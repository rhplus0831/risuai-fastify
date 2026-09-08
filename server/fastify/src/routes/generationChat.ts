import fs from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  FastifyChat as Chat,
  FastifyCharacter as character,
  FastifyDatabase as Database,
  FastifyMessage as Message,
} from '../prompt/serverTypes.js'
import type { PromptMultimodal, PromptMessage } from '../prompt/promptMessage.js'
import { trimUntilPunctuation } from '@risuai/shared-core/punctuation'
import type { CompletionStreamFrame } from '../generation/frames.js'
import { HYPA_CONTEXT_TRUNCATION_CONFIRMATION_REQUIRED } from '@risuai/protocol/hypa-context-truncation'
import type { AuthState } from '../auth.js'
import { getSchemaState } from '../db.js'
import { requireAuth } from '../http.js'
import {
  EntityNotFoundError,
  ValidationError,
  assetById,
  assetPath,
  isValidAssetId,
  loadPersistedForGenerationAssembly,
  loadPersistedForGenerationPreflight,
  writeSingleChatRow,
  writeSingleChatRowExact,
  writeSingleCharacterRow,
} from '../repository.js'
import {
  assemblePrompt,
  applyRequestTrigger,
  getMessageMutationFirstChangedIndex,
  runServerAlternatePostGeneration,
  runServerPostGeneration,
  type AssembleDeps,
  type AssembleAbortReason,
  type AssembleInput,
  type AssembleMutationPayload,
  type AssembleMutationSource,
  type AssembleResult,
  type AssemblyState,
  type ContinueDisposition,
  type PromptAssemblyStage,
} from '../prompt/assemble.js'
import {
  applyProfileBoundGenerationFields,
  resolveGenerationPreflightConfiguration,
  isChatGenerationSettingsIncompleteAssemblyError,
  isModelProfileGenerationGuardAssemblyError,
} from '../prompt/effectiveGenerationConfig.js'
import {
  decodeGenerationDatabase,
  decodeGenerationPreflightInputs,
  GenerationInputValidationError,
} from '../prompt/generationInputDecoder.js'
import type { ResolveStoredAsset, StoredAssetPurpose } from '../prompt/assetLookup.js'
import { requireChatLocationExact } from '../commands/chats.js'
import { createMessageRecord, validateUniqueMessageIds } from '../commands/messages.js'
import { COMMAND_EVENT_CATALOG, type CommandEventSink } from '../commands/events.js'
import { applyTargetedCommandMutation } from '../commands/mutations.js'
import {
  addAlternateMessage,
  activeMessageIdExists,
  activeMessageIdExistsInChat,
  activeMessageIdExistsOutsideChat,
  appendActiveChatMessageTail,
  clearAlternateMessages,
  countAlternateMessages,
  countChatMessages,
  getActiveMessageLocationById,
  getChatMessages,
  replaceActiveChatMessages,
  updateActiveMessageById,
  writeGenerationChatMessage,
} from '../messageStore.js'
import {
  dispatchChatProvider,
  getServerGenerationModelString,
  type ChatDispatchHistoryInput,
} from '../prompt/chatDispatch.js'
import {
  resolveModelProfile,
  type ModelProfileFallbackRef,
  type ResolvedModelProfile,
} from '@risuai/shared-core/model-profile-resolver'
import { risuEscape, risuUnescape } from '@risuai/shared-core/risuchat-parser-helpers'
import { ServerLuaFailureError } from '../prompt/luaRuntime.js'
import { isAgentPresetGenerationError, type AgentPresetProgressReporter } from '../prompt/agentPresetExecution.js'
import {
  emitProviderChunks,
  type ProviderFailurePostGenerationResult,
  type ProviderPostGenerationResult,
} from '../prompt/providerTransport.js'
import { tokenize } from '../prompt/tokens.js'
import { tokenizerEncodingFromDb } from '../prompt/tokenizerConfig.js'
import { promptSummaryMetricFields, summarizePromptRows, type PromptRowsSummary } from '../prompt/promptSummary.js'
import { triggerSourceMetricFields } from '../prompt/triggerSource.js'
import { bardWikiRequestHistoryMetadata } from '../prompt/bardWiki.js'
import { createOrReuseAutomaticBardWikiConfirmation } from '../bardWikiReceipts.js'
import type { BardWikiJobSummary } from '../bardWikiRepository.js'
import {
  formatPromptChatFrame,
  type PostGenerationFrame,
  type PromptChatEvent,
  type PromptEvent,
} from '../prompt/sseEvents.js'
import { ACTIVE_WRITER_SESSION_HEADER } from '../activeWriter.js'
import { getDatabaseLineage, getDatabaseWriterMetadata } from '../databaseLineage.js'
import { attachAbort } from '../requestAbort.js'
import type { GenerationJobRegistry } from '../generationJobs.js'
import { isStreamDeadlineActivityFrame, type JobClient, type StreamJob } from '../streamJobs.js'
import { getWritableBufferedBytes, writeBoundedRaw } from '../streamBackpressure.js'
import { emitProtocolMetric, protocolDurationMs, protocolMetricsEnabled, protocolNowMs } from '../protocolMetrics.js'
import { diagnosticsContextEnabled, recordDiagnosticEvent, runWithDiagnosticContext } from '../diagnosticContext.js'
import {
  DEFAULT_GENERATION_TRACE_MAX_GZIP_BYTES,
  generationTraceSidecarMetricField,
  writeGenerationTraceSidecar,
  type GenerationTraceContext,
  type GenerationTraceOptions,
} from '../generation/generationTraceSidecar.js'
import { PostGenerationLuaTraceCollector } from '../prompt/luaPostGenerationTrace.js'
import { PostGenerationLuaProgressTracker } from '../prompt/luaPostGenerationProgress.js'
import {
  GENERATION_FINALIZATION_LEGACY_SNAPSHOT_ERROR,
  deleteGenerationFinalizationRetry,
  enqueueGenerationFinalizationRetry,
  findUncommittedGenerationFinalizationForChat,
  listPendingGenerationFinalizationRetries,
  markGenerationFinalizationRetryFailure,
  type GenerationFinalizationAttempt,
  type GenerationFinalizationMode,
} from '../generationFinalizationRetry.js'
import { generationSubmitRateLimit } from '../routeRateLimits.js'
import { REQUEST_UID_HEADER } from '../requestTrace.js'
import type { ChatCompletionNotificationContext, PushNotificationService } from '../pushNotifications.js'
import type { MessageTranslationJobRegistry } from '../messageTranslationJobs.js'
import type { MemoryJob } from '../memoryRepository.js'
import { getBardWikiChatSettings } from '../bardWikiRepository.js'
import { readBardWikiGlobalSettings, resolveEffectiveBardWikiSettings } from '../bardWikiSettings.js'
import {
  emptyPromptMemoryQueryDiagnostics,
  prefetchPromptMemoryQueryVectors,
  type PrefetchPromptMemoryQueryInput,
  type PromptMemoryQueryPrefetchResult,
} from '../promptMemoryQuery.js'
import {
  handleGeneratedChatCompletion,
  type ServerMessageTranslationRunner,
} from '../translation/generationCompletionTranslation.js'
import { normalizeReportedClientContext } from '@risuai/protocol/client-context'
import {
  GenerationOperationAttemptConflictError,
  assertGenerationOperationDispatchable,
  completeGenerationOperationFinalizationInTransaction,
  getGenerationOperationProjection,
  generationOperationRequestFingerprint,
  insertGenerationOperationInTransaction,
  markGenerationOperationProviderDispatchFinished,
  markGenerationOperationProviderDispatchStarted,
  reserveGenerationOperationAttemptInTransaction,
  transitionGenerationOperation,
  type GenerationOperationLineage,
  type GenerationOperationProjection,
  type GenerationOperationTerminalOutcome,
} from '../generationOperations.js'
import {
  claimGenerationEffect,
  ensureGenerationEffectLedgerInTransaction,
  generationEffectLedgerRef,
  listPendingServerGenerationEffects,
  settleGenerationEffect,
  type GenerationEffectLedgerRef,
} from '../generationEffects.js'

const ALLOWED_MODES = new Set(['send', 'continue', 'preview', 'preview_prompt', 'regenerate'])
const SERVER_INLAY_SIGNATURE_CONTENT_TYPE = 'application/x-risu-inlay-signature+json'
const PROVIDER_DISPATCH_FALLBACK = 'Provider dispatch failed before returning an error message.'

export interface ChatRequestBody {
  chatId?: unknown
  characterId?: unknown
  loadoutId?: unknown
  mode?: unknown
  regenerateMessageId?: unknown
  userMessage?: unknown
  emptySend?: unknown
  syntheticSayNothing?: unknown
  resetMessages?: unknown
  expectedRevision?: unknown
  inlayAssets?: unknown
  inlayAssetRefs?: unknown
  clientCapabilities?: unknown
  clientContext?: unknown
  durable?: unknown
}

type SuccessfulAssembleResult = AssembleResult & {
  stopSending: false
  prompt: Omit<PromptEvent, 'type'>
}

export interface GenerationClientCapabilities {
  compactPromptEvent: boolean
  promptMetadataOnly: boolean
  omitDuplicateDoneResult: boolean
  hypaContextTruncationConfirmation: boolean
  regenerateTargetProjection: boolean
}

type PromptAssemblyRun = Awaited<ReturnType<typeof assemblePromptWithMetrics>>
type MetricPrimitive = string | number | boolean | null | undefined
type PromptAssemblyMetricContext = Record<string, MetricPrimitive>

type AssemblyPreflightResult =
  | { status: 'ready'; hypaContextTruncationCheckRequired: boolean }
  | { status: 'handled' }
  | { status: 'defer'; failure: AssemblyDeferredFailure }

type GenerationSettingsPreflightResult =
  | Exclude<AssemblyPreflightResult, { status: 'handled' }>
  | { status: 'rejected'; statusCode: number; body: unknown }

interface AssemblyDeferredFailure {
  error: unknown
}

export interface ChatProviderDispatchContext {
  input: AssembleInput
  result: SuccessfulAssembleResult
  database: Database
  generationId: string
  generationInfo: Record<string, unknown>
  signal: AbortSignal
  trace?: GenerationTraceContext
  /** Explicit primary/fallback profile selected by the request-policy wrapper. */
  profile?: ResolvedModelProfile
  /** Retry/fallback identity attached by the request-policy wrapper. */
  historyMetadata?: Record<string, unknown>
  /** Dispatch-time request model selected from a provider sentinel. */
  resolvedRequestModel?: string
  /** Durable-operation fence, invoked after awaited request transforms and immediately before each provider call. */
  beforeProviderDispatch?: () => void
}

export type ChatProviderDispatcher = (
  context: ChatProviderDispatchContext,
) =>
  | AsyncIterable<CompletionStreamFrame>
  | Promise<AsyncIterable<CompletionStreamFrame> | null | undefined>
  | null
  | undefined

export interface GenerationChatRouteOptions {
  dispatchProvider?: ChatProviderDispatcher
  /** Test/alternate adapter seam; production uses the shared server embedding adapter. */
  embedPromptMemoryQueryTexts?: PrefetchPromptMemoryQueryInput['embed']
  /** Contextual-model counterpart to `embedPromptMemoryQueryTexts`. */
  embedPromptMemoryQueryGroups?: PrefetchPromptMemoryQueryInput['embedGroups']
  /** Bounded query-embedding deadline; defaults to the shared memory-provider deadline. */
  promptMemoryEmbeddingDeadlineMs?: number
  pushNotifications?: false | PushNotificationService
  runMessageTranslation?: ServerMessageTranslationRunner
  onPromptMemoryJobEnqueued?: (job: MemoryJob) => void
  onBardWikiJobEnqueued?: (job: BardWikiJobSummary) => void
  finalizationRetry?:
    | false
    | {
        intervalMs?: number
        maxPerSweep?: number
        baseDelayMs?: number
        maxDelayMs?: number
      }
  /**
   * Cadence of the durable viewer's SSE comment heartbeat.
   * Defaults to the job's `heartbeatSec`; injectable for tests.
   */
  viewerHeartbeatMs?: number
  /** Deterministic lifecycle seam for fault-injection tests. */
  onDurableLifecycleTransition?: (
    transition:
      | 'registered'
      | 'viewer_write_started'
      | 'viewer_attached'
      | 'runner_tracked'
      | 'cancel_persistence_started',
    job: StreamJob,
  ) => void | Promise<void>
}

export interface GenerationFinalizationRetryLogger {
  warn(obj: Record<string, unknown>, msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

function fallbackProfileDatabase(database: Database, profileId: string): Database {
  return {
    ...database,
    modelRoleProfiles: { ...database.modelRoleProfiles, chatMain: { mode: 'profile', profileId } },
  }
}

function resolvePolicyProfiles(database: Database, resolvedPrimary?: ResolvedModelProfile): ResolvedModelProfile[] {
  const primary = resolvedPrimary ?? resolveModelProfile({ database, role: 'chatMain' })
  const profiles = [primary]
  for (const fallback of primary.fallbacks) {
    try {
      const resolved = resolvePolicyFallback(database, fallback)
      if (
        resolved &&
        !profiles.some((profile) => profile.profileId === resolved.profileId && profile.modelId === resolved.modelId)
      ) {
        profiles.push(resolved)
      }
    } catch {
      // An invalid fallback must not suppress the primary model or later valid fallbacks.
    }
  }
  return profiles
}

function resolvePolicyFallback(database: Database, fallback: ModelProfileFallbackRef): ResolvedModelProfile | null {
  if (fallback.kind === 'legacy-model-id') {
    return resolveModelProfile({ database, role: 'chatMain', staticModel: fallback.modelId })
  }
  return resolveModelProfile({ database: fallbackProfileDatabase(database, fallback.profileId), role: 'chatMain' })
}

function configuredRequestRetries(database: Database): number {
  const value = typeof database.requestRetrys === 'number' ? Math.floor(database.requestRetrys) : 0
  return Math.max(0, Math.min(value, 20))
}

function halfStreamingTokenProgress(database: Database, startedAt: number) {
  if (database.halfStreaming !== true) return undefined
  return {
    startedAt,
    countTokens: (content: string) => tokenize(content, tokenizerEncodingFromDb(database)),
  }
}

function materializePolicyProfileDatabase(
  database: Database,
  profile: ResolvedModelProfile,
  forceNonStreaming: boolean,
): Database {
  const effective: Database = { ...database }
  applyProfileBoundGenerationFields(effective, profile)
  if (forceNonStreaming) {
    effective.halfStreaming = false
    effective.useStreaming = false
  }
  return effective
}

function markPolicyProfileSuccess(
  context: ChatProviderDispatchContext,
  database: Database,
  profile: ResolvedModelProfile,
): void {
  context.generationInfo.model = getServerGenerationModelString(database, profile, context.resolvedRequestModel)
  if (typeof database.maxContext === 'number') context.generationInfo.maxContext = database.maxContext
}

function containsBannedScript(text: string, scripts: unknown): boolean {
  if (!Array.isArray(scripts) || text.length === 0) return false
  for (const script of scripts) {
    if (typeof script !== 'string' || script.length === 0) continue
    try {
      if (new RegExp(`\\p{Script=${script}}`, 'u').test(text)) return true
    } catch {
      // Ignore invalid Unicode script names retained in imported settings.
    }
  }
  return false
}

function escapedRows(rows: PromptMessage[], escape: boolean): PromptMessage[] {
  const cloned = structuredClone(rows)
  if (!escape) return cloned
  for (const row of cloned) row.content = risuUnescape(row.content)
  return cloned
}

function transformEscapedFrames(frames: CompletionStreamFrame[], escape: boolean): CompletionStreamFrame[] {
  if (!escape) return frames
  return frames.map((frame) =>
    frame.kind === 'token'
      ? { ...frame, content: risuEscape(frame.content ?? '') }
      : frame.kind === 'done' && frame.alternates
        ? { ...frame, alternates: frame.alternates.map(risuEscape) }
        : frame,
  )
}

/**
 * Retained request wrapper policies around the server-owned provider dispatch.
 * Streaming remains live after the first token; failures before that boundary
 * can be retried safely. Non-stream results are buffered so blank/banned-output
 * policies can decide before anything reaches the client.
 */
function dispatchProviderWithPolicies(
  context: ChatProviderDispatchContext,
  dispatcher: ChatProviderDispatcher,
): AsyncIterable<CompletionStreamFrame> {
  return (async function* () {
    const state = context.result.state
    const escape = state?.currentChar.escapeOutput === true
    // Accepted divergence (OR-3): unlike baseline request.ts:222, each same-model
    // retry starts from these untransformed rows instead of accumulating request
    // trigger rewrites from the preceding attempt.
    const baseRows = escapedRows(context.result.formated ?? context.result.prompt.formated ?? [], escape)
    const policyDatabase = context.database
    const profiles = resolvePolicyProfiles(policyDatabase, state?.resolvedMainProfile)
    const retries = configuredRequestRetries(policyDatabase)
    const requiresBufferedInspection =
      escape ||
      (Array.isArray(policyDatabase.banCharacterset) && policyDatabase.banCharacterset.length > 0) ||
      (policyDatabase.fallbackWhenBlankResponse === true && profiles.length > 1)
    let lastFailure: CompletionStreamFrame | undefined

    for (let profileIndex = 0; profileIndex < profiles.length; profileIndex++) {
      const profile = profiles[profileIndex]
      // Assembly already materialized the primary profile and then applied the
      // chat prompt preset's explicit overrides. Reapplying it here would erase
      // those final overrides; only fallback profiles need fresh materialization.
      const database =
        profileIndex === 0
          ? escape
            ? { ...policyDatabase, halfStreaming: false, useStreaming: false }
            : policyDatabase
          : materializePolicyProfileDatabase(policyDatabase, profile, escape)
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (context.signal.aborted) return
        const requestRows = state
          ? await applyRequestTrigger(state, structuredClone(baseRows))
          : structuredClone(baseRows)
        const attemptContext: ChatProviderDispatchContext = {
          ...context,
          database,
          profile,
          historyMetadata: {
            attempt: attempt + 1,
            retryCount: retries,
            fallbackIndex: profileIndex,
            fallbackCount: profiles.length - 1,
          },
          result: {
            ...context.result,
            outputTokens: context.result.outputTokens,
            formated: requestRows,
            prompt: { ...context.result.prompt, formated: requestRows },
          },
        }
        let iterable: AsyncIterable<CompletionStreamFrame> | null | undefined
        attemptContext.beforeProviderDispatch?.()
        recordDiagnosticEvent({
          category: 'generation',
          level: 'info',
          stage: 'dispatch',
          outcome: 'pending',
          providerMayHaveRun: true,
        })
        try {
          iterable = await dispatcher(attemptContext)
        } catch (error) {
          lastFailure = {
            kind: 'error',
            error: errorMessage(error, PROVIDER_DISPATCH_FALLBACK),
            reason: 'provider_dispatch_exception',
          }
          continue
        }
        if (!iterable) {
          lastFailure = { kind: 'error', error: PROVIDER_DISPATCH_FALLBACK }
          continue
        }

        if (!requiresBufferedInspection) {
          let emittedToken = false
          let retry = false
          try {
            for await (const frame of iterable) {
              if (frame.kind === 'token') {
                // Hidden reasoning can report progress without delivering an
                // answer. Preserve pre-visible-token retry/blank policy.
                if ((frame.content?.length ?? 0) > 0) {
                  emittedToken = true
                  markPolicyProfileSuccess(attemptContext, database, profile)
                }
                yield frame
                continue
              }
              if (frame.kind === 'error' && !emittedToken) {
                lastFailure = frame
                if (frame.nonRetryable === true) {
                  yield frame
                  return
                }
                retry = true
                break
              }
              if (
                frame.kind === 'done' &&
                !emittedToken &&
                database.fallbackWhenBlankResponse === true &&
                profileIndex < profiles.length - 1
              ) {
                retry = true
                attempt = retries
                break
              }
              if (frame.kind === 'done') markPolicyProfileSuccess(attemptContext, database, profile)
              yield frame
              if (frame.kind === 'done' || frame.kind === 'error') return
            }
          } catch (error) {
            const failure: CompletionStreamFrame = {
              kind: 'error',
              error: errorMessage(error, PROVIDER_DISPATCH_FALLBACK),
              reason: 'provider_dispatch_exception',
            }
            if (emittedToken) {
              throw error
            }
            lastFailure = failure
            retry = true
          }
          if (!retry) return
          continue
        }

        const buffered: CompletionStreamFrame[] = []
        let text = ''
        let failed = false
        try {
          for await (const frame of iterable) {
            // Output inspection can withhold text, but scalar progress is safe
            // to forward even while an attempt is awaiting acceptance.
            if (frame.kind === 'token' && frame.tokenCount !== undefined) {
              yield { kind: 'token', content: '', tokenCount: frame.tokenCount }
              if ((frame.content?.length ?? 0) > 0) buffered.push({ ...frame, tokenCount: 0 })
            } else {
              buffered.push(frame)
            }
            if (frame.kind === 'token') text += frame.content ?? ''
            if (frame.kind === 'error') {
              lastFailure = frame
              failed = true
              break
            }
          }
        } catch (error) {
          lastFailure = { kind: 'error', error: errorMessage(error, PROVIDER_DISPATCH_FALLBACK) }
          failed = true
        }
        if (failed) {
          if (lastFailure?.kind === 'error' && lastFailure.nonRetryable === true) {
            yield lastFailure
            return
          }
          continue
        }

        const transformed = transformEscapedFrames(buffered, escape)
        const transformedText = escape ? risuEscape(text) : text
        if (containsBannedScript(transformedText, database.banCharacterset)) {
          lastFailure = {
            kind: 'error',
            error: 'Provider response contained a banned character set after all configured retries.',
            reason: 'provider_output_banned',
          }
          continue
        }
        if (
          transformedText.trim().length === 0 &&
          database.fallbackWhenBlankResponse === true &&
          profileIndex < profiles.length - 1
        ) {
          attempt = retries
          continue
        }
        markPolicyProfileSuccess(attemptContext, database, profile)
        yield* transformed
        return
      }
    }

    yield lastFailure ?? { kind: 'error', error: 'All configured models failed.' }
  })()
}

interface GenerationFinalizationSnapshotRow {
  message: Message
}

export type GenerationFinalizationTargetSnapshot =
  | {
      mode: GenerationFinalizationMode
      kind: 'tail'
      transcriptLength: number
      tail?: GenerationFinalizationSnapshotRow
    }
  | {
      mode: GenerationFinalizationMode
      kind: 'target-tail'
      transcriptLength: number
      target: GenerationFinalizationSnapshotRow
    }

function badRequest(reply: FastifyReply, error: string): void {
  reply.code(400).send({ error })
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function readGenerationClientCapabilities(body: ChatRequestBody): GenerationClientCapabilities {
  const clientCapabilities = body.clientCapabilities
  return {
    compactPromptEvent: isRecord(clientCapabilities) && clientCapabilities.compactPromptEvent === true,
    promptMetadataOnly: isRecord(clientCapabilities) && clientCapabilities.promptMetadataOnly === true,
    omitDuplicateDoneResult: isRecord(clientCapabilities) && clientCapabilities.omitDuplicateDoneResult === true,
    hypaContextTruncationConfirmation:
      isRecord(clientCapabilities) && clientCapabilities.hypaContextTruncationConfirmation === true,
    regenerateTargetProjection: isRecord(clientCapabilities) && clientCapabilities.regenerateTargetProjection === 1,
  }
}

function promptEventForClient(
  prompt: Omit<PromptEvent, 'type'>,
  capabilities: GenerationClientCapabilities,
  mode?: AssembleInput['mode'],
): Omit<PromptEvent, 'type'> {
  if (!capabilities.compactPromptEvent) return prompt
  if (mode === 'preview_prompt') {
    const promptText = prompt.promptInfo?.promptText
    const previewRows =
      Array.isArray(promptText) && promptText.length > 0
        ? promptText
        : Array.isArray(prompt.formated)
          ? prompt.formated
          : (prompt.messages ?? [])
    return {
      promptInfo: {
        promptText: typeof promptText === 'string' ? promptText : JSON.stringify(previewRows),
      },
    }
  }
  const { messages: _messages, lorebookActivation: _lorebookActivation, ...compactPrompt } = prompt
  if (capabilities.promptMetadataOnly && mode !== undefined && isPersistingMode(mode)) {
    return compactPrompt.promptInfo === undefined ? {} : { promptInfo: compactPrompt.promptInfo }
  }
  return compactPrompt
}

function emitAssemblyWarnings(result: AssembleResult, emit: (event: PromptChatEvent) => void): void {
  for (const warning of result.warnings ?? []) {
    emit({ type: 'warning', ...warning })
  }
}

function messagePatchForClient(
  mutations: AssembleMutationPayload,
  capabilities: GenerationClientCapabilities,
): AssembleMutationPayload {
  if (!capabilities.compactPromptEvent) return mutations
  let changed = false
  const messageMutations = mutations.messageMutations.map((mutation) => {
    if (mutation.type !== 'replace_all') return mutation
    const firstChangedIndex = getMessageMutationFirstChangedIndex(mutation)
    if (firstChangedIndex === undefined || firstChangedIndex <= 0 || firstChangedIndex > mutation.messages.length) {
      return mutation
    }
    changed = true
    return {
      ...mutation,
      firstChangedIndex,
      messages: mutation.messages.slice(firstChangedIndex),
    }
  })
  return changed ? { ...mutations, messageMutations } : mutations
}

function mutationPayloadHasVisibleChanges(mutations: AssembleMutationPayload | undefined): boolean {
  return !!(
    mutations &&
    (mutations.messageMutations.length > 0 ||
      mutations.chatVarMutations.length > 0 ||
      (mutations.chatMetadataMutations?.length ?? 0) > 0 ||
      (mutations.characterFieldMutations?.length ?? 0) > 0 ||
      mutations.localLoreMutation !== undefined)
  )
}

function assemblyPatchForClient(args: {
  result: AssembleResult
  persistence?: PersistedAssemblyMutations
  capabilities: GenerationClientCapabilities
  useRegenerateTargetProjection: boolean
}): AssembleMutationPayload | undefined {
  if (!args.useRegenerateTargetProjection) {
    return args.result.mutations ? messagePatchForClient(args.result.mutations, args.capabilities) : undefined
  }
  const source = args.persistence?.patch
  return mutationPayloadHasVisibleChanges(source) ? messagePatchForClient(source!, args.capabilities) : undefined
}

function validate(body: ChatRequestBody): { ok: true } | { ok: false; error: string } {
  if (!isNonEmptyString(body.chatId)) return { ok: false, error: 'chatId is required' }
  if (!isNonEmptyString(body.characterId)) {
    return { ok: false, error: 'characterId is required' }
  }
  if (!isNonEmptyString(body.mode) || !ALLOWED_MODES.has(body.mode)) {
    return {
      ok: false,
      error: 'mode must be one of: send, continue, preview, preview_prompt, regenerate',
    }
  }
  if (body.emptySend !== undefined && typeof body.emptySend !== 'boolean') {
    return { ok: false, error: 'emptySend must be a boolean when provided' }
  }
  if (body.emptySend === true && (body.mode !== 'send' || body.userMessage !== undefined)) {
    return { ok: false, error: 'emptySend requires mode "send" without userMessage' }
  }
  if (body.mode === 'send' && !isNonEmptyString(body.userMessage) && body.emptySend !== true) {
    return { ok: false, error: 'userMessage or emptySend is required when mode is "send"' }
  }
  if (body.syntheticSayNothing !== undefined && typeof body.syntheticSayNothing !== 'boolean') {
    return { ok: false, error: 'syntheticSayNothing must be a boolean when provided' }
  }
  if (body.syntheticSayNothing === true && (body.mode !== 'send' || body.userMessage !== '*says nothing*')) {
    return {
      ok: false,
      error: 'syntheticSayNothing requires mode "send" and the say-nothing sentinel',
    }
  }
  if (body.mode === 'regenerate' && !isNonEmptyString(body.regenerateMessageId)) {
    return {
      ok: false,
      error: 'regenerateMessageId is required when mode is "regenerate"',
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'presetId')) {
    return {
      ok: false,
      error: 'presetId is not supported; use chat generationSettings modelPresetId and promptPresetId',
    }
  }
  if (body.loadoutId !== undefined && typeof body.loadoutId !== 'string') {
    return { ok: false, error: 'loadoutId must be a string when provided' }
  }
  if (body.resetMessages !== undefined && typeof body.resetMessages !== 'boolean') {
    return { ok: false, error: 'resetMessages must be a boolean when provided' }
  }
  if (body.expectedRevision !== undefined && typeof body.expectedRevision !== 'number') {
    return { ok: false, error: 'expectedRevision must be a number when provided' }
  }
  if (body.inlayAssets !== undefined && !Array.isArray(body.inlayAssets)) {
    return { ok: false, error: 'inlayAssets must be an array when provided' }
  }
  if (body.inlayAssetRefs !== undefined && !Array.isArray(body.inlayAssetRefs)) {
    return { ok: false, error: 'inlayAssetRefs must be an array when provided' }
  }
  if (body.durable !== undefined && typeof body.durable !== 'boolean') {
    return { ok: false, error: 'durable must be a boolean when provided' }
  }
  return { ok: true }
}

/**
 * Validation for the preview-prompt shortcut. The mode is forced to
 * `preview_prompt`, so the `send` / `regenerate` / mode-enum rules in
 * `validate` do not apply — only the scope IDs are required, plus the
 * shared optional-field type checks.
 */
function validatePreview(body: ChatRequestBody): { ok: true } | { ok: false; error: string } {
  if (!isNonEmptyString(body.chatId)) return { ok: false, error: 'chatId is required' }
  if (!isNonEmptyString(body.characterId)) {
    return { ok: false, error: 'characterId is required' }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'presetId')) {
    return {
      ok: false,
      error: 'presetId is not supported; use chat generationSettings modelPresetId and promptPresetId',
    }
  }
  if (body.loadoutId !== undefined && typeof body.loadoutId !== 'string') {
    return { ok: false, error: 'loadoutId must be a string when provided' }
  }
  if (body.expectedRevision !== undefined && typeof body.expectedRevision !== 'number') {
    return { ok: false, error: 'expectedRevision must be a number when provided' }
  }
  if (body.inlayAssets !== undefined && !Array.isArray(body.inlayAssets)) {
    return { ok: false, error: 'inlayAssets must be an array when provided' }
  }
  if (body.inlayAssetRefs !== undefined && !Array.isArray(body.inlayAssetRefs)) {
    return { ok: false, error: 'inlayAssetRefs must be an array when provided' }
  }
  if (body.syntheticSayNothing !== undefined && typeof body.syntheticSayNothing !== 'boolean') {
    return { ok: false, error: 'syntheticSayNothing must be a boolean when provided' }
  }
  return { ok: true }
}

// Disconnect + generous-deadline abort plumbing shared with the
// standalone generation routes; see `requestAbort.ts`.

/** Map a validated request body to the assembler input contract. */
export function toChatGenerationAssembleInput(body: ChatRequestBody): AssembleInput {
  return {
    chatId: body.chatId as string,
    characterId: body.characterId as string,
    mode: body.mode as AssembleInput['mode'],
    loadoutId: typeof body.loadoutId === 'string' ? body.loadoutId : undefined,
    regenerateMessageId: typeof body.regenerateMessageId === 'string' ? body.regenerateMessageId : undefined,
    userMessage: typeof body.userMessage === 'string' ? body.userMessage : undefined,
    emptySend: body.emptySend === true ? true : undefined,
    syntheticSayNothing: body.syntheticSayNothing === true ? true : undefined,
    resetMessages: typeof body.resetMessages === 'boolean' ? body.resetMessages : undefined,
    expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined,
    inlayAssets: Array.isArray(body.inlayAssets) ? body.inlayAssets : undefined,
    inlayAssetRefs: Array.isArray(body.inlayAssetRefs) ? body.inlayAssetRefs : undefined,
    clientContext: normalizeReportedClientContext(body.clientContext),
  }
}

/**
 * The assembler dependency surface bound to the persisted store. The
 * route owns the storage import so `assemble.ts` stays
 * storage-global-free. The loaded database reference is kept for provider
 * dispatch and mutation event payloads; durable chat-var persistence is
 * performed by the route itself through `persistAssemblyChatVars`
 * through the same JSON-command machinery the scriptstate command uses.
 */
interface RouteAssembleDeps extends AssembleDeps {
  getDatabase(): Database | null
  setPromptMemoryQueryPrefetch(prefetch: PromptMemoryQueryPrefetchResult): void
}

interface PromptAssemblyMeasurement {
  databaseLoadCount: number
  databaseLoadMs: number
  promptMemoryPrefetchMs: number
  stageTimingsMs: Partial<Record<PromptAssemblyStage, number>>
}

function addMeasurementMs(measurement: PromptAssemblyMeasurement, key: PromptAssemblyStage, durationMs: number): void {
  measurement.stageTimingsMs[key] = Math.round(((measurement.stageTimingsMs[key] ?? 0) + durationMs) * 100) / 100
}

const LOCAL_ASSET_PATH_RE = /^assets\/([a-f0-9]{64})\.[a-z0-9]+$/i

/**
 * Resolve an asset reference to its sha256 store id. Accepts either a bare id or
 * the `assets/<id>.<ext>` path form, mirroring the browser's
 * `serverAssetIdFromReference` (`src/ts/server/assets.ts`) and the risuSave
 * reference collector (`risuSave/assetReferences.ts`).
 */
function assetIdFromReference(reference: string): string | null {
  if (isValidAssetId(reference)) return reference
  return LOCAL_ASSET_PATH_RE.exec(reference)?.[1] ?? null
}

/**
 * Read an `{{asset_prompt::}}` / char-icon reference from the on-disk assets
 * store and re-wrap it as a `data:image/png;base64,` URI. Hardcoding the
 * png mime keeps byte-parity with the browser's `readImage(asset[1])` path
 * (`formatHistoryMessage.ts`), which does the same regardless of the
 * stored content-type. Returns `undefined` for an unresolvable reference so the
 * marker is stripped without bytes when assets are missing.
 */
function multimodalTypeFromContentType(contentType: string): PromptMultimodal['type'] | null {
  if (contentType === SERVER_INLAY_SIGNATURE_CONTENT_TYPE) return 'signature'
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('audio/')) return 'audio'
  if (contentType.startsWith('video/')) return 'video'
  return null
}

type StoredAssetReader = (
  db: DatabaseSync,
  dataDir: string,
  id: string,
  purpose: StoredAssetPurpose,
) => PromptMultimodal | undefined | Promise<PromptMultimodal | undefined>

function cloneStoredAssetResult(result: PromptMultimodal | undefined): PromptMultimodal | undefined {
  return result ? { ...result } : undefined
}

async function readAssetBytes(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.promises.readFile(file)
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw err
  }
}

async function readStoredAsset(
  db: DatabaseSync,
  dataDir: string,
  id: string,
  purpose: StoredAssetPurpose,
): Promise<PromptMultimodal | undefined> {
  const entry = assetById(db, id)
  if (!entry) return undefined
  const file = assetPath(dataDir, entry)
  const bytes = await readAssetBytes(file)
  if (!bytes) return undefined
  if (purpose === 'asset_prompt') {
    return { type: 'image', base64: `data:image/png;base64,${bytes.toString('base64')}` }
  }
  const type = multimodalTypeFromContentType(entry.contentType)
  if (!type) return undefined
  if (type === 'signature') {
    return { type, base64: bytes.toString('utf8') }
  }
  return { type, base64: `data:${entry.contentType};base64,${bytes.toString('base64')}` }
}

export function createRequestScopedStoredAssetResolver(
  db: DatabaseSync,
  dataDir: string,
  read: StoredAssetReader = readStoredAsset,
): ResolveStoredAsset {
  const cache = new Map<string, Promise<PromptMultimodal | undefined>>()
  return async (reference, purpose) => {
    const id = assetIdFromReference(reference)
    if (!id) return undefined
    const cacheKey = `${purpose}:${id}`
    let pending = cache.get(cacheKey)
    if (!pending) {
      pending = Promise.resolve(read(db, dataDir, id, purpose)).catch((err) => {
        cache.delete(cacheKey)
        throw err
      })
      cache.set(cacheKey, pending)
    }
    const resolved = await pending
    return cloneStoredAssetResult(resolved)
  }
}

/** A fresh factory belongs to one preparation phase. Accepted sends and retries
 * create another factory after their own revision/append boundary. */
export function createGenerationAssemblyResources(
  db: DatabaseSync,
  dataDir: string,
  target: Pick<AssembleInput, 'characterId' | 'chatId'>,
): { loadDatabase(): Database | null; resolveSpeakerName(characterId: string): string | undefined } {
  let database: Database | null = null
  let loaded = false
  const speakerNames = new Map<string, string | undefined>()
  return {
    loadDatabase() {
      if (loaded) return database
      const persisted = loadPersistedForGenerationAssembly(db, dataDir, target)
      if (persisted.database === null && persisted.missingTarget && persisted.missingTarget !== 'database') {
        throw new EntityNotFoundError(generationTargetMissingMessage(persisted.missingTarget, target))
      }
      database = persisted.database === null ? null : decodeGenerationDatabase(persisted.database)
      for (const [id, name] of Object.entries(persisted.speakerNames ?? {})) speakerNames.set(id, name)
      for (const owner of database?.characters ?? []) speakerNames.set(owner.chaId, owner.name)
      loaded = true
      return database
    },
    resolveSpeakerName(characterId) {
      return speakerNames.get(characterId)
    },
  }
}

function generationTargetMissingMessage(
  missing: 'database' | 'character' | 'chat' | undefined,
  target: Pick<AssembleInput, 'characterId' | 'chatId'>,
): string {
  if (missing === 'character') return `character not found: ${target.characterId}`
  if (missing === 'chat') return `chat not found: ${target.chatId}`
  return 'database not found'
}

function loadDatabaseDeps(
  dataDir: string,
  db: DatabaseSync,
  target: Pick<AssembleInput, 'characterId' | 'chatId'>,
  measurement?: PromptAssemblyMeasurement,
  signal?: AbortSignal,
  agentPresetProgress?: AgentPresetProgressReporter,
): RouteAssembleDeps {
  let database: Database | null = null
  let databaseLoaded = false
  let promptMemoryQueryPrefetch: PromptMemoryQueryPrefetchResult = {
    vectors: [],
    diagnostics: emptyPromptMemoryQueryDiagnostics(),
  }
  const resolveStoredAsset = createRequestScopedStoredAssetResolver(db, dataDir)
  const resources = createGenerationAssemblyResources(db, dataDir, target)
  return {
    signal,
    assetDataDir: dataDir,
    agentPresetProgress,
    loadDatabase: () => {
      if (databaseLoaded) return database
      databaseLoaded = true
      const startedAt = measurement ? protocolNowMs() : 0
      database = resources.loadDatabase()
      if (measurement) {
        measurement.databaseLoadCount += 1
        measurement.databaseLoadMs += protocolDurationMs(startedAt)
      }
      return database
    },
    loadMemoryDatabase: () => db,
    loadPromptMemoryQueryVectors: () => promptMemoryQueryPrefetch.vectors,
    loadPromptMemoryQueryDiagnostics: () => promptMemoryQueryPrefetch.diagnostics,
    onPromptMemoryJobEnqueued: undefined,
    setPromptMemoryQueryPrefetch: (prefetch) => {
      promptMemoryQueryPrefetch = prefetch
    },
    getDatabase: () => database,
    resolveStoredAsset,
    resolveSpeakerName: resources.resolveSpeakerName,
    recordAssemblyStageTiming: measurement
      ? (stage, durationMs) => addMeasurementMs(measurement, stage, durationMs)
      : undefined,
  }
}

async function assemblePromptWithMetrics(
  input: AssembleInput,
  dataDir: string,
  db: DatabaseSync,
  signal?: AbortSignal,
  context: PromptAssemblyMetricContext = {},
  agentPresetProgress?: AgentPresetProgressReporter,
  options: GenerationChatRouteOptions = {},
): Promise<{ result: AssembleResult; deps: RouteAssembleDeps; promptMs: number; stage2Ms: number }> {
  const measurement: PromptAssemblyMeasurement = {
    databaseLoadCount: 0,
    databaseLoadMs: 0,
    promptMemoryPrefetchMs: 0,
    stageTimingsMs: {},
  }
  const metricStartedAt = protocolNowMs()
  recordDiagnosticEvent({
    category: 'generation',
    level: 'info',
    stage: 'assembly',
    outcome: 'pending',
    providerMayHaveRun: false,
  })
  const startedAt = Date.now()
  const deps = loadDatabaseDeps(dataDir, db, input, measurement, signal, agentPresetProgress)
  deps.onPromptMemoryJobEnqueued = options.onPromptMemoryJobEnqueued
  try {
    const database = deps.loadDatabase()
    const promptMemoryPrefetchStartedAt = protocolNowMs()
    deps.setPromptMemoryQueryPrefetch(
      database && !suppressesHypaPromptWork(db, database, input.chatId)
        ? await prefetchPromptMemoryQueryVectors({
            db,
            database,
            input,
            signal,
            deadlineMs: options.promptMemoryEmbeddingDeadlineMs,
            embed: options.embedPromptMemoryQueryTexts,
            embedGroups: options.embedPromptMemoryQueryGroups,
          })
        : {
            vectors: [],
            diagnostics: emptyPromptMemoryQueryDiagnostics(options.promptMemoryEmbeddingDeadlineMs),
          },
    )
    measurement.promptMemoryPrefetchMs = protocolDurationMs(promptMemoryPrefetchStartedAt)
    const result = await assemblePrompt(input, deps)
    const promptMs = Date.now() - startedAt
    const stage2Ms =
      result.state?.promptMemoryChunkPlanningDiagnostics?.attempted === true
        ? Math.max(0, Math.round(measurement.promptMemoryPrefetchMs + (measurement.stageTimingsMs.memory_bridge ?? 0)))
        : 0
    recordPromptDiagnostic(result, protocolDurationMs(metricStartedAt))
    emitProtocolMetric('generation_prompt_assembly', {
      status: result.stopSending ? 'stopped' : 'ok',
      ...context,
      chatId: input.chatId,
      characterId: input.characterId,
      mode: input.mode,
      durationMs: protocolDurationMs(metricStartedAt),
      promptMs,
      databaseLoadCount: measurement.databaseLoadCount,
      databaseLoadMs: Math.round(measurement.databaseLoadMs * 100) / 100,
      stageTimingsMs: measurement.stageTimingsMs,
      ...assemblyDiagnosticMetricFields(result),
      ...(result.stopSending ? { stopReason: result.abortReason ?? 'unknown' } : {}),
    })
    return { result, deps, promptMs, stage2Ms }
  } catch (err) {
    recordDiagnosticEvent({
      category: 'prompt',
      level: 'error',
      outcome: 'error',
      durationMs: protocolDurationMs(metricStartedAt),
      truncation: 'unknown',
    })
    recordDiagnosticEvent({
      category: 'generation',
      level: 'error',
      stage: 'assembly',
      outcome: 'failed',
      providerMayHaveRun: false,
      durationMs: protocolDurationMs(metricStartedAt),
    })
    emitProtocolMetric('generation_prompt_assembly', {
      status: 'error',
      ...context,
      chatId: input.chatId,
      characterId: input.characterId,
      mode: input.mode,
      durationMs: protocolDurationMs(metricStartedAt),
      promptMs: Date.now() - startedAt,
      databaseLoadCount: measurement.databaseLoadCount,
      databaseLoadMs: Math.round(measurement.databaseLoadMs * 100) / 100,
      stageTimingsMs: measurement.stageTimingsMs,
      error: errorMessage(err, 'prompt assembly failed'),
    })
    throw err
  }
}

/** Select structural facts directly; raw prompt summaries also contain content hashes. */
function recordPromptDiagnostic(result: AssembleResult, durationMs: number): void {
  if (!diagnosticsContextEnabled()) return
  try {
    const rows = result.formated ?? result.prompt?.formated
    const roles = { system: 0, user: 0, assistant: 0, tool: 0, other: 0 }
    const media = { image: 0, audio: 0, video: 0, other: 0 }
    for (const row of rows ?? []) {
      if (row.role === 'system' || row.role === 'user' || row.role === 'assistant') roles[row.role] += 1
      else if (row.role === 'function') roles.tool += 1
      else roles.other += 1
      for (const modal of row.multimodals ?? []) {
        if (modal.type === 'image' || modal.type === 'audio' || modal.type === 'video') media[modal.type] += 1
        else media.other += 1
      }
    }
    recordDiagnosticEvent({
      category: 'prompt',
      level: result.stopSending ? 'warn' : 'info',
      outcome: result.stopSending ? 'stopped' : 'ok',
      durationMs,
      ...(rows ? { rows: rows.length, roles, media } : {}),
      inputTokens: result.inputTokens,
      budgetTokens: result.state?.database.maxContext,
      truncation: result.state ? (result.state.historyTruncated === true ? 'applied' : 'none') : 'unknown',
      selectedMemoryCount:
        result.state?.bardWikiPromptDiagnostics?.selectedCount ??
        result.state?.promptMemoryRowAssemblyDiagnostics?.inputSummaries,
      loreEntryCount: result.state?.report?.actives.length,
    })
  } catch {
    // Shape inspection must never affect prompt assembly or expose a text fallback.
  }
}

function suppressesHypaPromptWork(db: DatabaseSync, database: Database, chatId: string): boolean {
  const settings = resolveEffectiveBardWikiSettings(
    readBardWikiGlobalSettings(database.bardWiki),
    getBardWikiChatSettings(db, chatId),
  )
  return settings.enabledByDefault && settings.memoryMode === 'bardwiki'
}

function inspectChatGenerationSettings(
  input: AssembleInput,
  dataDir: string,
  db: DatabaseSync,
): GenerationSettingsPreflightResult {
  try {
    const loaded = loadPersistedForGenerationPreflight(db, dataDir, input)
    if (!loaded.preflightInputs) {
      const message = generationTargetMissingMessage(loaded.missingTarget, input)
      return { status: 'defer', failure: { error: new EntityNotFoundError(message) } }
    }
    const selected = decodeGenerationPreflightInputs(loaded.preflightInputs)
    const effective = resolveGenerationPreflightConfiguration(selected)
    return {
      status: 'ready',
      hypaContextTruncationCheckRequired:
        isPersistingMode(input.mode) &&
        !(effective.database.hypaV3 === true && selected.currentChar.supaMemory === true) &&
        selected.currentChat.hypaContextTruncationAcknowledged !== true,
    }
  } catch (err) {
    if (isChatGenerationSettingsIncompleteAssemblyError(err)) {
      return { status: 'rejected', statusCode: err.statusCode, body: err.body }
    }
    if (isModelProfileGenerationGuardAssemblyError(err)) {
      return { status: 'rejected', statusCode: err.statusCode, body: err.body }
    }
    if (err instanceof GenerationInputValidationError) {
      return { status: 'rejected', statusCode: 400, body: { error: err.message } }
    }
    return { status: 'defer', failure: { error: err } }
  }
}

function preflightChatGenerationSettings(
  reply: FastifyReply,
  input: AssembleInput,
  dataDir: string,
  db: DatabaseSync,
): AssemblyPreflightResult {
  const result = inspectChatGenerationSettings(input, dataDir, db)
  if (result.status === 'rejected') {
    recordDiagnosticEvent({
      category: 'generation',
      level: 'warn',
      stage: 'accepted',
      outcome: 'rejected',
      providerMayHaveRun: false,
    })
    reply.code(result.statusCode).send(result.body)
    return { status: 'handled' }
  }
  return result
}

/** Synchronous settings gate used before the accepted-send transaction commits. */
export function preflightGenerationOperationSettings(
  input: AssembleInput,
  dataDir: string,
  db: DatabaseSync,
): { status: 'ready' } | { status: 'rejected'; statusCode: number; body: unknown } {
  const result = inspectChatGenerationSettings(input, dataDir, db)
  if (result.status === 'rejected') {
    recordDiagnosticEvent({
      category: 'generation',
      level: 'warn',
      stage: 'accepted',
      outcome: 'rejected',
      providerMayHaveRun: false,
    })
  }
  return result.status === 'rejected' ? result : { status: 'ready' }
}

function sendAssemblyHttpError(reply: FastifyReply, err: unknown): boolean {
  if (isAgentPresetGenerationError(err)) {
    reply.code(err.statusCode).send(err.body)
    return true
  }
  if (isChatGenerationSettingsIncompleteAssemblyError(err)) {
    reply.code(err.statusCode).send(err.body)
    return true
  }
  if (isModelProfileGenerationGuardAssemblyError(err)) {
    reply.code(err.statusCode).send(err.body)
    return true
  }
  if (err instanceof GenerationInputValidationError) {
    reply.code(400).send({ error: err.message })
    return true
  }
  if (err instanceof EntityNotFoundError) {
    reply.code(404).send({ error: err.message })
    return true
  }
  return false
}

function retargetAssemblySignal(assembly: PromptAssemblyRun, signal?: AbortSignal): void {
  const state = assembly.result.state
  if (!state) return
  state.signal = signal
  state.ctx.signal = signal
}

function shouldDispatchProvider(input: AssembleInput, database: Database | null): database is Database {
  if (!(input.mode === 'send' || input.mode === 'continue' || input.mode === 'regenerate')) {
    return false
  }
  return database !== null
}

function createGenerationInfo(
  db: Database,
  generationId: string,
  result: SuccessfulAssembleResult,
  promptMs: number,
  stage2Ms: number,
): Record<string, unknown> {
  return {
    model: getServerGenerationModelString(db, result.state?.resolvedMainProfile),
    generationId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    maxContext: db.maxContext,
    stageTiming: {
      stage1: Math.max(0, promptMs - stage2Ms),
      stage2: stage2Ms,
      stage3: 0,
      stage4: 0,
    },
  }
}

function chatDispatchHistory(db: DatabaseSync, context: ChatProviderDispatchContext): ChatDispatchHistoryInput {
  const state = context.result.state
  const toggles = state?.currentChat.generationSettings?.sidebarToggles
  const bardWiki = state?.bardWikiPromptDiagnostics
  return {
    db,
    source: 'chat',
    context: {
      characterId: context.input.characterId,
      ...(state?.currentChar.name ? { characterName: state.currentChar.name } : {}),
      chatId: context.input.chatId,
      ...(state?.currentChat.name ? { chatName: state.currentChat.name } : {}),
      generationId: context.generationId,
    },
    ...(toggles ? { toggles: { ...toggles } } : {}),
    metadata: {
      mode: context.input.mode,
      inputTokens: context.result.inputTokens,
      ...bardWikiRequestHistoryMetadata(bardWiki),
      ...context.historyMetadata,
    },
  }
}

type AssemblyStopReason = AssembleAbortReason | 'unknown_stop'

function formatContextBudgetDetail(inputTokens: number | undefined, maxContext: number | undefined): string {
  const parts: string[] = []
  if (typeof inputTokens === 'number' && Number.isFinite(inputTokens)) {
    parts.push(`estimated ${Math.round(inputTokens).toLocaleString('en-US')} tokens needed`)
  }
  if (typeof maxContext === 'number' && Number.isFinite(maxContext) && maxContext > 0) {
    parts.push(`context limit ${Math.round(maxContext).toLocaleString('en-US')}`)
  }
  return parts.length > 0 ? ` (${parts.join(', ')}).` : '.'
}

function assemblyStopError(
  result: Pick<AssembleResult, 'abortReason' | 'inputTokens'>,
  database: Database | null | undefined,
): { error: string; reason: AssemblyStopReason } {
  const detail = formatContextBudgetDetail(result.inputTokens, database?.maxContext)
  switch (result.abortReason) {
    case 'trigger_stop':
      return {
        reason: 'trigger_stop',
        error: 'Generation was stopped by a start trigger.',
      }
    case 'history_context_overflow':
      return {
        reason: 'history_context_overflow',
        error: `Chat history could not fit within the model context window after trimming older messages${detail}`,
      }
    case 'bardwiki_pinned_budget_exceeded':
      return {
        reason: 'bardwiki_pinned_budget_exceeded',
        error: 'Pinned BardWiki references exceed the effective BardWiki prompt budget.',
      }
    case 'overflow':
      return {
        reason: 'overflow',
        error: `Prompt is too large for the model context window after trimming removable history${detail}`,
      }
    default:
      return {
        reason: 'unknown_stop',
        error: `Prompt assembly stopped before generation. Check active triggers and context budget settings${detail}`,
      }
  }
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.length > 0) return err.message
  if (typeof err === 'string' && err.length > 0) return err
  return fallback
}

function readStringHeader(req: FastifyRequest, headerName: string): string | undefined {
  const raw = req.headers[headerName.toLowerCase()]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function hashStrings(values: readonly string[]): string | undefined {
  if (values.length === 0) return undefined
  return createHash('sha256').update(JSON.stringify(values), 'utf8').digest('hex')
}

function assemblyDiagnosticMetricFields(result: AssembleResult): Record<string, unknown> {
  const mutations = result.mutations
  const loreSources = result.state?.report?.actives?.map((entry) => entry.source) ?? []
  const activeModuleIds = result.state?.activeModuleIds ?? []
  return {
    ...promptSummaryMetricFields(result.promptSummary),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    modelPresetId: result.state?.modelPresetId,
    promptPresetId: result.state?.promptPresetId,
    loadoutId: result.state?.loadoutId ?? result.state?.input.loadoutId,
    activeModuleCount: activeModuleIds.length,
    activeModuleIds,
    lorebookActivationCount: result.state?.report?.actives?.length ?? 0,
    lorebookActivationSourceCount: loreSources.length,
    lorebookActivationSourceHashes: loreSources.map((source) =>
      createHash('sha256').update(source, 'utf8').digest('hex'),
    ),
    lorebookActivationSourcesSha256: hashStrings(loreSources),
    messageMutationCount: mutations?.messageMutations.length ?? 0,
    chatVarMutationCount: mutations?.chatVarMutations.length ?? 0,
    additionalSystemPromptMutationCount: mutations?.additionalSystemPrompt.length ?? 0,
    varChanged: mutations?.varChanged ?? false,
    submitTranscriptChanged: result.submitTranscriptChanged ?? false,
    promptMemoryQueryStatus: result.state?.promptMemoryQueryDiagnostics?.status,
    promptMemoryQueryProviderCallAttempted: result.state?.promptMemoryQueryDiagnostics?.providerCallAttempted ?? false,
    promptMemoryQueryTextCount: result.state?.promptMemoryQueryDiagnostics?.queryTexts ?? 0,
    promptMemoryQueryVectorCount: result.state?.promptMemoryQueryDiagnostics?.vectors ?? 0,
    promptMemoryQueryError: result.state?.promptMemoryQueryDiagnostics?.error,
    bardWikiReason: result.state?.bardWikiPromptDiagnostics?.reason,
    bardWikiMemoryMode: result.state?.bardWikiPromptDiagnostics?.memoryMode,
    bardWikiQueryHash: result.state?.bardWikiPromptDiagnostics?.queryHash,
    bardWikiCandidateCount: result.state?.bardWikiPromptDiagnostics?.candidateCount ?? 0,
    bardWikiSelectedCount: result.state?.bardWikiPromptDiagnostics?.selectedCount ?? 0,
    bardWikiRetainedCount: result.state?.bardWikiPromptDiagnostics?.retainedCount ?? 0,
    bardWikiTrimmedCount: result.state?.bardWikiPromptDiagnostics?.trimmedCount ?? 0,
    bardWikiLinkedCandidateCount: result.state?.bardWikiPromptDiagnostics?.linkedCandidateCount ?? 0,
    bardWikiUnresolvedLinkCount: result.state?.bardWikiPromptDiagnostics?.unresolvedLinkCount ?? 0,
    bardWikiConsumedTokens: result.state?.bardWikiPromptDiagnostics?.consumedTokens ?? 0,
    bardWikiSelectedDocumentIds: result.state?.bardWikiPromptDiagnostics?.selected.map(({ documentId }) => documentId),
    bardWikiSelectedContentHashes: result.state?.bardWikiPromptDiagnostics?.selected.map(
      ({ contentHash }) => contentHash,
    ),
    bardWikiFinalPromptRowCount: result.formated?.filter(({ memo }) => memo === 'bardWiki').length ?? 0,
  }
}

function promptEventBooleanFields(promptEvent: Omit<PromptEvent, 'type'>): Record<string, boolean> {
  const event = promptEvent as Omit<PromptEvent, 'type'> & Record<string, unknown>
  return {
    promptEventHasFormated: Array.isArray(event.formated),
    promptEventHasMessages: Array.isArray(event.messages),
    promptEventHasLorebookActivation: event.lorebookActivation !== undefined,
    promptEventHasPromptInfo: event.promptInfo !== undefined,
  }
}

async function emitGenerationPromptEmissionMetric(args: {
  metricContext: PromptAssemblyMetricContext
  input: AssembleInput
  promptEvent: Omit<PromptEvent, 'type'>
  formated: PromptMessage[]
  promptSummary?: PromptRowsSummary
  generationId: string
  durableJobId?: string
  durable: boolean
  compactPromptEvent: boolean
  shouldDispatch: boolean
  revision?: number
  trace?: GenerationTraceContext
}): Promise<void> {
  const eventSummary =
    args.promptSummary ??
    (Array.isArray((args.promptEvent as Record<string, unknown>).formated)
      ? summarizePromptRows((args.promptEvent as { formated: PromptMessage[] }).formated)
      : undefined)
  const fullPromptSidecar = protocolMetricsEnabled()
    ? await writeGenerationTraceSidecar({
        context: args.trace,
        kind: 'prompt',
        value: {
          kind: 'generation_prompt_emission',
          chatId: args.input.chatId,
          characterId: args.input.characterId,
          mode: args.input.mode,
          generationId: args.generationId,
          durableJobId: args.durableJobId,
          durable: args.durable,
          formated: args.formated,
        },
      })
    : undefined
  emitProtocolMetric('generation_prompt_emission', {
    status: 'ok',
    ...args.metricContext,
    chatId: args.input.chatId,
    characterId: args.input.characterId,
    mode: args.input.mode,
    generationId: args.generationId,
    durableJobId: args.durableJobId,
    durable: args.durable,
    compactPromptEvent: args.compactPromptEvent,
    shouldDispatch: args.shouldDispatch,
    revision: args.revision,
    persistedRevision: args.revision,
    ...promptSummaryMetricFields(eventSummary),
    ...promptEventBooleanFields(args.promptEvent),
    ...generationTraceSidecarMetricField('fullPromptSidecar', fullPromptSidecar),
  })
}

function createGenerationTraceContext(args: {
  dataDir: string
  generationTrace?: GenerationTraceOptions
  metricContext: PromptAssemblyMetricContext
  generationId: string
  durableJobId?: string
  req?: FastifyRequest
}): GenerationTraceContext | undefined {
  if (!protocolMetricsEnabled() || args.generationTrace?.fullPrompt !== true) return undefined
  return {
    dataDir: args.dataDir,
    options: args.generationTrace,
    requestId: typeof args.metricContext.requestId === 'string' ? args.metricContext.requestId : undefined,
    requestUid: typeof args.metricContext.requestUid === 'string' ? args.metricContext.requestUid : undefined,
    generationId: args.generationId,
    durableJobId: args.durableJobId,
    logger: args.req?.log,
  }
}

function createPromptAssemblyMetricContext(args: {
  req: FastifyRequest
  input: AssembleInput
  durable: boolean
  clientCapabilities: GenerationClientCapabilities
  generationId?: string
}): PromptAssemblyMetricContext {
  return {
    requestId: String(args.req.id),
    requestUid: readStringHeader(args.req, REQUEST_UID_HEADER),
    xRisuCaller: readStringHeader(args.req, 'x-risu-caller'),
    chatId: args.input.chatId,
    characterId: args.input.characterId,
    mode: args.input.mode,
    loadoutId: args.input.loadoutId,
    expectedRevision: args.input.expectedRevision,
    inlayAssetsCount: args.input.inlayAssets?.length,
    inlayAssetRefsCount: args.input.inlayAssetRefs?.length,
    durable: args.durable,
    compactPromptEvent: args.clientCapabilities.compactPromptEvent,
    promptMetadataOnly: args.clientCapabilities.promptMetadataOnly,
    hypaContextTruncationConfirmation: args.clientCapabilities.hypaContextTruncationConfirmation,
    regenerateTargetProjection: args.clientCapabilities.regenerateTargetProjection,
    generationId: args.generationId,
    durableJobId: args.durable ? args.generationId : undefined,
  }
}

function assemblyRequiresHypaContextTruncationConfirmation(
  assembly: PromptAssemblyRun,
  clientCapabilities: GenerationClientCapabilities,
): boolean {
  const state = assembly.result.state
  return (
    clientCapabilities.hypaContextTruncationConfirmation &&
    assembly.result.stopSending === false &&
    state?.historyTruncated === true &&
    !(state.database.hypaV3 === true && state.currentChar.supaMemory === true) &&
    state.currentChat.hypaContextTruncationAcknowledged !== true
  )
}

function metricString(value: MetricPrimitive): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function emitPostGenerationLuaTraceMetric(args: {
  collector?: PostGenerationLuaTraceCollector
  status: 'ok' | 'error'
  error?: string
  input: AssembleInput
  generationId: string
  durable: boolean
  dataDir: string
  generationTrace?: GenerationTraceOptions
  metricContext?: PromptAssemblyMetricContext
}): Promise<void> {
  if (!args.collector?.hasRuns()) return

  const requestUid = metricString(args.metricContext?.requestUid)
  const requestId = metricString(args.metricContext?.requestId)
  const payload = args.collector.payload({
    status: args.status,
    ...(args.error ? { error: args.error } : {}),
    chatId: args.input.chatId,
    characterId: args.input.characterId,
    mode: args.input.mode,
    generationId: args.generationId,
    durable: args.durable,
    ...(requestUid ? { requestUid } : {}),
    ...(requestId ? { requestId } : {}),
  })
  const bodySidecar = await writeGenerationTraceSidecar({
    context: {
      dataDir: args.dataDir,
      options: {
        fullPrompt: true,
        maxGzipBytes: args.generationTrace?.maxGzipBytes ?? DEFAULT_GENERATION_TRACE_MAX_GZIP_BYTES,
      },
      requestUid,
      requestId,
      generationId: args.generationId,
      durableJobId: args.durable ? args.generationId : undefined,
    },
    kind: 'lua-post-generation',
    value: payload,
  })
  const summary = args.collector.metricSummary()
  emitProtocolMetric('generation_lua_post_generation_trace', {
    status: args.status,
    ...(args.error ? { error: args.error } : {}),
    requestUid,
    requestId,
    chatId: args.input.chatId,
    characterId: args.input.characterId,
    mode: args.input.mode,
    generationId: args.generationId,
    durable: args.durable,
    ...summary,
    ...generationTraceSidecarMetricField('bodySidecar', bodySidecar),
  })
}

/** Modes that persist their assembly delta; preview / preview_prompt stay read-only. */
function isPersistingMode(mode: AssembleInput['mode']): boolean {
  return mode === 'send' || mode === 'continue' || mode === 'regenerate'
}

function createAssemblyTranscriptMessage(input: unknown, index: number) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return createMessageRecord(input, `submitMessages[${index}]`)
  }
  const draft = structuredClone(input) as Record<string, unknown>
  if (typeof draft.chatId !== 'string' || draft.chatId.trim().length === 0) {
    draft.chatId = randomUUID()
  }
  return createMessageRecord(draft, `submitMessages[${index}]`)
}

function canAppendAssemblyReplacement(
  mutations: AssembleMutationPayload,
  replacementLength: number,
  persistedLength: number,
): boolean {
  if (replacementLength <= persistedLength) return false
  if (mutations.messageMutations.length === 0) return false

  for (const mutation of mutations.messageMutations) {
    if (mutation.type === 'append') {
      if (mutation.index < persistedLength) return false
      continue
    }
    if (mutation.type === 'replace_by_id') return false
    const firstChangedIndex = getMessageMutationFirstChangedIndex(mutation)
    if (firstChangedIndex === undefined || firstChangedIndex < persistedLength) {
      return false
    }
  }
  return true
}

interface PersistedAssemblyMutations {
  revision: number
  patch: AssembleMutationPayload
}

function persistedAssemblyReplacementSource(
  mutations: readonly AssembleMutationPayload['messageMutations'][number][],
): Exclude<AssembleMutationSource, 'user_message'> {
  for (let index = mutations.length - 1; index >= 0; index -= 1) {
    const mutation = mutations[index]
    if (
      mutation?.type === 'replace_all' &&
      (mutation.source === 'input_trigger' ||
        mutation.source === 'editinput' ||
        mutation.source === 'agent_preset' ||
        mutation.source === 'history_inject')
    ) {
      return mutation.source
    }
  }
  return 'editinput'
}

/**
 * Persist the assembly-time chat-var and chat-metadata deltas the assembler
 * computed and, when a submit-time input transform or history `@@inject`
 * rewrote the transcript, either the authoritative submit transcript
 * (`submitMessages`) or identity-addressed injected rows, through a targeted
 * command mutation:
 * one revision bump, one event, rollback on failure. The route owns these writes
 * and returns the new revision over SSE so the browser can reconcile its cached
 * command revision.
 *
 * The transcript is persisted only when `submitTranscriptChanged` is set; plain
 * history regex transforms stay request-local.
 * When both the transcript and chat vars change, they ride one command (one
 * revision); a composite chat-transcript event reconciles both writes.
 * Returns the bumped revision, or `undefined` when there is nothing to write.
 */
function persistAssemblyMutations(args: {
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  input: AssembleInput
  mutations: AssembleMutationPayload
  initialMessages: readonly Message[]
  submitMessages?: Message[]
  submitTranscriptChanged?: boolean
}): PersistedAssemblyMutations | undefined {
  const patch: Record<string, string | number | boolean> = {}
  const deleteKeys: string[] = []
  for (const mutation of args.mutations.chatVarMutations) {
    if (mutation.after === null) {
      deleteKeys.push(mutation.key)
    } else {
      patch[mutation.key] = mutation.after
    }
  }
  const hasVarWrite = Object.keys(patch).length > 0 || deleteKeys.length > 0
  const hasCharacterWrite = (args.mutations.characterFieldMutations?.length ?? 0) > 0
  const hasLocalLoreWrite = args.mutations.localLoreMutation !== undefined
  const lastMemoryMutation = args.mutations.chatMetadataMutations?.find((mutation) => mutation.key === 'lastMemory')
  const hasMetadataWrite = lastMemoryMutation !== undefined
  const injectReplacements = args.mutations.messageMutations.filter(
    (mutation) => mutation.type === 'replace_by_id' && mutation.source === 'history_inject',
  )
  const persistReplacement = !!args.submitTranscriptChanged && Array.isArray(args.submitMessages)
  const persistTargetedInjects = !!args.submitTranscriptChanged && !persistReplacement && injectReplacements.length > 0
  const persistMessages = persistReplacement || persistTargetedInjects
  if (!hasVarWrite && !hasMetadataWrite && !hasCharacterWrite && !hasLocalLoreWrite && !persistMessages) {
    emitProtocolMetric('generation_assembly_persistence', {
      status: 'skipped',
      chatId: args.input.chatId,
      mode: args.input.mode,
      chatVarMutationCount: args.mutations.chatVarMutations.length,
      persistMessages,
      hasVarWrite,
      hasMetadataWrite,
      hasCharacterWrite,
      hasLocalLoreWrite,
      durationMs: 0,
    })
    return undefined
  }

  const { revision: baseRevision } = getSchemaState(args.db)
  const persistStartedAt = protocolNowMs()
  let eventType = ''
  try {
    const replacement = persistReplacement
      ? args.submitMessages!.map((message, index) => createAssemblyTranscriptMessage(message, index))
      : undefined
    if (replacement) {
      validateUniqueMessageIds(replacement)
    }
    const result = applyTargetedCommandMutation<{ chatId: string }>({
      db: args.db,
      dataDir: args.dataDir,
      baseRevision,
      eventSink: args.eventSink,
      mutationPath: 'targeted-assembly',
      chatScopedRead: { chatId: args.input.chatId, exactChatRow: hasLocalLoreWrite },
      mutate(database, targetDb) {
        const characters = [(database as { characters?: unknown[] }).characters?.[0]].filter(
          Boolean,
        ) as import('../commands/characters.js').CharacterRecord[]
        const { character, chat } = requireChatLocationExact(characters, args.input.chatId)
        validateGenerationChatVarMutationsFresh({
          chatId: args.input.chatId,
          chat,
          chatVarMutations: args.mutations.chatVarMutations,
        })
        applyGenerationCharacterFieldMutationsFresh({
          characterId: character.chaId as string,
          character,
          characterFieldMutations: args.mutations.characterFieldMutations,
        })
        applyGenerationLocalLoreMutationFresh({
          chatId: args.input.chatId,
          chat,
          localLoreMutation: args.mutations.localLoreMutation,
        })
        if (hasVarWrite) {
          chat.scriptstate ??= {}
          for (const key of deleteKeys) {
            delete chat.scriptstate[key]
          }
          Object.assign(chat.scriptstate, patch)
          if (Object.keys(chat.scriptstate).length === 0) {
            delete chat.scriptstate
          }
        }
        if (replacement) {
          for (const message of replacement) {
            if (activeMessageIdExistsOutsideChat(targetDb, message.chatId, args.input.chatId)) {
              throw new ValidationError(`Duplicate message id: ${message.chatId}`)
            }
          }
          const persistedLength = countChatMessages(targetDb, args.input.chatId)
          const appended =
            canAppendAssemblyReplacement(args.mutations, replacement.length, persistedLength) &&
            appendActiveChatMessageTail(targetDb, args.input.chatId, replacement, args.initialMessages)
          if (!appended) {
            if (!isDeepStrictEqual(getChatMessages(targetDb, args.input.chatId), args.initialMessages)) {
              throw new ValidationError(`Generation assembly transcript is stale for chat ${args.input.chatId}`)
            }
            replaceActiveChatMessages(targetDb, args.input.chatId, replacement)
          }
        } else if (persistTargetedInjects) {
          for (const mutation of injectReplacements) {
            const location = getActiveMessageLocationById(targetDb, mutation.messageId)
            if (!location || location.chatId !== args.input.chatId) {
              throw new EntityNotFoundError(
                `Message not found for history inject in chat ${args.input.chatId}: ${mutation.messageId}`,
              )
            }
            if (!isDeepStrictEqual(location.message, mutation.before)) {
              throw new ValidationError(`Stale history inject target: ${mutation.messageId}`)
            }
            const message = createMessageRecord(structuredClone(mutation.message), 'historyInject.message')
            if (message.chatId !== mutation.messageId) {
              throw new ValidationError(`History inject message id changed: ${mutation.messageId}`)
            }
            const updated = updateActiveMessageById(targetDb, mutation.messageId, message)
            if (updated.ok === false || updated.chatId !== args.input.chatId) {
              throw new EntityNotFoundError(
                `Message not found for history inject in chat ${args.input.chatId}: ${mutation.messageId}`,
              )
            }
          }
        }
        if (lastMemoryMutation) {
          if (lastMemoryMutation.after === null) {
            delete chat.lastMemory
          } else {
            if (!activeMessageIdExistsInChat(targetDb, lastMemoryMutation.after, args.input.chatId)) {
              throw new ValidationError('lastMemory must reference an active message owned by the target chat')
            }
            chat.lastMemory = lastMemoryMutation.after
          }
        }
        if (hasVarWrite || hasMetadataWrite || hasLocalLoreWrite) {
          if (hasLocalLoreWrite) {
            writeSingleChatRowExact(targetDb, args.input.chatId, chat)
          } else {
            writeSingleChatRow(targetDb, args.input.chatId, chat)
          }
        }
        if (hasCharacterWrite) {
          writeSingleCharacterRow(targetDb, character.chaId as string, character)
        }
        const eventTemplate =
          persistMessages || hasMetadataWrite || hasCharacterWrite || hasLocalLoreWrite
            ? COMMAND_EVENT_CATALOG.generationAssemblyPersisted
            : COMMAND_EVENT_CATALOG.chatScriptstateUpdated
        eventType = eventTemplate.type
        return {
          event: {
            ...eventTemplate,
            id: args.input.chatId,
            parentId: character.chaId,
          },
          extra: { chatId: args.input.chatId },
        }
      },
    })
    emitProtocolMetric('generation_assembly_persistence', {
      status: 'ok',
      chatId: args.input.chatId,
      mode: args.input.mode,
      revision: result.revision,
      eventType,
      chatVarMutationCount: args.mutations.chatVarMutations.length,
      persistMessages,
      hasVarWrite,
      hasMetadataWrite,
      hasCharacterWrite,
      hasLocalLoreWrite,
      durationMs: protocolDurationMs(persistStartedAt),
    })
    recordDiagnosticEvent({
      category: 'persistence',
      level: 'info',
      phase: 'assembly',
      disposition: 'committed',
      durationMs: protocolDurationMs(persistStartedAt),
      authoritativeCommitted: true,
      ...(typeof args.input.expectedRevision === 'number'
        ? { revisionGap: Math.max(0, baseRevision - args.input.expectedRevision) }
        : {}),
    })
    const messageMutations: AssembleMutationPayload['messageMutations'] = replacement
      ? [
          {
            type: 'replace_all',
            source: persistedAssemblyReplacementSource(args.mutations.messageMutations),
            beforeLength: args.initialMessages.length,
            afterLength: replacement.length,
            messages: structuredClone(replacement) as Message[],
          },
        ]
      : persistTargetedInjects
        ? structuredClone(injectReplacements)
        : []
    return {
      revision: result.revision,
      patch: {
        chatId: args.mutations.chatId,
        characterId: args.mutations.characterId,
        selectedCharID: args.mutations.selectedCharID,
        chatPage: args.mutations.chatPage,
        varChanged: hasVarWrite,
        messageMutations,
        chatVarMutations: structuredClone(args.mutations.chatVarMutations),
        ...(lastMemoryMutation ? { chatMetadataMutations: [structuredClone(lastMemoryMutation)] } : {}),
        ...(hasCharacterWrite
          ? { characterFieldMutations: structuredClone(args.mutations.characterFieldMutations) }
          : {}),
        ...(hasLocalLoreWrite ? { localLoreMutation: structuredClone(args.mutations.localLoreMutation) } : {}),
        additionalSystemPrompt: [],
      },
    }
  } catch (err) {
    emitProtocolMetric('generation_assembly_persistence', {
      status: 'error',
      chatId: args.input.chatId,
      mode: args.input.mode,
      eventType,
      chatVarMutationCount: args.mutations.chatVarMutations.length,
      persistMessages,
      hasVarWrite,
      hasMetadataWrite,
      hasCharacterWrite,
      hasLocalLoreWrite,
      durationMs: protocolDurationMs(persistStartedAt),
      error: errorMessage(err, 'failed to persist assembly mutations'),
    })
    recordDiagnosticEvent({
      category: 'persistence',
      level: 'error',
      phase: 'assembly',
      disposition: 'failed',
      durationMs: protocolDurationMs(persistStartedAt),
      authoritativeCommitted: false,
      contention: sqliteContention(err),
    })
    throw err
  }
}

/**
 * Resolve the assistant message + replace target for the inline (non-durable)
 * server-dispatch path, which carries `continue` and `regenerate` (a send is
 * always durable). The two modes differ in message identity:
 *   - extend-style continue: `runServerPostGeneration` rewrites the last `char`
 *     row in place, preserving its original `chatId`.
 *   - append-style continue: the transient say-nothing boundary becomes a new
 *     assistant row keyed by `generationId`, so persistence appends it.
 *   - regenerate: a NEW row keyed by `generationId` was appended to the
 *     assembly-only transcript after its target was removed; persist it by
 *     replacing the still-authoritative target (`regenerateMessageId`).
 */
function resolveInlineGenerationMessage(args: {
  state: AssemblyState
  input: AssembleInput
  generationId: string
  finalText: string
  generationInfo: Record<string, unknown>
  promptInfo?: Record<string, unknown>
}): { message: Message; targetMessageId?: string } {
  if (args.input.mode === 'continue' && args.state.continueDisposition === 'extend') {
    const messages = args.state.currentChat.message ?? []
    const row = [...messages].reverse().find((message) => message.role === 'char')
    if (row) return { message: structuredClone(row) as Message }
    // Defensive: no prior assistant row to extend — append a fresh one.
    return {
      message: buildAssistantMessage({
        data: args.finalText,
        generationId: args.generationId,
        characterId: args.state.currentChar.chaId,
        generationInfo: args.generationInfo,
        promptInfo: args.promptInfo,
      }),
    }
  }
  const message = extractAssistantMessage(
    args.state,
    args.generationId,
    args.finalText,
    args.generationInfo,
    args.promptInfo,
  )
  return {
    message,
    targetMessageId: regenerateTargetMessageIdFromInitialMessages(args.input, args.state.initialMessages),
  }
}

/**
 * The last `char` row in the assembler-state chat — the `continue` target.
 * Captured BEFORE `runServerPostGeneration` rewrites it in place, so the failure
 * / cancel fallback can still reconstruct the extended text + the original id.
 * Mirrors `resolveInlineGenerationMessage`'s continue lookup.
 */
function findContinueRow(state: AssemblyState): Message | undefined {
  return [...(state.currentChat.message ?? [])].reverse().find((m) => m.role === 'char')
}

/**
 * Mode-aware RAW assistant message (no post-gen derivation) + replace target
 * for the successful-turn derivation-failure fallback. Interrupted streams do
 * not use this fallback. Extend-style `continue` keeps the captured row id; append-style
 * `continue` creates a generation-owned row from the say-nothing boundary;
 * `regenerate` replaces the target (`regenerateMessageId`) only when that target
 * existed at assembly start; `send` appends a fresh row keyed by `generationId`.
 * The mode-aware target is what makes a durable continue/regenerate land on the
 * right row even without a post-gen pass.
 */
function buildRawModeMessage(args: {
  input: AssembleInput
  continueDisposition: ContinueDisposition
  initialMessages?: readonly Message[]
  continueRow: Message | undefined
  text: string
  generationId: string
  generationInfo: Record<string, unknown>
  promptInfo?: Record<string, unknown>
  removeIncompleteResponse?: boolean
}): { message: Message; targetMessageId?: string } {
  const normalizeRawText = (text: string): string =>
    args.removeIncompleteResponse ? trimUntilPunctuation(text) : text.trim()
  if (args.input.mode === 'continue' && args.continueDisposition === 'extend') {
    return {
      message: buildAssistantMessage({
        data: normalizeRawText((args.continueRow?.data ?? '') + args.text),
        generationId: args.continueRow?.chatId ?? args.generationId,
        characterId: args.input.characterId,
        generationInfo: args.generationInfo,
        promptInfo: args.promptInfo,
      }),
    }
  }
  const appendContinueBase = args.input.mode === 'continue' ? '*says nothing*' : ''
  return {
    message: buildAssistantMessage({
      data: normalizeRawText(appendContinueBase + args.text),
      generationId: args.generationId,
      characterId: args.input.characterId,
      generationInfo: args.generationInfo,
      promptInfo: args.promptInfo,
    }),
    targetMessageId: regenerateTargetMessageIdFromInitialMessages(args.input, args.initialMessages),
  }
}

function snapshotMessageRow(message: Message | undefined): GenerationFinalizationSnapshotRow | undefined {
  if (!message) return undefined
  return { message: structuredClone(message) }
}

function generationFinalizationSourceRows(state: AssemblyState): Message[] {
  if (state.submitMessages) return state.submitMessages

  const rows = structuredClone(state.initialMessages ?? []) as Message[]
  for (const mutation of state.messageMutations ?? []) {
    if (mutation.type !== 'replace_by_id' || mutation.source !== 'history_inject') continue
    const index = rows.findIndex((message) => message.chatId === mutation.messageId)
    if (index >= 0) rows[index] = structuredClone(mutation.message) as Message
  }
  return rows
}

function captureGenerationFinalizationTargetSnapshot(
  input: AssembleInput,
  state: AssemblyState,
): GenerationFinalizationTargetSnapshot | undefined {
  const mode = finalizationModeFromInput(input)
  // Assembly persistence runs before provider dispatch. Targeted history
  // injects therefore have to be reflected in the freshness snapshot without
  // adopting the assembler's mode-specific working truncation (notably
  // regenerate, whose replacement target must remain present until finalization).
  const sourceRows = generationFinalizationSourceRows(state)
  const transcriptLength = sourceRows.length
  const tail = sourceRows.at(-1)

  if (mode === 'continue' && state.continueDisposition === 'extend' && tail?.role === 'char') {
    return {
      mode,
      kind: 'target-tail',
      transcriptLength,
      target: snapshotMessageRow(tail)!,
    }
  }

  if (mode === 'regenerate') {
    const targetMessageId = input.regenerateMessageId
    if (targetMessageId && tail?.role === 'char' && tail.chatId === targetMessageId) {
      return {
        mode,
        kind: 'target-tail',
        transcriptLength,
        target: snapshotMessageRow(tail)!,
      }
    }
  }

  const tailSnapshot = snapshotMessageRow(tail)
  return {
    mode,
    kind: 'tail',
    transcriptLength,
    ...(tailSnapshot ? { tail: tailSnapshot } : {}),
  }
}

function classifyPostGenerationFallbackSource(err: unknown): string {
  if (err instanceof ServerLuaFailureError) {
    const mode = err.runtimeMetricFields?.mode
    if (mode === 'output') return 'lua_output_trigger'
    if (mode === 'editOutput') return 'lua_edit_output'
  }
  const message = errorMessage(err, '').toLowerCase()
  if (message.includes('lua output trigger failed')) return 'lua_output_trigger'
  if (message.includes('lua editoutput edit trigger failed') || message.includes('editoutput')) {
    return 'lua_edit_output'
  }
  if (message.includes('bounded regex') || message.includes('customscript')) return 'regex_edit_output'
  return 'unknown_post_generation'
}

function luaFailureFallbackMetricFields(err: unknown): Record<string, unknown> {
  if (!(err instanceof ServerLuaFailureError)) return {}
  const runtime = err.runtimeMetricFields
  return {
    ...(runtime
      ? {
          luaMode: runtime.mode,
          luaCodeSha256: runtime.codeSha256,
          luaCodeBytes: runtime.codeBytes,
          luaLowLevelAccess: runtime.lowLevelAccess,
          luaDurationMs: runtime.durationMs,
          luaExecTimeoutMs: runtime.execTimeoutMs,
          luaEffectiveTimeoutMs: runtime.effectiveTimeoutMs,
          luaTimedOut: runtime.timedOut,
          luaInteractiveInvoked: runtime.interactiveInvoked,
          luaAborted: runtime.aborted,
          ...(runtime.errorKind ? { luaErrorKind: runtime.errorKind } : {}),
          ...(runtime.budgetTotalMs !== undefined ? { luaBudgetTotalMs: runtime.budgetTotalMs } : {}),
          ...(runtime.budgetUsedMsBefore !== undefined ? { luaBudgetUsedMsBefore: runtime.budgetUsedMsBefore } : {}),
          ...(runtime.budgetUsedMsAfter !== undefined ? { luaBudgetUsedMsAfter: runtime.budgetUsedMsAfter } : {}),
          ...(runtime.budgetRemainingMsBefore !== undefined
            ? { luaBudgetRemainingMsBefore: runtime.budgetRemainingMsBefore }
            : {}),
          ...(runtime.budgetRemainingMsAfter !== undefined
            ? { luaBudgetRemainingMsAfter: runtime.budgetRemainingMsAfter }
            : {}),
        }
      : {}),
    ...triggerSourceMetricFields(err.source),
  }
}

function safePostGenerationFallbackMetricError(err: unknown, fallback: string): string {
  if (err instanceof ServerLuaFailureError) {
    const mode = err.runtimeMetricFields?.mode
    const kind = err.runtimeMetricFields?.errorKind ?? 'lua_failure'
    if (mode === 'output') return `Lua output trigger failed (${kind})`
    if (mode === 'editOutput') return `Lua editOutput edit trigger failed (${kind})`
    return `Lua runtime failed (${kind})`
  }
  return errorMessage(err, fallback)
}

function completionSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Run server post-generation derivation and resolve the mode-aware assistant
 * message plus replace target, with a raw-text fallback when successful-turn
 * derivation throws. Interrupted partials reject persistence instead: cancel
 * and failure paths must never durably fall back to unprocessed text. A
 * `postGen` of `undefined` signals the successful-turn raw fallback is in use.
 */
async function resolvePostGenerationResult(args: {
  state: AssemblyState
  input: AssembleInput
  completionText: string
  alternateTexts?: readonly string[]
  generationId: string
  generationInfo: Record<string, unknown>
  promptInfo?: Record<string, unknown>
  dataDir: string
  durable: boolean
  emit?: (event: PromptChatEvent) => void
  generationTrace?: GenerationTraceOptions
  metricContext?: PromptAssemblyMetricContext
  /** Run only the editoutput-compatible interrupted-result path. */
  partial?: boolean
}): Promise<{
  postGen?: Awaited<ReturnType<typeof runServerPostGeneration>>
  postGenError?: string
  message: Message
  targetMessageId?: string
  chatVarMutations: AssembleMutationPayload['chatVarMutations']
  characterFieldMutations: AssembleMutationPayload['characterFieldMutations']
  localLoreMutation: AssembleMutationPayload['localLoreMutation']
  alternateTexts: string[]
  targetSnapshot?: GenerationFinalizationTargetSnapshot
  postGenMetricError?: string
}> {
  const persistedPromptInfo =
    args.state.database.promptInfoInsideChat === true ? args.promptInfo : ({} as Record<string, unknown>)
  const targetSnapshot = captureGenerationFinalizationTargetSnapshot(args.input, args.state)
  // Capture the continue target BEFORE post-gen mutates the row in place.
  const continueRow = args.input.mode === 'continue' ? findContinueRow(args.state) : undefined
  const luaTrace = protocolMetricsEnabled() ? new PostGenerationLuaTraceCollector() : undefined
  const luaProgress = args.emit ? new PostGenerationLuaProgressTracker(args.emit) : undefined
  let alternateTexts: string[] = []
  try {
    const postGen = await runServerPostGeneration(args.state, {
      completionText: args.completionText,
      generationId: args.generationId,
      generationInfo: args.generationInfo,
      promptInfo: persistedPromptInfo,
      luaTrace,
      luaProgress,
      ...(args.partial ? { partial: true } : {}),
      agentPresetProgress: args.emit
        ? (progress) => args.emit?.({ type: 'agent_preset_progress', ...progress })
        : undefined,
      beforeOutputTrigger: async (alternateState) => {
        alternateTexts = await transformProviderAlternateTexts(alternateState, args.input, args.alternateTexts ?? [])
      },
    })
    for (const warning of postGen.warnings ?? []) {
      args.emit?.({ type: 'warning', ...warning })
    }
    await emitPostGenerationLuaTraceMetric({
      collector: luaTrace,
      status: 'ok',
      input: args.input,
      generationId: args.generationId,
      durable: args.durable,
      dataDir: args.dataDir,
      generationTrace: args.generationTrace,
      metricContext: args.metricContext,
    })
    const resolved = resolveInlineGenerationMessage({
      state: args.state,
      input: args.input,
      generationId: args.generationId,
      finalText: postGen.finalText,
      generationInfo: args.generationInfo,
      promptInfo: persistedPromptInfo,
    })
    return {
      postGen,
      message: resolved.message,
      targetMessageId: resolved.targetMessageId,
      chatVarMutations: postGen.mutations.chatVarMutations,
      characterFieldMutations: postGen.mutations.characterFieldMutations,
      localLoreMutation: postGen.mutations.localLoreMutation,
      alternateTexts,
      targetSnapshot,
    }
  } catch (err) {
    const error = errorMessage(err, 'server post-generation derivation failed')
    const metricError = safePostGenerationFallbackMetricError(err, 'server post-generation derivation failed')
    await emitPostGenerationLuaTraceMetric({
      collector: luaTrace,
      status: 'error',
      error: metricError,
      input: args.input,
      generationId: args.generationId,
      durable: args.durable,
      dataDir: args.dataDir,
      generationTrace: args.generationTrace,
      metricContext: args.metricContext,
    })
    if (args.partial) {
      emitProtocolMetric('generation_post_generation_fallback', {
        fallbackType: 'interrupted_result_not_persisted',
        generationId: args.generationId,
        chatId: args.input.chatId,
        characterId: args.input.characterId,
        mode: args.input.mode,
        targetSnapshotKind: targetSnapshot?.kind,
        targetSnapshotTranscriptLength: targetSnapshot?.transcriptLength,
        completionLength: args.completionText.length,
        completionBytes: Buffer.byteLength(args.completionText, 'utf8'),
        completionSha256: completionSha256(args.completionText),
        error: metricError,
        source: classifyPostGenerationFallbackSource(err),
        ...luaFailureFallbackMetricFields(err),
      })
      throw err
    }
    // Successful-turn compatibility keeps the existing raw fallback so a
    // completion is not lost when completion-only derivation fails.
    const raw = buildRawModeMessage({
      input: args.input,
      continueDisposition: args.state.continueDisposition,
      initialMessages: args.state.initialMessages,
      continueRow,
      text: args.completionText,
      generationId: args.generationId,
      generationInfo: args.generationInfo,
      promptInfo: persistedPromptInfo,
      removeIncompleteResponse: args.state.database.removeIncompleteResponse,
    })
    emitProtocolMetric('generation_post_generation_fallback', {
      fallbackType: 'raw_provider_text',
      generationId: args.generationId,
      chatId: args.input.chatId,
      characterId: args.input.characterId,
      mode: args.input.mode,
      targetMessageId: raw.targetMessageId,
      targetSnapshotKind: targetSnapshot?.kind,
      targetSnapshotTranscriptLength: targetSnapshot?.transcriptLength,
      completionLength: args.completionText.length,
      completionBytes: Buffer.byteLength(args.completionText, 'utf8'),
      completionSha256: completionSha256(args.completionText),
      error: metricError,
      source: classifyPostGenerationFallbackSource(err),
      ...luaFailureFallbackMetricFields(err),
    })
    return {
      postGenError: error,
      message: raw.message,
      targetMessageId: raw.targetMessageId,
      chatVarMutations: [],
      characterFieldMutations: undefined,
      localLoreMutation: undefined,
      alternateTexts: (args.alternateTexts ?? []).map((text) => rawProviderAlternateText(args.state, args.input, text)),
      targetSnapshot,
      postGenMetricError: metricError,
    }
  }
}

/** Fold the post-gen derivation outputs onto the terminal `postGeneration` frame. */
function persistedPostGenerationMutations(
  mutations: AssembleMutationPayload,
  persistence: AppliedGenerationScriptMutations,
): AssembleMutationPayload {
  const {
    characterFieldMutations: _characterFieldMutations,
    localLoreMutation: _localLoreMutation,
    ...rest
  } = mutations
  return {
    ...rest,
    chatVarMutations: persistence.chatVarMutations,
    ...(persistence.characterFieldMutations.length > 0
      ? { characterFieldMutations: persistence.characterFieldMutations }
      : {}),
    ...(persistence.localLoreMutation ? { localLoreMutation: persistence.localLoreMutation } : {}),
  }
}

function emitDroppedGenerationScriptMutationWarning(
  emit: ((event: PromptChatEvent) => void) | undefined,
  droppedScriptMutations: readonly GenerationScriptMutationConflict[],
): void {
  if (droppedScriptMutations.length === 0) return
  emit?.({
    type: 'warning',
    message: 'Some server script updates were skipped because their targets changed during generation.',
    context: {
      kind: 'stale_generation_script_mutations',
      droppedMutations: droppedScriptMutations,
    },
  })
}

function droppedGenerationScriptMutationMetricFields(
  persistence: GenerationFinalizationPersistenceResult,
): Record<string, unknown> {
  return persistence.droppedScriptMutations.length > 0
    ? {
        droppedScriptMutationCount: persistence.droppedScriptMutations.length,
        droppedScriptMutations: persistence.droppedScriptMutations,
      }
    : {}
}

function buildPostGenerationFrameBody(
  revision: number,
  postGen: Awaited<ReturnType<typeof runServerPostGeneration>> | undefined,
  messageId?: string,
  translation?: PostGenerationFrame['translation'],
  persistence?: AppliedGenerationScriptMutations,
  effectLedger?: GenerationEffectLedgerRef,
): PostGenerationFrame {
  const frame: PostGenerationFrame = {
    revision,
    ...(messageId ? { messageId } : {}),
    ...(translation ? { translation } : {}),
    ...(effectLedger ? { effectLedger } : {}),
  }
  if (postGen) {
    const mutations = persistence ? persistedPostGenerationMutations(postGen.mutations, persistence) : postGen.mutations
    if (postGen.textChanged) frame.finalText = postGen.finalText
    if (
      mutations.chatVarMutations.length > 0 ||
      mutations.messageMutations.length > 0 ||
      (mutations.characterFieldMutations?.length ?? 0) > 0 ||
      mutations.localLoreMutation !== undefined
    ) {
      frame.messagePatch = mutations
    }
    if (postGen.resendChat) frame.resendChat = true
    if (postGen.agentPresetError) frame.agentPresetError = postGen.agentPresetError
  }
  return frame
}

function notifyChatCompletion(
  pushNotifications: false | PushNotificationService | undefined,
  context?: ChatCompletionNotificationContext,
): void {
  if (!pushNotifications) return
  void pushNotifications.sendChatCompletionNotification(context).catch(() => {
    // Best-effort: failed push delivery must not affect generation completion.
  })
}

export function directGenerationResponseIsWritable(raw: {
  writable?: boolean
  writableEnded: boolean
  destroyed?: boolean
}): boolean {
  return raw.writable !== false && !raw.writableEnded && raw.destroyed !== true
}

function handlePersistedGenerationCompletion(args: {
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  messageTranslationJobs: MessageTranslationJobRegistry
  message: Message
  targetMessageId?: string
  chatId: string
  characterId?: string
  completedAt: number
  emit?: (event: PromptChatEvent) => void
  pushNotifications?: false | PushNotificationService
  runMessageTranslation?: ServerMessageTranslationRunner
  generationId?: string
}): Promise<{ translation?: PostGenerationFrame['translation']; revision?: number; translationStarted?: boolean }> {
  const messageId = args.targetMessageId ?? args.message.chatId
  if (typeof messageId !== 'string' || messageId.trim().length === 0) {
    notifyChatCompletion(args.pushNotifications, { characterId: args.characterId, chatId: args.chatId })
    return Promise.resolve({})
  }
  const run = () =>
    handleGeneratedChatCompletion({
      db: args.db,
      dataDir: args.dataDir,
      eventSink: args.eventSink,
      messageTranslationJobs: args.messageTranslationJobs,
      messageId,
      chatId: args.chatId,
      ...(args.characterId ? { characterId: args.characterId } : {}),
      completedAt: args.completedAt,
      pushNotifications: args.pushNotifications,
      runMessageTranslation: args.runMessageTranslation,
      onTranslationStarted: ({ jobId }) =>
        args.emit?.({
          type: 'post_generation_progress',
          phase: 'translation',
          status: 'translating',
          runSeq: 0,
          messageId,
          jobId,
          llmCallCount: 0,
          pendingLlmCount: 0,
          llmCallCounts: { LLM: 0, axLLM: 0 },
          pendingLlmCounts: { LLM: 0, axLLM: 0 },
        }),
    })

  const generationId = args.generationId?.trim()
  if (!generationId) {
    return run().then((followup) => ({
      translationStarted: followup.translationStarted,
      ...(followup.frame ? { translation: followup.frame } : {}),
      ...(followup.revision !== undefined ? { revision: followup.revision } : {}),
    }))
  }

  const databaseLineage = getDatabaseLineage(args.db)
  const claim = claimGenerationEffect(args.db, {
    databaseLineage,
    generationId,
    kind: 'generated_translation',
    delivery: 'server',
    messageId,
  })
  if (claim.status !== 'claimed') return Promise.resolve({})

  return run().then(
    (followup) => {
      settleGenerationEffect(args.db, {
        databaseLineage,
        generationId,
        kind: 'generated_translation',
        claimId: claim.claimId,
        status: followup.translationStarted ? 'completed' : 'skipped',
        reason: followup.translationStarted ? null : 'not_applicable',
      })
      return {
        translationStarted: followup.translationStarted,
        ...(followup.frame ? { translation: followup.frame } : {}),
        ...(followup.revision !== undefined ? { revision: followup.revision } : {}),
      }
    },
    (error) => {
      settleGenerationEffect(args.db, {
        databaseLineage,
        generationId,
        kind: 'generated_translation',
        claimId: claim.claimId,
        status: 'failed',
        lastError: errorMessage(error, 'generated-message translation failed'),
      })
      throw error
    },
  )
}

/**
 * Run the server post-generation pass over the provider's completion text,
 * persist the result server-side, and build the `done.postGeneration` frame.
 * This surfaces final text / delta / resend / bumped revision for the browser.
 *
 * The inline path is the sole author of generation results. A derivation failure
 * persists the raw provider text best-effort rather than losing it; a persist
 * failure is swallowed and the browser keeps its optimistic copy.
 */
async function buildPostGenerationFrame(args: {
  state: NonNullable<Parameters<typeof runServerPostGeneration>[0]>
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  input: AssembleInput
  completionText: string
  alternateTexts?: readonly string[]
  generationId: string
  generationInfo: Record<string, unknown>
  promptInfo?: Record<string, unknown>
  emit?: (event: PromptChatEvent) => void
  pushNotifications?: false | PushNotificationService
  messageTranslationJobs: MessageTranslationJobRegistry
  runMessageTranslation?: ServerMessageTranslationRunner
  onBardWikiJobEnqueued?: (job: BardWikiJobSummary) => void
  generationTrace?: GenerationTraceOptions
  metricContext?: PromptAssemblyMetricContext
}): Promise<ProviderPostGenerationResult | undefined> {
  const diagnosticStartedAt = protocolNowMs()
  recordDiagnosticEvent({
    category: 'generation',
    level: 'info',
    stage: 'post-generation',
    outcome: 'pending',
    providerMayHaveRun: true,
  })
  const completedAt = Date.now()
  const {
    postGen,
    postGenError,
    postGenMetricError,
    message,
    targetMessageId,
    chatVarMutations,
    characterFieldMutations,
    localLoreMutation,
    alternateTexts,
    targetSnapshot,
  } = await resolvePostGenerationResult({
    state: args.state,
    input: args.input,
    completionText: args.completionText,
    alternateTexts: args.alternateTexts,
    generationId: args.generationId,
    generationInfo: args.generationInfo,
    promptInfo: args.promptInfo,
    dataDir: args.dataDir,
    durable: false,
    emit: args.emit,
    generationTrace: args.generationTrace,
    metricContext: args.metricContext,
  })
  recordDiagnosticEvent({
    category: 'generation',
    level: postGenError ? 'warn' : 'info',
    stage: 'post-generation',
    outcome: postGenError ? 'failed' : 'completed',
    providerMayHaveRun: true,
    durationMs: protocolDurationMs(diagnosticStartedAt),
  })
  const alternateMessages = buildProviderAlternateMessages({
    primaryMessage: message,
    alternateTexts,
  })

  let persistence: GenerationFinalizationPersistenceResult
  const persistStartedAt = protocolNowMs()
  try {
    persistence = persistServerGenerationResult({
      db: args.db,
      dataDir: args.dataDir,
      eventSink: args.eventSink,
      chatId: args.input.chatId,
      message,
      chatVarMutations,
      characterFieldMutations,
      localLoreMutation,
      targetMessageId,
      mode: finalizationModeFromInput(args.input),
      targetSnapshot,
      alternateMessages,
      automaticConfirmationEligible: finalizationModeFromInput(args.input) === 'send',
    })
  } catch (err) {
    emitProtocolMetric('generation_persistence', {
      status: 'inline_error',
      generationId: args.generationId,
      chatId: args.input.chatId,
      durationMs: protocolDurationMs(persistStartedAt),
      error: errorMessage(err, 'failed to persist the generation result'),
    })
    // Chat changed / gone during persist: leave the browser's optimistic copy
    // and terminate cleanly (no frame).
    return { primary: message.data, alternates: alternateTexts }
  }
  if (persistence.bardWikiJobEnqueued) args.onBardWikiJobEnqueued?.(persistence.bardWikiJobEnqueued)

  emitProtocolMetric('generation_persistence', {
    status: postGen ? 'inline_ok' : 'inline_raw_fallback',
    generationId: args.generationId,
    chatId: args.input.chatId,
    revision: persistence.revision,
    durationMs: protocolDurationMs(persistStartedAt),
    ...(postGenMetricError ? { error: postGenMetricError } : {}),
    ...droppedGenerationScriptMutationMetricFields(persistence),
  })
  emitDroppedGenerationScriptMutationWarning(args.emit, persistence.droppedScriptMutations)
  if (!postGen) {
    args.emit?.({
      type: 'warning',
      message: 'server post-generation derivation failed; persisted the raw provider text.',
      ...(postGenError ? { context: { error: postGenError } } : {}),
    })
  }
  const messageId = targetMessageId ?? message.chatId
  const translationFollowup = await handlePersistedGenerationCompletion({
    db: args.db,
    dataDir: args.dataDir,
    eventSink: args.eventSink,
    messageTranslationJobs: args.messageTranslationJobs,
    message,
    targetMessageId,
    chatId: args.input.chatId,
    characterId: args.input.characterId,
    completedAt,
    emit: args.emit,
    pushNotifications: args.pushNotifications,
    runMessageTranslation: args.runMessageTranslation,
  })
  return {
    frame: buildPostGenerationFrameBody(
      translationFollowup.revision ?? persistence.revision,
      postGen,
      messageId,
      translationFollowup.translation,
      persistence,
    ),
    primary: message.data,
    alternates: alternateTexts,
  }
}

/**
 * Stream the assembled prompt. The SSE head is written up front, so every
 * assembly failure is a terminal `error` event rather than an HTTP status. The
 * route persists the assembly-time chat-var delta and returns the bumped
 * revision on the `info` frame; the browser keeps the `message_patch` for its
 * projection but no
 * longer replays the delta as a command.
 */
async function streamAssembly(
  req: FastifyRequest,
  reply: FastifyReply,
  db: DatabaseSync,
  input: AssembleInput,
  dataDir: string,
  eventSink: CommandEventSink,
  clientCapabilities: GenerationClientCapabilities,
  messageTranslationJobs: MessageTranslationJobRegistry,
  options: GenerationChatRouteOptions = {},
  generationTrace?: GenerationTraceOptions,
  preparedAssembly?: PromptAssemblyRun,
  deferredFailure?: AssemblyDeferredFailure,
  metricContext: PromptAssemblyMetricContext = {},
  requestAbort = attachAbort(req, reply),
): Promise<void> {
  const { signal, refresh, abort, cleanup } = requestAbort
  let terminalDoneEmitted = false
  try {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    const emit = (event: PromptChatEvent): void => {
      const frame = formatPromptChatFrame(event)
      const written = writeBoundedRaw(reply.raw, frame, { onOverflow: abort })
      if (written && isStreamDeadlineActivityFrame(frame)) refresh()
    }

    emit({ type: 'stage', stage: 'validate', status: 'start' })
    emit({ type: 'stage', stage: 'validate', status: 'end' })
    emit({ type: 'stage', stage: 'prompt', status: 'start' })

    try {
      if (deferredFailure) throw deferredFailure.error
      const { result, deps, promptMs, stage2Ms } =
        preparedAssembly ??
        (await assemblePromptWithMetrics(
          input,
          dataDir,
          db,
          signal,
          metricContext,
          (progress) => emit({ type: 'agent_preset_progress', ...progress }),
          options,
        ))
      const database = result.state?.database ?? deps.getDatabase()
      // The route owns assembly-time chat-var writes and post-`editinput`
      // submit-transcript writes for persisting modes. This runs for both success
      // and `stopSending` so aborted sends do not lose the assembly mutations.
      const persistedAssembly =
        isPersistingMode(input.mode) && result.mutations
          ? persistAssemblyMutations({
              db,
              dataDir,
              eventSink,
              input,
              mutations: result.mutations,
              initialMessages: result.restoration?.messages ?? [],
              submitMessages: result.submitMessages,
              submitTranscriptChanged: result.submitTranscriptChanged,
            })
          : undefined
      const assemblyPatch = assemblyPatchForClient({
        result,
        persistence: persistedAssembly,
        capabilities: clientCapabilities,
        useRegenerateTargetProjection: false,
      })
      emitAssemblyWarnings(result, emit)
      if (!result.stopSending && result.prompt) {
        const successfulResult: SuccessfulAssembleResult = {
          ...result,
          stopSending: false,
          prompt: result.prompt,
        }
        const extendContinueBase =
          successfulResult.state?.input.mode === 'continue' && successfulResult.state.continueDisposition === 'extend'
            ? (findContinueRow(successfulResult.state)?.data ?? '')
            : undefined
        const generationId = randomUUID()
        const shouldDispatch = shouldDispatchProvider(input, database)
        const generationInfo =
          shouldDispatch && database
            ? createGenerationInfo(database, generationId, successfulResult, promptMs, stage2Ms)
            : undefined
        const promptEvent = promptEventForClient(result.prompt, clientCapabilities, input.mode)
        const trace = createGenerationTraceContext({
          dataDir,
          generationTrace,
          metricContext,
          generationId,
          req,
        })
        await emitGenerationPromptEmissionMetric({
          metricContext,
          input,
          promptEvent,
          formated: successfulResult.formated ?? successfulResult.prompt.formated ?? [],
          promptSummary: result.promptSummary,
          generationId,
          durable: false,
          compactPromptEvent: clientCapabilities.compactPromptEvent,
          shouldDispatch,
          revision: persistedAssembly?.revision,
          trace,
        })
        emit({ type: 'prompt', ...promptEvent })
        if (assemblyPatch) emit({ type: 'message_patch', patch: assemblyPatch })
        emit({ type: 'stage', stage: 'prompt', status: 'end' })
        // `outputTokens` is the response budget, not a completion count, so it
        // rides on `responseBudget` rather than `tokens.completion`.
        emit({
          type: 'info',
          timings: { prompt: promptMs },
          tokens: { prompt: result.inputTokens, total: result.inputTokens },
          responseBudget: result.outputTokens,
          ...(database?.halfStreaming === true ? { halfStreaming: true } : {}),
          generationId: shouldDispatch ? generationId : undefined,
          generationInfo,
          ...(successfulResult.state?.input.mode === 'continue'
            ? {
                continueDisposition: successfulResult.state.continueDisposition,
                ...(extendContinueBase !== undefined ? { continueBase: extendContinueBase } : {}),
              }
            : {}),
          // Present only when a chat-var write actually persisted, so the browser
          // reconciles its cached command revision; omitted otherwise.
          revision: persistedAssembly?.revision,
        })
        if (shouldDispatch && database && generationInfo) {
          const dispatchProvider =
            options.dispatchProvider ??
            ((context: ChatProviderDispatchContext) =>
              dispatchChatProvider({
                database: context.database,
                formated: context.result.formated ?? context.result.prompt.formated ?? [],
                outputTokens: context.result.outputTokens,
                biases: context.result.biases,
                multiGeneration: context.input.mode !== 'continue',
                currentCharacterName: context.result.state?.currentChar.name,
                signal: context.signal,
                trace: context.trace,
                profile: context.profile,
                history: chatDispatchHistory(db, context),
                inlayAssetPersistence: { db, dataDir },
                onWarning: (warning) => emit({ type: 'warning', ...warning }),
                onResolvedModel: (model) => {
                  context.resolvedRequestModel = model
                },
              }))
          const providerStartedAt = Date.now()
          let frames: AsyncIterable<CompletionStreamFrame> | null | undefined
          try {
            frames = dispatchProviderWithPolicies(
              {
                input,
                result: successfulResult,
                database,
                generationId,
                generationInfo,
                signal,
                trace,
              },
              dispatchProvider,
            )
          } catch (err) {
            emit({
              type: 'error',
              error: errorMessage(err, PROVIDER_DISPATCH_FALLBACK),
              reason: 'provider_dispatch_exception',
              restoration: successfulResult.restoration,
            })
            emit({ type: 'done', generationId, generationInfo })
            terminalDoneEmitted = true
          }
          if (frames) {
            const transportResult = await emitProviderChunks(frames, emit, signal, {
              // This inline stream cannot be reattached, so a capable client that
              // received token deltas does not need the full text repeated on done.
              omitResultWhenStreamed: clientCapabilities.omitDuplicateDoneResult,
              tokenProgress: halfStreamingTokenProgress(database, providerStartedAt),
              doneMetadata: () => {
                const stageTiming = generationInfo.stageTiming as Record<string, unknown> | undefined
                if (stageTiming) {
                  stageTiming.stage3 = Date.now() - providerStartedAt
                }
                return {
                  generationId,
                  generationInfo,
                  ...(database.halfStreaming === true ? { halfStreaming: true } : {}),
                  ...(successfulResult.state?.input.mode === 'continue'
                    ? {
                        continueDisposition: successfulResult.state.continueDisposition,
                        ...(extendContinueBase !== undefined ? { continueBase: extendContinueBase } : {}),
                      }
                    : {}),
                }
              },
              sideEffects: (texts) =>
                database.ttsAutoSpeech
                  ? texts.map((text) => ({
                      type: 'side_effect',
                      kind: 'tts',
                      payload: { text, characterId: input.characterId },
                    }))
                  : [],
              errorRestoration: () => successfulResult.restoration,
              failurePostGeneration: (completionText) =>
                successfulResult.state
                  ? persistFailedPartialResult({
                      state: successfulResult.state,
                      db,
                      dataDir,
                      eventSink,
                      input,
                      text: completionText,
                      generationId,
                      generationInfo,
                      promptInfo: successfulResult.prompt.promptInfo,
                      emit,
                      generationTrace,
                      metricContext,
                    })
                  : Promise.resolve(undefined),
              postGeneration: (completionText, alternateTexts) =>
                successfulResult.state
                  ? buildPostGenerationFrame({
                      state: successfulResult.state,
                      db,
                      dataDir,
                      eventSink,
                      input,
                      completionText,
                      alternateTexts,
                      generationId,
                      generationInfo,
                      promptInfo: successfulResult.prompt.promptInfo,
                      emit,
                      pushNotifications: options.pushNotifications,
                      messageTranslationJobs,
                      runMessageTranslation: options.runMessageTranslation,
                      onBardWikiJobEnqueued: options.onBardWikiJobEnqueued,
                      generationTrace,
                      metricContext,
                    })
                  : Promise.resolve(undefined),
            })
            terminalDoneEmitted = transportResult.status !== 'aborted'
          }
        }
      } else {
        if (assemblyPatch) emit({ type: 'message_patch', patch: assemblyPatch })
        const stopError = assemblyStopError(result, database)
        emit({
          type: 'error',
          error: stopError.error,
          reason: stopError.reason,
          restoration: result.restoration,
        })
      }
    } catch (err) {
      emit({
        type: 'error',
        error: err instanceof Error ? err.message : 'prompt assembly failed',
      })
    }

    if (!terminalDoneEmitted && !signal.aborted) {
      emit({ type: 'done' })
    }
    reply.raw.end()
  } finally {
    cleanup()
  }
}

// Durable generation: decoupled lifecycle + server-owned result.
//
// For a durable generating mode (browser `resolveDurableGeneration === 'durable'` →
// `body.durable === true`, mode `send`/`continue`/`regenerate`), the generation
// runs as a detached `JobRegistry` job whose lifecycle is **not** tied to the
// request connection:
// dropping the connection detaches a viewer, the job keeps generating, buffers,
// and is reattachable. At completion the server persists the derived assistant
// message + scriptstate delta itself.

/** The active-writer identity carried on the `/chat` request (captured at job creation). */
function readWriterSessionHeader(req: FastifyRequest): string | null {
  const raw = req.headers[ACTIVE_WRITER_SESSION_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** An SSE-backed `JobClient`: writes raw frame strings to the reply's raw socket. */
function makeSseJobClient(reply: FastifyReply): JobClient {
  return {
    send(frame) {
      if (typeof frame === 'string') {
        writeBoundedRaw(reply.raw, frame)
      }
    },
    close() {
      try {
        if (!reply.raw.writableEnded) reply.raw.end()
      } catch {
        // ignore
      }
    },
    get open() {
      return directGenerationResponseIsWritable(reply.raw)
    },
    get bufferedBytes() {
      return getWritableBufferedBytes(reply.raw)
    },
  }
}

function generationOperationLineageForJob(job: StreamJob): GenerationOperationLineage | undefined {
  if (
    !job.databaseLineage ||
    !job.operationId ||
    job.attemptNo === undefined ||
    job.writerEpoch === undefined ||
    !job.writerSessionId
  ) {
    return undefined
  }
  return {
    databaseLineage: job.databaseLineage,
    operationId: job.operationId,
    attemptNo: job.attemptNo,
    jobId: job.id,
  }
}

function generationFinalizationLineageForJob(
  job: StreamJob,
  terminalOutcome: GenerationOperationTerminalOutcome,
): Pick<
  GenerationFinalizationAttempt,
  | 'databaseLineage'
  | 'operationId'
  | 'operationAttemptNo'
  | 'actorWriterSessionId'
  | 'actorWriterEpoch'
  | 'acceptedMessageId'
  | 'terminalOutcome'
> {
  const lineage = generationOperationLineageForJob(job)
  if (!lineage) return {}
  return {
    databaseLineage: lineage.databaseLineage,
    operationId: lineage.operationId,
    operationAttemptNo: lineage.attemptNo,
    actorWriterSessionId: job.writerSessionId!,
    actorWriterEpoch: job.writerEpoch!,
    ...(job.acceptedMessageId ? { acceptedMessageId: job.acceptedMessageId } : {}),
    terminalOutcome,
  }
}

function updateJobOperationProjection(job: StreamJob, operation: GenerationOperationProjection): void {
  job.operationStateVersion = operation.stateVersion
  job.projectionEpoch = operation.projectionEpoch
}

function lineageEventForJob(db: DatabaseSync, job: StreamJob, event: PromptChatEvent): PromptChatEvent {
  const lineage = generationOperationLineageForJob(job)
  if (!lineage) return event
  const operation = getGenerationOperationProjection(db, lineage.databaseLineage, lineage.operationId)
  if (operation) updateJobOperationProjection(job, operation)
  return {
    ...event,
    databaseLineage: lineage.databaseLineage,
    operationId: lineage.operationId,
    writerSessionId: job.writerSessionId!,
    writerEpoch: job.writerEpoch!,
    operationStateVersion: operation?.stateVersion ?? job.operationStateVersion!,
    projectionEpoch: operation?.projectionEpoch ?? job.projectionEpoch!,
    attemptNo: lineage.attemptNo,
    jobId: lineage.jobId,
    ...(job.acceptedMessageId ? { acceptedMessageId: job.acceptedMessageId } : {}),
    ...(job.targetMessageId ? { targetMessageId: job.targetMessageId } : {}),
    ...(event.type === 'done' && operation ? { operationState: operation.state } : {}),
  }
}

/**
 * Attach a request connection as a **viewer** of a generation job over SSE: write
 * the event-stream head, send the `job_accepted` frame (so a drop during assembly
 * is reattachable), flush the job's buffered events, then stream live. A client
 * disconnect **detaches** the viewer (does NOT abort the job — that is the core
 * inversion). Used by both the initial `POST` and the reattach `GET`.
 */
function attachGenerationViewer(
  req: FastifyRequest,
  reply: FastifyReply,
  registry: GenerationJobRegistry,
  job: StreamJob,
  db?: DatabaseSync,
  viewerHeartbeatMs?: number,
  onLifecycleTransition?: GenerationChatRouteOptions['onDurableLifecycleTransition'],
): void {
  let client: JobClient | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const onClose = (): void => {
    if (heartbeat) clearInterval(heartbeat)
    if (client) registry.registry.detach(job.id, client)
  }
  try {
    reply.hijack()
    onLifecycleTransition?.('viewer_write_started', job)
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-risu-generation-job-id': job.id,
      ...(job.operationId ? { 'x-risu-generation-operation-id': job.operationId } : {}),
      ...(job.attemptNo !== undefined ? { 'x-risu-generation-attempt-no': String(job.attemptNo) } : {}),
      ...(job.projectionEpoch !== undefined
        ? { 'x-risu-generation-projection-epoch': String(job.projectionEpoch) }
        : {}),
    })
    client = makeSseJobClient(reply)
    client.send(
      formatPromptChatFrame(
        db
          ? lineageEventForJob(db, job, { type: 'job_accepted', jobId: job.id })
          : { type: 'job_accepted', jobId: job.id },
      ),
    )
    registry.registry.attach(job.id, client)
    // SSE comment heartbeat a long assembly or provider connect can
    // leave the stream silent past idle-proxy timeouts before the first token.
    // Comments are invisible to the SSE block parser and are written directly to
    // this viewer's socket — they never enter the job's replay buffer.
    heartbeat = setInterval(
      () => {
        if (!reply.raw.writableEnded) {
          writeBoundedRaw(reply.raw, ': heartbeat\n\n')
        }
      },
      viewerHeartbeatMs ?? job.heartbeatSec * 1000,
    )
    heartbeat.unref()
    req.raw.once('close', onClose)
  } catch (error) {
    req.raw.removeListener('close', onClose)
    if (heartbeat) clearInterval(heartbeat)
    if (client) {
      registry.registry.detach(job.id, client)
      client.close()
    } else {
      try {
        if (!reply.raw.writableEnded) reply.raw.end()
      } catch {
        // Preserve the original attachment failure.
      }
    }
    throw error
  }
  if (!client || !heartbeat) {
    throw new Error('generation viewer attachment did not initialize')
  }
  // Reattach to an already-completed (in-grace) job: `attach` just flushed the
  // buffered terminal frame, and the runner's finally already ran (it cannot close
  // this late viewer), so close + detach here. Otherwise the socket and the job
  // would dangle until the client hangs up (the job is `done` with one client, which
  // neither GC branch collects).
  if (job.done) {
    req.raw.removeListener('close', onClose)
    clearInterval(heartbeat)
    client.close()
    registry.registry.detach(job.id, client)
  }
}

export function attachGenerationOperationViewer(args: {
  req: FastifyRequest
  reply: FastifyReply
  db: DatabaseSync
  generationJobs: GenerationJobRegistry
  job: StreamJob
  options?: GenerationChatRouteOptions
}): void {
  attachGenerationViewer(
    args.req,
    args.reply,
    args.generationJobs,
    args.job,
    args.db,
    args.options?.viewerHeartbeatMs,
    args.options?.onDurableLifecycleTransition,
  )
}

/** Build a `char` assistant message in the shape `dispatchPersistGenerationResult` persists. */
function buildAssistantMessage(args: {
  data: string
  generationId: string
  characterId: string
  generationInfo: Record<string, unknown>
  promptInfo?: Record<string, unknown>
}): Message {
  return {
    role: 'char',
    data: args.data,
    chatId: args.generationId,
    saying: args.characterId,
    time: Date.now(),
    generationInfo: args.generationInfo,
    ...(args.promptInfo ? { promptInfo: args.promptInfo } : {}),
  } as Message
}

/**
 * The assistant row `runServerPostGeneration` appended to the assembler-state chat
 * (carrying the post-gen-derived final text + generation metadata), deep-cloned so
 * it can be written into the freshly-read current chat. Falls back to a constructed
 * row if not found (defensive — a `send` always appends, keyed by `generationId`).
 */
function extractAssistantMessage(
  state: AssemblyState,
  generationId: string,
  finalText: string,
  generationInfo: Record<string, unknown>,
  promptInfo?: Record<string, unknown>,
): Message {
  const row = (state.currentChat.message ?? []).find((message) => message.chatId === generationId)
  if (row) return structuredClone(row) as Message
  return buildAssistantMessage({
    data: finalText,
    generationId,
    characterId: state.currentChar.chaId,
    generationInfo,
    promptInfo,
  })
}

/** Build complete message records for the additional provider choices. */
function buildProviderAlternateMessages(args: {
  primaryMessage: Message
  alternateTexts: readonly string[]
}): Message[] {
  if (args.alternateTexts.length === 0) return []

  const primaryId = args.primaryMessage.chatId ?? randomUUID()
  return args.alternateTexts.map((text, index) => {
    const message = structuredClone(args.primaryMessage)
    message.data = text
    // The browser derives the same ids from `done.alternates`, so a live swipe
    // selects the already-durable candidate instead of creating a duplicate.
    message.chatId = `${primaryId}:alternate:${index + 1}`
    delete message.translation
    return message
  })
}

function rawProviderAlternateText(state: AssemblyState, input: AssembleInput, text: string): string {
  let continueBase = ''
  if (input.mode === 'continue') {
    if (state.continueDisposition === 'append') {
      continueBase = '*says nothing*'
    } else {
      const initialMessages = state.initialMessages ?? []
      for (let index = initialMessages.length - 1; index >= 0; index--) {
        if (initialMessages[index]?.role === 'char') {
          continueBase = initialMessages[index].data ?? ''
          break
        }
      }
    }
  }
  const combined = (continueBase + text).trim()
  return state.database.removeIncompleteResponse ? trimUntilPunctuation(combined) : combined
}

async function transformProviderAlternateTexts(
  state: AssemblyState,
  input: AssembleInput,
  alternateTexts: readonly string[],
): Promise<string[]> {
  const transformed: string[] = []
  for (const text of alternateTexts) {
    try {
      transformed.push(await runServerAlternatePostGeneration(state, text))
    } catch {
      // Keep an alternate usable even if its isolated presentation transform
      // fails; the primary's authoritative post-generation pass is unaffected.
      transformed.push(rawProviderAlternateText(state, input, text))
    }
  }
  return transformed
}

function regenerateTargetMessageIdFromInitialMessages(
  input: AssembleInput,
  initialMessages: readonly Message[] | undefined,
): string | undefined {
  if (input.mode !== 'regenerate') return undefined
  const targetMessageId = input.regenerateMessageId
  if (!targetMessageId) return undefined
  const target = initialMessages?.find((message) => message.chatId === targetMessageId)
  return target?.role === 'char' ? targetMessageId : undefined
}

function rowMatchesSnapshot(row: unknown, snapshot: GenerationFinalizationSnapshotRow): boolean {
  return isDeepStrictEqual(row, snapshot.message)
}

function rowMatchesMessage(row: unknown, message: Message): boolean {
  if (!isRecord(row)) return false
  if (row.role !== message.role || row.data !== message.data) return false
  return message.chatId === undefined || row.chatId === message.chatId
}

function finalizationAlreadyPersisted(args: {
  liveRows: readonly unknown[]
  snapshot: GenerationFinalizationTargetSnapshot
  message: Message
}): boolean {
  if (args.snapshot.kind === 'target-tail') {
    return (
      args.liveRows.length >= args.snapshot.transcriptLength &&
      rowMatchesMessage(args.liveRows[args.snapshot.transcriptLength - 1], args.message)
    )
  }
  return args.liveRows.length > args.snapshot.transcriptLength
    ? rowMatchesMessage(args.liveRows[args.snapshot.transcriptLength], args.message)
    : false
}

function automaticConfirmationAcceptedUserMessageId(args: {
  mode?: GenerationFinalizationMode
  targetSnapshot?: GenerationFinalizationTargetSnapshot
  operationLineage?: { acceptedMessageId?: string; terminalOutcome: GenerationOperationTerminalOutcome }
}): string | undefined {
  if (args.mode !== 'send') return undefined
  if (args.operationLineage?.acceptedMessageId) return args.operationLineage.acceptedMessageId
  if (args.targetSnapshot?.mode !== 'send' || args.targetSnapshot.kind !== 'tail') return undefined
  const tail = args.targetSnapshot.tail?.message
  return tail?.role === 'user' && typeof tail.chatId === 'string' ? tail.chatId : undefined
}

function validateGenerationFinalizationTargetFresh(args: {
  chatId: string
  liveRows: readonly unknown[]
  snapshot: GenerationFinalizationTargetSnapshot
  message: Message
}): { alreadyPersisted: boolean } {
  if (finalizationAlreadyPersisted(args)) {
    return { alreadyPersisted: true }
  }

  if (args.liveRows.length !== args.snapshot.transcriptLength) {
    throw new ValidationError(`Generation finalization target is stale for chat ${args.chatId}`)
  }

  const liveTail = args.liveRows.at(-1)
  if (args.snapshot.kind === 'target-tail') {
    if (!rowMatchesSnapshot(liveTail, args.snapshot.target)) {
      throw new ValidationError(`Generation finalization target is stale for chat ${args.chatId}`)
    }
  } else if (args.snapshot.tail) {
    if (!rowMatchesSnapshot(liveTail, args.snapshot.tail)) {
      throw new ValidationError(`Generation finalization target is stale for chat ${args.chatId}`)
    }
  } else if (liveTail !== undefined) {
    throw new ValidationError(`Generation finalization target is stale for chat ${args.chatId}`)
  }

  return { alreadyPersisted: false }
}

class GenerationFinalizationAlreadyPersistedNoop extends Error {
  constructor(readonly revision: number) {
    super('generation finalization already persisted')
    this.name = 'GenerationFinalizationAlreadyPersistedNoop'
  }
}

function readAlreadyPersistedGenerationFinalizationRevision(args: {
  db: DatabaseSync
  chatId: string
  snapshot: GenerationFinalizationTargetSnapshot
  message: Message
}): number | undefined {
  let transactionOpen = false
  args.db.exec('BEGIN IMMEDIATE')
  transactionOpen = true
  try {
    const { revision } = getSchemaState(args.db)
    const alreadyPersisted = finalizationAlreadyPersisted({
      liveRows: getChatMessages(args.db, args.chatId),
      snapshot: args.snapshot,
      message: args.message,
    })
    args.db.exec('COMMIT')
    transactionOpen = false
    return alreadyPersisted ? revision : undefined
  } catch (err) {
    if (transactionOpen) {
      args.db.exec('ROLLBACK')
    }
    throw err
  }
}

function liveChatVarMutationValue(value: unknown): string | number | boolean | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return null
}

function validateGenerationChatVarMutationsFresh(args: {
  chatId: string
  chat: { scriptstate?: Record<string, unknown> }
  chatVarMutations: AssembleMutationPayload['chatVarMutations']
}): void {
  for (const mutation of args.chatVarMutations) {
    const before = liveChatVarMutationValue(args.chat.scriptstate?.[mutation.key])
    if (before !== mutation.before) {
      throw new ValidationError(`Generation chat variable is stale for chat ${args.chatId}: ${mutation.key}`)
    }
  }
}

type GenerationScriptMutationConflict =
  | { scope: 'chat_variable'; key: string }
  | { scope: 'character_field'; key: string }
  | { scope: 'local_lore' }

interface AppliedGenerationScriptMutations {
  chatVarMutations: AssembleMutationPayload['chatVarMutations']
  characterFieldMutations: NonNullable<AssembleMutationPayload['characterFieldMutations']>
  localLoreMutation?: AssembleMutationPayload['localLoreMutation']
}

interface GenerationFinalizationPersistenceResult extends AppliedGenerationScriptMutations {
  revision: number
  droppedScriptMutations: GenerationScriptMutationConflict[]
  bookkeepingErrors: Array<{ phase: 'event_emission'; error: string }>
  effectLedger?: GenerationEffectLedgerRef
  bardWikiJobEnqueued?: BardWikiJobSummary
}

function applyGenerationChatVarMutationsDroppingConflicts(args: {
  chat: { scriptstate?: Record<string, unknown> }
  chatVarMutations: AssembleMutationPayload['chatVarMutations']
}): {
  applied: AssembleMutationPayload['chatVarMutations']
  dropped: GenerationScriptMutationConflict[]
} {
  const applied: AssembleMutationPayload['chatVarMutations'] = []
  const dropped: GenerationScriptMutationConflict[] = []
  for (const mutation of args.chatVarMutations) {
    const before = liveChatVarMutationValue(args.chat.scriptstate?.[mutation.key])
    if (before !== mutation.before) {
      dropped.push({ scope: 'chat_variable', key: mutation.key })
      continue
    }
    if (mutation.after === null) {
      if (args.chat.scriptstate) delete args.chat.scriptstate[mutation.key]
    } else {
      args.chat.scriptstate ??= {}
      args.chat.scriptstate[mutation.key] = mutation.after
    }
    applied.push(mutation)
  }
  if (args.chat.scriptstate && Object.keys(args.chat.scriptstate).length === 0) {
    delete args.chat.scriptstate
  }
  return { applied, dropped }
}

function liveCharacterFieldValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function applyGenerationCharacterFieldMutationsFresh(args: {
  characterId: string
  character: Record<string, unknown>
  characterFieldMutations: AssembleMutationPayload['characterFieldMutations']
}): void {
  for (const mutation of args.characterFieldMutations ?? []) {
    if (liveCharacterFieldValue(args.character[mutation.key]) !== mutation.before) {
      throw new ValidationError(
        `Generation character field is stale for character ${args.characterId}: ${mutation.key}`,
      )
    }
    args.character[mutation.key] = mutation.after
  }
}

function applyGenerationCharacterFieldMutationsDroppingConflicts(args: {
  character: Record<string, unknown>
  characterFieldMutations: AssembleMutationPayload['characterFieldMutations']
}): {
  applied: NonNullable<AssembleMutationPayload['characterFieldMutations']>
  dropped: GenerationScriptMutationConflict[]
} {
  const applied: NonNullable<AssembleMutationPayload['characterFieldMutations']> = []
  const dropped: GenerationScriptMutationConflict[] = []
  for (const mutation of args.characterFieldMutations ?? []) {
    if (liveCharacterFieldValue(args.character[mutation.key]) !== mutation.before) {
      dropped.push({ scope: 'character_field', key: mutation.key })
      continue
    }
    args.character[mutation.key] = mutation.after
    applied.push(mutation)
  }
  return { applied, dropped }
}

function repairGenerationLocalLoreEntryIds(entries: unknown[]): void {
  const reservedIds = new Set<string>()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError('Generation local lore entries must be objects')
    }
    const id = (entry as { id?: unknown }).id
    if (typeof id === 'string' && id.trim().length > 0) reservedIds.add(id)
  }

  const assignedIds = new Set<string>()
  for (const entry of entries as Array<Record<string, unknown>>) {
    const id = entry.id
    if (typeof id === 'string' && id.trim().length > 0 && !assignedIds.has(id)) {
      assignedIds.add(id)
      continue
    }

    let replacementId = randomUUID()
    while (reservedIds.has(replacementId)) replacementId = randomUUID()
    entry.id = replacementId
    reservedIds.add(replacementId)
    assignedIds.add(replacementId)
  }
}

function applyGenerationLocalLoreMutationFresh(args: {
  chatId: string
  chat: Record<string, unknown>
  localLoreMutation: AssembleMutationPayload['localLoreMutation']
}): void {
  if (!args.localLoreMutation) return
  const live = Array.isArray(args.chat.localLore) ? args.chat.localLore : []
  if (!isDeepStrictEqual(live, args.localLoreMutation.before)) {
    throw new ValidationError(`Generation local lore is stale for chat ${args.chatId}`)
  }
  // Keep the untouched snapshots as the freshness fence and repair only the
  // cloned value that will be written.
  const after = structuredClone(args.localLoreMutation.after)
  repairGenerationLocalLoreEntryIds(after)
  args.chat.localLore = after
}

function localLoreEntryId(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const id = (entry as { id?: unknown }).id
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined
}

function uniqueLocalLoreEntriesById(entries: readonly unknown[]): Map<string, unknown> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const id = localLoreEntryId(entry)
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const unique = new Map<string, unknown>()
  for (const entry of entries) {
    const id = localLoreEntryId(entry)
    if (id && counts.get(id) === 1) unique.set(id, entry)
  }
  return unique
}

function unaddressableLocalLoreEntries(entries: readonly unknown[]): unknown[] {
  const unique = uniqueLocalLoreEntriesById(entries)
  return entries.filter((entry) => {
    const id = localLoreEntryId(entry)
    return !id || !unique.has(id)
  })
}

function applyGenerationLocalLoreMutationDroppingConflicts(args: {
  chat: Record<string, unknown>
  localLoreMutation: AssembleMutationPayload['localLoreMutation']
}): {
  applied?: AssembleMutationPayload['localLoreMutation']
  dropped: GenerationScriptMutationConflict[]
} {
  if (!args.localLoreMutation) return { dropped: [] }
  const live = Array.isArray(args.chat.localLore) ? args.chat.localLore : []
  const before = args.localLoreMutation.before
  const scriptedAfter = args.localLoreMutation.after

  // Preserve the established fast path, including generation-owned repair of
  // degraded legacy ids, when no concurrent lore write occurred.
  if (isDeepStrictEqual(live, before)) {
    const after = structuredClone(scriptedAfter)
    repairGenerationLocalLoreEntryIds(after)
    args.chat.localLore = after
    return { applied: { before, after }, dropped: [] }
  }

  const beforeById = uniqueLocalLoreEntriesById(before)
  const afterById = uniqueLocalLoreEntriesById(scriptedAfter)
  const liveById = uniqueLocalLoreEntriesById(live)
  const scriptedIds = new Set([...beforeById.keys(), ...afterById.keys()])
  const changedIds = [...scriptedIds].filter((id) => !isDeepStrictEqual(beforeById.get(id), afterById.get(id)))
  let conflict = !isDeepStrictEqual(unaddressableLocalLoreEntries(before), unaddressableLocalLoreEntries(scriptedAfter))
  let appliedEntry = false
  const merged = structuredClone(live) as unknown[]

  for (const id of changedIds) {
    const previous = beforeById.get(id)
    const desired = afterById.get(id)
    const current = liveById.get(id)
    if (previous !== undefined && !isDeepStrictEqual(current, previous)) {
      // An identical desired value is already converged, not a conflict.
      if (!isDeepStrictEqual(current, desired)) conflict = true
      continue
    }
    if (previous === undefined && current !== undefined) {
      if (!isDeepStrictEqual(current, desired)) conflict = true
      continue
    }

    const index = merged.findIndex((entry) => localLoreEntryId(entry) === id)
    if (desired === undefined) {
      if (index >= 0) merged.splice(index, 1)
    } else if (index >= 0) {
      merged[index] = structuredClone(desired)
    } else {
      merged.push(structuredClone(desired))
    }
    appliedEntry = true
  }

  if (!appliedEntry) {
    return { dropped: conflict ? [{ scope: 'local_lore' }] : [] }
  }
  repairGenerationLocalLoreEntryIds(merged)
  const liveBefore = structuredClone(live) as typeof before
  args.chat.localLore = merged
  return {
    applied: { before: liveBefore, after: merged as typeof scriptedAfter },
    dropped: conflict ? [{ scope: 'local_lore' }] : [],
  }
}

type GenerationFinalizationMutationExtra = Record<string, unknown> &
  AppliedGenerationScriptMutations & {
    chatId: string
    messageId: string
    droppedScriptMutations: GenerationScriptMutationConflict[]
    effectLedger?: GenerationEffectLedgerRef
  }

/**
 * Persist a durable generation result in one targeted command mutation against a
 * freshly read chat: apply post-gen scriptstate changes, append/replace the
 * assistant row, and avoid duplicate rows for the same generation.
 * Matches the shape + `generation.persisted` event the browser command path
 * (`dispatchPersistGenerationResult` → the `/generation-result` route) produces, so
 * the result is byte-identical whether server- or (legacy) browser-written.
 */
function persistServerGenerationResult(args: {
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  chatId: string
  message: Message
  /** Additional provider choices persisted as reroll candidates atomically. */
  alternateMessages?: readonly Message[]
  chatVarMutations: AssembleMutationPayload['chatVarMutations']
  characterFieldMutations?: AssembleMutationPayload['characterFieldMutations']
  localLoreMutation?: AssembleMutationPayload['localLoreMutation']
  /**
   * Continue/regenerate target. When set, the result REPLACES the existing
   * message at this id (the regenerate target, or the continue row) rather than
   * appending/replacing by the result's own `chatId` — identical semantics to
   * the legacy browser `/generation-result` command (`lookupMessageId`). `send`
   * leaves it unset and appends by `generationId`.
   */
  targetMessageId?: string
  mode?: GenerationFinalizationMode
  automaticConfirmationEligible?: boolean
  targetSnapshot?: GenerationFinalizationTargetSnapshot
  operationLineage?: {
    databaseLineage: string
    operationId: string
    operationAttemptNo: number
    generationId: string
    terminalOutcome: GenerationOperationTerminalOutcome
    acceptedMessageId?: string
  }
}): GenerationFinalizationPersistenceResult {
  let bardWikiJobEnqueued: BardWikiJobSummary | undefined
  if (args.targetSnapshot) {
    const replayRevision = readAlreadyPersistedGenerationFinalizationRevision({
      db: args.db,
      chatId: args.chatId,
      snapshot: args.targetSnapshot,
      message: args.message,
    })
    if (replayRevision !== undefined) {
      return {
        revision: replayRevision,
        chatVarMutations: [],
        characterFieldMutations: [],
        droppedScriptMutations: [],
        bookkeepingErrors: [],
      }
    }
  }
  const { revision: baseRevision } = getSchemaState(args.db)
  const bookkeepingErrors: GenerationFinalizationPersistenceResult['bookkeepingErrors'] = []
  const finalizationEventSink: CommandEventSink = {
    emit(event) {
      try {
        args.eventSink.emit(event)
      } catch (err) {
        bookkeepingErrors.push({
          phase: 'event_emission',
          error: errorMessage(err, 'failed to emit the committed generation event'),
        })
      }
    },
    list: () => args.eventSink.list(),
    clear: () => args.eventSink.clear(),
    subscribe: (listener) => args.eventSink.subscribe(listener),
  }
  try {
    const result = applyTargetedCommandMutation<GenerationFinalizationMutationExtra>({
      db: args.db,
      dataDir: args.dataDir,
      baseRevision,
      eventSink: finalizationEventSink,
      mutationPath: 'targeted-generation',
      chatScopedRead: { chatId: args.chatId, exactChatRow: args.localLoreMutation !== undefined },
      mutate(database, targetDb) {
        const characters = [(database as { characters?: unknown[] }).characters?.[0]].filter(
          Boolean,
        ) as import('../commands/characters.js').CharacterRecord[]
        const { character, chat } = requireChatLocationExact(characters, args.chatId)
        if (args.targetSnapshot) {
          const freshness = validateGenerationFinalizationTargetFresh({
            chatId: args.chatId,
            liveRows: getChatMessages(targetDb, args.chatId),
            snapshot: args.targetSnapshot,
            message: args.message,
          })
          if (freshness.alreadyPersisted) {
            throw new GenerationFinalizationAlreadyPersistedNoop(baseRevision)
          }
        }
        const chatVarResult = applyGenerationChatVarMutationsDroppingConflicts({
          chat,
          chatVarMutations: args.chatVarMutations,
        })
        const characterFieldResult = applyGenerationCharacterFieldMutationsDroppingConflicts({
          character,
          characterFieldMutations: args.characterFieldMutations,
        })
        const localLoreResult = applyGenerationLocalLoreMutationDroppingConflicts({
          chat,
          localLoreMutation: args.localLoreMutation,
        })
        const droppedScriptMutations = [
          ...chatVarResult.dropped,
          ...characterFieldResult.dropped,
          ...localLoreResult.dropped,
        ]
        const hasScriptstateWrite = chatVarResult.applied.length > 0
        const hasCharacterWrite = characterFieldResult.applied.length > 0
        const hasLocalLoreWrite = localLoreResult.applied !== undefined
        const record = createMessageRecord(structuredClone(args.message), 'generationResult.message')
        const providerAlternates = (args.alternateMessages ?? []).map((message, index) =>
          createMessageRecord(structuredClone(message), `generationResult.alternateMessages[${index}]`),
        )
        validateUniqueMessageIds([record, ...providerAlternates])
        for (const alternate of providerAlternates) {
          if (activeMessageIdExists(targetDb, alternate.chatId)) {
            throw new ValidationError(`Duplicate message id: ${alternate.chatId}`)
          }
        }
        const write = writeGenerationChatMessage(targetDb, args.chatId, record, args.targetMessageId)
        if (write.ok === false) {
          switch (write.reason) {
            case 'missing-target':
              throw new EntityNotFoundError(`Message not found for chat ${args.chatId}: ${write.targetMessageId}`)
            case 'duplicate':
              throw new ValidationError(`Duplicate message id: ${write.messageId}`)
            case 'ambiguous':
              throw new ValidationError(`Ambiguous message id: ${write.messageId}`)
          }
        }
        // Reroll buffer ("don't lose a rerolled result"):
        //  - regenerate REPLACES a candidate; preserve BOTH the
        //    one it displaces AND the new one it produces as alternate rows, so the
        //    full candidate set of the turn survives a reload and swipe-navigation is
        //    durable for free (flipping the active tail never touches the buffer — the
        //    active is just whichever candidate is positioned, matched by `uid` on
        //    hydration). Dedup by `uid` keeps it
        //    replay-idempotent and free of duplicates as candidates accumulate.
        //  - send / continue is the confirm boundary — drop the chat's reroll buffer.
        //    A targetless same-uid collision is anomalous, however, so preserve
        //    both versions instead of silently discarding the displaced row.
        // Both run inside this mutation's transaction (atomic with the message write).
        const preservesRerollCandidate =
          args.mode !== 'continue' &&
          (!!args.targetMessageId ||
            !!write.displaced ||
            (args.mode === 'regenerate' && countAlternateMessages(targetDb, args.chatId) > 0))
        if (providerAlternates.length > 0) {
          if (!preservesRerollCandidate) clearAlternateMessages(targetDb, args.chatId)
          if (preservesRerollCandidate && write.displaced) addAlternateMessage(targetDb, args.chatId, write.displaced)
          addAlternateMessage(targetDb, args.chatId, record)
          for (const alternate of providerAlternates) {
            addAlternateMessage(targetDb, args.chatId, alternate)
          }
        } else if (preservesRerollCandidate) {
          if (write.displaced) addAlternateMessage(targetDb, args.chatId, write.displaced)
          addAlternateMessage(targetDb, args.chatId, record)
        } else {
          clearAlternateMessages(targetDb, args.chatId)
        }
        const effectiveFinalizationMode = args.mode ?? args.targetSnapshot?.mode ?? 'send'
        if (effectiveFinalizationMode === 'send' && args.automaticConfirmationEligible === true) {
          const acceptedUserMessageId = automaticConfirmationAcceptedUserMessageId(args)
          const confirmation = createOrReuseAutomaticBardWikiConfirmation(targetDb, {
            chatId: args.chatId,
            resultAssistantMessageId: write.messageId,
            ...(acceptedUserMessageId ? { acceptedUserMessageId } : {}),
            fallbackMessages: chat.message,
          })
          if (confirmation?.created) bardWikiJobEnqueued = confirmation.job
        }
        if (hasScriptstateWrite || hasLocalLoreWrite) {
          if (hasLocalLoreWrite) {
            writeSingleChatRowExact(targetDb, args.chatId, chat)
          } else {
            writeSingleChatRow(targetDb, args.chatId, chat)
          }
        }
        if (hasCharacterWrite) {
          writeSingleCharacterRow(targetDb, character.chaId as string, character)
        }
        const event =
          hasScriptstateWrite || hasCharacterWrite || hasLocalLoreWrite
            ? {
                ...COMMAND_EVENT_CATALOG.generationPersistedWithChatState,
                id: args.chatId,
                parentId: character.chaId as string,
              }
            : {
                ...COMMAND_EVENT_CATALOG.generationPersisted,
                id: write.messageId,
                parentId: args.chatId,
              }
        if (args.operationLineage) {
          completeGenerationOperationFinalizationInTransaction(targetDb, {
            databaseLineage: args.operationLineage.databaseLineage,
            operationId: args.operationLineage.operationId,
            attemptNo: args.operationLineage.operationAttemptNo,
            jobId: args.operationLineage.generationId,
            terminalOutcome: args.operationLineage.terminalOutcome,
            resultMessageId: write.messageId,
          })
        }
        const effectLedger =
          args.operationLineage?.terminalOutcome === 'completed'
            ? ensureGenerationEffectLedgerInTransaction(targetDb, {
                databaseLineage: args.operationLineage.databaseLineage,
                operationId: args.operationLineage.operationId,
                operationProtocolVersion:
                  getGenerationOperationProjection(
                    targetDb,
                    args.operationLineage.databaseLineage,
                    args.operationLineage.operationId,
                  )?.protocolVersion ?? 0,
                generationId: args.operationLineage.generationId,
                characterId: character.chaId as string,
                chatId: args.chatId,
                messageId: write.messageId,
              })
            : undefined
        return {
          event: args.operationLineage
            ? {
                ...event,
                databaseLineage: args.operationLineage.databaseLineage,
                operationId: args.operationLineage.operationId,
                ...(args.operationLineage.acceptedMessageId
                  ? { sourceMessageId: args.operationLineage.acceptedMessageId }
                  : {}),
                jobId: args.operationLineage.generationId,
              }
            : event,
          extra: {
            chatId: args.chatId,
            messageId: write.messageId,
            chatVarMutations: chatVarResult.applied,
            characterFieldMutations: characterFieldResult.applied,
            ...(localLoreResult.applied ? { localLoreMutation: localLoreResult.applied } : {}),
            droppedScriptMutations,
            ...(effectLedger ? { effectLedger } : {}),
          },
        }
      },
    })
    const persistence = {
      revision: result.revision,
      chatVarMutations: result.extra.chatVarMutations,
      characterFieldMutations: result.extra.characterFieldMutations,
      ...(result.extra.localLoreMutation ? { localLoreMutation: result.extra.localLoreMutation } : {}),
      droppedScriptMutations: result.extra.droppedScriptMutations,
      bookkeepingErrors,
      ...(result.extra.effectLedger ? { effectLedger: result.extra.effectLedger } : {}),
      ...(bardWikiJobEnqueued ? { bardWikiJobEnqueued } : {}),
    }
    if (persistence.droppedScriptMutations.length > 0) {
      emitProtocolMetric('generation_script_mutation_conflict', {
        status: 'dropped',
        chatId: args.chatId,
        messageId: args.message.chatId,
        droppedMutationCount: persistence.droppedScriptMutations.length,
        droppedMutations: persistence.droppedScriptMutations,
      })
    }
    return persistence
  } catch (err) {
    if (err instanceof GenerationFinalizationAlreadyPersistedNoop) {
      return {
        revision: err.revision,
        chatVarMutations: [],
        characterFieldMutations: [],
        droppedScriptMutations: [],
        bookkeepingErrors: [],
        ...(args.operationLineage
          ? {
              effectLedger: generationEffectLedgerRef(
                args.db,
                args.operationLineage.databaseLineage,
                args.operationLineage.generationId,
              ),
            }
          : {}),
      }
    }
    throw err
  }
}

function finalizationModeFromInput(input: AssembleInput): GenerationFinalizationMode {
  return input.mode === 'continue' || input.mode === 'regenerate' ? input.mode : 'send'
}

function isTerminalGenerationFinalizationError(err: unknown): boolean {
  return err instanceof EntityNotFoundError || err instanceof ValidationError
}

function persistGenerationFinalizationAttempt(args: {
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  attempt: GenerationFinalizationAttempt
}): GenerationFinalizationPersistenceResult {
  return persistServerGenerationResult({
    db: args.db,
    dataDir: args.dataDir,
    eventSink: args.eventSink,
    chatId: args.attempt.chatId,
    message: args.attempt.message,
    alternateMessages: args.attempt.alternateMessages,
    chatVarMutations: args.attempt.chatVarMutations,
    characterFieldMutations: args.attempt.characterFieldMutations,
    localLoreMutation: args.attempt.localLoreMutation,
    targetMessageId: args.attempt.targetMessageId,
    mode: args.attempt.mode,
    targetSnapshot: args.attempt.targetSnapshot,
    automaticConfirmationEligible: args.attempt.automaticConfirmationEligible === true,
    ...(args.attempt.databaseLineage &&
    args.attempt.operationId &&
    args.attempt.operationAttemptNo !== undefined &&
    args.attempt.terminalOutcome
      ? {
          operationLineage: {
            databaseLineage: args.attempt.databaseLineage,
            operationId: args.attempt.operationId,
            operationAttemptNo: args.attempt.operationAttemptNo,
            generationId: args.attempt.generationId,
            terminalOutcome: args.attempt.terminalOutcome,
            ...(args.attempt.acceptedMessageId ? { acceptedMessageId: args.attempt.acceptedMessageId } : {}),
          },
        }
      : {}),
  })
}

type GenerationFinalizationOutcome =
  | {
      kind: 'persisted'
      persistence: GenerationFinalizationPersistenceResult
      journalConfirmed: true
      authoritativeCommitted: true
      cleanupComplete: true
    }
  | {
      kind: 'committed_cleanup_pending'
      persistence: GenerationFinalizationPersistenceResult
      cleanupError: unknown
      journalConfirmed: true
      authoritativeCommitted: true
      cleanupComplete: false
    }
  | {
      kind: 'queued'
      error: unknown
      bookkeepingError?: unknown
      journalConfirmed: true
      authoritativeCommitted: false
      cleanupComplete: false
    }
  | {
      kind: 'rejected'
      error: unknown
      bookkeepingError?: unknown
      journalConfirmed: true
      authoritativeCommitted: false
      cleanupComplete: false
    }
  | {
      kind: 'unconfirmed'
      error: unknown
      journalConfirmed: false
      authoritativeCommitted: false
      cleanupComplete: false
    }

function recordConfirmedGenerationFinalizationFailure(args: {
  db: DatabaseSync
  attempt: GenerationFinalizationAttempt
  err: unknown
}): unknown | undefined {
  try {
    markGenerationFinalizationRetryFailure(
      args.db,
      args.attempt.generationId,
      errorMessage(args.err, 'failed to persist the generation result'),
      isTerminalGenerationFinalizationError(args.err),
    )
    return undefined
  } catch (bookkeepingError) {
    return bookkeepingError
  }
}

function recordFinalizationDiagnostic(
  outcome: GenerationFinalizationOutcome,
  startedAt: number,
  phase?: 'journal' | 'bookkeeping',
): void {
  recordDiagnosticEvent({
    category: 'persistence',
    level:
      outcome.kind === 'persisted'
        ? outcome.persistence.bookkeepingErrors.length > 0
          ? 'warn'
          : 'info'
        : outcome.kind === 'rejected' || outcome.kind === 'unconfirmed'
          ? 'error'
          : 'warn',
    phase:
      phase ??
      (outcome.kind === 'persisted'
        ? outcome.persistence.bookkeepingErrors.length > 0
          ? 'bookkeeping'
          : 'complete'
        : outcome.kind === 'committed_cleanup_pending'
          ? 'cleanup'
          : outcome.kind === 'unconfirmed'
            ? 'journal'
            : outcome.bookkeepingError
              ? 'bookkeeping'
              : 'authoritative_commit'),
    disposition:
      outcome.kind === 'persisted'
        ? 'committed'
        : outcome.kind === 'committed_cleanup_pending'
          ? 'cleanup-pending'
          : outcome.kind === 'rejected'
            ? 'terminal'
            : outcome.kind === 'unconfirmed'
              ? 'failed'
              : 'retryable',
    durationMs: protocolDurationMs(startedAt),
    journalConfirmed: outcome.journalConfirmed,
    authoritativeCommitted: outcome.authoritativeCommitted,
    cleanupComplete: outcome.cleanupComplete,
    ...('error' in outcome ? { contention: sqliteContention(outcome.error) } : {}),
  })
}

function sqliteContention(error: unknown): boolean {
  // SQLite BUSY/LOCKED are numeric driver facts, never message matching.
  return !!error && typeof error === 'object' && 'errcode' in error && (error.errcode === 5 || error.errcode === 6)
}

function persistConfirmedGenerationFinalization(args: {
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  attempt: GenerationFinalizationAttempt
}): Exclude<GenerationFinalizationOutcome, { kind: 'unconfirmed' }> {
  const diagnosticStartedAt = protocolNowMs()
  const finish = <T extends Exclude<GenerationFinalizationOutcome, { kind: 'unconfirmed' }>>(outcome: T): T => {
    recordFinalizationDiagnostic(outcome, diagnosticStartedAt)
    return outcome
  }
  let persistence: GenerationFinalizationPersistenceResult
  try {
    persistence = persistGenerationFinalizationAttempt(args)
  } catch (err) {
    const bookkeepingError = recordConfirmedGenerationFinalizationFailure({
      db: args.db,
      attempt: args.attempt,
      err,
    })
    if (isTerminalGenerationFinalizationError(err) && args.attempt.databaseLineage && args.attempt.operationId) {
      const operation = getGenerationOperationProjection(
        args.db,
        args.attempt.databaseLineage,
        args.attempt.operationId,
      )
      if (operation?.state === 'finalizing') {
        transitionGenerationOperation(args.db, {
          databaseLineage: args.attempt.databaseLineage,
          operationId: args.attempt.operationId,
          expectedState: 'finalizing',
          expectedStateVersion: operation.stateVersion,
          nextState: 'terminal_failed',
          failureCode: 'operation_target_stale',
          failurePhase: 'finalization',
          lastError: errorMessage(err, 'generation finalization target is stale'),
          providerMayHaveRun: true,
        })
      }
    }
    return finish({
      kind: isTerminalGenerationFinalizationError(err) ? 'rejected' : 'queued',
      error: err,
      ...(bookkeepingError ? { bookkeepingError } : {}),
      journalConfirmed: true,
      authoritativeCommitted: false,
      cleanupComplete: false,
    })
  }

  try {
    deleteGenerationFinalizationRetry(args.db, args.attempt.generationId)
  } catch (cleanupError) {
    return finish({
      kind: 'committed_cleanup_pending',
      persistence,
      cleanupError,
      journalConfirmed: true,
      authoritativeCommitted: true,
      cleanupComplete: false,
    })
  }
  return finish({
    kind: 'persisted',
    persistence,
    journalConfirmed: true,
    authoritativeCommitted: true,
    cleanupComplete: true,
  })
}

function queueAndPersistGenerationFinalization(args: {
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  attempt: GenerationFinalizationAttempt
}): GenerationFinalizationOutcome {
  const diagnosticStartedAt = protocolNowMs()
  recordDiagnosticEvent({
    category: 'generation',
    level: 'info',
    stage: 'finalization',
    outcome: 'pending',
    providerMayHaveRun: true,
  })
  try {
    // Shutdown guard an aborted runner's cancel-persist can land
    // after `onClose` closed the SQLite handle (the runner-settle wait covers
    // tracked runners; this covers any straggler). Fail with a clear error
    // instead of touching a closed database.
    if (!args.db.isOpen) {
      throw new Error('database is closed; generation finalization skipped (server shutting down)')
    }
    enqueueGenerationFinalizationRetry(args.db, args.attempt)
  } catch (err) {
    const outcome = {
      kind: 'unconfirmed',
      error: err,
      journalConfirmed: false,
      authoritativeCommitted: false,
      cleanupComplete: false,
    } as const
    recordFinalizationDiagnostic(outcome, diagnosticStartedAt, 'journal')
    return outcome
  }
  if (args.attempt.databaseLineage && args.attempt.operationId && args.attempt.terminalOutcome) {
    try {
      const operation = getGenerationOperationProjection(
        args.db,
        args.attempt.databaseLineage,
        args.attempt.operationId,
      )
      if (operation?.state === 'owned_by_job' || operation?.state === 'stopping') {
        const transitioned = transitionGenerationOperation(args.db, {
          databaseLineage: args.attempt.databaseLineage,
          operationId: args.attempt.operationId,
          expectedState: operation.state,
          expectedStateVersion: operation.stateVersion,
          nextState: 'finalizing',
          desiredTerminalOutcome: args.attempt.terminalOutcome,
          finalizationGenerationId: args.attempt.generationId,
        })
        if (transitioned.status !== 'applied') {
          throw new Error('generation operation changed before finalization could be bound')
        }
      } else if (operation?.state !== 'finalizing' && operation?.state !== args.attempt.terminalOutcome) {
        throw new Error('generation operation is not eligible for finalization')
      }
    } catch (err) {
      const outcome = {
        kind: 'queued',
        error: err,
        journalConfirmed: true,
        authoritativeCommitted: false,
        cleanupComplete: false,
      } as const
      recordFinalizationDiagnostic(outcome, diagnosticStartedAt, 'bookkeeping')
      return outcome
    }
  }
  return persistConfirmedGenerationFinalization(args)
}

export function retryQueuedGenerationFinalizations(args: {
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  logger?: GenerationFinalizationRetryLogger
  maxPerSweep?: number
  now?: string | Date
  baseDelayMs?: number
  maxDelayMs?: number
  pushNotifications?: false | PushNotificationService
  messageTranslationJobs: MessageTranslationJobRegistry
  runMessageTranslation?: ServerMessageTranslationRunner
  onBardWikiJobEnqueued?: (job: BardWikiJobSummary) => void
}): { attempted: number; persisted: number; terminal: number; retryable: number } {
  // Shutdown guard a sweep that fires while `onClose` is tearing
  // down must not touch the closed handle.
  if (!args.db.isOpen) {
    return { attempted: 0, persisted: 0, terminal: 0, retryable: 0 }
  }
  const retries = listPendingGenerationFinalizationRetries(args.db, {
    limit: args.maxPerSweep,
    now: args.now,
    baseDelayMs: args.baseDelayMs,
    maxDelayMs: args.maxDelayMs,
  })
  if (retries.length === 0) return { attempted: 0, persisted: 0, terminal: 0, retryable: 0 }
  let queueDepth: number | undefined
  try {
    queueDepth = (
      args.db
        .prepare("SELECT COUNT(*) AS count FROM generation_finalization_retries WHERE status = 'pending'")
        .get() as { count: number }
    ).count
  } catch {
    // Queue measurement never changes retry selection or execution.
  }
  let persisted = 0
  let terminal = 0
  let retryable = 0
  for (const retry of retries) {
    const { attempt } = retry
    runWithDiagnosticContext(
      args.db,
      {
        databaseLineage: attempt.databaseLineage,
        operationId: attempt.operationId ?? attempt.generationId,
        attemptId: attempt.generationId,
        background: true,
      },
      () => {
        const startedAt = protocolNowMs()
        recordDiagnosticEvent({
          category: 'generation',
          level: 'info',
          stage: 'recovery',
          outcome: 'pending',
          providerMayHaveRun: true,
        })
        const createdAt = Date.parse(retry.createdAt)
        recordDiagnosticEvent({
          category: 'persistence',
          level: 'info',
          phase: 'journal',
          disposition: 'queued',
          durationMs: 0,
          journalConfirmed: true,
          retryCount: retry.failureCount,
          queueDepth,
          ...(Number.isFinite(createdAt)
            ? { queueAgeMs: Math.min(86_400_000, Math.max(0, Date.now() - createdAt)) }
            : {}),
        })
        if (retry.replayability === 'legacy_snapshot_missing') {
          try {
            markGenerationFinalizationRetryFailure(
              args.db,
              attempt.generationId,
              GENERATION_FINALIZATION_LEGACY_SNAPSHOT_ERROR,
              true,
            )
            terminal += 1
            recordDiagnosticEvent({
              category: 'persistence',
              level: 'error',
              phase: 'replay_fence',
              disposition: 'terminal',
              durationMs: protocolDurationMs(startedAt),
              journalConfirmed: true,
              authoritativeCommitted: false,
              cleanupComplete: false,
              retryCount: retry.failureCount,
            })
            args.logger?.warn(
              {
                generationId: attempt.generationId,
                chatId: attempt.chatId,
                mode: attempt.mode,
                phase: 'replay_fence',
              },
              'legacy generation finalization retry quarantined without replay',
            )
            emitProtocolMetric('generation_persistence_retry', {
              status: GENERATION_FINALIZATION_LEGACY_SNAPSHOT_ERROR,
              generationId: attempt.generationId,
              chatId: attempt.chatId,
              mode: attempt.mode,
              phase: 'replay_fence',
              journalConfirmed: true,
              authoritativeCommitted: false,
              durationMs: protocolDurationMs(startedAt),
            })
          } catch (err) {
            retryable += 1
            recordDiagnosticEvent({
              category: 'persistence',
              level: 'warn',
              phase: 'bookkeeping',
              disposition: 'retryable',
              durationMs: protocolDurationMs(startedAt),
              journalConfirmed: true,
              authoritativeCommitted: false,
              cleanupComplete: false,
              retryCount: retry.failureCount,
            })
            args.logger?.error(
              { err, generationId: attempt.generationId, chatId: attempt.chatId, phase: 'bookkeeping' },
              'failed to quarantine a legacy generation finalization retry',
            )
            emitProtocolMetric('generation_persistence_retry', {
              status: 'bookkeeping_error',
              generationId: attempt.generationId,
              chatId: attempt.chatId,
              phase: 'bookkeeping',
              journalConfirmed: true,
              authoritativeCommitted: false,
              durationMs: protocolDurationMs(startedAt),
              error: errorMessage(err, 'failed to quarantine a legacy generation finalization retry'),
            })
          }
          return
        }

        const outcome = persistConfirmedGenerationFinalization({
          db: args.db,
          dataDir: args.dataDir,
          eventSink: args.eventSink,
          attempt,
        })
        if (outcome.kind === 'persisted' || outcome.kind === 'committed_cleanup_pending') {
          const { persistence } = outcome
          persisted += 1
          recordDiagnosticEvent({
            category: 'persistence',
            level: 'info',
            phase: 'complete',
            disposition: 'recovered',
            durationMs: protocolDurationMs(startedAt),
            journalConfirmed: true,
            authoritativeCommitted: true,
            cleanupComplete: outcome.cleanupComplete,
            retryCount: retry.failureCount,
          })
          if (persistence.bardWikiJobEnqueued) args.onBardWikiJobEnqueued?.(persistence.bardWikiJobEnqueued)
          void handlePersistedGenerationCompletion({
            db: args.db,
            dataDir: args.dataDir,
            eventSink: args.eventSink,
            messageTranslationJobs: args.messageTranslationJobs,
            message: attempt.message,
            targetMessageId: attempt.targetMessageId,
            chatId: attempt.chatId,
            generationId: attempt.generationId,
            completedAt: Date.now(),
            pushNotifications: args.pushNotifications,
            runMessageTranslation: args.runMessageTranslation,
          }).catch(() => {
            // Persistence already succeeded; follow-up translation/notification is best-effort.
          })
          emitProtocolMetric('generation_persistence_retry', {
            status:
              outcome.kind === 'committed_cleanup_pending'
                ? 'cleanup_pending'
                : persistence.bookkeepingErrors.length > 0
                  ? 'bookkeeping_error'
                  : 'persisted',
            generationId: attempt.generationId,
            chatId: attempt.chatId,
            revision: persistence.revision,
            phase:
              outcome.kind === 'committed_cleanup_pending'
                ? 'cleanup'
                : persistence.bookkeepingErrors.length > 0
                  ? 'bookkeeping'
                  : 'complete',
            journalConfirmed: true,
            authoritativeCommitted: true,
            cleanupComplete: outcome.cleanupComplete,
            durationMs: protocolDurationMs(startedAt),
            ...(outcome.kind === 'committed_cleanup_pending'
              ? { cleanupError: errorMessage(outcome.cleanupError, 'failed to clean up the finalization journal') }
              : {}),
            ...(persistence.bookkeepingErrors.length > 0 ? { bookkeepingErrors: persistence.bookkeepingErrors } : {}),
            ...droppedGenerationScriptMutationMetricFields(persistence),
          })
          if (persistence.droppedScriptMutations.length > 0) {
            args.logger?.warn(
              {
                generationId: attempt.generationId,
                chatId: attempt.chatId,
                droppedScriptMutations: persistence.droppedScriptMutations,
              },
              'generation finalization retry dropped stale script mutations',
            )
          }
          if (outcome.kind === 'committed_cleanup_pending') {
            args.logger?.warn(
              {
                err: outcome.cleanupError,
                generationId: attempt.generationId,
                chatId: attempt.chatId,
                phase: 'cleanup',
              },
              'generation finalization committed but journal cleanup remains pending',
            )
          }
        } else {
          if (outcome.kind === 'rejected') {
            terminal += 1
            args.logger?.warn(
              {
                err: outcome.error,
                generationId: attempt.generationId,
                chatId: attempt.chatId,
                ...(outcome.bookkeepingError ? { bookkeepingError: outcome.bookkeepingError } : {}),
              },
              'generation finalization retry reached a terminal failure',
            )
          } else {
            retryable += 1
            args.logger?.warn(
              {
                err: outcome.error,
                generationId: attempt.generationId,
                chatId: attempt.chatId,
                ...(outcome.bookkeepingError ? { bookkeepingError: outcome.bookkeepingError } : {}),
              },
              'generation finalization retry failed; it remains queued',
            )
          }
          emitProtocolMetric('generation_persistence_retry', {
            status: outcome.kind === 'rejected' ? 'terminal_error' : 'retryable_error',
            generationId: attempt.generationId,
            chatId: attempt.chatId,
            phase: outcome.bookkeepingError ? 'bookkeeping' : 'authoritative_commit',
            journalConfirmed: true,
            authoritativeCommitted: false,
            cleanupComplete: false,
            durationMs: protocolDurationMs(startedAt),
            error: errorMessage(outcome.error, 'failed to persist the generation result'),
            ...(outcome.bookkeepingError
              ? {
                  bookkeepingError: errorMessage(outcome.bookkeepingError, 'failed to update finalization retry state'),
                }
              : {}),
          })
        }
      },
    )
  }
  return { attempted: retries.length, persisted, terminal, retryable }
}

/** Resume server-owned translation effects that were pending at process loss. */
export async function retryPendingGenerationCompletionEffects(args: {
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  messageTranslationJobs: MessageTranslationJobRegistry
  runMessageTranslation?: ServerMessageTranslationRunner
}): Promise<number> {
  const pending = listPendingServerGenerationEffects(args.db)
  let settled = 0
  for (const effect of pending) {
    const message = getChatMessages(args.db, effect.chatId).find(
      (candidate) => candidate.chatId === effect.messageId,
    ) as unknown as Message | undefined
    if (!message || message.role !== 'char') continue
    await runWithDiagnosticContext(
      args.db,
      {
        databaseLineage: effect.databaseLineage,
        operationId: effect.operationId ?? effect.generationId,
        attemptId: effect.generationId,
        background: true,
      },
      () =>
        handlePersistedGenerationCompletion({
          db: args.db,
          dataDir: args.dataDir,
          eventSink: args.eventSink,
          messageTranslationJobs: args.messageTranslationJobs,
          message,
          targetMessageId: effect.messageId,
          chatId: effect.chatId,
          characterId: effect.characterId,
          completedAt: Date.now(),
          pushNotifications: false,
          runMessageTranslation: args.runMessageTranslation,
          generationId: effect.generationId,
        }),
    )
    settled += 1
  }
  return settled
}

/**
 * Durable-job post-generation pass. Runs server derivation, then persists the
 * **derived** assistant message + post-gen scriptstate delta server-side
 * (mode-aware via the shared
 * `resolvePostGenerationResult` — `send` appends, `continue` follows its derived
 * append/extend disposition, and `regenerate` replaces the target) and folds the bumped revision /
 * final text / resend onto the `done` frame so the (possibly reattached) browser
 * reconciles without persisting.
 *
 * Failure policy (the only divergence from the inline `buildPostGenerationFrame`):
 *  - **derivation throws**: the client may be gone, so persist the raw provider
 *    text and emit a `warning`.
 *  - **finalization is queued/rejected/unconfirmed**: record one terminal job
 *    `error` with the exact durability disposition the reattaching client sees.
 *  - **commit succeeds but cleanup fails**: finish with `done` and identify the
 *    remaining cleanup work without describing the committed message as failed.
 */
async function buildDurablePostGeneration(args: {
  emit: (event: PromptChatEvent) => void
  state: AssemblyState
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  input: AssembleInput
  completionText: string
  alternateTexts?: readonly string[]
  generationId: string
  job: StreamJob
  generationInfo: Record<string, unknown>
  promptInfo?: Record<string, unknown>
  pushNotifications?: false | PushNotificationService
  messageTranslationJobs: MessageTranslationJobRegistry
  runMessageTranslation?: ServerMessageTranslationRunner
  onBardWikiJobEnqueued?: (job: BardWikiJobSummary) => void
  generationTrace?: GenerationTraceOptions
  metricContext?: PromptAssemblyMetricContext
}): Promise<ProviderPostGenerationResult | undefined> {
  const diagnosticStartedAt = protocolNowMs()
  recordDiagnosticEvent({
    category: 'generation',
    level: 'info',
    stage: 'post-generation',
    outcome: 'pending',
    providerMayHaveRun: true,
  })
  const completedAt = Date.now()
  const operationLineage = generationOperationLineageForJob(args.job)
  if (operationLineage) {
    try {
      const operation = markGenerationOperationProviderDispatchFinished(args.db, operationLineage)
      updateJobOperationProjection(args.job, operation)
    } catch {
      // The started marker is the safety boundary. A transient failure while
      // adding the advisory finished timestamp must not bypass the phase-aware
      // finalization journal and its truthful persistence disposition.
    }
  }
  const {
    postGen,
    postGenError,
    postGenMetricError,
    message,
    targetMessageId,
    chatVarMutations,
    characterFieldMutations,
    localLoreMutation,
    alternateTexts,
    targetSnapshot,
  } = await resolvePostGenerationResult({
    state: args.state,
    input: args.input,
    completionText: args.completionText,
    alternateTexts: args.alternateTexts,
    generationId: args.generationId,
    generationInfo: args.generationInfo,
    promptInfo: args.promptInfo,
    dataDir: args.dataDir,
    durable: true,
    emit: args.emit,
    generationTrace: args.generationTrace,
    metricContext: args.metricContext,
  })
  recordDiagnosticEvent({
    category: 'generation',
    level: postGenError ? 'warn' : 'info',
    stage: 'post-generation',
    outcome: postGenError ? 'failed' : 'completed',
    providerMayHaveRun: true,
    durationMs: protocolDurationMs(diagnosticStartedAt),
  })
  const alternateMessages = buildProviderAlternateMessages({
    primaryMessage: message,
    alternateTexts,
  })

  let persistence: GenerationFinalizationPersistenceResult
  let persistenceDisposition: 'committed_cleanup_pending' | undefined
  const persistStartedAt = protocolNowMs()
  const finalization = queueAndPersistGenerationFinalization({
    db: args.db,
    dataDir: args.dataDir,
    eventSink: args.eventSink,
    attempt: {
      generationId: args.generationId,
      ...generationFinalizationLineageForJob(args.job, 'completed'),
      automaticConfirmationEligible: true,
      chatId: args.input.chatId,
      mode: finalizationModeFromInput(args.input),
      message,
      alternateMessages,
      chatVarMutations,
      characterFieldMutations,
      localLoreMutation,
      ...(targetMessageId ? { targetMessageId } : {}),
      ...(targetSnapshot ? { targetSnapshot } : {}),
    },
  })
  if (finalization.kind === 'unconfirmed' || finalization.kind === 'queued' || finalization.kind === 'rejected') {
    if (finalization.kind === 'unconfirmed') {
      settleGenerationOperationWithoutResult({
        db: args.db,
        job: args.job,
        failureCode: 'finalization_journal_unconfirmed',
        failurePhase: 'finalization_journal',
        lastError: errorMessage(finalization.error, 'failed to confirm generation finalization journal'),
      })
    }
    const disposition = finalization.kind
    const metricStatus =
      finalization.kind === 'unconfirmed'
        ? 'journal_error'
        : finalization.kind === 'queued'
          ? 'retry_queued'
          : 'terminal_error'
    emitProtocolMetric('generation_persistence', {
      status: metricStatus,
      generationId: args.generationId,
      chatId: args.input.chatId,
      phase:
        finalization.kind === 'unconfirmed'
          ? 'journal'
          : finalization.bookkeepingError
            ? 'bookkeeping'
            : 'authoritative_commit',
      journalConfirmed: finalization.journalConfirmed,
      authoritativeCommitted: finalization.authoritativeCommitted,
      cleanupComplete: finalization.cleanupComplete,
      durationMs: protocolDurationMs(persistStartedAt),
      error: errorMessage(finalization.error, 'failed to persist the generation result'),
      ...('bookkeepingError' in finalization && finalization.bookkeepingError
        ? {
            bookkeepingError: errorMessage(
              finalization.bookkeepingError,
              'failed to update generation finalization retry state',
            ),
          }
        : {}),
    })
    args.emit({
      type: 'error',
      error: errorMessage(finalization.error, 'failed to persist the generation result'),
      reason: 'generation_persistence_failed',
      persistenceDisposition: disposition,
      generationProjection: {
        characterId: args.input.characterId,
        chatId: args.input.chatId,
        generationId: args.generationId,
        mode: finalizationModeFromInput(args.input),
        ...(targetMessageId ? { targetMessageId } : {}),
      },
    })
    return { primary: message.data, alternates: alternateTexts, terminalStatus: 'error' }
  }
  persistence = finalization.persistence
  if (persistence.bardWikiJobEnqueued) args.onBardWikiJobEnqueued?.(persistence.bardWikiJobEnqueued)
  if (finalization.kind === 'committed_cleanup_pending') {
    persistenceDisposition = 'committed_cleanup_pending'
  }

  // `postGen === undefined` means the derivation threw: the client may be gone, so
  // warn rather than silently keep an optimistic copy (the inline path's choice).
  if (!postGen) {
    emitProtocolMetric('generation_persistence', {
      status:
        finalization.kind === 'committed_cleanup_pending'
          ? 'cleanup_pending'
          : persistence.bookkeepingErrors.length > 0
            ? 'bookkeeping_error'
            : 'persisted',
      generationId: args.generationId,
      chatId: args.input.chatId,
      revision: persistence.revision,
      phase:
        finalization.kind === 'committed_cleanup_pending'
          ? 'cleanup'
          : persistence.bookkeepingErrors.length > 0
            ? 'bookkeeping'
            : 'complete',
      journalConfirmed: true,
      authoritativeCommitted: true,
      cleanupComplete: finalization.cleanupComplete,
      durationMs: protocolDurationMs(persistStartedAt),
      ...(postGenMetricError ? { error: postGenMetricError } : {}),
      ...(finalization.kind === 'committed_cleanup_pending'
        ? { cleanupError: errorMessage(finalization.cleanupError, 'failed to clean up the finalization journal') }
        : {}),
      ...(persistence.bookkeepingErrors.length > 0 ? { bookkeepingErrors: persistence.bookkeepingErrors } : {}),
      ...droppedGenerationScriptMutationMetricFields(persistence),
    })
    emitDroppedGenerationScriptMutationWarning(args.emit, persistence.droppedScriptMutations)
    args.emit({
      type: 'warning',
      message: 'server post-generation derivation failed; persisted the raw provider text.',
      ...(postGenError ? { context: { error: postGenError } } : {}),
    })
    const messageId = targetMessageId ?? message.chatId
    const translationFollowup = await handlePersistedGenerationCompletion({
      db: args.db,
      dataDir: args.dataDir,
      eventSink: args.eventSink,
      messageTranslationJobs: args.messageTranslationJobs,
      message,
      targetMessageId,
      chatId: args.input.chatId,
      generationId: args.generationId,
      characterId: args.input.characterId,
      completedAt,
      emit: args.emit,
      pushNotifications: args.pushNotifications,
      runMessageTranslation: args.runMessageTranslation,
    })
    return {
      frame: buildPostGenerationFrameBody(
        translationFollowup.revision ?? persistence.revision,
        undefined,
        messageId,
        translationFollowup.translation,
        persistence,
        persistence.effectLedger,
      ),
      primary: message.data,
      alternates: alternateTexts,
      ...(persistenceDisposition ? { persistenceDisposition } : {}),
    }
  }

  emitProtocolMetric('generation_persistence', {
    status:
      finalization.kind === 'committed_cleanup_pending'
        ? 'cleanup_pending'
        : persistence.bookkeepingErrors.length > 0
          ? 'bookkeeping_error'
          : 'persisted',
    generationId: args.generationId,
    chatId: args.input.chatId,
    revision: persistence.revision,
    phase:
      finalization.kind === 'committed_cleanup_pending'
        ? 'cleanup'
        : persistence.bookkeepingErrors.length > 0
          ? 'bookkeeping'
          : 'complete',
    journalConfirmed: true,
    authoritativeCommitted: true,
    cleanupComplete: finalization.cleanupComplete,
    durationMs: protocolDurationMs(persistStartedAt),
    ...(finalization.kind === 'committed_cleanup_pending'
      ? { cleanupError: errorMessage(finalization.cleanupError, 'failed to clean up the finalization journal') }
      : {}),
    ...(persistence.bookkeepingErrors.length > 0 ? { bookkeepingErrors: persistence.bookkeepingErrors } : {}),
    ...droppedGenerationScriptMutationMetricFields(persistence),
  })
  emitDroppedGenerationScriptMutationWarning(args.emit, persistence.droppedScriptMutations)
  const messageId = targetMessageId ?? message.chatId
  const translationFollowup = await handlePersistedGenerationCompletion({
    db: args.db,
    dataDir: args.dataDir,
    eventSink: args.eventSink,
    messageTranslationJobs: args.messageTranslationJobs,
    message,
    targetMessageId,
    chatId: args.input.chatId,
    generationId: args.generationId,
    characterId: args.input.characterId,
    completedAt,
    emit: args.emit,
    pushNotifications: args.pushNotifications,
    runMessageTranslation: args.runMessageTranslation,
  })
  return {
    frame: buildPostGenerationFrameBody(
      translationFollowup.revision ?? persistence.revision,
      postGen,
      messageId,
      translationFollowup.translation,
      persistence,
      persistence.effectLedger,
    ),
    primary: message.data,
    alternates: alternateTexts,
    ...(persistenceDisposition ? { persistenceDisposition } : {}),
  }
}

function buildInterruptedPostGenerationFrame(args: {
  revision: number
  postGen: Awaited<ReturnType<typeof runServerPostGeneration>> | undefined
  messageId: string | undefined
  finalText: string
  persistence: AppliedGenerationScriptMutations
}): PostGenerationFrame {
  return {
    ...buildPostGenerationFrameBody(args.revision, args.postGen, args.messageId, undefined, args.persistence),
    // Interrupted terminals always need an exact row snapshot, even when
    // editoutput happened to leave the text unchanged.
    finalText: args.finalText,
  }
}

/**
 * On a streaming cancel, run the accumulated provider text through the narrow
 * editoutput-compatible partial path, then persist it mode-aware and
 * idempotently. Completion-only Agent Preset/output-trigger effects remain
 * success-only. A non-streaming cancel persists nothing.
 */
async function persistCancelledPartialResult(args: {
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  state: AssemblyState
  input: AssembleInput
  generationId: string
  job: StreamJob
  generationInfo: Record<string, unknown>
  promptInfo?: Record<string, unknown>
  text: string
  emit?: (event: PromptChatEvent) => void
  generationTrace?: GenerationTraceOptions
  metricContext?: PromptAssemblyMetricContext
}): Promise<{
  outcome: GenerationFinalizationOutcome
  messageId: string | undefined
  finalText: string | undefined
  postGen: Awaited<ReturnType<typeof runServerPostGeneration>> | undefined
}> {
  const operationLineage = generationOperationLineageForJob(args.job)
  if (operationLineage) {
    try {
      const operation = markGenerationOperationProviderDispatchFinished(args.db, operationLineage)
      updateJobOperationProjection(args.job, operation)
    } catch {
      // Keep cancelled-partial finalization authoritative even if the
      // nonessential provider-finished timestamp cannot be recorded.
    }
  }
  let resolved: Awaited<ReturnType<typeof resolvePostGenerationResult>>
  try {
    resolved = await resolvePostGenerationResult({
      state: args.state,
      input: args.input,
      completionText: args.text,
      generationId: args.generationId,
      generationInfo: args.generationInfo,
      promptInfo: args.promptInfo,
      dataDir: args.dataDir,
      durable: true,
      emit: args.emit,
      generationTrace: args.generationTrace,
      metricContext: args.metricContext,
      partial: true,
    })
  } catch (error) {
    return {
      outcome: {
        kind: 'unconfirmed',
        error,
        journalConfirmed: false,
        authoritativeCommitted: false,
        cleanupComplete: false,
      },
      messageId: undefined,
      finalText: undefined,
      postGen: undefined,
    }
  }
  const {
    postGen,
    message,
    targetMessageId,
    chatVarMutations,
    characterFieldMutations,
    localLoreMutation,
    targetSnapshot,
  } = resolved
  const outcome = queueAndPersistGenerationFinalization({
    db: args.db,
    dataDir: args.dataDir,
    eventSink: args.eventSink,
    attempt: {
      generationId: args.generationId,
      ...generationFinalizationLineageForJob(args.job, 'cancelled'),
      automaticConfirmationEligible: false,
      chatId: args.input.chatId,
      mode: finalizationModeFromInput(args.input),
      message,
      chatVarMutations,
      characterFieldMutations,
      localLoreMutation,
      ...(targetMessageId ? { targetMessageId } : {}),
      ...(targetSnapshot ? { targetSnapshot } : {}),
    },
  })
  return {
    outcome,
    messageId: targetMessageId ?? message.chatId,
    finalText: message.data,
    postGen,
  }
}

/** Persist a post-token provider failure while keeping the operation failed. */
async function persistFailedPartialResult(args: {
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  state: AssemblyState
  input: AssembleInput
  generationId: string
  generationInfo: Record<string, unknown>
  promptInfo?: Record<string, unknown>
  text: string
  emit?: (event: PromptChatEvent) => void
  generationTrace?: GenerationTraceOptions
  metricContext?: PromptAssemblyMetricContext
}): Promise<ProviderFailurePostGenerationResult | undefined> {
  if (args.text.length === 0) return undefined
  const {
    postGen,
    message,
    targetMessageId,
    chatVarMutations,
    characterFieldMutations,
    localLoreMutation,
    targetSnapshot,
  } = await resolvePostGenerationResult({
    state: args.state,
    input: args.input,
    completionText: args.text,
    generationId: args.generationId,
    generationInfo: args.generationInfo,
    promptInfo: args.promptInfo,
    dataDir: args.dataDir,
    durable: true,
    emit: args.emit,
    generationTrace: args.generationTrace,
    metricContext: args.metricContext,
    partial: true,
  })
  const finalization = queueAndPersistGenerationFinalization({
    db: args.db,
    dataDir: args.dataDir,
    eventSink: args.eventSink,
    attempt: {
      generationId: args.generationId,
      chatId: args.input.chatId,
      mode: finalizationModeFromInput(args.input),
      message,
      chatVarMutations,
      characterFieldMutations,
      localLoreMutation,
      ...(targetMessageId ? { targetMessageId } : {}),
      ...(targetSnapshot ? { targetSnapshot } : {}),
    },
  })
  const generationProjection = {
    characterId: args.input.characterId,
    chatId: args.input.chatId,
    generationId: args.generationId,
    mode: finalizationModeFromInput(args.input),
    ...(targetMessageId ? { targetMessageId } : {}),
  }
  if (finalization.kind === 'unconfirmed' || finalization.kind === 'rejected') {
    return { persistenceDisposition: finalization.kind, generationProjection }
  }
  if (finalization.kind === 'queued') {
    return {
      frame: { messageId: targetMessageId ?? message.chatId, finalText: message.data },
      persistenceDisposition: 'queued',
      generationProjection,
    }
  }
  return {
    frame: buildInterruptedPostGenerationFrame({
      revision: finalization.persistence.revision,
      postGen,
      messageId: targetMessageId ?? message.chatId,
      finalText: message.data,
      persistence: finalization.persistence,
    }),
  }
}

function settleGenerationOperationWithoutResultOnce(args: {
  db: DatabaseSync
  job: StreamJob
  failureCode: string
  failurePhase: string
  lastError?: string
  /** A retained failed partial makes retrying the same accepted source unsafe. */
  terminal?: boolean
}): GenerationOperationProjection | undefined {
  const lineage = generationOperationLineageForJob(args.job)
  if (!lineage) return undefined
  const operation = getGenerationOperationProjection(args.db, lineage.databaseLineage, lineage.operationId)
  if (!operation) return undefined
  let transitioned: ReturnType<typeof transitionGenerationOperation> | undefined
  if (operation.state === 'owned_by_job' || operation.state === 'launching') {
    transitioned = transitionGenerationOperation(args.db, {
      databaseLineage: lineage.databaseLineage,
      operationId: lineage.operationId,
      expectedState: operation.state,
      expectedStateVersion: operation.stateVersion,
      nextState: args.terminal ? 'terminal_failed' : 'retryable',
      failureCode: args.failureCode,
      failurePhase: args.failurePhase,
      ...(args.lastError ? { lastError: args.lastError } : {}),
      providerMayHaveRun: operation.providerMayHaveRun,
      runnerSettledAt: new Date().toISOString(),
    })
  } else if (operation.state === 'stopping') {
    const cancellationPersistenceUnconfirmed = args.failureCode === 'cancel_finalization_journal_unconfirmed'
    transitioned = transitionGenerationOperation(args.db, {
      databaseLineage: lineage.databaseLineage,
      operationId: lineage.operationId,
      expectedState: 'stopping',
      expectedStateVersion: operation.stateVersion,
      nextState: cancellationPersistenceUnconfirmed ? 'abandoned' : 'cancelled',
      failureCode: args.failureCode === 'user_stop' ? null : args.failureCode,
      failurePhase: args.failurePhase,
      ...(args.lastError ? { lastError: args.lastError } : {}),
      ...(cancellationPersistenceUnconfirmed ? { providerMayHaveRun: true } : {}),
      runnerSettledAt: new Date().toISOString(),
    })
  }
  const current = transitioned?.operation ?? operation
  updateJobOperationProjection(args.job, current)
  return current
}

function settleGenerationOperationWithoutResult(args: {
  db: DatabaseSync
  job: StreamJob
  failureCode: string
  failurePhase: string
  lastError?: string
  terminal?: boolean
}): GenerationOperationProjection | undefined {
  try {
    return settleGenerationOperationWithoutResultOnce(args)
  } catch {
    // SQLite can be transiently unavailable at exactly the same fault point
    // that made a finalization journal unconfirmed. Do not hide the truthful
    // SSE disposition; retry the operation projection briefly after the
    // competing writer releases its lock.
    let remainingAttempts = 20
    const retry = (): void => {
      if (!args.db.isOpen) return
      try {
        settleGenerationOperationWithoutResultOnce(args)
      } catch {
        remainingAttempts -= 1
        if (remainingAttempts <= 0) return
        const timer = setTimeout(retry, 25)
        timer.unref()
      }
    }
    const timer = setTimeout(retry, 25)
    timer.unref()
    return undefined
  }
}

function assertGenerationOperationTargetCurrent(db: DatabaseSync, job: StreamJob): void {
  const lineage = generationOperationLineageForJob(job)
  if (job.operationProtocolVersion !== 1 || !lineage || (!job.acceptedMessageId && !job.targetMessageId)) return
  const tail = job.chatId ? (getChatMessages(db, job.chatId).at(-1) as Record<string, unknown> | undefined) : undefined
  const expectedId = job.acceptedMessageId ?? job.targetMessageId
  const expectedRole = job.acceptedMessageId ? 'user' : 'char'
  if (tail?.chatId === expectedId && tail?.role === expectedRole) return
  const operation = getGenerationOperationProjection(db, lineage.databaseLineage, lineage.operationId)
  if (operation?.state === 'owned_by_job') {
    const failed = transitionGenerationOperation(db, {
      databaseLineage: lineage.databaseLineage,
      operationId: lineage.operationId,
      expectedState: 'owned_by_job',
      expectedStateVersion: operation.stateVersion,
      nextState: 'terminal_failed',
      failureCode: 'operation_target_stale',
      failurePhase: 'preflight',
      lastError: 'The exact generation source or target is no longer the chat tail.',
      providerMayHaveRun: operation.providerMayHaveRun,
      runnerSettledAt: new Date().toISOString(),
    })
    if (failed.operation) updateJobOperationProjection(job, failed.operation)
  }
  throw new GenerationOperationAttemptConflictError('generation operation target is stale')
}

/**
 * Detached generation runner. Mirrors `streamAssembly`'s assemble -> dispatch ->
 * done flow but (1) pushes the identical SSE frames into the job's `JobRegistry`
 * buffer (`pushRaw`) instead of a request reply, (2) runs on the job's own
 * `AbortController` (deadline / explicit cancel only, never the request
 * connection), and (3) finalizes post-generation output and persists the result
 * server-side. Launched fire-and-forget (`void`); the request connection is just a
 * viewer.
 */
async function runGenerationJob(args: {
  registry: GenerationJobRegistry
  job: StreamJob
  db: DatabaseSync
  input: AssembleInput
  dataDir: string
  eventSink: CommandEventSink
  clientCapabilities: GenerationClientCapabilities
  options: GenerationChatRouteOptions
  messageTranslationJobs: MessageTranslationJobRegistry
  generationTrace?: GenerationTraceOptions
  preparedAssembly?: PromptAssemblyRun
  deferredFailure?: AssemblyDeferredFailure
  metricContext?: PromptAssemblyMetricContext
}): Promise<void> {
  const {
    registry,
    job,
    db,
    input,
    dataDir,
    eventSink,
    clientCapabilities,
    options,
    messageTranslationJobs,
    generationTrace,
    preparedAssembly,
    deferredFailure,
    metricContext = {},
  } = args
  const diagnosticStartedAt = protocolNowMs()
  let providerMayHaveRun = false
  recordDiagnosticEvent({
    category: 'generation',
    level: 'info',
    stage: 'accepted',
    outcome: 'pending',
    providerMayHaveRun: false,
  })
  let lastTerminalError: string | undefined
  const emit = (event: PromptChatEvent): void => {
    if (event.type === 'error') lastTerminalError = event.error
    if (event.type === 'done') {
      recordDiagnosticEvent({
        category: 'generation',
        level: lastTerminalError ? 'warn' : 'info',
        stage: event.outcome === 'cancelled' ? 'cancellation' : 'complete',
        outcome:
          event.outcome === 'cancelled'
            ? 'cancelled'
            : lastTerminalError
              ? providerMayHaveRun
                ? 'ambiguous'
                : 'failed'
              : 'completed',
        providerMayHaveRun,
        durationMs: protocolDurationMs(diagnosticStartedAt),
        ...(event.outcome === 'cancelled' ? { cancellationOrigin: 'unknown' } : {}),
      })
      settleGenerationOperationWithoutResult({
        db,
        job,
        failureCode: event.outcome === 'cancelled' ? 'user_stop' : 'generation_ended_without_result',
        failurePhase: event.outcome === 'cancelled' ? 'cancellation' : 'runner',
        ...(lastTerminalError ? { lastError: lastTerminalError } : {}),
      })
    }
    registry.registry.pushRaw(job, formatPromptChatFrame(lineageEventForJob(db, job, event)))
  }
  const signal = job.abortController.signal
  const generationId = job.id
  let terminalDoneEmitted = false
  try {
    emit({ type: 'stage', stage: 'validate', status: 'start' })
    emit({ type: 'stage', stage: 'validate', status: 'end' })
    emit({ type: 'stage', stage: 'prompt', status: 'start' })

    try {
      if (deferredFailure) throw deferredFailure.error
      assertGenerationOperationTargetCurrent(db, job)
      if (preparedAssembly) retargetAssemblySignal(preparedAssembly, signal)
      const { result, deps, promptMs, stage2Ms } =
        preparedAssembly ??
        (await assemblePromptWithMetrics(
          input,
          dataDir,
          db,
          signal,
          metricContext,
          (progress) => emit({ type: 'agent_preset_progress', ...progress }),
          options,
        ))
      const operationLineage = generationOperationLineageForJob(job)
      if (operationLineage) {
        const operation = assertGenerationOperationDispatchable(db, operationLineage)
        updateJobOperationProjection(job, operation)
      }
      assertGenerationOperationTargetCurrent(db, job)
      const database = result.state?.database ?? deps.getDatabase()
      const useRegenerateTargetProjection =
        clientCapabilities.regenerateTargetProjection &&
        input.mode === 'regenerate' &&
        job.operationProtocolVersion === 1 &&
        typeof job.operationId === 'string' &&
        typeof job.attemptNo === 'number' &&
        typeof job.targetMessageId === 'string'
      const persistedAssembly =
        isPersistingMode(input.mode) && result.mutations
          ? persistAssemblyMutations({
              db,
              dataDir,
              eventSink,
              input,
              mutations: result.mutations,
              initialMessages: result.restoration?.messages ?? [],
              submitMessages: result.submitMessages,
              submitTranscriptChanged: result.submitTranscriptChanged,
            })
          : undefined
      const assemblyPatch = assemblyPatchForClient({
        result,
        persistence: persistedAssembly,
        capabilities: clientCapabilities,
        useRegenerateTargetProjection,
      })
      if (useRegenerateTargetProjection) {
        emitProtocolMetric('generation_regenerate_projection', {
          status: 'assembly_patch_filtered',
          chatId: input.chatId,
          characterId: input.characterId,
          operationId: job.operationId,
          attemptNo: job.attemptNo,
          projectionEpoch: job.projectionEpoch,
          suppressedWorkingMessageMutationCount: result.mutations?.messageMutations.length ?? 0,
          authoritativeMessageMutationCount: assemblyPatch?.messageMutations.length ?? 0,
        })
      }
      emitAssemblyWarnings(result, emit)
      if (!result.stopSending && result.prompt) {
        const successfulResult: SuccessfulAssembleResult = {
          ...result,
          stopSending: false,
          prompt: result.prompt,
        }
        const shouldDispatch = shouldDispatchProvider(input, database)
        const extendContinueBase =
          successfulResult.state?.input.mode === 'continue' && successfulResult.state.continueDisposition === 'extend'
            ? (findContinueRow(successfulResult.state)?.data ?? '')
            : undefined
        const generationInfo: Record<string, unknown> | undefined =
          shouldDispatch && database
            ? {
                ...createGenerationInfo(database, generationId, successfulResult, promptMs, stage2Ms),
                ...(generationOperationLineageForJob(job)
                  ? {
                      databaseLineage: job.databaseLineage,
                      operationId: job.operationId,
                      acceptedMessageId: job.acceptedMessageId,
                      attemptNo: job.attemptNo,
                      jobId: job.id,
                      effectLedgerKeyType: (job.operationProtocolVersion ?? 0) >= 1 ? 'operation' : 'generation',
                      effectLedgerKeyId: (job.operationProtocolVersion ?? 0) >= 1 ? job.operationId : generationId,
                      effectLedgerCharacterId: input.characterId,
                      effectLedgerChatId: input.chatId,
                    }
                  : {}),
              }
            : undefined
        const promptEvent = promptEventForClient(result.prompt, clientCapabilities, input.mode)
        const trace = createGenerationTraceContext({
          dataDir,
          generationTrace,
          metricContext,
          generationId,
          durableJobId: job.id,
        })
        await emitGenerationPromptEmissionMetric({
          metricContext,
          input,
          promptEvent,
          formated: successfulResult.formated ?? successfulResult.prompt.formated ?? [],
          promptSummary: result.promptSummary,
          generationId,
          durableJobId: job.id,
          durable: true,
          compactPromptEvent: clientCapabilities.compactPromptEvent,
          shouldDispatch,
          revision: persistedAssembly?.revision,
          trace,
        })
        if (operationLineage) {
          const operation = assertGenerationOperationDispatchable(db, operationLineage)
          updateJobOperationProjection(job, operation)
        }
        emit({ type: 'prompt', ...promptEvent })
        if (assemblyPatch) emit({ type: 'message_patch', patch: assemblyPatch })
        emit({ type: 'stage', stage: 'prompt', status: 'end' })
        if (successfulResult.state?.input.mode === 'continue') {
          job.continueDisposition = successfulResult.state.continueDisposition
        }
        emit({
          type: 'info',
          timings: { prompt: promptMs },
          tokens: { prompt: result.inputTokens, total: result.inputTokens },
          responseBudget: result.outputTokens,
          ...(database?.halfStreaming === true ? { halfStreaming: true } : {}),
          generationId: shouldDispatch ? generationId : undefined,
          generationInfo,
          ...(useRegenerateTargetProjection
            ? {
                generationDisplayProjection: {
                  version: 1 as const,
                  mode: 'regenerate' as const,
                  targetMessageId: job.targetMessageId!,
                  generationId,
                  operationId: job.operationId!,
                  attemptNo: job.attemptNo!,
                  projectionEpoch: job.projectionEpoch ?? 0,
                },
              }
            : {}),
          ...(successfulResult.state?.input.mode === 'continue'
            ? {
                continueDisposition: successfulResult.state.continueDisposition,
                ...(extendContinueBase !== undefined ? { continueBase: extendContinueBase } : {}),
              }
            : {}),
          revision: persistedAssembly?.revision,
        })
        if (shouldDispatch && database && generationInfo) {
          const dispatchProvider =
            options.dispatchProvider ??
            ((context: ChatProviderDispatchContext) =>
              dispatchChatProvider({
                database: context.database,
                formated: context.result.formated ?? context.result.prompt.formated ?? [],
                outputTokens: context.result.outputTokens,
                biases: context.result.biases,
                multiGeneration: context.input.mode !== 'continue',
                currentCharacterName: context.result.state?.currentChar.name,
                signal: context.signal,
                trace: context.trace,
                profile: context.profile,
                history: chatDispatchHistory(db, context),
                inlayAssetPersistence: { db, dataDir },
                onWarning: (warning) => emit({ type: 'warning', ...warning }),
                onResolvedModel: (model) => {
                  context.resolvedRequestModel = model
                },
              }))
          const providerStartedAt = Date.now()
          let frames: AsyncIterable<CompletionStreamFrame> | null | undefined
          try {
            frames = dispatchProviderWithPolicies(
              {
                input,
                result: successfulResult,
                database,
                generationId,
                generationInfo,
                signal,
                trace,
                ...(operationLineage
                  ? {
                      beforeProviderDispatch: () => {
                        assertGenerationOperationTargetCurrent(db, job)
                        const operation = markGenerationOperationProviderDispatchStarted(db, operationLineage)
                        updateJobOperationProjection(job, operation)
                        providerMayHaveRun = true
                      },
                    }
                  : {}),
              },
              dispatchProvider,
            )
          } catch (err) {
            emit({
              type: 'error',
              error: errorMessage(err, PROVIDER_DISPATCH_FALLBACK),
              reason: 'provider_dispatch_exception',
              restoration: successfulResult.restoration,
            })
            emit({ type: 'done', generationId, generationInfo })
            terminalDoneEmitted = true
          }
          if (frames) {
            const transportResult = await emitProviderChunks(frames, emit, signal, {
              tokenProgress: halfStreamingTokenProgress(database, providerStartedAt),
              doneMetadata: () => {
                const stageTiming = generationInfo.stageTiming as Record<string, unknown> | undefined
                if (stageTiming) {
                  stageTiming.stage3 = Date.now() - providerStartedAt
                }
                return {
                  generationId,
                  generationInfo,
                  ...(database.halfStreaming === true ? { halfStreaming: true } : {}),
                  ...(successfulResult.state?.input.mode === 'continue'
                    ? {
                        continueDisposition: successfulResult.state.continueDisposition,
                        ...(extendContinueBase !== undefined ? { continueBase: extendContinueBase } : {}),
                      }
                    : {}),
                }
              },
              sideEffects: (texts) =>
                database.ttsAutoSpeech
                  ? texts.map((text) => ({
                      type: 'side_effect',
                      kind: 'tts',
                      payload: { text, characterId: input.characterId },
                    }))
                  : [],
              errorRestoration: () => successfulResult.restoration,
              failurePostGeneration: (completionText) =>
                successfulResult.state
                  ? persistFailedPartialResult({
                      state: successfulResult.state,
                      db,
                      dataDir,
                      eventSink,
                      input,
                      text: completionText,
                      generationId,
                      generationInfo,
                      promptInfo: successfulResult.prompt.promptInfo,
                      emit,
                      generationTrace,
                      metricContext,
                    })
                  : Promise.resolve(undefined),
              postGeneration: (completionText, alternateTexts) => {
                if (!successfulResult.state) return Promise.resolve(undefined)
                // Stamp stage3 BEFORE the persist so the server-written message's
                // generationInfo carries it (the persist runs ahead of doneMetadata,
                // which would otherwise set it only on the wire `done` frame).
                const stageTiming = generationInfo.stageTiming as Record<string, unknown> | undefined
                if (stageTiming) stageTiming.stage3 = Date.now() - providerStartedAt
                return buildDurablePostGeneration({
                  emit,
                  state: successfulResult.state,
                  db,
                  dataDir,
                  eventSink,
                  input,
                  completionText,
                  alternateTexts,
                  generationId,
                  job,
                  generationInfo,
                  promptInfo: successfulResult.prompt.promptInfo,
                  pushNotifications: options.pushNotifications,
                  messageTranslationJobs,
                  runMessageTranslation: options.runMessageTranslation,
                  onBardWikiJobEnqueued: options.onBardWikiJobEnqueued,
                  generationTrace,
                  metricContext,
                })
              },
            })
            terminalDoneEmitted = transportResult.status !== 'aborted'
            if (transportResult.status === 'error') {
              const retainedFailedPartial =
                transportResult.failurePostGeneration?.frame !== undefined &&
                transportResult.failurePostGeneration.persistenceDisposition !== 'rejected' &&
                transportResult.failurePostGeneration.persistenceDisposition !== 'unconfirmed'
              settleGenerationOperationWithoutResult({
                db,
                job,
                failureCode: 'provider_failed',
                failurePhase: 'provider',
                lastError: lastTerminalError,
                terminal: retainedFailedPartial,
              })
            }
            const abortedOperation = operationLineage
              ? getGenerationOperationProjection(db, operationLineage.databaseLineage, operationLineage.operationId)
              : undefined
            if (transportResult.status === 'aborted' && operationLineage && abortedOperation?.state !== 'stopping') {
              settleGenerationOperationWithoutResult({
                db,
                job,
                failureCode: 'generation_aborted',
                failurePhase: 'provider',
              })
              emit({ type: 'error', error: 'Generation stopped before a terminal provider result.', reason: 'aborted' })
              emit({ type: 'done', generationId, generationInfo })
              terminalDoneEmitted = true
            }
            if (transportResult.status === 'aborted' && (!operationLineage || abortedOperation?.state === 'stopping')) {
              // A streaming cancel persists the accumulated-so-far text.
              let cancelFinalization: GenerationFinalizationOutcome | undefined
              let cancelTargetMessageId: string | undefined
              let cancelPersistedMessageId: string | undefined
              let cancelPersistedFinalText: string | undefined
              let cancelPostGen: Awaited<ReturnType<typeof runServerPostGeneration>> | undefined
              if (transportResult.result.length > 0 && successfulResult.state) {
                await options.onDurableLifecycleTransition?.('cancel_persistence_started', job)
                cancelTargetMessageId =
                  input.mode === 'regenerate'
                    ? input.regenerateMessageId
                    : input.mode === 'continue' && successfulResult.state.continueDisposition === 'extend'
                      ? findContinueRow(successfulResult.state)?.chatId
                      : undefined
                const cancelPersisted = await persistCancelledPartialResult({
                  db,
                  dataDir,
                  eventSink,
                  state: successfulResult.state,
                  input,
                  generationId,
                  job,
                  generationInfo,
                  promptInfo: successfulResult.prompt.promptInfo,
                  text: transportResult.result,
                  emit,
                  generationTrace,
                  metricContext,
                })
                cancelFinalization = cancelPersisted.outcome
                cancelPersistedMessageId = cancelPersisted.messageId
                cancelPersistedFinalText = cancelPersisted.finalText
                cancelPostGen = cancelPersisted.postGen
              }
              if (
                cancelFinalization?.kind === 'unconfirmed' ||
                cancelFinalization?.kind === 'queued' ||
                cancelFinalization?.kind === 'rejected'
              ) {
                if (cancelFinalization.kind === 'unconfirmed') {
                  settleGenerationOperationWithoutResult({
                    db,
                    job,
                    failureCode: 'cancel_finalization_journal_unconfirmed',
                    failurePhase: 'finalization_journal',
                    lastError: errorMessage(
                      cancelFinalization.error,
                      'failed to confirm cancelled generation finalization journal',
                    ),
                  })
                }
                const metricStatus =
                  cancelFinalization.kind === 'unconfirmed'
                    ? 'journal_error'
                    : cancelFinalization.kind === 'queued'
                      ? 'retry_queued'
                      : 'terminal_error'
                emitProtocolMetric('generation_cancel_persistence', {
                  status: metricStatus,
                  generationId,
                  chatId: input.chatId,
                  phase:
                    cancelFinalization.kind === 'unconfirmed'
                      ? 'journal'
                      : cancelFinalization.bookkeepingError
                        ? 'bookkeeping'
                        : 'authoritative_commit',
                  journalConfirmed: cancelFinalization.journalConfirmed,
                  authoritativeCommitted: cancelFinalization.authoritativeCommitted,
                  cleanupComplete: cancelFinalization.cleanupComplete,
                  error: errorMessage(cancelFinalization.error, 'failed to persist the cancelled generation result'),
                  ...('bookkeepingError' in cancelFinalization && cancelFinalization.bookkeepingError
                    ? {
                        bookkeepingError: errorMessage(
                          cancelFinalization.bookkeepingError,
                          'failed to update generation finalization retry state',
                        ),
                      }
                    : {}),
                })
                emit({
                  type: 'error',
                  error: errorMessage(cancelFinalization.error, 'failed to persist the cancelled generation result'),
                  reason: 'generation_cancel_persistence_failed',
                  persistenceDisposition: cancelFinalization.kind,
                  result: transportResult.result,
                  ...(cancelFinalization.kind === 'queued' && cancelPersistedFinalText !== undefined
                    ? {
                        postGeneration: {
                          messageId: cancelPersistedMessageId,
                          finalText: cancelPersistedFinalText,
                        },
                      }
                    : {}),
                  generationProjection: {
                    characterId: input.characterId,
                    chatId: input.chatId,
                    generationId,
                    mode: finalizationModeFromInput(input),
                    ...(cancelTargetMessageId ? { targetMessageId: cancelTargetMessageId } : {}),
                  },
                })
              } else {
                const cleanupPending = cancelFinalization?.kind === 'committed_cleanup_pending'
                const bookkeepingErrors =
                  cancelFinalization?.kind === 'persisted' || cancelFinalization?.kind === 'committed_cleanup_pending'
                    ? cancelFinalization.persistence.bookkeepingErrors
                    : []
                if (cancelFinalization) {
                  emitProtocolMetric('generation_cancel_persistence', {
                    status: cleanupPending
                      ? 'cleanup_pending'
                      : bookkeepingErrors.length > 0
                        ? 'bookkeeping_error'
                        : 'persisted',
                    generationId,
                    chatId: input.chatId,
                    phase: cleanupPending ? 'cleanup' : bookkeepingErrors.length > 0 ? 'bookkeeping' : 'complete',
                    journalConfirmed: cancelFinalization.journalConfirmed,
                    authoritativeCommitted: cancelFinalization.authoritativeCommitted,
                    cleanupComplete: cancelFinalization.cleanupComplete,
                    ...(cancelFinalization.kind === 'committed_cleanup_pending'
                      ? {
                          cleanupError: errorMessage(
                            cancelFinalization.cleanupError,
                            'failed to clean up the finalization journal',
                          ),
                        }
                      : {}),
                    ...(bookkeepingErrors.length > 0 ? { bookkeepingErrors } : {}),
                  })
                }
                const persistedRevision =
                  cancelFinalization?.kind === 'persisted' || cancelFinalization?.kind === 'committed_cleanup_pending'
                    ? cancelFinalization.persistence.revision
                    : undefined
                // Emit a canonical terminal frame so the cancelling viewer and
                // any reattached observers end cleanly and reconcile the exact
                // persisted partial. `emitProviderChunks` emits nothing on abort.
                emit({
                  type: 'done',
                  outcome: 'cancelled',
                  result: transportResult.result,
                  generationId,
                  generationInfo,
                  ...(database.halfStreaming === true ? { halfStreaming: true } : {}),
                  ...(successfulResult.state?.input.mode === 'continue'
                    ? {
                        continueDisposition: successfulResult.state.continueDisposition,
                        ...(extendContinueBase !== undefined ? { continueBase: extendContinueBase } : {}),
                      }
                    : {}),
                  ...(persistedRevision !== undefined
                    ? {
                        postGeneration:
                          cancelPersistedFinalText !== undefined && cancelFinalization
                            ? buildInterruptedPostGenerationFrame({
                                revision: persistedRevision,
                                postGen: cancelPostGen,
                                messageId: cancelPersistedMessageId,
                                finalText: cancelPersistedFinalText,
                                persistence: cancelFinalization.persistence,
                              })
                            : undefined,
                      }
                    : {}),
                  ...(cleanupPending ? { persistenceDisposition: 'committed_cleanup_pending' as const } : {}),
                })
              }
              terminalDoneEmitted = true
            }
          }
        }
      } else {
        if (assemblyPatch) emit({ type: 'message_patch', patch: assemblyPatch })
        const stopError = assemblyStopError(result, database)
        emit({
          type: 'error',
          error: stopError.error,
          reason: stopError.reason,
          restoration: result.restoration,
        })
      }
    } catch (err) {
      emit({
        type: 'error',
        error: err instanceof Error ? err.message : 'prompt assembly failed',
      })
    }

    if (!terminalDoneEmitted && !signal.aborted) {
      emit({ type: 'done' })
    }
  } finally {
    // Clear the submission lock + mark done at completion/cancel (not at GC), so the
    // chat accepts a new send immediately while the done job lingers for reattach.
    if (job.chatId) registry.clearRunning(job.chatId, job.id)
    registry.registry.markDone(job)
    // End the live viewer connections now that the terminal frame is delivered — the
    // viewer has everything, so the request lifecycle completes without waiting for the
    // client to hang up. A client that dropped *before* completion left no viewer here,
    // so its tail stays buffered for a reattach within the 30s grace.
    for (const client of [...job.clients]) {
      try {
        client.close()
      } catch {
        // ignore
      }
    }
  }
}

export interface LaunchGenerationOperationArgs {
  operation: GenerationOperationProjection
  db: DatabaseSync
  input: AssembleInput
  dataDir: string
  eventSink: CommandEventSink
  clientCapabilities: GenerationClientCapabilities
  options: GenerationChatRouteOptions
  generationTrace?: GenerationTraceOptions
  generationJobs: GenerationJobRegistry
  messageTranslationJobs: MessageTranslationJobRegistry
  preparedAssembly?: PromptAssemblyRun
  deferredFailure?: AssemblyDeferredFailure
  metricContext: PromptAssemblyMetricContext
  attachInitialViewer?: (job: StreamJob) => void
}

/** Register an exact reserved attempt, commit ownership, then start its runner. */
export function launchGenerationOperation(args: LaunchGenerationOperationArgs): GenerationOperationProjection {
  const attempt = args.operation.currentAttempt
  if (args.operation.state !== 'launching' || !attempt || !args.operation.chatId || !args.operation.mode) {
    throw new Error('generation operation must have a reserved launching attempt')
  }
  const job = args.generationJobs.registry.create({
    id: attempt.jobId,
    timeoutMs: undefined,
    heartbeatSec: undefined,
    slidingDeadline: true,
  })
  try {
    args.generationJobs.registry.enableReplay(job)
    job.chatId = args.operation.chatId
    job.writerSessionId = attempt.actorWriterSessionId
    job.writerEpoch = attempt.actorWriterEpoch
    job.mode = args.operation.mode
    job.databaseLineage = getDatabaseLineage(args.db)
    job.operationId = args.operation.operationId
    job.operationProtocolVersion = args.operation.protocolVersion
    job.operationStateVersion = args.operation.stateVersion
    job.projectionEpoch = args.operation.projectionEpoch
    job.attemptNo = attempt.attemptNo
    job.acceptedMessageId = args.operation.acceptedMessageId
    job.targetMessageId = args.operation.targetMessageId
    if (args.operation.mode === 'regenerate') job.regenerateMessageId = args.operation.targetMessageId
    args.generationJobs.register(args.operation.chatId, job.id)
    args.options.onDurableLifecycleTransition?.('registered', job)

    const owned = transitionGenerationOperation(args.db, {
      databaseLineage: job.databaseLineage,
      operationId: job.operationId,
      expectedState: 'launching',
      expectedStateVersion: args.operation.stateVersion,
      nextState: 'owned_by_job',
    })
    if (owned.status !== 'applied') throw new Error('generation operation ownership changed during launch')
    updateJobOperationProjection(job, owned.operation)

    args.attachInitialViewer?.(job)
    args.generationJobs.trackRunner(
      runWithDiagnosticContext(
        args.db,
        {
          databaseLineage: job.databaseLineage,
          requestUid: typeof args.metricContext.requestUid === 'string' ? args.metricContext.requestUid : undefined,
          operationId: job.operationId,
          attemptId: job.id,
          background: false,
        },
        () =>
          runGenerationJob({
            registry: args.generationJobs,
            job,
            db: args.db,
            input: args.input,
            dataDir: args.dataDir,
            eventSink: args.eventSink,
            clientCapabilities: args.clientCapabilities,
            options: args.options,
            generationTrace: args.generationTrace,
            messageTranslationJobs: args.messageTranslationJobs,
            preparedAssembly: args.preparedAssembly,
            deferredFailure: args.deferredFailure,
            metricContext: {
              ...args.metricContext,
              generationId: job.id,
              durableJobId: job.id,
              operationId: job.operationId,
              operationAttemptNo: job.attemptNo,
            },
          }),
      ),
    )
    args.options.onDurableLifecycleTransition?.('runner_tracked', job)
    return owned.operation
  } catch (error) {
    args.generationJobs.clearRunning(args.operation.chatId, job.id)
    args.generationJobs.registry.deleteJob(job.id)
    const current = getGenerationOperationProjection(args.db, job.databaseLineage!, job.operationId!)
    if (current?.state === 'launching' || current?.state === 'owned_by_job') {
      transitionGenerationOperation(args.db, {
        databaseLineage: job.databaseLineage!,
        operationId: job.operationId!,
        expectedState: current.state,
        expectedStateVersion: current.stateVersion,
        nextState: 'retryable',
        failureCode: 'generation_job_start_failed',
        failurePhase: 'launch',
        lastError: errorMessage(error, 'generation job startup failed'),
      })
    }
    throw error
  }
}

/** Compatibility durable route: create a legacy operation claim, then launch it. */
function startDurableGeneration(args: {
  req: FastifyRequest
  reply: FastifyReply
  db: DatabaseSync
  input: AssembleInput
  dataDir: string
  eventSink: CommandEventSink
  clientCapabilities: GenerationClientCapabilities
  options: GenerationChatRouteOptions
  generationTrace?: GenerationTraceOptions
  generationJobs: GenerationJobRegistry
  messageTranslationJobs: MessageTranslationJobRegistry
  serverInstanceId: string
  preparedAssembly?: PromptAssemblyRun
  deferredFailure?: AssemblyDeferredFailure
  metricContext: PromptAssemblyMetricContext
}): void {
  const { req, reply, input, generationJobs } = args
  if (generationJobs.hasRunningJob(input.chatId)) {
    reply.code(409).send({
      error: 'generation_in_progress',
      reason: 'A generation is already running for this chat.',
    })
    return
  }
  let job: StreamJob | undefined
  try {
    const writerSessionId = readWriterSessionHeader(req) ?? 'legacy'
    const writerEpoch = getDatabaseWriterMetadata(args.db).epoch
    const databaseLineage = getDatabaseLineage(args.db)
    const operationId = randomUUID()
    let reservation: ReturnType<typeof reserveGenerationOperationAttemptInTransaction>
    args.db.exec('BEGIN IMMEDIATE')
    let transactionOpen = true
    try {
      const pendingFinalization = findUncommittedGenerationFinalizationForChat(args.db, input.chatId)
      if (pendingFinalization) {
        args.db.exec('ROLLBACK')
        transactionOpen = false
        reply.code(409).send({
          error: 'generation_finalization_pending',
          reason: 'The previous reply is still saving. Try again when it finishes.',
          generationId: pendingFinalization.generationId,
        })
        return
      }
      const accepted = insertGenerationOperationInTransaction(args.db, {
        databaseLineage,
        operationId,
        protocolVersion: 0,
        requestOrigin: 'legacy',
        creatorWriterSessionId: writerSessionId,
        creatorWriterEpoch: writerEpoch,
        bindingServerInstanceId: args.serverInstanceId,
        characterId: input.characterId,
        chatId: input.chatId,
        mode: finalizationModeFromInput(input),
        targetMessageId: input.mode === 'regenerate' ? input.regenerateMessageId : null,
        requestFingerprint: generationOperationRequestFingerprint({ input, legacy: true }),
        intent: { input, legacy: true },
        acceptedRevision: getSchemaState(args.db).revision,
        state: 'accepted',
      })
      reservation = reserveGenerationOperationAttemptInTransaction(args.db, {
        databaseLineage,
        operationId,
        expectedState: 'accepted',
        expectedStateVersion: accepted.stateVersion,
        retryRequestId: operationId,
        jobId: randomUUID(),
        serverInstanceId: args.serverInstanceId,
        actorWriterSessionId: writerSessionId,
        actorWriterEpoch: writerEpoch,
        launchRevision: accepted.acceptedRevision ?? getSchemaState(args.db).revision,
      })
      args.db.exec('COMMIT')
      transactionOpen = false
    } catch (error) {
      if (transactionOpen) args.db.exec('ROLLBACK')
      throw error
    }
    if (reservation.status !== 'applied') throw new Error('legacy generation attempt reservation failed')
    const launched = launchGenerationOperation({
      operation: reservation.operation,
      db: args.db,
      input,
      dataDir: args.dataDir,
      eventSink: args.eventSink,
      clientCapabilities: args.clientCapabilities,
      options: args.options,
      generationTrace: args.generationTrace,
      generationJobs,
      messageTranslationJobs: args.messageTranslationJobs,
      preparedAssembly: args.preparedAssembly,
      deferredFailure: args.deferredFailure,
      metricContext: args.metricContext,
      attachInitialViewer(attachedJob) {
        job = attachedJob
        attachGenerationViewer(
          req,
          reply,
          generationJobs,
          attachedJob,
          args.db,
          args.options.viewerHeartbeatMs,
          args.options.onDurableLifecycleTransition,
        )
        args.options.onDurableLifecycleTransition?.('viewer_attached', attachedJob)
      },
    })
    if (job) updateJobOperationProjection(job, launched)
  } catch (error) {
    if (job) {
      generationJobs.clearRunning(input.chatId, job.id)
      generationJobs.registry.deleteJob(job.id)
    }
    req.log.error({ err: error, chatId: input.chatId, jobId: job?.id }, 'Durable generation startup failed')
    const sqliteCode =
      error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
    if (!reply.sent && sqliteCode.startsWith('SQLITE_CONSTRAINT')) {
      reply.code(409).send({
        error: 'generation_in_progress',
        reason: 'A generation is already running for this chat.',
      })
      return
    }
    if (reply.sent) {
      try {
        if (!reply.raw.writableEnded) reply.raw.end()
      } catch {
        // The attachment failure may also have made the response unwritable.
      }
      return
    }
    reply.code(500).send({ error: 'generation_job_start_failed' })
  }
}

export function registerGenerationChatRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  authState: AuthState,
  dataDir: string,
  eventSink: CommandEventSink,
  generationJobs: GenerationJobRegistry,
  messageTranslationJobs: MessageTranslationJobRegistry,
  serverInstanceId: string,
  options: GenerationChatRouteOptions = {},
  generationTrace?: GenerationTraceOptions,
): void {
  app.post('/api/v1/generate/chat', { config: { rateLimit: generationSubmitRateLimit } }, async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    const body = (req.body ?? {}) as ChatRequestBody
    const validation = validate(body)
    if (validation.ok === false) {
      return badRequest(reply, validation.error)
    }

    const input = toChatGenerationAssembleInput(body)
    const clientCapabilities = readGenerationClientCapabilities(body)
    const durable = body.durable === true && isPersistingMode(input.mode)
    const metricContext = createPromptAssemblyMetricContext({
      req,
      input,
      durable,
      clientCapabilities,
    })
    const requestAbort = attachAbort(req, reply)
    const preflight = preflightChatGenerationSettings(reply, input, dataDir, db)
    if (preflight.status === 'handled') {
      requestAbort.cleanup()
      return
    }
    let preparedAssembly: PromptAssemblyRun | undefined
    let deferredFailure = preflight.status === 'defer' ? preflight.failure : undefined
    if (
      preflight.status === 'ready' &&
      preflight.hypaContextTruncationCheckRequired &&
      clientCapabilities.hypaContextTruncationConfirmation
    ) {
      try {
        preparedAssembly = await assemblePromptWithMetrics(
          input,
          dataDir,
          db,
          requestAbort.signal,
          metricContext,
          undefined,
          options,
        )
      } catch (err) {
        if (sendAssemblyHttpError(reply, err)) {
          requestAbort.cleanup()
          return
        }
        deferredFailure = { error: err }
      }

      if (preparedAssembly && assemblyRequiresHypaContextTruncationConfirmation(preparedAssembly, clientCapabilities)) {
        requestAbort.cleanup()
        return reply.code(409).send({
          error: HYPA_CONTEXT_TRUNCATION_CONFIRMATION_REQUIRED,
          message: 'Confirmation is required before omitting older chat history without Hypa Memory.',
          chatId: input.chatId,
        })
      }
    }

    // Durable path for persisting generation modes. The active-writer submission
    // gate ran in the global preHandler; here we add the one-job-per-chat rule
    // and hand off to the detached runner.
    if (durable) {
      startDurableGeneration({
        req,
        reply,
        db,
        input,
        dataDir,
        eventSink,
        clientCapabilities,
        options,
        generationTrace,
        generationJobs,
        messageTranslationJobs,
        serverInstanceId,
        preparedAssembly,
        deferredFailure,
        metricContext,
      })
      requestAbort.cleanup()
      return
    }

    await streamAssembly(
      req,
      reply,
      db,
      input,
      dataDir,
      eventSink,
      clientCapabilities,
      messageTranslationJobs,
      options,
      generationTrace,
      preparedAssembly,
      deferredFailure,
      metricContext,
      requestAbort,
    )
  })

  // Reattach to a running, or done-within-grace, durable generation over SSE.
  // Observe is open to any authenticated client; completed jobs are read back via
  // the normal projection refresh.
  app.get<{ Params: { id: string } }>(
    '/api/v1/generate/chat/:id/stream',
    { exposeHeadRoute: false },
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      const job = generationJobs.registry.get(req.params.id)
      emitProtocolMetric(
        'generation_compatibility_stream_attach',
        {
          found: Boolean(job),
          jobId: req.params.id,
          ...(job?.operationId ? { operationId: job.operationId } : {}),
        },
        req.log,
      )
      if (!job) {
        reply.code(404).send({
          error: 'generation_job_not_found',
          reason: 'Generation job not found or already expired.',
        })
        return
      }
      attachGenerationViewer(
        req,
        reply,
        generationJobs,
        job,
        db,
        options.viewerHeartbeatMs,
        options.onDurableLifecycleTransition,
      )
    },
  )

  // A replay-budget spill keeps the complete terminal payload in an
  // instance-local file until the generation job's normal retention expires.
  // The SSE `done.terminalSnapshot` reference points here; streaming the JSON
  // file avoids rebuilding the oversized payload in the replay heap.
  app.get<{ Params: { id: string } }>(
    '/api/v1/generate/chat/:id/terminal-snapshot',
    { exposeHeadRoute: false },
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      const snapshot = generationJobs.registry.terminalSnapshotStream(req.params.id)
      if (!snapshot) {
        reply.code(404).send({
          error: 'generation_terminal_snapshot_not_found',
          reason: 'Generation terminal snapshot not found or already expired.',
        })
        return
      }
      reply.header('cache-control', 'no-store')
      reply.header('content-type', 'application/json; charset=utf-8')
      reply.header('content-length', String(snapshot.bytes))
      return reply.send(snapshot.stream)
    },
  )

  // Explicit cancel is authorized by the current active writer. It aborts provider
  // dispatch; the runner persists the streaming-so-far text and clears the
  // submission lock. A bare disconnect only detaches.
  app.delete<{ Params: { id: string } }>('/api/v1/generate/chat/:id', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    const job = generationJobs.registry.get(req.params.id)
    if (!job) {
      reply.code(404).send({
        disposition: 'not_found',
        error: 'generation_job_not_found',
        reason: 'Generation job not found or already expired.',
      })
      return
    }
    const lineage = generationOperationLineageForJob(job)
    let operation = lineage
      ? getGenerationOperationProjection(db, lineage.databaseLineage, lineage.operationId)
      : undefined
    if (operation?.state === 'completed') {
      return { disposition: 'already_completed', jobId: job.id, operation }
    }
    if (operation?.state === 'cancelled') {
      return { disposition: 'already_cancelled', jobId: job.id, operation }
    }
    if (operation?.state === 'finalizing') {
      return {
        disposition:
          operation.desiredTerminalOutcome === 'cancelled' ? 'cancelled_finalizing' : 'completion_finalizing',
        jobId: job.id,
        operation,
      }
    }
    if (operation?.state === 'terminal_failed' || operation?.state === 'invalidated' || job.done) {
      return { disposition: 'already_terminal', jobId: job.id, ...(operation ? { operation } : {}) }
    }
    if (lineage) {
      if (operation?.state === 'owned_by_job') {
        const stopping = transitionGenerationOperation(db, {
          databaseLineage: lineage.databaseLineage,
          operationId: lineage.operationId,
          expectedState: 'owned_by_job',
          expectedStateVersion: operation.stateVersion,
          nextState: 'stopping',
          cancelRequestedAt: new Date().toISOString(),
        })
        if (stopping.operation) {
          operation = stopping.operation
          updateJobOperationProjection(job, stopping.operation)
        }
      }
    }
    // Abort only — the runner's finally persists the streaming-so-far text and THEN
    // clears the submission lock. Clearing it here (synchronously, before the
    // async cancel-persist lands) would let an overlapping send for the same chat
    // start and race the cancel write.
    job.abortController.abort('user_stop')
    return reply.code(202).send({ disposition: 'cancelling', jobId: job.id, ...(operation ? { operation } : {}) })
  })

  // One-shot JSON preview. Unlike `/chat`, this never opens an SSE stream, so
  // scope errors surface as real HTTP status codes.
  app.post(
    '/api/v1/generate/preview-prompt',
    { config: { rateLimit: generationSubmitRateLimit } },
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return

      const body = (req.body ?? {}) as ChatRequestBody
      const validation = validatePreview(body)
      if (validation.ok === false) {
        return badRequest(reply, validation.error)
      }

      const input = toChatGenerationAssembleInput({ ...body, mode: 'preview_prompt' })
      const clientCapabilities = readGenerationClientCapabilities(body)
      const metricContext = createPromptAssemblyMetricContext({
        req,
        input,
        durable: false,
        clientCapabilities,
      })
      const { signal, cleanup } = attachAbort(req, reply)
      try {
        const { result, deps } = await assemblePromptWithMetrics(
          input,
          dataDir,
          db,
          signal,
          metricContext,
          undefined,
          options,
        )
        if (result.stopSending) {
          if (result.abortReason === 'bardwiki_pinned_budget_exceeded') reply.code(409)
          return {
            stopSending: true,
            abortReason: result.abortReason,
            message: assemblyStopError(result, deps.getDatabase()).error,
          }
        }
        return result.prompt ? promptEventForClient(result.prompt, clientCapabilities, input.mode) : result.prompt
      } catch (err) {
        if (sendAssemblyHttpError(reply, err)) return
        throw err
      } finally {
        cleanup()
      }
    },
  )
}
