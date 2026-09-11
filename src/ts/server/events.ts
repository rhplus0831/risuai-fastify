import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import { iterateSseEvents } from '../process/request/sseParse'
import type { CommandEvent } from './commands'
import type {
  ServerHypaV3ProgressPayload,
  ServerMemoryJob,
  ServerMemoryJobKind,
  ServerMemoryJobStatus,
} from '../process/request/serverMemory'
import { activeWriterSessionHeader, isWriterAccessLost } from './activeWriterSession'
import type { BardWikiJobSummary } from '@risuai/protocol'
import type { ServerBardWikiJobEvent } from './bardWikiJobEvents'
import {
  canUseClientReadServices,
  canUseClientRecoveryAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
  isClientSessionManaged,
} from '../clientSession'

const EVENTS_ENDPOINT = '/api/v1/events'
export const SERVER_EVENT_CONNECT_TIMEOUT_MS = 30_000
const EVENT_CONNECTION_CANCELLED = Symbol('event-connection-cancelled')

export type ServerCommandEventHandler = (event: CommandEvent) => void

export interface ServerMemoryJobEvent {
  type: 'memory.job'
  streamId: string
  version: number
  chatId: string
  job: Omit<ServerMemoryJob, 'chatId'>
  sideEffect?: {
    kind: 'hypav3_progress'
    payload: ServerHypaV3ProgressPayload
  }
}

export type ServerMemoryEvent = ServerMemoryJobEvent
export type ServerMemoryEventHandler = (event: ServerMemoryEvent) => void

export interface ServerMemoryJobSnapshot {
  type: 'memory.snapshot'
  streamId: string
  version: number
  jobs: ServerMemoryJob[]
  bardWikiJobs: BardWikiJobSummary[]
}

export type ServerMemorySnapshotHandler = (snapshot: ServerMemoryJobSnapshot) => void

export interface ServerWriterEvent {
  /** Present on current servers; absent only for compatibility with older event streams. */
  databaseLineage?: string
  sessionId: string | null
  epoch: number
}

export type ServerWriterEventHandler = (event: ServerWriterEvent) => void

export interface SubscribeServerCommandEventsInput {
  /** Reader streams never register a connected writer session. */
  mode?: 'reader' | 'writer'
  onCommandEvent: ServerCommandEventHandler
  onMemoryEvent?: ServerMemoryEventHandler
  onBardWikiEvent?: (event: ServerBardWikiJobEvent) => void
  onMemorySnapshot?: ServerMemorySnapshotHandler
  onWriterEvent?: ServerWriterEventHandler
  onFrame?: (frame: { event: string; data: string; id?: string }) => void
  onError?: (error: string) => void
  onClose?: () => void
  sinceRevision?: number | null
  signal?: AbortSignal | null
}

export type ServerCommandEventSubscriptionResult =
  | { status: 'ok'; unsubscribe: () => void }
  | { status: 'error'; error: string; httpStatus?: number }
  | {
      status: 'replay-unavailable'
      error: string
      currentRevision: number
      oldestRevision?: number
      latestRevision?: number
    }
  | { status: 'unavailable' }

export function canUseServerEvents(): boolean {
  return !isWriterAccessLost()
}

export async function subscribeServerCommandEvents(
  input: SubscribeServerCommandEventsInput,
): Promise<ServerCommandEventSubscriptionResult> {
  const generation = captureClientSessionGeneration()
  if (input.mode === 'reader' ? !canUseClientReadServices() : !canUseServerEvents() || !canUseClientRecoveryAccess())
    return { status: 'unavailable' }

  const controller = new AbortController()
  let stopped = false
  let connectTimedOut = false
  let resolveConnectionCancelled!: (value: typeof EVENT_CONNECTION_CANCELLED) => void
  const connectionCancelled = new Promise<typeof EVENT_CONNECTION_CANCELLED>((resolve) => {
    resolveConnectionCancelled = resolve
  })
  const stop = (): void => {
    stopped = true
    controller.abort()
    resolveConnectionCancelled(EVENT_CONNECTION_CANCELLED)
  }
  const connectDeadline = setTimeout(() => {
    connectTimedOut = true
    stop()
  }, SERVER_EVENT_CONNECT_TIMEOUT_MS)
  const clearConnectDeadline = () => clearTimeout(connectDeadline)
  const cancelledConnectionResult = (): ServerCommandEventSubscriptionResult =>
    connectTimedOut ? { status: 'error', error: 'Event stream connection timed out' } : { status: 'unavailable' }

  if (input.signal) {
    if (input.signal.aborted) {
      stop()
    } else {
      input.signal.addEventListener('abort', stop, { once: true })
    }
  }

  let auth: string
  try {
    const result = await Promise.race([getNodeServerProxyAuth(), connectionCancelled])
    if (result === EVENT_CONNECTION_CANCELLED) {
      clearConnectDeadline()
      input.signal?.removeEventListener('abort', stop)
      return cancelledConnectionResult()
    }
    auth = result
  } catch (err) {
    clearConnectDeadline()
    input.signal?.removeEventListener('abort', stop)
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', error: `Network error: ${message}` }
  }
  if (stopped || !isClientSessionGenerationCurrent(generation)) {
    clearConnectDeadline()
    input.signal?.removeEventListener('abort', stop)
    return { status: 'unavailable' }
  }
  const headers: Record<string, string> = {
    'risu-auth': auth,
    ...(input.mode === 'reader' ? {} : activeWriterSessionHeader()),
  }
  const sinceRevision =
    Number.isInteger(input.sinceRevision) && (input.sinceRevision as number) >= 0
      ? (input.sinceRevision as number)
      : null
  const endpoint =
    sinceRevision === null
      ? EVENTS_ENDPOINT
      : `${EVENTS_ENDPOINT}?sinceRevision=${encodeURIComponent(String(sinceRevision))}`
  if (sinceRevision !== null) {
    headers['Last-Event-ID'] = String(sinceRevision)
  }

  let response: Response
  try {
    const result = await Promise.race([
      fetch(endpoint, {
        method: 'GET',
        signal: controller.signal,
        headers,
      }),
      connectionCancelled,
    ])
    if (result === EVENT_CONNECTION_CANCELLED) {
      clearConnectDeadline()
      input.signal?.removeEventListener('abort', stop)
      return cancelledConnectionResult()
    }
    response = result
  } catch (err) {
    clearConnectDeadline()
    if (input.signal) input.signal.removeEventListener('abort', stop)
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', error: `Network error: ${message}` }
  }

  if (response.status === 409) {
    const result = await Promise.race([parseReplayUnavailableResponse(response), connectionCancelled])
    if (result === EVENT_CONNECTION_CANCELLED) {
      clearConnectDeadline()
      input.signal?.removeEventListener('abort', stop)
      return cancelledConnectionResult()
    }
    const replayError = result
    clearConnectDeadline()
    input.signal?.removeEventListener('abort', stop)
    if (replayError) return replayError
  }

  if (!response.ok) {
    clearConnectDeadline()
    if (input.signal) input.signal.removeEventListener('abort', stop)
    return {
      status: 'error',
      error: `HTTP ${response.status}`,
      ...(input.mode === 'reader' || isClientSessionManaged() ? { httpStatus: response.status } : {}),
    }
  }

  if (!response.body) {
    clearConnectDeadline()
    if (input.signal) input.signal.removeEventListener('abort', stop)
    return { status: 'error', error: 'Event stream response has no body' }
  }

  clearConnectDeadline()

  void (async () => {
    let completed = false
    try {
      for await (const frame of iterateSseEvents(response.body!, controller.signal)) {
        if (stopped) continue
        input.onFrame?.(frame)
        if (frame.event === 'command') {
          const event = parseCommandEvent(frame.data)
          if (!event) {
            throw new Error('Malformed command event frame')
          }
          input.onCommandEvent(event)
        } else if (frame.event === 'memory') {
          const event = parseMemoryEvent(frame.data)
          if (event) {
            input.onMemoryEvent?.(event)
          } else {
            const bardWikiEvent = parseBardWikiJobEvent(frame.data)
            if (bardWikiEvent) input.onBardWikiEvent?.(bardWikiEvent)
          }
        } else if (frame.event === 'memory_snapshot') {
          const snapshot = parseMemorySnapshot(frame.data)
          if (snapshot) input.onMemorySnapshot?.(snapshot)
        } else if (frame.event === 'writer') {
          const event = parseWriterEvent(frame.data)
          if (event) input.onWriterEvent?.(event)
        }
      }
      completed = true
    } catch (err) {
      if (!stopped && !controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err)
        input.onError?.(`Event stream error: ${message}`)
      }
    } finally {
      if (completed && !stopped && !controller.signal.aborted) {
        input.onClose?.()
      }
      if (input.signal) input.signal.removeEventListener('abort', stop)
    }
  })()

  return {
    status: 'ok',
    unsubscribe: stop,
  }
}

function parseWriterEvent(data: string): ServerWriterEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (
    record.sessionId !== null &&
    (typeof record.sessionId !== 'string' ||
      record.sessionId.trim() !== record.sessionId ||
      record.sessionId.length === 0 ||
      record.sessionId.length > 128)
  ) {
    return null
  }
  if (!Number.isSafeInteger(record.epoch) || (record.epoch as number) < 0) return null
  if (
    record.databaseLineage !== undefined &&
    (typeof record.databaseLineage !== 'string' || record.databaseLineage.length === 0)
  )
    return null
  return {
    ...(typeof record.databaseLineage === 'string' ? { databaseLineage: record.databaseLineage } : {}),
    sessionId: record.sessionId as string | null,
    epoch: record.epoch as number,
  }
}

async function parseReplayUnavailableResponse(
  response: Response,
): Promise<Extract<ServerCommandEventSubscriptionResult, { status: 'replay-unavailable' }> | null> {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (record.error !== 'event_replay_unavailable') return null
  if (!Number.isInteger(record.currentRevision) || (record.currentRevision as number) < 0) {
    return null
  }

  return {
    status: 'replay-unavailable',
    error: 'event_replay_unavailable',
    currentRevision: record.currentRevision as number,
    ...(Number.isInteger(record.oldestRevision) ? { oldestRevision: record.oldestRevision as number } : {}),
    ...(Number.isInteger(record.latestRevision) ? { latestRevision: record.latestRevision as number } : {}),
  }
}

function parseMemoryEvent(data: string): ServerMemoryEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (record.type !== 'memory.job') return null
  if (typeof record.streamId !== 'string' || record.streamId.length === 0) return null
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 0) return null
  if (typeof record.chatId !== 'string') return null
  if (!record.job || typeof record.job !== 'object' || Array.isArray(record.job)) return null
  const jobRecord = record.job as Record<string, unknown>
  if (typeof jobRecord.id !== 'string') return null
  if (typeof jobRecord.instanceId !== 'string' || jobRecord.instanceId.length === 0) return null
  if (!isMemoryJobKind(jobRecord.kind)) return null
  if (!isMemoryJobStatus(jobRecord.status)) return null
  if (!Number.isInteger(jobRecord.attemptCount) || (jobRecord.attemptCount as number) < 0) return null
  if (!Number.isInteger(jobRecord.maxAttempts) || (jobRecord.maxAttempts as number) <= 0) return null

  const event: ServerMemoryJobEvent = {
    type: 'memory.job',
    streamId: record.streamId,
    version: record.version as number,
    chatId: record.chatId,
    job: {
      id: jobRecord.id,
      instanceId: jobRecord.instanceId,
      kind: jobRecord.kind,
      status: jobRecord.status,
      attemptCount: jobRecord.attemptCount as number,
      maxAttempts: jobRecord.maxAttempts as number,
      ...(jobRecord.error === null
        ? { error: null }
        : typeof jobRecord.error === 'string'
          ? { error: jobRecord.error }
          : {}),
      ...(typeof jobRecord.updatedAt === 'string' ? { updatedAt: jobRecord.updatedAt } : {}),
    },
  }

  if (record.sideEffect !== undefined) {
    const sideEffect = parseMemorySideEffect(record.sideEffect)
    if (!sideEffect) return null
    event.sideEffect = sideEffect
  }

  return event
}

function parseMemorySnapshot(data: string): ServerMemoryJobSnapshot | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.type !== 'memory.snapshot') return null
  if (typeof record.streamId !== 'string' || record.streamId.length === 0) return null
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 0) return null
  if (!Array.isArray(record.jobs)) return null
  const jobs: ServerMemoryJob[] = []
  for (const value of record.jobs) {
    const job = parseMemorySnapshotJob(value)
    if (!job) return null
    jobs.push(job)
  }
  const bardWikiJobs: BardWikiJobSummary[] = []
  if (record.bardWikiJobs !== undefined) {
    if (!Array.isArray(record.bardWikiJobs)) return null
    for (const value of record.bardWikiJobs) {
      const job = parseBardWikiSnapshotJob(value)
      if (!job) return null
      bardWikiJobs.push(job)
    }
  }
  return {
    type: 'memory.snapshot',
    streamId: record.streamId,
    version: record.version as number,
    jobs,
    bardWikiJobs,
  }
}

function parseBardWikiJobEvent(data: string): ServerBardWikiJobEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.type !== 'bardwiki.job') return null
  if (typeof record.streamId !== 'string' || record.streamId.length === 0) return null
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 0) return null
  if (typeof record.chatId !== 'string' || record.chatId.length === 0) return null
  const job = parseBardWikiEventJob(record.job)
  if (!job) return null
  return {
    type: 'bardwiki.job',
    streamId: record.streamId,
    version: record.version as number,
    chatId: record.chatId,
    job,
  }
}

function parseBardWikiEventJob(value: unknown): ServerBardWikiJobEvent['job'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!isBardWikiJobCore(record, false)) return null
  if (typeof record.updatedAt !== 'string') return null
  return {
    id: record.id,
    instanceId: record.instanceId,
    receiptId: record.receiptId,
    kind: record.kind,
    status: record.status,
    errorCode: record.errorCode === undefined ? null : record.errorCode,
    errorSummary: record.errorSummary === undefined ? null : record.errorSummary,
    attemptCount: record.attemptCount,
    maxAttempts: record.maxAttempts,
    progressCurrent: record.progressCurrent === undefined ? null : record.progressCurrent,
    progressTotal: record.progressTotal === undefined ? null : record.progressTotal,
    updatedAt: record.updatedAt,
  }
}

function parseBardWikiSnapshotJob(value: unknown): BardWikiJobSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    !isBardWikiJobCore(record, true) ||
    typeof record.chatId !== 'string' ||
    (record.errorCode !== null && typeof record.errorCode !== 'string') ||
    (record.errorSummary !== null && typeof record.errorSummary !== 'string')
  ) {
    return null
  }
  if (
    typeof record.nextRunAt !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return null
  }
  return {
    id: record.id,
    instanceId: record.instanceId,
    chatId: record.chatId,
    receiptId: record.receiptId,
    kind: record.kind,
    status: record.status,
    errorCode: record.errorCode,
    errorSummary: record.errorSummary,
    attemptCount: record.attemptCount,
    maxAttempts: record.maxAttempts,
    progressCurrent: record.progressCurrent === undefined ? null : record.progressCurrent,
    progressTotal: record.progressTotal === undefined ? null : record.progressTotal,
    nextRunAt: record.nextRunAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function isBardWikiJobCore(
  record: Record<string, unknown>,
  requireChatId: boolean,
): record is Record<string, unknown> & {
  id: string
  instanceId: string
  chatId?: string
  receiptId: string | null
  kind: BardWikiJobSummary['kind']
  status: BardWikiJobSummary['status']
  errorCode?: string | null
  errorSummary?: string | null
  attemptCount: number
  maxAttempts: number
  progressCurrent?: number | null
  progressTotal?: number | null
} {
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.instanceId === 'string' &&
    record.instanceId.length > 0 &&
    (!requireChatId || (typeof record.chatId === 'string' && record.chatId.length > 0)) &&
    (record.receiptId === null || (typeof record.receiptId === 'string' && record.receiptId.length > 0)) &&
    (record.kind === 'apply_turn' || record.kind === 'reconcile_receipt' || record.kind === 'rebuild_chat') &&
    (record.status === 'pending' ||
      record.status === 'running' ||
      record.status === 'completed' ||
      record.status === 'failed' ||
      record.status === 'cancelled') &&
    (record.errorCode === undefined || record.errorCode === null || typeof record.errorCode === 'string') &&
    (record.errorSummary === undefined || record.errorSummary === null || typeof record.errorSummary === 'string') &&
    Number.isInteger(record.attemptCount) &&
    (record.attemptCount as number) >= 0 &&
    Number.isInteger(record.maxAttempts) &&
    (record.maxAttempts as number) > 0 &&
    (record.progressCurrent === undefined ||
      record.progressCurrent === null ||
      (Number.isInteger(record.progressCurrent) && (record.progressCurrent as number) >= 0)) &&
    (record.progressTotal === undefined ||
      record.progressTotal === null ||
      (Number.isInteger(record.progressTotal) && (record.progressTotal as number) >= 0))
  )
}

function parseMemorySnapshotJob(value: unknown): ServerMemoryJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.length === 0) return null
  if (typeof record.instanceId !== 'string' || record.instanceId.length === 0) return null
  if (typeof record.chatId !== 'string' || record.chatId.length === 0) return null
  if (!isMemoryJobKind(record.kind) || !isMemoryJobStatus(record.status)) return null
  if (record.status !== 'pending' && record.status !== 'running') return null
  if (!Number.isInteger(record.attemptCount) || (record.attemptCount as number) < 0) return null
  if (!Number.isInteger(record.maxAttempts) || (record.maxAttempts as number) <= 0) return null
  if (typeof record.updatedAt !== 'string') return null
  return {
    id: record.id,
    instanceId: record.instanceId,
    chatId: record.chatId,
    kind: record.kind,
    status: record.status,
    attemptCount: record.attemptCount as number,
    maxAttempts: record.maxAttempts as number,
    updatedAt: record.updatedAt,
  }
}

function parseMemorySideEffect(value: unknown): ServerMemoryJobEvent['sideEffect'] | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.kind !== 'hypav3_progress') return null
  if (!isHypaV3ProgressPayload(record.payload)) return null
  return {
    kind: 'hypav3_progress',
    payload: record.payload,
  }
}

function isHypaV3ProgressPayload(value: unknown): value is ServerHypaV3ProgressPayload {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.open !== 'boolean') return false
  if (typeof record.miniMsg !== 'string') return false
  if (typeof record.msg !== 'string') return false
  if (typeof record.subMsg !== 'string') return false
  if (record.status !== undefined && !isMemoryJobStatus(record.status)) return false
  if (record.queuedCount !== undefined && !Number.isInteger(record.queuedCount)) return false
  return true
}

function isMemoryJobKind(value: unknown): value is ServerMemoryJobKind {
  return value === 'chunk' || value === 'embed' || value === 'summarize'
}

function isMemoryJobStatus(value: unknown): value is ServerMemoryJobStatus {
  return (
    value === 'pending' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled'
  )
}

function parseCommandEvent(data: string): CommandEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (typeof record.type !== 'string') return null
  if (!Number.isInteger(record.revision) || (record.revision as number) < 0) return null
  if (typeof record.resource !== 'string') return null
  if (record.id !== undefined && typeof record.id !== 'string') return null
  if (record.parentId !== undefined && typeof record.parentId !== 'string') return null
  if (record.databaseLineage !== undefined && typeof record.databaseLineage !== 'string') return null
  if (record.operationId !== undefined && typeof record.operationId !== 'string') return null
  if (record.sourceMessageId !== undefined && typeof record.sourceMessageId !== 'string') return null
  if (record.jobId !== undefined && typeof record.jobId !== 'string') return null
  if (record.origin !== undefined && !isCommandEventOrigin(record.origin)) return null

  return {
    type: record.type,
    revision: record.revision as number,
    resource: record.resource,
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.parentId === 'string' ? { parentId: record.parentId } : {}),
    ...(typeof record.databaseLineage === 'string' ? { databaseLineage: record.databaseLineage } : {}),
    ...(typeof record.operationId === 'string' ? { operationId: record.operationId } : {}),
    ...(typeof record.sourceMessageId === 'string' ? { sourceMessageId: record.sourceMessageId } : {}),
    ...(typeof record.jobId === 'string' ? { jobId: record.jobId } : {}),
    ...(isCommandEventOrigin(record.origin) ? { origin: record.origin } : {}),
  }
}

function isCommandEventOrigin(value: unknown): value is { writerSessionId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const writerSessionId = (value as { writerSessionId?: unknown }).writerSessionId
  return typeof writerSessionId === 'string' && writerSessionId.trim() !== ''
}
