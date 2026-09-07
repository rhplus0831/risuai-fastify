import { canUseClientWriteAccess } from './clientSession'
import {
  AGENT_PRESET_SCHEMA_VERSION,
  normalizeAgentPresets,
  type AgentPresetRecord,
  type AgentPresetStepRecord,
} from './agentPresetRecords'
import { safeStructuredClone } from './polyfill'
import {
  createAgentPresetCommand,
  createAgentPresetStepCommand,
  deleteAgentPresetCommand,
  deleteAgentPresetStepCommand,
  duplicateAgentPresetCommand,
  duplicateAgentPresetStepCommand,
  reorderAgentPresetsCommand,
  reorderAgentPresetStepsCommand,
  runServerCommand,
  setAgentPresetDefaultCommand,
  updateAgentPresetCommand,
  updateAgentPresetStepCommand,
  type AgentPresetSnapshot,
  type AgentPresetStepSnapshot,
  type JsonFieldState,
  type ServerCommandResult,
  type ServerCommandTransportOptions,
} from './server/commands'
import { dispatchDurableMutation, registerDurableMutationSettlementListener } from './server/durableMutationDispatch'
import {
  MAX_DURABLE_MUTATION_PAYLOAD_BYTES,
  pendingMutationIntentPayloadByteLength,
  stagePendingMutation,
  type DurableMutationIntent,
} from './server/pendingMutationOutbox'
import { refreshServerResourceTargets } from './server/resourceInvalidation'
import {
  charactersResourceState,
  collectionsResourceState,
  getCharacterResourceOwner,
  settingsResourceState,
} from './server/resourceState.svelte'
import { applyAttemptedFieldRollback } from './server/staleStateGuards'

type DatabaseRecord = Record<string, unknown>

interface AgentPresetCommandOptions {
  signal?: AbortSignal | null
}

const AGENT_PRESET_MUTATION_KEY = 'agent-presets:collection'

export type AgentPresetMutationOutcome<T extends Record<string, unknown> = Record<string, unknown>> =
  | {
      status: 'accepted'
      result: Extract<ServerCommandResult<T>, { status: 'ok' }>
    }
  | {
      status: 'queued'
      result: Exclude<ServerCommandResult<T>, { status: 'ok' }>
      projectionLatch?: AgentPresetGeneratedProjectionLatch
    }
  | {
      status: 'blocked'
      result: Exclude<ServerCommandResult<T>, { status: 'ok' }>
      projectionLatch: AgentPresetGeneratedProjectionLatch
    }
  | {
      status: 'failed'
      result: Exclude<ServerCommandResult<T>, { status: 'ok' }>
    }

export type AgentPresetGeneratedProjectionLatch =
  | {
      kind: 'preset'
      key: string
      baselineIds: string[]
      expectedName: string
      semanticDescriptor: string
    }
  | {
      kind: 'step'
      key: string
      presetId: string
      baselineIds: string[]
      expectedName: string
      expectedOutputKey?: string
      semanticDescriptor: string
      semanticDescriptorWithoutOutputKey?: string
      compareOutputKey: boolean
    }

type AgentPresetProjectionEntry =
  | { kind: 'preset-patch'; presetId: string; patch: AgentPresetSnapshot }
  | { kind: 'preset-delete'; presetId: string }
  | { kind: 'preset-reorder'; presetIds: string[] }
  | { kind: 'preset-default'; presetId: string | null }
  | { kind: 'step-patch'; presetId: string; stepId: string; patch: AgentPresetStepSnapshot }
  | { kind: 'step-delete'; presetId: string; stepId: string }
  | { kind: 'step-reorder'; presetId: string; stepIds: string[] }

interface PendingAgentPresetProjection {
  sequence: number
  entry: AgentPresetProjectionEntry
}

interface AgentPresetRollbackAttempt {
  rollback: () => void
  inheritedRollbacks: Array<() => void>
  successor?: AgentPresetRollbackAttempt
  settlementCleanup?: () => void
  settled: boolean
}

interface PendingAgentPresetRollbackAttempt {
  sequence: number
  attempt: AgentPresetRollbackAttempt
}

let nextAgentPresetMutationSequence = 0
const pendingAgentPresetProjections: PendingAgentPresetProjection[] = []
const pendingAgentPresetRollbackAttempts: PendingAgentPresetRollbackAttempt[] = []
const pendingGeneratedSubmissions = new Map<
  string,
  {
    latch: AgentPresetGeneratedProjectionLatch
    stopSettlementListener?: () => void
  }
>()
let latestAgentPresetRollbackAttempt: AgentPresetRollbackAttempt | undefined

function agentPresetSettingsOwnerReady(): boolean {
  const groupStatus = settingsResourceState.groupStatuses.agents
  return groupStatus === 'ready' && settingsResourceState.status !== 'error'
}

function agentPresetSettingsGroupReady(): boolean {
  return agentPresetSettingsOwnerReady()
}

/**
 * The agents settings group is the canonical owner of this collection. A
 * missing owner or malformed/duplicate stable ids is a hard failure.
 */
function readyAgentPresetCollectionOwner(): AgentPresetRecord[] | undefined {
  if (!agentPresetSettingsGroupReady()) return undefined
  const presets = (settingsResourceState.value as DatabaseRecord).agentPresets
  return isStableAgentPresetCollection(presets) ? presets : undefined
}

function agentPresetCollectionOwnerRead(): AgentPresetRecord[] {
  return readyAgentPresetCollectionOwner() ?? []
}

function agentPresetSettingsOwner(): DatabaseRecord | undefined {
  return readyAgentPresetCollectionOwner() ? (settingsResourceState.value as DatabaseRecord) : undefined
}

function agentPresetCollectionOwnerWrite(presets: AgentPresetRecord[]): boolean {
  if (!isStableAgentPresetCollection(presets)) return false
  if (!readyAgentPresetCollectionOwner()) return false
  ;(settingsResourceState.value as DatabaseRecord).agentPresets = presets
  return true
}

function agentPresetDefaultOwnerRead(): string | undefined {
  const presets = readyAgentPresetCollectionOwner()
  if (!presets) return undefined
  const id = nonBlankId((settingsResourceState.value as DatabaseRecord).agentPresetDefaultId)
  return id && presets.some((preset) => preset.id === id) ? id : undefined
}

function characterCollectionOwnerReady(): boolean {
  return charactersResourceState.status === 'ready'
}

type CharacterRows = typeof charactersResourceState.characters

function characterRowsOwner(): CharacterRows {
  if (!characterCollectionOwnerReady()) return []
  const ids = charactersResourceState.characters.map((candidate) => nonBlankId(candidate?.chaId))
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return []
  return charactersResourceState.characters
}

function uniqueCharacterOwner(characterId: string): CharacterRows[number] | undefined {
  if (!nonBlankId(characterId)) return undefined
  if (!characterCollectionOwnerReady() || charactersResourceState.rowStatuses[characterId] !== 'ready') return undefined
  return getCharacterResourceOwner(characterId)
}

function readyLoadoutCollectionOwner(): DatabaseRecord[] | undefined {
  if (!loadoutCollectionOwnerReady()) return undefined
  const loadouts = collectionsResourceState.values.loadouts
  if (!isStableRecordCollection(loadouts)) return undefined
  return loadouts as unknown as DatabaseRecord[]
}

function loadoutCollectionOwnerReady(): boolean {
  const status = collectionsResourceState.statuses.loadouts
  return status === 'ready' && collectionsResourceState.status !== 'error'
}

function loadoutCollectionOwnerRead(): DatabaseRecord[] {
  return readyLoadoutCollectionOwner() ?? []
}

function agentPresetReferenceOwnersReady(): boolean {
  return (
    agentPresetSettingsOwnerReady() &&
    characterCollectionOwnerReady() &&
    loadoutCollectionOwnerReady() &&
    characterRowsOwner().length === charactersResourceState.characters.length &&
    readyLoadoutCollectionOwner() !== undefined
  )
}

function withAgentPresetReferenceOwnerWrite<T>(callback: () => T): T | undefined {
  return agentPresetReferenceOwnersReady() ? callback() : undefined
}

function isStableAgentPresetCollection(value: unknown): value is AgentPresetRecord[] {
  if (!Array.isArray(value)) return false
  const presetIds = new Set<string>()
  for (const candidate of value) {
    if (!isDatabaseRecord(candidate)) return false
    const presetId = nonBlankId(candidate.id)
    if (!presetId || presetIds.has(presetId) || !Array.isArray(candidate.steps)) return false
    const stepIds = new Set<string>()
    for (const step of candidate.steps) {
      if (!isDatabaseRecord(step)) return false
      const stepId = nonBlankId(step.id)
      if (!stepId || stepIds.has(stepId)) return false
      stepIds.add(stepId)
    }
    if (candidate.agentUses !== undefined) {
      if (!Array.isArray(candidate.agentUses)) return false
      const useIds = new Set<string>()
      for (const use of candidate.agentUses) {
        if (!isDatabaseRecord(use)) return false
        const useId = nonBlankId(use.id)
        if (!useId || useIds.has(useId)) return false
        useIds.add(useId)
      }
    }
    presetIds.add(presetId)
  }
  return true
}

function isStableRecordCollection(value: unknown): value is DatabaseRecord[] {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  for (const candidate of value) {
    if (!isDatabaseRecord(candidate)) return false
    const id = nonBlankId(candidate.id)
    if (!id || ids.has(id)) return false
    ids.add(id)
  }
  return true
}

export function getAgentPresets(): AgentPresetRecord[] {
  return agentPresetCollectionOwnerRead()
}

export function getAgentPresetById(presetId: string): AgentPresetRecord | undefined {
  return uniqueAgentPresetById(presetId)
}

export function getAgentPresetDefaultId(): string | undefined {
  return agentPresetDefaultOwnerRead()
}

export function createAgentPreset(
  preset: AgentPresetSnapshot,
  options: AgentPresetCommandOptions = {},
): Promise<AgentPresetMutationOutcome<{ presetId: string }>> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const attempted = safeStructuredClone(preset)
  const latch: AgentPresetGeneratedProjectionLatch = {
    kind: 'preset',
    key: 'agent-preset:generated',
    baselineIds: getAgentPresets().map((candidate) => candidate.id),
    expectedName: typeof attempted.name === 'string' ? attempted.name : 'New Agent Preset',
    semanticDescriptor: createdPresetSemanticDescriptor(attempted),
  }
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [{ method: 'POST', path: '/agent-presets', body: { preset: safeStructuredClone(attempted) } }],
  }
  return dispatchGeneratedAgentPresetMutation(
    latch,
    intent,
    (baseRevision, signal) =>
      createAgentPresetCommand({ baseRevision, preset: safeStructuredClone(attempted) }, signal),
    options,
  )
}

export function updateAgentPreset(
  presetId: string,
  patch: AgentPresetSnapshot,
  options: AgentPresetCommandOptions = {},
): Promise<AgentPresetMutationOutcome<{ presetId: string }>> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const attempted = safeStructuredClone(patch)
  const optimistic = optimisticallyPatchAgentPreset(presetId, patch)
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [
      {
        method: 'PATCH',
        path: `/agent-presets/${encodeURIComponent(presetId)}`,
        body: { patch: safeStructuredClone(attempted) },
      },
    ],
  }
  return dispatchAgentPresetMutation(
    intent,
    (baseRevision, signal) =>
      updateAgentPresetCommand(
        {
          baseRevision,
          presetId,
          patch: safeStructuredClone(attempted),
        },
        signal,
      ),
    taintedAgentPresetRollback(optimistic.rollback),
    { kind: 'preset-patch', presetId, patch: attempted },
    options,
  )
}

export function duplicateAgentPreset(
  presetId: string,
  options: AgentPresetCommandOptions & { name?: string } = {},
): Promise<AgentPresetMutationOutcome<{ presetId: string; sourcePresetId: string }>> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const source = getAgentPresetById(presetId)
  const expectedName = options.name ?? (source ? `${source.name} Copy` : 'Agent Preset Copy')
  const latch: AgentPresetGeneratedProjectionLatch = {
    kind: 'preset',
    key: 'agent-preset:generated',
    baselineIds: getAgentPresets().map((candidate) => candidate.id),
    expectedName,
    semanticDescriptor: source
      ? agentPresetSemanticDescriptor({ ...safeStructuredClone(source), name: expectedName })
      : missingPresetSemanticDescriptor(expectedName),
  }
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [
      {
        method: 'POST',
        path: `/agent-presets/${encodeURIComponent(presetId)}/duplicate`,
        body: { name: options.name },
      },
    ],
  }
  return dispatchGeneratedAgentPresetMutation(
    latch,
    intent,
    (baseRevision, signal) => duplicateAgentPresetCommand({ baseRevision, presetId, name: options.name }, signal),
    options,
  )
}

export function deleteAgentPreset(
  presetId: string,
  options: AgentPresetCommandOptions = {},
): Promise<
  AgentPresetMutationOutcome<{
    presetId: string
    clearedDefault: boolean
    clearedChatCount: number
    clearedLoadoutCount: number
  }>
> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const rollback = taintedAgentPresetRollback(optimisticallyDeleteAgentPreset(presetId))
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [{ method: 'DELETE', path: `/agent-presets/${encodeURIComponent(presetId)}`, body: {} }],
  }
  return dispatchAgentPresetMutation(
    intent,
    (baseRevision, signal) => deleteAgentPresetCommand({ baseRevision, presetId }, signal),
    rollback,
    { kind: 'preset-delete', presetId },
    options,
  )
}

export function reorderAgentPresets(
  presetIds: string[],
  options: AgentPresetCommandOptions = {},
): Promise<AgentPresetMutationOutcome<{ agentPresetDefaultId: string | null }>> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const attemptedPresetIds = [...presetIds]
  const rollback = optimisticallyReorderAgentPresets(attemptedPresetIds)
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [{ method: 'POST', path: '/agent-presets/reorder', body: { presetIds: [...attemptedPresetIds] } }],
  }
  return dispatchAgentPresetMutation(
    intent,
    (baseRevision, signal) =>
      reorderAgentPresetsCommand(
        {
          baseRevision,
          presetIds: [...attemptedPresetIds],
        },
        signal,
      ),
    taintedAgentPresetRollback(rollback),
    { kind: 'preset-reorder', presetIds: attemptedPresetIds },
    options,
  )
}

export function setAgentPresetDefault(
  agentPresetId: string | null,
  options: AgentPresetCommandOptions = {},
): Promise<AgentPresetMutationOutcome<{ agentPresetDefaultId: string | null }>> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const rollback = optimisticallySetAgentPresetDefault(agentPresetId)
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [{ method: 'POST', path: '/agent-presets/default', body: { agentPresetId } }],
  }
  return dispatchAgentPresetMutation(
    intent,
    (baseRevision, signal) =>
      setAgentPresetDefaultCommand(
        {
          baseRevision,
          agentPresetId,
        },
        signal,
      ),
    taintedAgentPresetRollback(rollback),
    { kind: 'preset-default', presetId: agentPresetId },
    options,
  )
}

export function createAgentPresetStep(
  presetId: string,
  step: AgentPresetStepSnapshot,
  options: AgentPresetCommandOptions = {},
): Promise<AgentPresetMutationOutcome<{ presetId: string; stepId: string }>> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const attempted = safeStructuredClone(step)
  const expectedName = typeof attempted.name === 'string' ? attempted.name : 'New Step'
  const expectedOutputKey = typeof attempted.outputKey === 'string' ? attempted.outputKey : undefined
  const latch: AgentPresetGeneratedProjectionLatch = {
    kind: 'step',
    key: `agent-preset:generated-step:${presetId}`,
    presetId,
    baselineIds: getAgentPresetById(presetId)?.steps.map((candidate) => candidate.id) ?? [],
    expectedName,
    ...(expectedOutputKey ? { expectedOutputKey } : {}),
    semanticDescriptor: createdStepSemanticDescriptor(attempted),
    semanticDescriptorWithoutOutputKey: createdStepSemanticDescriptor(attempted, false),
    compareOutputKey: Object.prototype.hasOwnProperty.call(attempted, 'outputKey'),
  }
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [
      {
        method: 'POST',
        path: `/agent-presets/${encodeURIComponent(presetId)}/steps`,
        body: { step: safeStructuredClone(attempted) },
      },
    ],
  }
  return dispatchGeneratedAgentPresetMutation(
    latch,
    intent,
    (baseRevision, signal) =>
      createAgentPresetStepCommand({ baseRevision, presetId, step: safeStructuredClone(attempted) }, signal),
    options,
  )
}

export function updateAgentPresetStep(
  presetId: string,
  stepId: string,
  patch: AgentPresetStepSnapshot,
  options: AgentPresetCommandOptions = {},
): Promise<AgentPresetMutationOutcome<{ presetId: string; stepId: string }>> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const attempted = safeStructuredClone(patch)
  const optimistic = optimisticallyPatchAgentPresetStep(presetId, stepId, patch)
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [
      {
        method: 'PATCH',
        path: `/agent-presets/${encodeURIComponent(presetId)}/steps/${encodeURIComponent(stepId)}`,
        body: { patch: safeStructuredClone(attempted) },
      },
    ],
  }
  return dispatchAgentPresetMutation(
    intent,
    (baseRevision, signal) =>
      updateAgentPresetStepCommand(
        {
          baseRevision,
          presetId,
          stepId,
          patch: safeStructuredClone(attempted),
        },
        signal,
      ),
    taintedAgentPresetRollback(optimistic.rollback),
    { kind: 'step-patch', presetId, stepId, patch: attempted },
    options,
  )
}

export function duplicateAgentPresetStep(
  presetId: string,
  stepId: string,
  options: AgentPresetCommandOptions & { name?: string } = {},
): Promise<AgentPresetMutationOutcome<{ presetId: string; stepId: string; sourceStepId: string }>> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const source = getAgentPresetById(presetId)?.steps.find((candidate) => candidate.id === stepId)
  const expectedName = options.name ?? (source ? `${source.name} Copy` : 'Agent Preset Step Copy')
  const expectedOutputKey = source
    ? uniqueAgentPresetStepDuplicateOutputKey(source, getAgentPresetById(presetId)?.steps ?? [])
    : undefined
  const latch: AgentPresetGeneratedProjectionLatch = {
    kind: 'step',
    key: `agent-preset:generated-step:${presetId}`,
    presetId,
    baselineIds: getAgentPresetById(presetId)?.steps.map((candidate) => candidate.id) ?? [],
    expectedName,
    ...(expectedOutputKey ? { expectedOutputKey } : {}),
    semanticDescriptor: source
      ? agentPresetStepSemanticDescriptor(
          { ...safeStructuredClone(source), name: expectedName, outputKey: expectedOutputKey! },
          undefined,
          true,
        )
      : missingStepSemanticDescriptor(expectedName),
    semanticDescriptorWithoutOutputKey: source
      ? agentPresetStepSemanticDescriptor(
          { ...safeStructuredClone(source), name: expectedName, outputKey: expectedOutputKey! },
          undefined,
          false,
        )
      : missingStepSemanticDescriptor(expectedName),
    compareOutputKey: expectedOutputKey !== undefined,
  }
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [
      {
        method: 'POST',
        path: `/agent-presets/${encodeURIComponent(presetId)}/steps/${encodeURIComponent(stepId)}/duplicate`,
        body: { name: options.name },
      },
    ],
  }
  return dispatchGeneratedAgentPresetMutation(
    latch,
    intent,
    (baseRevision, signal) =>
      duplicateAgentPresetStepCommand({ baseRevision, presetId, stepId, name: options.name }, signal),
    options,
  )
}

export function deleteAgentPresetStep(
  presetId: string,
  stepId: string,
  options: AgentPresetCommandOptions = {},
): Promise<AgentPresetMutationOutcome<{ presetId: string; stepId: string }>> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const rollback = taintedAgentPresetRollback(optimisticallyDeleteAgentPresetStep(presetId, stepId))
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [
      {
        method: 'DELETE',
        path: `/agent-presets/${encodeURIComponent(presetId)}/steps/${encodeURIComponent(stepId)}`,
        body: {},
      },
    ],
  }
  return dispatchAgentPresetMutation(
    intent,
    (baseRevision, signal) => deleteAgentPresetStepCommand({ baseRevision, presetId, stepId }, signal),
    rollback,
    { kind: 'step-delete', presetId, stepId },
    options,
  )
}

export function reorderAgentPresetSteps(
  presetId: string,
  stepIds: string[],
  options: AgentPresetCommandOptions = {},
): Promise<AgentPresetMutationOutcome<{ presetId: string }>> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const attemptedStepIds = [...stepIds]
  const rollback = taintedAgentPresetRollback(optimisticallyReorderAgentPresetSteps(presetId, attemptedStepIds))
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [
      {
        method: 'POST',
        path: `/agent-presets/${encodeURIComponent(presetId)}/steps/reorder`,
        body: { stepIds: [...attemptedStepIds] },
      },
    ],
  }
  return dispatchAgentPresetMutation(
    intent,
    (baseRevision, signal) =>
      reorderAgentPresetStepsCommand({ baseRevision, presetId, stepIds: [...attemptedStepIds] }, signal),
    rollback,
    { kind: 'step-reorder', presetId, stepIds: attemptedStepIds },
    options,
  )
}

function dispatchAgentPresetMutation<T extends Record<string, unknown>>(
  intent: DurableMutationIntent,
  command: (baseRevision: number, signal?: AbortSignal | null) => Promise<ServerCommandResult<T>>,
  rollback: () => void,
  projection: AgentPresetProjectionEntry,
  options: AgentPresetCommandOptions,
): Promise<AgentPresetMutationOutcome<T>> {
  const blockedLatch = firstUnresolvedGeneratedSubmission()
  if (blockedLatch) {
    rollback()
    return Promise.resolve({
      status: 'blocked',
      result: { status: 'unavailable' },
      projectionLatch: safeStructuredClone(blockedLatch),
    })
  }
  return dispatchAgentPresetDurableMutation(intent, command, rollback, projection, options)
}

function dispatchGeneratedAgentPresetMutation<T extends Record<string, unknown>>(
  latch: AgentPresetGeneratedProjectionLatch,
  intent: DurableMutationIntent,
  command: (baseRevision: number, signal?: AbortSignal | null) => Promise<ServerCommandResult<T>>,
  options: AgentPresetCommandOptions = {},
): Promise<AgentPresetMutationOutcome<T>> {
  const blockedLatch = firstUnresolvedGeneratedSubmission()
  if (blockedLatch) {
    return Promise.resolve({
      status: 'blocked',
      result: { status: 'unavailable' },
      projectionLatch: safeStructuredClone(blockedLatch),
    })
  }
  const frozenLatch = safeStructuredClone(latch)
  const pendingSubmission: {
    latch: AgentPresetGeneratedProjectionLatch
    stopSettlementListener?: () => void
  } = { latch: frozenLatch }
  pendingGeneratedSubmissions.set(frozenLatch.key, pendingSubmission)
  return dispatchAgentPresetDurableMutation(intent, command, undefined, undefined, options, (mutationId) => {
    pendingSubmission.stopSettlementListener = registerDurableMutationSettlementListener(mutationId, () => {
      clearPendingGeneratedSubmission(frozenLatch.key, pendingSubmission)
    })
  }).then(
    (outcome) => {
      if (outcome.status === 'queued') {
        return { ...outcome, projectionLatch: frozenLatch }
      }
      clearPendingGeneratedSubmission(frozenLatch.key, pendingSubmission)
      return outcome
    },
    (error) => {
      clearPendingGeneratedSubmission(frozenLatch.key, pendingSubmission)
      console.error('Agent Preset generated mutation rejected:', error)
      return {
        status: 'failed',
        result: {
          status: 'error',
          error: error instanceof Error ? error.message : 'Unable to queue Agent Preset mutation',
        },
      }
    },
  )
}

async function dispatchAgentPresetDurableMutation<T extends Record<string, unknown>>(
  intent: DurableMutationIntent,
  command: (baseRevision: number, signal?: AbortSignal | null) => Promise<ServerCommandResult<T>>,
  rollback?: () => void,
  projection?: AgentPresetProjectionEntry,
  options: AgentPresetCommandOptions = {},
  onStaged?: (mutationId: string) => void,
): Promise<AgentPresetMutationOutcome<T>> {
  const sequence = ++nextAgentPresetMutationSequence
  if (projection) {
    pendingAgentPresetProjections.push({ sequence, entry: safeStructuredClone(projection) })
  }
  const rollbackAttempt = rollback ? registerAgentPresetRollbackAttempt(sequence, rollback) : undefined
  let outbox
  try {
    const payloadBytes = pendingMutationIntentPayloadByteLength(intent)
    if (payloadBytes > MAX_DURABLE_MUTATION_PAYLOAD_BYTES) {
      throw new RangeError('Pending Agent Preset mutation payload is too large')
    }
    outbox = stagePendingMutation(AGENT_PRESET_MUTATION_KEY, intent)
    if (rollbackAttempt) {
      rollbackAttempt.settlementCleanup = registerDurableMutationSettlementListener(outbox.mutationId, (settlement) => {
        clearAgentPresetSettlementListener(rollbackAttempt)
        if (settlement === 'accepted') {
          clearAcceptedAgentPresetProjections(sequence)
          clearAcceptedAgentPresetRollbackAttempts(sequence)
          return
        }
        settleFailedAgentPresetRollbackAttempt(rollbackAttempt)
        removeAgentPresetProjection(sequence)
        removeAgentPresetRollbackAttempt(sequence)
      })
    }
    onStaged?.(outbox.mutationId)
  } catch (error) {
    console.error('Unable to stage Agent Preset mutation:', error)
    if (rollbackAttempt) settleFailedAgentPresetRollbackAttempt(rollbackAttempt)
    removeAgentPresetProjection(sequence)
    removeAgentPresetRollbackAttempt(sequence)
    return {
      status: 'failed',
      result: {
        status: 'error',
        error: error instanceof Error ? error.message : 'Unable to queue Agent Preset mutation',
      },
    }
  }
  let failureRollbackDisposition: ServerCommandTransportOptions['failureRollbackDisposition']
  let result: ServerCommandResult<T>
  try {
    result = await dispatchDurableMutation(outbox, intent, (transport) => {
      failureRollbackDisposition = transport.failureRollbackDisposition
      return runServerCommand({
        signal: options.signal,
        rollback: rollbackAttempt ? () => settleFailedAgentPresetRollbackAttempt(rollbackAttempt) : rollback,
        command: async (baseRevision) => {
          // Reaching this command means the durable same-lane wrapper already
          // replayed every older retained row. Those predecessors are now
          // accepted even if this request later remains queued, so keep only
          // this and newer optimistic overlays during reconciliation.
          clearAcceptedAgentPresetProjections(sequence - 1)
          clearAcceptedAgentPresetRollbackAttempts(sequence - 1)
          const commandResult = await command(baseRevision, options.signal ?? transport.signal)
          // Retire accepted overlays before runServerCommand reconciles the
          // response event. Otherwise an authoritative agents-group read can
          // be immediately masked by the just-accepted attempted value.
          if (commandResult.status === 'ok') {
            clearAcceptedAgentPresetProjections(sequence)
            clearAcceptedAgentPresetRollbackAttempts(sequence)
          }
          return commandResult
        },
        ...transport,
      })
    })
  } catch (error) {
    console.error('Agent Preset mutation command rejected:', error)
    result = { status: 'unavailable' }
  }

  if (result.status === 'ok') {
    clearAcceptedAgentPresetProjections(sequence)
    clearAcceptedAgentPresetRollbackAttempts(sequence)
    return { status: 'accepted', result }
  }
  const disposition = failureRollbackDisposition?.(result) ?? 'rollback'
  if (disposition === 'retain') return { status: 'queued', result }
  if (rollbackAttempt) settleFailedAgentPresetRollbackAttempt(rollbackAttempt)
  removeAgentPresetProjection(sequence)
  removeAgentPresetRollbackAttempt(sequence)
  return { status: 'failed', result }
}

function clearAcceptedAgentPresetProjections(sequence: number): void {
  for (let index = pendingAgentPresetProjections.length - 1; index >= 0; index -= 1) {
    if (pendingAgentPresetProjections[index].sequence <= sequence) pendingAgentPresetProjections.splice(index, 1)
  }
}

function removeAgentPresetProjection(sequence: number): void {
  const index = pendingAgentPresetProjections.findIndex((operation) => operation.sequence === sequence)
  if (index >= 0) pendingAgentPresetProjections.splice(index, 1)
}

function registerAgentPresetRollbackAttempt(sequence: number, rollback: () => void): AgentPresetRollbackAttempt {
  const attempt: AgentPresetRollbackAttempt = {
    rollback,
    inheritedRollbacks: [],
    settled: false,
  }
  if (latestAgentPresetRollbackAttempt && !latestAgentPresetRollbackAttempt.settled) {
    latestAgentPresetRollbackAttempt.successor = attempt
  }
  latestAgentPresetRollbackAttempt = attempt
  pendingAgentPresetRollbackAttempts.push({ sequence, attempt })
  return attempt
}

function settleFailedAgentPresetRollbackAttempt(attempt: AgentPresetRollbackAttempt): void {
  if (attempt.settled) return
  clearAgentPresetSettlementListener(attempt)
  attempt.settled = true
  const rollbackChain = [attempt.rollback, ...attempt.inheritedRollbacks]
  for (const rollback of rollbackChain) rollback()
  if (attempt.successor && !attempt.successor.settled) {
    attempt.successor.inheritedRollbacks.push(...rollbackChain)
  }
  updateLatestAgentPresetRollbackAttempt()
}

function clearAcceptedAgentPresetRollbackAttempts(sequence: number): void {
  for (let index = pendingAgentPresetRollbackAttempts.length - 1; index >= 0; index -= 1) {
    const pending = pendingAgentPresetRollbackAttempts[index]
    if (pending.sequence > sequence) continue
    clearAgentPresetSettlementListener(pending.attempt)
    pending.attempt.settled = true
    pendingAgentPresetRollbackAttempts.splice(index, 1)
  }
  updateLatestAgentPresetRollbackAttempt()
}

function removeAgentPresetRollbackAttempt(sequence: number): void {
  const index = pendingAgentPresetRollbackAttempts.findIndex((pending) => pending.sequence === sequence)
  if (index >= 0) {
    clearAgentPresetSettlementListener(pendingAgentPresetRollbackAttempts[index].attempt)
    pendingAgentPresetRollbackAttempts.splice(index, 1)
  }
  updateLatestAgentPresetRollbackAttempt()
}

function clearAgentPresetSettlementListener(attempt: AgentPresetRollbackAttempt): void {
  attempt.settlementCleanup?.()
  attempt.settlementCleanup = undefined
}

function updateLatestAgentPresetRollbackAttempt(): void {
  latestAgentPresetRollbackAttempt = pendingAgentPresetRollbackAttempts
    .map((pending) => pending.attempt)
    .findLast((attempt) => !attempt.settled)
}

function createdPresetSemanticDescriptor(snapshot: AgentPresetSnapshot): string {
  const normalized = normalizeAgentPresets([
    {
      name: 'New Agent Preset',
      enabled: true,
      version: AGENT_PRESET_SCHEMA_VERSION,
      steps: [],
      ...safeStructuredClone(snapshot),
      id: '__expected_agent_preset__',
    },
  ])[0]
  return normalized
    ? agentPresetSemanticDescriptor(normalized)
    : missingPresetSemanticDescriptor(typeof snapshot.name === 'string' ? snapshot.name : 'New Agent Preset')
}

function createdStepSemanticDescriptor(
  snapshot: AgentPresetStepSnapshot,
  compareOutputKey = Object.prototype.hasOwnProperty.call(snapshot, 'outputKey'),
): string {
  const phase = snapshot.phase === 'afterMain' ? 'afterMain' : 'beforeMain'
  const normalized = normalizeAgentPresets([
    {
      id: '__expected_agent_preset__',
      name: 'Expected Agent Preset',
      enabled: true,
      version: AGENT_PRESET_SCHEMA_VERSION,
      steps: [
        {
          name: 'New Step',
          enabled: true,
          phase,
          dependencies: [],
          instruction: '',
          model: { mode: 'inheritMain' },
          runtime: {},
          inputScopes: [],
          outputKey: '__expected_agent_preset_step__',
          outputFormat: 'text',
          destination: phase === 'beforeMain' ? 'promptOutput' : 'intermediate',
          failurePolicy: { mode: 'required' },
          ...safeStructuredClone(snapshot),
          id: '__expected_agent_preset_step__',
        },
      ],
    },
  ])[0]?.steps[0]
  return normalized
    ? agentPresetStepSemanticDescriptor(normalized, undefined, compareOutputKey)
    : missingStepSemanticDescriptor(typeof snapshot.name === 'string' ? snapshot.name : 'New Step')
}

function agentPresetSemanticDescriptor(preset: AgentPresetRecord): string {
  const stepIndexes = new Map(preset.steps.map((step, index) => [step.id, index]))
  return canonicalAgentPresetDescriptor({
    name: preset.name,
    description: preset.description ?? null,
    moduleIntergration: preset.moduleIntergration ?? null,
    finalOutputTemplate: preset.finalOutputTemplate ?? null,
    enabled: preset.enabled,
    version: preset.version,
    maxConcurrency: preset.maxConcurrency ?? null,
    steps: preset.steps.map((step) => agentPresetStepDescriptorValue(step, stepIndexes, true)),
  })
}

function agentPresetStepSemanticDescriptor(
  step: AgentPresetStepRecord,
  dependencyIndexes?: ReadonlyMap<string, number>,
  includeOutputKey = true,
): string {
  return canonicalAgentPresetDescriptor(agentPresetStepDescriptorValue(step, dependencyIndexes, includeOutputKey))
}

function agentPresetStepDescriptorValue(
  step: AgentPresetStepRecord,
  dependencyIndexes: ReadonlyMap<string, number> | undefined,
  includeOutputKey: boolean,
): Record<string, unknown> {
  return {
    name: step.name,
    enabled: step.enabled,
    phase: step.phase,
    dependencies: step.dependencies.map((dependencyId) => {
      const dependencyIndex = dependencyIndexes?.get(dependencyId)
      return dependencyIndex === undefined ? `id:${dependencyId}` : `step:${dependencyIndex}`
    }),
    instruction: step.instruction,
    useChatML: step.useChatML ?? false,
    model: step.model,
    runtime: step.runtime,
    inputScopes: step.inputScopes,
    ...(includeOutputKey ? { outputKey: step.outputKey } : {}),
    outputFormat: step.outputFormat,
    destination: step.destination,
    failurePolicy: step.failurePolicy,
  }
}

function missingPresetSemanticDescriptor(expectedName: string): string {
  return canonicalAgentPresetDescriptor({ kind: 'missing-preset', name: expectedName })
}

function missingStepSemanticDescriptor(expectedName: string): string {
  return canonicalAgentPresetDescriptor({ kind: 'missing-step', name: expectedName })
}

function canonicalAgentPresetDescriptor(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalAgentPresetDescriptor).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalAgentPresetDescriptor(record[key])}`)
    .join(',')}}`
}

function uniqueAgentPresetStepDuplicateOutputKey(
  source: AgentPresetStepRecord,
  steps: readonly AgentPresetStepRecord[],
): string {
  const used = new Set(steps.filter((step) => step.phase === source.phase).map((step) => step.outputKey))
  const base = sanitizeAgentPresetOutputKeyBase(`${source.outputKey}_copy`)
  if (!used.has(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `_${index}`
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`
    if (!used.has(candidate) && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(candidate)) return candidate
  }
  return 'agent_output'
}

function sanitizeAgentPresetOutputKeyBase(base: string): string {
  let candidate = base.replace(/[^A-Za-z0-9_]/g, '_')
  if (!/^[A-Za-z_]/.test(candidate)) candidate = `agent_${candidate}`
  candidate = candidate.slice(0, 64)
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(candidate) ? candidate : 'agent_output'
}

function firstUnresolvedGeneratedSubmission(): AgentPresetGeneratedProjectionLatch | undefined {
  for (const [key, pending] of pendingGeneratedSubmissions) {
    const latch = pending.latch
    if (isAgentPresetGeneratedProjectionResolved(latch)) {
      clearPendingGeneratedSubmission(key, pending)
      continue
    }
    return latch
  }
  return undefined
}

export function currentPendingAgentPresetGeneratedProjectionLatch(): AgentPresetGeneratedProjectionLatch | null {
  const latch = firstUnresolvedGeneratedSubmission()
  return latch ? safeStructuredClone(latch) : null
}

export function isAgentPresetGeneratedProjectionResolved(latch: AgentPresetGeneratedProjectionLatch): boolean {
  const pending = pendingGeneratedSubmissions.get(latch.key)
  if (!pending || canonicalAgentPresetDescriptor(pending.latch) !== canonicalAgentPresetDescriptor(latch)) return true
  const baselineIds = new Set(latch.baselineIds)
  if (latch.kind === 'preset') {
    return getAgentPresets().some(
      (preset) =>
        !baselineIds.has(preset.id) &&
        preset.name === latch.expectedName &&
        agentPresetSemanticDescriptor(preset) === latch.semanticDescriptor,
    )
  }
  const preset = getAgentPresetById(latch.presetId)
  return !!preset?.steps.some((step) => {
    if (baselineIds.has(step.id) || step.name !== latch.expectedName) return false
    const exactMatch =
      (latch.expectedOutputKey === undefined || step.outputKey === latch.expectedOutputKey) &&
      agentPresetStepSemanticDescriptor(step, undefined, latch.compareOutputKey) === latch.semanticDescriptor
    if (exactMatch) return true
    return (
      latch.compareOutputKey &&
      typeof latch.semanticDescriptorWithoutOutputKey === 'string' &&
      agentPresetStepSemanticDescriptor(step, undefined, false) === latch.semanticDescriptorWithoutOutputKey
    )
  })
}

function clearPendingGeneratedSubmission(
  key: string,
  expected: { latch: AgentPresetGeneratedProjectionLatch; stopSettlementListener?: () => void },
): void {
  if (pendingGeneratedSubmissions.get(key) !== expected) return
  pendingGeneratedSubmissions.delete(key)
  expected.stopSettlementListener?.()
  expected.stopSettlementListener = undefined
}

export function resetPendingAgentPresetMutationsForTests(): void {
  pendingAgentPresetProjections.splice(0)
  for (const pending of pendingAgentPresetRollbackAttempts) clearAgentPresetSettlementListener(pending.attempt)
  pendingAgentPresetRollbackAttempts.splice(0)
  for (const [key, pending] of pendingGeneratedSubmissions) clearPendingGeneratedSubmission(key, pending)
  latestAgentPresetRollbackAttempt = undefined
  nextAgentPresetMutationSequence = 0
}

/** Preserve exact retained Agent Preset intents across settings refreshes. */
export function mergePendingAgentPresetSettingsResource<T extends Record<string, unknown>>(settings: T): T {
  if (pendingAgentPresetProjections.length === 0) return settings
  const merged = safeStructuredClone(settings)
  for (const operation of pendingAgentPresetProjections) {
    applyAgentPresetProjectionEntry(merged, operation.entry)
  }
  return merged
}

/** Keep a retained preset delete from reviving loadout references on refresh. */
export function mergePendingAgentPresetLoadoutsResource<T extends Array<Record<string, unknown>>>(loadouts: T): T {
  const deletedPresetIds = pendingDeletedAgentPresetIds()
  if (deletedPresetIds.size === 0) return loadouts
  return safeStructuredClone(loadouts).map((loadout) => {
    if (!deletedPresetIds.has(String(loadout.agentPresetId ?? ''))) return loadout
    delete loadout.agentPresetId
    delete loadout.agentPresetName
    return loadout
  }) as T
}

/** Keep a retained preset delete from reviving chat selections on refresh. */
export function mergePendingAgentPresetCharactersResource<T extends Array<Record<string, any>>>(characters: T): T {
  const deletedPresetIds = pendingDeletedAgentPresetIds()
  if (deletedPresetIds.size === 0) return characters
  const merged = safeStructuredClone(characters)
  for (const character of merged) {
    if (!Array.isArray(character.chats)) continue
    for (const chat of character.chats) {
      const generationSettings = chat?.generationSettings
      if (
        generationSettings &&
        typeof generationSettings === 'object' &&
        !Array.isArray(generationSettings) &&
        deletedPresetIds.has(String(generationSettings.agentPresetId ?? ''))
      ) {
        delete generationSettings.agentPresetId
      }
    }
  }
  return merged
}

function pendingDeletedAgentPresetIds(): Set<string> {
  return new Set(
    pendingAgentPresetProjections
      .map((operation) => operation.entry)
      .filter(
        (entry): entry is Extract<AgentPresetProjectionEntry, { kind: 'preset-delete' }> =>
          entry.kind === 'preset-delete',
      )
      .map((entry) => entry.presetId),
  )
}

function applyAgentPresetProjectionEntry(settings: Record<string, unknown>, entry: AgentPresetProjectionEntry): void {
  const presets = Array.isArray(settings.agentPresets)
    ? (safeStructuredClone(settings.agentPresets) as AgentPresetRecord[])
    : []

  if (entry.kind === 'preset-patch') {
    const index = presets.findIndex((preset) => preset.id === entry.presetId)
    if (index >= 0) presets[index] = applyProjectionPatch(presets[index], entry.patch) as AgentPresetRecord
  } else if (entry.kind === 'preset-delete') {
    settings.agentPresets = presets.filter((preset) => preset.id !== entry.presetId)
    if (settings.agentPresetDefaultId === entry.presetId) delete settings.agentPresetDefaultId
    return
  } else if (entry.kind === 'preset-reorder') {
    settings.agentPresets = reorderProjectionRows(presets, entry.presetIds)
    return
  } else if (entry.kind === 'preset-default') {
    if (entry.presetId) settings.agentPresetDefaultId = entry.presetId
    else delete settings.agentPresetDefaultId
    return
  } else {
    const presetIndex = presets.findIndex((preset) => preset.id === entry.presetId)
    if (presetIndex < 0) return
    const preset = safeStructuredClone(presets[presetIndex])
    if (entry.kind === 'step-patch') {
      const stepIndex = preset.steps.findIndex((step) => step.id === entry.stepId)
      if (stepIndex >= 0) {
        preset.steps[stepIndex] = applyProjectionPatch(preset.steps[stepIndex], entry.patch) as AgentPresetStepRecord
      }
    } else if (entry.kind === 'step-delete') {
      preset.steps = preset.steps
        .filter((step) => step.id !== entry.stepId)
        .map((step) => ({
          ...step,
          dependencies: step.dependencies.filter((dependencyId) => dependencyId !== entry.stepId),
        }))
    } else {
      preset.steps = reorderProjectionRows(preset.steps, entry.stepIds)
    }
    presets[presetIndex] = preset
  }
  settings.agentPresets = presets
}

function applyProjectionPatch<T extends object>(target: T, patch: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...(target as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id') continue
    if (
      value === null &&
      (key === 'description' ||
        key === 'moduleIntergration' ||
        key === 'finalOutputTemplate' ||
        key === 'maxConcurrency')
    ) {
      delete next[key]
    } else next[key] = safeStructuredClone(value)
  }
  return next as T
}

function reorderProjectionRows<T extends { id: string }>(rows: T[], ids: readonly string[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const used = new Set<string>()
  const reordered: T[] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row || used.has(id)) continue
    reordered.push(row)
    used.add(id)
  }
  for (const row of rows) if (!used.has(row.id)) reordered.push(row)
  return reordered
}

interface OptimisticAgentPresetFieldPatch {
  rollback?: () => void
}

interface AgentPresetDeleteFieldRollback {
  keys: string[]
  previous: Record<string, JsonFieldState>
  attempted: Record<string, JsonFieldState>
  targetAtMutation: DatabaseRecord
  resolveTarget: () => DatabaseRecord | undefined
  reconciliationTarget?: AgentPresetDeleteReconciliationTarget
}

type AgentPresetDeleteReconciliationTarget =
  | { kind: 'character'; characterId: string }
  | { kind: 'collection'; name: 'loadouts' }

function optimisticallyPatchAgentPreset(presetId: string, patch: AgentPresetSnapshot): OptimisticAgentPresetFieldPatch {
  const preset = uniqueAgentPresetById(presetId)
  if (!preset) return {}
  return applyOptimisticAgentPresetFields(
    () => uniqueAgentPresetById(presetId) as unknown as DatabaseRecord | undefined,
    preset as unknown as DatabaseRecord,
    patch,
  )
}

function optimisticallyDeleteAgentPreset(presetId: string): (() => void) | undefined {
  const preset = uniqueAgentPresetById(presetId)
  if (!preset) return undefined
  const presetRollback = withAgentPresetRollback(['agentPresets'], () => {
    const presets = agentPresetCollectionOwnerRead()
    const index = presets.indexOf(preset)
    if (index !== -1) agentPresetCollectionOwnerWrite(presets.filter((_, candidateIndex) => candidateIndex !== index))
  })
  const referenceRollbacks =
    withAgentPresetReferenceOwnerWrite(() => {
      const rollbacks: AgentPresetDeleteFieldRollback[] = []
      const settings = agentPresetSettingsOwner()
      if (settings?.agentPresetDefaultId === presetId) {
        rollbacks.push(
          captureAgentPresetDeleteFieldRollback({
            target: settings,
            resolveTarget: () => agentPresetSettingsOwner(),
            keys: ['agentPresetDefaultId'],
            mutate: () => delete settings.agentPresetDefaultId,
          }),
        )
      }
      rollbacks.push(...clearChatAgentPresetSelections(presetId), ...clearLoadoutAgentPresetSelections(presetId))
      return rollbacks
    }) ?? []

  return () => {
    presetRollback?.()
    // Never restore references to a preset whose whole-row rollback was
    // superseded by a later edit. The agents taint forces authoritative
    // reconciliation before a later local acknowledgement can fence it.
    if (!uniqueAgentPresetById(presetId)) return
    const reconciliationTargets =
      withAgentPresetReferenceOwnerWrite(() =>
        referenceRollbacks.flatMap((rollback) => {
          const target = restoreAgentPresetDeleteFields(rollback)
          return target ? [target] : []
        }),
      ) ?? []
    scheduleAgentPresetDeleteReferenceReconciliation(reconciliationTargets)
  }
}

function optimisticallyReorderAgentPresets(presetIds: string[]): (() => void) | undefined {
  return withAgentPresetRollback(['agentPresets'], () => {
    const presets = agentPresetCollectionOwnerRead()
    const byId = new Map(presets.map((preset) => [preset.id, preset]))
    if (presetIds.length !== presets.length || presetIds.some((id) => !byId.has(id))) return
    agentPresetCollectionOwnerWrite(presetIds.map((id) => byId.get(id)!))
  })
}

function optimisticallySetAgentPresetDefault(agentPresetId: string | null): (() => void) | undefined {
  return withAgentPresetRollback(['agentPresetDefaultId'], () => {
    const settings = agentPresetSettingsOwner()
    if (!settings) return
    if (agentPresetId === null) {
      delete settings.agentPresetDefaultId
    } else {
      if (!nonBlankId(agentPresetId) || !uniqueAgentPresetById(agentPresetId)) return
      settings.agentPresetDefaultId = agentPresetId
    }
  })
}

function optimisticallyPatchAgentPresetStep(
  presetId: string,
  stepId: string,
  patch: AgentPresetStepSnapshot,
): OptimisticAgentPresetFieldPatch {
  const step = uniqueAgentPresetStepById(presetId, stepId)
  if (!step) return {}
  return applyOptimisticAgentPresetFields(
    () => uniqueAgentPresetStepById(presetId, stepId) as unknown as DatabaseRecord | undefined,
    step as unknown as DatabaseRecord,
    patch,
  )
}

function applyOptimisticAgentPresetFields(
  resolveTarget: () => DatabaseRecord | undefined,
  target: DatabaseRecord,
  patch: Record<string, unknown>,
): OptimisticAgentPresetFieldPatch {
  const keys = Object.keys(patch).filter((key) => key !== 'id')
  const previous = snapshotKeys(target, keys)
  if (!agentPresetSettingsOwnerReady()) return {}
  for (const key of keys) target[key] = patch[key]
  const attempted = snapshotKeys(target, keys)
  return {
    rollback: () => {
      const liveTarget = resolveTarget()
      if (!liveTarget) return
      if (!agentPresetSettingsOwnerReady()) return
      applyAttemptedFieldRollback({
        target: liveTarget,
        previous,
        attempted,
        keys,
        deleteMissingPrevious: true,
      })
    },
  }
}

function uniqueAgentPresetById(presetId: string): AgentPresetRecord | undefined {
  if (!nonBlankId(presetId)) return undefined
  const matches = getAgentPresets().filter((preset) => preset.id === presetId)
  return matches.length === 1 ? matches[0] : undefined
}

function uniqueAgentPresetStepById(presetId: string, stepId: string): AgentPresetStepRecord | undefined {
  const preset = uniqueAgentPresetById(presetId)
  if (!preset) return undefined
  const matches = preset.steps.filter((step) => step.id === stepId)
  return matches.length === 1 ? matches[0] : undefined
}

function taintedAgentPresetRollback(rollback?: () => void): () => void {
  return () => rollback?.()
}

function optimisticallyDeleteAgentPresetStep(presetId: string, stepId: string): (() => void) | undefined {
  return withAgentPresetRollback(['agentPresets'], () => {
    const preset = getAgentPresetById(presetId)
    if (!preset) return
    const index = preset.steps.findIndex((step) => step.id === stepId)
    if (index !== -1) preset.steps.splice(index, 1)
    for (const step of preset.steps) {
      step.dependencies = step.dependencies.filter((dependencyId) => dependencyId !== stepId)
    }
  })
}

function optimisticallyReorderAgentPresetSteps(presetId: string, stepIds: string[]): (() => void) | undefined {
  return withAgentPresetRollback(['agentPresets'], () => {
    const preset = getAgentPresetById(presetId)
    if (!preset) return
    const byId = new Map(preset.steps.map((step) => [step.id, step]))
    if (stepIds.length !== preset.steps.length || stepIds.some((id) => !byId.has(id))) return
    preset.steps = stepIds.map((id) => byId.get(id)!)
  })
}

function withAgentPresetRollback(keys: string[], mutate: () => void): (() => void) | undefined {
  const target = agentPresetSettingsOwner()
  if (!target) return undefined
  const previous = snapshotKeys(target, keys)
  mutate()
  const attempted = snapshotKeys(target, keys)
  return () => {
    const liveTarget = agentPresetSettingsOwner()
    if (!liveTarget) return
    applyAttemptedFieldRollback({
      target: liveTarget,
      previous,
      attempted,
      keys,
      deleteMissingPrevious: true,
    })
  }
}

function snapshotKeys(target: DatabaseRecord, keys: readonly string[]): Partial<DatabaseRecord> {
  const snapshot: Partial<DatabaseRecord> = {}
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      snapshot[key] = safeStructuredClone(target[key])
    }
  }
  return snapshot
}

function clearChatAgentPresetSelections(presetId: string): AgentPresetDeleteFieldRollback[] {
  const rollbacks: AgentPresetDeleteFieldRollback[] = []
  for (const character of characterRowsOwner()) {
    const characterId = nonBlankId(character?.chaId)
    if (!characterId) continue
    if (uniqueCharacterOwner(characterId) !== character) continue
    const chats = Array.isArray(character?.chats) ? character.chats : []
    for (const chat of chats) {
      const chatId = nonBlankId(chat?.id)
      const generationSettings = chat?.generationSettings as unknown
      if (
        !chatId ||
        !isDatabaseRecord(generationSettings) ||
        generationSettings.agentPresetId !== presetId ||
        resolveUniqueChatGenerationSettings(characterId, chatId) !== generationSettings
      ) {
        continue
      }
      rollbacks.push(
        captureAgentPresetDeleteFieldRollback({
          target: generationSettings,
          resolveTarget: () => resolveUniqueChatGenerationSettings(characterId, chatId),
          keys: ['agentPresetId'],
          mutate: () => delete generationSettings.agentPresetId,
          reconciliationTarget: { kind: 'character', characterId },
        }),
      )
    }
  }
  return rollbacks
}

function clearLoadoutAgentPresetSelections(presetId: string): AgentPresetDeleteFieldRollback[] {
  const rollbacks: AgentPresetDeleteFieldRollback[] = []
  for (const loadout of loadoutCollectionOwnerRead()) {
    const loadoutId = nonBlankId(loadout?.id)
    const target = loadout
    if (!loadoutId || target.agentPresetId !== presetId || resolveUniqueLoadout(loadoutId) !== target) {
      continue
    }
    rollbacks.push(
      captureAgentPresetDeleteFieldRollback({
        target,
        resolveTarget: () => resolveUniqueLoadout(loadoutId),
        keys: ['agentPresetId', 'agentPresetName'],
        mutate: () => {
          delete target.agentPresetId
          delete target.agentPresetName
        },
        reconciliationTarget: { kind: 'collection', name: 'loadouts' },
      }),
    )
  }
  return rollbacks
}

function captureAgentPresetDeleteFieldRollback(input: {
  target: DatabaseRecord
  resolveTarget: () => DatabaseRecord | undefined
  keys: string[]
  mutate: () => void
  reconciliationTarget?: AgentPresetDeleteReconciliationTarget
}): AgentPresetDeleteFieldRollback {
  const previous = snapshotAgentPresetDeleteFieldStates(input.target, input.keys)
  input.mutate()
  return {
    keys: input.keys,
    previous,
    attempted: snapshotAgentPresetDeleteFieldStates(input.target, input.keys),
    targetAtMutation: input.target,
    resolveTarget: input.resolveTarget,
    reconciliationTarget: input.reconciliationTarget,
  }
}

function restoreAgentPresetDeleteFields(
  rollback: AgentPresetDeleteFieldRollback,
): AgentPresetDeleteReconciliationTarget | undefined {
  const target = rollback.resolveTarget()
  if (!target) return
  // Treat related loadout id/name fields atomically. A later edit to either
  // field supersedes this rollback and must not be partially overwritten.
  if (rollback.keys.some((key) => !jsonFieldStateMatches(target, key, rollback.attempted[key]))) return
  if (target !== rollback.targetAtMutation && rollback.reconciliationTarget) return rollback.reconciliationTarget
  for (const key of rollback.keys) {
    const previous = rollback.previous[key]
    if (previous.present) target[key] = safeStructuredClone(previous.value)
    else delete target[key]
  }
}

function scheduleAgentPresetDeleteReferenceReconciliation(
  targets: readonly AgentPresetDeleteReconciliationTarget[],
): void {
  if (targets.length === 0) return
  const characterIds = [
    ...new Set(targets.flatMap((target) => (target.kind === 'character' ? [target.characterId] : []))),
  ]
  const refreshLoadouts = targets.some((target) => target.kind === 'collection' && target.name === 'loadouts')
  setTimeout(() => {
    void refreshServerResourceTargets(
      {
        characterIds,
        ...(refreshLoadouts ? { collections: ['loadouts'] as const } : {}),
      },
      {
        hooks: {
          mergePendingAgentPresetCharacters: mergePendingAgentPresetCharactersResource,
          mergePendingAgentPresetLoadouts: mergePendingAgentPresetLoadoutsResource,
        },
      },
    )
      .then((result) => {
        if (result.status === 'error') console.warn(`Unable to reconcile failed Agent Preset delete: ${result.error}`)
      })
      .catch((error) => {
        console.warn('Unable to reconcile failed Agent Preset delete:', error)
      })
  }, 0)
}

function jsonFieldStateMatches(target: DatabaseRecord, key: string, expected: JsonFieldState): boolean {
  const present = Object.prototype.hasOwnProperty.call(target, key)
  if (!expected.present) return !present || target[key] === undefined
  return present && JSON.stringify(target[key]) === JSON.stringify(expected.value)
}

function snapshotAgentPresetDeleteFieldStates(
  target: DatabaseRecord,
  keys: readonly string[],
): Record<string, JsonFieldState> {
  const fields: Record<string, JsonFieldState> = {}
  for (const key of keys) {
    const value = target[key]
    fields[key] =
      Object.prototype.hasOwnProperty.call(target, key) && value !== undefined
        ? { present: true, value: safeStructuredClone(value) }
        : { present: false }
  }
  return fields
}

function resolveUniqueChatGenerationSettings(characterId: string, chatId: string): DatabaseRecord | undefined {
  const character = uniqueCharacterOwner(characterId)
  if (!character) return undefined
  const chats = (character.chats ?? []).filter((chat) => chat?.id === chatId)
  if (chats.length !== 1 || !isDatabaseRecord(chats[0].generationSettings)) return undefined
  return chats[0].generationSettings as unknown as DatabaseRecord
}

function resolveUniqueLoadout(loadoutId: string): DatabaseRecord | undefined {
  const loadouts = loadoutCollectionOwnerRead().filter((loadout) => loadout?.id === loadoutId)
  return loadouts.length === 1 ? loadouts[0] : undefined
}

function isDatabaseRecord(value: unknown): value is DatabaseRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function nonBlankId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
