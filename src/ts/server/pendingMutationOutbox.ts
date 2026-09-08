import {
  canUseClientRecoveryAccess,
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  clientSessionStore,
  getClientSessionSnapshot,
  isClientSessionGenerationCurrent,
  isClientSessionManaged,
  registerClientWriterLossHandler,
} from '../clientSession'
import {
  captureClientWriteOperation,
  assertClientWriteOperation,
  isClientWriteOperationCurrent,
} from '../clientWriteOperation'
import { gcm } from '@noble/ciphers/aes.js'
import {
  findProtocolDurableCommandOperation,
  protocolDurableGenerationOperationMatches,
} from '@risuai/protocol/durable-command-operation'

import { clearRetainedChatProjections } from './chatRetainedProjection'
import { beginPersistenceActivity, setPendingMutationOutboxActive } from './persistenceActivity.svelte'
import {
  captureBrowserDiagnosticsGeneration,
  isBrowserDiagnosticsGenerationCurrent,
  recordBrowserDiagnostic,
} from './browserDiagnostics'

export type DurableMutationRequestMethod = 'DELETE' | 'PATCH' | 'POST' | 'PUT'

export interface DurableMutationRequest {
  method: DurableMutationRequestMethod
  /** Command path below `/api/v1/commands`, including the leading slash. */
  path: string
  /** Command fields exclude enqueue-time `baseRevision`; atomic submit persists its complete request. */
  body: Record<string, unknown>
}

export interface DurableMutationIntent {
  version: 1
  /** Non-command mutation families that share the encrypted transport outbox. */
  kind?: 'generation-operation-submit' | 'generation-operation-cancel' | 'generation-operation-retry'
  requests: DurableMutationRequest[]
  /**
   * Additional semantic lanes that must settle before this intent. The keys
   * are encrypted with the request payload and are used only for client-side
   * ordering; they are never sent to the command API.
   */
  dependencyKeys?: string[]
}

type PendingMutationPhase = 'dispatching' | 'staged' | 'superseded'

export type PendingMutationPersistenceStatus = 'persisted' | 'superseded' | 'unavailable'
export type PendingMutationAcknowledgement = 'deleted' | 'superseded' | 'unavailable'

export interface PendingMutationHandle {
  readonly key: string
  readonly mutationId: string
  readonly sequence: number
  readonly ownerWriterSessionId: string | null
  readonly writerEpoch: number | null
  readonly databaseLineage: string | null
  readonly ready: Promise<PendingMutationPersistenceStatus>
  phase: PendingMutationPhase
}

export interface PendingMutationProjectionFence {
  readonly target: string
  readonly generationId: string
  readonly ordinal: number
  readonly ownerWriterSessionId: string
  readonly writerEpoch: number
  readonly databaseLineage: string
}

export interface PendingMutationLocalProjectionToken {
  readonly generationId: string
}

export interface PendingMutationOutboxEntry {
  handle: PendingMutationHandle
  intent: DurableMutationIntent
}

export type PendingMutationPredecessorResult =
  | { status: 'ok'; entries: PendingMutationOutboxEntry[]; semanticKeys: string[] }
  | { status: 'superseded' | 'unavailable' }

export type PendingMutationIntentReplacementResult =
  | { status: 'replaced' | 'successor'; handle: PendingMutationHandle }
  | { status: 'superseded' | 'unavailable' }

export interface PendingMutationReceiptAcknowledgement {
  mutationId: string
  requestCount: number
  databaseLineage: string
  queuedAt: number
}

export interface PreparePendingMutationOutboxInput {
  writerSessionId: string
  writerEpoch: number
  databaseLineage: string
  requestedWriterWasActive: boolean
  /** Runs synchronously before a changed scope can admit replacement-owner writes. */
  onOwnershipChange?: () => void
}

export interface PreparePendingMutationOutboxSummary {
  discarded: number
}

export type PendingMutationDiscardListener = (mutationId: string) => void

export interface PendingMutationOwnerCandidate {
  writerSessionId: string
  writerEpoch: number
  databaseLineage: string
}

interface PendingMutationScope {
  writerSessionId: string
  writerEpoch: number
  databaseLineage: string
}

interface LivePendingMutationProjectionGeneration {
  id: string
  ordinal: number
  scope: PendingMutationScope
  targetKeys: Set<string>
}

type OutboxKeyKind = 'raw' | 'subtle'

interface StoredPendingMutation {
  mutationId: string
  semanticKey: string
  sequence: number
  order: number
  /** Plaintext transaction fence; missing v3 rows are treated as unstarted. */
  dispatchStarted?: boolean
  ownerWriterSessionId: string
  writerEpoch: number
  databaseLineage: string
  updatedAt: number
  /** Original queue admission time; legacy rows fall back to their last persisted update. */
  queuedAt?: number
  /** Missing on legacy rows, which always use the WebCrypto key. */
  keyKind?: OutboxKeyKind
  iv: ArrayBuffer
  ciphertext: ArrayBuffer
}

interface StoredPendingMutationOrderCounter {
  version: 1
  writerSessionId: string
  databaseLineage: string
  lastCommittedOrder: number
}

interface EncryptedPendingMutationPayload {
  intent: DurableMutationIntent
}

type OutboxEncryptionKey = { keyKind: 'raw'; key: Uint8Array<ArrayBuffer> } | { keyKind: 'subtle'; key: CryptoKey }

const OUTBOX_DATABASE_NAME = 'risu-pending-mutations-v1'
const OUTBOX_DATABASE_VERSION = 3
const OUTBOX_MUTATION_STORE = 'mutations'
const OUTBOX_KEY_STORE = 'keys'
const OUTBOX_ORDER_STORE = 'orders'
const OUTBOX_RECEIPT_ACK_STORE = 'receiptAcks'
const OUTBOX_ENCRYPTION_KEY_ID = 'pending-mutation-aes-gcm-v1'
const OUTBOX_RAW_ENCRYPTION_KEY_ID = 'pending-mutation-aes-gcm-raw-v1'
const MAX_DURABLE_MUTATION_REQUESTS = 100
const MAX_DURABLE_MUTATION_DEPENDENCY_KEYS = 32
export const MAX_DURABLE_MUTATION_PAYLOAD_BYTES = 16 * 1024 * 1024
const MAX_PENDING_MUTATION_KEY_LENGTH = 2_048
const MUTATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,96}$/
const SCOPE_VALUE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

let pendingMutationActivityRefresh = 0

let outboxDatabasePromise: Promise<IDBDatabase | null> | null = null
let outboxRawEncryptionKeyPromise: Promise<OutboxEncryptionKey | null> | null = null
let outboxSubtleEncryptionKeyPromise: Promise<OutboxEncryptionKey | null> | null = null
let nextSequenceOffset = 0
let nextProjectionGenerationOrdinal = 0
let persistenceWarningReported = false
let pendingMutationScope: PendingMutationScope | null = null
let lastQueueDiagnostic:
  | { scope: PendingMutationScope; generation: number; count: number; oldest: number | null }
  | undefined
let handleSessionGenerations = new WeakMap<PendingMutationHandle, number>()
const pendingMutationStageLockTails = new Map<string, Promise<void>>()
const admittedPendingMutationWrites = new Set<Promise<PendingMutationPersistenceStatus>>()
const liveProjectionGenerations = new Map<string, LivePendingMutationProjectionGeneration>()
const liveProjectionGenerationStacks = new Map<string, string[]>()
const pendingMutationDiscardListeners = new Set<PendingMutationDiscardListener>()
let pendingMutationCommitTransactionHookForTests: ((transaction: IDBTransaction) => void) | null = null

/** Originating page generation for delayed dispatch and exact settlement callbacks. */
export function getPendingMutationHandleSessionGeneration(handle: PendingMutationHandle): number {
  return handleSessionGenerations.get(handle) ?? captureClientSessionGeneration()
}

function stampPendingHandle(handle: PendingMutationHandle, generation: number): PendingMutationHandle {
  handleSessionGenerations.set(handle, generation)
  return handle
}

function outboxRecoveryIsCurrent(generation: number): boolean {
  return canUseClientRecoveryAccess() && isClientSessionGenerationCurrent(generation)
}

function canRecoverPendingOwner(writerSessionId: string | null, databaseLineage: string | null): boolean {
  const session = getClientSessionSnapshot()
  return !session.managed || (session.sessionId === writerSessionId && session.databaseLineage === databaseLineage)
}

function assertOutboxRecovery(generation: number): void {
  if (!canUseClientRecoveryAccess()) throw new Error('client_recovery_access_required')
  if (!isClientSessionGenerationCurrent(generation)) throw new Error('client_recovery_operation_stale')
}

function watchOutboxTransaction(transaction: IDBTransaction, generation: number, ordinaryWrite = false): () => void {
  const current = () =>
    ordinaryWrite ? isClientWriteOperationCurrent(generation) : outboxRecoveryIsCurrent(generation)
  const abort = () => {
    if (current()) return
    try {
      transaction.abort()
    } catch {}
  }
  const stopLoss = registerClientWriterLossHandler(abort)
  const stopSession = clientSessionStore.subscribe(abort)
  return () => {
    stopLoss()
    stopSession()
  }
}

clientSessionStore.subscribe(() => {
  if (isClientSessionManaged() && !canUseClientRecoveryAccess()) {
    pendingMutationActivityRefresh += 1
    clearLivePendingMutationProjectionGenerations()
    setPendingMutationOutboxActive(false)
  }
})

export function pendingMutationSettingsFieldProjectionTarget(field: string): string {
  return `settings-field:${encodeProjectionTargetPart(field)}`
}

export function pendingMutationModuleEnabledProjectionTarget(moduleId: string): string {
  return `module-enabled:${encodeProjectionTargetPart(moduleId)}`
}

export function pendingMutationPluginRowProjectionTarget(pluginId: string): string {
  return `plugin-row:${encodeProjectionTargetPart(pluginId)}`
}

export function pendingMutationPluginProviderProjectionTarget(): string {
  return 'plugin-provider:current'
}

export function pendingMutationPluginOrderProjectionTarget(): string {
  return 'plugin-order:current'
}

export function pendingMutationPluginStorageProjectionTarget(key: string): string {
  return `plugin-storage:${encodeProjectionTargetPart(key)}`
}

export function pendingMutationAgentPresetRowProjectionTarget(presetId: string): string {
  return `agent-preset-row:${encodeProjectionTargetPart(presetId)}`
}

export function pendingMutationAgentPresetCollectionProjectionTarget(): string {
  return 'agent-preset-collection'
}

export function pendingMutationAgentPresetStepsProjectionTarget(presetId: string): string {
  return `agent-preset-steps:${encodeProjectionTargetPart(presetId)}`
}

export function pendingMutationAgentPresetStepProjectionTarget(presetId: string, stepId: string): string {
  return `agent-preset-step:${encodeProjectionTargetPart(presetId)}:${encodeProjectionTargetPart(stepId)}`
}

export function pendingMutationAgentPresetOrderProjectionTarget(): string {
  return 'agent-preset-order'
}

export function pendingMutationAgentPresetDefaultProjectionTarget(): string {
  return 'agent-preset-default'
}

export function pendingMutationAgentCollectionProjectionTarget(): string {
  return 'agent-collection'
}

export function pendingMutationAgentRowProjectionTarget(agentId: string): string {
  return `agent-row:${encodeProjectionTargetPart(agentId)}`
}

export function pendingMutationLoadoutRowProjectionTarget(loadoutId: string): string {
  return `loadout-row:${encodeProjectionTargetPart(loadoutId)}`
}

export function pendingMutationChatGenerationSettingsProjectionTarget(chatId: string): string {
  return `chat-generation-settings:${encodeProjectionTargetPart(chatId)}`
}

export function pendingMutationCharacterLorebooksProjectionTarget(characterId: string): string {
  return `character-lorebooks:${encodeProjectionTargetPart(characterId)}`
}

export function pendingMutationCharacterScriptsProjectionTarget(characterId: string): string {
  return `character-scripts:${encodeProjectionTargetPart(characterId)}`
}

export function pendingMutationCharacterTriggersProjectionTarget(characterId: string): string {
  return `character-triggers:${encodeProjectionTargetPart(characterId)}`
}

export function pendingMutationCharacterOrderProjectionTarget(): string {
  return 'character-order'
}

export function pendingMutationPersonaRowProjectionTarget(personaId: string): string {
  return `persona-row:${encodeProjectionTargetPart(personaId)}`
}

export function pendingMutationPresetRowProjectionTarget(
  kind: 'legacy' | 'model' | 'prompt',
  presetId: string,
): string {
  return `preset-row:${kind}:${encodeProjectionTargetPart(presetId)}`
}

export function pendingMutationSelectionProjectionTarget(
  kind: 'legacyPreset' | 'modelPreset' | 'persona' | 'promptPreset',
): string {
  return `selection:${kind}`
}

/**
 * Record additional concrete projection fields owned by an already-staged
 * durable generation. Registration preserves its original stage ordinal, so
 * late intent preparation cannot jump ahead of a newer user action.
 */
export function recordPendingMutationProjectionTargets(
  handle: PendingMutationHandle,
  targets: readonly string[],
): void {
  if (!canUseClientWriteAccess()) return
  const scope = pendingMutationScopeFromHandle(handle)
  if (!scope) return
  recordLiveProjectionGeneration(projectionGenerationId(scope, handle.mutationId), scope, targets)
}

/** Advance concrete projection fields for optimistic writers without an outbox row. */
export function advancePendingMutationProjectionTargets(
  targets: readonly string[],
): PendingMutationLocalProjectionToken | null {
  const scope = pendingMutationScope
  if (!canUseClientWriteAccess() || !scope || targets.length === 0) return null
  const generationId = projectionGenerationId(scope, `local-${createMutationId()}`)
  recordLiveProjectionGeneration(generationId, scope, targets)
  return { generationId }
}

export function retirePendingMutationLocalProjectionToken(token: PendingMutationLocalProjectionToken | null): void {
  if (token) retireLiveProjectionGeneration(token.generationId)
}

export function acceptPendingMutationLocalProjectionToken(token: PendingMutationLocalProjectionToken | null): void {
  if (token) compactAcceptedLiveProjectionGeneration(token.generationId)
}

export function pendingMutationProjectionTargets(intent: DurableMutationIntent): string[] {
  return normalizedPendingMutationProjectionTargets(normalizeIntent(intent))
}

/** Read metadata only after the caller has captured/validated its owned intent. */
function normalizedPendingMutationProjectionTargets(normalized: DurableMutationIntent): string[] {
  if (normalized.kind) {
    const operationId = generationOperationIdFromPendingIntent(normalized)
    return operationId ? [`generation-operation:${operationId}`] : []
  }
  const targets = new Set<string>()
  for (const request of normalized.requests) {
    for (const target of pendingMutationRequestProjectionTargets(request)) targets.add(target)
  }
  if (normalized.requests.some((request) => request.path === '/personas/select')) {
    for (const dependencyKey of normalized.dependencyKeys ?? []) {
      if (dependencyKey.startsWith('persona-profile:')) {
        targets.add(pendingMutationPersonaRowProjectionTarget(dependencyKey.slice('persona-profile:'.length)))
      }
    }
  }
  return Array.from(targets).sort()
}

export function pendingMutationProjectionFence(
  handle: PendingMutationHandle,
  target: string,
): PendingMutationProjectionFence | null {
  const scope = pendingMutationScopeFromHandle(handle)
  if (!scope) return null
  return liveProjectionFence(projectionGenerationId(scope, handle.mutationId), target)
}

export function pendingMutationLocalProjectionFence(
  token: PendingMutationLocalProjectionToken | null,
  target: string,
): PendingMutationProjectionFence | null {
  return token ? liveProjectionFence(token.generationId, target) : null
}

/** Test/support hook for asserting accepted-generation compaction. */
export function pendingMutationProjectionGenerationCountForTests(): number {
  return liveProjectionGenerations.size
}

function liveProjectionFence(generationId: string, target: string): PendingMutationProjectionFence | null {
  const generation = liveProjectionGenerations.get(generationId)
  if (!generation) return null
  const normalizedTarget = normalizeProjectionTarget(target)
  const targetKey = projectionTargetKey(generation.scope, normalizedTarget)
  if (!generation.targetKeys.has(targetKey)) return null
  return {
    target: normalizedTarget,
    generationId,
    ordinal: generation.ordinal,
    ownerWriterSessionId: generation.scope.writerSessionId,
    writerEpoch: generation.scope.writerEpoch,
    databaseLineage: generation.scope.databaseLineage,
  }
}

export function isPendingMutationProjectionFenceCurrent(fence: PendingMutationProjectionFence): boolean {
  if (!canUseClientWriteAccess()) return false
  const currentScope = pendingMutationScope
  if (
    !currentScope ||
    currentScope.writerSessionId !== fence.ownerWriterSessionId ||
    currentScope.writerEpoch !== fence.writerEpoch ||
    currentScope.databaseLineage !== fence.databaseLineage
  ) {
    return false
  }
  const targetKey = projectionTargetKey(
    {
      writerSessionId: fence.ownerWriterSessionId,
      writerEpoch: fence.writerEpoch,
      databaseLineage: fence.databaseLineage,
    },
    fence.target,
  )
  return liveProjectionGenerationStacks.get(targetKey)?.at(-1) === fence.generationId
}

export function retirePendingMutationProjectionTargets(handle: PendingMutationHandle): void {
  retirePendingMutationProjectionGeneration(handle)
}

/**
 * Recover a single unambiguous owner before writer-intent bootstrap when a
 * browser restart lost sessionStorage but retained IndexedDB.
 */
export async function readSinglePendingMutationOwner(): Promise<PendingMutationOwnerCandidate | null> {
  if (isClientSessionManaged()) return null
  const generation = captureClientSessionGeneration()
  const database = await openOutboxDatabase()
  if (!database) return null
  try {
    const transaction = database.transaction(OUTBOX_MUTATION_STORE, 'readonly')
    const mutations = await requestResult<StoredPendingMutation[]>(
      transaction.objectStore(OUTBOX_MUTATION_STORE).getAll(),
    )
    await transactionDone(transaction)
    if (isClientSessionManaged() || !isClientSessionGenerationCurrent(generation)) return null
    const owners = new Map<string, PendingMutationOwnerCandidate>()
    for (const mutation of mutations) {
      if (
        !SCOPE_VALUE_PATTERN.test(mutation.ownerWriterSessionId) ||
        !Number.isSafeInteger(mutation.writerEpoch) ||
        mutation.writerEpoch < 0 ||
        !SCOPE_VALUE_PATTERN.test(mutation.databaseLineage)
      ) {
        continue
      }
      const owner = {
        writerSessionId: mutation.ownerWriterSessionId,
        writerEpoch: mutation.writerEpoch,
        databaseLineage: mutation.databaseLineage,
      }
      const ownerKey = `${owner.writerSessionId}\u0000${owner.databaseLineage}`
      const existing = owners.get(ownerKey)
      if (!existing || owner.writerEpoch > existing.writerEpoch) owners.set(ownerKey, owner)
      if (owners.size > 1) return null
    }
    return owners.values().next().value ?? null
  } catch (error) {
    reportPersistenceWarning('Unable to recover pending-mutation ownership', error)
    return null
  }
}

/**
 * Bind subsequent staging and replay to the authenticated writer and the
 * concrete server database. A same-session ownership reclaim keeps older-epoch
 * rows replayable: mutation receipts are lineage-scoped, and the current
 * active-writer header still gates every replay request. Rows from another
 * writer session in the same lineage stay encrypted and dormant so their owner
 * can reclaim them later; listing and startup replay remain scoped to the
 * current session. A database-lineage change is the conclusive disposal
 * boundary because those intents can never be valid against the replacement.
 */
export async function preparePendingMutationOutbox(
  input: PreparePendingMutationOutboxInput,
): Promise<PreparePendingMutationOutboxSummary> {
  const generation = captureClientSessionGeneration()
  assertOutboxRecovery(generation)
  const scope = normalizeScope(input.writerSessionId, input.writerEpoch, input.databaseLineage)
  const managed = isClientSessionManaged()
  const requestedWriterWasActive = input.requestedWriterWasActive
  const onOwnershipChange = input.onOwnershipChange
  if (managed && scope.writerSessionId !== getClientSessionSnapshot().sessionId) {
    throw new Error('client_recovery_owner_mismatch')
  }
  const adoptScope = () => {
    assertOutboxRecovery(generation)
    const ownershipChanged = pendingMutationScope !== null && !pendingMutationScopeEquals(scope)
    const lineageChanged =
      pendingMutationScope !== null && pendingMutationScope.databaseLineage !== scope.databaseLineage
    // The conservative path retains its established reset policy. Connected
    // writer epochs park intent; only authenticated lineage replacement disposes it.
    const resetOwners = managed ? lineageChanged : ownershipChanged
    if (resetOwners) onOwnershipChange?.()
    assertOutboxRecovery(generation)
    if (!requestedWriterWasActive || ownershipChanged) {
      clearLivePendingMutationProjectionGenerations()
      if (!managed || lineageChanged) clearRetainedChatProjections()
    }
    pendingMutationScope = scope
  }
  // Preserve legacy synchronous scope setup. Managed recovery commits adoption
  // only after awaited storage reads have passed the originating session fence.
  if (!managed) adoptScope()
  else {
    // A just-demoted writer may still be finishing encryption for an intent
    // that was already admitted. Recovery must see that row before replay.
    await Promise.all([...admittedPendingMutationWrites])
    assertOutboxRecovery(generation)
  }
  const [database, encryptionKey] = await Promise.all([openOutboxDatabase(), getOutboxEncryptionKey()])
  assertOutboxRecovery(generation)
  if (!database || !encryptionKey) {
    if (managed) adoptScope()
    await refreshPendingMutationActivity()
    assertOutboxRecovery(generation)
    return { discarded: 0 }
  }

  const discardedMutationIds: string[] = []
  let stopTransactionWatch: (() => void) | undefined
  try {
    const transaction = database.transaction([OUTBOX_MUTATION_STORE, OUTBOX_RECEIPT_ACK_STORE], 'readwrite')
    const done = transactionDone(transaction)
    void done.catch(() => undefined)
    stopTransactionWatch = watchOutboxTransaction(transaction, generation)
    const mutationStore = transaction.objectStore(OUTBOX_MUTATION_STORE)
    const receiptStore = transaction.objectStore(OUTBOX_RECEIPT_ACK_STORE)
    const [mutations, receipts] = await Promise.all([
      requestResult<StoredPendingMutation[]>(mutationStore.getAll()),
      requestResult<PendingMutationReceiptAcknowledgement[]>(receiptStore.getAll()),
    ])
    assertOutboxRecovery(generation)
    if (managed) adoptScope()
    for (const mutation of mutations) {
      if (mutation.databaseLineage !== scope.databaseLineage) {
        mutationStore.delete(mutation.mutationId)
        discardedMutationIds.push(mutation.mutationId)
      }
    }
    for (const receipt of receipts) {
      if (receipt.databaseLineage !== scope.databaseLineage) receiptStore.delete(receipt.mutationId)
    }
    await done
    assertOutboxRecovery(generation)
    for (const mutationId of discardedMutationIds) publishPendingMutationDiscard(mutationId)
  } catch (error) {
    assertOutboxRecovery(generation)
    reportPersistenceWarning('Unable to prepare the pending-mutation outbox', error)
    await refreshPendingMutationActivity()
    assertOutboxRecovery(generation)
    return { discarded: 0 }
  } finally {
    stopTransactionWatch?.()
  }
  await refreshPendingMutationActivity()
  assertOutboxRecovery(generation)
  return { discarded: discardedMutationIds.length }
}

/**
 * Observe rows removed while authenticated database ownership is prepared.
 * The durable dispatcher uses this hook to publish terminal settlements
 * without making the outbox import its higher-level dispatch module.
 */
export function registerPendingMutationDiscardListener(listener: PendingMutationDiscardListener): () => void {
  pendingMutationDiscardListeners.add(listener)
  return () => pendingMutationDiscardListeners.delete(listener)
}

function publishPendingMutationDiscard(mutationId: string): void {
  for (const listener of pendingMutationDiscardListeners) {
    try {
      listener(mutationId)
    } catch (error) {
      console.error('Pending mutation discard listener rejected:', error)
    }
  }
}

/**
 * Persist a coalesced autosave intent before its network debounce settles.
 *
 * Every generation gets a fresh receipt id. Restaging transactionally removes
 * an exact predecessor only while its persisted dispatch marker is still
 * false; otherwise both ordered rows remain durable for predecessor draining.
 */
export function stagePendingMutation(
  key: string,
  intent: DurableMutationIntent,
  previous?: PendingMutationHandle | null,
): PendingMutationHandle {
  const generation = captureClientWriteOperation()
  const semanticKey = normalizeOutboxKey(key)
  const normalizedIntent = normalizeIntent(intent)
  assertClientWriteOperation(generation)
  return stageNormalizedPendingMutation(semanticKey, normalizedIntent, previous)
}

/** Internal continuation of the normalization ownership boundary. Replacement
 * already owns a normalized snapshot and must not recapture its body. */
function stageNormalizedPendingMutation(
  semanticKey: string,
  normalizedIntent: DurableMutationIntent,
  previous?: PendingMutationHandle | null,
): PendingMutationHandle {
  const generation = captureClientWriteOperation()
  const scope = pendingMutationScope
  const replacePrevious =
    !!scope &&
    previous?.phase === 'staged' &&
    previous.key === semanticKey &&
    previous.ownerWriterSessionId === scope.writerSessionId &&
    previous.writerEpoch === scope.writerEpoch &&
    previous.databaseLineage === scope.databaseLineage
  // A server receipt permanently binds an id to one semantic fingerprint.
  // Restaging therefore always gets a fresh id; the persistence transaction
  // below may still atomically remove an exact predecessor that never started.
  const mutationId = createMutationId()
  const sequence = nextMutationSequence()

  if (replacePrevious && previous) previous.phase = 'superseded'

  const ready = scope
    ? persistPendingMutation(
        semanticKey,
        mutationId,
        sequence,
        scope,
        normalizedIntent,
        replacePrevious ? previous : null,
      )
    : Promise.resolve('unavailable' as const)
  admittedPendingMutationWrites.add(ready)
  void ready.then(
    () => admittedPendingMutationWrites.delete(ready),
    () => admittedPendingMutationWrites.delete(ready),
  )
  if (!scope) reportPersistenceWarning('Pending mutation staged before server database ownership was established')
  const finishPersistenceActivity = scope ? beginPersistenceActivity() : null

  const handle: PendingMutationHandle = {
    key: semanticKey,
    mutationId,
    sequence,
    ownerWriterSessionId: scope?.writerSessionId ?? null,
    writerEpoch: scope?.writerEpoch ?? null,
    databaseLineage: scope?.databaseLineage ?? null,
    phase: 'staged',
    ready,
  }
  stampPendingHandle(handle, generation)
  recordPendingMutationProjectionTargets(handle, normalizedPendingMutationProjectionTargets(normalizedIntent))
  void ready.then(async (status) => {
    if (status !== 'persisted') retirePendingMutationProjectionGeneration(handle)
    if (status === 'persisted' && isClientWriteOperationCurrent(generation)) {
      setPendingMutationOutboxActive(true)
    } else {
      await refreshPendingMutationActivity()
    }
    finishPersistenceActivity?.()
  })
  return handle
}

/** Exact encrypted JSON envelope size used by the persisted outbox row. */
export function pendingMutationIntentPayloadByteLength(intent: DurableMutationIntent): number {
  return serializePendingMutationIntent(normalizeIntent(intent)).byteLength
}

/** Freeze this exact payload/id for dispatch. Later edits must stage a new id. */
export async function beginPendingMutationDispatch(
  handle: PendingMutationHandle,
): Promise<PendingMutationPersistenceStatus> {
  const generation = getPendingMutationHandleSessionGeneration(handle)
  if (
    !outboxRecoveryIsCurrent(generation) ||
    !canRecoverPendingOwner(handle.ownerWriterSessionId, handle.databaseLineage) ||
    handle.phase === 'superseded'
  )
    return 'superseded'
  handle.phase = 'dispatching'
  const persistence = await handle.ready
  if (!outboxRecoveryIsCurrent(generation)) return 'superseded'
  if (persistence !== 'persisted') return persistence
  return markPendingMutationDispatchStarted(handle, generation)
}

/**
 * Replace a queued placeholder with its exact prepared request without moving
 * its durable order. The sequence changes so a replay that already decrypted
 * the placeholder cannot send it after this transaction wins. If dispatch
 * marked the placeholder first, preserve it and return a fresh successor.
 */
export async function replaceStagedPendingMutationIntent(
  handle: PendingMutationHandle,
  intent: DurableMutationIntent,
): Promise<PendingMutationIntentReplacementResult> {
  const generation = getPendingMutationHandleSessionGeneration(handle)
  if (
    !isClientWriteOperationCurrent(generation) ||
    !canRecoverPendingOwner(handle.ownerWriterSessionId, handle.databaseLineage) ||
    handle.phase !== 'staged'
  )
    return { status: 'superseded' }
  const normalizedIntent = normalizeIntent(intent)
  if (!isClientWriteOperationCurrent(generation)) return { status: 'superseded' }
  const replacement = await replacePendingMutationIntentExact(handle, normalizedIntent, generation)
  if (!isClientWriteOperationCurrent(generation)) return { status: 'superseded' }
  if (replacement.status === 'replaced') {
    handle.phase = 'superseded'
    recordPendingMutationProjectionTargets(
      replacement.handle,
      normalizedPendingMutationProjectionTargets(normalizedIntent),
    )
    return replacement
  }
  if (replacement.status === 'unavailable') return { status: 'unavailable' }

  const scope = pendingMutationScope
  if (!scope || !pendingMutationScopeMatchesHandle(scope, handle)) return { status: 'superseded' }
  handle.phase = 'superseded'
  const successor = stageNormalizedPendingMutation(normalizeOutboxKey(handle.key), normalizedIntent)
  const persistence = await successor.ready
  return persistence === 'persisted' ? { status: 'successor', handle: successor } : { status: persistence }
}

/** Verify the exact encrypted generation still exists before starting a request. */
export async function isPendingMutationCurrent(handle: PendingMutationHandle): Promise<boolean> {
  const database = await openOutboxDatabase()
  if (!database || !handle.ownerWriterSessionId || handle.writerEpoch === null || !handle.databaseLineage) return false
  try {
    const transaction = database.transaction(OUTBOX_MUTATION_STORE, 'readonly')
    const current = await requestResult<StoredPendingMutation | undefined>(
      transaction.objectStore(OUTBOX_MUTATION_STORE).get(handle.mutationId),
    )
    await transactionDone(transaction)
    return storedMutationMatchesHandle(current, handle)
  } catch (error) {
    reportPersistenceWarning('Unable to verify a pending server mutation', error)
    return false
  }
}

async function markPendingMutationDispatchStarted(
  handle: PendingMutationHandle,
  generation: number,
): Promise<PendingMutationPersistenceStatus> {
  const database = await openOutboxDatabase()
  if (!outboxRecoveryIsCurrent(generation)) return 'superseded'
  if (!database) return 'unavailable'
  let stopWatch: (() => void) | undefined
  try {
    const transaction = database.transaction(OUTBOX_MUTATION_STORE, 'readwrite')
    const done = transactionDone(transaction)
    void done.catch(() => undefined)
    stopWatch = watchOutboxTransaction(transaction, generation)
    const store = transaction.objectStore(OUTBOX_MUTATION_STORE)
    const current = await requestResult<StoredPendingMutation | undefined>(store.get(handle.mutationId))
    if (!outboxRecoveryIsCurrent(generation)) {
      transaction.abort()
      return 'superseded'
    }
    const matches = storedMutationMatchesHandle(current, handle)
    if (matches && current && current.dispatchStarted !== true) {
      store.put({ ...current, dispatchStarted: true } satisfies StoredPendingMutation)
    }
    await done
    if (!outboxRecoveryIsCurrent(generation)) return 'superseded'
    return matches ? 'persisted' : 'superseded'
  } catch (error) {
    if (!outboxRecoveryIsCurrent(generation)) return 'superseded'
    reportPersistenceWarning('Unable to mark a pending server mutation for dispatch', error)
    return 'unavailable'
  } finally {
    stopWatch?.()
  }
}

/** Delete a no-op or terminally rejected intent without creating a receipt ACK. */
export async function discardPendingMutation(handle: PendingMutationHandle): Promise<PendingMutationAcknowledgement> {
  const persistence = await handle.ready
  if (persistence === 'unavailable') {
    retirePendingMutationProjectionGeneration(handle)
    return 'unavailable'
  }
  const database = await openOutboxDatabase()
  if (!database) return 'unavailable'

  try {
    const transaction = database.transaction(OUTBOX_MUTATION_STORE, 'readwrite')
    const store = transaction.objectStore(OUTBOX_MUTATION_STORE)
    const current = await requestResult<StoredPendingMutation | undefined>(store.get(handle.mutationId))
    const matches = storedMutationMatchesHandle(current, handle)
    if (matches) store.delete(handle.mutationId)
    await transactionDone(transaction)
    if (matches) retirePendingMutationProjectionGeneration(handle)
    if (matches) void refreshPendingMutationActivity()
    return matches ? 'deleted' : 'superseded'
  } catch (error) {
    reportPersistenceWarning('Unable to discard a pending server mutation', error)
    return 'unavailable'
  }
}

/** Compatibility name for callers cancelling a staged/no-op mutation. */
export const acknowledgePendingMutation = discardPendingMutation

/**
 * Atomically remove an accepted intent and queue its server receipt cleanup.
 * A crash at any later point can leak neither the domain intent nor the ACK.
 */
export async function completePendingMutation(
  handle: PendingMutationHandle,
  requestCount: number,
): Promise<PendingMutationAcknowledgement> {
  if (!Number.isInteger(requestCount) || requestCount < 1 || requestCount > MAX_DURABLE_MUTATION_REQUESTS) {
    throw new RangeError('Pending mutation receipt request count is invalid')
  }
  const persistence = await handle.ready
  if (persistence === 'unavailable' || !handle.databaseLineage) return 'unavailable'
  const database = await openOutboxDatabase()
  if (!database) return 'unavailable'

  try {
    const transaction = database.transaction([OUTBOX_MUTATION_STORE, OUTBOX_RECEIPT_ACK_STORE], 'readwrite')
    const mutationStore = transaction.objectStore(OUTBOX_MUTATION_STORE)
    const current = await requestResult<StoredPendingMutation | undefined>(mutationStore.get(handle.mutationId))
    const matches = storedMutationMatchesHandle(current, handle)
    if (matches) {
      mutationStore.delete(handle.mutationId)
      transaction.objectStore(OUTBOX_RECEIPT_ACK_STORE).put({
        mutationId: handle.mutationId,
        requestCount,
        databaseLineage: handle.databaseLineage,
        queuedAt: Date.now(),
      } satisfies PendingMutationReceiptAcknowledgement)
    }
    await transactionDone(transaction)
    if (matches) compactAcceptedPendingMutationProjectionGeneration(handle)
    if (matches) void refreshPendingMutationActivity()
    return matches ? 'deleted' : 'superseded'
  } catch (error) {
    reportPersistenceWarning('Unable to complete a pending server mutation', error)
    return 'unavailable'
  }
}

export async function listPendingMutations(): Promise<PendingMutationOutboxEntry[]> {
  const generation = captureClientSessionGeneration()
  if (!outboxRecoveryIsCurrent(generation)) return []
  const scope = pendingMutationScope
  if (scope && !canRecoverPendingOwner(scope.writerSessionId, scope.databaseLineage)) return []
  const database = await openOutboxDatabase()
  if (!database || !scope || !outboxRecoveryIsCurrent(generation)) return []

  let stored: StoredPendingMutation[]
  try {
    const transaction = database.transaction(OUTBOX_MUTATION_STORE, 'readonly')
    stored = await requestResult<StoredPendingMutation[]>(transaction.objectStore(OUTBOX_MUTATION_STORE).getAll())
    await transactionDone(transaction)
  } catch (error) {
    reportPersistenceWarning('Unable to read pending server mutations', error)
    return []
  }

  const entries: PendingMutationOutboxEntry[] = []
  for (const record of stored
    .filter(
      (candidate) =>
        candidate.ownerWriterSessionId === scope.writerSessionId && candidate.databaseLineage === scope.databaseLineage,
    )
    .sort((left, right) => left.order - right.order)) {
    try {
      const intent = await decryptIntent(record)
      if (!outboxRecoveryIsCurrent(generation)) return []
      const handle: PendingMutationHandle = {
        key: record.semanticKey,
        mutationId: record.mutationId,
        sequence: record.sequence,
        ownerWriterSessionId: record.ownerWriterSessionId,
        writerEpoch: record.writerEpoch,
        databaseLineage: record.databaseLineage,
        phase: 'staged',
        ready: Promise.resolve('persisted'),
      }
      entries.push({ handle: stampPendingHandle(handle, generation), intent })
    } catch (error) {
      reportPersistenceWarning(`Unable to decrypt pending server mutation ${record.semanticKey}`, error)
    }
  }
  return outboxRecoveryIsCurrent(generation) ? entries : []
}

/**
 * Count the current writer/database's raw encrypted rows without decrypting
 * them. Startup uses this after replay so an unreadable intent cannot be
 * mistaken for an empty outbox and followed by stale authoritative hydration.
 */
export async function countPendingMutationRecords(): Promise<number | null> {
  const generation = captureClientSessionGeneration()
  const diagnosticGeneration = captureBrowserDiagnosticsGeneration()
  if (!outboxRecoveryIsCurrent(generation)) return 0
  const scope = pendingMutationScope
  if (scope && !canRecoverPendingOwner(scope.writerSessionId, scope.databaseLineage)) return 0
  if (!scope) return 0
  if (typeof globalThis.indexedDB === 'undefined') return 0
  const database = await openOutboxDatabase()
  if (!outboxRecoveryIsCurrent(generation)) return null
  if (!database) return null

  try {
    const transaction = database.transaction(OUTBOX_MUTATION_STORE, 'readonly')
    const stored = await requestResult<StoredPendingMutation[]>(transaction.objectStore(OUTBOX_MUTATION_STORE).getAll())
    await transactionDone(transaction)
    if (!outboxRecoveryIsCurrent(generation)) return null
    const current = stored.filter(
      (candidate) =>
        candidate.ownerWriterSessionId === scope.writerSessionId && candidate.databaseLineage === scope.databaseLineage,
    )
    recordPendingQueueDiagnostic(current, scope, diagnosticGeneration)
    return current.length
  } catch (error) {
    reportPersistenceWarning('Unable to count pending server mutations', error)
    return null
  }
}

/** Reuse already-read raw metadata; never decrypt intents for telemetry. */
function recordPendingQueueDiagnostic(
  rows: readonly StoredPendingMutation[],
  scope: PendingMutationScope,
  generation: number,
): void {
  try {
    if (pendingMutationScope !== scope || !isBrowserDiagnosticsGenerationCurrent(generation)) return
    let oldest: number | null = rows.length === 0 ? 0 : null
    if (rows.length > 0 && rows.length <= 8192) {
      oldest = Number.MAX_SAFE_INTEGER
      for (const row of rows) {
        const queuedAt = row.queuedAt ?? row.updatedAt
        if (!Number.isSafeInteger(queuedAt) || queuedAt < 0) {
          oldest = null
          break
        }
        oldest = Math.min(oldest, queuedAt)
      }
    }
    if (
      lastQueueDiagnostic?.scope === scope &&
      lastQueueDiagnostic.generation === generation &&
      lastQueueDiagnostic.count === rows.length &&
      lastQueueDiagnostic.oldest === oldest
    )
      return
    lastQueueDiagnostic = { scope, generation, count: rows.length, oldest }
    recordBrowserDiagnostic({
      category: 'browser',
      level: 'info',
      stage: 'queue',
      outcome: rows.length > 0 ? 'pending' : 'ready',
      queuedCount: Math.min(1_000_000_000, rows.length),
      ...(oldest !== null
        ? { queueAgeMs: rows.length === 0 ? 0 : Math.min(86_400_000, Math.max(0, Date.now() - oldest)) }
        : {}),
    })
  } catch {
    // Reading or measuring diagnostics must not affect durable queue admission.
  }
}

/**
 * Count startup-blocking rows after replay. A cancellation control is allowed
 * to remain encrypted while its acknowledged operation settles; replay has
 * already refreshed its visible controller state, and keeping it must not
 * prevent authoritative resource hydration. Unreadable rows still fail closed.
 */
export async function countBlockingPendingMutationRecords(): Promise<number | null> {
  const generation = captureClientSessionGeneration()
  if (!outboxRecoveryIsCurrent(generation)) return 0
  const scope = pendingMutationScope
  if (scope && !canRecoverPendingOwner(scope.writerSessionId, scope.databaseLineage)) return 0
  if (!scope) return 0
  if (typeof globalThis.indexedDB === 'undefined') return 0
  const database = await openOutboxDatabase()
  if (!outboxRecoveryIsCurrent(generation)) return null
  if (!database) return null

  try {
    const transaction = database.transaction(OUTBOX_MUTATION_STORE, 'readonly')
    const stored = await requestResult<StoredPendingMutation[]>(transaction.objectStore(OUTBOX_MUTATION_STORE).getAll())
    await transactionDone(transaction)
    if (!outboxRecoveryIsCurrent(generation)) return null
    let blocking = 0
    for (const record of stored.filter(
      (candidate) =>
        candidate.ownerWriterSessionId === scope.writerSessionId && candidate.databaseLineage === scope.databaseLineage,
    )) {
      const intent = await decryptIntent(record)
      if (!outboxRecoveryIsCurrent(generation)) return null
      if (intent.kind !== 'generation-operation-cancel') blocking += 1
    }
    return blocking
  } catch (error) {
    reportPersistenceWarning('Unable to classify pending server mutations for startup', error)
    return null
  }
}

/**
 * Read the transitive closure of older generations that this mutation owns or
 * depends on. A dependency introduced by an older predecessor only reaches
 * rows older than that predecessor, preserving the durable global-order
 * cutoff instead of pulling unrelated newer work into the chain.
 */
export async function listPendingMutationPredecessors(
  handle: PendingMutationHandle,
  additionalDependencyKeys: readonly string[] = [],
): Promise<PendingMutationPredecessorResult> {
  const generation = getPendingMutationHandleSessionGeneration(handle)
  if (
    !outboxRecoveryIsCurrent(generation) ||
    !canRecoverPendingOwner(handle.ownerWriterSessionId, handle.databaseLineage)
  )
    return { status: 'superseded' }
  const persistence = await handle.ready
  if (!outboxRecoveryIsCurrent(generation)) return { status: 'superseded' }
  if (persistence !== 'persisted') return { status: persistence }
  const database = await openOutboxDatabase()
  if (!outboxRecoveryIsCurrent(generation)) return { status: 'superseded' }
  if (!database) return { status: 'unavailable' }

  let records: StoredPendingMutation[]
  try {
    const transaction = database.transaction(OUTBOX_MUTATION_STORE, 'readonly')
    records = await requestResult<StoredPendingMutation[]>(transaction.objectStore(OUTBOX_MUTATION_STORE).getAll())
    await transactionDone(transaction)
  } catch (error) {
    reportPersistenceWarning('Unable to read pending server mutation predecessors', error)
    return { status: 'unavailable' }
  }

  const current = records.find((record) => record.mutationId === handle.mutationId)
  if (!current || !storedMutationMatchesHandle(current, handle)) return { status: 'superseded' }
  const scopedPredecessors = records
    .filter(
      (record) =>
        record.ownerWriterSessionId === current.ownerWriterSessionId &&
        record.databaseLineage === current.databaseLineage &&
        record.order < current.order,
    )
    .sort((left, right) => left.order - right.order)

  try {
    const currentIntent = await decryptIntent(current)
    if (!outboxRecoveryIsCurrent(generation)) return { status: 'superseded' }
    const orderCutoffByKey = new Map<string, number>([[current.semanticKey, current.order]])
    for (const dependencyKey of [
      ...(currentIntent.dependencyKeys ?? []),
      ...normalizeDependencyKeys(additionalDependencyKeys, false),
    ]) {
      orderCutoffByKey.set(dependencyKey, current.order)
    }

    const selected = new Map<string, PendingMutationOutboxEntry>()
    let expanded = true
    while (expanded) {
      expanded = false
      for (const record of scopedPredecessors) {
        if (selected.has(record.mutationId)) continue
        const cutoff = orderCutoffByKey.get(record.semanticKey)
        if (cutoff === undefined || record.order >= cutoff) continue

        const intent = await decryptIntent(record)
        if (!outboxRecoveryIsCurrent(generation)) return { status: 'superseded' }
        selected.set(record.mutationId, {
          handle: stampPendingHandle(
            {
              key: record.semanticKey,
              mutationId: record.mutationId,
              sequence: record.sequence,
              ownerWriterSessionId: record.ownerWriterSessionId,
              writerEpoch: record.writerEpoch,
              databaseLineage: record.databaseLineage,
              phase: 'staged',
              ready: Promise.resolve('persisted'),
            },
            generation,
          ),
          intent,
        })
        expanded = true

        for (const dependencyKey of intent.dependencyKeys ?? []) {
          const previousCutoff = orderCutoffByKey.get(dependencyKey)
          if (previousCutoff === undefined || previousCutoff < record.order) {
            orderCutoffByKey.set(dependencyKey, record.order)
          }
        }
      }
    }

    const entries = scopedPredecessors
      .map((record) => selected.get(record.mutationId))
      .filter((entry): entry is PendingMutationOutboxEntry => entry !== undefined)
    return {
      status: 'ok',
      entries,
      semanticKeys: Array.from(orderCutoffByKey.keys()).sort(),
    }
  } catch (error) {
    reportPersistenceWarning(`Unable to decrypt pending predecessor ${current.semanticKey}`, error)
    return { status: 'unavailable' }
  }
}

export async function listPendingMutationReceiptAcknowledgements(): Promise<PendingMutationReceiptAcknowledgement[]> {
  const database = await openOutboxDatabase()
  const lineage = pendingMutationScope?.databaseLineage
  if (!database || !lineage) return []
  try {
    const transaction = database.transaction(OUTBOX_RECEIPT_ACK_STORE, 'readonly')
    const records = await requestResult<PendingMutationReceiptAcknowledgement[]>(
      transaction.objectStore(OUTBOX_RECEIPT_ACK_STORE).getAll(),
    )
    await transactionDone(transaction)
    return records
      .filter((record) => record.databaseLineage === lineage)
      .sort((left, right) => left.queuedAt - right.queuedAt)
  } catch (error) {
    reportPersistenceWarning('Unable to read pending mutation receipt acknowledgements', error)
    return []
  }
}

export async function deletePendingMutationReceiptAcknowledgement(
  acknowledgement: PendingMutationReceiptAcknowledgement,
): Promise<boolean> {
  const database = await openOutboxDatabase()
  if (!database) return false
  try {
    const transaction = database.transaction(OUTBOX_RECEIPT_ACK_STORE, 'readwrite')
    const store = transaction.objectStore(OUTBOX_RECEIPT_ACK_STORE)
    const current = await requestResult<PendingMutationReceiptAcknowledgement | undefined>(
      store.get(acknowledgement.mutationId),
    )
    const matches =
      current?.requestCount === acknowledgement.requestCount &&
      current.databaseLineage === acknowledgement.databaseLineage
    if (matches) store.delete(acknowledgement.mutationId)
    await transactionDone(transaction)
    return matches
  } catch (error) {
    reportPersistenceWarning('Unable to delete a pending mutation receipt acknowledgement', error)
    return false
  }
}

/** Test/support hook. Production callers should delete exact handles. */
export async function clearPendingMutationOutbox(): Promise<void> {
  clearLivePendingMutationProjectionGenerations()
  clearRetainedChatProjections()
  const database = await openOutboxDatabase()
  if (!database) return
  const transaction = database.transaction([OUTBOX_MUTATION_STORE, OUTBOX_RECEIPT_ACK_STORE], 'readwrite')
  transaction.objectStore(OUTBOX_MUTATION_STORE).clear()
  transaction.objectStore(OUTBOX_RECEIPT_ACK_STORE).clear()
  await transactionDone(transaction)
  pendingMutationActivityRefresh += 1
  setPendingMutationOutboxActive(false)
}

export function resetPendingMutationOutboxForTests(): void {
  outboxDatabasePromise = null
  outboxRawEncryptionKeyPromise = null
  outboxSubtleEncryptionKeyPromise = null
  nextSequenceOffset = 0
  nextProjectionGenerationOrdinal = 0
  persistenceWarningReported = false
  pendingMutationScope = null
  lastQueueDiagnostic = undefined
  handleSessionGenerations = new WeakMap()
  pendingMutationStageLockTails.clear()
  admittedPendingMutationWrites.clear()
  pendingMutationCommitTransactionHookForTests = null
  pendingMutationActivityRefresh += 1
  setPendingMutationOutboxActive(false)
  clearLivePendingMutationProjectionGenerations()
  clearRetainedChatProjections()
}

/** Abort/fault injection for atomicity tests; invoked synchronously after final writes are queued. */
export function setPendingMutationCommitTransactionHookForTests(
  hook: ((transaction: IDBTransaction) => void) | null,
): void {
  pendingMutationCommitTransactionHookForTests = hook
}

async function refreshPendingMutationActivity(): Promise<void> {
  const generation = captureClientSessionGeneration()
  const refresh = ++pendingMutationActivityRefresh
  const count = await countPendingMutationRecords()
  if (isClientSessionGenerationCurrent(generation) && refresh === pendingMutationActivityRefresh && count !== null) {
    setPendingMutationOutboxActive(count > 0)
  }
}

function persistPendingMutation(
  semanticKey: string,
  mutationId: string,
  sequence: number,
  scope: PendingMutationScope,
  intent: DurableMutationIntent,
  replacement: PendingMutationHandle | null,
): Promise<PendingMutationPersistenceStatus> {
  // This call synchronously queues the origin-wide lock request. In
  // particular, do not load IndexedDB or encryption state before requesting it.
  return withPendingMutationStageLock(scope, () =>
    persistPendingMutationLocked(semanticKey, mutationId, sequence, scope, intent, replacement),
  ).catch((error) => {
    reportPersistenceWarning('Unable to persist a pending server mutation', error)
    return 'unavailable'
  })
}

async function persistPendingMutationLocked(
  semanticKey: string,
  mutationId: string,
  sequence: number,
  scope: PendingMutationScope,
  intent: DurableMutationIntent,
  replacement: PendingMutationHandle | null,
): Promise<PendingMutationPersistenceStatus> {
  if (!mayPersistCapturedPendingMutationScope(scope)) return 'superseded'
  const replacementPersistence = replacement ? await replacement.ready : null
  const persistedReplacement = replacementPersistence === 'persisted' ? replacement : null
  if (!mayPersistCapturedPendingMutationScope(scope)) return 'superseded'

  try {
    const payload = serializePendingMutationIntent(intent)
    if (payload.byteLength > MAX_DURABLE_MUTATION_PAYLOAD_BYTES) {
      throw new RangeError('Pending mutation payload is too large')
    }
    const [database, encryptionKey] = await Promise.all([openOutboxDatabase(), getOutboxEncryptionKey()])
    if (!database || !encryptionKey) return 'unavailable'

    while (true) {
      if (!mayPersistCapturedPendingMutationScope(scope)) return 'superseded'
      const lastCommittedOrder = await readPendingMutationOrderBase(database, scope)
      const candidateOrder = nextPendingMutationOrder(lastCommittedOrder)
      // Each attempt gets a new nonce. A CAS loss changes the authenticated
      // order, so retaining an earlier IV would be an AES-GCM nonce reuse.
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
      const ciphertext = await encryptIntentPayload(
        encryptionKey,
        iv,
        mutationAdditionalData(semanticKey, mutationId, sequence, candidateOrder, scope),
        payload,
      )
      if (!mayPersistCapturedPendingMutationScope(scope)) return 'superseded'

      const committed = await commitPendingMutationOrderAndRow({
        database,
        encryptionKey,
        semanticKey,
        mutationId,
        sequence,
        scope,
        candidateOrder,
        iv,
        ciphertext,
        replacement: persistedReplacement,
      })
      if (committed.status === 'order-raced') continue
      if (committed.status !== 'persisted') return 'superseded'
      if (committed.replacementDeleted && persistedReplacement) {
        retirePendingMutationProjectionGeneration(persistedReplacement)
      }
      return 'persisted'
    }
  } catch (error) {
    reportPersistenceWarning('Unable to persist a pending server mutation', error)
    return 'unavailable'
  }
}

interface CommitPendingMutationInput {
  database: IDBDatabase
  encryptionKey: OutboxEncryptionKey
  semanticKey: string
  mutationId: string
  sequence: number
  scope: PendingMutationScope
  candidateOrder: number
  iv: Uint8Array<ArrayBuffer>
  ciphertext: ArrayBuffer
  replacement: PendingMutationHandle | null
}

type CommitPendingMutationResult =
  | { status: 'persisted'; replacementDeleted: boolean }
  | { status: 'order-raced' | 'superseded' }

async function readPendingMutationOrderBase(database: IDBDatabase, scope: PendingMutationScope): Promise<number> {
  const transaction = database.transaction([OUTBOX_ORDER_STORE, OUTBOX_MUTATION_STORE], 'readonly')
  const [storedCounter, mutations] = await Promise.all([
    requestResult<unknown>(transaction.objectStore(OUTBOX_ORDER_STORE).get(pendingMutationOrderCounterKey(scope))),
    requestResult<StoredPendingMutation[]>(transaction.objectStore(OUTBOX_MUTATION_STORE).getAll()),
  ])
  await transactionDone(transaction)
  if (storedCounter !== undefined) return normalizePendingMutationOrderCounter(storedCounter, scope).lastCommittedOrder
  return maximumPendingMutationOrder(mutations, scope)
}

/**
 * Atomically compare the speculative order base, advance it, and publish the
 * complete encrypted row. Every request and write is queued from IndexedDB
 * callbacks; no WebCrypto or unrelated await can span this transaction.
 */
function commitPendingMutationOrderAndRow(input: CommitPendingMutationInput): Promise<CommitPendingMutationResult> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction
    try {
      transaction = input.database.transaction([OUTBOX_ORDER_STORE, OUTBOX_MUTATION_STORE], 'readwrite')
    } catch (error) {
      reject(error)
      return
    }

    const orderStore = transaction.objectStore(OUTBOX_ORDER_STORE)
    const mutationStore = transaction.objectStore(OUTBOX_MUTATION_STORE)
    const counterRequest = orderStore.get(pendingMutationOrderCounterKey(input.scope))
    const mutationsRequest = mutationStore.getAll()
    const currentRequest = mutationStore.get(input.mutationId)
    const replacementRequest = input.replacement ? mutationStore.get(input.replacement.mutationId) : null
    let requestsRemaining = replacementRequest ? 4 : 3
    let outcome: CommitPendingMutationResult | null = null
    let callbackError: unknown = null
    let settled = false

    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }
    transaction.oncomplete = () => {
      if (settled) return
      if (!outcome) {
        rejectOnce(new Error('Pending-mutation commit completed without a result'))
        return
      }
      settled = true
      resolve(outcome)
    }
    transaction.onerror = () => {
      callbackError ??= transaction.error ?? new Error('IndexedDB transaction failed')
    }
    transaction.onabort = () => {
      rejectOnce(callbackError ?? transaction.error ?? new Error('IndexedDB transaction aborted'))
    }

    const requestFailed = (request: IDBRequest) => {
      callbackError ??= request.error ?? new Error('IndexedDB request failed')
    }
    const requestSucceeded = () => {
      requestsRemaining -= 1
      if (requestsRemaining !== 0) return
      try {
        const storedCounter = counterRequest.result
        const currentBase =
          storedCounter === undefined
            ? maximumPendingMutationOrder(mutationsRequest.result as StoredPendingMutation[], input.scope)
            : normalizePendingMutationOrderCounter(storedCounter, input.scope).lastCommittedOrder
        if (nextPendingMutationOrder(currentBase) !== input.candidateOrder) {
          outcome = { status: 'order-raced' }
          return
        }
        if (currentRequest.result !== undefined || !mayPersistCapturedPendingMutationScope(input.scope)) {
          outcome = { status: 'superseded' }
          return
        }

        const replaced = replacementRequest?.result as StoredPendingMutation | undefined
        const replacementDeleted = !!(
          input.replacement &&
          storedMutationMatchesHandle(replaced, input.replacement) &&
          replaced?.dispatchStarted !== true
        )
        orderStore.put(
          {
            version: 1,
            writerSessionId: input.scope.writerSessionId,
            databaseLineage: input.scope.databaseLineage,
            lastCommittedOrder: input.candidateOrder,
          } satisfies StoredPendingMutationOrderCounter,
          pendingMutationOrderCounterKey(input.scope),
        )
        mutationStore.put({
          mutationId: input.mutationId,
          semanticKey: input.semanticKey,
          sequence: input.sequence,
          order: input.candidateOrder,
          dispatchStarted: false,
          ownerWriterSessionId: input.scope.writerSessionId,
          writerEpoch: input.scope.writerEpoch,
          databaseLineage: input.scope.databaseLineage,
          updatedAt: Date.now(),
          queuedAt: replacementDeleted && replaced ? (replaced.queuedAt ?? replaced.updatedAt) : Date.now(),
          keyKind: input.encryptionKey.keyKind,
          iv: input.iv.buffer,
          ciphertext: input.ciphertext,
        } satisfies StoredPendingMutation)
        if (replacementDeleted && input.replacement) mutationStore.delete(input.replacement.mutationId)
        outcome = { status: 'persisted', replacementDeleted }
        pendingMutationCommitTransactionHookForTests?.(transaction)
      } catch (error) {
        callbackError = error
        try {
          transaction.abort()
        } catch {
          rejectOnce(error)
        }
      }
    }

    for (const request of [counterRequest, mutationsRequest, currentRequest, replacementRequest]) {
      if (!request) continue
      request.onsuccess = requestSucceeded
      request.onerror = () => requestFailed(request)
    }
  })
}

function maximumPendingMutationOrder(mutations: readonly StoredPendingMutation[], scope: PendingMutationScope): number {
  let maximum = 0
  for (const mutation of mutations) {
    if (
      mutation.ownerWriterSessionId === scope.writerSessionId &&
      mutation.databaseLineage === scope.databaseLineage &&
      Number.isSafeInteger(mutation.order) &&
      mutation.order >= 0
    ) {
      maximum = Math.max(maximum, mutation.order)
    }
  }
  return maximum
}

function nextPendingMutationOrder(lastCommittedOrder: number): number {
  if (!Number.isSafeInteger(lastCommittedOrder) || lastCommittedOrder < 0) {
    throw new TypeError('Pending-mutation order counter is invalid')
  }
  if (lastCommittedOrder >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Pending-mutation order counter is exhausted')
  }
  return lastCommittedOrder + 1
}

function pendingMutationOrderCounterKey(scope: PendingMutationScope): string {
  return JSON.stringify(['pending-mutation-order-counter', 1, scope.writerSessionId, scope.databaseLineage])
}

function normalizePendingMutationOrderCounter(
  value: unknown,
  scope: PendingMutationScope,
): StoredPendingMutationOrderCounter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Pending-mutation order counter is invalid')
  }
  const counter = value as Partial<StoredPendingMutationOrderCounter>
  if (
    counter.version !== 1 ||
    typeof counter.writerSessionId !== 'string' ||
    !SCOPE_VALUE_PATTERN.test(counter.writerSessionId) ||
    counter.writerSessionId !== scope.writerSessionId ||
    typeof counter.databaseLineage !== 'string' ||
    !SCOPE_VALUE_PATTERN.test(counter.databaseLineage) ||
    counter.databaseLineage !== scope.databaseLineage ||
    !Number.isSafeInteger(counter.lastCommittedOrder) ||
    counter.lastCommittedOrder! < 0
  ) {
    throw new TypeError('Pending-mutation order counter is invalid')
  }
  return counter as StoredPendingMutationOrderCounter
}

async function withPendingMutationStageLock<T>(scope: PendingMutationScope, task: () => Promise<T>): Promise<T> {
  const name = `risu:pending-mutation-stage:${JSON.stringify([scope.writerSessionId, scope.databaseLineage])}`
  const lockManager = globalThis.navigator?.locks
  if (lockManager) return lockManager.request(name, { mode: 'exclusive' }, task)
  // This FIFO protects initiation order only within this module/page. Separate
  // tabs without Web Locks are linearized by the IndexedDB CAS commit instead.
  return withLocalPendingMutationStageLock(name, task)
}

async function withLocalPendingMutationStageLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const previous = pendingMutationStageLockTails.get(name) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  const queuedTail = previous.then(() => tail)
  pendingMutationStageLockTails.set(name, queuedTail)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (pendingMutationStageLockTails.get(name) === queuedTail) pendingMutationStageLockTails.delete(name)
  }
}

type ExactPendingMutationIntentReplacementResult =
  | { status: 'replaced'; handle: PendingMutationHandle }
  | { status: 'started' | 'superseded' | 'unavailable' }

async function replacePendingMutationIntentExact(
  handle: PendingMutationHandle,
  intent: DurableMutationIntent,
  generation: number,
): Promise<ExactPendingMutationIntentReplacementResult> {
  const persistence = await handle.ready
  if (!isClientWriteOperationCurrent(generation)) return { status: 'superseded' }
  if (persistence !== 'persisted') return { status: persistence }
  const [database, encryptionKey] = await Promise.all([openOutboxDatabase(), getOutboxEncryptionKey()])
  if (!isClientWriteOperationCurrent(generation)) return { status: 'superseded' }
  if (!database || !encryptionKey) return { status: 'unavailable' }
  let stopWatch: (() => void) | undefined

  try {
    const readTransaction = database.transaction(OUTBOX_MUTATION_STORE, 'readonly')
    const candidate = await requestResult<StoredPendingMutation | undefined>(
      readTransaction.objectStore(OUTBOX_MUTATION_STORE).get(handle.mutationId),
    )
    await transactionDone(readTransaction)
    if (!isClientWriteOperationCurrent(generation)) return { status: 'superseded' }
    if (!candidate || !storedMutationMatchesHandle(candidate, handle)) return { status: 'superseded' }
    if (candidate.dispatchStarted === true) return { status: 'started' }

    const sequence = nextMutationSequence()
    const payload = serializePendingMutationIntent(intent)
    if (payload.byteLength > MAX_DURABLE_MUTATION_PAYLOAD_BYTES) {
      throw new RangeError('Pending mutation payload is too large')
    }
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
    const scope: PendingMutationScope = {
      writerSessionId: candidate.ownerWriterSessionId,
      writerEpoch: candidate.writerEpoch,
      databaseLineage: candidate.databaseLineage,
    }
    const ciphertext = await encryptIntentPayload(
      encryptionKey,
      iv,
      mutationAdditionalData(candidate.semanticKey, candidate.mutationId, sequence, candidate.order, scope),
      payload,
    )

    if (!isClientWriteOperationCurrent(generation)) return { status: 'superseded' }
    const transaction = database.transaction(OUTBOX_MUTATION_STORE, 'readwrite')
    const done = transactionDone(transaction)
    void done.catch(() => undefined)
    stopWatch = watchOutboxTransaction(transaction, generation, true)
    const store = transaction.objectStore(OUTBOX_MUTATION_STORE)
    const current = await requestResult<StoredPendingMutation | undefined>(store.get(handle.mutationId))
    if (!isClientWriteOperationCurrent(generation)) {
      transaction.abort()
      return { status: 'superseded' }
    }
    if (!current || !storedMutationMatchesHandle(current, handle)) {
      await done
      return { status: 'superseded' }
    }
    if (current.dispatchStarted === true) {
      await done
      return { status: 'started' }
    }
    store.put({
      ...current,
      sequence,
      dispatchStarted: false,
      updatedAt: Date.now(),
      queuedAt: current.queuedAt ?? current.updatedAt,
      keyKind: encryptionKey.keyKind,
      iv: iv.buffer,
      ciphertext,
    } satisfies StoredPendingMutation)
    await done
    return {
      status: 'replaced',
      handle: stampPendingHandle(
        {
          key: current.semanticKey,
          mutationId: current.mutationId,
          sequence,
          ownerWriterSessionId: current.ownerWriterSessionId,
          writerEpoch: current.writerEpoch,
          databaseLineage: current.databaseLineage,
          phase: 'staged',
          ready: Promise.resolve('persisted'),
        },
        generation,
      ),
    }
  } catch (error) {
    if (!isClientWriteOperationCurrent(generation)) return { status: 'superseded' }
    reportPersistenceWarning('Unable to replace a staged pending server mutation', error)
    return { status: 'unavailable' }
  } finally {
    stopWatch?.()
  }
}

async function decryptIntent(record: StoredPendingMutation): Promise<DurableMutationIntent> {
  const keyKind = record.keyKind ?? 'subtle'
  const encryptionKey = await getOutboxEncryptionKey(keyKind)
  // The envelope chooses its own key scheme. If that scheme is unavailable,
  // callers report the row as unreadable and retain it for a compatible visit.
  if (!encryptionKey) throw new Error(`Pending mutation ${keyKind} encryption is unavailable`)
  const iv = new Uint8Array(record.iv)
  const additionalData = mutationAdditionalData(record.semanticKey, record.mutationId, record.sequence, record.order, {
    writerSessionId: record.ownerWriterSessionId,
    writerEpoch: record.writerEpoch,
    databaseLineage: record.databaseLineage,
  })
  const plaintext =
    encryptionKey.keyKind === 'subtle'
      ? await decryptSubtleIntent(encryptionKey.key, iv, additionalData, record.ciphertext)
      : gcm(encryptionKey.key, iv, additionalData).decrypt(new Uint8Array(record.ciphertext))
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<EncryptedPendingMutationPayload>
  return normalizeIntent(parsed.intent)
}

function normalizeIntent(value: unknown): DurableMutationIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Pending mutation intent must be an object')
  }
  const record = value as Partial<DurableMutationIntent>
  const { version, requests: inputRequests, kind, dependencyKeys: inputDependencyKeys } = record
  if (version !== 1 || !Array.isArray(inputRequests)) {
    throw new TypeError('Unsupported pending mutation intent')
  }
  if (
    kind !== undefined &&
    kind !== 'generation-operation-submit' &&
    kind !== 'generation-operation-cancel' &&
    kind !== 'generation-operation-retry'
  ) {
    throw new TypeError('Unsupported pending mutation intent kind')
  }
  const requestCount = inputRequests.length
  if (!Number.isInteger(requestCount) || requestCount <= 0 || requestCount > MAX_DURABLE_MUTATION_REQUESTS) {
    throw new RangeError('Pending mutation request count is invalid')
  }
  if (kind && requestCount !== 1) {
    throw new RangeError('Generation operation pending intents require exactly one request')
  }
  // Capture the bounded request list before any body JSON conversion can run.
  const requestInputs = Array.from({ length: requestCount }, (_, index) => inputRequests[index])
  let dependencyKeys: string[] = []
  if (inputDependencyKeys !== undefined) {
    if (!Array.isArray(inputDependencyKeys)) {
      throw new TypeError('Pending mutation dependency keys must be an array')
    }
    dependencyKeys = normalizeDependencyKeys(inputDependencyKeys)
  }
  return {
    version: 1,
    ...(kind ? { kind } : {}),
    requests: requestInputs.map((request) => normalizeRequest(request, kind)),
    ...(dependencyKeys.length === 0 ? {} : { dependencyKeys }),
  }
}

export function isGenerationOperationPendingIntent(intent: DurableMutationIntent): intent is DurableMutationIntent & {
  kind: 'generation-operation-submit' | 'generation-operation-cancel' | 'generation-operation-retry'
} {
  return (
    intent.kind === 'generation-operation-submit' ||
    intent.kind === 'generation-operation-cancel' ||
    intent.kind === 'generation-operation-retry'
  )
}

function generationOperationIdFromPendingIntent(intent: DurableMutationIntent): string | undefined {
  const request = intent.requests[0]
  if (intent.kind === 'generation-operation-submit') {
    return typeof request?.body.operationId === 'string' ? request.body.operationId : undefined
  }
  if (intent.kind === 'generation-operation-cancel' || intent.kind === 'generation-operation-retry') {
    const suffix = intent.kind === 'generation-operation-cancel' ? 'cancellation' : 'retries'
    const match = new RegExp(`^/generation-operations/([^/?#]+)/${suffix}$`).exec(request?.path ?? '')
    if (!match) return undefined
    try {
      return decodeURIComponent(match[1]!)
    } catch {
      return match[1]
    }
  }
  return undefined
}

function serializePendingMutationIntent(intent: DurableMutationIntent): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify({ intent } satisfies EncryptedPendingMutationPayload))
}

function normalizeRequest(value: unknown, kind?: DurableMutationIntent['kind']): DurableMutationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Pending mutation request must be an object')
  }
  const request = value as Partial<DurableMutationRequest>
  const { method: inputMethod, path, body: inputBody } = request
  if (!['DELETE', 'PATCH', 'POST', 'PUT'].includes(inputMethod ?? '')) {
    throw new TypeError('Pending mutation request method is invalid')
  }
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('..') ||
    path.length > 2_048
  ) {
    throw new TypeError('Pending mutation command path is invalid')
  }
  const method = inputMethod as DurableMutationRequestMethod
  const generationOperationPathAllowed =
    kind !== undefined && protocolDurableGenerationOperationMatches(kind, method, path)
  const commandPathAllowed = kind === undefined && findProtocolDurableCommandOperation(method, path) !== undefined
  if (!generationOperationPathAllowed && !commandPathAllowed) {
    throw new TypeError('Pending mutation command path is not allowlisted')
  }
  if (!inputBody || typeof inputBody !== 'object' || Array.isArray(inputBody)) {
    throw new TypeError('Pending mutation request body must be an object')
  }
  if (kind === undefined && Object.prototype.hasOwnProperty.call(inputBody, 'baseRevision')) {
    throw new TypeError('Pending mutation intent must not persist a base revision')
  }
  const body = isImmutableJsonSnapshot(inputBody) ? inputBody : cloneJsonValue(inputBody)
  // JSON conversion can change shape or introduce fields (for example toJSON).
  // Validate the owned snapshot before any persistence or target registration.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('Pending mutation request body must be an object')
  }
  if (kind === undefined && Object.prototype.hasOwnProperty.call(body, 'baseRevision')) {
    throw new TypeError('Pending mutation intent must not persist a base revision')
  }
  return { method, path, body }
}

function isImmutableJsonSnapshot(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (!value || typeof value !== 'object' || !Object.isFrozen(value) || ancestors.has(value)) return false

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value)
      const ownKeys = Reflect.ownKeys(value)
      if (keys.length !== value.length || ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) {
        return false
      }
      for (let index = 0; index < value.length; index += 1) {
        if (keys[index] !== String(index)) return false
      }
      return value.every((entry) => isImmutableJsonSnapshot(entry, ancestors))
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) return false
      if (!isImmutableJsonSnapshot(descriptor.value, ancestors)) return false
    }
    return true
  } finally {
    ancestors.delete(value)
  }
}

function pendingMutationRequestProjectionTargets(request: DurableMutationRequest): string[] {
  if (request.method === 'PATCH' && request.path.startsWith('/settings/')) {
    const patch = request.body.patch
    if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
      const fields = Object.keys(patch as Record<string, unknown>)
      if (fields.length > 0) return fields.map(pendingMutationSettingsFieldProjectionTarget)
    }
  }

  if (request.method === 'POST' && request.path === '/modules/enable') {
    return typeof request.body.moduleId === 'string'
      ? [pendingMutationModuleEnabledProjectionTarget(request.body.moduleId)]
      : []
  }

  if (request.method === 'POST' && request.path === '/characters/reorder') {
    return [pendingMutationCharacterOrderProjectionTarget()]
  }

  if (request.method === 'POST' && request.path === '/plugins') {
    const plugin = request.body.plugin
    const pluginId =
      plugin && typeof plugin === 'object' && !Array.isArray(plugin)
        ? (plugin as Record<string, unknown>).name
        : undefined
    return typeof pluginId === 'string' ? [pendingMutationPluginRowProjectionTarget(pluginId)] : []
  }

  if (request.method === 'POST' && request.path === '/plugins/provider') {
    return [pendingMutationPluginProviderProjectionTarget()]
  }
  if (request.method === 'POST' && request.path === '/plugins/reorder') {
    return [pendingMutationPluginOrderProjectionTarget()]
  }

  const pluginEnable = request.method === 'POST' ? /^\/plugins\/([^/]+)\/enable$/.exec(request.path) : null
  if (pluginEnable) {
    return [pendingMutationPluginRowProjectionTarget(decodeProjectionTargetPart(pluginEnable[1]!))]
  }

  const pluginRow =
    request.method === 'PATCH' || request.method === 'DELETE' ? /^\/plugins\/([^/]+)$/.exec(request.path) : null
  if (pluginRow) {
    const targets = [pendingMutationPluginRowProjectionTarget(decodeProjectionTargetPart(pluginRow[1]!))]
    if (request.method === 'DELETE') targets.push(pendingMutationPluginProviderProjectionTarget())
    return targets
  }

  const pluginStorageKey =
    request.method === 'PUT' || request.method === 'DELETE' ? /^\/plugin-storage\/([^/]+)$/.exec(request.path) : null
  if (pluginStorageKey) {
    return [pendingMutationPluginStorageProjectionTarget(decodeProjectionTargetPart(pluginStorageKey[1]!))]
  }

  if (request.method === 'POST' && request.path === '/plugin-storage/bulk') {
    const keys = new Set<string>()
    const values = request.body.values
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      for (const key of Object.keys(values as Record<string, unknown>)) keys.add(key)
    }
    const deleteKeys = request.body.deleteKeys
    if (Array.isArray(deleteKeys)) {
      for (const key of deleteKeys) if (typeof key === 'string') keys.add(key)
    }
    return keys.size > 0 ? [...keys].map(pendingMutationPluginStorageProjectionTarget) : ['plugin-storage:collection']
  }

  if (request.method === 'POST' && request.path === '/agent-presets') {
    return [pendingMutationAgentPresetCollectionProjectionTarget()]
  }
  if (request.method === 'POST' && (request.path === '/agents' || request.path === '/agents/reorder')) {
    return [pendingMutationAgentCollectionProjectionTarget()]
  }
  const agentDuplicate = request.method === 'POST' ? /^\/agents\/([^/]+)\/duplicate$/.exec(request.path) : null
  if (agentDuplicate) return [pendingMutationAgentCollectionProjectionTarget()]
  const agentRow =
    request.method === 'PATCH' || request.method === 'DELETE' ? /^\/agents\/([^/]+)$/.exec(request.path) : null
  if (agentRow) {
    const targets = [pendingMutationAgentRowProjectionTarget(decodeProjectionTargetPart(agentRow[1]!))]
    if (request.method === 'DELETE') targets.push(pendingMutationAgentCollectionProjectionTarget())
    return targets
  }
  if (request.method === 'POST' && request.path === '/agent-presets/reorder') {
    return [pendingMutationAgentPresetOrderProjectionTarget()]
  }
  if (request.method === 'POST' && request.path === '/agent-presets/default') {
    return [pendingMutationAgentPresetDefaultProjectionTarget()]
  }

  const agentPresetUseReorder =
    request.method === 'POST' ? /^\/agent-presets\/([^/]+)\/uses\/reorder$/.exec(request.path) : null
  if (agentPresetUseReorder) {
    return [pendingMutationAgentPresetStepsProjectionTarget(decodeProjectionTargetPart(agentPresetUseReorder[1]!))]
  }

  const agentPresetUseCollection =
    request.method === 'POST' ? /^\/agent-presets\/([^/]+)\/uses$/.exec(request.path) : null
  if (agentPresetUseCollection) {
    return [pendingMutationAgentPresetStepsProjectionTarget(decodeProjectionTargetPart(agentPresetUseCollection[1]!))]
  }

  const agentPresetUseRow =
    request.method === 'PATCH' || request.method === 'DELETE'
      ? /^\/agent-presets\/([^/]+)\/uses\/([^/]+)$/.exec(request.path)
      : null
  if (agentPresetUseRow) {
    const presetId = decodeProjectionTargetPart(agentPresetUseRow[1]!)
    const targets = [
      pendingMutationAgentPresetStepProjectionTarget(presetId, decodeProjectionTargetPart(agentPresetUseRow[2]!)),
    ]
    if (request.method === 'DELETE') targets.push(pendingMutationAgentPresetStepsProjectionTarget(presetId))
    return targets
  }

  const agentPresetStepDuplicate =
    request.method === 'POST' ? /^\/agent-presets\/([^/]+)\/steps\/([^/]+)\/duplicate$/.exec(request.path) : null
  if (agentPresetStepDuplicate) {
    return [pendingMutationAgentPresetStepsProjectionTarget(decodeProjectionTargetPart(agentPresetStepDuplicate[1]!))]
  }

  const agentPresetStepReorder =
    request.method === 'POST' ? /^\/agent-presets\/([^/]+)\/steps\/reorder$/.exec(request.path) : null
  if (agentPresetStepReorder) {
    return [pendingMutationAgentPresetStepsProjectionTarget(decodeProjectionTargetPart(agentPresetStepReorder[1]!))]
  }

  const agentPresetStepCollection =
    request.method === 'POST' ? /^\/agent-presets\/([^/]+)\/steps$/.exec(request.path) : null
  if (agentPresetStepCollection) {
    return [pendingMutationAgentPresetStepsProjectionTarget(decodeProjectionTargetPart(agentPresetStepCollection[1]!))]
  }

  const agentPresetStepRow =
    request.method === 'PATCH' || request.method === 'DELETE'
      ? /^\/agent-presets\/([^/]+)\/steps\/([^/]+)$/.exec(request.path)
      : null
  if (agentPresetStepRow) {
    const presetId = decodeProjectionTargetPart(agentPresetStepRow[1]!)
    const targets = [
      pendingMutationAgentPresetStepProjectionTarget(presetId, decodeProjectionTargetPart(agentPresetStepRow[2]!)),
    ]
    if (request.method === 'DELETE') targets.push(pendingMutationAgentPresetStepsProjectionTarget(presetId))
    return targets
  }

  const agentPresetDuplicate =
    request.method === 'POST' ? /^\/agent-presets\/([^/]+)\/duplicate$/.exec(request.path) : null
  if (agentPresetDuplicate) return [pendingMutationAgentPresetCollectionProjectionTarget()]

  const agentPresetRow =
    request.method === 'PATCH' || request.method === 'DELETE' ? /^\/agent-presets\/([^/]+)$/.exec(request.path) : null
  if (agentPresetRow) {
    const targets = [pendingMutationAgentPresetRowProjectionTarget(decodeProjectionTargetPart(agentPresetRow[1]!))]
    if (request.method === 'DELETE') {
      targets.push(
        pendingMutationAgentPresetOrderProjectionTarget(),
        pendingMutationAgentPresetDefaultProjectionTarget(),
      )
    }
    return targets
  }

  const deletedModule = request.method === 'DELETE' ? /^\/modules\/([^/]+)$/.exec(request.path) : null
  if (deletedModule) {
    return [pendingMutationModuleEnabledProjectionTarget(decodeProjectionTargetPart(deletedModule[1]!))]
  }

  const chatGenerationSettings = /^\/chats\/([^/]+)\/generation-settings$/.exec(request.path)
  if (request.method === 'PUT' && chatGenerationSettings) {
    return [
      pendingMutationChatGenerationSettingsProjectionTarget(decodeProjectionTargetPart(chatGenerationSettings[1]!)),
    ]
  }

  const characterLorebooksCollection =
    request.method === 'PUT' ? /^\/characters\/([^/]+)\/lorebooks$/.exec(request.path) : null
  const characterLorebookEntry =
    request.method === 'PUT' || request.method === 'DELETE'
      ? /^\/characters\/([^/]+)\/lorebooks\/entries\/[^/]+$/.exec(request.path)
      : null
  const characterLorebookReorder =
    request.method === 'POST' ? /^\/characters\/([^/]+)\/lorebooks\/entries\/reorder$/.exec(request.path) : null
  const characterLorebooks = characterLorebooksCollection ?? characterLorebookEntry ?? characterLorebookReorder
  if (characterLorebooks) {
    return [pendingMutationCharacterLorebooksProjectionTarget(decodeProjectionTargetPart(characterLorebooks[1]!))]
  }

  const characterDefinitions =
    request.method === 'PUT' || request.method === 'PATCH'
      ? /^\/characters\/([^/]+)\/(scripts|triggers)$/.exec(request.path)
      : null
  if (characterDefinitions) {
    const characterId = decodeProjectionTargetPart(characterDefinitions[1]!)
    return [
      characterDefinitions[2] === 'scripts'
        ? pendingMutationCharacterScriptsProjectionTarget(characterId)
        : pendingMutationCharacterTriggersProjectionTarget(characterId),
    ]
  }

  const loadoutTouch = request.method === 'POST' ? /^\/loadouts\/([^/]+)\/touch$/.exec(request.path) : null
  if (loadoutTouch) {
    return [
      pendingMutationLoadoutRowProjectionTarget(decodeProjectionTargetPart(loadoutTouch[1]!)),
      pendingMutationSettingsFieldProjectionTarget('lastLoadedLoadoutName'),
    ]
  }

  if (request.method === 'POST' && request.path === '/loadouts') {
    const loadout = request.body.loadout
    if (loadout && typeof loadout === 'object' && !Array.isArray(loadout)) {
      const loadoutId = (loadout as Record<string, unknown>).id
      if (typeof loadoutId === 'string') return [pendingMutationLoadoutRowProjectionTarget(loadoutId)]
    }
  }

  const loadoutRow = /^\/loadouts\/([^/]+)(?:\/favorite)?$/.exec(request.path)
  if ((request.method === 'DELETE' || request.method === 'POST') && loadoutRow) {
    return [pendingMutationLoadoutRowProjectionTarget(decodeProjectionTargetPart(loadoutRow[1]!))]
  }

  const personaPatch = request.method === 'PATCH' ? /^\/personas\/([^/]+)$/.exec(request.path) : null
  if (personaPatch) {
    return [pendingMutationPersonaRowProjectionTarget(decodeProjectionTargetPart(personaPatch[1]!))]
  }

  const presetRow = /^\/(presets|model-presets|prompt-presets)\/([^/]+)$/.exec(request.path)
  if ((request.method === 'PATCH' || request.method === 'DELETE') && presetRow) {
    const kind = presetRow[1] === 'presets' ? 'legacy' : presetRow[1] === 'model-presets' ? 'model' : 'prompt'
    return [pendingMutationPresetRowProjectionTarget(kind, decodeProjectionTargetPart(presetRow[2]!))]
  }

  const selectionTarget =
    request.path === '/personas/select'
      ? pendingMutationSelectionProjectionTarget('persona')
      : request.path === '/presets/select'
        ? pendingMutationSelectionProjectionTarget('legacyPreset')
        : request.path === '/model-presets/select'
          ? pendingMutationSelectionProjectionTarget('modelPreset')
          : request.path === '/prompt-presets/select'
            ? pendingMutationSelectionProjectionTarget('promptPreset')
            : null
  if (selectionTarget) return [selectionTarget]

  return [`request:${request.method}:${request.path}`]
}

function encodeProjectionTargetPart(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError('Pending mutation projection target part is invalid')
  return encodeURIComponent(normalized)
}

function decodeProjectionTargetPart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function normalizeProjectionTarget(target: string): string {
  const normalized = target.trim()
  if (!normalized || normalized.length > MAX_PENDING_MUTATION_KEY_LENGTH) {
    throw new TypeError('Pending mutation projection target is invalid')
  }
  return normalized
}

function pendingMutationScopeFromHandle(handle: PendingMutationHandle): PendingMutationScope | null {
  if (!handle.ownerWriterSessionId || handle.writerEpoch === null || !handle.databaseLineage) return null
  return {
    writerSessionId: handle.ownerWriterSessionId,
    writerEpoch: handle.writerEpoch,
    databaseLineage: handle.databaseLineage,
  }
}

function projectionGenerationId(scope: PendingMutationScope, mutationId: string): string {
  return JSON.stringify([scope.writerSessionId, scope.writerEpoch, scope.databaseLineage, mutationId])
}

function projectionTargetKey(scope: PendingMutationScope, target: string): string {
  return JSON.stringify([
    scope.writerSessionId,
    scope.writerEpoch,
    scope.databaseLineage,
    normalizeProjectionTarget(target),
  ])
}

function recordLiveProjectionGeneration(
  generationId: string,
  scope: PendingMutationScope,
  targets: readonly string[],
): void {
  let generation = liveProjectionGenerations.get(generationId)
  if (!generation) {
    generation = {
      id: generationId,
      ordinal: ++nextProjectionGenerationOrdinal,
      scope,
      targetKeys: new Set<string>(),
    }
    liveProjectionGenerations.set(generationId, generation)
  }

  for (const target of new Set(targets.map(normalizeProjectionTarget))) {
    const targetKey = projectionTargetKey(scope, target)
    if (generation.targetKeys.has(targetKey)) continue
    generation.targetKeys.add(targetKey)
    const stack = liveProjectionGenerationStacks.get(targetKey) ?? []
    stack.push(generationId)
    stack.sort(
      (left, right) =>
        (liveProjectionGenerations.get(left)?.ordinal ?? -1) - (liveProjectionGenerations.get(right)?.ordinal ?? -1),
    )
    liveProjectionGenerationStacks.set(targetKey, stack)
  }
}

function retirePendingMutationProjectionGeneration(handle: PendingMutationHandle): void {
  const scope = pendingMutationScopeFromHandle(handle)
  if (!scope) return
  retireLiveProjectionGeneration(projectionGenerationId(scope, handle.mutationId))
}

function compactAcceptedPendingMutationProjectionGeneration(handle: PendingMutationHandle): void {
  const scope = pendingMutationScopeFromHandle(handle)
  if (!scope) return
  compactAcceptedLiveProjectionGeneration(projectionGenerationId(scope, handle.mutationId))
}

/**
 * Keep an accepted writer as the baseline for every field it owns while
 * removing older writers for those fields. A newer optimistic writer stays on
 * top and can still retire back to this accepted generation.
 */
function compactAcceptedLiveProjectionGeneration(generationId: string): void {
  const generation = liveProjectionGenerations.get(generationId)
  if (!generation) return

  for (const targetKey of generation.targetKeys) {
    const stack = liveProjectionGenerationStacks.get(targetKey)
    const acceptedIndex = stack?.indexOf(generationId) ?? -1
    if (!stack || acceptedIndex < 0) continue

    for (const obsoleteGenerationId of stack.slice(0, acceptedIndex)) {
      const obsolete = liveProjectionGenerations.get(obsoleteGenerationId)
      if (!obsolete) continue
      obsolete.targetKeys.delete(targetKey)
      if (obsolete.targetKeys.size === 0) liveProjectionGenerations.delete(obsoleteGenerationId)
    }
    liveProjectionGenerationStacks.set(targetKey, stack.slice(acceptedIndex))
  }
}

function retireLiveProjectionGeneration(generationId: string): void {
  const generation = liveProjectionGenerations.get(generationId)
  if (!generation) return
  for (const targetKey of generation.targetKeys) {
    const stack = liveProjectionGenerationStacks.get(targetKey)
    if (!stack) continue
    const retained = stack.filter((candidate) => candidate !== generationId)
    if (retained.length === 0) liveProjectionGenerationStacks.delete(targetKey)
    else liveProjectionGenerationStacks.set(targetKey, retained)
  }
  liveProjectionGenerations.delete(generationId)
}

function clearLivePendingMutationProjectionGenerations(): void {
  liveProjectionGenerations.clear()
  liveProjectionGenerationStacks.clear()
}

function normalizeOutboxKey(key: string): string {
  const normalized = key.trim()
  if (normalized.length === 0 || normalized.length > MAX_PENDING_MUTATION_KEY_LENGTH) {
    throw new TypeError('Pending mutation key is invalid')
  }
  return normalized
}

function normalizeDependencyKeys(value: readonly unknown[], enforceCount = true): string[] {
  const count = value.length
  if (!Number.isInteger(count) || count < 0 || (enforceCount && count > MAX_DURABLE_MUTATION_DEPENDENCY_KEYS)) {
    throw new RangeError('Pending mutation dependency key count is invalid')
  }
  return Array.from(
    new Set(
      Array.from({ length: count }, (_, index) => {
        const dependencyKey = value[index]
        if (typeof dependencyKey !== 'string') {
          throw new TypeError('Pending mutation dependency key is invalid')
        }
        return normalizeOutboxKey(dependencyKey)
      }),
    ),
  )
}

function normalizeScope(writerSessionId: string, writerEpoch: number, databaseLineage: string): PendingMutationScope {
  const writer = writerSessionId.trim()
  const lineage = databaseLineage.trim()
  if (
    !SCOPE_VALUE_PATTERN.test(writer) ||
    !Number.isSafeInteger(writerEpoch) ||
    writerEpoch < 0 ||
    !SCOPE_VALUE_PATTERN.test(lineage)
  ) {
    throw new TypeError('Pending mutation ownership scope is invalid')
  }
  return { writerSessionId: writer, writerEpoch, databaseLineage: lineage }
}

function pendingMutationScopeMatchesHandle(scope: PendingMutationScope, handle: PendingMutationHandle): boolean {
  return (
    handle.ownerWriterSessionId === scope.writerSessionId &&
    handle.writerEpoch === scope.writerEpoch &&
    handle.databaseLineage === scope.databaseLineage
  )
}

function mayPersistCapturedPendingMutationScope(scope: PendingMutationScope): boolean {
  return isClientSessionManaged()
    ? pendingMutationScope?.databaseLineage === scope.databaseLineage
    : pendingMutationScopeEquals(scope)
}

function pendingMutationScopeEquals(scope: PendingMutationScope): boolean {
  return (
    pendingMutationScope?.writerSessionId === scope.writerSessionId &&
    pendingMutationScope.writerEpoch === scope.writerEpoch &&
    pendingMutationScope.databaseLineage === scope.databaseLineage
  )
}

function nextMutationSequence(): number {
  const base = Date.now() * 1_000
  nextSequenceOffset = (nextSequenceOffset + 1) % 1_000
  return base + nextSequenceOffset
}

function createMutationId(): string {
  const cryptoApi = globalThis.crypto
  const id = cryptoApi?.randomUUID?.()
  if (id && MUTATION_ID_PATTERN.test(id)) return id
  if (!cryptoApi?.getRandomValues) throw new Error('WebCrypto is unavailable')
  const bytes = cryptoApi.getRandomValues(new Uint8Array(18))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function mutationAdditionalData(
  semanticKey: string,
  mutationId: string,
  sequence: number,
  order: number,
  scope: PendingMutationScope,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `${scope.writerSessionId}\u0000${scope.writerEpoch}\u0000${scope.databaseLineage}\u0000${semanticKey}\u0000${mutationId}\u0000${sequence}\u0000${order}`,
  )
}

function storedMutationMatchesHandle(
  current: StoredPendingMutation | undefined,
  handle: PendingMutationHandle,
): boolean {
  return (
    current?.mutationId === handle.mutationId &&
    current.sequence === handle.sequence &&
    current.semanticKey === handle.key &&
    current.ownerWriterSessionId === handle.ownerWriterSessionId &&
    current.writerEpoch === handle.writerEpoch &&
    current.databaseLineage === handle.databaseLineage
  )
}

function preferredOutboxKeyKind(): OutboxKeyKind | null {
  if (globalThis.crypto?.subtle) return 'subtle'
  return globalThis.crypto?.getRandomValues ? 'raw' : null
}

async function getOutboxEncryptionKey(
  keyKind: OutboxKeyKind | null = preferredOutboxKeyKind(),
): Promise<OutboxEncryptionKey | null> {
  if (!keyKind || (keyKind === 'subtle' && !globalThis.crypto?.subtle)) return null
  if (keyKind === 'raw') {
    if (!outboxRawEncryptionKeyPromise) {
      outboxRawEncryptionKeyPromise = loadOrCreateOutboxEncryptionKey('raw')
    }
    return outboxRawEncryptionKeyPromise
  }
  if (!outboxSubtleEncryptionKeyPromise) {
    outboxSubtleEncryptionKeyPromise = loadOrCreateOutboxEncryptionKey('subtle')
  }
  return outboxSubtleEncryptionKeyPromise
}

async function loadOrCreateOutboxEncryptionKey(keyKind: OutboxKeyKind): Promise<OutboxEncryptionKey | null> {
  const database = await openOutboxDatabase()
  if (!database) return null
  const keyId = keyKind === 'subtle' ? OUTBOX_ENCRYPTION_KEY_ID : OUTBOX_RAW_ENCRYPTION_KEY_ID

  try {
    const readTransaction = database.transaction(OUTBOX_KEY_STORE, 'readonly')
    const existing = await requestResult<unknown>(readTransaction.objectStore(OUTBOX_KEY_STORE).get(keyId))
    await transactionDone(readTransaction)
    const existingKey = normalizeStoredOutboxEncryptionKey(keyKind, existing)
    if (existingKey) return existingKey

    const cryptoApi = globalThis.crypto
    const generated =
      keyKind === 'subtle'
        ? await cryptoApi?.subtle?.generateKey({ name: 'AES-GCM', length: 256 }, false, ['decrypt', 'encrypt'])
        : cryptoApi?.getRandomValues(new Uint8Array(32))
    const generatedKey = normalizeStoredOutboxEncryptionKey(keyKind, generated)
    if (!generatedKey) return null
    try {
      const createTransaction = database.transaction(OUTBOX_KEY_STORE, 'readwrite')
      createTransaction.objectStore(OUTBOX_KEY_STORE).add(generated, keyId)
      await transactionDone(createTransaction)
      return generatedKey
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'ConstraintError') throw error
      const retryTransaction = database.transaction(OUTBOX_KEY_STORE, 'readonly')
      const raced = await requestResult<unknown>(retryTransaction.objectStore(OUTBOX_KEY_STORE).get(keyId))
      await transactionDone(retryTransaction)
      return normalizeStoredOutboxEncryptionKey(keyKind, raced)
    }
  } catch (error) {
    reportPersistenceWarning('Unable to initialize pending-mutation encryption', error)
    return null
  }
}

function normalizeStoredOutboxEncryptionKey(keyKind: OutboxKeyKind, value: unknown): OutboxEncryptionKey | null {
  if (keyKind === 'subtle') {
    return value && typeof value === 'object' ? { keyKind, key: value as CryptoKey } : null
  }
  const key =
    value instanceof Uint8Array
      ? new Uint8Array(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value.slice(0))
        : null
  return key?.byteLength === 32 ? { keyKind, key } : null
}

async function encryptIntentPayload(
  encryptionKey: OutboxEncryptionKey,
  iv: Uint8Array<ArrayBuffer>,
  additionalData: Uint8Array<ArrayBuffer>,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  if (encryptionKey.keyKind === 'subtle') {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) throw new Error('Pending mutation subtle encryption is unavailable')
    return subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, encryptionKey.key, plaintext)
  }
  return uint8ArrayToArrayBuffer(gcm(encryptionKey.key, iv, additionalData).encrypt(plaintext))
}

async function decryptSubtleIntent(
  encryptionKey: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  additionalData: Uint8Array<ArrayBuffer>,
  ciphertext: ArrayBuffer,
): Promise<ArrayBuffer> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Pending mutation subtle encryption is unavailable')
  return subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, encryptionKey, ciphertext)
}

function uint8ArrayToArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

async function openOutboxDatabase(): Promise<IDBDatabase | null> {
  if (typeof globalThis.indexedDB === 'undefined') return null
  if (outboxDatabasePromise) return outboxDatabasePromise

  const opening = new Promise<IDBDatabase | null>((resolve) => {
    const request = globalThis.indexedDB.open(OUTBOX_DATABASE_NAME, OUTBOX_DATABASE_VERSION)
    request.onupgradeneeded = (event) => {
      const database = request.result
      // Versions 1/2 used one row per semantic key, which cannot preserve an
      // in-flight generation and its successor. They were never shipped.
      if (event.oldVersion < 3 && database.objectStoreNames.contains(OUTBOX_MUTATION_STORE)) {
        database.deleteObjectStore(OUTBOX_MUTATION_STORE)
      }
      if (!database.objectStoreNames.contains(OUTBOX_MUTATION_STORE)) {
        database.createObjectStore(OUTBOX_MUTATION_STORE, { keyPath: 'mutationId' })
      }
      if (!database.objectStoreNames.contains(OUTBOX_KEY_STORE)) {
        database.createObjectStore(OUTBOX_KEY_STORE)
      }
      if (!database.objectStoreNames.contains(OUTBOX_ORDER_STORE)) {
        database.createObjectStore(OUTBOX_ORDER_STORE, { autoIncrement: true })
      }
      if (!database.objectStoreNames.contains(OUTBOX_RECEIPT_ACK_STORE)) {
        database.createObjectStore(OUTBOX_RECEIPT_ACK_STORE, { keyPath: 'mutationId' })
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => {
        database.close()
        if (outboxDatabasePromise === opening) {
          outboxDatabasePromise = null
          outboxRawEncryptionKeyPromise = null
          outboxSubtleEncryptionKeyPromise = null
        }
      }
      resolve(database)
    }
    request.onerror = () => {
      reportPersistenceWarning('Unable to open the pending-mutation outbox', request.error)
      resolve(null)
    }
    request.onblocked = () => {
      reportPersistenceWarning('Pending-mutation outbox upgrade is blocked')
    }
  })
  outboxDatabasePromise = opening
  return opening
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  })
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function reportPersistenceWarning(message: string, error?: unknown): void {
  if (persistenceWarningReported) return
  persistenceWarningReported = true
  console.warn(message, error)
}
