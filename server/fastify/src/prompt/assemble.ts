import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { isDeepStrictEqual } from 'node:util'
import type {
  FastifyChat as Chat,
  FastifyCharacter as character,
  FastifyDatabase as Database,
  FastifyLoreBook as loreBook,
  FastifyMessage as Message,
  FastifyMessagePresetInfo as MessagePresetInfo,
} from './serverTypes.js'
import type { PromptItem } from './promptTemplate.js'
import type { CbsCallbackMemo } from './cbsCallbackMemo.js'
import type { ReportedClientContext } from '@risuai/protocol/client-context'
import type { BardWikiGlobalSettings } from '@risuai/protocol'
import type { PersistedGenerationScope } from '../generationScope.js'
import type { PromptMessage } from './promptMessage.js'
import { trimUntilPunctuation } from '@risuai/shared-core/punctuation'
import { hypaV3PresetIndexFromStableId } from '@risuai/shared-core/hypa-v3-preset-selection-identity'
import { EntityNotFoundError } from '../repository.js'
import {
  determineHypaV3SummarizedPrefixStartIndex,
  normalizeHypaV3Settings,
  planStandardHypaV3Memory,
  type HypaV3Settings,
  type HypaV3SummaryRef,
} from '../memoryPlanner.js'
import { emptyPromptMemoryQueryDiagnostics, type PromptMemoryQueryDiagnostics } from '../promptMemoryQuery.js'
import { planHypaV3ChunkJobs } from '../memoryChunkPlanner.js'
import {
  buildFormatOrder,
  createStableCardRenderCache,
  normalizeTemplate,
  renderFinalPrompt,
  type FormatOrderKey,
  type StableCardRenderCache,
  type UnformatedPromptSlots,
} from './templates.js'
import {
  buildAuthorNote,
  buildCotInstruction,
  buildDescription,
  buildInlayViewInstruction,
  buildPersona,
} from './staticSections.js'
import { buildPlainPromptSections } from './plainSections.js'
import {
  activateLorebook,
  activateLorebookAsync,
  buildLorebookContext,
  type LoreEntryActive,
  type LorebookActivationReport,
} from './lorebook.js'
import { preflightTemplateTokens } from './preflight.js'
import {
  applyDepthPrompts,
  buildHistoryWindow,
  NO_ASSETS,
  type AssetLookup,
  type EditProcessHook,
  type PreparedDepthPrompt,
  type PromptAssetDropDiagnostic,
} from './history.js'
import { buildAssetLookup, type ResolveStoredAsset } from './assetLookup.js'
import { buildPromptAssetTable, type PromptAssetTable } from './promptAssets.js'
import { buildMemoryWindow } from './memory.js'
import {
  assemblePromptMemoryRows,
  selectPromptMemory,
  type PromptMemoryAdapterDiagnostics,
  type PromptMemoryRowAssemblyDiagnostics,
} from './memoryAdapter.js'
import {
  emptyPromptMemoryFollowUpDiagnostics,
  enqueuePromptMemoryFollowUps,
  type PromptMemoryFollowUpDiagnostics,
} from './memoryFollowups.js'
import { finalizeRequestBudget } from './budgetFinalize.js'
import { runTrigger, type TriggerRunContext, type TriggerRunResult } from './triggers.js'
import { createTriggerVarEngine, type TriggerVarEngine } from './triggerVars.js'
import {
  createLuaExecBudget,
  runLuaEditTrigger,
  runServerLua,
  throwServerLuaFailure,
  type LuaExecBudget,
  type ServerLuaEditTriggerContext,
} from './luaRuntime.js'
import type { PostGenerationLuaTraceCollector } from './luaPostGenerationTrace.js'
import type { PostGenerationLuaProgressTracker } from './luaPostGenerationProgress.js'
import { processScriptAsync } from './scripts.js'
import { getActiveModules, getModuleTriggers } from './modules.js'
import { expandVariables, type ExpandContext } from './variables.js'
import { getChatDefaultVariables } from './chatVarDefaults.js'
import { modelInfoForPromptScope, type ServerCbsCallbackDiagnosticReason } from './promptScope.js'
import type { PromptEvent, WarningEvent } from './sseEvents.js'
import type { MemorySelectionInput } from '../memorySelectionService.js'
import {
  cleanupOrphanedMemoryWithSummarySnapshot,
  loadMemorySummarySnapshot,
  type CleanupOrphanedMemoryResult,
  type EnqueueMemoryJobInput,
  type MemoryJob,
  type MemorySummary,
  type MemorySummarySnapshot,
} from '../memoryRepository.js'
import { filterMemorySummariesForModel } from '../memorySummaryCompatibility.js'
import { tokenize, tokenizeChat } from './tokens.js'
import { buildBardWikiPromptRows, type BardWikiPromptDiagnostics } from './bardWiki.js'
import { BardWikiPinnedBudgetError } from './bardWikiSelection.js'
import { tokenizeHypaV3PrefixChat } from './prefixTokenMemo.js'
import { ensureTokenizerLoadedForDb, tokenizerOptionsFromDb } from './tokenizerConfig.js'
import { isRisuChatParserFixedPoint } from './parserFixedPoint.js'
import { bumpAssemblyCbsHistoryGeneration, createAssemblyCbsCallbackMemo } from './cbsCallbackMemo.js'
import { buildEffectiveGenerationConfig, cloneGenerationWorkingCharacter } from './effectiveGenerationConfig.js'
import { summarizePromptRows, type PromptRowsSummary } from './promptSummary.js'
import {
  AgentPresetGenerationError,
  assertAgentPresetLorebookInputsReady,
  agentPresetStepResultErrorMessage,
  executeAgentPresetPhase,
  executeAgentPresetStep,
  type AgentPresetGenerationErrorBody,
  type AgentPresetPhaseExecutionResult,
  type AgentPresetPhaseFailure,
  type AgentPresetPreviousOutput,
  type AgentPresetProgressReporter,
  type AgentPresetStepExecutionResult,
  type AgentPresetStepExecutor,
} from './agentPresetExecution.js'
import {
  resolveAgentPresetForChat,
  type AgentPresetExecutionPlan,
  type AgentPresetResolution,
} from '@risuai/shared-core/agent-preset-resolver'
import type { ResolvedModelProfile } from '@risuai/shared-core/model-profile-resolver'
import type { ReadonlyAgentPresetRecord as AgentPresetRecord } from '@risuai/shared-core/agent-preset-records'

/**
 * Root prompt assembly entry point.
 *
 * The assembler resolves the persisted database, selected character, and chat;
 * builds the template slots and expansion context; fills static/plain sections;
 * activates lorebooks; runs token preflight; builds history rows;
 * bridges history through memory; applies depth prompts and start-trigger
 * system prompts; renders the final prompt; and performs the final budget trim.
 * It returns either a dispatch-ready `AssembleResult` or a structured
 * `stopSending` result for trigger/budget aborts.
 */

/**
 * The explicit dependency surface the assembler loads state through. Routes
 * bind this to persisted storage; tests inject fixtures. Keeping it a seam
 * means the assembler never imports storage globals.
 */
export interface AssembleDeps {
  /** Optional offline diagnostics policy; production leaves this absent. */
  offlineReplay?: ExpandContext['offlineReplay']
  loadDatabase(): Database | null
  resolveSpeakerName?: (characterId: string) => string | undefined
  loadMemoryDatabase?(): DatabaseSync | null
  /** Recheck the accepted generation or compatibility tuple while the memory
   * database's write transaction is active. Production persisting routes bind
   * this after any asynchronous query-embedding preparation. */
  assertPromptMemoryMutationAuthorityInTransaction?: () => void
  /** Server asset root used by Lua image generation. */
  assetDataDir?: string
  loadPromptMemoryQueryVectors?(): MemorySelectionInput['queryVectors']
  loadPromptMemoryQueryDiagnostics?(): PromptMemoryQueryDiagnostics
  enqueuePromptMemoryFollowUpJob?: (job: EnqueueMemoryJobInput) => MemoryJob
  onPromptMemoryJobEnqueued?: (job: MemoryJob) => void
  executeAgentPresetStep?: AgentPresetStepExecutor
  /** Optional live progress reporter for Agent Preset helper steps. */
  agentPresetProgress?: AgentPresetProgressReporter
  recordAssemblyStageTiming?: (stage: PromptAssemblyStage, durationMs: number) => void
  /**
   * Resolve a stored-asset reference (sha256 id or `assets/<id>.<ext>` path) to
   * prompt multimodal bytes. The route binds this to the on-disk assets store;
   * absent, asset and inlay prompts drop their bytes.
   */
  resolveStoredAsset?: ResolveStoredAsset
  /**
   * Originating-request (or durable-job) abort signal, threaded into the Lua
   * runtime so a disconnect/cancel stops in-flight hook work.
   */
  signal?: AbortSignal
}

export type PromptAssemblyStage =
  | 'scope_resolution'
  | 'submit_transforms'
  | 'agent_preset_before_main'
  | 'static_plain_slots'
  | 'lorebook_preflight'
  | 'history_bias'
  | 'memory_bridge'
  | 'final_render'
  | 'budget'

export interface PromptMemoryChunkPlanningDiagnostics {
  attempted: boolean
  summarizedPrefixStartIndex: number
  summarizedPrefixTokens: number
  chunksCreated: number
  jobsCreated: number
  plannedWindows: number
  cleanup: CleanupOrphanedMemoryResult
  plannerWarnings: string[]
  plannerErrors: string[]
  errors: string[]
}

/**
 * Fully resolved, server-owned generation configuration captured atomically
 * when a durable operation is accepted. Chat history and Hypa data are loaded
 * from authoritative storage for each attempt; configuration stays frozen even
 * if settings are edited later. Older snapshots may still contain history.
 */
export interface AcceptedEffectiveGenerationConfiguration {
  version: 1
  database: Database
  /** Target identity for post-generation validation, without retaining history.
   * Undefined identifies older snapshots whose tail is still in database. */
  acceptedTranscriptTail?: Pick<Message, 'role' | 'chatId'> | null
  /** Supplemental translator settings include the separately persisted preset
   * collection, which is not part of generation assembly's normal projection. */
  translationSettings?: Record<string, unknown>
  promptInfo: MessagePresetInfo
  resolvedMainProfile: ResolvedModelProfile
  acceptedBardWikiSettings?: BardWikiGlobalSettings
  speakerNames?: Readonly<Record<string, string | undefined>>
}

export interface AssembleInput {
  chatId: string
  characterId: string
  loadoutId?: string
  mode: 'send' | 'continue' | 'preview' | 'preview_prompt' | 'regenerate'
  regenerateMessageId?: string
  userMessage?: string
  /** Durable identity of a protocol-v1 accepted user row already in the transcript. */
  acceptedMessageId?: string
  operationId?: string
  operationAttemptNo?: number
  generationScope?: PersistedGenerationScope
  acceptedEffectiveConfiguration?: AcceptedEffectiveGenerationConfiguration
  /** Compatibility-only identity rechecked at each inline persistence boundary. */
  compatibilityWriterSessionId?: string
  compatibilityDatabaseLineage?: string
  compatibilityOccupancyEpoch?: number
  /** Retry-only: the accepted row's submit-time input hooks already committed. */
  reuseAcceptedSubmitTransforms?: boolean
  /** Original-compatible send from an assistant tail without appending a user row. */
  emptySend?: boolean
  /** Client-created empty-send sentinel; skips only submit-time input hooks. */
  syntheticSayNothing?: boolean
  resetMessages?: boolean
  expectedRevision?: number
  /** Legacy compatibility only; Fastify inlay bytes should live in `/assets`. */
  inlayAssets?: unknown[]
  /** Legacy browser-local inlay id -> server asset id aliases. */
  inlayAssetRefs?: unknown[]
  /** Browser values reported by the client for server-owned CBS expansion. */
  clientContext?: ReportedClientContext
}

/** Server-derived persistence behavior for a Continue generation. */
export type ContinueDisposition = 'append' | 'extend'

export type AssembleMutationSource =
  | 'user_message'
  | 'regenerate'
  | 'run_var'
  | 'history_normalize'
  | 'history_inject'
  | 'start_trigger'
  | 'input_trigger'
  | 'editinput'
  | 'agent_preset'
  | 'output_trigger'

export type ChatVarMutationValue = string | number | boolean | null

export interface AssembleChatVarMutation {
  key: string
  before: ChatVarMutationValue
  after: ChatVarMutationValue
}

export type AssembleMessageMutation =
  | {
      type: 'append'
      source: 'user_message'
      index: number
      message: Message
    }
  | {
      type: 'replace_all'
      source: Exclude<AssembleMutationSource, 'user_message'>
      beforeLength: number
      afterLength: number
      messages: Message[]
    }
  | {
      type: 'replace_by_id'
      source: 'history_inject'
      messageId: string
      before: Message
      message: Message
    }

const MESSAGE_MUTATION_FIRST_CHANGED_INDEX = Symbol('messageMutationFirstChangedIndex')

type MessageMutationWithFirstChangedIndex = AssembleMessageMutation & {
  [MESSAGE_MUTATION_FIRST_CHANGED_INDEX]?: number
}

export interface AssemblyMessageFullTranscriptCloneCounts {
  initialMessages: number
  messageReplacement: number
  submitTranscript: number
  restoration: number
  postGenerationCheckpoint: number
}

export interface AssemblyMessageCaptureInstrumentation {
  fullTranscriptClones: AssemblyMessageFullTranscriptCloneCounts
  fullTranscriptStringifies: number
  rowStringifies: number
  messageReplacementComparisons: number
  messageReplacementCaptures: Partial<Record<Exclude<AssembleMutationSource, 'user_message'>, number>>
}

export interface AgentPresetRuntimeState {
  resolution: AgentPresetResolution
  plan?: AgentPresetExecutionPlan
  preset?: AgentPresetRecord
  beforeMain?: AgentPresetPhaseExecutionResult
  afterMain?: AgentPresetPhaseExecutionResult
  previousAgentOutputs: AgentPresetPreviousOutput[]
  promptOutputs: Record<string, string>
  outputRequired: Record<string, boolean>
  userInputModified?: boolean
  finalTextModified?: boolean
  finalOutputComposed?: boolean
  mainOutputText?: string
  failure?: AgentPresetPhaseFailure | AgentPresetFinalOutputFailure
}

interface AgentPresetFinalOutputFailure {
  phase: 'afterMain'
  message: string
  failureKind: 'final_output_cbs'
}

const assemblyMessageCaptureInstrumentation: AssemblyMessageCaptureInstrumentation = {
  fullTranscriptClones: {
    initialMessages: 0,
    messageReplacement: 0,
    submitTranscript: 0,
    restoration: 0,
    postGenerationCheckpoint: 0,
  },
  fullTranscriptStringifies: 0,
  rowStringifies: 0,
  messageReplacementComparisons: 0,
  messageReplacementCaptures: {},
}

export function resetAssemblyMessageCaptureInstrumentation(): void {
  assemblyMessageCaptureInstrumentation.fullTranscriptClones.initialMessages = 0
  assemblyMessageCaptureInstrumentation.fullTranscriptClones.messageReplacement = 0
  assemblyMessageCaptureInstrumentation.fullTranscriptClones.submitTranscript = 0
  assemblyMessageCaptureInstrumentation.fullTranscriptClones.restoration = 0
  assemblyMessageCaptureInstrumentation.fullTranscriptClones.postGenerationCheckpoint = 0
  assemblyMessageCaptureInstrumentation.fullTranscriptStringifies = 0
  assemblyMessageCaptureInstrumentation.rowStringifies = 0
  assemblyMessageCaptureInstrumentation.messageReplacementComparisons = 0
  assemblyMessageCaptureInstrumentation.messageReplacementCaptures = {}
}

export function getAssemblyMessageCaptureInstrumentation(): AssemblyMessageCaptureInstrumentation {
  return {
    fullTranscriptClones: { ...assemblyMessageCaptureInstrumentation.fullTranscriptClones },
    fullTranscriptStringifies: assemblyMessageCaptureInstrumentation.fullTranscriptStringifies,
    rowStringifies: assemblyMessageCaptureInstrumentation.rowStringifies,
    messageReplacementComparisons: assemblyMessageCaptureInstrumentation.messageReplacementComparisons,
    messageReplacementCaptures: {
      ...assemblyMessageCaptureInstrumentation.messageReplacementCaptures,
    },
  }
}

function recordFullTranscriptClone(reason: keyof AssemblyMessageFullTranscriptCloneCounts): void {
  assemblyMessageCaptureInstrumentation.fullTranscriptClones[reason]++
}

function recordMessageReplacementCapture(source: Exclude<AssembleMutationSource, 'user_message'>): void {
  assemblyMessageCaptureInstrumentation.messageReplacementCaptures[source] =
    (assemblyMessageCaptureInstrumentation.messageReplacementCaptures[source] ?? 0) + 1
}

export function getMessageMutationFirstChangedIndex(mutation: AssembleMessageMutation): number | undefined {
  return (mutation as MessageMutationWithFirstChangedIndex)[MESSAGE_MUTATION_FIRST_CHANGED_INDEX]
}

export interface AssembleAdditionalSystemPromptMutation {
  type: 'insert_prompt_row'
  source: 'additional_sys_prompt'
  origin: 'start' | 'historyend' | 'promptend'
  slot: 'lastChat' | 'postEverything'
  placement: 'push' | 'unshift'
  row: PromptMessage
}

export interface AssembleChatMetadataMutation {
  key: 'lastMemory'
  before: string | null
  after: string | null
}

export type AssembleCharacterFieldMutation = {
  key: 'name' | 'firstMessage' | 'backgroundHTML' | 'desc'
  before: string | null
  after: string
}

export interface AssembleLocalLoreMutation {
  before: loreBook[]
  after: loreBook[]
}

export interface AssembleMutationPayload {
  chatId: string
  characterId: string
  selectedCharID: number
  chatPage: number
  varChanged: boolean
  messageMutations: AssembleMessageMutation[]
  chatVarMutations: AssembleChatVarMutation[]
  chatMetadataMutations?: AssembleChatMetadataMutation[]
  characterFieldMutations?: AssembleCharacterFieldMutation[]
  localLoreMutation?: AssembleLocalLoreMutation
  additionalSystemPrompt: AssembleAdditionalSystemPromptMutation[]
}

export interface AssembleRestorationPayload {
  chatId: string
  characterId: string
  selectedCharID: number
  chatPage: number
  messages: Message[]
  scriptstate?: Record<string, string | number | boolean>
}

export type AssembleAbortReason =
  | 'trigger_stop'
  | 'history_context_overflow'
  | 'bardwiki_pinned_budget_exceeded'
  | 'overflow'

/**
 * The full assembler output. `prompt` is the `prompt` SSE event payload; the
 * remaining fields carry dispatch-only data. On an abort (`stopSending`) the
 * mutation contract still rides along so the route can persist chat-var writes
 * made before the abort.
 */
export interface AssembleResult {
  /** A start trigger or context-budget failure aborted the send. */
  stopSending: boolean
  /** Why the send aborted, when `stopSending` is true. */
  abortReason?: AssembleAbortReason
  /** The `prompt` SSE event payload (messages + promptInfo + lore report). */
  prompt?: Omit<PromptEvent, 'type'>
  /** The budgeted flat prompt (full `PromptMessage` rows) for dispatch. */
  formated?: PromptMessage[]
  /** Expanded global + character provider logit-bias rows. */
  biases?: [string, number][]
  /** Metadata-only deterministic summary/hash of the budgeted dispatch rows. */
  promptSummary?: PromptRowsSummary
  /** Final input token count from `finalizeRequestBudget`. */
  inputTokens?: number
  /** Reserved response budget from `finalizeRequestBudget`, clamped when pinned input requires it. */
  outputTokens?: number
  /** Non-fatal assembly diagnostics emitted through the existing warning SSE channel. */
  warnings?: Omit<WarningEvent, 'type'>[]
  /** Server-owned chat and variable mutations produced during assembly. */
  mutations?: AssembleMutationPayload
  /** Browser-visible state from before the server-owned mutations replay. */
  restoration?: AssembleRestorationPayload
  /**
   * Optional full transcript snapshot used when persistence cannot be expressed
   * as identity-addressed mutations alone. Route-only (not on the SSE wire).
   */
  submitMessages?: Message[]
  /**
   * True when a submit-time input transform or history `@@inject` rewrite made
   * the route responsible for transcript persistence, using either
   * {@link submitMessages} or the message mutation payload. Stays false for
   * plain prompt-local history regex transforms.
   */
  submitTranscriptChanged?: boolean
  /**
   * Internal assembler state, exposed **route-only** (never on the SSE wire) so
   * the route can run {@link runServerPostGeneration} over the
   * just-generated assistant text after provider dispatch — it reuses the same
   * chat clone, expansion context, var-engine coordinates, and persisted
   * scriptstate baseline assembly built. Present only on the dispatch-ready
   * success path (omitted for `stopSending`, which never dispatches).
   */
  state?: AssemblyState
}

/**
 * The internal assembler state threaded through the assembly steps.
 */
export interface AssemblyState {
  input: AssembleInput
  database: Database
  currentChar: character
  currentChat: Chat
  /** Older durable chat history was omitted by either context-budget pass. */
  historyTruncated?: boolean
  /** Prompt preset name and active toggle snapshot for the generated assistant row. */
  promptInfo: MessagePresetInfo
  /** Index into `database.characters`. */
  selectedCharID: number
  /** Index into `currentChar.chats`. */
  chatPage: number
  /** Reused by every downstream slot builder (`buildDescription`, …). */
  ctx: ExpandContext
  /** Per-assembly opt-in CBS callback memo for expensive history/lore callbacks. */
  cbsCallbackMemo: CbsCallbackMemo
  unformated: UnformatedPromptSlots
  promptTemplate: PromptItem[] | null
  usingPromptTemplate: boolean
  /** Per-assembly cache for template cards stable across token preflight and final render. */
  stableCardCache: StableCardRenderCache
  /**
   * Scriptstate surrounding the speculative stable-card preflight. Preflight
   * run-var writes are rolled back so the start trigger observes its baseline
   * input; an unchanged final render replays `after`, while an invalidated
   * render executes the cards once against the post-trigger state.
   */
  stableCardPreflightScriptstate?: {
    before: Record<string, string | number | boolean>
    after?: Record<string, string | number | boolean>
  }
  stableCardCacheInvalidated?: boolean
  formatOrder: FormatOrderKey[]
  /** `input.mode === 'continue'`; drives the `[Continue the last response]` marker. */
  isContinue: boolean
  /**
   * Compatibility policy derived from the effective `useSayNothing` setting.
   * `append` mirrors the original transient say-nothing turn; `extend` keeps
   * Fastify's explicit in-place continuation behavior.
   */
  continueDisposition: ContinueDisposition
  /** Identity of the non-persistent say-nothing row used by append-style Continue. */
  transientContinueBoundaryId?: string
  /** Abort signal from `AssembleDeps.signal`, handed to every Lua run. */
  signal?: AbortSignal
  /**
   * Aggregate Lua exec budget shared by every hook phase of this request
   * (input/output triggers, editinput/editRequest/editoutput), so
   * a card stacking runaway hooks cannot stall assembly indefinitely.
   */
  luaExecBudget?: LuaExecBudget
  /** Recorded identity only; live assembly config comes from chat.generationSettings. */
  modelPresetId?: string
  promptPresetId?: string
  loadoutId?: string
  activeModuleIds?: string[]
  resolvedMainProfile?: ResolvedModelProfile
  /** Unsupported trigger types observed anywhere in this generation. */
  unsupportedTriggerEffectTypes: Set<string>
  /** Types already surfaced through the warning SSE channel. */
  warnedUnsupportedTriggerEffectTypes: Set<string>
  /** Unavailable CBS callbacks observed anywhere in this generation. */
  cbsCallbackDiagnostics: Map<string, ServerCbsCallbackDiagnosticReason>
  /** CBS callback names already surfaced through the warning SSE channel. */
  warnedCbsCallbackNames: Set<string>
  // --- Lorebook placement + token preflight (set by `fillLorebookSlots`) ---
  /** The lorebook activation report (entries that fired + why). */
  report?: LorebookActivationReport
  /** `{{position::}}` resolver shared by the template / render walkers. */
  positionParser?: (text: string, loc: string | undefined) => string
  /** The base character-description row, retained across lorebook insertion. */
  descriptionBasePrompt?: PromptMessage
  /** Index of the base character-description row after lorebook placement. */
  descriptionBaseIndex?: number
  /** Depth-positioned lore the history splicer consumes. */
  depthPrompts?: LoreEntryActive[]
  /**
   * Depth prompt bodies expanded during history token preflight and reused
   * during the final post-memory splice.
   */
  preparedDepthPrompts?: PreparedDepthPrompt[]
  /** Running token estimate: `maxResponse + 50 + preflight.addedTokens`. */
  currentTokens?: number
  /** From `preflightTemplateTokens`: the template contains a `memory` card. */
  memoryCardUsed?: boolean
  /** From `preflightTemplateTokens`: the template contains a `cache` card. */
  hasCachePoint?: boolean
  // --- History window (set by `fillHistoryAndBias`) ---
  /**
   * The flattened history rows from `buildHistoryWindow`. Captured here only;
   * the memory window pushes them into `unformated.chats`.
   */
  historyMessages?: PromptMessage[]
  biases?: [string, number][]
  /**
   * The start-trigger result threaded out of the history walk. Later assembly
   * merges `triggerResult.additonalSysPrompt` into the slots; `null` when no
   * triggers ran.
   */
  triggerResult?: TriggerRunResult | null
  /**
   * The start trigger asked to abort the send. Mirrors the SPA's
   * `history.stopSending` early return in `assembleLocalSendChatPrompt`.
   */
  stopSending?: boolean
  /**
   * A run-var expansion or start-trigger `setvar` mutated chat state; the route
   * persists the database when true.
   */
  varChanged?: boolean
  // --- Memory bridge (set by `fillMemoryAndPostHistory`) ---
  /**
   * Memory-card rows split out of the history by the memory window and fed to
   * `renderFinalPrompt`.
   */
  memories?: PromptMessage[]
  promptMemoryChunkPlanningDiagnostics?: PromptMemoryChunkPlanningDiagnostics
  promptMemoryQueryDiagnostics?: PromptMemoryQueryDiagnostics
  promptMemorySelectionDiagnostics?: PromptMemoryAdapterDiagnostics
  promptMemoryRowAssemblyDiagnostics?: PromptMemoryRowAssemblyDiagnostics
  promptMemoryFollowUpDiagnostics?: PromptMemoryFollowUpDiagnostics
  bardWikiPromptDiagnostics?: BardWikiPromptDiagnostics
  bardWikiRows?: PromptMessage[]
  recordAssemblyStageTiming?: (stage: PromptAssemblyStage, durationMs: number) => void
  promptMemoryRows?: PromptMessage[]
  /** Stored-summary boundary applied only when the Hypa V3 prompt-memory path is enabled. */
  promptMemoryHistoryStartIndex?: number
  /** Token cost removed with `promptMemoryHistoryStartIndex`. */
  promptMemorySummarizedHistoryTokens?: number
  /** Agent Preset resolution, hidden step outputs, and diagnostics for this generation. */
  agentPreset?: AgentPresetRuntimeState
  // --- Final render + budget (set by `renderAndBudget`) ---
  /** The budgeted flat prompt for dispatch. */
  formated?: PromptMessage[]
  /** Metadata-only deterministic summary/hash of the budgeted dispatch rows. */
  promptSummary?: PromptRowsSummary
  /** Template-path prompt-info rows (`renderFinalPrompt.promptText`). */
  promptText?: PromptMessage[]
  /** Final input token count from `finalizeRequestBudget`. */
  inputTokens?: number
  /** Reserved response budget from `finalizeRequestBudget`, clamped when pinned input requires it. */
  outputTokens?: number
  /** Why the send aborted, when `stopSending` is true. */
  abortReason?: AssembleAbortReason
  // --- Typed mutation handoff (set while assembling) ---
  initialMessages?: Message[]
  /**
   * Authoritative submit-time transcript projection. Prompt-only transforms
   * (notably regenerate truncation and run-var expansion) never write here.
   * Route-owned submit transforms update rows in this snapshot by identity and
   * `captureSubmitTranscript()` persists from it rather than the working prompt.
   */
  authoritativeMessages?: Message[]
  messageMutationCheckpoint?: Message[]
  initialScriptstate?: Record<string, string | number | boolean>
  initialLastMemory?: string
  initialCharacterFields?: Record<AssembleCharacterFieldMutation['key'], string | null>
  initialLocalLore?: loreBook[]
  /** The submit-time input trigger rewrote the transcript. */
  inputTriggerRewroteTranscript?: boolean
  /** `editinput` transformed the submitted user message. */
  editInputTransformed?: boolean
  /** A before-main Agent Preset step replaced the latest user message. */
  agentPresetInputTransformed?: boolean
  /** A matched history `@@inject` rewrote one or more persistence-eligible rows. */
  historyInjectRewroteTranscript?: boolean
  /** An injected row did not exist at assembly start and needs full transcript persistence. */
  historyInjectRequiresTranscriptReplacement?: boolean
  /** Submit transcript snapshot used when a server-owned input transform changed it. */
  submitMessages?: Message[]
  messageMutations?: AssembleMessageMutation[]
  additionalSystemPromptMutations?: AssembleAdditionalSystemPromptMutation[]
  memoryDatabase?: DatabaseSync | null
  /** Server asset root used by Lua image generation. */
  assetDataDir?: string
  promptMemoryQueryVectors?: MemorySelectionInput['queryVectors']
  assertPromptMemoryMutationAuthorityInTransaction?: () => void
  enqueuePromptMemoryFollowUpJob?: (job: EnqueueMemoryJobInput) => MemoryJob
  onPromptMemoryJobEnqueued?: (job: MemoryJob) => void
  executeAgentPresetStep?: AgentPresetStepExecutor
  /**
   * The non-empty asset lookup the history walk resolves inlay / asset bytes
   * through. Built lazily for the history stage from the route's store resolver
   * plus optional legacy inlay id aliases; falls back to `NO_ASSETS` when unset.
   */
  assetLookup?: AssetLookup
  /** Char + module asset rows shared by `assetLookup` and the history walk. */
  promptAssetTable?: PromptAssetTable
  /** Prompt asset markers dropped because metadata or stored bytes were unavailable. */
  promptAssetDropDiagnostics?: PromptAssetDropDiagnostic[]
  resolveStoredAsset?: ResolveStoredAsset
}

/** The 10 canonical slot arrays, all empty. Shared by the assembler and tests. */
export function createEmptyUnformatedSlots(): UnformatedPromptSlots {
  return {
    main: [],
    jailbreak: [],
    chats: [],
    lorebook: [],
    globalNote: [],
    authorNote: [],
    lastChat: [],
    description: [],
    postEverything: [],
    personaPrompt: [],
  }
}

interface ResolvedScope {
  database: Database
  currentChar: character
  currentChat: Chat
  promptInfo: MessagePresetInfo
  resolvedMainProfile: ResolvedModelProfile
  selectedCharID: number
  chatPage: number
}

/**
 * Resolve the persisted database and the selected character / chat from
 * the request IDs. A missing database, or an explicit `characterId` /
 * `chatId` that matches nothing, is a hard `EntityNotFoundError`; the
 * active pointers (`database.currentChar`, `character.chatPage`) resolve
 * normally when an ID points at the active entity.
 */
function resolveScope(input: AssembleInput, deps: AssembleDeps): ResolvedScope {
  const database = deps.loadDatabase()
  if (!database) {
    throw new EntityNotFoundError('database not found')
  }

  const characters = database.characters
  const selectedCharID = characters.findIndex((c) => c.chaId === input.characterId)
  if (selectedCharID === -1) {
    throw new EntityNotFoundError(`character not found: ${input.characterId}`)
  }
  const currentChar = characters[selectedCharID]

  const chatPage = currentChar.chats.findIndex((ch) => ch.id === input.chatId)
  if (chatPage === -1) {
    throw new EntityNotFoundError(`chat not found: ${input.chatId}`)
  }
  const currentChat = currentChar.chats[chatPage]

  if (input.acceptedEffectiveConfiguration) {
    return {
      database,
      currentChar,
      currentChat,
      promptInfo: input.acceptedEffectiveConfiguration.promptInfo,
      resolvedMainProfile: input.acceptedEffectiveConfiguration.resolvedMainProfile,
      selectedCharID,
      chatPage,
    }
  }

  const effective = buildEffectiveGenerationConfig({
    database,
    currentChar,
    currentChat,
    selectedCharID,
    chatPage,
  })
  effective.currentChar.chatPage = chatPage

  return {
    database: effective.database,
    currentChar: effective.currentChar,
    currentChat: effective.currentChat,
    promptInfo: effective.promptInfo,
    resolvedMainProfile: effective.resolvedMainProfile,
    selectedCharID,
    chatPage,
  }
}

/**
 * Build the `AssemblyState`: resolve scope, construct the shared
 * `ExpandContext` + empty slots, and run the pure template helpers.
 */
export function beginAssembly(input: AssembleInput, deps: AssembleDeps): AssemblyState {
  const { database, currentChar, currentChat, promptInfo, resolvedMainProfile, selectedCharID, chatPage } =
    resolveScope(input, deps)

  const cbsCallbackMemo = createAssemblyCbsCallbackMemo()
  const luaExecBudget = createLuaExecBudget()
  const memoryDatabase = deps.loadMemoryDatabase?.() ?? null
  const unsupportedTriggerEffectTypes = new Set<string>()
  const cbsCallbackDiagnostics = new Map<string, ServerCbsCallbackDiagnosticReason>()
  const ctx: ExpandContext = {
    database,
    selectedCharID,
    chatPage,
    modelInfo: modelInfoForPromptScope(resolvedMainProfile),
    signal: deps.signal,
    resolveSpeakerName: deps.resolveSpeakerName,
    luaExecBudget,
    offlineReplay: deps.offlineReplay,
    ...(memoryDatabase ? { requestHistoryDb: memoryDatabase } : {}),
    ...(deps.assetDataDir ? { assetDataDir: deps.assetDataDir } : {}),
    allowGeneratedAssetWrites: input.generationScope?.admissionKind !== 'chat_only',
    cbsCallbackMemo,
    unsupportedTriggerEffectTypes,
    clientContext: input.clientContext,
    cbsCallbackDiagnostics,
  }
  const unformated = createEmptyUnformatedSlots()

  const { promptTemplate, usingPromptTemplate } = normalizeTemplate(database, currentChar, {
    chatPromptPresetId: currentChat.generationSettings?.promptPresetId,
  })
  const formatOrder = buildFormatOrder(database)
  const stableCardCache = createStableCardRenderCache()
  const initialMessages = cloneMessages(currentChat.message ?? [], 'initialMessages')
  const continueDisposition: ContinueDisposition =
    input.mode === 'continue' && (currentChar as { type?: string }).type !== 'group' && database.useSayNothing === true
      ? 'append'
      : 'extend'
  const transientContinueBoundaryId = continueDisposition === 'append' ? randomUUID() : undefined
  if (transientContinueBoundaryId) {
    ;(currentChat.message ??= []).push({
      role: 'user',
      data: '*says nothing*',
      chatId: transientContinueBoundaryId,
      name: database.username,
    } as Message)
    // This is an effective-database working copy, not durable storage. Keeping
    // it in sync makes CBS/Lua history reads see the same boundary the original
    // browser implementation exposed throughout prompt assembly.
    const effectiveChat = database.characters?.[selectedCharID]?.chats?.[chatPage]
    if (effectiveChat) effectiveChat.message = currentChat.message
  }
  const activeModuleIds = getActiveModules(database, currentChar, currentChat).map((module) => module.id)

  return {
    input,
    database,
    currentChar,
    currentChat,
    promptInfo,
    selectedCharID,
    chatPage,
    ctx,
    cbsCallbackMemo,
    unformated,
    promptTemplate,
    usingPromptTemplate,
    stableCardCache,
    formatOrder,
    signal: deps.signal,
    luaExecBudget,
    isContinue: input.mode === 'continue',
    continueDisposition,
    ...(transientContinueBoundaryId ? { transientContinueBoundaryId } : {}),
    modelPresetId: currentChat.generationSettings?.modelPresetId,
    promptPresetId: currentChat.generationSettings?.promptPresetId,
    loadoutId: input.loadoutId,
    activeModuleIds,
    resolvedMainProfile,
    unsupportedTriggerEffectTypes,
    warnedUnsupportedTriggerEffectTypes: new Set<string>(),
    cbsCallbackDiagnostics,
    warnedCbsCallbackNames: new Set<string>(),
    initialMessages,
    authoritativeMessages: structuredClone(initialMessages) as Message[],
    messageMutationCheckpoint: initialMessages,
    initialScriptstate: cloneScriptstate(currentChat.scriptstate),
    initialLastMemory: currentChat.lastMemory,
    initialCharacterFields: characterFieldSnapshot(currentChar),
    initialLocalLore: cloneLocalLore(currentChat.localLore),
    messageMutations: [],
    additionalSystemPromptMutations: [],
    memoryDatabase,
    assetDataDir: deps.assetDataDir,
    promptMemoryQueryVectors: deps.loadPromptMemoryQueryVectors?.() ?? [],
    promptMemoryQueryDiagnostics:
      deps.loadPromptMemoryQueryDiagnostics?.() ?? emptyPromptMemoryQueryDiagnostics(undefined, 'feature-disabled'),
    assertPromptMemoryMutationAuthorityInTransaction: deps.assertPromptMemoryMutationAuthorityInTransaction,
    enqueuePromptMemoryFollowUpJob: deps.enqueuePromptMemoryFollowUpJob,
    onPromptMemoryJobEnqueued: deps.onPromptMemoryJobEnqueued,
    resolveStoredAsset: deps.resolveStoredAsset,
    executeAgentPresetStep: deps.executeAgentPresetStep,
  }
}

function cloneMessages(
  messages: readonly Message[] | undefined,
  reason: keyof AssemblyMessageFullTranscriptCloneCounts,
): Message[] {
  recordFullTranscriptClone(reason)
  return structuredClone(messages ?? []) as Message[]
}

function cloneScriptstate(scriptstate: Chat['scriptstate'] | undefined): Record<string, string | number | boolean> {
  return structuredClone(scriptstate ?? {}) as Record<string, string | number | boolean>
}

function persistentMessageRows(state: AssemblyState): Message[] {
  const rows = state.currentChat.message ?? []
  const boundaryId = state.transientContinueBoundaryId
  return boundaryId ? rows.filter((message) => message.chatId !== boundaryId) : rows
}

function characterFieldValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function characterFieldSnapshot(value: character): Record<AssembleCharacterFieldMutation['key'], string | null> {
  return {
    name: characterFieldValue(value.name),
    firstMessage: characterFieldValue(value.firstMessage),
    backgroundHTML: characterFieldValue(value.backgroundHTML),
    desc: characterFieldValue(value.desc),
  }
}

function cloneLocalLore(localLore: Chat['localLore'] | undefined): loreBook[] {
  return structuredClone(localLore ?? []) as loreBook[]
}

function scriptstateEqual(
  a: Record<string, string | number | boolean>,
  b: Record<string, string | number | boolean>,
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (a[key] !== b[key]) return false
  }
  return true
}

function currentPersistedScriptstateSnapshot(state: AssemblyState): Record<string, string | number | boolean> {
  return cloneScriptstate(currentPersistedChat(state)?.scriptstate)
}

function persistedScriptstateChangedSince(
  state: AssemblyState,
  before: Record<string, string | number | boolean>,
): boolean {
  return !scriptstateEqual(before, currentPersistedScriptstateSnapshot(state))
}

function equalMessageRows(a: Message, b: Message): boolean {
  if (a === b) return true
  assemblyMessageCaptureInstrumentation.rowStringifies += 2
  return JSON.stringify(a) === JSON.stringify(b)
}

function firstChangedMessageIndex(before: readonly Message[], after: readonly Message[]): number | undefined {
  const shared = Math.min(before.length, after.length)
  let index = 0
  while (index < shared && equalMessageRows(before[index], after[index])) index++
  if (index === before.length && index === after.length) return undefined
  return index
}

function markFirstChangedIndex(mutation: AssembleMessageMutation, firstChangedIndex: number): AssembleMessageMutation {
  Object.defineProperty(mutation, MESSAGE_MUTATION_FIRST_CHANGED_INDEX, {
    value: firstChangedIndex,
    enumerable: false,
  })
  return mutation
}

function valueOrNull(value: string | number | boolean | undefined): ChatVarMutationValue {
  return value === undefined ? null : value
}

function currentPersistedChat(state: AssemblyState): Chat | undefined {
  return state.database.characters?.[state.selectedCharID]?.chats?.[state.chatPage]
}

function syncWorkingScriptstate(state: AssemblyState): void {
  const persisted = currentPersistedChat(state)
  if (persisted) {
    state.currentChat.scriptstate = persisted.scriptstate
  }
}

function replaceWorkingScriptstate(state: AssemblyState, scriptstate: Record<string, string | number | boolean>): void {
  const persisted = currentPersistedChat(state)
  if (!persisted) return
  if (Object.keys(scriptstate).length === 0) {
    delete persisted.scriptstate
  } else {
    persisted.scriptstate = structuredClone(scriptstate)
  }
  syncWorkingScriptstate(state)
}

function syncWorkingTranscript(state: AssemblyState): void {
  const persisted = currentPersistedChat(state)
  if (persisted) {
    persisted.message = state.currentChat.message ?? []
  }
  state.currentChar.chatPage = state.chatPage
}

function foldStableCardCacheVars(state: AssemblyState): void {
  if (!state.stableCardCache.dirty) return
  state.varChanged = true
  syncWorkingScriptstate(state)
}

function invalidateStableCardCache(state: AssemblyState): void {
  state.stableCardCache.clear()
  state.stableCardCacheInvalidated = true
}

function finishStableCardPreflight(state: AssemblyState, before: Record<string, string | number | boolean>): void {
  const after = currentPersistedScriptstateSnapshot(state)
  const changed = !scriptstateEqual(before, after)
  state.stableCardPreflightScriptstate = {
    before,
    ...(changed ? { after } : {}),
  }
  if (changed) {
    // The preflight is speculative. The final render either reuses its rows and
    // replays this exact result, or invalidates the rows and executes run-var CBS
    // once against the post-start-trigger state.
    replaceWorkingScriptstate(state, before)
  }
}

function prepareStableCardsForFinalRender(state: AssemblyState): void {
  const preflight = state.stableCardPreflightScriptstate
  if (!preflight) return

  if (!state.stableCardCacheInvalidated) {
    const live = currentPersistedScriptstateSnapshot(state)
    if (!scriptstateEqual(live, preflight.before)) {
      invalidateStableCardCache(state)
    }
  }

  if (!state.stableCardCacheInvalidated && preflight.after) {
    replaceWorkingScriptstate(state, preflight.after)
    state.varChanged = true
  }
}

function bumpHistoryCallbackMemo(state: Pick<AssemblyState, 'cbsCallbackMemo'>): void {
  bumpAssemblyCbsHistoryGeneration(state.cbsCallbackMemo)
}

function captureMessageReplacement(
  state: AssemblyState,
  source: Exclude<AssembleMutationSource, 'user_message'>,
): void {
  const before = state.messageMutationCheckpoint ?? []
  const afterRows = persistentMessageRows(state)
  assemblyMessageCaptureInstrumentation.messageReplacementComparisons++
  const firstChangedIndex = firstChangedMessageIndex(before, afterRows)
  if (firstChangedIndex === undefined) return

  const after = cloneMessages(afterRows, 'messageReplacement')

  state.messageMutations?.push(
    markFirstChangedIndex(
      {
        type: 'replace_all',
        source,
        beforeLength: before.length,
        afterLength: after.length,
        messages: after,
      },
      firstChangedIndex,
    ),
  )
  recordMessageReplacementCapture(source)
  state.messageMutationCheckpoint = after
  bumpHistoryCallbackMemo(state)
}

function setMessageMutationCheckpointRow(state: AssemblyState, index: number, message: Message): void {
  const checkpoint = state.messageMutationCheckpoint ?? []
  const next = checkpoint.slice()
  next[index] = message
  state.messageMutationCheckpoint = next
}

function replaceAuthoritativeTranscript(state: AssemblyState, messages: readonly Message[]): void {
  state.authoritativeMessages = structuredClone(messages) as Message[]
}

function upsertAuthoritativeMessage(state: AssemblyState, index: number, message: Message): void {
  const messages = (state.authoritativeMessages ??= structuredClone(state.initialMessages ?? []) as Message[])
  const messageId = message.chatId
  const existingIndex = messageId ? messages.findIndex((candidate) => candidate.chatId === messageId) : -1
  const next = structuredClone(message) as Message
  if (existingIndex >= 0) {
    messages[existingIndex] = next
    return
  }
  if (index >= messages.length) {
    messages.push(next)
    return
  }
  messages.splice(Math.max(0, index), 0, next)
}

function updateAuthoritativeMessageById(
  state: AssemblyState,
  messageId: string | undefined,
  update: (message: Message) => Message,
): void {
  if (!messageId) return
  const messages = (state.authoritativeMessages ??= structuredClone(state.initialMessages ?? []) as Message[])
  const index = messages.findIndex((message) => message.chatId === messageId)
  if (index < 0) return
  messages[index] = structuredClone(update(messages[index])) as Message
}

function appendUserMessageRow(state: AssemblyState): void {
  const userMessage = state.input.userMessage
  if (state.input.mode !== 'send' || typeof userMessage !== 'string') return

  const messages = (state.currentChat.message ??= [])
  const lastIndex = messages.length - 1
  const lastMessage = messages[lastIndex]
  const acceptedTailMatches =
    typeof state.input.acceptedMessageId === 'string' &&
    lastMessage?.role === 'user' &&
    lastMessage.chatId === state.input.acceptedMessageId
  if (acceptedTailMatches && state.input.reuseAcceptedSubmitTransforms === true) {
    syncWorkingTranscript(state)
    return
  }
  if (
    acceptedTailMatches ||
    (lastMessage?.role === 'user' && lastMessage.data === userMessage && (lastMessage.name ?? null) === null)
  ) {
    const message = {
      ...structuredClone(lastMessage),
      chatId: lastMessage.chatId ?? randomUUID(),
      time: lastMessage.time ?? Date.now(),
      name: null,
    } as Message
    messages[lastIndex] = message
    const checkpointMessage = structuredClone(message) as Message
    state.messageMutations?.push({
      type: 'append',
      source: 'user_message',
      index: lastIndex,
      message: checkpointMessage,
    })
    setMessageMutationCheckpointRow(state, lastIndex, checkpointMessage)
    upsertAuthoritativeMessage(state, lastIndex, checkpointMessage)
    syncWorkingTranscript(state)
    bumpHistoryCallbackMemo(state)
    return
  }

  const message = {
    role: 'user',
    data: userMessage,
    time: Date.now(),
    chatId: state.input.acceptedMessageId ?? randomUUID(),
    name: null,
  } as Message
  const index = messages.length
  messages.push(message)
  const checkpointMessage = structuredClone(message) as Message
  state.messageMutations?.push({
    type: 'append',
    source: 'user_message',
    index,
    message: checkpointMessage,
  })
  setMessageMutationCheckpointRow(state, index, checkpointMessage)
  upsertAuthoritativeMessage(state, index, checkpointMessage)
  syncWorkingTranscript(state)
  bumpHistoryCallbackMemo(state)
}

/**
 * Submit-time **input trigger**, ported from the browser chat-screen submit
 * handler. It runs over the transcript **without the new user message**, so when
 * the loaded transcript already ends with the new user text we exclude that last
 * row for the trigger run and let {@link appendUserMessageRow} re-add it.
 *
 * The trigger's `triggerlua` effects run on the server Lua VM via the injected
 * `runLua` seam ({@link runServerLua}, mode `'input'` → the Lua `onInput`),
 * `lowLevelAccess` inherited from the trigger. Var writes propagate through the
 * trigger's `createTriggerVarEngine` onto the db chat scriptstate, so the route's
 * chat-var delta picks them up exactly like a `'start'` trigger's.
 *
 * To preserve byte-parity for the overwhelming trigger-less case (every existing
 * fixture), the rewritten transcript is adopted **only when the trigger actually
 * changed it**; otherwise the loaded transcript is left untouched so
 * `appendUserMessageRow`'s dedup path is unchanged.
 */
async function runInputTrigger(state: AssemblyState): Promise<void> {
  if (state.input.mode !== 'send') return
  const { currentChar } = state
  const db = state.database

  const rawUserMessage = state.input.userMessage
  const messages = state.currentChat.message ?? []
  const lastIndex = messages.length - 1
  const lastMessage = messages[lastIndex]
  const lastIsNewUser =
    lastMessage?.role === 'user' &&
    ((typeof state.input.acceptedMessageId === 'string' && lastMessage.chatId === state.input.acceptedMessageId) ||
      (typeof rawUserMessage === 'string' &&
        lastMessage.data === rawUserMessage &&
        (lastMessage.name ?? null) === null))
  const priorMessages = lastIsNewUser ? messages.slice(0, lastIndex) : messages.slice()

  const triggerCtx: TriggerRunContext = {
    modules: getActiveModules(db, currentChar, state.currentChat),
    model: db.aiModel,
    database: db,
    selectedCharID: state.selectedCharID,
    chatPage: state.chatPage,
    signal: state.signal,
    unsupportedEffectTypes: state.unsupportedTriggerEffectTypes,
    clientContext: state.ctx.clientContext,
    cbsCallbackDiagnostics: state.cbsCallbackDiagnostics,
    runLua: async ({ code, mode, lowLevelAccess, chat, varEngine, source }) => {
      const result = await runServerLua(
        { code, mode, lowLevelAccess, source },
        {
          chat,
          database: db,
          selectedCharID: state.selectedCharID,
          chatPage: state.chatPage,
          varEngine,
          char: currentChar,
          model: db.aiModel,
          signal: state.signal,
          execBudget: state.luaExecBudget,
          ...(state.memoryDatabase ? { requestHistoryDb: state.memoryDatabase } : {}),
          ...(state.assetDataDir ? { assetDataDir: state.assetDataDir } : {}),
          allowGeneratedAssetWrites: state.ctx.allowGeneratedAssetWrites,
          offlineReplay: state.ctx.offlineReplay,
        },
      )
      throwServerLuaFailure(result, `Lua ${mode} trigger failed`)
      // The host fns mutate `chat` in place (its `.message` array is reassigned by
      // cutChat/setFullChat etc.), so the same reference carries the edits back.
      return { chat, stopSending: result.stopSending }
    },
  }

  const result = await runTrigger(triggerCtx, currentChar, 'input', {
    chat: { ...state.currentChat, message: priorMessages },
  })
  if (!result) return

  // Var writes already propagated to the db chat scriptstate; fold the flag so
  // the route persists the delta.
  state.varChanged = !!state.varChanged || result.varChanged
  syncWorkingScriptstate(state)
  if (result.aborted) return

  // Lore upserts replace the array on the shallow trigger chat, so carry that
  // durable field back independently of transcript bookkeeping.
  if (result.chat.localLore !== state.currentChat.localLore) {
    state.currentChat.localLore = result.chat.localLore
  }

  // Adopt the rewritten transcript only on a real change (parity-preserving for
  // trigger-less chars). The user message — excluded above — is re-added by
  // `appendUserMessageRow`, mirroring the browser's `cha.push(...)` after the
  // trigger.
  const rewritten = result.chat.message ?? []
  if (firstChangedMessageIndex(priorMessages, rewritten) !== undefined) {
    state.currentChat.message = rewritten
    replaceAuthoritativeTranscript(state, rewritten)
    state.inputTriggerRewroteTranscript = true
    syncWorkingTranscript(state)
    captureMessageReplacement(state, 'input_trigger')
  }
}

/**
 * Apply the declarative `request` trigger to the final provider rows. Request
 * mode is deliberately display-only and limited by the trigger runner's
 * request allowlist, matching the retained browser wrapper.
 */
export async function applyRequestTrigger(state: AssemblyState, rows: PromptMessage[]): Promise<PromptMessage[]> {
  const triggerCtx: TriggerRunContext = {
    modules: getActiveModules(state.database, state.currentChar, state.currentChat),
    model: state.database.aiModel,
    database: state.database,
    selectedCharID: state.selectedCharID,
    chatPage: state.chatPage,
    signal: state.signal,
    unsupportedEffectTypes: state.unsupportedTriggerEffectTypes,
    clientContext: state.ctx.clientContext,
    cbsCallbackDiagnostics: state.cbsCallbackDiagnostics,
  }
  try {
    const result = await runTrigger(triggerCtx, state.currentChar, 'request', {
      chat: state.currentChat,
      displayMode: true,
      displayData: JSON.stringify(rows),
    })
    if (!result || result.aborted || typeof result.displayData !== 'string') return rows
    const parsed = JSON.parse(result.displayData) as unknown
    return Array.isArray(parsed) ? (parsed as PromptMessage[]) : rows
  } catch {
    return rows
  }
}

/**
 * Submit-time **`editinput`** transform of the just-appended user message,
 * ported from the browser's `processScript(char, messageInput, 'editinput')`
 * (`DefaultChatScreen.svelte` → `scripts.ts`'s `processScriptFull`). Mirrors
 * `processScriptFull`'s order for the user text: the Lua `editInput` hook
 * (`runLuaEditTrigger(char,'editinput',…)`) → CBS expansion (the
 * `risuChatParser` at `scripts.ts`) → the regex `editinput` scripts
 * ({@link processScript}). Because Fastify owns the transform after appending
 * the submitted row, its actual message index is used for Lua metadata and CBS.
 *
 * The transform applies in place to the last (user) row that
 * `appendUserMessageRow` produced, whose `.data` is still the raw submitted text.
 * Lua var writes during the hook fold into the chat-var delta the same way the
 * `editRequest` hook's do. A no-op transform leaves the row (and the mutation
 * stream) untouched.
 */
async function applyEditInput(state: AssemblyState): Promise<void> {
  if (state.input.mode !== 'send') return
  const rawUserMessage = state.input.userMessage
  if (typeof rawUserMessage !== 'string') return

  const messages = state.currentChat.message ?? []
  const lastMessageIndex = messages.length - 1
  const lastMessage = messages[lastMessageIndex]
  // Only the freshly-submitted user row (still carrying the raw text) is edited.
  if (lastMessage?.role !== 'user' || (lastMessage.name ?? null) !== null || lastMessage.data !== rawUserMessage) {
    return
  }

  const { editCtx, varEngine } = buildLuaEditTriggerContext(state)
  let text = await runLuaEditTrigger(
    state.currentChar,
    'editinput',
    rawUserMessage,
    { index: lastMessageIndex },
    editCtx,
  )
  text = expandVariables(text, { ...state.ctx, chatID: lastMessageIndex, chara: state.currentChar }).text
  text = await processScriptAsync(
    state.ctx,
    state.currentChar,
    text,
    'editinput',
    {},
    lastMessageIndex,
    state.currentChat,
  )

  if (varEngine.varChanged) {
    state.varChanged = true
    syncWorkingScriptstate(state)
  }

  if (text === rawUserMessage) return
  lastMessage.data = text
  updateAuthoritativeMessageById(state, lastMessage.chatId, (message) => ({ ...message, data: text }))
  state.editInputTransformed = true
  syncWorkingTranscript(state)
  captureMessageReplacement(state, 'editinput')
}

function prepareRegenerateTranscript(state: AssemblyState): void {
  if (state.input.mode !== 'regenerate') return

  const regenerateMessageId = state.input.regenerateMessageId
  if (typeof regenerateMessageId !== 'string' || regenerateMessageId.length === 0) {
    throw new EntityNotFoundError('regenerate message not found')
  }

  const messages = (state.currentChat.message ??= [])
  const targetIndex = messages.findIndex((message) => message.chatId === regenerateMessageId)
  if (targetIndex === -1) {
    throw new EntityNotFoundError(`regenerate message not found: ${regenerateMessageId}`)
  }

  const target = messages[targetIndex]
  if (target.role === 'user') {
    throw new EntityNotFoundError(`regenerate target must be an assistant message: ${regenerateMessageId}`)
  }
  if (targetIndex !== messages.length - 1) {
    throw new EntityNotFoundError(`regenerate target must be the latest assistant message: ${regenerateMessageId}`)
  }

  const saying = target.saying
  let sayingQuota = 2
  while (messages.length > 0 && messages.at(-1)?.role !== 'user') {
    const last = messages.at(-1)
    if (last?.saying === saying) {
      sayingQuota -= 1
      if (sayingQuota === 0) {
        break
      }
    }
    messages.pop()
  }
  syncWorkingTranscript(state)
  captureMessageReplacement(state, 'regenerate')
}

export { isRisuChatParserFixedPoint as isRunVarParserFixedPoint } from './parserFixedPoint.js'

export function applyCurrentChatRunVars(
  state: AssemblyState,
  options: {
    captureMessageMutation?: boolean
    expandVariablesForRunVar?: typeof expandVariables
  } = {},
): void {
  const expandRunVar = options.expandVariablesForRunVar ?? expandVariables
  let beforeScriptstate: Record<string, string | number | boolean> | undefined
  let chatVarDirty = false
  let messageDirty = false
  const messages = (state.currentChat.message ??= [])
  // Invariant across the loop the expand context never varies per
  // row, so build it once instead of re-spreading per message.
  const expandCtx: ExpandContext = { ...state.ctx, chara: state.currentChar, runVar: true }
  for (const message of messages) {
    const original = message.data
    const text = message.data ?? ''
    if (isRisuChatParserFixedPoint(text)) {
      // Skip the O(length) parse for marker-free prose; keep the historical
      // `undefined -> ''` coercion the full pass performed.
      message.data = text
      messageDirty ||= original !== text
      continue
    }
    beforeScriptstate ??= currentPersistedScriptstateSnapshot(state)
    const result = expandRunVar(text, expandCtx)
    message.data = result.text
    messageDirty ||= original !== result.text
    chatVarDirty ||= result.dirty
  }
  if (chatVarDirty) {
    state.varChanged = true
    syncWorkingScriptstate(state)
    if (!messageDirty && beforeScriptstate && persistedScriptstateChangedSince(state, beforeScriptstate)) {
      bumpHistoryCallbackMemo(state)
    }
  }
  if (messageDirty) {
    if (options.captureMessageMutation === false) {
      bumpHistoryCallbackMemo(state)
    } else {
      captureMessageReplacement(state, 'run_var')
    }
  }
}

function buildChatVarMutations(state: AssemblyState): AssembleChatVarMutation[] {
  const before = state.initialScriptstate ?? {}
  const after = cloneScriptstate(currentPersistedChat(state)?.scriptstate)
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()
  return keys
    .filter((key) => before[key] !== after[key])
    .map((key) => ({
      key,
      before: valueOrNull(before[key]),
      after: valueOrNull(after[key]),
    }))
}

function buildChatMetadataMutations(state: AssemblyState): AssembleChatMetadataMutation[] {
  const before =
    typeof state.initialLastMemory === 'string' && state.initialLastMemory.length > 0 ? state.initialLastMemory : null
  const initialMessageIds = new Set(
    (state.initialMessages ?? [])
      .map((message) => message.chatId)
      .filter((messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0),
  )
  const candidate = state.currentChat.lastMemory
  const after = typeof candidate === 'string' && initialMessageIds.has(candidate) ? candidate : null
  return before === after ? [] : [{ key: 'lastMemory', before, after }]
}

function buildCharacterFieldMutations(state: AssemblyState): AssembleCharacterFieldMutation[] {
  const before = state.initialCharacterFields ?? characterFieldSnapshot(state.currentChar)
  const after = characterFieldSnapshot(state.currentChar)
  return (Object.keys(after) as AssembleCharacterFieldMutation['key'][]).flatMap((key) =>
    before[key] === after[key] || after[key] === null ? [] : [{ key, before: before[key], after: after[key] }],
  )
}

function buildLocalLoreMutation(state: AssemblyState): AssembleLocalLoreMutation | undefined {
  const before = state.initialLocalLore ?? []
  const after = cloneLocalLore(state.currentChat.localLore)
  return isDeepStrictEqual(before, after) ? undefined : { before: cloneLocalLore(before), after }
}

function buildMutationPayload(state: AssemblyState): AssembleMutationPayload {
  const chatMetadataMutations = buildChatMetadataMutations(state)
  const characterFieldMutations = buildCharacterFieldMutations(state)
  const localLoreMutation = buildLocalLoreMutation(state)
  return {
    chatId: state.input.chatId,
    characterId: state.input.characterId,
    selectedCharID: state.selectedCharID,
    chatPage: state.chatPage,
    varChanged: !!state.varChanged,
    messageMutations: state.messageMutations ?? [],
    chatVarMutations: buildChatVarMutations(state),
    ...(chatMetadataMutations.length > 0 ? { chatMetadataMutations } : {}),
    ...(characterFieldMutations.length > 0 ? { characterFieldMutations } : {}),
    ...(localLoreMutation ? { localLoreMutation } : {}),
    additionalSystemPrompt: state.additionalSystemPromptMutations ?? [],
  }
}

export function buildRestorationPayload(state: AssemblyState): AssembleRestorationPayload {
  const scriptstate = structuredClone(state.initialScriptstate ?? {})
  return {
    chatId: state.input.chatId,
    characterId: state.input.characterId,
    selectedCharID: state.selectedCharID,
    chatPage: state.chatPage,
    messages: state.initialMessages ?? [],
    scriptstate: Object.keys(scriptstate).length > 0 ? scriptstate : undefined,
  }
}

/**
 * Snapshot the submit-time transcript after a server-owned rewrite. The initial
 * capture happens after the input trigger + `editinput`; Agent Preset and
 * identity-addressed history `@@inject` mutations refresh it later.
 */
function submitTranscriptReplacementRequired(state: AssemblyState): boolean {
  return (
    !!state.inputTriggerRewroteTranscript ||
    !!state.editInputTransformed ||
    !!state.agentPresetInputTransformed ||
    !!state.historyInjectRequiresTranscriptReplacement
  )
}

function captureSubmitTranscript(state: AssemblyState): void {
  if (!submitTranscriptReplacementRequired(state)) return
  state.submitMessages = cloneMessages(state.authoritativeMessages ?? state.initialMessages ?? [], 'submitTranscript')
}

/**
 * The route owns the transcript write only when a submit hook, before-main
 * Agent Preset, or history `@@inject` changed it. Plain history regex transforms
 * remain prompt-local.
 */
function submitTranscriptChanged(state: AssemblyState): boolean {
  return (
    !!state.inputTriggerRewroteTranscript ||
    !!state.editInputTransformed ||
    !!state.agentPresetInputTransformed ||
    !!state.historyInjectRewroteTranscript
  )
}

/**
 * Fill the static/plain slots on the `AssemblyState`, mutating
 * `state.unformated` in place. Mirrors `assembleLocalSendChatPrompt`:
 *   - plain sections (`main` / `jailbreak` / `globalNote`) only on the
 *     non-utility, non-template path,
 *   - `authorNote`, the chain-of-thought into `postEverything`,
 *     `description`, `personaPrompt`, and the image-gen / emotion view
 *     instruction into `postEverything` always.
 *
 * Sync — every leaf is sync. `buildInlayViewInstruction` mirrors the SPA's
 * push at `sendChatPromptAssembly.ts` (after the chain-of-thought row, so
 * `postEverything` stays ordered `[cot, inlayView, …promptend]`).
 */
export function fillStaticSlots(state: AssemblyState): void {
  const { ctx, currentChar, currentChat, unformated, promptTemplate, usingPromptTemplate } = state

  if (!currentChar.utilityBot && !promptTemplate) {
    const sections = buildPlainPromptSections(ctx, currentChar)
    unformated.main.push(...sections.main)
    unformated.jailbreak.push(...sections.jailbreak)
    unformated.globalNote.push(...sections.globalNote)
  }

  unformated.authorNote.push(...buildAuthorNote(ctx, currentChat))
  unformated.postEverything.push(...buildCotInstruction(ctx, usingPromptTemplate))
  const descriptionRows = buildDescription(ctx, currentChar)
  state.descriptionBasePrompt = descriptionRows[0]
  unformated.description.push(...descriptionRows)
  unformated.personaPrompt.push(...buildPersona(ctx))
  unformated.postEverything.push(...buildInlayViewInstruction(currentChar))
}

export async function runAgentPresetBeforeMainStage(state: AssemblyState, deps: AssembleDeps): Promise<void> {
  const resolution = resolveAgentPresetForChat({
    database: {
      ...state.database,
      agentPresets: state.database.agentPresets ?? [],
      agents: state.database.agents ?? [],
      modelProfiles: state.database.modelProfiles ?? [],
    },
    currentCharacter: state.currentChar,
    currentChat: state.currentChat,
    generationSettings: state.currentChat.generationSettings,
    resolvedMainProfile: state.resolvedMainProfile,
  })
  const runtime = createAgentPresetRuntimeState(resolution)
  state.agentPreset = runtime
  syncAgentPresetExpansionContext(state)

  if (resolution.status === 'none' || resolution.status === 'disabled') return
  if (resolution.status !== 'ready') {
    throw agentPresetResolutionError(resolution)
  }

  runtime.preset = resolution.preset
  runtime.plan = resolution.plan
  runtime.outputRequired = beforeMainOutputRequiredByKey(resolution.plan)
  syncAgentPresetExpansionContext(state)

  assertAgentPresetLorebookInputsReady({
    steps: resolution.plan.stableSteps.map((planned) => planned.step),
    currentChar: state.currentChar,
    currentChat: state.currentChat,
    presetId: resolution.preset.id,
    presetName: resolution.preset.name,
  })

  const beforeMain = await executeAgentPresetPhase({
    database: state.database,
    ...(state.memoryDatabase ? { requestHistoryDb: state.memoryDatabase } : {}),
    currentChar: state.currentChar,
    currentChat: state.currentChat,
    currentUserMessage: latestUserMessage(state.currentChat),
    plan: resolution.plan.beforeMain,
    resolvedMainProfile: state.resolvedMainProfile,
    maxConcurrency: resolution.plan.maxConcurrency,
    signal: state.signal,
    executeStep: state.executeAgentPresetStep ?? deps.executeAgentPresetStep ?? executeAgentPresetStep,
    onProgress: (progress) =>
      deps.agentPresetProgress?.({
        chatId: state.currentChat.id ?? state.input.chatId,
        presetId: resolution.preset.id,
        presetName: resolution.preset.name,
        ...progress,
      }),
  })
  runtime.beforeMain = beforeMain
  runtime.previousAgentOutputs = beforeMain.previousAgentOutputs
  runtime.promptOutputs = promptOutputsFromBeforeMain(resolution.plan, beforeMain)
  syncAgentPresetExpansionContext(state)

  if (beforeMain.blockingFailure) {
    runtime.failure = beforeMain.blockingFailure
    throw agentPresetPhaseError(runtime, beforeMain.blockingFailure)
  }

  applyAgentPresetUserInputModifier(state, resolution.plan, beforeMain)
}

function createAgentPresetRuntimeState(resolution: AgentPresetResolution): AgentPresetRuntimeState {
  return {
    resolution,
    plan:
      resolution.status === 'ready' || resolution.status === 'model_not_ready' || resolution.status === 'incomplete'
        ? resolution.plan
        : undefined,
    preset:
      resolution.status === 'ready' ||
      resolution.status === 'disabled' ||
      resolution.status === 'invalid' ||
      resolution.status === 'incomplete' ||
      resolution.status === 'model_not_ready'
        ? resolution.preset
        : undefined,
    previousAgentOutputs: [],
    promptOutputs: {},
    outputRequired: {},
  }
}

function latestUserMessage(chat: Chat): string | undefined {
  const index = latestUserMessageIndex(chat)
  return index === -1 ? undefined : chat.message?.[index]?.data
}

function latestUserMessageIndex(chat: Chat): number {
  const messages = chat.message ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && typeof message.data === 'string') return index
  }
  return -1
}

function applyAgentPresetUserInputModifier(
  state: AssemblyState,
  plan: AgentPresetExecutionPlan,
  beforeMain: AgentPresetPhaseExecutionResult,
): void {
  if (!plan.userInputModifierStepId) return
  const modifier = beforeMain.stepResults.find(
    (result) => result.status === 'success' && result.stepId === plan.userInputModifierStepId,
  )
  if (modifier?.status !== 'success') return

  const index = latestUserMessageIndex(state.currentChat)
  if (index === -1) return
  const messages = (state.currentChat.message ??= [])
  const current = messages[index]
  if (!current || current.data === modifier.outputText) return

  messages[index] = { ...current, data: modifier.outputText }
  updateAuthoritativeMessageById(state, current.chatId, (message) => ({ ...message, data: modifier.outputText }))
  state.agentPresetInputTransformed = true
  if (state.agentPreset) state.agentPreset.userInputModified = true
  syncWorkingTranscript(state)
  captureMessageReplacement(state, 'agent_preset')
  captureSubmitTranscript(state)
}

function syncAgentPresetExpansionContext(state: AssemblyState): void {
  state.ctx.agentOutputs = state.agentPreset?.promptOutputs ?? {}
  state.ctx.agentOutputRequired = state.agentPreset?.outputRequired ?? {}
}

function beforeMainOutputRequiredByKey(plan: AgentPresetExecutionPlan): Record<string, boolean> {
  const required: Record<string, boolean> = {}
  for (const planned of plan.beforeMain.steps) {
    const step = planned.step
    if (step.destination !== 'promptOutput') continue
    required[step.outputKey] = step.failurePolicy.mode !== 'optional'
  }
  return required
}

function promptOutputsFromBeforeMain(
  plan: AgentPresetExecutionPlan,
  beforeMain: AgentPresetPhaseExecutionResult,
): Record<string, string> {
  const promptOutputStepIds = new Set(
    plan.beforeMain.steps
      .filter((planned) => planned.step.destination === 'promptOutput')
      .map((planned) => planned.step.id),
  )
  const outputs: Record<string, string> = {}
  for (const result of beforeMain.stepResults) {
    if (result.status !== 'success') continue
    if (!promptOutputStepIds.has(result.stepId)) continue
    outputs[result.outputKey] = result.outputText
  }
  return outputs
}

function agentPresetResolutionError(
  resolution: Exclude<AgentPresetResolution, { status: 'none' | 'disabled' | 'ready' }>,
): AgentPresetGenerationError {
  switch (resolution.status) {
    case 'missing':
      return new AgentPresetGenerationError(`Selected Agent Preset does not exist: ${resolution.selectedPresetId}`, {
        presetId: resolution.selectedPresetId,
        diagnostics: { status: resolution.status, summary: resolution.summary },
      })
    case 'invalid':
      return new AgentPresetGenerationError(`Selected Agent Preset is invalid: ${resolution.preset.name}`, {
        presetId: resolution.preset.id,
        presetName: resolution.preset.name,
        diagnostics: { status: resolution.status, issues: resolution.issues, summary: resolution.summary },
      })
    case 'incomplete':
      return new AgentPresetGenerationError(`Selected Agent Preset is incomplete: ${resolution.preset.name}`, {
        presetId: resolution.preset.id,
        presetName: resolution.preset.name,
        diagnostics: { status: resolution.status, issues: resolution.issues, summary: resolution.summary },
      })
    case 'model_not_ready':
      return new AgentPresetGenerationError(
        `Selected Agent Preset has a step model that is not ready: ${resolution.preset.name}`,
        {
          presetId: resolution.preset.id,
          presetName: resolution.preset.name,
          diagnostics: {
            status: resolution.status,
            modelReadiness: resolution.modelReadiness,
            summary: resolution.summary,
          },
        },
      )
  }
}

function agentPresetPhaseError(
  runtime: AgentPresetRuntimeState,
  failure: AgentPresetPhaseFailure,
): AgentPresetGenerationError {
  return new AgentPresetGenerationError(`Agent Preset step failed: ${failure.stepName}: ${failure.message}`, {
    presetId: runtime.preset?.id,
    presetName: runtime.preset?.name,
    phase: failure.phase,
    stepId: failure.stepId,
    stepName: failure.stepName,
    outputKey: failure.outputKey,
    failureKind: failure.failureKind,
    failurePolicyOutcome: failure.failurePolicyOutcome,
    diagnostics: buildAgentPresetGenerationDiagnostics(runtime),
  })
}

/**
 * Activate the lorebook, distribute the activated entries into the slots, build
 * the `positionParser` + `depthPrompts`, and run the
 * template-wide token preflight. Mirrors `assembleLocalSendChatPrompt`.
 *
 * Runs after `fillStaticSlots` so the `before_desc` / `after_desc`
 * placement sees the static description row and the preflight tokenizes
 * the now-full slots. Mutates the lorebook fields on `state`.
 */
function applyLorebookReport(
  state: AssemblyState,
  report: LorebookActivationReport,
  stickyChatVarDirty: boolean,
): void {
  const { ctx, currentChar, unformated, promptTemplate, usingPromptTemplate } = state
  const db = state.database
  if (stickyChatVarDirty) {
    state.varChanged = true
    syncWorkingScriptstate(state)
    bumpHistoryCallbackMemo(state)
  }

  const { positionParser, depthPrompts } = buildLorebookContext(ctx, currentChar, report, unformated)
  state.descriptionBaseIndex = state.descriptionBasePrompt
    ? unformated.description.indexOf(state.descriptionBasePrompt)
    : undefined

  // Match the SPA prompt assembly: seed with the max response budget plus a
  // small headroom for unexpected error overhead.
  let currentTokens = (db.maxResponse ?? 0) + 50
  const stableCardScriptstateBefore = currentPersistedScriptstateSnapshot(state)
  const preflight = preflightTemplateTokens({
    ctx,
    currentChar,
    unformated,
    promptTemplate,
    usingPromptTemplate,
    report,
    stableCardCache: state.stableCardCache,
    descriptionBaseIndex: state.descriptionBaseIndex,
  })
  currentTokens += preflight.addedTokens
  finishStableCardPreflight(state, stableCardScriptstateBefore)

  state.report = report
  state.positionParser = positionParser
  state.depthPrompts = depthPrompts
  state.currentTokens = currentTokens
  state.memoryCardUsed = preflight.memoryCardUsed
  state.hasCachePoint = preflight.hasCachePoint
}

export function fillLorebookSlots(state: AssemblyState): void {
  const { currentChar, currentChat } = state
  const db = state.database
  let stickyChatVarDirty = false

  const report = activateLorebook({
    database: db,
    currentChar,
    currentChat,
    cbsContext: state.ctx,
    resolveSpeakerName: state.ctx.resolveSpeakerName,
    writeChatVar: (key, value) => {
      const persisted = currentPersistedChat(state)
      if (!persisted) return
      persisted.scriptstate ??= {}
      const stateKey = '$' + key
      if (persisted.scriptstate[stateKey] === value) return
      persisted.scriptstate[stateKey] = value
      stickyChatVarDirty = true
    },
  })

  applyLorebookReport(state, report, stickyChatVarDirty)
}

export async function fillLorebookSlotsAsync(state: AssemblyState): Promise<void> {
  await ensureTokenizerLoadedForDb(state.database)
  const { currentChar, currentChat } = state
  const db = state.database
  let stickyChatVarDirty = false

  const report = await activateLorebookAsync({
    database: db,
    currentChar,
    currentChat,
    cbsContext: state.ctx,
    resolveSpeakerName: state.ctx.resolveSpeakerName,
    writeChatVar: (key, value) => {
      const persisted = currentPersistedChat(state)
      if (!persisted) return
      persisted.scriptstate ??= {}
      const stateKey = '$' + key
      if (persisted.scriptstate[stateKey] === value) return
      persisted.scriptstate[stateKey] = value
      stickyChatVarDirty = true
    },
  })

  applyLorebookReport(state, report, stickyChatVarDirty)
}

/**
 * Run the async history window,
 * mutating `state` in place. Mirrors `assembleLocalSendChatPrompt`'s history
 * and related history-side effects. Runs after `fillLorebookSlots` so `state.report`
 * feeds the depth-prompt token preflight inside `buildHistoryWindow`.
 *
 * The start trigger inside `buildHistoryWindow` may mutate the chat, so
 * its results (`currentChat` / `triggerResult` / `varChanged`) are
 * threaded back regardless of outcome — the route persists when
 * `varChanged` is true. On `stopSending` the function short-circuits
 * (matching the SPA's `sendChatPromptAssembly` early return): the history rows
 * are incomplete, so they are not captured.
 *
 * Boundary: the history rows are only captured on `state.historyMessages` here.
 * The memory window pushes them into `unformated.chats`
 * (`buildMemoryWindow`, coordinated by `assembleLocalSendChatPrompt`). Inlay/asset bytes resolve
 * through `state.assetLookup`, falling back to `NO_ASSETS` only when no resolver
 * is bound.
 */
export async function fillHistoryAndBias(state: AssemblyState): Promise<void> {
  const { ctx, currentChar, usingPromptTemplate } = state
  const db = state.database
  const promptAssetTable =
    state.promptAssetTable ??
    state.assetLookup?.assetTable ??
    buildPromptAssetTable({
      database: db,
      currentChar,
      currentChat: state.currentChat,
    })
  state.promptAssetTable = promptAssetTable
  state.assetLookup ??= buildAssetLookup({
    database: db,
    currentChar,
    currentChat: state.currentChat,
    inlayAssets: state.input.inlayAssets,
    inlayAssetRefs: state.input.inlayAssetRefs,
    resolveStoredAsset: state.resolveStoredAsset,
    assetTable: promptAssetTable,
  })

  // Lua `editprocess` is currently a browser no-op; this hook stays identity
  // while preserving the same call position before regex `processScript`.
  const { editCtx } = buildLuaEditTriggerContext(state)
  const editProcess: EditProcessHook = (content, index) =>
    runLuaEditTrigger(state.currentChar, 'editprocess', content, { index }, editCtx)

  const history = await buildHistoryWindow(
    ctx,
    currentChar,
    state.currentChat,
    usingPromptTemplate,
    state.assetLookup ?? NO_ASSETS,
    state.report,
    editProcess,
    promptAssetTable,
  )

  // The start trigger may have mutated the chat and chat-vars even when
  // it asks to abort, so thread these out before the `stopSending` gate.
  state.currentChat = history.currentChat
  syncWorkingTranscript(state)
  state.triggerResult = history.triggerResult
  state.varChanged = !!state.varChanged || history.varChanged
  syncWorkingScriptstate(state)

  if (history.triggerResult) {
    // A start trigger can change chat rows, scriptstate, or request-local
    // character state. Conservatively discard the pre-trigger stable rows.
    invalidateStableCardCache(state)
  }

  if (history.stopSending === true) {
    state.stopSending = true
    state.abortReason = 'trigger_stop'
    captureMessageReplacement(state, 'start_trigger')
    return
  }
  state.stopSending = false

  state.currentTokens = (state.currentTokens ?? 0) + history.addedTokens
  state.historyMessages = history.messages
  state.preparedDepthPrompts = history.preparedDepthPrompts
  state.promptAssetDropDiagnostics = history.assetDiagnostics
  const globalBias = Array.isArray(state.database.bias) ? state.database.bias : []
  const characterBias = Array.isArray(currentChar.bias) ? currentChar.bias : []
  state.biases = [...globalBias, ...characterBias].flatMap((row) => {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'number') return []
    const source = row[0].replaceAll('\\n', '\n').replaceAll('\\r', '\r').replaceAll('\\\\', '\\')
    return [[expandVariables(source, { ...state.ctx, chara: currentChar }).text, row[1]] as [string, number]]
  })
  if (history.triggerResult) {
    captureMessageReplacement(state, 'start_trigger')
  }
  if (history.injectMutations.length > 0) {
    const persistentInjectMutations = history.injectMutations.filter(
      (mutation) => mutation.messageId !== state.transientContinueBoundaryId,
    )
    state.historyInjectRewroteTranscript = persistentInjectMutations.length > 0
    for (const mutation of persistentInjectMutations) {
      const initial = state.initialMessages?.find((message) => message.chatId === mutation.messageId)
      if (!initial) state.historyInjectRequiresTranscriptReplacement = true
      state.messageMutations?.push({
        type: 'replace_by_id',
        source: 'history_inject',
        messageId: mutation.messageId,
        before: initial ? (structuredClone(initial) as Message) : mutation.before,
        message: mutation.after,
      })
      updateAuthoritativeMessageById(state, mutation.messageId, () => mutation.after)
    }
    if (persistentInjectMutations.length > 0) {
      captureSubmitTranscript(state)
      bumpHistoryCallbackMemo(state)
      invalidateStableCardCache(state)
    }
  }
}

/**
 * Bridge the captured history into `unformated.chats` through the
 * non-Hypa memory window, then apply the post-history slot mutations.
 * Mirrors `assembleLocalSendChatPrompt`:
 *   - `buildMemoryWindow` (memory.ts) trims the oldest rows under
 *     `db.maxContext`, promotes the trailing chat to `lastChat` (no
 *     template), splits memory cards into `state.memories`, and marks the
 *     rest `removable`; `stopSending` short-circuits the rest;
 *   - `applyDepthPrompts` splices the lorebook depth prompts into
 *     `unformated.chats`;
 *   - the start trigger's `additonalSysPrompt` is placed into
 *     `postEverything` / `lastChat`.
 *
 * Sync — the non-Hypa window and every post-history mutation are sync. Runs
 * after `fillHistoryAndBias`, so a prior `stopSending` short-circuits.
 */
export function fillMemoryAndPostHistory(state: AssemblyState): void {
  if (state.stopSending) return

  const { ctx, currentChar, unformated } = state
  const db = state.database
  let bardWikiRows: PromptMessage[] = []
  let hypaTokenBudget: number | null = null
  if (state.memoryDatabase) {
    try {
      const bardWiki = buildBardWikiPromptRows({
        db: state.memoryDatabase,
        database: state.database,
        querySource: {
          chatId: state.input.chatId,
          characterId: state.input.characterId,
          mode: state.input.mode,
          regenerateMessageId: state.input.regenerateMessageId,
          userMessage: state.input.userMessage,
        },
      })
      bardWikiRows = bardWiki.rows
      hypaTokenBudget = bardWiki.budgets.hypaTokenBudget
      state.bardWikiPromptDiagnostics = bardWiki.diagnostics
      state.bardWikiRows = bardWiki.rows
    } catch (error) {
      if (!(error instanceof BardWikiPinnedBudgetError)) throw error
      state.stopSending = true
      state.abortReason = 'bardwiki_pinned_budget_exceeded'
      state.inputTokens = error.requiredTokens
      return
    }
  }
  const promptMemoryRows = buildPromptMemoryRowsForAssembly(state, hypaTokenBudget)
  const historyStartIndex = state.promptMemoryHistoryStartIndex ?? 0
  const promptHistory = (state.historyMessages ?? []).slice(historyStartIndex)
  const currentTokens =
    (state.currentTokens ?? 0) -
    (state.promptMemorySummarizedHistoryTokens ?? 0) +
    (state.bardWikiPromptDiagnostics?.consumedTokens ?? 0)
  state.currentTokens = currentTokens

  const mem = buildMemoryWindow({
    chats: [...bardWikiRows, ...promptMemoryRows, ...promptHistory],
    currentTokens,
    maxContextTokens: db.maxContext ?? 0,
    currentChat: state.currentChat,
    memoryCardUsed: !!state.memoryCardUsed,
    promptTemplate: state.promptTemplate,
    unformated,
    db,
  })

  if (mem.stopSending === true) {
    state.stopSending = true
    state.abortReason = mem.reason
    state.inputTokens = state.currentTokens
    return
  }

  state.currentChat = mem.currentChat
  state.historyTruncated = state.historyTruncated === true || mem.historyTruncated === true
  syncWorkingTranscript(state)
  state.memories = mem.memories
  // The SPA root re-tokenizes the rendered prompt, but the post-trim estimate is
  // the honest value for `info` telemetry, so keep it on the state.
  state.currentTokens = mem.currentTokens

  // SPA lorebook depth-prompt splice. `applyDepthPrompts`
  // already resolves `{{position::}}` + expands + applies the
  // depth/reverse_depth index math (excluding `depth === 0`, which the
  // template/postEverything path owns).
  if (state.report) {
    applyDepthPrompts(unformated.chats, ctx, currentChar, state.report, state.preparedDepthPrompts)
  }

  // SPA start-trigger `additonalSysPrompt` placement.
  const triggerResult = state.triggerResult
  if (triggerResult) {
    const sys = triggerResult.additonalSysPrompt
    if (sys.promptend) {
      const row: PromptMessage = { role: 'system', content: sys.promptend }
      unformated.postEverything.push(row)
      state.additionalSystemPromptMutations?.push({
        type: 'insert_prompt_row',
        source: 'additional_sys_prompt',
        origin: 'promptend',
        slot: 'postEverything',
        placement: 'push',
        row: structuredClone(row),
      })
    }
    if (sys.historyend) {
      const row: PromptMessage = { role: 'system', content: sys.historyend }
      unformated.lastChat.push(row)
      state.additionalSystemPromptMutations?.push({
        type: 'insert_prompt_row',
        source: 'additional_sys_prompt',
        origin: 'historyend',
        slot: 'lastChat',
        placement: 'push',
        row: structuredClone(row),
      })
    }
    if (sys.start) {
      const row: PromptMessage = { role: 'system', content: sys.start }
      unformated.lastChat.unshift(row)
      state.additionalSystemPromptMutations?.push({
        type: 'insert_prompt_row',
        source: 'additional_sys_prompt',
        origin: 'start',
        slot: 'lastChat',
        placement: 'unshift',
        row: structuredClone(row),
      })
    }
  }
}

function buildPromptMemoryRowsForAssembly(state: AssemblyState, hypaTokenBudget: number | null): PromptMessage[] {
  const memoryDb = state.memoryDatabase
  if (!memoryDb) {
    state.promptMemoryRows = []
    state.promptMemoryHistoryStartIndex = 0
    state.promptMemorySummarizedHistoryTokens = 0
    state.promptMemoryChunkPlanningDiagnostics = emptyPromptMemoryChunkPlanningDiagnostics()
    state.promptMemoryFollowUpDiagnostics = emptyPromptMemoryFollowUpDiagnostics()
    return []
  }
  const enabled = shouldSelectPromptMemory(state, hypaTokenBudget)
  const { settings } = normalizeHypaV3Settings(
    resolveHypaV3PresetSettings(state.database) as Partial<HypaV3Settings> | null | undefined,
  )
  const chatId = state.currentChat.id ?? state.input.chatId
  const embeddingModel = resolvePromptMemoryEmbeddingModel(state.database)
  const memoryPreparationReadOnly = state.input.mode === 'preview' || state.input.mode === 'preview_prompt'
  const prepare = (onJobCreated: ((job: MemoryJob) => void) | undefined): PromptMessage[] => {
    const planning = planPromptMemoryChunksForAssembly({
      state,
      memoryDb,
      chatId,
      enabled,
      settings,
      memoryPreparationReadOnly,
      onJobCreated,
    })
    state.promptMemoryChunkPlanningDiagnostics = planning.diagnostics
    state.promptMemoryHistoryStartIndex = planning.summarizedPrefixStartIndex
    state.promptMemorySummarizedHistoryTokens = planning.summarizedPrefixTokens
    const selection = selectPromptMemory({
      db: memoryDb,
      enabled,
      chatId,
      summaryModel: settings.summarizationModel,
      embeddingModel,
      queryVectors: state.promptMemoryQueryVectors ?? [],
      availableTokens: clampHypaTokenBudget(
        Math.floor((state.database.maxContext ?? 0) * settings.memoryTokensRatio),
        hypaTokenBudget,
      ),
      settings: {
        recentMemoryRatio: settings.recentMemoryRatio,
        similarMemoryRatio: settings.similarMemoryRatio,
      },
      summarySnapshot: planning.summarySnapshot,
      getSummaryTokenCost: createPromptMemorySummaryTokenCost(state.database),
    })
    selection.diagnostics.hotPathWork.generatedQueryEmbeddings =
      state.promptMemoryQueryDiagnostics?.status === 'success' && state.promptMemoryQueryDiagnostics.vectors > 0
    selection.diagnostics.hotPathWork.calledProviders =
      state.promptMemoryQueryDiagnostics?.providerCallAttempted ?? false
    state.promptMemorySelectionDiagnostics = selection.diagnostics

    const assembled = assemblePromptMemoryRows(selection)
    state.promptMemoryRowAssemblyDiagnostics = assembled.diagnostics
    state.promptMemoryFollowUpDiagnostics = memoryPreparationReadOnly
      ? emptyPromptMemoryFollowUpDiagnostics()
      : enqueuePromptMemoryFollowUps({
          db: memoryDb,
          chatId,
          summaryModel: settings.summarizationModel,
          embeddingModel,
          diagnostics: selection.diagnostics.missingMemory,
          operationId: state.input.operationId,
          operationAttemptNo: state.input.operationAttemptNo,
          generationScope: state.input.generationScope,
          enqueueJob: state.enqueuePromptMemoryFollowUpJob,
          onJobCreated,
        })
    state.promptMemoryRows = assembled.rows
    return assembled.rows
  }

  const assertAuthority = state.assertPromptMemoryMutationAuthorityInTransaction
  if (memoryPreparationReadOnly || !enabled || !assertAuthority) {
    return prepare(state.onPromptMemoryJobEnqueued)
  }

  const createdJobs: MemoryJob[] = []
  const ownsTransaction = !memoryDb.isTransaction
  if (ownsTransaction) memoryDb.exec('BEGIN IMMEDIATE')
  try {
    // Query embeddings are asynchronous and deliberately happen before this
    // point. Revalidate the original operation/compatibility identity only
    // after acquiring the write lock, then publish every Hypa mutation under
    // that same transaction so a claim cannot interleave partway through.
    assertAuthority()
    const rows = prepare((job) => createdJobs.push(job))
    if (ownsTransaction) memoryDb.exec('COMMIT')
    for (const job of createdJobs) state.onPromptMemoryJobEnqueued?.(job)
    return rows
  } catch (error) {
    if (ownsTransaction && memoryDb.isTransaction) memoryDb.exec('ROLLBACK')
    throw error
  }
}

function createPromptMemorySummaryTokenCost(db: Database): (summary: MemorySummary) => number {
  const { encoding } = tokenizerOptionsFromDb(db)
  const fallbackTokenCache = new Map<string, number>()

  return (summary) => {
    if (Number.isFinite(summary.tokens) && summary.tokens > 0) {
      return summary.tokens
    }
    const cached = fallbackTokenCache.get(summary.id)
    if (cached !== undefined) return cached
    const tokens = tokenize(summary.text, encoding)
    fallbackTokenCache.set(summary.id, tokens)
    return tokens
  }
}

function planPromptMemoryChunksForAssembly(input: {
  state: AssemblyState
  memoryDb: DatabaseSync
  chatId: string
  enabled: boolean
  settings: ReturnType<typeof normalizeHypaV3Settings>['settings']
  memoryPreparationReadOnly: boolean
  onJobCreated?: (job: MemoryJob) => void
}): {
  diagnostics: PromptMemoryChunkPlanningDiagnostics
  summarySnapshot?: MemorySummarySnapshot
  summarizedPrefixStartIndex: number
  summarizedPrefixTokens: number
} {
  const diagnostics = emptyPromptMemoryChunkPlanningDiagnostics()
  if (!input.enabled) {
    return { diagnostics, summarizedPrefixStartIndex: 0, summarizedPrefixTokens: 0 }
  }

  diagnostics.attempted = true
  let summarySnapshot: MemorySummarySnapshot | undefined
  let summarizedPrefixStartIndex = 0
  let summarizedPrefixTokens = 0
  try {
    const chats = input.state.historyMessages ?? []
    const currentChatMemos = chats.map((chat) => chat.memo).filter(isNonEmptyString)
    summarySnapshot = loadMemorySummarySnapshot(input.memoryDb, { chatId: input.chatId })
    if (!input.settings.preserveOrphanedMemory && currentChatMemos.length > 0) {
      const cleaned = input.memoryPreparationReadOnly
        ? previewOrphanedMemoryCleanupSnapshot(summarySnapshot, currentChatMemos)
        : cleanupOrphanedMemoryWithSummarySnapshot(input.memoryDb, {
            chatId: input.chatId,
            currentChatMemos,
            preserveOrphanedMemory: input.settings.preserveOrphanedMemory,
            summarySnapshot,
          })
      diagnostics.cleanup = cleaned.cleanup
      summarySnapshot = cleaned.summarySnapshot
    }

    const summaries = filterMemorySummariesForModel(summarySnapshot.summaries, input.settings.summarizationModel)
    summarizedPrefixStartIndex = determineHypaV3SummarizedPrefixStartIndex(chats, summaries.map(summaryToHypaV3Ref))
    const { encoding, options } = tokenizerOptionsFromDb(input.state.database)
    const plan = planStandardHypaV3Memory({
      chats,
      currentTokens: input.state.currentTokens ?? 0,
      maxContextTokens: input.state.database.maxContext ?? 0,
      maxResponseTokens: input.state.database.maxResponse ?? 0,
      settings: input.settings,
      summaries: summaries.map(summaryToHypaV3Ref),
      tokenizeChat: (chat) => tokenizeChat(chat, encoding, options),
      tokenizeSummarizedPrefixChat: (chat) => tokenizeHypaV3PrefixChat(chat, encoding, options),
    })
    summarizedPrefixTokens = -(plan.tokenDeltas.find((delta) => delta.kind === 'summarized_history')?.amount ?? 0)
    diagnostics.summarizedPrefixStartIndex = summarizedPrefixStartIndex
    diagnostics.summarizedPrefixTokens = summarizedPrefixTokens
    diagnostics.plannerWarnings.push(...plan.warnings.map((warning) => warning.message))
    diagnostics.plannerErrors.push(...plan.errors.map((error) => error.message))

    if (input.memoryPreparationReadOnly) {
      diagnostics.plannedWindows = plan.plannedWindows.length
    } else {
      const planned = planHypaV3ChunkJobs({
        db: input.memoryDb,
        chatId: input.chatId,
        chats,
        plan,
        model: input.settings.summarizationModel,
        operationId: input.state.input.operationId,
        operationAttemptNo: input.state.input.operationAttemptNo,
        generationScope: input.state.input.generationScope,
        onJobCreated: input.onJobCreated,
      })
      diagnostics.plannedWindows = planned.planned.length
      diagnostics.chunksCreated = planned.chunksCreated
      diagnostics.jobsCreated = planned.jobsCreated
    }
  } catch (error) {
    diagnostics.errors.push(errorMessage(error, 'failed to plan Hypa V3 memory chunks'))
  }
  return { diagnostics, summarySnapshot, summarizedPrefixStartIndex, summarizedPrefixTokens }
}

function previewOrphanedMemoryCleanupSnapshot(
  summarySnapshot: MemorySummarySnapshot,
  currentChatMemos: readonly string[],
): { cleanup: CleanupOrphanedMemoryResult; summarySnapshot: MemorySummarySnapshot } {
  const currentMemoSet = new Set(currentChatMemos)
  const orphanedSummaries = summarySnapshot.summaries.filter((summary) => {
    const chatMemos = readSummaryChatMemos(summary)
    return chatMemos !== null && chatMemos.some((memo) => !currentMemoSet.has(memo))
  })
  const deletedSummaryIds = new Set(orphanedSummaries.map((summary) => summary.id))
  const deletedChunkIds = new Set(orphanedSummaries.map((summary) => summary.chunkId))
  return {
    cleanup: {
      // Preview assembly only filters its in-memory view. Keep the mutation
      // diagnostics truthful: no persisted cleanup was published.
      summariesDeleted: 0,
      chunksDeleted: 0,
    },
    summarySnapshot: {
      chatId: summarySnapshot.chatId,
      summaries: summarySnapshot.summaries.filter(
        (summary) => !deletedSummaryIds.has(summary.id) && !deletedChunkIds.has(summary.chunkId),
      ),
    },
  }
}

function emptyPromptMemoryChunkPlanningDiagnostics(): PromptMemoryChunkPlanningDiagnostics {
  return {
    attempted: false,
    summarizedPrefixStartIndex: 0,
    summarizedPrefixTokens: 0,
    chunksCreated: 0,
    jobsCreated: 0,
    plannedWindows: 0,
    cleanup: { summariesDeleted: 0, chunksDeleted: 0 },
    plannerWarnings: [],
    plannerErrors: [],
    errors: [],
  }
}

function summaryToHypaV3Ref(summary: MemorySummary): HypaV3SummaryRef {
  return { chatMemos: readSummaryChatMemos(summary) ?? [] }
}

function readSummaryChatMemos(summary: MemorySummary): string[] | null {
  if (!isRecord(summary.metadata)) return null
  const chatMemos = summary.metadata.chatMemos
  if (!Array.isArray(chatMemos)) return null
  if (!chatMemos.every((memo): memo is string => typeof memo === 'string')) return null
  return chatMemos
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return fallback
}

function shouldSelectPromptMemory(state: AssemblyState, hypaTokenBudget: number | null): boolean {
  return (
    hypaTokenBudget !== 0 &&
    state.memoryDatabase !== null &&
    state.database.hypaV3 === true &&
    state.currentChar.supaMemory === true
  )
}

function clampHypaTokenBudget(legacyBudget: number, hypaTokenBudget: number | null): number {
  return hypaTokenBudget === null ? legacyBudget : Math.min(legacyBudget, hypaTokenBudget)
}

function resolveHypaV3PresetSettings(database: Database): unknown {
  const presetId = hypaV3PresetIndexFromStableId({
    hypaV3Presets: database.hypaV3Presets,
    selectedHypaV3PresetId: database.selectedHypaV3PresetId,
  })
  const preset = database.hypaV3Presets?.[presetId]
  if (preset && typeof preset === 'object' && 'settings' in preset) {
    return preset.settings
  }
  return null
}

function resolvePromptMemoryEmbeddingModel(database: Database): string {
  if (database.hypaModel === 'custom') return 'custom'
  return database.hypaModel || 'MiniLM'
}

/**
 * Shared construction of the VM-backed edit-trigger context the `editRequest`
 * (render) and `editprocess` (history) hooks both run against. The var engine is
 * bound to the working chat + persisted db coordinates so any Lua
 * `setChatVar`/`setState` during a hook flows into the same `chat.scriptstate`
 * the route's chat-var delta reads (`buildChatVarMutations` →
 * `persistAssemblyChatVars`) — picked up for free, exactly like a `'start'`
 * trigger's writes. The caller reads `varEngine.varChanged` to fold the hook's
 * writes into the assembly state. Privileged host fns stay gated off — edit-hook
 * triggers run `lowLevelAccess: false`.
 */
function buildLuaEditTriggerContext(state: AssemblyState): {
  editCtx: ServerLuaEditTriggerContext
  varEngine: TriggerVarEngine
} {
  const db = state.database
  const varEngine = createTriggerVarEngine({
    chat: state.currentChat,
    database: db,
    selectedCharID: state.selectedCharID,
    chatPage: state.chatPage,
    defaultVariables: getChatDefaultVariables(state.currentChar, db),
  })
  const editCtx: ServerLuaEditTriggerContext = {
    chat: state.currentChat,
    database: db,
    selectedCharID: state.selectedCharID,
    chatPage: state.chatPage,
    varEngine,
    model: db.aiModel,
    signal: state.signal,
    execBudget: state.luaExecBudget,
    ...(state.memoryDatabase ? { requestHistoryDb: state.memoryDatabase } : {}),
    ...(state.assetDataDir ? { assetDataDir: state.assetDataDir } : {}),
    allowGeneratedAssetWrites: state.ctx.allowGeneratedAssetWrites,
    offlineReplay: state.ctx.offlineReplay,
    moduleTriggers: getModuleTriggers(getActiveModules(db, state.currentChar, state.currentChat)),
  }
  return { editCtx, varEngine }
}

/**
 * Build the VM-backed Lua `editRequest` hook the final render applies over
 * `formated` and the prompt-info capture, mirroring the browser's
 * `runLuaEditTrigger(char, 'editRequest', formated)`.
 *
 * Supplied unconditionally for byte-parity with the browser (which always calls
 * `runLuaEditTrigger`); when the character + active modules declare no
 * `triggerlua` effect the hook is a no-op and no Lua engine boots
 * (`runLuaEditTrigger` only executes `triggerlua` effects). The returned engine
 * (see {@link buildLuaEditTriggerContext}) lets the caller fold the hook's
 * `varChanged` into the assembly state.
 */
function buildLuaEditRequest(state: AssemblyState): {
  editRequest: (rows: PromptMessage[]) => Promise<PromptMessage[]>
  varEngine: TriggerVarEngine
  persistedScriptstateChanged: () => boolean
} {
  const { editCtx, varEngine } = buildLuaEditTriggerContext(state)
  let persistedScriptstateChanged = false
  return {
    editRequest: async (rows) => {
      const beforeScriptstate = currentPersistedScriptstateSnapshot(state)
      const result = await runLuaEditTrigger(state.currentChar, 'editRequest', rows, undefined, editCtx)
      persistedScriptstateChanged ||= persistedScriptstateChangedSince(state, beforeScriptstate)
      return result
    },
    varEngine,
    persistedScriptstateChanged: () => persistedScriptstateChanged,
  }
}

/**
 * Render the now-complete slots into the flat prompt and run the budget recheck,
 * mutating `state` in place. Mirrors
 * `assembleLocalSendChatPrompt`:
 *   - `renderFinalPrompt` over `state.formatOrder` (which already has
 *     `postEverything` appended by `buildFormatOrder`, so it is **not**
 *     re-pushed here), `state.memories`, and `state.positionParser`,
 *     with the `isContinue` marker, and the VM-backed Lua `editRequest`
 *     hook ({@link buildLuaEditRequest}) over both `formated` and the
 *     prompt-info capture, mirroring the browser's `runLuaEditTrigger`;
 *   - `finalizeRequestBudget` re-tokenizes the rendered rows, trims
 *     `removable` rows to reserve `db.maxResponse` within `db.maxContext`, and
 *     clamps the response budget only when pinned rows require it. On overflow
 *     the send aborts (`stopSending` + `abortReason = 'overflow'`).
 *
 * Runs after `fillMemoryAndPostHistory`, so a prior `stopSending`
 * short-circuits before any rendering.
 */
export async function renderAndBudget(state: AssemblyState): Promise<void> {
  await ensureTokenizerLoadedForDb(state.database)
  if (state.stopSending) return

  const { ctx, currentChar, unformated } = state
  const db = state.database

  prepareStableCardsForFinalRender(state)
  const lua = buildLuaEditRequest(state)
  const render = await measureAssemblyStageAsync(state, 'final_render', () =>
    renderFinalPrompt({
      ctx,
      currentChar,
      unformated,
      promptTemplate: state.promptTemplate,
      usingPromptTemplate: state.usingPromptTemplate,
      formatOrder: state.formatOrder,
      memories: state.memories,
      positionParser: state.positionParser,
      isContinue: state.isContinue,
      editRequest: lua.editRequest,
      stableCardCache: state.stableCardCache,
      descriptionBaseIndex: state.descriptionBaseIndex,
    }),
  )
  state.promptText = render.promptText
  foldStableCardCacheVars(state)
  // A Lua `editRequest` hook may have written chat vars; fold its writes into
  // the assembly state so the route persists them (the var engine already wrote
  // through to the db chat scriptstate the delta reads).
  if (lua.varEngine.varChanged) {
    state.varChanged = true
    syncWorkingScriptstate(state)
    if (lua.persistedScriptstateChanged()) {
      bumpHistoryCallbackMemo(state)
    }
  }

  const budget = measureAssemblyStage(state, 'budget', () =>
    finalizeRequestBudget({
      db,
      formated: render.formated,
      maxContextTokens: db.maxContext ?? 0,
      maxResponse: db.maxResponse ?? 0,
      historyMessageIds: new Set(
        (state.currentChat.message ?? [])
          .map((message) => message.chatId)
          .filter((messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0),
      ),
    }),
  )
  if (!budget.ok) {
    state.stopSending = true
    const { encoding, options } = tokenizerOptionsFromDb(db)
    const pinnedBardWikiTokens = render.formated
      .filter((row) => row.memo === 'bardWiki' && row.removable === false)
      .reduce((tokens, row) => tokens + tokenizeChat(row, encoding, options), 0)
    state.abortReason =
      pinnedBardWikiTokens > 0 && budget.inputTokens - pinnedBardWikiTokens <= (db.maxContext ?? 0)
        ? 'bardwiki_pinned_budget_exceeded'
        : 'overflow'
    state.inputTokens = budget.inputTokens
    return
  }

  state.formated = budget.formated
  if (state.bardWikiPromptDiagnostics) {
    const retainedCount = budget.formated.filter(({ memo }) => memo === 'bardWiki').length
    state.bardWikiPromptDiagnostics.retainedCount = retainedCount
    state.bardWikiPromptDiagnostics.trimmedCount = Math.max(
      0,
      state.bardWikiPromptDiagnostics.selectedCount - retainedCount,
    )
  }
  state.historyTruncated = state.historyTruncated === true || budget.historyTruncated === true
  state.promptSummary = summarizePromptRows(budget.formated)
  state.inputTokens = budget.inputTokens
  state.outputTokens = budget.outputTokens
}

function nowMs(): number {
  return performance.now()
}

function roundedDurationMs(startMs: number): number {
  return Math.round((performance.now() - startMs) * 100) / 100
}

function recordAssemblyStageTiming(
  state: Pick<AssemblyState, 'recordAssemblyStageTiming'>,
  stage: PromptAssemblyStage,
  startMs: number,
): void {
  state.recordAssemblyStageTiming?.(stage, roundedDurationMs(startMs))
}

function measureAssemblyStage<T>(
  state: Pick<AssemblyState, 'recordAssemblyStageTiming'>,
  stage: PromptAssemblyStage,
  run: () => T,
): T {
  if (!state.recordAssemblyStageTiming) return run()
  const startedAt = nowMs()
  try {
    return run()
  } finally {
    recordAssemblyStageTiming(state, stage, startedAt)
  }
}

async function measureAssemblyStageAsync<T>(
  state: Pick<AssemblyState, 'recordAssemblyStageTiming'>,
  stage: PromptAssemblyStage,
  run: () => Promise<T>,
): Promise<T> {
  if (!state.recordAssemblyStageTiming) return run()
  const startedAt = nowMs()
  try {
    return await run()
  } finally {
    recordAssemblyStageTiming(state, stage, startedAt)
  }
}

/**
 * Assemble the full prompt payload. Bad request IDs throw `EntityNotFoundError`;
 * a start trigger or budget overflow returns `{ stopSending: true }` rather
 * than throwing.
 */
export async function assemblePrompt(input: AssembleInput, deps: AssembleDeps): Promise<AssembleResult> {
  const state = measureAssemblyStage(
    { recordAssemblyStageTiming: deps.recordAssemblyStageTiming },
    'scope_resolution',
    () => beginAssembly(input, deps),
  )
  state.recordAssemblyStageTiming = deps.recordAssemblyStageTiming
  await ensureTokenizerLoadedForDb(state.database)
  await measureAssemblyStageAsync(state, 'submit_transforms', async () => {
    prepareRegenerateTranscript(state)
    // The submit-time input trigger runs before the user message is appended;
    // `editinput` then rewrites that user row. This mirrors the browser
    // chat-screen submit handler while the server receives the raw user text.
    const bypassInputHooks =
      state.input.mode === 'send' &&
      (state.input.emptySend === true ||
        (state.input.syntheticSayNothing === true && state.input.userMessage === '*says nothing*'))
    const reuseAcceptedSubmitTransforms =
      state.input.mode === 'send' && state.input.reuseAcceptedSubmitTransforms === true
    if (!bypassInputHooks && !reuseAcceptedSubmitTransforms) await runInputTrigger(state)
    appendUserMessageRow(state)
    if (!bypassInputHooks && !reuseAcceptedSubmitTransforms) await applyEditInput(state)
    captureSubmitTranscript(state)
    applyCurrentChatRunVars(state)
  })
  await measureAssemblyStageAsync(state, 'agent_preset_before_main', () => runAgentPresetBeforeMainStage(state, deps))
  measureAssemblyStage(state, 'static_plain_slots', () => fillStaticSlots(state))
  await measureAssemblyStageAsync(state, 'lorebook_preflight', () => fillLorebookSlotsAsync(state))
  await measureAssemblyStageAsync(state, 'history_bias', () => fillHistoryAndBias(state))
  measureAssemblyStage(state, 'memory_bridge', () => fillMemoryAndPostHistory(state))
  await renderAndBudget(state)

  const warnings: Omit<WarningEvent, 'type'>[] = [
    ...(state.promptAssetDropDiagnostics ?? []).map((diagnostic) => ({
      message: 'Prompt asset was omitted because its metadata or stored bytes were unavailable.',
      context: {
        kind: 'prompt_asset_dropped',
        name: diagnostic.name,
        ...(diagnostic.reference ? { reference: diagnostic.reference } : {}),
        reason: diagnostic.reason,
      },
    })),
    ...takeServerCompatibilityWarnings(state),
  ]

  if (state.stopSending) {
    return {
      stopSending: true,
      abortReason: state.abortReason ?? 'trigger_stop',
      inputTokens: state.inputTokens,
      promptSummary: state.promptSummary,
      mutations: buildMutationPayload(state),
      restoration: buildRestorationPayload(state),
      submitMessages: state.submitMessages,
      submitTranscriptChanged: submitTranscriptChanged(state),
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  }

  const formated = state.formated ?? []
  const promptSummary = state.promptSummary ?? summarizePromptRows(formated)
  return {
    stopSending: false,
    prompt: {
      messages: formated.map((row) => ({ role: row.role, content: row.content })),
      promptInfo: {
        ...state.promptInfo,
        ...(state.promptText !== undefined ? { promptText: state.promptText } : {}),
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
      },
      lorebookActivation: state.report,
      // Carry the full rows on the wire so preview clients can inspect the
      // dispatch payload, not just the lossy `messages` projection.
      formated,
      biases: state.biases ?? [],
    },
    formated,
    biases: state.biases ?? [],
    promptSummary,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    ...(warnings.length > 0 ? { warnings } : {}),
    mutations: buildMutationPayload(state),
    restoration: buildRestorationPayload(state),
    submitMessages: state.submitMessages,
    submitTranscriptChanged: submitTranscriptChanged(state),
    // Hand the assembler state to the route so post-generation processing can
    // reuse this exact chat/var context after provider dispatch.
    state,
  }
}

// Server post-generation pass.
//
// After the provider produces the completion text, the server runs `editoutput`,
// the pre-trigger run-var pass, and the `'output'` trigger. It derives the
// `chat.scriptstate` delta and final assistant text, and reports whether the
// output trigger requested a resend.
//
// Generation result finalization persists the scriptstate delta and assistant
// text. This pass derives against the post-assembly scriptstate baseline and
// never emits a transcript write for the appended assistant row.

/** Route inputs for {@link runServerPostGeneration}. */
export interface ServerPostGenerationInput {
  /** The raw provider completion text (pre-`editoutput`). */
  completionText: string
  /** The assistant message id (`generationId`) used to key persistence. */
  generationId: string
  /** `createGenerationInfo` output, stamped onto the appended assistant row. */
  generationInfo?: Record<string, unknown>
  /** Assembled prompt-info, stamped onto the appended assistant row. */
  promptInfo?: Record<string, unknown>
  /** Optional collector for post-generation Lua diagnostics. */
  luaTrace?: PostGenerationLuaTraceCollector
  /** Optional live progress tracker for post-generation Lua scripts. */
  luaProgress?: PostGenerationLuaProgressTracker
  /** Optional live progress reporter for after-main Agent Preset steps. */
  agentPresetProgress?: AgentPresetProgressReporter
  /**
   * Runs after the transformed primary row is present but before run-vars and
   * the output trigger mutate the transcript. Used to derive provider reroll
   * choices against the same context/order as retained multiline generation.
   */
  beforeOutputTrigger?: (alternateState: AssemblyState) => Promise<void>
  /**
   * Retain an interrupted provider result using only the streaming-visible
   * `editoutput` pipeline. Cancellation and post-token failures must not run
   * completion-only Agent Preset/output-trigger effects.
   */
  partial?: boolean
}

/** Result of {@link runServerPostGeneration}. */
export interface ServerPostGenerationResult {
  /** The `editoutput`'d + run-var'd assistant text (server-owned final text). */
  finalText: string
  /** True when `editoutput` / run-var changed the text vs the reformatted completion. */
  textChanged: boolean
  /** Structured Agent Preset after-main failure, when finalization stopped at that point. */
  agentPresetError?: AgentPresetGenerationErrorBody
  /** The post-gen delta (scriptstate + any output-trigger message surgery). */
  mutations: AssembleMutationPayload
  /** The output trigger requested a resend (`sendAIprompt`). Browser re-issues it. */
  resendChat: boolean
  /** A durable chat-var write occurred; the route persists when true. */
  changed: boolean
  /** Unsupported output-trigger effects first observed after assembly warnings were emitted. */
  warnings?: Omit<WarningEvent, 'type'>[]
}

function takeUnsupportedTriggerWarnings(state: AssemblyState): Omit<WarningEvent, 'type'>[] {
  const warnings: Omit<WarningEvent, 'type'>[] = []
  for (const effectType of state.unsupportedTriggerEffectTypes) {
    if (state.warnedUnsupportedTriggerEffectTypes.has(effectType)) continue
    state.warnedUnsupportedTriggerEffectTypes.add(effectType)
    warnings.push({
      message: `Trigger effect "${effectType}" is unsupported on this server and was skipped.`,
      context: { kind: 'unsupported_trigger_effect', effectType },
    })
  }
  return warnings
}

function takeCbsCallbackWarnings(state: AssemblyState): Omit<WarningEvent, 'type'>[] {
  const warnings: Omit<WarningEvent, 'type'>[] = []
  for (const [callbackName, reason] of state.cbsCallbackDiagnostics) {
    if (state.warnedCbsCallbackNames.has(callbackName)) continue
    state.warnedCbsCallbackNames.add(callbackName)
    warnings.push({
      message:
        reason === 'unsupported_on_server'
          ? `CBS callback "${callbackName}" is unsupported on this server and returned an empty value.`
          : `CBS callback "${callbackName}" could not resolve because client context was not reported and returned an empty value.`,
      context: { kind: 'unsupported_cbs_callback', callbackName, reason },
    })
  }
  return warnings
}

function takeServerCompatibilityWarnings(state: AssemblyState): Omit<WarningEvent, 'type'>[] {
  return [...takeUnsupportedTriggerWarnings(state), ...takeCbsCallbackWarnings(state)]
}

function cloneAgentPresetRuntime(runtime: AgentPresetRuntimeState | undefined): AgentPresetRuntimeState | undefined {
  if (!runtime) return undefined
  return {
    ...runtime,
    previousAgentOutputs: structuredClone(runtime.previousAgentOutputs),
    promptOutputs: { ...runtime.promptOutputs },
    outputRequired: { ...runtime.outputRequired },
    ...(runtime.beforeMain ? { beforeMain: structuredClone(runtime.beforeMain) } : {}),
    afterMain: undefined,
    failure: undefined,
  }
}

function clonePostGenerationState(state: AssemblyState): AssemblyState {
  const database: Database = {
    ...state.database,
    characters: state.database.characters.slice(),
    globalChatVariables: { ...state.database.globalChatVariables },
  }
  const currentChar = cloneGenerationWorkingCharacter(state.currentChar)
  const currentChat = structuredClone(state.currentChat)
  const luaExecBudget = state.luaExecBudget ? { ...state.luaExecBudget } : undefined
  currentChar.chats[state.chatPage] = currentChat
  database.characters[state.selectedCharID] = currentChar

  return {
    ...state,
    database,
    currentChar,
    currentChat,
    ctx: {
      ...state.ctx,
      database,
      ...(typeof state.ctx.chara === 'object' ? { chara: currentChar } : {}),
      ...(luaExecBudget ? { luaExecBudget } : {}),
    },
    ...(luaExecBudget ? { luaExecBudget } : {}),
    ...(state.initialMessages ? { initialMessages: structuredClone(state.initialMessages) } : {}),
    ...(state.messageMutationCheckpoint
      ? { messageMutationCheckpoint: structuredClone(state.messageMutationCheckpoint) }
      : {}),
    ...(state.initialScriptstate ? { initialScriptstate: structuredClone(state.initialScriptstate) } : {}),
    messageMutations: [],
    additionalSystemPromptMutations: [],
    varChanged: false,
    agentPreset: cloneAgentPresetRuntime(state.agentPreset),
  }
}

/**
 * Apply the per-choice presentation transforms to a provider alternate without
 * committing its scriptstate/message side effects. Each choice gets an isolated
 * state clone so `editoutput` and Agent Preset modifiers match the primary while
 * only the selected primary runs the output trigger and persists mutations.
 */
export async function runServerAlternatePostGeneration(state: AssemblyState, completionText: string): Promise<string> {
  const isolated = clonePostGenerationState(state)
  const isContinue = isolated.input.mode === 'continue'
  const messages = isolated.currentChat.message ?? []
  const continueIndex = messages.length - 1
  const initialMessages = isolated.initialMessages ?? messages
  const initialContinueIndex = initialMessages.length - 1
  const continueBase = isContinue
    ? isolated.continueDisposition === 'append'
      ? '*says nothing*'
      : initialMessages[initialContinueIndex]?.role === 'char'
        ? (initialMessages[initialContinueIndex].data ?? '')
        : ''
    : ''
  const editIndex = isContinue ? continueIndex : messages.length

  const reformatted = reformatCompletion(continueBase + completionText)
  let editedText = await applyEditOutput(isolated, reformatted, editIndex)
  if (isolated.database.removeIncompleteResponse) {
    editedText = trimUntilPunctuation(editedText)
  }
  return (await runAgentPresetAfterMainStage(isolated, editedText)).finalText
}

/** Browser `sendChat`'s `reformatContent` is `.trim()`; mirror it server-side. */
function reformatCompletion(text: string): string {
  return text.trim()
}

/**
 * The `editoutput` transform of the completion text, mirroring
 * `processScriptFull(…, 'editoutput', msgIndex)` (`scripts.ts`): the Lua
 * `editOutput` hook → CBS expansion → the regex `editoutput` scripts. Identical in
 * shape to `applyEditInput`. pluginV2 stays permanent-unsupported, so its arm is
 * intentionally absent. Lua var writes fold into the chat-var delta.
 */
async function applyEditOutput(
  state: AssemblyState,
  text: string,
  msgIndex: number,
  luaTrace?: PostGenerationLuaTraceCollector,
  luaProgress?: PostGenerationLuaProgressTracker,
): Promise<string> {
  const { editCtx, varEngine } = buildLuaEditTriggerContext(state)
  editCtx.postGenerationTrace = luaTrace
  editCtx.postGenerationProgress = luaProgress
  let out = await runLuaEditTrigger(state.currentChar, 'editoutput', text, { index: msgIndex }, editCtx)
  out = expandVariables(out, { ...state.ctx, chatID: msgIndex, chara: state.currentChar }).text
  out = await processScriptAsync(state.ctx, state.currentChar, out, 'editoutput', {}, msgIndex, state.currentChat)
  if (varEngine.varChanged) {
    state.varChanged = true
    syncWorkingScriptstate(state)
  }
  return out
}

/**
 * Append (send / regenerate) or extend (continue) the assistant row carrying the
 * `editoutput`'d text, mirroring `consumeStreamResponse` / `applyNonStreamResponse`.
 * For `continue` the trailing assistant row is rewritten in place, keeping its
 * id/metadata for target-message replacement; otherwise a fresh row is pushed
 * with the generation metadata so the result can be found by
 * `chatId === generationId`.
 */
function appendAssistantRow(
  state: AssemblyState,
  editedText: string,
  input: ServerPostGenerationInput,
  isContinue: boolean,
  continueIndex: number,
): void {
  const messages = (state.currentChat.message ??= [])
  if (isContinue && state.continueDisposition === 'extend' && messages[continueIndex]?.role === 'char') {
    messages[continueIndex] = { ...messages[continueIndex], data: editedText }
    bumpHistoryCallbackMemo(state)
    return
  }
  const promptInfo = promptInfoForPersistence(state, input.promptInfo)
  const message = {
    role: 'char',
    data: editedText,
    saying: state.currentChar.chaId,
    time: Date.now(),
    chatId: input.generationId,
    ...(input.generationInfo ? { generationInfo: input.generationInfo } : {}),
    ...(promptInfo !== undefined ? { promptInfo } : {}),
  } as Message
  if (
    isContinue &&
    state.continueDisposition === 'append' &&
    messages[continueIndex]?.chatId === state.transientContinueBoundaryId
  ) {
    messages[continueIndex] = message
    delete state.transientContinueBoundaryId
  } else {
    messages.push(message)
  }
  bumpHistoryCallbackMemo(state)
}

function promptInfoForPersistence(
  state: AssemblyState,
  promptInfo: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return state.database.promptInfoInsideChat === true ? promptInfo : {}
}

/**
 * The `'output'` trigger over the post-generation transcript, mirroring
 * `applyOutputTrigger` (`postGeneration/outputTrigger.ts`) and reusing the
 * input-trigger wiring (the Lua VM seam, the var-engine writethrough).
 * `setvar`/`v2SetVar` arms fold into the chat-var delta; a transcript rewrite is
 * captured as an `output_trigger` message mutation (surfaced for the projection,
 * not persisted here). Returns the trigger's resend request (`sendAIprompt`).
 */
async function runOutputTrigger(
  state: AssemblyState,
  luaTrace?: PostGenerationLuaTraceCollector,
  luaProgress?: PostGenerationLuaProgressTracker,
): Promise<boolean> {
  const { currentChar } = state
  const db = state.database
  const triggerCtx: TriggerRunContext = {
    modules: getActiveModules(db, currentChar, state.currentChat),
    model: db.aiModel,
    database: db,
    selectedCharID: state.selectedCharID,
    chatPage: state.chatPage,
    signal: state.signal,
    unsupportedEffectTypes: state.unsupportedTriggerEffectTypes,
    clientContext: state.ctx.clientContext,
    cbsCallbackDiagnostics: state.cbsCallbackDiagnostics,
    runLua: async ({ code, mode, lowLevelAccess, chat, varEngine, source }) => {
      const traceRun = luaTrace?.beginRun({
        phase: 'onOutput',
        mode,
        code,
        source,
        chat,
      })
      const progressRun = luaProgress?.beginRun({
        phase: 'onOutput',
        source,
      })
      let result: Awaited<ReturnType<typeof runServerLua>>
      try {
        result = await runServerLua(
          { code, mode, lowLevelAccess, source, traceSink: traceRun?.sink, progressSink: progressRun?.sink },
          {
            chat,
            database: db,
            selectedCharID: state.selectedCharID,
            chatPage: state.chatPage,
            varEngine,
            char: currentChar,
            model: db.aiModel,
            signal: state.signal,
            execBudget: state.luaExecBudget,
            ...(state.memoryDatabase ? { requestHistoryDb: state.memoryDatabase } : {}),
            ...(state.assetDataDir ? { assetDataDir: state.assetDataDir } : {}),
            allowGeneratedAssetWrites: state.ctx.allowGeneratedAssetWrites,
            offlineReplay: state.ctx.offlineReplay,
          },
        )
      } catch (error) {
        progressRun?.finish('error')
        traceRun?.finish({
          status: 'error',
          chat,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
      const failure =
        result.error || result.timedOut || result.interactiveInvoked || result.aborted
          ? (result.error ?? (result.timedOut ? 'Lua execution timed out' : 'Lua runtime failed'))
          : undefined
      progressRun?.finish(failure ? 'error' : 'finished')
      traceRun?.finish({
        status: failure ? 'error' : 'ok',
        chat,
        runtimeMetricFields: result.runtimeMetricFields as unknown as Record<string, unknown> | undefined,
        ...(failure ? { error: failure } : {}),
      })
      throwServerLuaFailure(result, `Lua ${mode} trigger failed`)
      return { chat, stopSending: result.stopSending }
    },
  }

  const result = await runTrigger(triggerCtx, currentChar, 'output', { chat: state.currentChat })
  if (!result) return false

  state.varChanged = !!state.varChanged || result.varChanged
  syncWorkingScriptstate(state)
  if (result.aborted) return false
  state.currentChat = result.chat
  // No-op when the trigger left the transcript untouched.
  captureMessageReplacement(state, 'output_trigger')
  return !!result.sendAIprompt
}

/** Read the assistant text back after run-var + the output trigger may have run. */
function assistantTextAfterPass(
  state: AssemblyState,
  input: ServerPostGenerationInput,
  isContinue: boolean,
  continueIndex: number,
  fallback: string,
): string {
  const messages = state.currentChat.message ?? []
  if (isContinue && state.continueDisposition === 'extend') {
    return messages[continueIndex]?.data ?? fallback
  }
  const byId = messages.find((message) => message.chatId === input.generationId)
  return byId?.data ?? messages.at(-1)?.data ?? fallback
}

interface AgentPresetAfterMainRun {
  finalText: string
  error?: AgentPresetGenerationErrorBody
}

async function runAgentPresetAfterMainStage(
  state: AssemblyState,
  mainDraft: string,
  progressReporter?: AgentPresetProgressReporter,
): Promise<AgentPresetAfterMainRun> {
  const runtime = state.agentPreset
  const plan = runtime?.plan
  if (!runtime || runtime.resolution.status !== 'ready' || !plan) {
    return { finalText: mainDraft }
  }

  runtime.mainOutputText = mainDraft
  let outputTextByKey = outputTextByKeyFromPreviousOutputs(runtime.previousAgentOutputs)
  let directFinalText = mainDraft

  if (plan.afterMain.steps.length > 0) {
    const afterMain = await executeAgentPresetPhase({
      database: state.database,
      ...(state.memoryDatabase ? { requestHistoryDb: state.memoryDatabase } : {}),
      currentChar: state.currentChar,
      currentChat: state.currentChat,
      currentUserMessage: latestUserMessage(state.currentChat),
      previousAgentOutputs: runtime.previousAgentOutputs,
      mainDraft,
      plan: plan.afterMain,
      resolvedMainProfile: state.resolvedMainProfile,
      maxConcurrency: plan.maxConcurrency,
      signal: state.signal,
      executeStep: state.executeAgentPresetStep ?? executeAgentPresetStep,
      onProgress: (progress) =>
        progressReporter?.({
          chatId: state.currentChat.id ?? state.input.chatId,
          presetId: runtime.preset?.id ?? '',
          presetName: runtime.preset?.name ?? '',
          ...progress,
        }),
    })
    runtime.afterMain = afterMain
    runtime.previousAgentOutputs = afterMain.previousAgentOutputs
    outputTextByKey = afterMain.outputTextByKey

    if (afterMain.blockingFailure) {
      runtime.failure = afterMain.blockingFailure
      runtime.finalTextModified = false
      return {
        finalText: mainDraft,
        error: agentPresetPhaseError(runtime, afterMain.blockingFailure).body,
      }
    }

    const modifier = plan.finalOutputModifierStepId
      ? afterMain.stepResults.find(
          (result) => result.status === 'success' && result.stepId === plan.finalOutputModifierStepId,
        )
      : undefined
    directFinalText = modifier?.status === 'success' ? modifier.outputText : mainDraft
  }

  let finalText = directFinalText
  if (runtime.preset?.finalOutputTemplate) {
    try {
      finalText = expandVariables(runtime.preset.finalOutputTemplate, {
        ...state.ctx,
        slot: { ...(state.ctx.slot ?? {}), mainOutput: mainDraft },
        agentOutputs: outputTextByKey,
        agentOutputRequired: allAgentOutputsRequiredByKey(plan),
      }).text
      runtime.finalOutputComposed = true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const failure: AgentPresetFinalOutputFailure = {
        phase: 'afterMain',
        message: `Final output CBS failed: ${detail}`,
        failureKind: 'final_output_cbs',
      }
      runtime.failure = failure
      runtime.finalOutputComposed = false
      runtime.finalTextModified = false
      return {
        finalText: mainDraft,
        error: new AgentPresetGenerationError(failure.message, {
          phase: failure.phase,
          presetId: runtime.preset.id,
          presetName: runtime.preset.name,
          failureKind: failure.failureKind,
          diagnostics: { status: failure.failureKind },
        }).body,
      }
    }
  } else {
    runtime.finalOutputComposed = false
  }

  runtime.finalTextModified = finalText !== mainDraft
  return { finalText }
}

function outputTextByKeyFromPreviousOutputs(outputs: readonly AgentPresetPreviousOutput[]): Record<string, string> {
  const byKey: Record<string, string> = {}
  for (const output of outputs) byKey[output.outputKey] = output.text
  return byKey
}

function allAgentOutputsRequiredByKey(plan: AgentPresetExecutionPlan): Record<string, boolean> {
  const required: Record<string, boolean> = {}
  for (const planned of plan.stableSteps) {
    if (planned.step.failurePolicy.mode !== 'optional') required[planned.step.outputKey] = true
  }
  return required
}

function attachAgentPresetDiagnostics(generationInfo: Record<string, unknown> | undefined, state: AssemblyState): void {
  if (!generationInfo || !state.agentPreset || state.agentPreset.resolution.status === 'none') return
  generationInfo.agentPreset = buildAgentPresetGenerationDiagnostics(state.agentPreset)
}

function buildAgentPresetGenerationDiagnostics(runtime: AgentPresetRuntimeState): Record<string, unknown> {
  const preset = runtime.preset
  const steps = [...(runtime.beforeMain?.stepResults ?? []), ...(runtime.afterMain?.stepResults ?? [])].map((result) =>
    serializeAgentPresetStepResult(result),
  )

  return {
    status: runtime.resolution.status,
    ...(preset
      ? {
          presetId: preset.id,
          presetName: preset.name,
          presetVersion: preset.version,
        }
      : {}),
    ...(runtime.plan
      ? {
          maxConcurrency: runtime.plan.maxConcurrency,
          beforeMainStepCount: runtime.plan.beforeMain.steps.length,
          afterMainStepCount: runtime.plan.afterMain.steps.length,
          userInputModifierStepId: runtime.plan.userInputModifierStepId,
          finalOutputModifierStepId: runtime.plan.finalOutputModifierStepId,
        }
      : {}),
    promptOutputKeys: Object.keys(runtime.promptOutputs),
    steps,
    userInputModified: runtime.userInputModified === true,
    finalTextModified: runtime.finalTextModified === true,
    finalOutputComposed: runtime.finalOutputComposed === true,
    ...(runtime.mainOutputText !== undefined
      ? { mainOutputPreview: boundedPreview(runtime.mainOutputText), mainOutputChars: runtime.mainOutputText.length }
      : {}),
    ...(runtime.failure ? { failure: runtime.failure } : {}),
  }
}

function serializeAgentPresetStepResult(result: AgentPresetStepExecutionResult): Record<string, unknown> {
  const diagnostics = result.diagnostics
  return {
    status: result.status,
    stepId: result.stepId,
    stepName: result.stepName,
    phase: diagnostics.phase,
    outputKey: result.outputKey,
    destination: diagnostics.destination,
    outputFormat: diagnostics.outputFormat,
    failurePolicy: diagnostics.failurePolicy,
    inputChars: diagnostics.inputChars,
    outputChars: diagnostics.outputChars,
    durationMs: diagnostics.durationMs,
    provider: diagnostics.provider,
    profileId: diagnostics.profileId,
    profileName: diagnostics.profileName,
    modelId: diagnostics.modelId,
    requestModel: diagnostics.requestModel,
    parseStatus: diagnostics.parseStatus,
    preparedInputSections: diagnostics.preparedInputSections.map((section) => ({
      scope: section.scope,
      sourceLabel: section.sourceLabel,
      charCount: section.charCount,
      truncated: section.truncated,
    })),
    preparedInputDiagnostics: diagnostics.preparedInputDiagnostics,
    ...(result.status === 'success'
      ? {
          outputPreview: boundedPreview(result.outputText),
          outputTruncated: result.outputTruncated,
        }
      : {}),
    ...(result.status === 'failed'
      ? {
          failureKind: result.failureKind,
          failurePolicyOutcome: result.failurePolicyOutcome,
          error: result.error,
        }
      : {}),
    ...(result.status === 'skipped'
      ? {
          reason: result.reason,
          error: agentPresetStepResultErrorMessage(result),
        }
      : {}),
  }
}

function boundedPreview(text: string, maxChars = 4_000): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 3) return text.slice(0, maxChars)
  return `${text.slice(0, maxChars - 3).trimEnd()}...`
}

/**
 * Run the server post-generation pass over the provider's completion text. Reuses
 * the assembler state from {@link assemblePrompt} (handed back on `AssembleResult.state`).
 * See the section header above for the full contract.
 */
export async function runServerPostGeneration(
  state: AssemblyState,
  input: ServerPostGenerationInput,
): Promise<ServerPostGenerationResult> {
  const isContinue = state.input.mode === 'continue'
  const messages = (state.currentChat.message ??= [])
  const continueIndex = messages.length - 1
  const continueBase = isContinue
    ? state.continueDisposition === 'append'
      ? '*says nothing*'
      : messages[continueIndex]?.role === 'char'
        ? (messages[continueIndex].data ?? '')
        : ''
    : ''
  const editIndex =
    isContinue &&
    state.continueDisposition === 'append' &&
    messages[continueIndex]?.chatId !== state.transientContinueBoundaryId
      ? messages.length
      : isContinue
        ? continueIndex
        : messages.length

  // Baseline the post-gen delta against the post-assembly scriptstate (the route
  // already persisted the assembly-time delta), and clear the assembly-time
  // mutation accumulators so the payload carries only post-gen writes.
  state.initialScriptstate = cloneScriptstate(currentPersistedChat(state)?.scriptstate)
  state.initialLastMemory = state.currentChat.lastMemory
  state.initialCharacterFields = characterFieldSnapshot(state.currentChar)
  state.initialLocalLore = cloneLocalLore(state.currentChat.localLore)
  state.varChanged = false
  state.messageMutations = []
  state.additionalSystemPromptMutations = []

  // Accepted divergence (OR-6): baseline index.svelte.ts:1631 entered a
  // buffered per-choice loop that fired `editoutput` once on the raw Continue
  // fragment and again on the combined row. Keep the intentional single pass.
  const reformatted = reformatCompletion(continueBase + input.completionText)
  let editedText = await applyEditOutput(state, reformatted, editIndex, input.luaTrace, input.luaProgress)
  if (state.database.removeIncompleteResponse) {
    editedText = trimUntilPunctuation(editedText)
  }

  if (input.partial) {
    appendAssistantRow(state, editedText, input, isContinue, continueIndex)
    const mutations = buildMutationPayload(state)
    const changed =
      mutations.varChanged ||
      mutations.chatVarMutations.length > 0 ||
      (mutations.characterFieldMutations?.length ?? 0) > 0 ||
      mutations.localLoreMutation !== undefined
    const warnings = takeServerCompatibilityWarnings(state)
    return {
      finalText: editedText,
      textChanged: editedText !== reformatted,
      mutations,
      resendChat: false,
      changed,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  }

  const alternateAgentPreset = cloneAgentPresetRuntime(state.agentPreset)
  const agentPresetAfterMain = await runAgentPresetAfterMainStage(state, editedText, input.agentPresetProgress)
  attachAgentPresetDiagnostics(input.generationInfo, state)

  appendAssistantRow(state, agentPresetAfterMain.finalText, input, isContinue, continueIndex)
  await input.beforeOutputTrigger?.({ ...state, agentPreset: alternateAgentPreset })
  if (agentPresetAfterMain.error) {
    return {
      finalText: agentPresetAfterMain.finalText,
      textChanged: agentPresetAfterMain.finalText !== reformatted,
      agentPresetError: agentPresetAfterMain.error,
      mutations: buildMutationPayload(state),
      resendChat: false,
      changed: false,
    }
  }

  // The run-var pass rewrites the assistant body (stripping `{{setvar}}` etc.); that
  // rewrite is the *final text*, surfaced on `done`, not a transcript mutation.
  // Re-baseline once after the pass so any later output-trigger edit is isolated.
  applyCurrentChatRunVars(state, { captureMessageMutation: false })
  state.messageMutations = []
  state.messageMutationCheckpoint = cloneMessages(state.currentChat.message ?? [], 'postGenerationCheckpoint')

  const resendChat = await runOutputTrigger(state, input.luaTrace, input.luaProgress)

  const finalText = assistantTextAfterPass(state, input, isContinue, continueIndex, agentPresetAfterMain.finalText)
  attachAgentPresetDiagnostics(input.generationInfo, state)
  const mutations = buildMutationPayload(state)
  const changed =
    mutations.varChanged ||
    mutations.chatVarMutations.length > 0 ||
    (mutations.characterFieldMutations?.length ?? 0) > 0 ||
    mutations.localLoreMutation !== undefined
  const warnings = takeServerCompatibilityWarnings(state)

  return {
    finalText,
    textChanged: finalText !== reformatted,
    mutations,
    resendChat,
    changed,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
