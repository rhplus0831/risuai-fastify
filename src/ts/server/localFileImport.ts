import { canUseClientWriteAccess, captureClientSessionGeneration } from '../clientSession'
import { isClientWriteOperationCurrent } from '../clientWriteOperation'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import { activeWriterSessionHeader, handleActiveWriterStaleResponse } from './activeWriterSession'
import {
  sendLocalCharacterImport,
  reportLocalFileImportProgress,
  type LocalFileImportProgress,
} from './localFileImportTransport'
export type { LocalFileImportProgress } from './localFileImportTransport'
import {
  getServerCommandBaseRevision,
  setCachedServerCommandRevision,
  withDirectServerCommandEventReconciliation,
  type CommandEvent,
} from './commands'

const CHARACTER_IMPORT_ENDPOINT = '/api/v1/import/character-card'
const MODULE_IMPORT_ENDPOINT = '/api/v1/import/module'

export interface LocalCharacterImportReport {
  droppedArchiveEntries: string[]
  droppedInlineAssets: Array<{ index: number; name: string }>
}

export type ServerLocalCharacterImportResult =
  | {
      status: 'ok'
      revision: number
      event: CommandEvent
      characterId: string
      importReport: LocalCharacterImportReport
    }
  | ServerLocalFileImportChallenge
  | ServerLocalFileImportFailure

export type ServerLocalModuleImportResult =
  | { status: 'ok'; revision: number; event: CommandEvent; moduleId: string }
  | ServerLocalFileImportChallenge
  | ServerLocalFileImportFailure

export type ServerLocalFileImportChallenge =
  | { status: 'low-level-access'; pendingImportToken: string }
  | { status: 'password-required'; pendingImportToken: string }
  | { status: 'password-invalid'; error: string; pendingImportToken?: string }

export type ServerLocalFileImportFailure =
  | { status: 'conflict'; currentRevision: number }
  | { status: 'error'; error: string }
  | { status: 'unavailable' }

interface LocalFileImportOptions {
  file?: Blob
  fileName?: string
  pendingImportToken?: string
  allowLowLevelAccess?: boolean
  password?: string
  signal?: AbortSignal | null
  onProgress?: (progress: LocalFileImportProgress) => void
}

export function importLocalCharacterFileFromServer(
  options: LocalFileImportOptions,
): Promise<ServerLocalCharacterImportResult> {
  return importLocalFileFromServer('character', options) as Promise<ServerLocalCharacterImportResult>
}

export function importLocalModuleFileFromServer(
  options: LocalFileImportOptions,
): Promise<ServerLocalModuleImportResult> {
  return importLocalFileFromServer('module', options) as Promise<ServerLocalModuleImportResult>
}

async function importLocalFileFromServer(
  kind: 'character' | 'module',
  options: LocalFileImportOptions,
): Promise<ServerLocalCharacterImportResult | ServerLocalModuleImportResult> {
  if (!canUseClientWriteAccess()) return { status: 'unavailable' }
  const sourceGeneration = captureClientSessionGeneration()
  const onProgress = options.onProgress
    ? (progress: LocalFileImportProgress) => {
        if (isClientWriteOperationCurrent(sourceGeneration)) options.onProgress?.(progress)
      }
    : undefined
  let confirmedId: string | null = null
  const expectedEventType = kind === 'character' ? 'character.created' : 'module.created'
  return withDirectServerCommandEventReconciliation(
    (event) => event.type === expectedEventType && (confirmedId === null || event.id === confirmedId),
    async (reconcileResponseEvent) => {
      reportLocalFileImportProgress(onProgress, { phase: 'prepare' })
      const baseRevision = await getServerCommandBaseRevision(options.signal)
      if (!isClientWriteOperationCurrent(sourceGeneration)) return { status: 'unavailable' }
      if (baseRevision === null) return { status: 'error', error: 'Unable to read server command revision' }

      const auth = await getNodeServerProxyAuth()
      if (!isClientWriteOperationCurrent(sourceGeneration)) return { status: 'unavailable' }
      const endpoint = kind === 'character' ? CHARACTER_IMPORT_ENDPOINT : MODULE_IMPORT_ENDPOINT
      const headers: Record<string, string> = {
        'risu-auth': auth,
        ...activeWriterSessionHeader(),
      }
      let body: FormData | string
      let url = endpoint
      if (options.pendingImportToken) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify({
          baseRevision,
          pendingImportToken: options.pendingImportToken,
          allowLowLevelAccess: options.allowLowLevelAccess === true,
          ...(options.password !== undefined ? { password: options.password } : {}),
        })
      } else {
        if (!options.file) return { status: 'error', error: 'Import file is required' }
        const form = new FormData()
        form.append('file', options.file, options.fileName ?? defaultFileName(kind))
        body = form
        url = `${endpoint}?baseRevision=${encodeURIComponent(String(baseRevision))}`
      }

      let response: Response
      try {
        response =
          kind === 'character' && onProgress
            ? await sendLocalCharacterImport({
                url,
                headers,
                body,
                signal: options.signal,
                onProgress,
              })
            : await fetch(url, {
                method: 'POST',
                signal: options.signal ?? undefined,
                headers,
                body,
              })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { status: 'error', error: `Network error: ${message}` }
      }

      const result = await readLocalFileImportResponse(kind, response, options.pendingImportToken, sourceGeneration)
      if (result.status === 'ok' && isClientWriteOperationCurrent(sourceGeneration)) {
        confirmedId = 'characterId' in result ? result.characterId : result.moduleId
        reportLocalFileImportProgress(onProgress, { phase: 'refresh' })
        await reconcileResponseEvent(result.event)
      }
      return result
    },
  )
}

async function readLocalFileImportResponse(
  kind: 'character' | 'module',
  response: Response,
  pendingImportToken: string | undefined,
  sourceGeneration: number,
): Promise<ServerLocalCharacterImportResult | ServerLocalModuleImportResult> {
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // HTTP status handling below reports non-JSON responses.
  }

  const code = readBodyString(body, 'code')
  const returnedToken = readBodyString(body, 'pendingImportToken') ?? pendingImportToken
  if (response.status === 409 && code === 'low_level_access_confirmation_required' && returnedToken) {
    return { status: 'low-level-access', pendingImportToken: returnedToken }
  }
  if (response.status === 409 && code === 'character_password_required' && returnedToken) {
    return { status: 'password-required', pendingImportToken: returnedToken }
  }
  if (response.status === 400 && code === 'character_password_invalid') {
    return {
      status: 'password-invalid',
      error: errorMessageFromBody(body, 'Character card password is invalid'),
      ...(returnedToken ? { pendingImportToken: returnedToken } : {}),
    }
  }
  if (response.status === 409) {
    const currentRevision = readBodyNumber(body, 'currentRevision')
    if (currentRevision !== null) {
      if (isClientWriteOperationCurrent(sourceGeneration)) setCachedServerCommandRevision(currentRevision)
      return { status: 'conflict', currentRevision }
    }
  }
  if (handleActiveWriterStaleResponse(response, body, sourceGeneration)) {
    return { status: 'error', error: errorMessageFromBody(body, `HTTP ${response.status}`) }
  }
  if (!response.ok) return { status: 'error', error: errorMessageFromBody(body, `HTTP ${response.status}`) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 'error', error: 'Invalid local file import response' }
  }

  const record = body as Record<string, unknown>
  const revision =
    Number.isInteger(record.revision) && (record.revision as number) >= 0 ? (record.revision as number) : null
  if (revision === null || !record.event || typeof record.event !== 'object') {
    return { status: 'error', error: 'Invalid local file import response' }
  }
  if (isClientWriteOperationCurrent(sourceGeneration)) setCachedServerCommandRevision(revision)
  if (kind === 'character') {
    if (typeof record.characterId !== 'string') return { status: 'error', error: 'Invalid character import response' }
    return {
      status: 'ok',
      revision,
      event: record.event as CommandEvent,
      characterId: record.characterId,
      importReport: readCharacterImportReport(record.importReport),
    }
  }
  if (typeof record.moduleId !== 'string') return { status: 'error', error: 'Invalid module import response' }
  return { status: 'ok', revision, event: record.event as CommandEvent, moduleId: record.moduleId }
}

function readCharacterImportReport(value: unknown): LocalCharacterImportReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { droppedArchiveEntries: [], droppedInlineAssets: [] }
  }
  const record = value as Record<string, unknown>
  const droppedArchiveEntries = Array.isArray(record.droppedArchiveEntries)
    ? record.droppedArchiveEntries.filter((entry): entry is string => typeof entry === 'string')
    : []
  const droppedInlineAssets = Array.isArray(record.droppedInlineAssets)
    ? record.droppedInlineAssets.filter(
        (entry): entry is { index: number; name: string } =>
          !!entry &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          Number.isInteger((entry as Record<string, unknown>).index) &&
          typeof (entry as Record<string, unknown>).name === 'string',
      )
    : []
  return { droppedArchiveEntries, droppedInlineAssets }
}

function readBodyString(body: unknown, key: string): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

function readBodyNumber(body: unknown, key: string): number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = (body as Record<string, unknown>)[key]
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  return readBodyString(body, 'error') ?? readBodyString(body, 'reason') ?? fallback
}

function defaultFileName(kind: 'character' | 'module'): string {
  return kind === 'character' ? 'character.png' : 'module.risum'
}
