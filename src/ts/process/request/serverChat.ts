import {
  canUseClientWriteAccess,
  canUseClientReadServices,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
  clientSessionStore,
} from '../../clientSession'
import { isClientWriteOperationCurrent } from '../../clientWriteOperation'
/**
 * Browser client adapter for `POST /api/v1/generate/chat`.
 *
 * POSTs an intent body, authenticates with the `risu-auth` header, and
 * stream-parses the SSE response. Unlike `/completion` (which dispatches an
 * already-assembled prompt to a provider), `/chat` performs server-side prompt
 * assembly and streams back prompt metadata plus `info` telemetry. Preview
 * requests still receive the assembled rows they render.
 *
 * This adapter consumes `stage` / `prompt` / `message_patch` / `info` /
 * `error` / `done`. Token / side-effect / warning events are tolerated for
 * generation streams. Preview prompt events carry full `formated` rows; normal
 * server-dispatched generations request metadata only because the browser never
 * sends those rows to a provider itself.
 */

import { getNodeServerProxyAuth } from '../../storage/fastifyStorage'
import type { MessageGenerationInfo } from '../../storage/database.svelte'
import { setCachedServerCommandRevision } from '../../server/commands'
import { activeWriterSessionHeader, handleActiveWriterStaleResponse } from '../../server/activeWriterSession'
import {
  beginPostGenerationProgress,
  clearPostGenerationProgress,
  updatePostGenerationProgress,
  type PostGenerationProgressSession,
} from '../postGenerationProgress'
import {
  beginAgentPresetProgress,
  clearAgentPresetProgress,
  updateAgentPresetProgress,
  type AgentPresetProgressSession,
} from '../agentPresetProgress'
import { forgetActiveGenerationJob, rememberActiveGenerationJob } from '../reattach'
import { handleServerGeneratedMessageTranslation } from '../serverGeneratedMessageTranslation'
import {
  beginHalfStreamingProgress,
  clearHalfStreamingProgress,
  recordHalfStreamingToken,
  type HalfStreamingProgressTarget,
} from '../halfStreamingProgress'
import { iterateSseEvents } from './sseParse'
import {
  parsePromptChatSseEvent,
  type ErrorEvent,
  type DoneEvent,
  type InfoEvent,
  type PromptEvent,
  type ServerChatGenerationProjection,
  type ServerChatGenerationPersistenceDisposition,
  type ServerChatMessagePatch,
  type ServerChatRestoration,
  type ServerChatSideEffect,
  type ServerChatWarning,
} from '@risuai/protocol/generation-sse'
import type { requestDataResponse, StreamResponseChunk } from './request'
import { HYPA_CONTEXT_TRUNCATION_CONFIRMATION_REQUIRED } from './hypaContextTruncation'
import { GENERATION_IN_PROGRESS_FAILURE_CAUSE } from '../sendChatFailure'
import type { GenerationReattachOutcomeStatus } from '../generationReattachOutcome'
import { readBrowserClientContext } from './clientContext'
import { alertToast } from '../../alert'
import { language } from '../../../lang'
import {
  applyGenerationOperationSseEvent,
  reconcileGenerationOperationErrorBody,
  registerGenerationOperationViewer,
  stopGenerationOperation,
} from '../../server/generationOperations'
import { recordGenerationRecoveryEvent } from '../../server/protocolDiagnostics'
import type { GenerationDisplayProjectionRef } from '../generationDisplayProjection.svelte'
import { registerServerChatRuntime } from '../generationRuntimeBridge'

const CHAT_ENDPOINT = '/api/v1/generate/chat'
const INCOMPLETE_CHAT_GENERATION_SETTINGS_ERROR = 'chat_generation_settings_incomplete'
const HUMAN_REASON_ERROR_CODES = new Set([
  'generation_in_progress',
  'generation_job_not_found',
  'generation_finalization_pending',
])
const REQUEST_UID_HEADER = 'X-Request-UID'
const DURABLE_JOB_ID_HEADER = 'X-Risu-Generation-Job-ID'
// The recovery coordinator owns retry/backoff. The adapter performs one
// immediate replay-aware reopen so short read-boundary failures stay invisible.
const DURABLE_STREAM_RECONNECT_DELAYS_MS = [0] as const
const MAX_DURABLE_STREAM_RECONNECT_CYCLES = 1
export const SERVER_CHAT_CLIENT_CAPABILITIES = {
  compactPromptEvent: true,
  promptMetadataOnly: true,
  omitDuplicateDoneResult: true,
  hypaContextTruncationConfirmation: true,
  regenerateTargetProjection: 1,
} as const

const durableGenerationViewerRetirers = new Map<string, Set<() => void>>()

/** Retire local viewers for an exact job without issuing durable cancellation. */
export function retireGenerationJobViewers(jobId: string): void {
  const viewers = durableGenerationViewerRetirers.get(jobId)
  if (!viewers) return
  durableGenerationViewerRetirers.delete(jobId)
  for (const retire of [...viewers]) retire()
}

function registerGenerationJobViewer(jobId: string, retire: () => void): () => void {
  if (!jobId) return () => undefined
  const viewers = durableGenerationViewerRetirers.get(jobId) ?? new Set<() => void>()
  viewers.add(retire)
  durableGenerationViewerRetirers.set(jobId, viewers)
  return () => {
    const current = durableGenerationViewerRetirers.get(jobId)
    current?.delete(retire)
    if (current?.size === 0) durableGenerationViewerRetirers.delete(jobId)
  }
}

function showServerCompatibilityWarning(warning: ServerChatWarning): void {
  const context = warning.context
  if (context?.kind === 'unsupported_trigger_effect' && typeof context.effectType === 'string') {
    alertToast(language.triggerEffectRuntimeUnsupported(context.effectType))
    return
  }
  if (context?.kind !== 'unsupported_cbs_callback' || typeof context.callbackName !== 'string') return
  alertToast(
    context.reason === 'client_context_unavailable'
      ? language.cbsClientContextUnavailable(context.callbackName)
      : language.cbsCallbackRuntimeUnsupported(context.callbackName),
  )
}

function clearLiveGenerationProgress(
  agentPresetSession: AgentPresetProgressSession,
  postGenerationSession: PostGenerationProgressSession,
): void {
  clearAgentPresetProgress(agentPresetSession)
  clearPostGenerationProgress(postGenerationSession)
}

/** The request body the `/chat` route expects (mirrors server `AssembleInput`). */
export interface ServerChatInput {
  chatId: string
  characterId: string
  mode: 'send' | 'continue' | 'preview' | 'preview_prompt' | 'regenerate'
  userMessage?: string
  /** Original-compatible send from an assistant tail without appending a user row. */
  emptySend?: boolean
  syntheticSayNothing?: boolean
  regenerateMessageId?: string
  loadoutId?: string
  resetMessages?: boolean
  expectedRevision?: number
  /** Legacy compatibility only; Fastify inlay bytes should live in `/assets`. */
  inlayAssets?: unknown[]
  /** Legacy browser-local inlay id -> server asset id aliases. */
  inlayAssetRefs?: unknown[]
  clientCapabilities?: typeof SERVER_CHAT_CLIENT_CAPABILITIES
  /**
   * When set, the server runs this as a detached, reconnectable job and persists
   * the result itself, so the browser suppresses its own generation-result persist.
   * Computed by `resolveDurableGeneration`.
   */
  durable?: boolean
}

export interface ServerChatOperationStream {
  operationId: string
  acceptedMessageId?: string
  attemptNo: number
  jobId: string
  projectionEpoch: number
  href: string
}

/** The assembled prompt payload, parsed from the `prompt` SSE event. */
export type ServerChatPrompt = Omit<PromptEvent, 'type'>

/** Telemetry parsed from the `info` SSE event. */
export type ServerChatInfo = Omit<InfoEvent, 'type'>

export type ServerChatResult =
  | {
      status: 'ok'
      prompt: ServerChatPrompt
      info?: ServerChatInfo
      messagePatches: ServerChatMessagePatch[]
    }
  | { status: 'error'; error: string; code?: string; messagePatches?: ServerChatMessagePatch[] }
  | { status: 'aborted' }

export interface ServerChatTerminal {
  status: 'done' | 'cancelled' | 'error'
  error?: string
  reattachOutcome?: GenerationReattachOutcomeStatus
  restoration?: ServerChatRestoration
  persistenceDisposition?: Exclude<ServerChatGenerationPersistenceDisposition, 'committed_cleanup_pending'>
  generationProjection?: ServerChatGenerationProjection
  sideEffects?: ServerChatSideEffect[]
  warnings?: ServerChatWarning[]
  done?: Omit<DoneEvent, 'type'>
}

export type ServerChatGenerationResult =
  | {
      status: 'ok'
      prompt: ServerChatPrompt
      info?: ServerChatInfo
      messagePatches: ServerChatMessagePatch[]
      req: Exclude<requestDataResponse, { type: 'fail' }>
      generationId: string
      generationInfo: MessageGenerationInfo
      terminal: Promise<ServerChatTerminal>
    }
  | {
      status: 'error'
      error: string
      code?: string
      reattachOutcome?: GenerationReattachOutcomeStatus
      messagePatches?: ServerChatMessagePatch[]
      restoration?: ServerChatRestoration
    }
  | { status: 'aborted' }

export type LegacyGenerationCancellationDisposition =
  | 'cancelling'
  | 'cancelled_finalizing'
  | 'completion_finalizing'
  | 'already_cancelled'
  | 'already_completed'
  | 'already_terminal'

export type LegacyGenerationCancellationResult =
  | { status: 'acknowledged'; disposition: LegacyGenerationCancellationDisposition; jobId: string }
  | { status: 'not_found'; error: string }
  | { status: 'failed'; error: string; code?: string }

function parseData(data: string): Record<string, unknown> | null {
  try {
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    return null
  }
}

function omitEventType<T extends { type: unknown }>(event: T): Omit<T, 'type'> {
  const { type: _type, ...payload } = event
  return payload
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function truncationConfirmationCode(value: unknown): string | undefined {
  return value === HYPA_CONTEXT_TRUNCATION_CONFIRMATION_REQUIRED ? value : undefined
}

function httpErrorCode(value: unknown): string | undefined {
  return (
    truncationConfirmationCode(value) ??
    (value === GENERATION_IN_PROGRESS_FAILURE_CAUSE
      ? GENERATION_IN_PROGRESS_FAILURE_CAUSE
      : value === 'generation_job_not_found'
        ? value
        : value === 'stale_generation_attempt'
          ? value
          : undefined)
  )
}

function httpErrorReason(body: { error?: unknown; message?: unknown; reason?: unknown }): string | null {
  if (body.error === INCOMPLETE_CHAT_GENERATION_SETTINGS_ERROR && nonEmptyString(body.message)) {
    return body.message
  }
  if (nonEmptyString(body.message)) return body.message
  if (typeof body.error === 'string' && HUMAN_REASON_ERROR_CODES.has(body.error) && nonEmptyString(body.reason)) {
    return body.reason
  }
  if (nonEmptyString(body.error)) return body.error
  if (nonEmptyString(body.reason)) return body.reason
  return null
}

function cancellationHttpError(body: unknown, status: number, statusText: string): string {
  const reason =
    body && typeof body === 'object' && !Array.isArray(body)
      ? httpErrorReason(body as { error?: unknown; message?: unknown; reason?: unknown })
      : null
  return reason ?? `HTTP ${status}${statusText ? ` ${statusText}` : ''}`
}

function serverChatCaller(input: ServerChatInput): 'chat-generate' | 'preview-prompt' {
  return input.mode === 'preview_prompt' ? 'preview-prompt' : 'chat-generate'
}

function protocolDebugEnabled(): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      (localStorage.getItem('risu:protocol-debug') === '1' || localStorage.getItem('risu:protocol-debug') === 'true')
    )
  } catch {
    return false
  }
}

function debugServerChat(event: string, details: Record<string, unknown>): void {
  if (!protocolDebugEnabled()) return
  console.debug('[risu:protocol]', event, details)
}

function errorMessageFromEvent(data: ErrorEvent, fallback: string): string {
  const error = nonEmptyString(data.error) ? data.error : fallback
  const details: string[] = []
  if (typeof data.status === 'number' && Number.isFinite(data.status) && !error.includes(`HTTP ${data.status}`)) {
    const statusText = nonEmptyString(data.statusText) ? ` ${data.statusText}` : ''
    details.push(`HTTP ${data.status}${statusText}`)
  }
  if (nonEmptyString(data.code) && !error.includes(data.code)) {
    details.push(`code ${data.code}`)
  }
  return details.length > 0 ? `${error} (${details.join(', ')})` : error
}

/**
 * When `/generate/chat` persists an assembly-time chat-var delta, it returns the
 * bumped revision on the `info` frame. Sync the command layer's cached revision
 * so the next browser command POSTs the right `baseRevision` instead of a stale
 * one. Absent when the route persisted nothing, in which case this is a no-op.
 */
function reconcileServerCommandRevision(info: ServerChatInfo): void {
  if (typeof info.revision === 'number') {
    setCachedServerCommandRevision(info.revision)
  }
}

/**
 * Explicitly cancel a running durable job. A bare disconnect only detaches the
 * viewer; the job keeps generating, so the stop button must
 * `DELETE /generate/chat/:id` to abort it. Authorized by the current active
 * writer. Compatibility callers receive typed acknowledgement instead of
 * treating dispatch as cancellation success.
 */
export async function cancelServerChatGeneration(generationId: string): Promise<LegacyGenerationCancellationResult> {
  if (!canUseClientWriteAccess()) return { status: 'failed', error: 'client_write_access_required' }
  const sourceGeneration = captureClientSessionGeneration()
  if (!generationId) return { status: 'failed', error: 'Generation job ID is required.' }
  try {
    const auth = await getNodeServerProxyAuth()
    if (!isClientWriteOperationCurrent(sourceGeneration))
      return { status: 'failed', error: 'client_write_operation_stale' }
    const response = await fetch(`${CHAT_ENDPOINT}/${encodeURIComponent(generationId)}`, {
      method: 'DELETE',
      headers: {
        'risu-auth': auth,
        'x-risu-caller': 'chat-cancel',
        ...activeWriterSessionHeader(),
      },
    })
    const requestUid = response.headers.get(REQUEST_UID_HEADER) || undefined
    debugServerChat('server-chat-cancel-response', {
      requestUid,
      status: response.status,
      ok: response.ok,
    })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // A non-JSON response cannot acknowledge the requested job lifecycle.
    }
    if (response.status === 404) {
      return {
        status: 'not_found',
        error: cancellationHttpError(body, response.status, response.statusText),
      }
    }
    if (!response.ok) {
      handleActiveWriterStaleResponse(response, body, sourceGeneration)
      return {
        status: 'failed',
        error: cancellationHttpError(body, response.status, response.statusText),
        ...(body && typeof body === 'object' && typeof (body as Record<string, unknown>).error === 'string'
          ? { code: (body as Record<string, unknown>).error as string }
          : {}),
      }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 'failed', error: 'Invalid generation cancellation response.' }
    }
    const record = body as Record<string, unknown>
    const allowed: readonly LegacyGenerationCancellationDisposition[] = [
      'cancelling',
      'cancelled_finalizing',
      'completion_finalizing',
      'already_cancelled',
      'already_completed',
      'already_terminal',
    ]
    if (
      typeof record.jobId !== 'string' ||
      !allowed.includes(record.disposition as LegacyGenerationCancellationDisposition)
    ) {
      return { status: 'failed', error: 'Invalid generation cancellation response.' }
    }
    return {
      status: 'acknowledged',
      disposition: record.disposition as LegacyGenerationCancellationDisposition,
      jobId: record.jobId,
    }
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? `Network error: ${error.message}` : `Network error: ${String(error)}`,
    }
  }
}

async function openChatResponse(
  input: ServerChatInput,
  signal: AbortSignal | null,
  reattachJobId?: string,
  operationStream?: ServerChatOperationStream,
  staleAttemptRedirects = 0,
  sourceGeneration = captureClientSessionGeneration(),
): Promise<
  | { status: 'ok'; response: Response; requestUid?: string; operationStream?: ServerChatOperationStream }
  | {
      status: 'error'
      error: string
      code?: string
      requestUid?: string
      httpStatus?: number
      retryable?: boolean
    }
  | { status: 'aborted' }
> {
  const canOpen = () =>
    isClientSessionGenerationCurrent(sourceGeneration) &&
    (reattachJobId || operationStream ? canUseClientReadServices() : canUseClientWriteAccess())
  if (!canOpen()) return { status: 'error', error: 'client_write_access_required', retryable: false }
  const auth = await getNodeServerProxyAuth()
  if (!canOpen()) return { status: 'aborted' }

  let response: Response
  try {
    // Reattach by GETting the live stream of an already-running durable job
    // (buffered frames first, then live). A fresh send POSTs the intent body.
    response =
      reattachJobId || operationStream
        ? await fetch(operationStream?.href ?? `${CHAT_ENDPOINT}/${encodeURIComponent(reattachJobId!)}/stream`, {
            method: 'GET',
            headers: {
              'risu-auth': auth,
              'x-risu-caller': operationStream ? 'generation-operation-stream' : 'chat-reattach',
              ...(canUseClientWriteAccess() ? activeWriterSessionHeader() : {}),
            },
            signal: signal ?? undefined,
          })
        : await fetch(CHAT_ENDPOINT, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'risu-auth': auth,
              'x-risu-caller': serverChatCaller(input),
              ...activeWriterSessionHeader(),
            },
            body: JSON.stringify({
              ...input,
              clientCapabilities: SERVER_CHAT_CLIENT_CAPABILITIES,
              clientContext: readBrowserClientContext(),
            }),
            signal: signal ?? undefined,
          })
  } catch (err) {
    if (signal?.aborted) return { status: 'aborted' }
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 'error', error: `Network error: ${msg}`, retryable: true }
  }
  const requestUid = response.headers.get(REQUEST_UID_HEADER) || undefined
  debugServerChat('server-chat-response-opened', {
    requestUid,
    caller: operationStream ? 'generation-operation-stream' : reattachJobId ? 'chat-reattach' : serverChatCaller(input),
    status: response.status,
    ok: response.ok,
  })

  if (!response.ok) {
    const statusText = response.statusText.trim()
    let reason = `HTTP ${response.status}${statusText ? ` ${statusText}` : ''}`
    let code: string | undefined
    let body: unknown = null
    try {
      body = (await response.json()) as {
        error?: unknown
        message?: unknown
        reason?: unknown
      }
      if (body && typeof body === 'object') {
        code = httpErrorCode((body as { error?: unknown }).error)
      }
      reason = httpErrorReason(body) ?? reason
    } catch {
      // ignore parse failure
    }
    handleActiveWriterStaleResponse(response, body, sourceGeneration)
    if (
      isClientSessionGenerationCurrent(sourceGeneration) &&
      operationStream &&
      response.status === 409 &&
      code === 'stale_generation_attempt' &&
      staleAttemptRedirects < 3
    ) {
      const authority = reconcileGenerationOperationErrorBody(body)
      if (authority.disposition === 'redirected' && authority.stream.operationId === operationStream.operationId) {
        recordGenerationRecoveryEvent(
          {
            trigger: 'stream_open',
            recoveryEpoch: 0,
            disposition: 'stale_attempt_redirect',
            operationId: authority.operation.operationId,
            attemptNo: authority.stream.attemptNo,
            jobId: authority.stream.jobId,
            requestUid,
          },
          'stale_attempt_redirect',
        )
        return openChatResponse(input, signal, undefined, authority.stream, staleAttemptRedirects + 1, sourceGeneration)
      }
    }
    debugServerChat('server-chat-response-error', { requestUid, status: response.status, error: reason })
    if (operationStream || reattachJobId) {
      recordGenerationRecoveryEvent({
        trigger: 'stream_open',
        recoveryEpoch: 0,
        disposition: code ?? `http_${response.status}`,
        ...(operationStream?.operationId ? { operationId: operationStream.operationId } : {}),
        ...(operationStream?.attemptNo !== undefined ? { attemptNo: operationStream.attemptNo } : {}),
        jobId: operationStream?.jobId ?? reattachJobId!,
        requestUid,
      })
    }
    return {
      status: 'error',
      error: reason,
      ...(code ? { code } : {}),
      requestUid,
      httpStatus: response.status,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    }
  }

  if (!isClientSessionGenerationCurrent(sourceGeneration)) {
    void response.body?.cancel().catch(() => {})
    return { status: 'aborted' }
  }
  if (!response.body) {
    const error = 'Server did not return a streaming response body.'
    debugServerChat('server-chat-response-error', { requestUid, status: response.status, error })
    return { status: 'error', error, requestUid, retryable: true }
  }

  return { status: 'ok', response, requestUid, ...(operationStream ? { operationStream } : {}) }
}

async function fetchDurableTerminalSnapshot(
  jobId: string,
  reference: NonNullable<DoneEvent['terminalSnapshot']>,
  signal: AbortSignal,
): Promise<Omit<DoneEvent, 'type'>> {
  const expectedHref = `${CHAT_ENDPOINT}/${encodeURIComponent(jobId)}/terminal-snapshot`
  if (reference.version !== 1 || reference.href !== expectedHref) {
    throw new Error('Server returned an invalid durable terminal snapshot reference.')
  }
  const auth = await getNodeServerProxyAuth()
  const response = await fetch(expectedHref, {
    method: 'GET',
    headers: {
      'risu-auth': auth,
      'x-risu-caller': 'chat-terminal-snapshot',
      ...activeWriterSessionHeader(),
    },
    signal,
  })
  if (!response.ok) {
    throw new Error(`Durable terminal snapshot fetch failed with HTTP ${response.status}.`)
  }
  const payload = (await response.json()) as unknown
  const event = parsePromptChatSseEvent('done', payload)
  if (!event || event.type !== 'done') {
    throw new Error('Server returned an invalid durable terminal snapshot payload.')
  }
  return omitEventType(event)
}

function classifyReattachOpenError(error: {
  httpStatus?: number
  code?: string
  retryable?: boolean
}): GenerationReattachOutcomeStatus {
  if (error.code === 'stale_generation_attempt') return 'authority_reconciliation_required'
  if (error.httpStatus === 404) return 'missing_job'
  return error.retryable === true ? 'retryable_transport_failure' : 'terminal_failure'
}

async function waitForDurableReconnect(delayMs: number, signal: AbortSignal | null): Promise<boolean> {
  if (signal?.aborted) return false
  if (delayMs <= 0) return true

  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => finish(false)
    const timer = setTimeout(() => finish(true), delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) finish(false)
  })
}

/**
 * Call the `/chat` route and resolve the assembled prompt. The terminal
 * `done` event (or stream end) closes a successful run; an `error` event is
 * terminal and surfaces its message; an abort resolves as `aborted`.
 */
export async function requestServerChat(input: ServerChatInput, signal: AbortSignal | null): Promise<ServerChatResult> {
  const sourceGeneration = captureClientSessionGeneration()
  const opened = await openChatResponse(input, signal, undefined, undefined, 0, sourceGeneration)
  if (opened.status !== 'ok') {
    return opened.status === 'error'
      ? {
          status: 'error',
          error: opened.error,
          ...(opened.code ? { code: opened.code } : {}),
        }
      : opened
  }
  const response = opened.response

  let prompt: ServerChatPrompt | null = null
  let info: ServerChatInfo | undefined
  const messagePatches: ServerChatMessagePatch[] = []
  let error: string | null = null
  let errorCode: string | undefined
  let done = false

  // The SSE event *name* (`frame.event`) is the discriminator; the `data:`
  // payload carries the remaining fields with `type` stripped (see the
  // server's `writePromptChatEvent`).
  for await (const frame of iterateSseEvents(response.body, signal)) {
    if (!isClientWriteOperationCurrent(sourceGeneration)) return { status: 'aborted' }
    const event = parsePromptChatSseEvent(frame.event, parseData(frame.data))
    if (!event) continue
    switch (event.type) {
      case 'prompt':
        prompt = omitEventType(event)
        break
      case 'info':
        info = omitEventType(event)
        reconcileServerCommandRevision(info)
        break
      case 'message_patch':
        messagePatches.push(event.patch)
        break
      case 'error':
        error = errorMessageFromEvent(event, 'Server returned an error without details during prompt assembly.')
        errorCode = truncationConfirmationCode(event.code) ?? truncationConfirmationCode(event.reason)
        done = true
        break
      case 'done':
        done = true
        break
      // Prompt-only calls ignore stage and dispatch-coupled events.
      default:
        break
    }
    if (done) break
  }

  if (signal?.aborted) return { status: 'aborted' }
  if (error !== null) {
    return {
      status: 'error',
      error,
      ...(errorCode ? { code: errorCode } : {}),
      ...(messagePatches.length > 0 ? { messagePatches } : {}),
    }
  }
  if (!prompt) {
    return { status: 'error', error: 'stream ended without a prompt event' }
  }
  return { status: 'ok', prompt, info, messagePatches }
}

function coerceGenerationInfo(
  info: ServerChatInfo | undefined,
  done: Omit<DoneEvent, 'type'> | undefined,
): { generationId: string; generationInfo: MessageGenerationInfo } | null {
  const doneGenerationInfo =
    done?.generationInfo && typeof done.generationInfo === 'object'
      ? (done.generationInfo as MessageGenerationInfo)
      : undefined
  const infoGenerationInfo =
    info?.generationInfo && typeof info.generationInfo === 'object'
      ? (info.generationInfo as MessageGenerationInfo)
      : undefined
  const generationInfo: MessageGenerationInfo = {
    ...(infoGenerationInfo ?? {}),
    ...(doneGenerationInfo ?? {}),
  }
  const generationId =
    typeof done?.generationId === 'string'
      ? done.generationId
      : typeof info?.generationId === 'string'
        ? info.generationId
        : typeof generationInfo.generationId === 'string'
          ? generationInfo.generationId
          : ''
  if (generationId.length === 0) return null
  generationInfo.generationId = generationId
  if (generationInfo.inputTokens === undefined && typeof info?.tokens?.prompt === 'number') {
    generationInfo.inputTokens = info.tokens.prompt
  }
  if (generationInfo.outputTokens === undefined && typeof info?.responseBudget === 'number') {
    generationInfo.outputTokens = info.responseBudget
  }
  if (generationInfo.stageTiming === undefined) {
    generationInfo.stageTiming = {
      stage1: typeof info?.timings?.prompt === 'number' ? info.timings.prompt : 0,
      stage2: 0,
      stage3: 0,
      stage4: 0,
    }
  }
  return { generationId, generationInfo }
}

function regenerateDisplayProjectionFromInfo(
  input: ServerChatInput,
  info: ServerChatInfo,
  operationStream: ServerChatOperationStream | undefined,
): GenerationDisplayProjectionRef | undefined {
  const projection = info.generationDisplayProjection
  if (
    input.mode !== 'regenerate' ||
    !projection ||
    projection.version !== 1 ||
    projection.mode !== 'regenerate' ||
    projection.targetMessageId !== input.regenerateMessageId ||
    !nonEmptyString(projection.generationId) ||
    !nonEmptyString(projection.operationId) ||
    !Number.isSafeInteger(projection.attemptNo) ||
    !Number.isSafeInteger(projection.projectionEpoch)
  ) {
    return undefined
  }
  if (
    operationStream &&
    (operationStream.operationId !== projection.operationId || operationStream.attemptNo !== projection.attemptNo)
  ) {
    return undefined
  }
  return {
    operationId: projection.operationId,
    attemptNo: projection.attemptNo,
    characterId: input.characterId,
    chatId: input.chatId,
    mode: 'regenerate',
    targetMessageId: projection.targetMessageId,
    generationId: projection.generationId,
    projectionEpoch: projection.projectionEpoch,
  }
}

export async function requestServerChatGeneration(
  input: ServerChatInput,
  signal: AbortSignal | null,
  reattachJobId?: string,
  operationStream?: ServerChatOperationStream,
): Promise<ServerChatGenerationResult> {
  const sourceGeneration = captureClientSessionGeneration()
  if (!reattachJobId && !operationStream && !canUseClientWriteAccess())
    return { status: 'error', error: 'client_write_access_required' }
  let authoritativeOperationStream = operationStream
  const agentPresetSession = beginAgentPresetProgress(input.chatId)
  const postGenerationSession = beginPostGenerationProgress({
    characterId: input.characterId,
    chatId: input.chatId,
  })
  // Reattach already knows the durable job before the viewer GET opens. Watch
  // explicit Stop immediately so cancellation owns the whole visible activity,
  // including the pre-response window. Fresh durable sends fill this from the
  // response header (or job_accepted) below.
  let durableJobId = authoritativeOperationStream?.jobId ?? reattachJobId ?? ''
  const watchesDurableJob = input.durable === true || reattachJobId !== undefined || operationStream !== undefined
  let cancelledDurableJobId = ''
  const viewerAbortController = new AbortController()
  let consumerDetached = false
  let observerSuperseded = false
  let operationStopDetached = false
  let operationCancellationRequested = false
  let observedJobId = ''
  let unregisterGenerationJobViewer = () => undefined
  const retireObserver = (): void => {
    if (observerSuperseded) return
    observerSuperseded = true
    viewerAbortController.abort()
  }
  const observeJobId = (jobId: string): void => {
    if (!jobId || observedJobId === jobId) return
    unregisterGenerationJobViewer()
    observedJobId = jobId
    unregisterGenerationJobViewer = registerGenerationJobViewer(jobId, retireObserver)
  }
  const unregisterGenerationOperationViewer = authoritativeOperationStream
    ? registerGenerationOperationViewer(
        authoritativeOperationStream.operationId,
        () => {
          operationCancellationRequested = true
          operationStopDetached = true
          // Stop owns the durable operation, but this viewer still owns the
          // visible transcript. Keep consuming until the canonical cancelled
          // terminal arrives so its processed snapshot can be applied locally.
        },
        retireObserver,
      )
    : () => undefined
  const cancelDurableOnAbort = (): void => {
    if (!isClientWriteOperationCurrent(sourceGeneration)) return
    // Protocol-v1 Stop is addressed before a job ID exists and stages its own
    // durable control before detaching this viewer.
    if (authoritativeOperationStream?.operationId) {
      if (operationCancellationRequested) return
      operationCancellationRequested = true
      void stopGenerationOperation(authoritativeOperationStream.operationId)
      return
    }
    // Compatibility jobs retain their typed job-ID cancellation boundary.
    if (!watchesDurableJob || durableJobId.length === 0 || cancelledDurableJobId === durableJobId) return
    cancelledDurableJobId = durableJobId
    void cancelServerChatGeneration(durableJobId)
  }
  const onOwnerAbort = (): void => {
    if (!isClientWriteOperationCurrent(sourceGeneration)) {
      retireObserver()
      return
    }
    cancelDurableOnAbort()
    if (!authoritativeOperationStream?.operationId) viewerAbortController.abort()
  }
  const stopSessionWatch = clientSessionStore.subscribe(() => {
    if (!isClientSessionGenerationCurrent(sourceGeneration)) retireObserver()
  })
  const stopWatchingAbort = (): void => {
    stopSessionWatch()
    signal?.removeEventListener('abort', onOwnerAbort)
    unregisterGenerationOperationViewer()
    unregisterGenerationJobViewer()
  }
  observeJobId(durableJobId)
  if (signal?.aborted) {
    onOwnerAbort()
  } else {
    signal?.addEventListener('abort', onOwnerAbort, { once: true })
  }

  const opened = await openChatResponse(
    input,
    viewerAbortController.signal,
    reattachJobId,
    authoritativeOperationStream,
    0,
    sourceGeneration,
  )
  if (opened.status !== 'ok') {
    stopWatchingAbort()
    if (opened.status === 'aborted' && reattachJobId && !observerSuperseded) forgetActiveGenerationJob(reattachJobId)
    clearAgentPresetProgress(agentPresetSession)
    clearPostGenerationProgress(postGenerationSession)
    if (opened.status === 'aborted' && observerSuperseded) {
      return {
        status: 'error',
        error: 'The previous generation observer was replaced by foreground recovery.',
        reattachOutcome: 'observer_superseded',
      }
    }
    return opened.status === 'error'
      ? {
          status: 'error',
          error: opened.error,
          ...(opened.code ? { code: opened.code } : {}),
          ...(reattachJobId || authoritativeOperationStream
            ? { reattachOutcome: classifyReattachOpenError(opened) }
            : {}),
        }
      : opened
  }
  authoritativeOperationStream = opened.operationStream ?? authoritativeOperationStream
  durableJobId = authoritativeOperationStream?.jobId ?? durableJobId

  let prompt: ServerChatPrompt | null = null
  let info: ServerChatInfo | undefined
  let donePayload: Omit<DoneEvent, 'type'> | undefined
  const messagePatches: ServerChatMessagePatch[] = []
  const sideEffects: ServerChatSideEffect[] = []
  const warnings: ServerChatWarning[] = []
  const seenMessagePatches = new Set<string>()
  const seenSideEffects = new Set<string>()
  const seenAgentProgress = new Set<string>()
  const seenPostGenerationProgress = new Set<string>()
  const seenWarnings = new Set<string>()
  let readyResolved = false
  let terminalResolved = false
  let tokenStreamInactive = false
  let tokenResult = ''
  let replayGapTruncated = false
  let replayGapPending = false
  let streamKey = 'server-chat'
  let halfStreaming = false
  let halfStreamingTarget: HalfStreamingProgressTarget | null = null
  const beginHalfStreaming = (generationId: string): void => {
    halfStreamingTarget = {
      characterId: input.characterId,
      chatId: input.chatId,
      generationId,
    }
    beginHalfStreamingProgress(halfStreamingTarget)
  }
  const clearHalfStreaming = (): void => {
    if (!halfStreamingTarget) return
    clearHalfStreamingProgress(halfStreamingTarget)
    halfStreamingTarget = null
  }
  // The server also returns the durable job id in the response headers. Unlike
  // the first `job_accepted` body frame, headers are available as soon as fetch
  // accepts the response, so Stop can cancel a job even while its first body
  // bytes are still delayed by the network.
  durableJobId ||= opened.response.headers.get(DURABLE_JOB_ID_HEADER)?.trim() ?? ''
  observeJobId(durableJobId)
  const reattachOutcomeFields = (
    status: GenerationReattachOutcomeStatus,
  ): { reattachOutcome: GenerationReattachOutcomeStatus } | Record<string, never> =>
    reattachJobId || authoritativeOperationStream ? { reattachOutcome: status } : {}
  let operationLineage: Partial<ServerChatOperationStream> = authoritativeOperationStream ?? {}
  const rememberDurableJob = (): void => {
    if (!watchesDurableJob || durableJobId.length === 0) return
    rememberActiveGenerationJob({
      chatId: input.chatId,
      jobId: durableJobId,
      ...(input.mode === 'continue' || input.mode === 'regenerate' ? { mode: input.mode } : { mode: 'send' }),
      ...(info?.continueDisposition ? { continueDisposition: info.continueDisposition } : {}),
      ...(input.mode === 'regenerate' && input.regenerateMessageId
        ? { regenerateMessageId: input.regenerateMessageId }
        : {}),
      ...(operationLineage.operationId ? { operationId: operationLineage.operationId } : {}),
      ...(operationLineage.acceptedMessageId ? { acceptedMessageId: operationLineage.acceptedMessageId } : {}),
      ...(operationLineage.attemptNo !== undefined ? { attemptNo: operationLineage.attemptNo } : {}),
      ...(operationLineage.projectionEpoch !== undefined ? { projectionEpoch: operationLineage.projectionEpoch } : {}),
    })
  }
  rememberDurableJob()
  if (signal?.aborted) cancelDurableOnAbort()

  let resolveReady: (value: ServerChatGenerationResult) => void = () => {}
  const ready = new Promise<ServerChatGenerationResult>((resolve) => {
    resolveReady = resolve
  })

  let resolveTerminal: (value: ServerChatTerminal) => void = () => {}
  const terminal = new Promise<ServerChatTerminal>((resolve) => {
    resolveTerminal = resolve
  })
  let streamingRequest: Extract<requestDataResponse, { type: 'streaming' }> | undefined

  const resolveReadyOnce = (value: ServerChatGenerationResult): void => {
    if (readyResolved) return
    readyResolved = true
    resolveReady(value)
  }

  const resolveTerminalOnce = (value: ServerChatTerminal): void => {
    if (terminalResolved) return
    terminalResolved = true
    resolveTerminal(value)
  }

  const tokenStream = new ReadableStream<StreamResponseChunk>({
    start(controller) {
      const enqueueToken = (chunk: StreamResponseChunk): void => {
        if (tokenStreamInactive) return
        try {
          controller.enqueue(chunk)
        } catch {
          tokenStreamInactive = true
        }
      }
      const closeTokenStream = (): void => {
        if (tokenStreamInactive) return
        tokenStreamInactive = true
        try {
          controller.close()
        } catch {
          // The consumer may have cancelled or errored the readable during abort.
        }
      }
      const maybeResolveReady = (): void => {
        if (readyResolved || !prompt || !info) return
        const generation = coerceGenerationInfo(info, donePayload)
        if (!generation) return
        streamKey = generation.generationId
        halfStreaming = info.halfStreaming === true
        if (halfStreaming) {
          beginHalfStreaming(generation.generationId)
        }
        const generationDisplayProjection = regenerateDisplayProjectionFromInfo(
          input,
          info,
          authoritativeOperationStream,
        )
        streamingRequest = {
          type: 'streaming',
          result: tokenStream,
          ...(halfStreaming ? { halfStreaming: true, halfStreamingProgressManaged: true } : {}),
          ...(replayGapTruncated ? { replayGapTruncated: true } : {}),
          ...(replayGapPending ? { replayGapPending: true } : {}),
          ...(info.continueDisposition ? { continueDisposition: info.continueDisposition } : {}),
          ...(typeof info.continueBase === 'string' ? { continueBase: info.continueBase } : {}),
          ...(generationDisplayProjection ? { generationDisplayProjection } : {}),
        }
        resolveReadyOnce({
          status: 'ok',
          prompt,
          info,
          messagePatches,
          req: streamingRequest,
          generationId: generation.generationId,
          generationInfo: generation.generationInfo,
          terminal,
        })
      }

      const settleAborted = (): void => {
        if (observerSuperseded) {
          const error = 'The previous generation observer was replaced by foreground recovery.'
          resolveReadyOnce({ status: 'error', error, reattachOutcome: 'observer_superseded' })
          resolveTerminalOnce({ status: 'error', error, reattachOutcome: 'observer_superseded', warnings })
          clearLiveGenerationProgress(agentPresetSession, postGenerationSession)
          clearHalfStreaming()
          closeTokenStream()
          stopWatchingAbort()
          return
        }
        cancelDurableOnAbort()
        // If a legacy/transport path still settles locally during operation
        // Stop, keep the exact job owned until reconciliation proves terminal.
        if (!operationStopDetached) forgetActiveGenerationJob(durableJobId)
        resolveReadyOnce({ status: 'aborted' })
        resolveTerminalOnce({ status: 'error', error: 'Aborted', ...reattachOutcomeFields('aborted'), warnings })
        clearLiveGenerationProgress(agentPresetSession, postGenerationSession)
        clearHalfStreaming()
        closeTokenStream()
        stopWatchingAbort()
      }

      const settleTransportError = (
        error: string,
        reattachOutcome: GenerationReattachOutcomeStatus = 'retryable_transport_failure',
      ): void => {
        resolveReadyOnce({ status: 'error', error, ...reattachOutcomeFields(reattachOutcome) })
        resolveTerminalOnce({ status: 'error', error, ...reattachOutcomeFields(reattachOutcome), warnings })
        clearLiveGenerationProgress(agentPresetSession, postGenerationSession)
        clearHalfStreaming()
        closeTokenStream()
        stopWatchingAbort()
      }

      let reconnectCycles = 0
      const reconnectDurableStream = async (
        transportError: string,
      ): Promise<
        | { status: 'ok'; opened: Extract<Awaited<ReturnType<typeof openChatResponse>>, { status: 'ok' }> }
        | { status: 'error'; error: string; reattachOutcome: GenerationReattachOutcomeStatus }
        | { status: 'aborted' }
      > => {
        if (!watchesDurableJob || durableJobId.length === 0) {
          return { status: 'error', error: transportError, reattachOutcome: 'retryable_transport_failure' }
        }
        if (reconnectCycles >= MAX_DURABLE_STREAM_RECONNECT_CYCLES) {
          return { status: 'error', error: transportError, reattachOutcome: 'retryable_transport_failure' }
        }
        reconnectCycles += 1

        let lastError = transportError
        let reattachOutcome: GenerationReattachOutcomeStatus = 'retryable_transport_failure'
        for (const delayMs of DURABLE_STREAM_RECONNECT_DELAYS_MS) {
          if (!(await waitForDurableReconnect(delayMs, viewerAbortController.signal))) return { status: 'aborted' }
          const next = await openChatResponse(
            input,
            viewerAbortController.signal,
            authoritativeOperationStream ? undefined : durableJobId,
            authoritativeOperationStream,
            0,
            sourceGeneration,
          )
          if (next.status === 'ok') {
            authoritativeOperationStream = next.operationStream ?? authoritativeOperationStream
            durableJobId = authoritativeOperationStream?.jobId ?? durableJobId
            observeJobId(durableJobId)
            operationLineage = authoritativeOperationStream ?? operationLineage
            // Rebuild from the retained replay window so re-sent deltas do not
            // duplicate text rendered before mobile suspension. A replay_gap
            // frame below makes an incomplete retained window explicit.
            tokenResult = ''
            replayGapPending = false
            if (streamingRequest) streamingRequest.replayGapPending = false
            if (halfStreaming) {
              beginHalfStreaming(streamKey)
            }
            debugServerChat('server-chat-stream-reattached', {
              requestUid: next.requestUid,
              jobId: durableJobId,
              reconnectCycle: reconnectCycles,
            })
            return { status: 'ok', opened: next }
          }
          if (next.status === 'aborted') return next
          lastError = next.error
          reattachOutcome = classifyReattachOpenError(next)
          if (next.retryable === false) break
        }
        return { status: 'error', error: lastError, reattachOutcome }
      }

      void (async () => {
        let activeOpened = opened
        while (true) {
          let transportError = 'stream ended without a done event'
          try {
            for await (const frame of iterateSseEvents(activeOpened.response.body!, viewerAbortController.signal)) {
              if (!isClientSessionGenerationCurrent(sourceGeneration)) {
                settleAborted()
                return
              }
              const event = parsePromptChatSseEvent(frame.event, parseData(frame.data))
              if (!event) continue
              switch (event.type) {
                case 'job_accepted':
                  durableJobId = event.jobId
                  observeJobId(durableJobId)
                  operationLineage = {
                    ...operationLineage,
                    ...(typeof event.operationId === 'string' ? { operationId: event.operationId } : {}),
                    ...(typeof event.acceptedMessageId === 'string'
                      ? { acceptedMessageId: event.acceptedMessageId }
                      : {}),
                    ...(Number.isSafeInteger(event.attemptNo) ? { attemptNo: event.attemptNo as number } : {}),
                    ...(Number.isSafeInteger(event.projectionEpoch)
                      ? { projectionEpoch: event.projectionEpoch as number }
                      : {}),
                  }
                  applyGenerationOperationSseEvent(event, {
                    chatId: input.chatId,
                    mode: input.mode === 'preview' || input.mode === 'preview_prompt' ? undefined : input.mode,
                    ...(input.regenerateMessageId ? { regenerateMessageId: input.regenerateMessageId } : {}),
                  })
                  // Backward-compatible with servers that predate the response
                  // header: an abort may have won the race with this first frame.
                  if (signal?.aborted) cancelDurableOnAbort()
                  debugServerChat('server-chat-job-accepted', {
                    requestUid: activeOpened.requestUid,
                    jobId: durableJobId,
                  })
                  break
                case 'prompt':
                  prompt = omitEventType(event)
                  maybeResolveReady()
                  break
                case 'info':
                  info = omitEventType(event)
                  halfStreaming = info.halfStreaming === true
                  reconcileServerCommandRevision(info)
                  rememberDurableJob()
                  maybeResolveReady()
                  break
                case 'replay_gap':
                  if (event.reason === 'replay_budget_exceeded') {
                    replayGapTruncated = true
                    replayGapPending = true
                    tokenResult = ''
                    if (streamingRequest) {
                      streamingRequest.replayGapTruncated = true
                      streamingRequest.replayGapPending = true
                    }
                    debugServerChat('server-chat-replay-gap', {
                      requestUid: activeOpened.requestUid,
                      jobId: durableJobId,
                      evictedEvents: event.evictedEvents,
                      evictedBytes: event.evictedBytes,
                    })
                  }
                  break
                case 'message_patch':
                  {
                    const signature = JSON.stringify(event.patch)
                    if (!seenMessagePatches.has(signature)) {
                      seenMessagePatches.add(signature)
                      messagePatches.push(event.patch)
                    }
                  }
                  break
                case 'side_effect':
                  {
                    const sideEffect = omitEventType(event)
                    const signature = JSON.stringify(sideEffect)
                    if (!seenSideEffects.has(signature)) {
                      seenSideEffects.add(signature)
                      sideEffects.push(sideEffect)
                    }
                  }
                  break
                case 'agent_preset_progress': {
                  const signature = JSON.stringify(event)
                  if (!seenAgentProgress.has(signature)) {
                    seenAgentProgress.add(signature)
                    updateAgentPresetProgress(agentPresetSession, event)
                  }
                  break
                }
                case 'post_generation_progress': {
                  const signature = JSON.stringify(event)
                  if (!seenPostGenerationProgress.has(signature)) {
                    seenPostGenerationProgress.add(signature)
                    updatePostGenerationProgress(postGenerationSession, event)
                  }
                  break
                }
                case 'warning':
                  {
                    const warning = omitEventType(event)
                    const signature = JSON.stringify(warning)
                    if (seenWarnings.has(signature)) break
                    seenWarnings.add(signature)
                    warnings.push(warning)
                    debugServerChat('server-chat-warning', {
                      requestUid: activeOpened.requestUid,
                      message: event.message,
                      context: event.context,
                    })
                    console.warn(`Server chat warning: ${event.message}`, event.context ?? '')
                    showServerCompatibilityWarning(event)
                  }
                  break
                case 'token': {
                  const content = event.content
                  tokenResult += content
                  if (halfStreaming) {
                    const hasProgress =
                      Number.isFinite(event.generatedTokens) &&
                      (event.generatedTokens ?? 0) > 0 &&
                      Number.isFinite(event.elapsedMs) &&
                      (event.elapsedMs ?? 0) > 0
                    if ((content.length > 0 || hasProgress) && halfStreamingTarget) {
                      recordHalfStreamingToken(halfStreamingTarget, Date.now(), {
                        generatedTokens: event.generatedTokens,
                        elapsedMs: event.elapsedMs,
                      })
                    }
                  } else if (content.length > 0 && !replayGapPending) {
                    enqueueToken({ [streamKey]: tokenResult })
                  }
                  break
                }
                case 'error': {
                  const error = errorMessageFromEvent(
                    event,
                    'Server returned an error without details during generation.',
                  )
                  const restoration = event.restoration
                  const code = truncationConfirmationCode(event.code) ?? truncationConfirmationCode(event.reason)
                  const persistenceDisposition = event.persistenceDisposition
                  const generationProjection = event.generationProjection
                  const retainedResult = event.result
                  const postGeneration = event.postGeneration
                  if (retainedResult !== undefined) {
                    const previousTokenResult = tokenResult
                    tokenResult = retainedResult
                    if (halfStreaming || tokenResult !== previousTokenResult || replayGapPending) {
                      enqueueToken({ [streamKey]: tokenResult })
                    }
                  }
                  if (typeof postGeneration?.revision === 'number') {
                    setCachedServerCommandRevision(postGeneration.revision)
                  }
                  applyGenerationOperationSseEvent({ ...event, jobId: durableJobId })
                  resolveReadyOnce({
                    status: 'error',
                    error,
                    ...reattachOutcomeFields('terminal_failure'),
                    ...(code ? { code } : {}),
                    ...(messagePatches.length > 0 ? { messagePatches } : {}),
                    ...(restoration ? { restoration } : {}),
                  })
                  resolveTerminalOnce({
                    status: 'error',
                    error,
                    ...reattachOutcomeFields('terminal_failure'),
                    restoration,
                    ...(persistenceDisposition ? { persistenceDisposition } : {}),
                    ...(generationProjection ? { generationProjection } : {}),
                    ...(retainedResult !== undefined || postGeneration
                      ? {
                          done: {
                            ...(retainedResult !== undefined ? { result: retainedResult } : {}),
                            ...(postGeneration ? { postGeneration } : {}),
                            ...(typeof info?.generationId === 'string' ? { generationId: info.generationId } : {}),
                            ...(info?.generationInfo ? { generationInfo: info.generationInfo } : {}),
                          },
                        }
                      : {}),
                    sideEffects,
                    warnings,
                  })
                  clearLiveGenerationProgress(agentPresetSession, postGenerationSession)
                  clearHalfStreaming()
                  closeTokenStream()
                  stopWatchingAbort()
                  return
                }
                case 'done':
                  donePayload = omitEventType(event)
                  if (donePayload.terminalSnapshot) {
                    try {
                      const snapshotPayload = await fetchDurableTerminalSnapshot(
                        durableJobId,
                        donePayload.terminalSnapshot,
                        viewerAbortController.signal,
                      )
                      if (!isClientSessionGenerationCurrent(sourceGeneration)) {
                        settleAborted()
                        return
                      }
                      donePayload = { ...snapshotPayload, ...donePayload }
                    } catch (error) {
                      settleTransportError(
                        error instanceof Error ? error.message : String(error),
                        authoritativeOperationStream ? 'authority_reconciliation_required' : 'missing_job',
                      )
                      return
                    }
                  }
                  if (replayGapTruncated && (!prompt || !info)) {
                    const generation = coerceGenerationInfo(info, donePayload)
                    if (generation) {
                      prompt ??= {}
                      info ??= {
                        generationId: generation.generationId,
                        generationInfo: { ...generation.generationInfo },
                        ...(donePayload.halfStreaming === true ? { halfStreaming: true } : {}),
                        ...(donePayload.continueDisposition
                          ? { continueDisposition: donePayload.continueDisposition }
                          : {}),
                        ...(typeof donePayload.continueBase === 'string'
                          ? { continueBase: donePayload.continueBase }
                          : {}),
                      }
                      halfStreaming = info.halfStreaming === true
                      maybeResolveReady()
                    }
                  }
                  const terminalClosesReplayGap = replayGapPending
                  replayGapPending = false
                  if (streamingRequest) streamingRequest.replayGapPending = false
                  applyGenerationOperationSseEvent({ ...event, jobId: durableJobId })
                  const previousTokenResult = tokenResult
                  if (watchesDurableJob && typeof donePayload.result === 'string') {
                    // Durable replay is a lossy token window. Its protected
                    // terminal result is the complete raw snapshot and must win
                    // even when a non-empty replay suffix survived eviction.
                    tokenResult = donePayload.result
                  } else if (typeof donePayload.result === 'string' && tokenResult.length === 0) {
                    // Inline streams retain their negotiated contract: use the
                    // terminal fallback only when no token text was delivered.
                    tokenResult = donePayload.result
                  }
                  const terminalSnapshotChanged = tokenResult !== previousTokenResult
                  if (halfStreaming || terminalSnapshotChanged || terminalClosesReplayGap) {
                    enqueueToken({ [streamKey]: tokenResult })
                  }
                  const terminalOutcome = donePayload.outcome === 'cancelled' ? 'cancelled' : 'completed'
                  // The post-gen pass may have persisted a scriptstate delta and
                  // bumped the revision; reconcile it so the follow-up command POSTs
                  // the right baseRevision.
                  if (typeof donePayload.postGeneration?.revision === 'number') {
                    setCachedServerCommandRevision(donePayload.postGeneration.revision)
                  }
                  if (terminalOutcome === 'completed') {
                    handleServerGeneratedMessageTranslation(input.chatId, donePayload.postGeneration)
                  }
                  maybeResolveReady()
                  if (!readyResolved) {
                    resolveReadyOnce({
                      status: 'error',
                      ...reattachOutcomeFields(terminalOutcome),
                      error: prompt
                        ? 'server chat dispatch did not return generation metadata'
                        : 'stream ended without a prompt event',
                    })
                  }
                  resolveTerminalOnce({
                    status: terminalOutcome === 'cancelled' ? 'cancelled' : 'done',
                    ...reattachOutcomeFields(terminalOutcome),
                    done: donePayload,
                    sideEffects,
                    warnings,
                  })
                  clearLiveGenerationProgress(agentPresetSession, postGenerationSession)
                  closeTokenStream()
                  stopWatchingAbort()
                  return
                default:
                  break
              }
            }
          } catch (err) {
            transportError = err instanceof Error ? err.message : String(err)
          }

          if (consumerDetached) return
          if (observerSuperseded || signal?.aborted || operationStopDetached) {
            settleAborted()
            return
          }

          const reconnected = await reconnectDurableStream(transportError)
          if (reconnected.status === 'ok') {
            activeOpened = reconnected.opened
            continue
          }
          if (reconnected.status === 'aborted') settleAborted()
          else settleTransportError(reconnected.error, reconnected.reattachOutcome)
          return
        }
      })()
    },
    cancel() {
      consumerDetached = true
      tokenStreamInactive = true
      viewerAbortController.abort()
      resolveTerminalOnce({ status: 'error', error: 'Aborted', warnings })
      clearLiveGenerationProgress(agentPresetSession, postGenerationSession)
      clearHalfStreaming()
      stopWatchingAbort()
    },
  })

  return ready
}

registerServerChatRuntime({ cancelServerChatGeneration, retireGenerationJobViewers })
