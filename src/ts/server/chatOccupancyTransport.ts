import {
  CHAT_OCCUPANCY_EPOCH_HEADER,
  CHAT_OCCUPANCY_NORMALIZE_ENDPOINT,
  CHAT_OCCUPANCY_PROTOCOL_VERSION,
  CHAT_OCCUPANCY_SNAPSHOT_ENDPOINT,
  CHAT_OCCUPANCY_SWITCH_ENDPOINT,
  isChatOccupancySnapshot,
  type ChatOccupancyClaimClass,
  type ChatOccupancyProjection,
  type ChatOccupancySnapshot,
} from '@risuai/protocol/chat-occupancy'
import {
  captureClientSessionGeneration,
  getClientSessionSnapshot,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import { ACTIVE_WRITER_SESSION_HEADER } from './activeWriterSession'

const DATABASE_LINEAGE_HEADER = 'risu-database-lineage'
export const CHAT_OCCUPANCY_REQUEST_TIMEOUT_MS = 30_000
const CHAT_OCCUPANCY_REQUEST_CANCELLED = Symbol('chat-occupancy-request-cancelled')

export interface ChatOccupancyRequestScope {
  readonly databaseLineage: string
  readonly sessionId: string
  readonly generation: number
}

export type ChatOccupancyTransportError = {
  readonly status: 'error'
  readonly error: string
  readonly httpStatus?: number
  readonly requestUid?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export type ChatOccupancyTransportUnavailable = {
  readonly status: 'unavailable'
  readonly reason: 'superseded' | 'cancelled'
}

export type ChatOccupancySnapshotTransportResult =
  | { readonly status: 'ok'; readonly snapshot: ChatOccupancySnapshot; readonly requestUid?: string }
  | ChatOccupancyTransportError
  | ChatOccupancyTransportUnavailable

export type ChatOccupancyMutationTransportResult =
  | { readonly status: 'ok'; readonly occupancy: ChatOccupancyProjection; readonly requestUid?: string }
  | ChatOccupancyTransportError
  | ChatOccupancyTransportUnavailable

export function fetchChatOccupancySnapshot(
  scope: ChatOccupancyRequestScope,
  signal?: AbortSignal,
): Promise<ChatOccupancySnapshotTransportResult> {
  return requestSnapshot(scope, signal)
}

export function claimChatOccupancy(
  scope: ChatOccupancyRequestScope,
  input: {
    readonly chatId: string
    readonly expectedOccupancyEpoch: number
    readonly claimClass: ChatOccupancyClaimClass
  },
  signal?: AbortSignal,
): Promise<ChatOccupancyMutationTransportResult> {
  return requestProjection(
    scope,
    `${CHAT_OCCUPANCY_SNAPSHOT_ENDPOINT}/${encodeURIComponent(input.chatId)}/claim`,
    'POST',
    input.expectedOccupancyEpoch,
    { version: CHAT_OCCUPANCY_PROTOCOL_VERSION, claimClass: input.claimClass },
    input.chatId,
    signal,
  )
}

export function renewChatOccupancy(
  scope: ChatOccupancyRequestScope,
  occupancy: Pick<ChatOccupancyProjection, 'chatId' | 'occupancyEpoch'>,
  signal?: AbortSignal,
): Promise<ChatOccupancyMutationTransportResult> {
  return requestProjection(
    scope,
    `${CHAT_OCCUPANCY_SNAPSHOT_ENDPOINT}/${encodeURIComponent(occupancy.chatId)}/lease`,
    'PUT',
    occupancy.occupancyEpoch,
    { version: CHAT_OCCUPANCY_PROTOCOL_VERSION },
    occupancy.chatId,
    signal,
  )
}

export function releaseChatOccupancy(
  scope: ChatOccupancyRequestScope,
  occupancy: Pick<ChatOccupancyProjection, 'chatId' | 'occupancyEpoch'>,
  signal?: AbortSignal,
): Promise<ChatOccupancyMutationTransportResult> {
  return requestProjection(
    scope,
    `${CHAT_OCCUPANCY_SNAPSHOT_ENDPOINT}/${encodeURIComponent(occupancy.chatId)}`,
    'DELETE',
    occupancy.occupancyEpoch,
    { version: CHAT_OCCUPANCY_PROTOCOL_VERSION },
    occupancy.chatId,
    signal,
  )
}

export function switchChatOccupancy(
  scope: ChatOccupancyRequestScope,
  input: {
    readonly sourceChatId: string
    readonly targetChatId: string
    readonly occupancyEpoch: number
  },
  signal?: AbortSignal,
): Promise<ChatOccupancyMutationTransportResult> {
  return requestProjection(
    scope,
    CHAT_OCCUPANCY_SWITCH_ENDPOINT,
    'POST',
    input.occupancyEpoch,
    {
      version: CHAT_OCCUPANCY_PROTOCOL_VERSION,
      sourceChatId: input.sourceChatId,
      targetChatId: input.targetChatId,
    },
    input.targetChatId,
    signal,
  )
}

export function normalizeChatOccupancies(
  scope: ChatOccupancyRequestScope,
  selected: Pick<ChatOccupancyProjection, 'chatId' | 'occupancyEpoch'>,
  signal?: AbortSignal,
): Promise<ChatOccupancyMutationTransportResult> {
  return requestProjection(
    scope,
    CHAT_OCCUPANCY_NORMALIZE_ENDPOINT,
    'POST',
    selected.occupancyEpoch,
    { version: CHAT_OCCUPANCY_PROTOCOL_VERSION, selectedChatId: selected.chatId },
    selected.chatId,
    signal,
  )
}

async function requestSnapshot(
  scope: ChatOccupancyRequestScope,
  callerSignal?: AbortSignal,
): Promise<ChatOccupancySnapshotTransportResult> {
  const result = await request(scope, CHAT_OCCUPANCY_SNAPSHOT_ENDPOINT, 'GET', undefined, undefined, callerSignal)
  if (result.status !== 'ok') return result
  if (!isChatOccupancySnapshot(result.body) || result.body.databaseLineage !== scope.databaseLineage) {
    return invalidResponse(result.requestUid, 'Invalid chat occupancy snapshot response')
  }
  return {
    status: 'ok',
    snapshot: result.body,
    ...(result.requestUid ? { requestUid: result.requestUid } : {}),
  }
}

async function requestProjection(
  scope: ChatOccupancyRequestScope,
  endpoint: string,
  method: 'POST' | 'PUT' | 'DELETE',
  occupancyEpoch: number,
  body: unknown,
  expectedChatId: string,
  callerSignal?: AbortSignal,
): Promise<ChatOccupancyMutationTransportResult> {
  const result = await request(scope, endpoint, method, occupancyEpoch, body, callerSignal)
  if (result.status !== 'ok') return result
  const candidate = result.body
  if (
    !isChatOccupancySnapshot({
      version: CHAT_OCCUPANCY_PROTOCOL_VERSION,
      databaseLineage: scope.databaseLineage,
      occupancies: [candidate],
    }) ||
    (candidate as ChatOccupancyProjection).chatId !== expectedChatId
  ) {
    return invalidResponse(result.requestUid, 'Invalid chat occupancy mutation response')
  }
  return {
    status: 'ok',
    occupancy: candidate as ChatOccupancyProjection,
    ...(result.requestUid ? { requestUid: result.requestUid } : {}),
  }
}

type JsonRequestResult =
  | { readonly status: 'ok'; readonly body: unknown; readonly requestUid?: string }
  | ChatOccupancyTransportError
  | ChatOccupancyTransportUnavailable

async function request(
  scope: ChatOccupancyRequestScope,
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  occupancyEpoch?: number,
  body?: unknown,
  callerSignal?: AbortSignal,
): Promise<JsonRequestResult> {
  if (!scopeIsCurrent(scope)) return { status: 'unavailable', reason: 'superseded' }
  const abort = createRequestAbort(callerSignal)
  try {
    const auth = await Promise.race([getNodeServerProxyAuth(), abort.cancelled])
    if (auth === CHAT_OCCUPANCY_REQUEST_CANCELLED) return cancellationResult(abort)
    if (!scopeIsCurrent(scope)) return { status: 'unavailable', reason: 'superseded' }
    const response = await Promise.race([
      fetch(endpoint, {
        method,
        cache: 'no-store',
        signal: abort.signal,
        headers: {
          'risu-auth': auth,
          [ACTIVE_WRITER_SESSION_HEADER]: scope.sessionId,
          [DATABASE_LINEAGE_HEADER]: scope.databaseLineage,
          ...(occupancyEpoch === undefined ? {} : { [CHAT_OCCUPANCY_EPOCH_HEADER]: String(occupancyEpoch) }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      abort.cancelled,
    ])
    if (response === CHAT_OCCUPANCY_REQUEST_CANCELLED) return cancellationResult(abort)
    const requestUid = response.headers.get('X-Request-UID') || undefined
    const parsedResult = await Promise.race([response.json().catch(() => null), abort.cancelled])
    if (parsedResult === CHAT_OCCUPANCY_REQUEST_CANCELLED) return cancellationResult(abort)
    const parsed: unknown = parsedResult
    if (!scopeIsCurrent(scope)) return { status: 'unavailable', reason: 'superseded' }
    if (!response.ok) return errorResponse(response.status, parsed, requestUid)
    return { status: 'ok', body: parsed, ...(requestUid ? { requestUid } : {}) }
  } catch (error) {
    if (abort.signal.aborted) {
      return abort.timedOut()
        ? { status: 'error', error: 'Network error: Request timed out' }
        : { status: 'unavailable', reason: 'cancelled' }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'error', error: `Network error: ${message}` }
  } finally {
    abort.dispose()
  }
}

function scopeIsCurrent(scope: ChatOccupancyRequestScope): boolean {
  const session = getClientSessionSnapshot()
  return (
    scope.generation === captureClientSessionGeneration() &&
    isClientSessionGenerationCurrent(scope.generation) &&
    session.authenticated &&
    session.sessionId === scope.sessionId &&
    session.databaseLineage === scope.databaseLineage
  )
}

function invalidResponse(requestUid: string | undefined, error: string): ChatOccupancyTransportError {
  return { status: 'error', error, ...(requestUid ? { requestUid } : {}) }
}

function errorResponse(status: number, body: unknown, requestUid?: string): ChatOccupancyTransportError {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  const error = typeof record?.error === 'string' ? record.error : `HTTP ${status}`
  const details = record
    ? Object.freeze(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'error')))
    : undefined
  return {
    status: 'error',
    error,
    httpStatus: status,
    ...(requestUid ? { requestUid } : {}),
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  }
}

function createRequestAbort(callerSignal?: AbortSignal): {
  signal: AbortSignal
  cancelled: Promise<typeof CHAT_OCCUPANCY_REQUEST_CANCELLED>
  timedOut(): boolean
  dispose(): void
} {
  const controller = new AbortController()
  let timedOut = false
  let resolveCancelled!: (value: typeof CHAT_OCCUPANCY_REQUEST_CANCELLED) => void
  const cancelled = new Promise<typeof CHAT_OCCUPANCY_REQUEST_CANCELLED>((resolve) => {
    resolveCancelled = resolve
  })
  const abort = () => {
    controller.abort()
    resolveCancelled(CHAT_OCCUPANCY_REQUEST_CANCELLED)
  }
  if (callerSignal?.aborted) abort()
  else callerSignal?.addEventListener('abort', abort, { once: true })
  const deadline = setTimeout(() => {
    timedOut = true
    abort()
  }, CHAT_OCCUPANCY_REQUEST_TIMEOUT_MS)
  return {
    signal: controller.signal,
    cancelled,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(deadline)
      callerSignal?.removeEventListener('abort', abort)
    },
  }
}

function cancellationResult(
  abort: ReturnType<typeof createRequestAbort>,
): ChatOccupancyTransportError | ChatOccupancyTransportUnavailable {
  return abort.timedOut()
    ? { status: 'error', error: 'Network error: Request timed out' }
    : { status: 'unavailable', reason: 'cancelled' }
}
