// This source-only server runs on Node >=24. The worker uses native type
// stripping, with no tsx loader, app imports or authoritative database access.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import type {
  BackupCopyEntry,
  BackupCopyFailure,
  BackupCopyRequest,
  BackupCopyResponse,
  BackupCopyWorkerData,
} from './backupCopyProtocol.js'

const port = parentPort!
const options = workerData as BackupCopyWorkerData
const cancellation = new Int32Array(options.cancellation)
const hashBuffer = Buffer.allocUnsafe(options.hashBufferBytes)

function checkCancellation(): void {
  if (Atomics.load(cancellation, 0)) throw new DOMException('Backup copy cancelled', 'AbortError')
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function invalidAsset(message: string): never {
  throw Object.assign(new Error(message), { name: 'BackupAssetError', code: 'backup_asset_invalid' })
}

function copyAssetFile(from: string, to: string, id: string): void {
  if (fs.lstatSync(from).isSymbolicLink()) invalidAsset(`Backup asset symbolic links are not supported: ${id}`)
  fs.copyFileSync(from, to)
}

function verifyAsset(file: string, asset: Extract<BackupCopyEntry, { kind: 'asset' }>): void {
  const descriptor = fs.openSync(file, 'r')
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size !== asset.size) invalidAsset(`Backup asset size mismatch: ${asset.id}`)
    const hash = createHash('sha256')
    while (true) {
      checkCancellation()
      const read = fs.readSync(descriptor, hashBuffer, 0, hashBuffer.length, null)
      if (!read) break
      hash.update(hashBuffer.subarray(0, read))
    }
    if (hash.digest('hex') !== asset.id) invalidAsset(`Backup asset hash mismatch: ${asset.id}`)
  } finally {
    fs.closeSync(descriptor)
  }
}

function copy(entry: BackupCopyEntry): void {
  checkCancellation()
  if (entry.kind === 'file') {
    if (entry.symbolicLink) fs.symlinkSync(fs.readlinkSync(entry.from), entry.to)
    else fs.copyFileSync(entry.from, entry.to)
  } else {
    try {
      copyAssetFile(entry.from, entry.to, entry.id)
    } catch (error) {
      if (!isMissing(error)) throw error
      if (!entry.required) return
      if (!entry.fallback) invalidAsset(`Required backup asset is missing: ${entry.id}`)
      checkCancellation()
      try {
        copyAssetFile(entry.fallback, entry.to, entry.id)
      } catch (fallbackError) {
        if (!isMissing(fallbackError)) throw fallbackError
        invalidAsset(`Required backup asset is missing from live and restore source: ${entry.id}`)
      }
    }
    checkCancellation()
    // Optional orphan bytes retain their existing damage/missing state.
    if (entry.required) verifyAsset(entry.to, entry)
  }
  checkCancellation()
}

function serializeFailure(error: unknown): BackupCopyFailure {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  return {
    name: error.name,
    message: error.message,
    ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
  }
}

function respond(response: BackupCopyResponse): void {
  port.postMessage(response)
}

port.on('message', (request: BackupCopyRequest) => {
  if (request.kind === 'close') {
    port.close()
    return
  }
  try {
    if (request.entries.length > options.batchSize) throw new Error('backup_copy_batch_limit_exceeded')
    for (const entry of request.entries) copy(entry)
    respond({ kind: 'copied' })
  } catch (error) {
    respond({ kind: 'copied', error: serializeFailure(error) })
  }
})
respond({ kind: 'ready' })
