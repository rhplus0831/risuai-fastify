import { getNodeServerProxyAuth, getNodeServerDiagnosticsAuth } from '../storage/fastifyStorage'
import { captureClientSessionGeneration, isClientSessionGenerationCurrent } from '../clientSession'
import type { Message } from '../storage/database.svelte'
import { activeWriterSessionHeader } from './activeWriterSession'
import { setCachedServerCommandRevision } from './commands'
import { configureStartupTelemetry } from './startupTelemetry'
import { configureClientDiagnostics } from '../diagnostics'
import { configureBrowserDiagnostics, resetBrowserDiagnosticsSession } from './browserDiagnostics'
import {
  isBrowserDiagnosticsConfiguration,
  type BrowserDiagnosticsConfiguration,
} from '@risuai/protocol/remote-diagnostics'
import { isDiagnosticsConfiguration, type DiagnosticsConfiguration } from '@risuai/protocol/diagnostics'
import { isStartupTelemetryConfiguration, type StartupTelemetryConfiguration } from '@risuai/protocol/startup-telemetry'

const BOOTSTRAP_ENDPOINT = '/api/v1/bootstrap'
const WRITER_OBSERVER_SESSION_HEADER = 'risu-writer-observer-session'
export const DISCONNECT_EXISTING_WRITER_HEADER = 'risu-disconnect-existing-writer'
export const EXPECTED_WRITER_EPOCH_HEADER = 'risu-expected-writer-epoch'
export const EXPECTED_DATABASE_LINEAGE_HEADER = 'risu-expected-database-lineage'

export interface BootstrapWriter {
  sessionId: string | null
  epoch: number
}

export interface ActiveGenerationJob {
  chatId: string
  jobId: string
  /**
   * The generating mode of the running job. Lets a reload-resume reattach render
   * a `continue` / `regenerate` on the right row instead of as a fresh send.
   * Absent (treated as `send`) for older server builds.
   */
  mode?: 'send' | 'continue' | 'regenerate'
  /** Append-style legacy boundary or Fastify's in-place extension. */
  continueDisposition?: 'append' | 'extend'
  /** The regenerate target id, present only for `mode === 'regenerate'`. */
  regenerateMessageId?: string
  databaseLineage?: string
  operationId?: string
  writerSessionId?: string
  writerEpoch?: number
  operationStateVersion?: number
  projectionEpoch?: number
  attemptNo?: number
  acceptedMessageId?: string
  targetMessageId?: string
}

export interface ActiveMessageTranslation {
  chatId: string
  messageId: string
  jobId: string
  status: 'running' | 'succeeded' | 'failed'
  error?: string
  completedAt?: number
}

export interface ActiveGreetingTranslation {
  characterId: string
  chatId: string
  greetingIndex: number
  settingsHash: string
  jobId: string
  status: 'running' | 'succeeded' | 'failed'
  error?: string
  completedAt?: number
}

export type GenerationOperationState =
  | 'cancel_requested'
  | 'accepted'
  | 'launching'
  | 'owned_by_job'
  | 'stopping'
  | 'finalizing'
  | 'retryable'
  | 'abandoned'
  | 'completed'
  | 'cancelled'
  | 'terminal_failed'
  | 'invalidated'

export interface GenerationOperationAttemptProjection {
  attemptNo: number
  retryRequestId: string
  jobId: string
  status:
    | 'reserved'
    | 'running'
    | 'stopping'
    | 'finalizing'
    | 'completed'
    | 'cancelled'
    | 'retryable_failed'
    | 'terminal_failed'
    | 'abandoned'
  serverInstanceId: string
  actorWriterSessionId: string
  actorWriterEpoch: number
  launchRevision: number
  providerDispatchStartedAt?: string
  providerDispatchFinishedAt?: string
  runnerSettledAt?: string
  finalizationGenerationId?: string
  failureCode?: string
  lastError?: string
  createdAt?: string
  updatedAt?: string
}

export interface GenerationOperationProjection {
  operationId: string
  protocolVersion: number
  requestOrigin: 'unbound' | 'accepted_send' | 'continue' | 'regenerate' | 'legacy'
  state: GenerationOperationState
  stateVersion: number
  projectionEpoch: number
  creatorWriterSessionId: string
  creatorWriterEpoch: number
  bindingServerInstanceId?: string
  characterId?: string
  chatId?: string
  mode?: 'send' | 'continue' | 'regenerate'
  acceptedMessageId?: string
  targetMessageId?: string
  clientDraftGeneration?: unknown
  acceptedRevision?: number
  currentAttempt?: GenerationOperationAttemptProjection
  desiredTerminalOutcome?: 'completed' | 'cancelled'
  resultMessageId?: string
  failureCode?: string
  failurePhase?: string
  lastError?: string
  providerMayHaveRun: boolean
  cancelRequestedAt?: string
  runnerSettledAt?: string
  terminalAt?: string
  createdAt?: string
  updatedAt?: string
  recoveryDisposition?: 'retryable'
}

export type GenerationEffectKind =
  | 'igp'
  | 'plugin_output'
  | 'generated_translation'
  | 'notification'
  | 'tts'
  | 'completion_sound'
  | 'emotion_image_state'

export interface PendingGenerationEffect {
  ledgerVersion: 1
  databaseLineage: string
  keyType: 'operation' | 'generation'
  keyId: string
  kind: GenerationEffectKind
  effectClass: 'durable' | 'ephemeral' | 'recomputed'
  operationId?: string
  generationId: string
  characterId: string
  chatId: string
  messageId: string
  status: 'pending' | 'claimed'
  claimId?: string
  claimedAt?: string
  leaseExpiresAt?: string
  createdAt: string
  updatedAt: string
}

export type GenerationFinalizationState =
  | 'queued'
  | 'stalled'
  | 'terminal'
  | 'stalled_legacy'
  | 'committed_cleanup_pending'

export type GenerationFinalizationProjectionFence =
  | {
      mode: 'send' | 'continue' | 'regenerate'
      kind: 'tail'
      transcriptLength: number
      tail?: { message: Message }
    }
  | {
      mode: 'send' | 'continue' | 'regenerate'
      kind: 'target-tail'
      transcriptLength: number
      target: { message: Message }
    }

export interface GenerationFinalizationProjection {
  generationId: string
  databaseLineage?: string
  operationId?: string
  operationAttemptNo?: number
  actorWriterSessionId?: string
  actorWriterEpoch?: number
  acceptedMessageId?: string
  terminalOutcome?: 'completed' | 'cancelled'
  chatId: string
  messageId: string
  mode: 'send' | 'continue' | 'regenerate'
  state: GenerationFinalizationState
  failureCount: number
  nextAttemptAt?: string
  provisionalMessage?: Message
  projectionFence?: GenerationFinalizationProjectionFence
}

export interface ServerBootstrapRuntime {
  initialized: boolean
  revision: number
  schemaVersion?: number
  assetBaseUrl?: string
  /** True when this writer already owned the server before registration. */
  requestedWriterWasActive?: boolean
  /** Durable identity of the concrete server database/realm. */
  databaseLineage?: string
  /** Persistent ownership generation, incremented whenever the writer changes. */
  writerEpoch?: number
  /** Explicit current ownership. Missing on legacy servers means unknown, not no owner. */
  writer?: BootstrapWriter
  generationOperationProtocol?: { version: number }
  displaySourceProtocol?: { version: number }
  generationOperationProjectionEpoch?: number
  generationOperations?: GenerationOperationProjection[]
  /**
   * Generations still running server-side, so a reloaded browser can re-attach to
   * the live stream of the open chat instead of only seeing the result after it
   * lands. Empty when none.
   */
  activeGenerationJobs?: ActiveGenerationJob[]
  /** Active-writer-scoped SQLite finalization work, including retained terminal rows. */
  generationFinalizations?: GenerationFinalizationProjection[]
  /** Active-writer-only terminal effects not yet dispatched or permanently skipped. */
  pendingGenerationEffects?: PendingGenerationEffect[]
  /**
   * Message translations still running server-side after a detached request.
   * Used to keep row-level translation spinners and mutation controls stable
   * after reload.
   */
  activeMessageTranslations?: ActiveMessageTranslation[]
  activeGreetingTranslations?: ActiveGreetingTranslation[]
  startupTelemetry?: StartupTelemetryConfiguration
  clientDiagnostics?: DiagnosticsConfiguration
  browserDiagnostics?: BrowserDiagnosticsConfiguration
}

export type ServerBootstrapResult =
  | { status: 'ok'; bootstrap: ServerBootstrapRuntime; requestUid?: string }
  | { status: 'active-writer-connected'; error: 'active_writer_connected'; requestUid?: string }
  | { status: 'error'; error: string; requestUid?: string; httpStatus?: number }
  | { status: 'unavailable' }

type ServerBootstrapReadOnlyResult = Exclude<ServerBootstrapResult, { status: 'active-writer-connected' }>

export function canUseServerBootstrap(): boolean {
  return true
}

export async function fetchServerBootstrap(
  signal?: AbortSignal | null,
  options: { disconnectExistingWriter?: boolean; expectedWriter?: { epoch: number; databaseLineage: string } } = {},
): Promise<ServerBootstrapResult> {
  return fetchServerBootstrapWithMode({
    signal,
    registerActiveWriter: true,
    cacheRevision: true,
    disconnectExistingWriter: options.disconnectExistingWriter === true,
    expectedWriter: options.expectedWriter,
  })
}

export async function fetchServerBootstrapReadOnly(
  signal?: AbortSignal | null,
  options: { cacheRevision?: boolean } = {},
): Promise<ServerBootstrapReadOnlyResult> {
  const result = await fetchServerBootstrapWithMode({
    signal,
    registerActiveWriter: false,
    cacheRevision: options.cacheRevision ?? true,
    disconnectExistingWriter: false,
  })
  if (result.status === 'active-writer-connected') {
    return {
      status: 'error',
      error: 'Unexpected active-writer conflict during read-only bootstrap',
      ...(result.requestUid ? { requestUid: result.requestUid } : {}),
    }
  }
  return result
}

async function fetchServerBootstrapWithMode(input: {
  signal?: AbortSignal | null
  registerActiveWriter: boolean
  cacheRevision: boolean
  disconnectExistingWriter: boolean
  expectedWriter?: { epoch: number; databaseLineage: string }
}): Promise<ServerBootstrapResult> {
  const generation = captureClientSessionGeneration()
  if (!canUseServerBootstrap()) return { status: 'unavailable' }

  const auth = await getNodeServerProxyAuth()
  if (input.registerActiveWriter && (!isClientSessionGenerationCurrent(generation) || input.signal?.aborted)) {
    return { status: 'unavailable' }
  }
  let response: Response
  try {
    response = await fetch(BOOTSTRAP_ENDPOINT, {
      method: 'GET',
      signal: input.signal ?? undefined,
      headers: {
        'risu-auth': auth,
        ...(input.registerActiveWriter
          ? {
              ...activeWriterSessionHeader(),
              ...(input.disconnectExistingWriter ? { [DISCONNECT_EXISTING_WRITER_HEADER]: 'true' } : {}),
              ...(input.expectedWriter
                ? {
                    [EXPECTED_WRITER_EPOCH_HEADER]: String(input.expectedWriter.epoch),
                    [EXPECTED_DATABASE_LINEAGE_HEADER]: input.expectedWriter.databaseLineage,
                  }
                : {}),
            }
          : { [WRITER_OBSERVER_SESSION_HEADER]: activeWriterSessionHeader()['risu-writer-session'] }),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', error: `Network error: ${message}` }
  }
  const requestUid = response.headers.get('X-Request-UID') || undefined

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // HTTP status handling below reports non-JSON failures.
  }

  if (
    response.status === 409 &&
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>).error === 'active_writer_connected'
  ) {
    return {
      status: 'active-writer-connected',
      error: 'active_writer_connected',
      ...(requestUid ? { requestUid } : {}),
    }
  }

  if (!response.ok) {
    if (
      (response.status === 401 || response.status === 403) &&
      isClientSessionGenerationCurrent(generation) &&
      !input.signal?.aborted
    )
      resetBrowserDiagnosticsSession()
    return {
      status: 'error',
      error: errorMessageFromBody(body, `HTTP ${response.status}`),
      httpStatus: response.status,
      ...(requestUid ? { requestUid } : {}),
    }
  }

  if (!body || typeof body !== 'object') {
    return { status: 'error', error: 'Invalid bootstrap response' }
  }

  const record = body as Record<string, unknown>
  if (typeof record.initialized !== 'boolean') {
    return { status: 'error', error: 'Invalid bootstrap initialization state' }
  }
  const revision = record.revision
  if (!Number.isInteger(revision) || (revision as number) < 0) {
    return { status: 'error', error: 'Invalid bootstrap revision' }
  }

  const writer = Object.hasOwn(record, 'writer') ? parseBootstrapWriter(record.writer) : undefined
  if (writer === null || (writer && record.writerEpoch !== undefined && record.writerEpoch !== writer.epoch)) {
    return { status: 'error', error: 'Invalid bootstrap writer metadata', ...(requestUid ? { requestUid } : {}) }
  }

  if (input.cacheRevision && isClientSessionGenerationCurrent(generation) && !input.signal?.aborted) {
    setCachedServerCommandRevision(revision as number)
  }

  const bootstrap: ServerBootstrapRuntime = {
    initialized: record.initialized,
    revision: revision as number,
    schemaVersion: Number.isInteger(record.schemaVersion) ? (record.schemaVersion as number) : undefined,
    assetBaseUrl: typeof record.assetBaseUrl === 'string' ? record.assetBaseUrl : undefined,
    requestedWriterWasActive:
      typeof record.requestedWriterWasActive === 'boolean' ? record.requestedWriterWasActive : undefined,
    databaseLineage: typeof record.databaseLineage === 'string' ? record.databaseLineage : undefined,
    writerEpoch: Number.isSafeInteger(record.writerEpoch) ? (record.writerEpoch as number) : undefined,
    ...(writer ? { writer } : {}),
    generationOperationProtocol: parseGenerationOperationProtocol(record.generationOperationProtocol),
    displaySourceProtocol: parseGenerationOperationProtocol(record.displaySourceProtocol),
    ...(isStartupTelemetryConfiguration(record.startupTelemetry) ? { startupTelemetry: record.startupTelemetry } : {}),
    ...(isDiagnosticsConfiguration(record.clientDiagnostics) ? { clientDiagnostics: record.clientDiagnostics } : {}),
    ...(isBrowserDiagnosticsConfiguration(record.browserDiagnostics)
      ? { browserDiagnostics: record.browserDiagnostics }
      : {}),
    generationOperationProjectionEpoch: isNonNegativeSafeInteger(record.generationOperationProjectionEpoch)
      ? (record.generationOperationProjectionEpoch as number)
      : undefined,
    generationOperations: parseGenerationOperations(record.generationOperations),
    activeGenerationJobs: parseActiveGenerationJobs(record.activeGenerationJobs),
    ...(Array.isArray(record.generationFinalizations)
      ? { generationFinalizations: parseGenerationFinalizations(record.generationFinalizations) }
      : {}),
    ...(Array.isArray(record.pendingGenerationEffects)
      ? { pendingGenerationEffects: parsePendingGenerationEffects(record.pendingGenerationEffects) }
      : {}),
    activeMessageTranslations: parseActiveMessageTranslations(record.activeMessageTranslations),
    activeGreetingTranslations: parseActiveGreetingTranslations(record.activeGreetingTranslations),
  }
  if (isClientSessionGenerationCurrent(generation) && !input.signal?.aborted) {
    const browserUpload = configureBrowserDiagnostics(bootstrap.browserDiagnostics, {
      auth: () => getNodeServerDiagnosticsAuth(),
      databaseLineage: bootstrap.databaseLineage,
    })
    configureStartupTelemetry(browserUpload ? undefined : bootstrap.startupTelemetry)
    configureClientDiagnostics(bootstrap.clientDiagnostics)
  }
  return {
    status: 'ok',
    bootstrap,
    ...(requestUid ? { requestUid } : {}),
  }
}

function parseBootstrapWriter(value: unknown): BootstrapWriter | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { sessionId, epoch } = value as Record<string, unknown>
  if (!isNonNegativeSafeInteger(epoch)) return null
  if (sessionId === null) return { sessionId: null, epoch }
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    sessionId.length > 128 ||
    sessionId.trim() !== sessionId
  )
    return null
  return { sessionId, epoch }
}

function parsePendingGenerationEffects(value: unknown): PendingGenerationEffect[] {
  if (!Array.isArray(value)) return []
  const effects: PendingGenerationEffect[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const kind = record.kind
    const effectClass = record.effectClass
    if (
      record.ledgerVersion !== 1 ||
      typeof record.databaseLineage !== 'string' ||
      (record.keyType !== 'operation' && record.keyType !== 'generation') ||
      typeof record.keyId !== 'string' ||
      (kind !== 'igp' &&
        kind !== 'plugin_output' &&
        kind !== 'generated_translation' &&
        kind !== 'notification' &&
        kind !== 'tts' &&
        kind !== 'completion_sound' &&
        kind !== 'emotion_image_state') ||
      (effectClass !== 'durable' && effectClass !== 'ephemeral' && effectClass !== 'recomputed') ||
      typeof record.generationId !== 'string' ||
      typeof record.characterId !== 'string' ||
      typeof record.chatId !== 'string' ||
      typeof record.messageId !== 'string' ||
      (record.status !== 'pending' && record.status !== 'claimed') ||
      typeof record.createdAt !== 'string' ||
      typeof record.updatedAt !== 'string'
    ) {
      continue
    }
    effects.push({
      ledgerVersion: 1,
      databaseLineage: record.databaseLineage,
      keyType: record.keyType,
      keyId: record.keyId,
      kind,
      effectClass,
      ...(typeof record.operationId === 'string' ? { operationId: record.operationId } : {}),
      generationId: record.generationId,
      characterId: record.characterId,
      chatId: record.chatId,
      messageId: record.messageId,
      status: record.status,
      ...(typeof record.claimId === 'string' ? { claimId: record.claimId } : {}),
      ...(typeof record.claimedAt === 'string' ? { claimedAt: record.claimedAt } : {}),
      ...(typeof record.leaseExpiresAt === 'string' ? { leaseExpiresAt: record.leaseExpiresAt } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })
  }
  return effects
}

function parseGenerationOperationProtocol(value: unknown): { version: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const version = (value as Record<string, unknown>).version
  return isPositiveSafeInteger(version) ? { version: version as number } : undefined
}

export function parseGenerationOperations(value: unknown): GenerationOperationProjection[] {
  if (!Array.isArray(value)) return []
  const operations: GenerationOperationProjection[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (
      typeof record.operationId !== 'string' ||
      !isNonNegativeSafeInteger(record.protocolVersion) ||
      !isGenerationOperationRequestOrigin(record.requestOrigin) ||
      !isGenerationOperationState(record.state) ||
      !isPositiveSafeInteger(record.stateVersion) ||
      !isPositiveSafeInteger(record.projectionEpoch) ||
      typeof record.creatorWriterSessionId !== 'string' ||
      !isNonNegativeSafeInteger(record.creatorWriterEpoch) ||
      typeof record.providerMayHaveRun !== 'boolean'
    ) {
      continue
    }
    const operation: GenerationOperationProjection = {
      operationId: record.operationId,
      protocolVersion: record.protocolVersion as number,
      requestOrigin: record.requestOrigin,
      state: record.state,
      stateVersion: record.stateVersion as number,
      projectionEpoch: record.projectionEpoch as number,
      creatorWriterSessionId: record.creatorWriterSessionId,
      creatorWriterEpoch: record.creatorWriterEpoch as number,
      providerMayHaveRun: record.providerMayHaveRun,
    }
    for (const field of [
      'bindingServerInstanceId',
      'characterId',
      'chatId',
      'acceptedMessageId',
      'targetMessageId',
      'resultMessageId',
      'failureCode',
      'failurePhase',
      'lastError',
      'cancelRequestedAt',
      'runnerSettledAt',
      'terminalAt',
      'createdAt',
      'updatedAt',
    ] as const) {
      if (typeof record[field] === 'string') operation[field] = record[field]
    }
    if (record.mode === 'send' || record.mode === 'continue' || record.mode === 'regenerate') {
      operation.mode = record.mode
    }
    if (Object.hasOwn(record, 'clientDraftGeneration')) {
      operation.clientDraftGeneration = structuredClone(record.clientDraftGeneration)
    }
    if (isNonNegativeSafeInteger(record.acceptedRevision))
      operation.acceptedRevision = record.acceptedRevision as number
    if (record.desiredTerminalOutcome === 'completed' || record.desiredTerminalOutcome === 'cancelled') {
      operation.desiredTerminalOutcome = record.desiredTerminalOutcome
    }
    if (record.recoveryDisposition === 'retryable') operation.recoveryDisposition = 'retryable'
    const currentAttempt = parseGenerationOperationAttempt(record.currentAttempt)
    if (currentAttempt) operation.currentAttempt = currentAttempt
    operations.push(operation)
  }
  return operations
}

function parseGenerationOperationAttempt(value: unknown): GenerationOperationAttemptProjection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    !isPositiveSafeInteger(record.attemptNo) ||
    typeof record.retryRequestId !== 'string' ||
    typeof record.jobId !== 'string' ||
    !isGenerationOperationAttemptStatus(record.status) ||
    typeof record.serverInstanceId !== 'string' ||
    typeof record.actorWriterSessionId !== 'string' ||
    !isNonNegativeSafeInteger(record.actorWriterEpoch) ||
    !isNonNegativeSafeInteger(record.launchRevision)
  ) {
    return undefined
  }
  const attempt: GenerationOperationAttemptProjection = {
    attemptNo: record.attemptNo as number,
    retryRequestId: record.retryRequestId,
    jobId: record.jobId,
    status: record.status,
    serverInstanceId: record.serverInstanceId,
    actorWriterSessionId: record.actorWriterSessionId,
    actorWriterEpoch: record.actorWriterEpoch as number,
    launchRevision: record.launchRevision as number,
  }
  for (const field of [
    'providerDispatchStartedAt',
    'providerDispatchFinishedAt',
    'runnerSettledAt',
    'finalizationGenerationId',
    'failureCode',
    'lastError',
    'createdAt',
    'updatedAt',
  ] as const) {
    if (typeof record[field] === 'string') attempt[field] = record[field]
  }
  return attempt
}

function isGenerationOperationAttemptStatus(value: unknown): value is GenerationOperationAttemptProjection['status'] {
  return (
    value === 'reserved' ||
    value === 'running' ||
    value === 'stopping' ||
    value === 'finalizing' ||
    value === 'completed' ||
    value === 'cancelled' ||
    value === 'retryable_failed' ||
    value === 'terminal_failed' ||
    value === 'abandoned'
  )
}

function isGenerationOperationRequestOrigin(value: unknown): value is GenerationOperationProjection['requestOrigin'] {
  return (
    value === 'unbound' ||
    value === 'accepted_send' ||
    value === 'continue' ||
    value === 'regenerate' ||
    value === 'legacy'
  )
}

function isGenerationOperationState(value: unknown): value is GenerationOperationState {
  return (
    value === 'cancel_requested' ||
    value === 'accepted' ||
    value === 'launching' ||
    value === 'owned_by_job' ||
    value === 'stopping' ||
    value === 'finalizing' ||
    value === 'retryable' ||
    value === 'abandoned' ||
    value === 'completed' ||
    value === 'cancelled' ||
    value === 'terminal_failed' ||
    value === 'invalidated'
  )
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function parseGenerationFinalizations(value: unknown): GenerationFinalizationProjection[] {
  if (!Array.isArray(value)) return []
  const finalizations: GenerationFinalizationProjection[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (
      typeof record.generationId !== 'string' ||
      record.generationId.length === 0 ||
      typeof record.chatId !== 'string' ||
      record.chatId.length === 0 ||
      typeof record.messageId !== 'string' ||
      record.messageId.length === 0 ||
      (record.mode !== 'send' && record.mode !== 'continue' && record.mode !== 'regenerate') ||
      (record.state !== 'queued' &&
        record.state !== 'stalled' &&
        record.state !== 'terminal' &&
        record.state !== 'stalled_legacy' &&
        record.state !== 'committed_cleanup_pending') ||
      !Number.isSafeInteger(record.failureCount) ||
      (record.failureCount as number) < 0
    ) {
      continue
    }
    const finalization: GenerationFinalizationProjection = {
      generationId: record.generationId,
      chatId: record.chatId,
      messageId: record.messageId,
      mode: record.mode,
      state: record.state,
      failureCount: record.failureCount as number,
      ...(typeof record.nextAttemptAt === 'string' && !Number.isNaN(Date.parse(record.nextAttemptAt))
        ? { nextAttemptAt: record.nextAttemptAt }
        : {}),
      ...(record.provisionalMessage &&
      typeof record.provisionalMessage === 'object' &&
      !Array.isArray(record.provisionalMessage)
        ? { provisionalMessage: record.provisionalMessage as Message }
        : {}),
      ...(parseGenerationFinalizationProjectionFence(record.projectionFence)
        ? { projectionFence: parseGenerationFinalizationProjectionFence(record.projectionFence)! }
        : {}),
    }
    for (const field of ['databaseLineage', 'operationId', 'actorWriterSessionId', 'acceptedMessageId'] as const) {
      if (typeof record[field] === 'string') finalization[field] = record[field]
    }
    if (isPositiveSafeInteger(record.operationAttemptNo)) {
      finalization.operationAttemptNo = record.operationAttemptNo as number
    }
    if (isNonNegativeSafeInteger(record.actorWriterEpoch)) {
      finalization.actorWriterEpoch = record.actorWriterEpoch as number
    }
    if (record.terminalOutcome === 'completed' || record.terminalOutcome === 'cancelled') {
      finalization.terminalOutcome = record.terminalOutcome
    }
    finalizations.push(finalization)
  }
  return finalizations
}

function parseGenerationFinalizationProjectionFence(value: unknown): GenerationFinalizationProjectionFence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    (record.mode !== 'send' && record.mode !== 'continue' && record.mode !== 'regenerate') ||
    !Number.isSafeInteger(record.transcriptLength) ||
    (record.transcriptLength as number) < 0
  ) {
    return undefined
  }
  if (record.kind === 'tail') {
    const tail = parseGenerationFinalizationSnapshotRow(record.tail)
    return {
      mode: record.mode,
      kind: 'tail',
      transcriptLength: record.transcriptLength as number,
      ...(tail ? { tail } : {}),
    }
  }
  if (record.kind === 'target-tail') {
    const target = parseGenerationFinalizationSnapshotRow(record.target)
    if (!target) return undefined
    return {
      mode: record.mode,
      kind: 'target-tail',
      transcriptLength: record.transcriptLength as number,
      target,
    }
  }
  return undefined
}

function parseGenerationFinalizationSnapshotRow(value: unknown): { message: Message } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const message = (value as Record<string, unknown>).message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
  return { message: message as Message }
}

function parseActiveGreetingTranslations(value: unknown): ActiveGreetingTranslation[] {
  if (!Array.isArray(value)) return []
  const jobs: ActiveGreetingTranslation[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (
      typeof record.characterId !== 'string' ||
      typeof record.chatId !== 'string' ||
      !Number.isInteger(record.greetingIndex) ||
      (record.greetingIndex as number) < -1 ||
      typeof record.settingsHash !== 'string' ||
      typeof record.jobId !== 'string' ||
      record.jobId.length === 0
    ) {
      continue
    }
    const status =
      record.status === 'succeeded' || record.status === 'failed' || record.status === 'running'
        ? record.status
        : 'running'
    const job: ActiveGreetingTranslation = {
      characterId: record.characterId,
      chatId: record.chatId,
      greetingIndex: record.greetingIndex as number,
      settingsHash: record.settingsHash,
      jobId: record.jobId,
      status,
    }
    if (status === 'failed' && typeof record.error === 'string') job.error = record.error
    if (status !== 'running' && typeof record.completedAt === 'number' && Number.isFinite(record.completedAt)) {
      job.completedAt = record.completedAt
    }
    jobs.push(job)
  }
  return jobs
}

function parseActiveMessageTranslations(value: unknown): ActiveMessageTranslation[] {
  if (!Array.isArray(value)) return []
  const jobs: ActiveMessageTranslation[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (typeof record.chatId !== 'string' || typeof record.messageId !== 'string') continue
    const status =
      record.status === 'succeeded' || record.status === 'failed' || record.status === 'running'
        ? record.status
        : 'running'
    const job: ActiveMessageTranslation = {
      chatId: record.chatId,
      messageId: record.messageId,
      jobId:
        typeof record.jobId === 'string' && record.jobId.length > 0
          ? record.jobId
          : `legacy:${record.chatId}:${record.messageId}`,
      status,
    }
    if (status === 'failed' && typeof record.error === 'string') job.error = record.error
    if (status !== 'running' && typeof record.completedAt === 'number' && Number.isFinite(record.completedAt)) {
      job.completedAt = record.completedAt
    }
    jobs.push(job)
  }
  return jobs
}

function parseActiveGenerationJobs(value: unknown): ActiveGenerationJob[] {
  if (!Array.isArray(value)) return []
  const jobs: ActiveGenerationJob[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (typeof record.chatId === 'string' && typeof record.jobId === 'string') {
      const job: ActiveGenerationJob = { chatId: record.chatId, jobId: record.jobId }
      if (record.mode === 'send' || record.mode === 'continue' || record.mode === 'regenerate') {
        job.mode = record.mode
      }
      if (typeof record.regenerateMessageId === 'string') {
        job.regenerateMessageId = record.regenerateMessageId
      }
      for (const field of [
        'databaseLineage',
        'operationId',
        'writerSessionId',
        'acceptedMessageId',
        'targetMessageId',
      ] as const) {
        if (typeof record[field] === 'string') job[field] = record[field]
      }
      for (const field of ['writerEpoch', 'operationStateVersion', 'projectionEpoch', 'attemptNo'] as const) {
        if (isNonNegativeSafeInteger(record[field])) job[field] = record[field] as number
      }
      jobs.push(job)
    }
  }
  return jobs
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (typeof record.error === 'string') return record.error
    if (typeof record.reason === 'string') return record.reason
  }
  return fallback
}
