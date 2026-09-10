import type {
  AgentLorebookInput,
  AgentPresetStepInputScope,
  AgentPresetStepPhase,
  AgentPresetStepRecord,
} from '@risuai/shared-core/agent-preset-records'
import { AGENT_PRESET_STEP_INPUT_SCOPES, agentToggleStorageKey } from '@risuai/shared-core/agent-preset-records'
import { resolveAgentLorebookInput } from '@risuai/shared-core/agent-lorebook-inputs'
import {
  AGENT_PRESET_PREPARED_INPUT_CBS_RE,
  isAgentPresetPreparedInputScope,
} from '@risuai/shared-core/agent-preset-input-references'
import type { AgentPresetPhasePlan } from '@risuai/shared-core/agent-preset-resolver'
import {
  assertModelProfileGenerationReady,
  modelProfileGenerationBlockReason,
  resolveModelProfile,
  resolveModelProfileByProfileId,
  type ResolvedModelProfile,
} from '@risuai/shared-core/model-profile-resolver'
import type { PromptMessage } from './promptMessage.js'
import { parseChatMLRows } from '@risuai/shared-core/chatml-rows'
import { stripInternalReasoning } from '@risuai/shared-core/internal-reasoning'
import type {
  FastifyChat as Chat,
  FastifyCharacter as character,
  FastifyDatabase as Database,
  FastifyMessage as Message,
} from './serverTypes.js'
import type { DatabaseSync } from 'node:sqlite'
import { expandAgentPresetOutputCbs } from '@risuai/shared-core/agent-preset-output-references'
import type { CompletionStreamFrame } from '../generation/frames.js'
import {
  AgentPresetGenerationError,
  isAgentPresetGenerationError,
  type AgentPresetGenerationErrorBody,
  type AgentPresetStepFailureKind,
  type AgentPresetStepFailurePolicyOutcome,
} from './agentPresetErrors.js'
import { dispatchChatProvider, type ChatDispatchHistoryInput } from './chatDispatch.js'
import { activateLorebook } from './lorebook.js'
import { ensureTokenizerLoadedForDb } from './tokenizerConfig.js'
import { expandVariables } from './variables.js'
import { selectedPersonaIndexFromStableId } from '@risuai/shared-core/persona-selection-identity'

export {
  AgentPresetGenerationError,
  isAgentPresetGenerationError,
  type AgentPresetGenerationErrorBody,
  type AgentPresetStepFailureKind,
  type AgentPresetStepFailurePolicyOutcome,
} from './agentPresetErrors.js'

const DEFAULT_MAX_INPUT_CHARS = 24_000
const DEFAULT_MAX_OUTPUT_CHARS = 1_200
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_TEMPERATURE = 100
const RECENT_CHAT_TAIL_COUNT = 12
const CHAT_SEARCH_LIMIT = 6
const AGENT_INPUT_CBS_RE = /\{\{\s*agentInput::([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
const AGENT_TOGGLE_CBS_RE = /\{\{\s*agentToggle::([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

export interface AgentPresetPreviousOutput {
  stepId: string
  stepName: string
  phase: AgentPresetStepPhase
  outputKey: string
  text: string
}

export interface AgentPresetPreparedInputContext {
  database: Database
  requestHistoryDb?: DatabaseSync
  currentChar: character
  currentChat: Chat
  currentUserMessage?: string
  previousAgentOutputs?: readonly AgentPresetPreviousOutput[]
  agentOutputs?: Readonly<Record<string, string>>
  mainDraft?: string
}

export interface AgentPresetPreparedInputSection {
  scope: AgentPresetStepInputScope | 'agentLorebookInput'
  inputKey?: string
  label: string
  sourceLabel: string
  content: string
  charCount: number
  truncated: boolean
}

export interface AgentPresetPreparedInputDiagnostic {
  scope: AgentPresetStepInputScope | 'agentLorebookInput'
  inputKey?: string
  sourceLabel: string
  reason: 'unavailable' | 'empty' | 'max_input_exhausted' | 'collector_error'
  message: string
}

export interface AgentPresetPreparedInputCollection {
  sections: AgentPresetPreparedInputSection[]
  diagnostics: AgentPresetPreparedInputDiagnostic[]
  totalChars: number
  maxInputChars: number
}

export interface BuildAgentPresetStepMessagesInput {
  step: AgentPresetStepRecord
  preparedInputs: AgentPresetPreparedInputCollection
  agentOutputs?: Readonly<Record<string, string>>
  toggleValues?: Readonly<Record<string, string>>
  /** Expands standard CBS after ChatML roles are fixed and before prepared inputs are inserted. */
  expandChatMLContent?: (content: string) => string
}

export interface AgentPresetProviderDispatchArgs {
  database: Database
  messages: PromptMessage[]
  outputTokens: number
  profile: ResolvedModelProfile
  signal: AbortSignal
  history?: ChatDispatchHistoryInput
}

export type AgentPresetProviderDispatcher = (
  args: AgentPresetProviderDispatchArgs,
) => Promise<AsyncIterable<CompletionStreamFrame>> | AsyncIterable<CompletionStreamFrame>

export type AgentPresetStepExecutor = (input: ExecuteAgentPresetStepInput) => Promise<AgentPresetStepExecutionResult>

export type AgentPresetPhaseProgressStatus = 'started' | 'running' | 'finished' | 'error'

export interface AgentPresetActiveStepProgress {
  stepId: string
  stepName: string
  outputKey: string
}

export interface AgentPresetPhaseProgress {
  phase: AgentPresetStepPhase
  status: AgentPresetPhaseProgressStatus
  totalSteps: number
  completedSteps: number
  activeSteps: AgentPresetActiveStepProgress[]
}

export type AgentPresetPhaseProgressReporter = (progress: AgentPresetPhaseProgress) => void

export interface AgentPresetProgress extends AgentPresetPhaseProgress {
  chatId: string
  presetId: string
  presetName: string
}

export type AgentPresetProgressReporter = (progress: AgentPresetProgress) => void

export interface ExecuteAgentPresetStepInput extends AgentPresetPreparedInputContext {
  step: AgentPresetStepRecord
  resolvedMainProfile?: ResolvedModelProfile | null
  dependencySkippedReason?: string
  signal?: AbortSignal
  dispatchProvider?: AgentPresetProviderDispatcher
}

export type AgentPresetStepExecutionResult =
  | {
      status: 'skipped'
      reason: 'disabled' | 'dependency_skipped'
      stepId: string
      stepName: string
      outputKey: string
      diagnostics: AgentPresetStepExecutionDiagnostics
    }
  | {
      status: 'success'
      stepId: string
      stepName: string
      outputKey: string
      outputText: string
      parsedJson?: Record<string, unknown>
      outputTruncated: boolean
      diagnostics: AgentPresetStepExecutionDiagnostics
    }
  | {
      status: 'failed'
      stepId: string
      stepName: string
      outputKey: string
      failureKind: AgentPresetStepFailureKind
      failurePolicyOutcome: AgentPresetStepFailurePolicyOutcome
      error: string
      diagnostics: AgentPresetStepExecutionDiagnostics
    }

export interface AgentPresetStepExecutionDiagnostics {
  phase: AgentPresetStepPhase
  outputFormat: AgentPresetStepRecord['outputFormat']
  destination: AgentPresetStepRecord['destination']
  failurePolicy: AgentPresetStepRecord['failurePolicy']['mode']
  inputChars: number
  outputChars: number
  provider?: string
  profileId?: string
  profileName?: string
  modelId?: string
  requestModel?: string
  startedAt: number
  endedAt: number
  durationMs: number
  preparedInputSections: AgentPresetPreparedInputSection[]
  preparedInputDiagnostics: AgentPresetPreparedInputDiagnostic[]
  parseStatus?: 'not_applicable' | 'ok' | 'invalid'
}

export interface AgentPresetPhaseFailure {
  phase: AgentPresetStepPhase
  stepId: string
  stepName: string
  outputKey: string
  message: string
  failureKind?: AgentPresetStepFailureKind
  failurePolicyOutcome?: AgentPresetStepFailurePolicyOutcome
}

export interface AgentPresetPhaseExecutionResult {
  phase: AgentPresetStepPhase
  stepResults: AgentPresetStepExecutionResult[]
  successfulOutputs: AgentPresetPreviousOutput[]
  previousAgentOutputs: AgentPresetPreviousOutput[]
  outputTextByKey: Record<string, string>
  blockingFailure?: AgentPresetPhaseFailure
}

export interface ExecuteAgentPresetPhaseInput extends AgentPresetPreparedInputContext {
  plan: AgentPresetPhasePlan
  resolvedMainProfile?: ResolvedModelProfile | null
  maxConcurrency?: number
  initialPreviousAgentOutputs?: readonly AgentPresetPreviousOutput[]
  signal?: AbortSignal
  dispatchProvider?: AgentPresetProviderDispatcher
  executeStep?: AgentPresetStepExecutor
  onProgress?: AgentPresetPhaseProgressReporter
}

export function assertAgentPresetLorebookInputsReady(input: {
  steps: readonly AgentPresetStepRecord[]
  currentChar: character
  currentChat: Chat
  presetId?: string
  presetName?: string
}): void {
  for (const step of input.steps) {
    for (const definition of step.lorebookInputs ?? []) {
      if (!definition.required) continue
      const resolution = resolveAgentLorebookInput(definition, input.currentChar, input.currentChat)
      if (resolution.status === 'resolved') continue
      const message = 'message' in resolution ? resolution.message : `Missing lorebook input: ${definition.displayName}`
      throw new AgentPresetGenerationError(message, {
        phase: step.phase,
        presetId: input.presetId,
        presetName: input.presetName,
        stepId: step.id,
        stepName: step.name,
        outputKey: step.outputKey,
        diagnostics: {
          status: 'lorebook_input_not_ready',
          inputKey: definition.key,
          displayName: definition.displayName,
          resolution: resolution.status,
          ...('scope' in resolution && resolution.scope ? { scope: resolution.scope } : {}),
        },
      })
    }
  }
}

class AgentPresetTimeoutError extends Error {
  constructor() {
    super('Agent Preset step timed out')
    this.name = 'AgentPresetTimeoutError'
  }
}

export function collectAgentPresetPreparedInputs(
  step: AgentPresetStepRecord,
  context: AgentPresetPreparedInputContext,
): AgentPresetPreparedInputCollection {
  const maxInputChars = maxInputCharsForStep(step)
  let remaining = maxInputChars
  const sections: AgentPresetPreparedInputSection[] = []
  const diagnostics: AgentPresetPreparedInputDiagnostic[] = []

  // Explicit named inputs take priority over broad prepared-input scopes. A
  // required input must not disappear merely because a chat-history scope
  // consumed the step's complete input budget first.
  for (const definition of referencedAgentLorebookInputs(step)) {
    const sourceLabel = `Agent-only lorebook “${definition.displayName}”`
    if (remaining <= 0) {
      diagnostics.push({
        scope: 'agentLorebookInput',
        inputKey: definition.key,
        sourceLabel,
        reason: 'max_input_exhausted',
        message: `Skipped ${sourceLabel}; max input budget is exhausted.`,
      })
      continue
    }
    const resolution = resolveAgentLorebookInput(definition, context.currentChar, context.currentChat)
    if (resolution.status !== 'resolved') {
      diagnostics.push({
        scope: 'agentLorebookInput',
        inputKey: definition.key,
        sourceLabel,
        reason: resolution.status === 'optional_missing' ? 'unavailable' : 'collector_error',
        message: 'message' in resolution ? resolution.message : `${sourceLabel} is unavailable.`,
      })
      continue
    }
    const bounded = boundText(resolution.content.trim(), remaining)
    sections.push({
      scope: 'agentLorebookInput',
      inputKey: definition.key,
      label: definition.displayName,
      sourceLabel: `${resolution.scope} lorebook`,
      content: bounded.text,
      charCount: bounded.text.length,
      truncated: bounded.truncated,
    })
    remaining -= bounded.text.length
  }

  for (const scope of orderedScopes(step.inputScopes)) {
    const sourceLabel = sourceLabelForScope(scope)
    if (remaining <= 0) {
      diagnostics.push({
        scope,
        sourceLabel,
        reason: 'max_input_exhausted',
        message: `Skipped ${sourceLabel}; max input budget is exhausted.`,
      })
      continue
    }

    let collected: string
    try {
      collected = collectScope(scope, step, context)
    } catch (err) {
      diagnostics.push({
        scope,
        sourceLabel,
        reason: 'collector_error',
        message: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    const trimmed = collected.trim()
    if (!trimmed) {
      diagnostics.push({
        scope,
        sourceLabel,
        reason: isScopeUnavailable(scope, step, context) ? 'unavailable' : 'empty',
        message: `${sourceLabel} produced no content.`,
      })
      continue
    }

    const bounded = boundText(trimmed, remaining)
    sections.push({
      scope,
      label: sectionLabelForScope(scope),
      sourceLabel,
      content: bounded.text,
      charCount: bounded.text.length,
      truncated: bounded.truncated,
    })
    remaining -= bounded.text.length
  }

  return {
    sections,
    diagnostics,
    totalChars: sections.reduce((sum, section) => sum + section.charCount, 0),
    maxInputChars,
  }
}

export function buildAgentPresetStepMessages(input: BuildAgentPresetStepMessagesInput): PromptMessage[] {
  const { step, preparedInputs, agentOutputs, toggleValues, expandChatMLContent } = input
  if (step.useChatML) {
    const messages = parseChatMLRows(step.instruction)
    if (!messages) throw new Error('A ChatML Agent instruction must start with <|im_start|>')
    return messages.map((message) => ({
      ...message,
      content: expandAgentInstructionContent(
        expandChatMLContent?.(message.content) ?? message.content,
        preparedInputs,
        agentOutputs,
        toggleValues ?? {},
      ),
    }))
  }

  const system = [
    'You are executing one RisuAI Agent Preset helper step.',
    `Step name: ${step.name}`,
    `Phase: ${step.phase}`,
    `Output key: ${step.outputKey}`,
    `Destination: ${step.destination}`,
    step.outputFormat === 'jsonObject'
      ? 'Return exactly one JSON object. Do not wrap it in Markdown or explanatory prose.'
      : 'Return free text only. Do not include tool calls.',
    'Prepared input CBS placeholders in the author instruction are already expanded.',
    'Use only the context embedded in the author instruction. Do not include tool calls.',
  ].join('\n')

  const authorInstruction = expandAgentInstructionContent(
    step.instruction,
    preparedInputs,
    agentOutputs,
    toggleValues ?? {},
  ).trim()

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Author instruction:\n${authorInstruction}` },
  ]
}

function expandAgentInstructionContent(
  instruction: string,
  preparedInputs: AgentPresetPreparedInputCollection,
  agentOutputs: Readonly<Record<string, string>> | undefined,
  toggleValues: Readonly<Record<string, string>>,
): string {
  return expandAgentPresetOutputCbs(
    expandAgentToggleCbs(
      expandAgentInputCbs(expandPreparedInputCbs(instruction, preparedInputs), preparedInputs),
      toggleValues,
    ),
    (key) => (agentOutputs && Object.prototype.hasOwnProperty.call(agentOutputs, key) ? agentOutputs[key] : ''),
  )
}

export function resolveAgentPresetStepProfile(input: {
  database: Database
  step: AgentPresetStepRecord
  resolvedMainProfile?: ResolvedModelProfile | null
}): ResolvedModelProfile | null {
  if (input.step.model.mode === 'modelProfile') {
    return resolveModelProfileByProfileId({
      database: input.database,
      role: 'chatAux',
      profileId: input.step.model.profileId,
    })
  }
  return input.resolvedMainProfile ?? resolveModelProfile({ database: input.database })
}

function expandPreparedInputCbs(instruction: string, preparedInputs: AgentPresetPreparedInputCollection): string {
  const contentByScope = new Map(preparedInputs.sections.map((section) => [section.scope, section.content]))
  return instruction.replace(AGENT_PRESET_PREPARED_INPUT_CBS_RE, (match, name: string) => {
    if (!isAgentPresetPreparedInputScope(name)) return match
    return contentByScope.get(name) ?? ''
  })
}

function expandAgentInputCbs(instruction: string, preparedInputs: AgentPresetPreparedInputCollection): string {
  const contentByKey = new Map(
    preparedInputs.sections.flatMap((section) =>
      section.scope === 'agentLorebookInput' && section.inputKey ? [[section.inputKey, section.content] as const] : [],
    ),
  )
  return instruction.replace(AGENT_INPUT_CBS_RE, (_match, key: string) => contentByKey.get(key) ?? '')
}

function expandAgentToggleCbs(instruction: string, toggleValues: Readonly<Record<string, string>>): string {
  return instruction.replace(AGENT_TOGGLE_CBS_RE, (_match, key: string) => toggleValues[key] ?? '')
}

function referencedAgentLorebookInputs(step: AgentPresetStepRecord): AgentLorebookInput[] {
  const inputsByKey = new Map((step.lorebookInputs ?? []).map((input) => [input.key, input]))
  const referenced = new Set<string>()
  for (const match of step.instruction.matchAll(AGENT_INPUT_CBS_RE)) referenced.add(match[1])
  return (step.lorebookInputs ?? []).filter((input) => referenced.has(input.key) && inputsByKey.has(input.key))
}

function agentToggleValuesForStep(step: AgentPresetStepRecord, chat: Chat): Record<string, string> {
  if (!step.agentId) return {}
  const stored = chat.generationSettings?.sidebarToggles ?? {}
  return Object.fromEntries(
    (step.toggles ?? []).map((toggle) => [toggle.key, stored[agentToggleStorageKey(step.agentId!, toggle.key)] ?? '']),
  )
}

function stepWithReferencedPreparedInputScopes(step: AgentPresetStepRecord): AgentPresetStepRecord {
  const inputScopes = referencedPreparedInputScopes(step)
  return inputScopes.length === step.inputScopes.length ? step : { ...step, inputScopes }
}

function referencedPreparedInputScopes(step: AgentPresetStepRecord): AgentPresetStepInputScope[] {
  const selectedScopes = new Set(step.inputScopes)
  const referencedScopes = new Set<AgentPresetStepInputScope>()
  for (const match of step.instruction.matchAll(AGENT_PRESET_PREPARED_INPUT_CBS_RE)) {
    const name = match[1]
    if (isAgentPresetPreparedInputScope(name) && selectedScopes.has(name)) {
      referencedScopes.add(name)
    }
  }
  return orderedScopes([...referencedScopes])
}

function agentPromptLocation(input: AgentPresetPreparedInputContext): { selectedCharID?: number; chatPage?: number } {
  const characters = input.database.characters
  const selectedCharID = characters.findIndex(
    (candidate) => candidate === input.currentChar || candidate.chaId === input.currentChar.chaId,
  )
  if (selectedCharID < 0) return {}

  const character = characters[selectedCharID]
  const chatPage = character.chats.findIndex(
    (candidate) =>
      candidate === input.currentChat ||
      (typeof candidate.id === 'string' && candidate.id !== '' && candidate.id === input.currentChat.id),
  )
  return {
    selectedCharID,
    ...(chatPage >= 0 ? { chatPage } : {}),
  }
}

export async function executeAgentPresetStep(
  input: ExecuteAgentPresetStepInput,
): Promise<AgentPresetStepExecutionResult> {
  const startedAt = Date.now()
  if (!input.step.enabled) {
    return skippedResult(input.step, 'disabled', startedAt, emptyCollection(input.step))
  }
  if (input.dependencySkippedReason) {
    return skippedResult(input.step, 'dependency_skipped', startedAt, emptyCollection(input.step))
  }
  throwIfAgentPresetAborted(input.signal)

  await ensureTokenizerLoadedForDb(input.database)

  const preparedInputStep = stepWithReferencedPreparedInputScopes(input.step)
  const preparedInputs = collectAgentPresetPreparedInputs(preparedInputStep, input)
  const messages = buildAgentPresetStepMessages({
    step: input.step,
    preparedInputs,
    agentOutputs: input.agentOutputs,
    toggleValues: agentToggleValuesForStep(input.step, input.currentChat),
    expandChatMLContent: input.step.useChatML
      ? (content) =>
          expandVariables(content, {
            database: input.database,
            ...agentPromptLocation(input),
            chara: input.currentChar,
            ...(input.agentOutputs ? { agentOutputs: { ...input.agentOutputs } } : {}),
          }).text
      : undefined,
  })
  const profile = resolveAgentPresetStepProfile(input)
  if (!profile) {
    return failureResult({
      step: input.step,
      kind: 'model_not_ready',
      message: 'Selected model profile is unavailable.',
      startedAt,
      preparedInputs,
    })
  }

  const blockReason = modelProfileGenerationBlockReason(profile)
  if (blockReason) {
    return failureResult({
      step: input.step,
      kind: 'model_not_ready',
      message: blockReason,
      startedAt,
      preparedInputs,
      profile,
    })
  }

  try {
    assertModelProfileGenerationReady(profile)
  } catch (err) {
    return failureResult({
      step: input.step,
      kind: 'model_not_ready',
      message: err instanceof Error ? err.message : String(err),
      startedAt,
      preparedInputs,
      profile,
    })
  }

  const controller = new AbortController()
  const timeoutMs = timeoutMsForStep(input.step)
  const parentAbort = (): void => controller.abort(input.signal?.reason)
  if (input.signal?.aborted) parentAbort()
  else input.signal?.addEventListener('abort', parentAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const output = await withTimeout(
      collectProviderOutput({
        database: prepareDatabaseForStep(input.database, input.step),
        messages,
        outputTokens: maxOutputCharsForStep(input.step),
        profile,
        signal: controller.signal,
        ...(input.requestHistoryDb
          ? {
              history: {
                db: input.requestHistoryDb,
                source: 'agent-preset',
                context: {
                  characterId: input.currentChar.chaId,
                  characterName: input.currentChar.name,
                  ...(input.currentChat.id ? { chatId: input.currentChat.id } : {}),
                  ...(input.currentChat.name ? { chatName: input.currentChat.name } : {}),
                },
                ...(input.currentChat.generationSettings?.sidebarToggles
                  ? { toggles: { ...input.currentChat.generationSettings.sidebarToggles } }
                  : {}),
                metadata: {
                  agentPresetStepId: input.step.id,
                  agentPresetStepName: input.step.name,
                  agentPresetPhase: input.step.phase,
                  agentPresetOutputKey: input.step.outputKey,
                },
              },
            }
          : {}),
        dispatchProvider: input.dispatchProvider ?? defaultAgentPresetProviderDispatcher,
      }),
      timeoutMs,
    )
    // Provider dispatch records the unmodified response in request history.
    // Only the externally usable Agent output is scrubbed so private reasoning
    // cannot flow into a later Agent, the main prompt, or the persisted reply.
    const bounded = boundText(stripInternalReasoning(output), maxOutputCharsForStep(input.step))
    if (!bounded.text) {
      return failureResult({
        step: input.step,
        kind: 'empty_output',
        message: 'Agent Preset step returned an empty output.',
        startedAt,
        preparedInputs,
        profile,
      })
    }

    if (input.step.outputFormat === 'jsonObject') {
      const parsed = parseJsonObject(bounded.text)
      if (parsed.status === 'error') {
        return failureResult({
          step: input.step,
          kind: 'invalid_json_output',
          message: parsed.error,
          startedAt,
          preparedInputs,
          profile,
          outputChars: bounded.text.length,
          parseStatus: 'invalid',
        })
      }
      return successResult({
        step: input.step,
        text: bounded.text,
        parsedJson: parsed.value,
        outputTruncated: bounded.truncated,
        startedAt,
        preparedInputs,
        profile,
        parseStatus: 'ok',
      })
    }

    return successResult({
      step: input.step,
      text: bounded.text,
      outputTruncated: bounded.truncated,
      startedAt,
      preparedInputs,
      profile,
      parseStatus: 'not_applicable',
    })
  } catch (err) {
    throwIfAgentPresetAborted(input.signal)
    const timeoutFailure = err instanceof AgentPresetTimeoutError || controller.signal.aborted
    return failureResult({
      step: input.step,
      kind: timeoutFailure ? 'timeout' : 'provider_error',
      message: timeoutFailure ? 'Agent Preset step timed out.' : err instanceof Error ? err.message : String(err),
      startedAt,
      preparedInputs,
      profile,
    })
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', parentAbort)
  }
}

function throwIfAgentPresetAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('Agent Preset step aborted.')
  error.name = 'AbortError'
  throw error
}

export async function executeAgentPresetPhase(
  input: ExecuteAgentPresetPhaseInput,
): Promise<AgentPresetPhaseExecutionResult> {
  const maxConcurrency = normalizeMaxConcurrency(input.maxConcurrency)
  const executeStep = input.executeStep ?? executeAgentPresetStep
  const resultByStepId = new Map<string, AgentPresetStepExecutionResult>()
  const initialPreviousOutputs = input.initialPreviousAgentOutputs ?? input.previousAgentOutputs ?? []
  const previousOutputs: AgentPresetPreviousOutput[] = [...initialPreviousOutputs]
  const successfulOutputs: AgentPresetPreviousOutput[] = []
  const outputTextByKey: Record<string, string> = previousOutputsToOutputTextByKey(previousOutputs)
  const totalSteps = input.plan.steps.length
  const activeSteps = new Map<string, AgentPresetActiveStepProgress>()
  let completedSteps = 0

  const reportProgress = (status: AgentPresetPhaseProgressStatus): void => {
    try {
      input.onProgress?.({
        phase: input.plan.phase,
        status,
        totalSteps,
        completedSteps,
        activeSteps: [...activeSteps.values()],
      })
    } catch {
      // Progress reporting is best-effort and must never interrupt generation.
    }
  }

  if (totalSteps > 0) reportProgress('started')

  try {
    for (const level of input.plan.dependencyLevels) {
      const levelSteps = level.stepIds
        .map((stepId) => input.plan.steps.find((planned) => planned.step.id === stepId)?.step)
        .filter((step): step is AgentPresetStepRecord => !!step)

      const levelResults = await runWithConcurrency(levelSteps, maxConcurrency, async (step) => {
        activeSteps.set(step.id, {
          stepId: step.id,
          stepName: step.name,
          outputKey: step.outputKey,
        })
        reportProgress('running')
        const dependencySkippedReason = dependencySkippedReasonFor(step, resultByStepId)
        try {
          return await executeStep({
            database: input.database,
            requestHistoryDb: input.requestHistoryDb,
            currentChar: input.currentChar,
            currentChat: input.currentChat,
            currentUserMessage: input.currentUserMessage,
            previousAgentOutputs: previousOutputs,
            agentOutputs: { ...outputTextByKey },
            mainDraft: input.mainDraft,
            step,
            resolvedMainProfile: input.resolvedMainProfile,
            dependencySkippedReason,
            signal: input.signal,
            dispatchProvider: input.dispatchProvider,
          })
        } finally {
          activeSteps.delete(step.id)
          completedSteps += 1
          reportProgress('running')
        }
      })

      for (const [index, result] of levelResults.entries()) {
        const step = levelSteps[index]
        if (!step) continue
        resultByStepId.set(step.id, result)
      }

      for (const planned of input.plan.steps) {
        if (!level.stepIds.includes(planned.step.id)) continue
        const result = resultByStepId.get(planned.step.id)
        if (result?.status !== 'success') continue
        const output: AgentPresetPreviousOutput = {
          stepId: result.stepId,
          stepName: result.stepName,
          phase: planned.step.phase,
          outputKey: result.outputKey,
          text: result.outputText,
        }
        successfulOutputs.push(output)
        previousOutputs.push(output)
        outputTextByKey[result.outputKey] = result.outputText
      }

      const blockingFailure = firstBlockingFailure(levelSteps, resultByStepId)
      if (blockingFailure) {
        reportProgress('error')
        return phaseResult(
          input.plan.phase,
          input.plan,
          resultByStepId,
          successfulOutputs,
          previousOutputs,
          outputTextByKey,
          {
            blockingFailure,
          },
        )
      }
    }

    if (totalSteps > 0) reportProgress('finished')
    return phaseResult(
      input.plan.phase,
      input.plan,
      resultByStepId,
      successfulOutputs,
      previousOutputs,
      outputTextByKey,
    )
  } catch (error) {
    if (totalSteps > 0) reportProgress('error')
    throw error
  }
}

function previousOutputsToOutputTextByKey(outputs: readonly AgentPresetPreviousOutput[]): Record<string, string> {
  const byKey: Record<string, string> = {}
  for (const output of outputs) byKey[output.outputKey] = output.text
  return byKey
}

export function agentPresetStepResultErrorMessage(result: AgentPresetStepExecutionResult): string | undefined {
  if (result.status === 'failed') return result.error
  if (result.status === 'skipped') {
    return result.reason === 'dependency_skipped'
      ? 'Agent Preset step was skipped because a dependency did not produce output.'
      : 'Agent Preset step was skipped.'
  }
  return undefined
}

function phaseResult(
  phase: AgentPresetStepPhase,
  plan: AgentPresetPhasePlan,
  resultByStepId: ReadonlyMap<string, AgentPresetStepExecutionResult>,
  successfulOutputs: AgentPresetPreviousOutput[],
  previousAgentOutputs: AgentPresetPreviousOutput[],
  outputTextByKey: Record<string, string>,
  options: { blockingFailure?: AgentPresetPhaseFailure } = {},
): AgentPresetPhaseExecutionResult {
  return {
    phase,
    stepResults: plan.steps
      .map((planned) => resultByStepId.get(planned.step.id))
      .filter((result): result is AgentPresetStepExecutionResult => !!result),
    successfulOutputs,
    previousAgentOutputs,
    outputTextByKey,
    ...(options.blockingFailure ? { blockingFailure: options.blockingFailure } : {}),
  }
}

function normalizeMaxConcurrency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return Number.POSITIVE_INFINITY
  return Math.max(1, Math.min(16, Math.trunc(value)))
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let next = 0
  const workerCount = Math.min(items.length, concurrency)

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const index = next
        next += 1
        results[index] = await run(items[index])
      }
    }),
  )

  return results
}

function dependencySkippedReasonFor(
  step: AgentPresetStepRecord,
  resultByStepId: ReadonlyMap<string, AgentPresetStepExecutionResult>,
): string | undefined {
  for (const dependencyId of step.dependencies) {
    const result = resultByStepId.get(dependencyId)
    if (!result) {
      return `Dependency did not run: ${dependencyId}`
    }
    if (result.status !== 'success') {
      return `Dependency did not produce output: ${result.stepName}`
    }
  }
  return undefined
}

function firstBlockingFailure(
  steps: readonly AgentPresetStepRecord[],
  resultByStepId: ReadonlyMap<string, AgentPresetStepExecutionResult>,
): AgentPresetPhaseFailure | undefined {
  for (const step of steps) {
    const result = resultByStepId.get(step.id)
    if (!result || !isBlockingResult(step, result)) continue
    return {
      phase: step.phase,
      stepId: step.id,
      stepName: step.name,
      outputKey: step.outputKey,
      message: agentPresetStepResultErrorMessage(result) ?? 'Agent Preset step failed.',
      ...(result.status === 'failed'
        ? {
            failureKind: result.failureKind,
            failurePolicyOutcome: result.failurePolicyOutcome,
          }
        : {}),
    }
  }
  return undefined
}

function isBlockingResult(step: AgentPresetStepRecord, result: AgentPresetStepExecutionResult): boolean {
  if (result.status === 'success') return false
  if (result.status === 'failed') return result.failurePolicyOutcome !== 'optional_failure'
  if (result.reason === 'disabled') return false
  return step.failurePolicy.mode === 'required' || step.failurePolicy.mode === 'stopGeneration'
}

async function defaultAgentPresetProviderDispatcher(
  args: AgentPresetProviderDispatchArgs,
): Promise<AsyncIterable<CompletionStreamFrame>> {
  return dispatchChatProvider({
    database: args.database,
    formated: args.messages,
    outputTokens: args.outputTokens,
    profile: args.profile,
    signal: args.signal,
    history: args.history,
  })
}

async function collectProviderOutput(
  input: AgentPresetProviderDispatchArgs & {
    dispatchProvider: AgentPresetProviderDispatcher
  },
): Promise<string> {
  const frames = await input.dispatchProvider(input)
  let output = ''
  for await (const frame of frames) {
    if (frame.kind === 'token' && typeof frame.content === 'string') {
      output += frame.content
      continue
    }
    if (frame.kind === 'error') {
      throw new Error(frame.error ?? 'Provider error')
    }
  }
  return output
}

function prepareDatabaseForStep(database: Database, step: AgentPresetStepRecord): Database {
  const copy: Database = { ...database }
  copy.halfStreaming = false
  copy.useStreaming = false
  copy.maxResponse = maxOutputCharsForStep(step)
  copy.temperature = temperatureForStep(step)
  copy.modelTools = []
  return copy
}

function skippedResult(
  step: AgentPresetStepRecord,
  reason: 'disabled' | 'dependency_skipped',
  startedAt: number,
  preparedInputs: AgentPresetPreparedInputCollection,
): AgentPresetStepExecutionResult {
  return {
    status: 'skipped',
    reason,
    stepId: step.id,
    stepName: step.name,
    outputKey: step.outputKey,
    diagnostics: diagnosticsFor({
      step,
      startedAt,
      preparedInputs,
      outputChars: 0,
    }),
  }
}

function successResult(input: {
  step: AgentPresetStepRecord
  text: string
  parsedJson?: Record<string, unknown>
  outputTruncated: boolean
  startedAt: number
  preparedInputs: AgentPresetPreparedInputCollection
  profile?: ResolvedModelProfile
  parseStatus: AgentPresetStepExecutionDiagnostics['parseStatus']
}): AgentPresetStepExecutionResult {
  return {
    status: 'success',
    stepId: input.step.id,
    stepName: input.step.name,
    outputKey: input.step.outputKey,
    outputText: input.text,
    ...(input.parsedJson ? { parsedJson: input.parsedJson } : {}),
    outputTruncated: input.outputTruncated,
    diagnostics: diagnosticsFor({
      step: input.step,
      startedAt: input.startedAt,
      preparedInputs: input.preparedInputs,
      outputChars: input.text.length,
      profile: input.profile,
      parseStatus: input.parseStatus,
    }),
  }
}

function failureResult(input: {
  step: AgentPresetStepRecord
  kind: AgentPresetStepFailureKind
  message: string
  startedAt: number
  preparedInputs: AgentPresetPreparedInputCollection
  profile?: ResolvedModelProfile
  outputChars?: number
  parseStatus?: AgentPresetStepExecutionDiagnostics['parseStatus']
}): AgentPresetStepExecutionResult {
  const outcome = failurePolicyOutcome(input.step)
  if (outcome === 'fallback_text' && input.step.failurePolicy.mode === 'fallbackText') {
    const fallbackText = input.step.failurePolicy.text.trim()
    if (!fallbackText) {
      return failedResult(input, outcome, 'empty_output', 'Agent Preset fallback text is empty.')
    }
    if (input.step.outputFormat === 'jsonObject') {
      const parsed = parseJsonObject(fallbackText)
      if (parsed.status === 'error') {
        return failedResult(
          {
            ...input,
            outputChars: fallbackText.length,
            parseStatus: 'invalid',
          },
          outcome,
          'invalid_json_output',
          `Agent Preset fallback text is not a JSON object: ${parsed.error}`,
        )
      }
      return successResult({
        step: input.step,
        text: fallbackText,
        parsedJson: parsed.value,
        outputTruncated: false,
        startedAt: input.startedAt,
        preparedInputs: input.preparedInputs,
        profile: input.profile,
        parseStatus: 'ok',
      })
    }
    return successResult({
      step: input.step,
      text: fallbackText,
      outputTruncated: false,
      startedAt: input.startedAt,
      preparedInputs: input.preparedInputs,
      profile: input.profile,
      parseStatus: input.parseStatus ?? 'not_applicable',
    })
  }

  return failedResult(input, outcome, input.kind, input.message)
}

function failedResult(
  input: {
    step: AgentPresetStepRecord
    kind: AgentPresetStepFailureKind
    message: string
    startedAt: number
    preparedInputs: AgentPresetPreparedInputCollection
    profile?: ResolvedModelProfile
    outputChars?: number
    parseStatus?: AgentPresetStepExecutionDiagnostics['parseStatus']
  },
  outcome: AgentPresetStepFailurePolicyOutcome,
  kind: AgentPresetStepFailureKind,
  message: string,
): AgentPresetStepExecutionResult {
  return {
    status: 'failed',
    stepId: input.step.id,
    stepName: input.step.name,
    outputKey: input.step.outputKey,
    failureKind: kind,
    failurePolicyOutcome: outcome,
    error: message,
    diagnostics: diagnosticsFor({
      step: input.step,
      startedAt: input.startedAt,
      preparedInputs: input.preparedInputs,
      outputChars: input.outputChars ?? 0,
      profile: input.profile,
      parseStatus: input.parseStatus,
    }),
  }
}

function failurePolicyOutcome(step: AgentPresetStepRecord): AgentPresetStepFailurePolicyOutcome {
  switch (step.failurePolicy.mode) {
    case 'optional':
      return 'optional_failure'
    case 'fallbackText':
      return 'fallback_text'
    case 'stopGeneration':
      return 'stop_generation'
    case 'required':
    default:
      return 'required_failure'
  }
}

function diagnosticsFor(input: {
  step: AgentPresetStepRecord
  startedAt: number
  preparedInputs: AgentPresetPreparedInputCollection
  outputChars: number
  profile?: ResolvedModelProfile
  parseStatus?: AgentPresetStepExecutionDiagnostics['parseStatus']
}): AgentPresetStepExecutionDiagnostics {
  const endedAt = Date.now()
  return {
    phase: input.step.phase,
    outputFormat: input.step.outputFormat,
    destination: input.step.destination,
    failurePolicy: input.step.failurePolicy.mode,
    inputChars: input.preparedInputs.totalChars,
    outputChars: input.outputChars,
    provider:
      input.profile?.providerCapability.routable === true ? input.profile.providerCapability.provider : undefined,
    profileId: input.profile?.source.profileId ?? input.profile?.profileId,
    profileName: input.profile?.source.profileName,
    modelId: input.profile?.modelId,
    requestModel: input.profile?.requestModel,
    startedAt: input.startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - input.startedAt),
    preparedInputSections: input.preparedInputs.sections,
    preparedInputDiagnostics: input.preparedInputs.diagnostics,
    ...(input.parseStatus ? { parseStatus: input.parseStatus } : {}),
  }
}

function maxInputCharsForStep(step: AgentPresetStepRecord): number {
  return clampInteger(step.runtime.maxInputChars, DEFAULT_MAX_INPUT_CHARS, 0, 500_000)
}

function maxOutputCharsForStep(step: AgentPresetStepRecord): number {
  return clampInteger(step.runtime.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 1, 120_000)
}

function timeoutMsForStep(step: AgentPresetStepRecord): number {
  return clampInteger(step.runtime.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 300_000)
}

function temperatureForStep(step: AgentPresetStepRecord): number {
  const temperature = step.runtime.temperature
  return typeof temperature === 'number' && Number.isFinite(temperature)
    ? Math.max(0, Math.min(200, temperature))
    : DEFAULT_TEMPERATURE
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function orderedScopes(scopes: readonly AgentPresetStepInputScope[]): AgentPresetStepInputScope[] {
  const selected = new Set(scopes)
  return AGENT_PRESET_STEP_INPUT_SCOPES.filter((scope) => selected.has(scope))
}

function collectScope(
  scope: AgentPresetStepInputScope,
  step: AgentPresetStepRecord,
  context: AgentPresetPreparedInputContext,
): string {
  switch (scope) {
    case 'recentChatTail':
      return recentChatTail(context.currentChat)
    case 'chatSearchSnippets':
      return chatSearchSnippets(context)
    case 'lorebookContext':
      return lorebookContext(context)
    case 'memoryContext':
      return memoryContext(context.currentChat)
    case 'characterSummary':
      return characterSummary(context.currentChar)
    case 'personaSummary':
      return personaSummary(context.database)
    case 'currentUserMessage':
      return currentUserMessage(context)
    case 'previousAgentOutputs':
      return previousAgentOutputs(context.previousAgentOutputs ?? [])
    case 'mainDraft':
      return step.phase === 'afterMain' ? (context.mainDraft ?? '') : ''
  }
}

function isScopeUnavailable(
  scope: AgentPresetStepInputScope,
  step: AgentPresetStepRecord,
  context: AgentPresetPreparedInputContext,
): boolean {
  if (scope === 'mainDraft') return step.phase !== 'afterMain' || !context.mainDraft
  if (scope === 'previousAgentOutputs') return !context.previousAgentOutputs?.length
  if (scope === 'currentUserMessage') return !currentUserMessage(context).trim()
  return false
}

function recentChatTail(chat: Chat): string {
  return (chat.message ?? [])
    .slice(-RECENT_CHAT_TAIL_COUNT)
    .map((message, index) => `${index + 1}. ${messageRole(message)}: ${messageContent(message)}`)
    .join('\n')
}

function chatSearchSnippets(context: AgentPresetPreparedInputContext): string {
  const query = currentUserMessage(context)
  if (!query.trim()) return ''
  const results: Array<{ score: number; order: number; text: string }> = []
  let order = 0
  for (const char of context.database.characters ?? []) {
    for (const chat of char.chats ?? []) {
      for (const message of chat.message ?? []) {
        const text = messageContent(message)
        const score = searchScore(`${chat.name ?? ''}\n${text}`, query)
        if (score > 0) {
          results.push({
            score,
            order,
            text: `${char.name ?? char.chaId} / ${chat.name ?? chat.id ?? 'chat'} / ${messageRole(message)}: ${text}`,
          })
        }
        order += 1
      }
    }
  }
  return results
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, CHAT_SEARCH_LIMIT)
    .map((result, index) => `${index + 1}. ${result.text}`)
    .join('\n')
}

function lorebookContext(context: AgentPresetPreparedInputContext): string {
  const report = activateLorebook({
    database: context.database,
    currentChar: structuredClone(context.currentChar) as character,
    currentChat: structuredClone(context.currentChat) as Chat,
  })
  return report.actives.map((entry, index) => `${index + 1}. ${entry.source}: ${entry.prompt}`).join('\n')
}

function memoryContext(chat: Chat): string {
  const rows: string[] = []
  if (typeof chat.lastMemory === 'string' && chat.lastMemory.trim()) {
    rows.push(`Last memory: ${chat.lastMemory.trim()}`)
  }
  for (const message of chat.message ?? []) {
    const memo = (message as { memo?: unknown }).memo
    if (memo === 'supaMemory' || memo === 'hypaMemory') {
      rows.push(`${memo}: ${messageContent(message)}`)
    }
  }
  if (chat.hypaV3Data) rows.push(`Hypa V3 data: ${JSON.stringify(chat.hypaV3Data)}`)
  return rows.join('\n')
}

function characterSummary(char: character): string {
  return labeledFields([
    ['name', char.name],
    ['displayName', char.nickname],
    ['description', char.desc],
    ['personality', char.personality],
    ['scenario', char.scenario],
    ['systemPrompt', char.systemPrompt],
    ['postHistoryInstructions', char.postHistoryInstructions],
    ['creatorNotes', char.creatorNotes],
  ])
}

function personaSummary(database: Database): string {
  const selectedIndex = selectedPersonaIndexFromStableId(database)
  const selectedPersona = selectedIndex >= 0 ? database.personas?.[selectedIndex] : undefined
  return labeledFields([
    ['selectedPersona', selectedPersona?.name ?? selectedPersona?.displayName],
    ['personaPrompt', selectedPersona?.personaPrompt ?? database.personaPrompt],
    ['username', database.username],
  ])
}

function currentUserMessage(context: AgentPresetPreparedInputContext): string {
  if (typeof context.currentUserMessage === 'string') return context.currentUserMessage
  const messages = context.currentChat.message ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messageContent(messages[index])
  }
  return ''
}

function previousAgentOutputs(outputs: readonly AgentPresetPreviousOutput[]): string {
  return outputs
    .map((output) => `[${output.phase}] ${output.outputKey} (${output.stepName}):\n${output.text}`)
    .join('\n\n')
}

function labeledFields(fields: ReadonlyArray<readonly [string, unknown]>): string {
  return fields
    .map(([label, value]) => [label, typeof value === 'string' ? value.trim() : ''] as const)
    .filter(([, value]) => value.length > 0)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n')
}

function messageContent(message: Message): string {
  return typeof message.data === 'string' ? message.data : ''
}

function messageRole(message: Message): string {
  return message.role === 'char' ? 'assistant' : message.role
}

function searchScore(haystack: string, query: string): number {
  const lower = haystack.toLowerCase()
  const exact = query.trim().toLowerCase()
  let score = exact && lower.includes(exact) ? 8 : 0
  for (const term of queryTerms(query)) {
    if (lower.includes(term)) score += 2
  }
  return score
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_'-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 12)
}

function sectionLabelForScope(scope: AgentPresetStepInputScope): string {
  switch (scope) {
    case 'recentChatTail':
      return 'Recent chat tail'
    case 'chatSearchSnippets':
      return 'Chat search snippets'
    case 'lorebookContext':
      return 'Lorebook context'
    case 'memoryContext':
      return 'Memory context'
    case 'characterSummary':
      return 'Character summary'
    case 'personaSummary':
      return 'Persona summary'
    case 'currentUserMessage':
      return 'Current user message'
    case 'previousAgentOutputs':
      return 'Previous agent outputs'
    case 'mainDraft':
      return 'Main draft'
  }
}

function sourceLabelForScope(scope: AgentPresetStepInputScope): string {
  switch (scope) {
    case 'recentChatTail':
      return 'current chat tail'
    case 'chatSearchSnippets':
      return 'chat search'
    case 'lorebookContext':
      return 'selected lorebooks'
    case 'memoryContext':
      return 'selected memory'
    case 'characterSummary':
      return 'current character'
    case 'personaSummary':
      return 'selected persona'
    case 'currentUserMessage':
      return 'submitted user message'
    case 'previousAgentOutputs':
      return 'completed agent outputs'
    case 'mainDraft':
      return 'post-edit main draft'
  }
}

function boundText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  if (maxChars <= 3) return { text: text.slice(0, Math.max(0, maxChars)), truncated: true }
  return { text: text.slice(0, maxChars - 3).trimEnd() + '...', truncated: true }
}

type ParseJsonObjectResult = { status: 'ok'; value: Record<string, unknown> } | { status: 'error'; error: string }

function parseJsonObject(text: string): ParseJsonObjectResult {
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'error', error: 'Agent Preset JSON output must be one object.' }
    }
    return { status: 'ok', value: parsed as Record<string, unknown> }
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new AgentPresetTimeoutError()), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function emptyCollection(step: AgentPresetStepRecord): AgentPresetPreparedInputCollection {
  return {
    sections: [],
    diagnostics: [],
    totalChars: 0,
    maxInputChars: maxInputCharsForStep(step),
  }
}
