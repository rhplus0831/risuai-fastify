import { canUseClientWriteAccess, captureClientSessionGeneration } from '../clientSession'
import { isClientWriteOperationCurrent } from '../clientWriteOperation'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import { activeWriterSessionHeader, handleActiveWriterStaleResponse } from './activeWriterSession'

const REQUEST_HISTORY_ENDPOINT = '/api/v1/request-history'

export type RequestHistoryStatus = 'pending' | 'success' | 'error' | 'cancelled'

export interface RequestHistoryProfileSnapshot {
  id: string
  name?: string
  role: string
  sourceKind: string
  provider?: string
  modelId: string
  requestModel: string
}

export interface RequestHistoryContext {
  characterId?: string
  characterName?: string
  chatId?: string
  chatName?: string
  messageId?: string
  generationId?: string
}

export interface RequestHistoryRecordSummary {
  id: string
  startedAt: number
  completedAt?: number
  status: RequestHistoryStatus
  source: string
  profile: RequestHistoryProfileSnapshot
  context?: RequestHistoryContext
  responsePreview: string
  error?: string
}

export interface RequestHistoryRecord extends RequestHistoryRecordSummary {
  prompt: unknown
  toggles?: Record<string, string>
  response: string
  metadata: Record<string, unknown>
  apiMetadata: Record<string, unknown>
}

export type RequestHistoryApiResult<T> = { status: 'ok'; value: T } | { status: 'error'; error: string }

export async function listRequestHistory(
  signal?: AbortSignal,
): Promise<RequestHistoryApiResult<{ limit: number; records: RequestHistoryRecordSummary[] }>> {
  return requestHistoryJson(REQUEST_HISTORY_ENDPOINT, { method: 'GET', signal }, (body) => {
    if (!isRecord(body) || !Number.isSafeInteger(body.limit) || (body.limit as number) < 0) return null
    if (!Array.isArray(body.records)) return null
    const records = body.records.map(readSummary)
    if (records.some((record) => record === null)) return null
    return { limit: body.limit as number, records: records as RequestHistoryRecordSummary[] }
  })
}

export async function getRequestHistoryRecord(
  id: string,
  signal?: AbortSignal,
): Promise<RequestHistoryApiResult<RequestHistoryRecord>> {
  return requestHistoryJson(
    `${REQUEST_HISTORY_ENDPOINT}/${encodeURIComponent(id)}`,
    { method: 'GET', signal },
    (body) => {
      if (!isRecord(body)) return null
      return readRecord(body.record)
    },
  )
}

export async function deleteRequestHistoryRecord(
  id: string,
  signal?: AbortSignal,
): Promise<RequestHistoryApiResult<{ id: string }>> {
  return requestHistoryJson(
    `${REQUEST_HISTORY_ENDPOINT}/${encodeURIComponent(id)}`,
    { method: 'DELETE', signal },
    (body) => (isRecord(body) && typeof body.id === 'string' ? { id: body.id } : null),
  )
}

async function requestHistoryJson<T>(
  url: string,
  init: { method: 'GET' | 'DELETE'; signal?: AbortSignal },
  read: (body: unknown) => T | null,
): Promise<RequestHistoryApiResult<T>> {
  const operation = captureClientSessionGeneration()
  if (init.method === 'DELETE' && !canUseClientWriteAccess()) {
    return { status: 'error', error: 'client_write_access_required' }
  }
  const auth = await getNodeServerProxyAuth()
  if (init.method === 'DELETE' && !isClientWriteOperationCurrent(operation)) {
    return { status: 'error', error: 'client_write_operation_stale' }
  }
  let response: Response
  try {
    response = await fetch(url, {
      method: init.method,
      signal: init.signal,
      headers: { 'risu-auth': auth, ...activeWriterSessionHeader() },
    })
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    handleActiveWriterStaleResponse(response, body, operation)
    return { status: 'error', error: errorFromBody(body, `HTTP ${response.status}`) }
  }
  const value = read(body)
  return value === null ? { status: 'error', error: 'Invalid request history response' } : { status: 'ok', value }
}

function readRecord(value: unknown): RequestHistoryRecord | null {
  const summary = readSummary(value)
  if (!summary || !isRecord(value)) return null
  if (typeof value.response !== 'string' || !isRecord(value.metadata)) return null
  if (value.apiMetadata !== undefined && !isRecord(value.apiMetadata)) return null
  if (value.toggles !== undefined && !isStringRecord(value.toggles)) return null
  return {
    ...summary,
    prompt: value.prompt,
    ...(isStringRecord(value.toggles) ? { toggles: value.toggles } : {}),
    response: value.response,
    metadata: value.metadata,
    apiMetadata: isRecord(value.apiMetadata) ? value.apiMetadata : {},
  }
}

function readSummary(value: unknown): RequestHistoryRecordSummary | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.source !== 'string') return null
  if (!Number.isFinite(value.startedAt) || (value.completedAt !== undefined && !Number.isFinite(value.completedAt))) {
    return null
  }
  if (!isRequestHistoryStatus(value.status) || typeof value.responsePreview !== 'string') return null
  const profile = readProfile(value.profile)
  if (!profile) return null
  if (value.context !== undefined && !isRecord(value.context)) return null
  if (value.error !== undefined && typeof value.error !== 'string') return null
  return {
    id: value.id,
    startedAt: value.startedAt as number,
    ...(typeof value.completedAt === 'number' ? { completedAt: value.completedAt } : {}),
    status: value.status,
    source: value.source,
    profile,
    ...(isRecord(value.context) ? { context: value.context as RequestHistoryContext } : {}),
    responsePreview: value.responsePreview,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  }
}

function readProfile(value: unknown): RequestHistoryProfileSnapshot | null {
  if (!isRecord(value)) return null
  for (const key of ['id', 'role', 'sourceKind', 'modelId', 'requestModel']) {
    if (typeof value[key] !== 'string') return null
  }
  if (value.name !== undefined && typeof value.name !== 'string') return null
  if (value.provider !== undefined && typeof value.provider !== 'string') return null
  return value as unknown as RequestHistoryProfileSnapshot
}

function isRequestHistoryStatus(value: unknown): value is RequestHistoryStatus {
  return value === 'pending' || value === 'success' || value === 'error' || value === 'cancelled'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

function errorFromBody(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.error === 'string' ? body.error : fallback
}
