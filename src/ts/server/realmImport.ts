import { canUseClientWriteAccess, captureClientSessionGeneration } from '../clientSession'
import { isClientWriteOperationCurrent } from '../clientWriteOperation'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import { activeWriterSessionHeader, handleActiveWriterStaleResponse } from './activeWriterSession'
import {
  getServerCommandBaseRevision,
  setCachedServerCommandRevision,
  withDirectServerCommandEventReconciliation,
  type CommandEvent,
} from './commands'
import { iterateSseEvents } from '../process/request/sseParse'

const REALM_IMPORT_ENDPOINT = '/api/v1/import/realm-character'

export type ServerRealmImportProgressPhase =
  | 'validate'
  | 'download'
  | 'extract'
  | 'assets'
  | 'convert'
  | 'commit'
  | 'refresh'

export interface ServerRealmImportProgress {
  phase: ServerRealmImportProgressPhase
  message: string
  percent: number
}

export type ServerRealmImportResult =
  | { status: 'ok'; revision: number; event: CommandEvent; characterId: string }
  | { status: 'low-level-access'; pendingImportToken?: string }
  | { status: 'unsupported'; error: string }
  | { status: 'conflict'; currentRevision: number }
  | { status: 'error'; error: string }
  | { status: 'unavailable' }

export async function importRealmCharacterFromServer(
  id: string,
  options: {
    allowLowLevelAccess?: boolean
    pendingImportToken?: string
    signal?: AbortSignal | null
    onProgress?: (progress: ServerRealmImportProgress) => void
  } = {},
): Promise<ServerRealmImportResult> {
  if (!canUseClientWriteAccess()) return { status: 'unavailable' }
  const sourceGeneration = captureClientSessionGeneration()
  const onProgress = options.onProgress
    ? (progress: ServerRealmImportProgress) => {
        if (isClientWriteOperationCurrent(sourceGeneration)) options.onProgress?.(progress)
      }
    : undefined
  let confirmedCharacterId: string | null = null
  return withDirectServerCommandEventReconciliation(
    (event) =>
      event.type === 'character.created' &&
      event.resource === 'character' &&
      (confirmedCharacterId === null || event.id === confirmedCharacterId),
    async (reconcileResponseEvent) => {
      const baseRevision = await getServerCommandBaseRevision(options.signal)
      if (!isClientWriteOperationCurrent(sourceGeneration)) return { status: 'unavailable' }
      if (baseRevision === null) {
        return { status: 'error', error: 'Unable to read server command revision' }
      }

      const auth = await getNodeServerProxyAuth()
      if (!isClientWriteOperationCurrent(sourceGeneration)) return { status: 'unavailable' }
      let response: Response
      try {
        response = await fetch(REALM_IMPORT_ENDPOINT, {
          method: 'POST',
          signal: options.signal ?? undefined,
          headers: {
            'content-type': 'application/json',
            ...(options.onProgress ? { accept: 'text/event-stream' } : {}),
            'risu-auth': auth,
            ...activeWriterSessionHeader(),
          },
          body: JSON.stringify({
            id,
            baseRevision,
            allowLowLevelAccess: options.allowLowLevelAccess === true,
            ...(options.pendingImportToken ? { pendingImportToken: options.pendingImportToken } : {}),
            clientCapabilities: { realmProgressDelta: true },
          }),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { status: 'error', error: `Network error: ${message}` }
      }

      const result =
        options.onProgress && response.ok && response.headers.get('content-type')?.includes('text/event-stream')
          ? await readRealmImportProgressStream(response, { ...options, onProgress }, sourceGeneration)
          : await readRealmImportJsonResponse(response, sourceGeneration)
      if (result.status === 'ok' && isClientWriteOperationCurrent(sourceGeneration)) {
        confirmedCharacterId = result.characterId
        await reconcileResponseEvent(result.event)
      }
      return result
    },
  )
}

async function readRealmImportProgressStream(
  response: Response,
  options: {
    signal?: AbortSignal | null
    onProgress?: (progress: ServerRealmImportProgress) => void
  },
  sourceGeneration: number,
): Promise<ServerRealmImportResult> {
  if (!response.body) {
    return { status: 'error', error: 'Invalid Realm import progress response' }
  }

  try {
    let lastProgress: ServerRealmImportProgress | null = null
    for await (const frame of iterateSseEvents(response.body, options.signal ?? null)) {
      if (frame.event === 'progress') {
        const progress = readProgressFrame(frame.data, lastProgress)
        if (progress) {
          lastProgress = progress
          options.onProgress?.(progress)
        }
        continue
      }
      if (frame.event === 'done') {
        return readRealmImportSuccessBody(parseJsonFrame(frame.data), sourceGeneration)
      }
      if (frame.event === 'low_level_access') {
        return lowLevelAccessResult(parseJsonFrame(frame.data))
      }
      if (frame.event === 'unsupported') {
        return {
          status: 'unsupported',
          error: errorMessageFromBody(parseJsonFrame(frame.data), 'Unsupported Realm download'),
        }
      }
      if (frame.event === 'conflict') {
        const body = parseJsonFrame(frame.data)
        const currentRevision = readCurrentRevision(body)
        if (currentRevision !== null && isClientWriteOperationCurrent(sourceGeneration))
          setCachedServerCommandRevision(currentRevision)
        return currentRevision === null
          ? { status: 'error', error: errorMessageFromBody(body, 'Revision mismatch') }
          : { status: 'conflict', currentRevision }
      }
      if (frame.event === 'error') {
        return { status: 'error', error: errorMessageFromBody(parseJsonFrame(frame.data), 'Error') }
      }
    }
  } catch (err) {
    if (options.signal?.aborted) {
      return { status: 'error', error: 'Realm import aborted' }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', error: `Progress stream error: ${message}` }
  }

  return { status: 'error', error: 'Realm import progress stream ended without a result' }
}

async function readRealmImportJsonResponse(
  response: Response,
  sourceGeneration: number,
): Promise<ServerRealmImportResult> {
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // Non-JSON errors are surfaced by HTTP status handling below.
  }

  if (response.status === 409) {
    if (readBodyCode(body) === 'low_level_access_confirmation_required') {
      return lowLevelAccessResult(body)
    }
    const currentRevision = readCurrentRevision(body)
    if (currentRevision !== null && isClientWriteOperationCurrent(sourceGeneration))
      setCachedServerCommandRevision(currentRevision)
    return currentRevision === null
      ? { status: 'error', error: errorMessageFromBody(body, 'HTTP 409') }
      : { status: 'conflict', currentRevision }
  }

  if (response.status === 415) {
    return {
      status: 'unsupported',
      error: errorMessageFromBody(body, 'Unsupported Realm download'),
    }
  }

  if (handleActiveWriterStaleResponse(response, body, sourceGeneration)) {
    return { status: 'error', error: errorMessageFromBody(body, 'HTTP 423') }
  }

  if (!response.ok) {
    return { status: 'error', error: errorMessageFromBody(body, `HTTP ${response.status}`) }
  }

  return readRealmImportSuccessBody(body, sourceGeneration)
}

function readRealmImportSuccessBody(body: unknown, sourceGeneration: number): ServerRealmImportResult {
  if (!body || typeof body !== 'object') {
    return { status: 'error', error: 'Invalid Realm import response' }
  }
  const record = body as Record<string, unknown>
  if (!Number.isInteger(record.revision) || (record.revision as number) < 0) {
    return { status: 'error', error: 'Invalid Realm import revision' }
  }
  if (!record.event || typeof record.event !== 'object') {
    return { status: 'error', error: 'Invalid Realm import event' }
  }
  if (typeof record.characterId !== 'string') {
    return { status: 'error', error: 'Invalid Realm import character id' }
  }

  const revision = record.revision as number
  if (isClientWriteOperationCurrent(sourceGeneration)) setCachedServerCommandRevision(revision)
  return {
    status: 'ok',
    revision,
    event: record.event as CommandEvent,
    characterId: record.characterId,
  }
}

function readProgressFrame(
  data: string,
  lastProgress: ServerRealmImportProgress | null,
): ServerRealmImportProgress | null {
  const parsed = parseJsonFrame(data)
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (typeof record.percent !== 'number' || !Number.isFinite(record.percent)) return null
  if (record.phase !== undefined && typeof record.phase !== 'string') return null
  if (record.message !== undefined && typeof record.message !== 'string') return null
  const phase = typeof record.phase === 'string' ? record.phase : lastProgress?.phase
  const message = typeof record.message === 'string' ? record.message : lastProgress?.message
  if (phase === undefined || message === undefined) return null
  return {
    phase: phase as ServerRealmImportProgressPhase,
    message,
    percent: Math.max(0, Math.min(100, record.percent)),
  }
}

function parseJsonFrame(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

function readCurrentRevision(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null
  const revision = (body as { currentRevision?: unknown }).currentRevision
  return Number.isInteger(revision) && (revision as number) >= 0 ? (revision as number) : null
}

function readBodyCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const code = (body as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function lowLevelAccessResult(body: unknown): ServerRealmImportResult {
  const pendingImportToken =
    body &&
    typeof body === 'object' &&
    typeof (body as { pendingImportToken?: unknown }).pendingImportToken === 'string'
      ? (body as { pendingImportToken: string }).pendingImportToken
      : undefined
  return pendingImportToken ? { status: 'low-level-access', pendingImportToken } : { status: 'low-level-access' }
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (typeof record.error === 'string') return record.error
    if (typeof record.reason === 'string') return record.reason
  }
  return fallback
}
