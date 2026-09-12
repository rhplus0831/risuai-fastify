import { canUseClientWriteAccess, captureClientSessionGeneration } from '../clientSession'
import { isClientWriteOperationCurrent } from '../clientWriteOperation'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import { activeWriterSessionHeader, handleActiveWriterStaleResponse } from './activeWriterSession'
import type { CommandEvent } from './commands'
import {
  adoptReplacementDatabaseOwnership,
  beginLocalReplacementDatabaseOperation,
} from './replacementDatabaseOwnership'
import { forceServerDatabaseReplacementRefresh } from './resourceRefresh'

const BACKUPS_ENDPOINT = '/api/v1/backups'
const BUNDLE_EXPORT_ENDPOINT = '/api/v1/export/bundle'
const LOCAL_BACKUP_EXPORT_ENDPOINT = '/api/v1/export/local-backup'
const BUNDLE_IMPORT_ENDPOINT = '/api/v1/import/bundle'
const DEFAULT_BUNDLE_FILENAME = 'database.risu.zip'
const DEFAULT_LOCAL_BACKUP_FILENAME = 'database.bin'
const ESTIMATED_BACKUP_BYTES_HEADER = 'x-risu-estimated-backup-bytes'

export interface ServerBackupManifest {
  _version: number
  id: string
  label: string | null
  kind?: 'manual' | 'automatic'
  createdAt: string
  revision: number
  assetCount: number
}

export type ServerBackupResult<T> =
  | ({ status: 'ok' } & T)
  | { status: 'error'; error: string; discardedPendingMutations?: number }
  | { status: 'unavailable' }

export interface UnsupportedBackupGroup {
  id: string | null
  name: string | null
}

export interface UnsupportedBackupGroupsResult {
  status: 'unsupported-groups'
  count: number
  groups: UnsupportedBackupGroup[]
  error: string
}

export interface UnsupportedStandaloneChatBlocksResult {
  status: 'unsupported-chat-blocks'
  error: string
}

export interface ServerBackupAssetReport {
  referencedCount: number
  missingCount: number
  orphanedCount: number
}

export interface ServerBackupSkippedBlock {
  name: string
  type: 'CHAT'
}

export type ServerBackupProgressPhase =
  | 'prepare'
  | 'request'
  | 'download'
  | 'upload'
  | 'process'
  | 'resync'
  | 'complete'

export interface ServerBackupProgress {
  phase: ServerBackupProgressPhase
  message: string
  percent: number | null
  loadedBytes?: number
  totalBytes?: number | null
  estimatedTotalBytes?: boolean
}

export type ServerBackupProgressCallback = (progress: ServerBackupProgress) => void

export interface ServerBackupProgressOptions {
  signal?: AbortSignal | null
  onProgress?: ServerBackupProgressCallback
}

export function canUseServerBackups(): boolean {
  return canUseClientWriteAccess()
}

export async function createServerBackup(
  input: {
    label?: string | null
    signal?: AbortSignal | null
    onProgress?: ServerBackupProgressCallback
  } = {},
): Promise<ServerBackupResult<{ backup: ServerBackupManifest }>> {
  if (!canUseClientWriteAccess()) return { status: 'unavailable' }
  const operation = captureClientSessionGeneration()
  input = { ...input, onProgress: guardWriterProgress(input.onProgress, operation) }
  reportProgress(input.onProgress, {
    phase: 'process',
    message: 'Creating server backup',
    percent: 10,
  })
  if (!isClientWriteOperationCurrent(operation)) return { status: 'unavailable' }
  const result = await requestServerBackupJson('', {
    method: 'POST',
    body: { label: input.label ?? null },
    signal: input.signal,
    validate: readBackupManifest,
    map: (backup) => ({ backup }),
  })
  if (result.status === 'ok' && isClientWriteOperationCurrent(operation)) {
    reportProgress(input.onProgress, {
      phase: 'complete',
      message: 'Server backup saved',
      percent: 100,
    })
  }
  return result
}

export async function listServerBackups(
  signal?: AbortSignal | null,
): Promise<ServerBackupResult<{ backups: ServerBackupManifest[] }>> {
  return requestServerBackupJson('', {
    method: 'GET',
    signal,
    validate: (body) => {
      if (!body || typeof body !== 'object') return null
      const backups = (body as { backups?: unknown }).backups
      if (!Array.isArray(backups)) return null
      const parsed = backups.map(readBackupManifest)
      return parsed.every((backup): backup is ServerBackupManifest => backup !== null) ? parsed : null
    },
    map: (backups) => ({ backups }),
  })
}

export async function restoreServerBackup(input: {
  id: string
  signal?: AbortSignal | null
  onProgress?: ServerBackupProgressCallback
}): Promise<ServerBackupResult<{ revision: number; event?: CommandEvent; discardedPendingMutations: number }>> {
  if (!canUseClientWriteAccess()) return { status: 'unavailable' }
  const operation = captureClientSessionGeneration()
  input = { ...input, onProgress: guardWriterProgress(input.onProgress, operation) }
  const finishReplacement = beginLocalReplacementDatabaseOperation()
  try {
    return await restoreServerBackupImplementation(input)
  } finally {
    finishReplacement()
  }
}

async function restoreServerBackupImplementation(input: {
  id: string
  signal?: AbortSignal | null
  onProgress?: ServerBackupProgressCallback
}): Promise<ServerBackupResult<{ revision: number; event?: CommandEvent; discardedPendingMutations: number }>> {
  const operation = captureClientSessionGeneration()
  input = { ...input, onProgress: guardWriterProgress(input.onProgress, operation) }
  reportProgress(input.onProgress, {
    phase: 'process',
    message: 'Restoring server backup',
    percent: 10,
  })
  if (!isClientWriteOperationCurrent(operation)) return { status: 'unavailable' }
  const restored = await requestServerBackupJson(`/${encodeURIComponent(input.id)}/restore`, {
    method: 'POST',
    signal: input.signal,
    validate: (body) => {
      if (!body || typeof body !== 'object') return null
      const record = body as {
        revision?: unknown
        event?: unknown
        databaseLineage?: unknown
        writerEpoch?: unknown
      }
      if (!Number.isInteger(record.revision) || (record.revision as number) < 0) return null
      if (record.event !== undefined && !isCommandEvent(record.event)) return null
      const ownership = readDatabaseOwnership(record)
      if (!ownership) return null
      return {
        revision: record.revision as number,
        ...(isCommandEvent(record.event) ? { event: record.event } : {}),
        ...ownership,
      }
    },
    map: (result) => result,
  })
  if (restored.status !== 'ok') return restored
  // The server accepted this replacement. A stale caller must not adopt its
  // ownership or overwrite the current projection; canonical refresh reconciles it.
  if (!isClientWriteOperationCurrent(operation)) {
    return {
      status: 'ok',
      revision: restored.revision,
      discardedPendingMutations: 0,
      ...(restored.event ? { event: restored.event } : {}),
    }
  }
  let discardedPendingMutations = 0
  try {
    ;({ discarded: discardedPendingMutations } = await adoptReplacementDatabaseOwnership(restored))

    reportProgress(input.onProgress, {
      phase: 'resync',
      message: 'Refreshing local state',
      percent: 75,
    })
    if (!isClientWriteOperationCurrent(operation))
      return {
        status: 'ok',
        revision: restored.revision,
        discardedPendingMutations,
        ...(restored.event ? { event: restored.event } : {}),
      }
    const resync = await forceServerDatabaseReplacementRefresh('backup-restore')
    if (resync.status !== 'ok') {
      return {
        status: 'error',
        ...(discardedPendingMutations > 0 ? { discardedPendingMutations } : {}),
        error:
          resync.status === 'unavailable'
            ? 'Backup restored, but server resource APIs are unavailable; reload to refresh local state.'
            : `Backup restored, but resource refresh failed: ${resync.error}`,
      }
    }
    if (isClientWriteOperationCurrent(operation)) await showLegacyMemoryMigrationNoticeAfterReplacement(operation)
    reportProgress(input.onProgress, {
      phase: 'complete',
      message: 'Server backup loaded',
      percent: 100,
    })
    return {
      status: 'ok',
      revision: restored.revision,
      discardedPendingMutations,
      ...(restored.event ? { event: restored.event } : {}),
    }
  } catch (error) {
    return {
      status: 'error',
      ...(discardedPendingMutations > 0 ? { discardedPendingMutations } : {}),
      error: `Backup restored, but resource refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function deleteServerBackup(input: {
  id: string
  signal?: AbortSignal | null
}): Promise<ServerBackupResult<{ id: string }>> {
  return requestServerBackupJson(`/${encodeURIComponent(input.id)}`, {
    method: 'DELETE',
    signal: input.signal,
    validate: (body) => {
      if (!body || typeof body !== 'object') return null
      const id = (body as { id?: unknown }).id
      return typeof id === 'string' ? { id } : null
    },
    map: (result) => result,
  })
}

/**
 * Download the server's full `.risu.zip` bundle (database + referenced asset
 * files) so the caller can save it to the user's device as the ZIP-style
 * fallback backup.
 */
export async function exportServerBundle(
  options?: AbortSignal | ServerBackupProgressOptions | null,
): Promise<ServerBackupResult<{ blob: Blob; filename: string }>> {
  return exportServerBackupBlob(BUNDLE_EXPORT_ENDPOINT, DEFAULT_BUNDLE_FILENAME, options)
}

/**
 * Download a server-built backup in the original Risu local `.bin` format. The
 * file is a LocalWriter-compatible record stream with `database.risudat` plus
 * referenced asset files, so original Risu can load it through its local backup
 * path.
 */
export async function exportServerLocalBackup(
  options?: AbortSignal | ServerBackupProgressOptions | null,
): Promise<ServerBackupResult<{ blob: Blob; filename: string }>> {
  return exportServerBackupBlob(LOCAL_BACKUP_EXPORT_ENDPOINT, DEFAULT_LOCAL_BACKUP_FILENAME, options)
}

async function exportServerBackupBlob(
  endpoint: string,
  defaultFilename: string,
  options?: AbortSignal | ServerBackupProgressOptions | null,
): Promise<ServerBackupResult<{ blob: Blob; filename: string }>> {
  const { signal, onProgress } = normalizeProgressOptions(options)
  reportProgress(onProgress, {
    phase: 'request',
    message: 'Requesting backup export',
    percent: 5,
  })
  const auth = await getNodeServerProxyAuth()
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      signal: signal ?? undefined,
      headers: { 'risu-auth': auth },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', error: `Network error: ${message}` }
  }

  if (!response.ok) {
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // Fall back to the status code below for non-JSON failures.
    }
    return { status: 'error', error: errorMessageFromBody(body, `HTTP ${response.status}`) }
  }

  let blob: Blob
  try {
    blob = await readResponseBlobWithProgress(response, scaleProgress(onProgress, 10, 95), 'Downloading backup')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', error: `Download error: ${message}` }
  }
  reportProgress(onProgress, {
    phase: 'complete',
    message: 'Backup download complete',
    percent: 100,
    loadedBytes: blob.size,
    totalBytes: blob.size,
  })
  return {
    status: 'ok',
    blob,
    filename: filenameFromContentDisposition(response.headers.get('content-disposition')) ?? defaultFilename,
  }
}

/**
 * Upload a `.risu.zip` bundle the user selected from their device and restore it
 * on the server (registers bundled assets, replaces the database), then refresh
 * the local projection. This is the server-backed replacement for the original
 * "Load Backup Locally" feature.
 */
export async function importServerBundle(input: {
  file: Blob
  filename?: string
  signal?: AbortSignal | null
  onProgress?: ServerBackupProgressCallback
}): Promise<
  | ServerBackupResult<{
      revision: number
      event?: CommandEvent
      discardedPendingMutations: number
      assetReport: ServerBackupAssetReport
      skippedBlocks: ServerBackupSkippedBlock[]
    }>
  | UnsupportedBackupGroupsResult
  | UnsupportedStandaloneChatBlocksResult
> {
  if (!canUseClientWriteAccess()) return { status: 'unavailable' }
  const operation = captureClientSessionGeneration()
  input = { ...input, onProgress: guardWriterProgress(input.onProgress, operation) }
  const finishReplacement = beginLocalReplacementDatabaseOperation()
  try {
    return await importServerBundleImplementation(input)
  } finally {
    finishReplacement()
  }
}

async function importServerBundleImplementation(input: {
  file: Blob
  filename?: string
  signal?: AbortSignal | null
  onProgress?: ServerBackupProgressCallback
}): Promise<
  | ServerBackupResult<{
      revision: number
      event?: CommandEvent
      discardedPendingMutations: number
      assetReport: ServerBackupAssetReport
      skippedBlocks: ServerBackupSkippedBlock[]
    }>
  | UnsupportedBackupGroupsResult
  | UnsupportedStandaloneChatBlocksResult
> {
  if (!canUseServerBackups()) return { status: 'unavailable' }
  const operation = captureClientSessionGeneration()

  reportProgress(input.onProgress, {
    phase: 'prepare',
    message: 'Preparing local backup upload',
    percent: 2,
  })
  const auth = await getNodeServerProxyAuth()
  if (!isClientWriteOperationCurrent(operation)) return { status: 'unavailable' }
  const form = new FormData()
  form.append('file', input.file, input.filename ?? DEFAULT_BUNDLE_FILENAME)

  let response: Response
  try {
    if (input.onProgress) {
      response = await sendMultipartWithUploadProgress({
        endpoint: BUNDLE_IMPORT_ENDPOINT,
        form,
        headers: { 'risu-auth': auth, ...activeWriterSessionHeader() },
        signal: input.signal ?? null,
        onProgress: scaleProgress(input.onProgress, 5, 75),
      })
    } else {
      // Let the browser set the multipart content-type (with boundary) for the
      // FormData body; an explicit content-type header would break the upload.
      response = await fetch(BUNDLE_IMPORT_ENDPOINT, {
        method: 'POST',
        signal: input.signal ?? undefined,
        headers: { 'risu-auth': auth, ...activeWriterSessionHeader() },
        body: form,
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', error: `Network error: ${message}` }
  }

  reportProgress(input.onProgress, {
    phase: 'process',
    message: 'Processing local backup',
    percent: 80,
  })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // HTTP status handling below reports non-JSON failures.
  }

  if (!response.ok) {
    handleActiveWriterStaleResponse(response, body, operation)
    const unsupportedStandaloneChatBlocks = readUnsupportedStandaloneChatBlocks(body)
    if (unsupportedStandaloneChatBlocks) return unsupportedStandaloneChatBlocks
    const unsupportedGroups = readUnsupportedBackupGroups(body)
    if (unsupportedGroups) return unsupportedGroups
    return { status: 'error', error: errorMessageFromBody(body, `HTTP ${response.status}`) }
  }

  const imported = readBundleImportResult(body)
  if (imported === null) {
    return { status: 'error', error: 'Invalid bundle import response' }
  }
  if (!isClientWriteOperationCurrent(operation)) {
    return {
      status: 'ok',
      revision: imported.revision,
      discardedPendingMutations: 0,
      assetReport: imported.assetReport,
      skippedBlocks: imported.skippedBlocks,
      ...(imported.event ? { event: imported.event } : {}),
    }
  }
  let discardedPendingMutations = 0
  try {
    ;({ discarded: discardedPendingMutations } = await adoptReplacementDatabaseOwnership(imported))

    reportProgress(input.onProgress, {
      phase: 'resync',
      message: 'Refreshing local state',
      percent: 90,
    })
    if (!isClientWriteOperationCurrent(operation))
      return {
        status: 'ok',
        revision: imported.revision,
        discardedPendingMutations,
        assetReport: imported.assetReport,
        skippedBlocks: imported.skippedBlocks,
        ...(imported.event ? { event: imported.event } : {}),
      }
    const resync = await forceServerDatabaseReplacementRefresh('bundle-restore')
    if (resync.status !== 'ok') {
      return {
        status: 'error',
        ...(discardedPendingMutations > 0 ? { discardedPendingMutations } : {}),
        error:
          resync.status === 'unavailable'
            ? 'Backup imported, but server resource APIs are unavailable; reload to refresh local state.'
            : `Backup imported, but resource refresh failed: ${resync.error}`,
      }
    }
    if (isClientWriteOperationCurrent(operation)) await showLegacyMemoryMigrationNoticeAfterReplacement(operation)
    reportProgress(input.onProgress, {
      phase: 'complete',
      message: 'Local backup loaded',
      percent: 100,
    })
    return {
      status: 'ok',
      revision: imported.revision,
      discardedPendingMutations,
      assetReport: imported.assetReport,
      skippedBlocks: imported.skippedBlocks,
      ...(imported.event ? { event: imported.event } : {}),
    }
  } catch (error) {
    return {
      status: 'error',
      ...(discardedPendingMutations > 0 ? { discardedPendingMutations } : {}),
      error: `Backup imported, but resource refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function readUnsupportedStandaloneChatBlocks(body: unknown): UnsupportedStandaloneChatBlocksResult | null {
  if (!body || typeof body !== 'object') return null
  const record = body as { code?: unknown; error?: unknown }
  if (record.code !== 'unsupported-standalone-chat-blocks' || typeof record.error !== 'string') return null
  return {
    status: 'unsupported-chat-blocks',
    error: record.error,
  }
}

async function showLegacyMemoryMigrationNoticeAfterReplacement(operation: number): Promise<void> {
  const { showLegacyMemoryMigrationNoticeIfNeeded } = await import('../process/legacyMemoryMigrationNotice')
  if (isClientWriteOperationCurrent(operation)) showLegacyMemoryMigrationNoticeIfNeeded()
}

function readUnsupportedBackupGroups(body: unknown): UnsupportedBackupGroupsResult | null {
  if (!body || typeof body !== 'object') return null
  const record = body as {
    code?: unknown
    error?: unknown
    unsupportedGroupCount?: unknown
    unsupportedGroups?: unknown
  }
  if (
    record.code !== 'unsupported-group-characters' ||
    typeof record.error !== 'string' ||
    !Number.isSafeInteger(record.unsupportedGroupCount) ||
    (record.unsupportedGroupCount as number) < 1 ||
    !Array.isArray(record.unsupportedGroups)
  ) {
    return null
  }
  const groups: UnsupportedBackupGroup[] = []
  for (const group of record.unsupportedGroups) {
    if (!group || typeof group !== 'object') return null
    const candidate = group as { id?: unknown; name?: unknown }
    const id = typeof candidate.id === 'string' ? candidate.id : candidate.id === null ? null : undefined
    const name = typeof candidate.name === 'string' ? candidate.name : candidate.name === null ? null : undefined
    if (id === undefined || name === undefined) return null
    groups.push({ id, name })
  }
  return {
    status: 'unsupported-groups',
    count: record.unsupportedGroupCount as number,
    groups,
    error: record.error,
  }
}

function guardWriterProgress(
  onProgress: ServerBackupProgressCallback | undefined,
  operation: number,
): ServerBackupProgressCallback | undefined {
  return onProgress
    ? (progress) => {
        if (isClientWriteOperationCurrent(operation)) onProgress(progress)
      }
    : undefined
}

function reportProgress(onProgress: ServerBackupProgressCallback | undefined, progress: ServerBackupProgress): void {
  if (!onProgress) return
  const percent = progress.percent === null ? null : Math.max(0, Math.min(100, Number(progress.percent)))
  onProgress({ ...progress, percent })
}

function scaleProgress(
  onProgress: ServerBackupProgressCallback | undefined,
  start: number,
  end: number,
): ServerBackupProgressCallback | undefined {
  if (!onProgress) return undefined
  return (progress) => {
    reportProgress(onProgress, {
      ...progress,
      percent:
        progress.percent === null ? null : start + ((end - start) * Math.max(0, Math.min(100, progress.percent))) / 100,
    })
  }
}

function normalizeProgressOptions(
  options?: AbortSignal | ServerBackupProgressOptions | null,
): ServerBackupProgressOptions {
  if (!options) return {}
  if (isAbortSignal(options)) return { signal: options }
  return options
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function'
  )
}

async function readResponseBlobWithProgress(
  response: Response,
  onProgress: ServerBackupProgressCallback | undefined,
  message: string,
): Promise<Blob> {
  if (!onProgress || !response.body) {
    // Read as a Blob (not an ArrayBuffer) so the browser can back large backups
    // by disk instead of holding the whole bundle in a single buffer.
    return response.blob()
  }

  const contentLengthBytes = parseContentLength(response.headers.get('content-length'))
  const estimatedContentLengthBytes =
    contentLengthBytes === null ? parseContentLength(response.headers.get(ESTIMATED_BACKUP_BYTES_HEADER)) : null
  const totalBytes = contentLengthBytes ?? estimatedContentLengthBytes
  const estimatedTotalBytes = contentLengthBytes === null && estimatedContentLengthBytes !== null
  let loadedBytes = 0
  reportProgress(onProgress, {
    phase: 'download',
    message,
    percent: totalBytes === null ? null : 0,
    loadedBytes,
    totalBytes,
    estimatedTotalBytes,
  })

  const reader = response.body.getReader()
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const read = await reader.read()
      if (read.done) {
        controller.close()
        return
      }
      loadedBytes += read.value.byteLength
      reportProgress(onProgress, {
        phase: 'download',
        message,
        percent: totalBytes === null ? null : downloadPercent(loadedBytes, totalBytes, estimatedTotalBytes),
        loadedBytes,
        totalBytes,
        estimatedTotalBytes,
      })
      controller.enqueue(read.value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  const headers = new Headers()
  const contentType = response.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  return new Response(stream, { headers }).blob()
}

function downloadPercent(loadedBytes: number, totalBytes: number, estimatedTotalBytes: boolean) {
  const percent = (loadedBytes / Math.max(totalBytes, 1)) * 100
  return estimatedTotalBytes ? Math.min(99, percent) : percent
}

function parseContentLength(header: string | null): number | null {
  if (!header) return null
  const value = Number(header)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function sendMultipartWithUploadProgress(input: {
  endpoint: string
  form: FormData
  headers: Record<string, string>
  signal: AbortSignal | null
  onProgress: ServerBackupProgressCallback
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error('request aborted'))
      return
    }

    const xhr = new XMLHttpRequest()
    const cleanup = () => {
      input.signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      xhr.abort()
    }

    xhr.open('POST', input.endpoint)
    for (const [key, value] of Object.entries(input.headers)) {
      xhr.setRequestHeader(key, value)
    }
    xhr.upload.onprogress = (event) => {
      reportProgress(input.onProgress, {
        phase: 'upload',
        message: 'Uploading local backup',
        percent: event.lengthComputable ? (event.loaded / Math.max(event.total, 1)) * 100 : null,
        loadedBytes: event.loaded,
        totalBytes: event.lengthComputable ? event.total : null,
      })
    }
    xhr.onload = () => {
      cleanup()
      resolve(
        new Response(xhr.responseText, {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: parseXhrHeaders(xhr.getAllResponseHeaders()),
        }),
      )
    }
    xhr.onerror = () => {
      cleanup()
      reject(new Error('request failed'))
    }
    xhr.onabort = () => {
      cleanup()
      reject(new Error('request aborted'))
    }

    input.signal?.addEventListener('abort', abort, { once: true })
    xhr.send(input.form)
  })
}

function parseXhrHeaders(rawHeaders: string): Headers {
  const headers = new Headers()
  for (const line of rawHeaders.trim().split(/[\r\n]+/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim())
  }
  return headers
}

function readBundleImportResult(body: unknown): {
  revision: number
  event?: CommandEvent
  databaseLineage: string
  writerEpoch: number
  assetReport: ServerBackupAssetReport
  skippedBlocks: ServerBackupSkippedBlock[]
} | null {
  if (!body || typeof body !== 'object') return null
  const record = body as {
    revision?: unknown
    event?: unknown
    databaseLineage?: unknown
    writerEpoch?: unknown
    assetReport?: unknown
    importReport?: unknown
  }
  if (!Number.isInteger(record.revision) || (record.revision as number) < 0) return null
  const ownership = readDatabaseOwnership(record)
  if (!ownership) return null
  const assetReport = readServerBackupAssetReport(record.assetReport)
  if (!assetReport) return null
  const skippedBlocks = readServerBackupSkippedBlocks(record.importReport)
  if (!skippedBlocks) return null
  return {
    revision: record.revision as number,
    ...(isCommandEvent(record.event) ? { event: record.event } : {}),
    ...ownership,
    assetReport,
    skippedBlocks,
  }
}

function readServerBackupSkippedBlocks(value: unknown): ServerBackupSkippedBlock[] | null {
  if (value === undefined) return []
  if (!value || typeof value !== 'object') return null
  const skippedBlocks = (value as { skippedBlocks?: unknown }).skippedBlocks
  if (skippedBlocks === undefined) return []
  if (!Array.isArray(skippedBlocks)) return null
  const parsed: ServerBackupSkippedBlock[] = []
  for (const block of skippedBlocks) {
    if (!block || typeof block !== 'object') return null
    const record = block as { name?: unknown; type?: unknown }
    if (typeof record.name !== 'string' || record.type !== 'CHAT') return null
    parsed.push({ name: record.name, type: 'CHAT' })
  }
  return parsed
}

function readServerBackupAssetReport(value: unknown): ServerBackupAssetReport | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<keyof ServerBackupAssetReport, unknown>
  if (
    !Number.isSafeInteger(record.referencedCount) ||
    (record.referencedCount as number) < 0 ||
    !Number.isSafeInteger(record.missingCount) ||
    (record.missingCount as number) < 0 ||
    !Number.isSafeInteger(record.orphanedCount) ||
    (record.orphanedCount as number) < 0
  ) {
    return null
  }
  return {
    referencedCount: record.referencedCount as number,
    missingCount: record.missingCount as number,
    orphanedCount: record.orphanedCount as number,
  }
}

function readDatabaseOwnership(record: {
  databaseLineage?: unknown
  writerEpoch?: unknown
}): { databaseLineage: string; writerEpoch: number } | null {
  if (typeof record.databaseLineage !== 'string' || record.databaseLineage.trim().length === 0) return null
  if (!Number.isSafeInteger(record.writerEpoch) || (record.writerEpoch as number) < 0) return null
  return {
    databaseLineage: record.databaseLineage,
    writerEpoch: record.writerEpoch as number,
  }
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null
  const match = /filename="?([^"]+)"?/i.exec(header)
  return match ? match[1] : null
}

async function requestServerBackupJson<T, R extends Record<string, unknown>>(
  path: string,
  init: {
    method: string
    body?: unknown
    signal?: AbortSignal | null
    validate: (body: unknown) => T | null
    map: (value: T) => R
  },
): Promise<ServerBackupResult<R>> {
  const operation = captureClientSessionGeneration()
  const mutation = init.method !== 'GET'
  if (mutation && !canUseClientWriteAccess()) return { status: 'unavailable' }

  const auth = await getNodeServerProxyAuth()
  if (mutation && !isClientWriteOperationCurrent(operation)) return { status: 'unavailable' }
  let response: Response
  try {
    response = await fetch(`${BACKUPS_ENDPOINT}${path}`, {
      method: init.method,
      signal: init.signal ?? undefined,
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        'risu-auth': auth,
        ...activeWriterSessionHeader(),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', error: `Network error: ${message}` }
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // HTTP status handling below reports non-JSON failures.
  }

  if (!response.ok) {
    handleActiveWriterStaleResponse(response, body, operation)
    return { status: 'error', error: errorMessageFromBody(body, `HTTP ${response.status}`) }
  }

  const parsed = init.validate(body)
  if (parsed === null) {
    return { status: 'error', error: 'Invalid backup response' }
  }

  return { status: 'ok', ...init.map(parsed) }
}

function readBackupManifest(value: unknown): ServerBackupManifest | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record._version !== 1) return null
  if (typeof record.id !== 'string') return null
  if (record.label !== null && typeof record.label !== 'string') return null
  if (record.kind !== undefined && record.kind !== 'manual' && record.kind !== 'automatic') return null
  if (typeof record.createdAt !== 'string') return null
  if (!Number.isInteger(record.revision) || (record.revision as number) < 0) return null
  if (!Number.isInteger(record.assetCount) || (record.assetCount as number) < 0) return null
  return record as unknown as ServerBackupManifest
}

function isCommandEvent(value: unknown): value is CommandEvent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.type === 'string' &&
    Number.isInteger(record.revision) &&
    (record.revision as number) >= 0 &&
    typeof record.resource === 'string' &&
    (record.id === undefined || typeof record.id === 'string') &&
    (record.parentId === undefined || typeof record.parentId === 'string')
  )
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (typeof record.error === 'string') return record.error
    if (typeof record.reason === 'string') return record.reason
  }
  return fallback
}
