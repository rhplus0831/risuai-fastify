import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import type { AuthState } from '../auth.js'
import { requireAuth } from '../http.js'
import { authCryptoRateLimit } from '../routeRateLimits.js'
import { getMaintenanceCoordinator, MaintenanceBusyError } from '../maintenanceCoordinator.js'
import { attachMaintenanceAbort } from '../maintenanceRequest.js'
import { allowApplicationFileRead } from '../diagnosticsStaticFiles.js'

const HEX_RE = /^[0-9a-fA-F]+$/
const LEGACY_STORAGE_TEMP_PREFIX = '.legacy-storage-'
const DIRECTORY_FSYNC_UNSUPPORTED_CODES = new Set(['EISDIR', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'])

function isHexFilename(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && HEX_RE.test(value)
}

function ensureSaveDir(dataDir: string): string {
  const savePath = path.join(dataDir, 'save')
  fs.mkdirSync(savePath, { recursive: true })
  return savePath
}

/**
 * Read one value from the pre-Fastify key/value store without going through an
 * HTTP round trip. Internal migrations use this after the request has already
 * passed the normal auth gate. Keys are encoded exactly like FastifyStorage's
 * `file-path` header, so legacy sidecars remain byte-for-byte untouched.
 */
export async function readLegacyStorageValue(dataDir: string, storageKey: string): Promise<Buffer | null> {
  const savePath = ensureSaveDir(dataDir)
  const filePath = Buffer.from(storageKey, 'utf8').toString('hex')
  try {
    return await fs.promises.readFile(path.join(savePath, filePath))
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null
    throw err
  }
}

function legacyStorageTempPath(savePath: string): string {
  return path.join(savePath, `${LEGACY_STORAGE_TEMP_PREFIX}${process.pid}-${randomUUID()}.tmp`)
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function isUnsupportedDirectoryFsyncError(err: unknown): boolean {
  const code = errorCode(err)
  return code !== undefined && DIRECTORY_FSYNC_UNSUPPORTED_CODES.has(code)
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'r')
  let syncError: unknown
  try {
    await handle.sync()
  } catch (err) {
    syncError = err
    throw err
  } finally {
    try {
      await handle.close()
    } catch (err) {
      if (syncError === undefined) throw err
    }
  }
}

async function syncDirectoryIfAvailable(dirPath: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await fs.promises.open(dirPath, 'r')
    await handle.sync()
  } catch (err) {
    if (isUnsupportedDirectoryFsyncError(err)) return
    throw err
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

async function writeLegacyStorageFileAtomic(
  savePath: string,
  filePath: string,
  body: Buffer,
  signal: AbortSignal,
): Promise<void> {
  const finalPath = path.join(savePath, filePath)
  const tempPath = legacyStorageTempPath(savePath)
  let renamed = false
  try {
    await fs.promises.writeFile(tempPath, body, { flag: 'wx', signal })
    await syncFile(tempPath)
    signal.throwIfAborted()
    await fs.promises.rename(tempPath, finalPath)
    renamed = true
    // Once the replacement is visible, finish its durability work even if the
    // request or shutdown signal is cancelled while rename is in flight.
    await syncDirectoryIfAvailable(savePath)
  } finally {
    if (!renamed) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {})
    }
  }
}

interface CryptoBody {
  data?: unknown
}

export function registerLegacyStorageRoutes(
  app: FastifyInstance,
  authState: AuthState,
  dataDir: string,
  canReadFile: (file: string) => boolean = (file) => allowApplicationFileRead({ dataDir }, file),
): void {
  app.register(async (instance) => {
    instance.removeAllContentTypeParsers()
    instance.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body)
    })

    instance.get('/api/v1/storage/list', async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      const savePath = ensureSaveDir(dataDir)
      const entries = await fs.promises.readdir(savePath)
      const content = entries
        .filter((name) => HEX_RE.test(name))
        .map((name) => Buffer.from(name, 'hex').toString('utf-8'))
      return { success: true, content }
    })

    instance.get('/api/v1/storage/exists', async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      const raw = req.headers['file-path']
      const filePath = Array.isArray(raw) ? raw[0] : raw
      if (!filePath) {
        reply.code(400)
        return { error: 'File path required' }
      }
      if (!isHexFilename(filePath)) {
        reply.code(400)
        return { error: 'Invalid path' }
      }
      const savePath = ensureSaveDir(dataDir)
      return { success: true, exists: fs.existsSync(path.join(savePath, filePath)) }
    })

    instance.get('/api/v1/storage/read', async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      const raw = req.headers['file-path']
      const filePath = Array.isArray(raw) ? raw[0] : raw
      if (!filePath) {
        reply.code(400)
        return { error: 'File path required' }
      }
      if (!isHexFilename(filePath)) {
        reply.code(400)
        return { error: 'Invalid path' }
      }
      const savePath = ensureSaveDir(dataDir)
      const onDisk = path.join(savePath, filePath)
      if (!fs.existsSync(onDisk)) {
        reply.header('content-type', 'application/octet-stream')
        return reply.send()
      }
      if (!canReadFile(onDisk)) return reply.code(404).send({ error: 'not found' })
      reply.header('content-type', 'application/octet-stream')
      return reply.send(fs.createReadStream(onDisk))
    })

    instance.post('/api/v1/storage/write', async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      const raw = req.headers['file-path']
      const filePath = Array.isArray(raw) ? raw[0] : raw
      if (!filePath) {
        reply.code(400)
        return { error: 'File path required' }
      }
      if (!isHexFilename(filePath)) {
        reply.code(400)
        return { error: 'Invalid path' }
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        reply.code(400)
        return { error: 'Body required' }
      }
      const requestAbort = attachMaintenanceAbort(req, reply)
      try {
        const lease = getMaintenanceCoordinator(dataDir).beginSaveMutation(requestAbort.signal)
        try {
          const savePath = ensureSaveDir(dataDir)
          await writeLegacyStorageFileAtomic(savePath, filePath, req.body, lease.signal)
          return { success: true }
        } finally {
          lease.release()
        }
      } catch (error) {
        if (error instanceof MaintenanceBusyError) {
          reply.code(503)
          return { error: error.code, code: error.code }
        }
        throw error
      } finally {
        requestAbort.cleanup()
      }
    })

    instance.post('/api/v1/storage/remove', async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      const raw = req.headers['file-path']
      const header = Array.isArray(raw) ? raw[0] : raw
      if (!header) {
        reply.code(400)
        return { error: 'File path required' }
      }
      const filePaths = header.split('$$').filter((p) => p.length > 0)
      for (const filePath of filePaths) {
        if (!isHexFilename(filePath)) {
          reply.code(400)
          return { error: 'Invalid path' }
        }
      }
      const requestAbort = attachMaintenanceAbort(req, reply)
      try {
        const lease = getMaintenanceCoordinator(dataDir).beginSaveMutation(requestAbort.signal)
        try {
          const savePath = ensureSaveDir(dataDir)
          for (const filePath of filePaths) {
            lease.signal.throwIfAborted()
            const onDisk = path.join(savePath, filePath)
            try {
              await fs.promises.rm(onDisk, { force: true })
            } catch (err) {
              req.log.warn({ err, filePath }, 'storage remove failed')
            }
          }
          return { success: true }
        } finally {
          lease.release()
        }
      } catch (error) {
        if (error instanceof MaintenanceBusyError) {
          reply.code(503)
          return { error: error.code, code: error.code }
        }
        throw error
      } finally {
        requestAbort.cleanup()
      }
    })
  })

  app.post('/api/v1/auth/crypto', { config: { rateLimit: authCryptoRateLimit } }, async (req, reply) => {
    const body = (req.body ?? {}) as CryptoBody
    if (typeof body.data !== 'string') {
      reply.code(400)
      return { error: 'data: string required' }
    }
    const hash = createHash('sha256')
    hash.update(Buffer.from(body.data, 'utf-8'))
    return hash.digest('hex')
  })
}
