import fs from 'node:fs'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { requireActiveWriter, type ActiveWriterState } from '../activeWriter.js'
import type { AuthState } from '../auth.js'
import { getSchemaState } from '../db.js'
import { PREFER_RETURN_MINIMAL, prefersMinimalResponse, requireAuth } from '../http.js'
import {
  ValidationError,
  addAsset,
  addAssets,
  assetById,
  assetPath,
  isValidAssetId,
  missingAssetIds,
  type AddAssetResult,
} from '../repository.js'
import { assetExistsRateLimit } from '../routeRateLimits.js'
import { emitProtocolMetric } from '../protocolMetrics.js'
import { allowApplicationFileRead } from '../diagnosticsStaticFiles.js'

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
export const ASSET_BULK_BINARY_CONTENT_TYPE = 'application/vnd.risu.assets-bulk'
export const ASSET_EXISTS_MAX_IDS = 1024
const ASSET_EXISTS_BODY_LIMIT = 128 * 1024

interface ExistsBody {
  ids?: unknown
}

interface BulkAssetsBody {
  assets?: unknown
}

interface BulkAssetBinaryManifest {
  assets?: unknown
}

interface FastifyValidationError {
  validation?: Array<{
    dataPath?: string
    instancePath?: string
    keyword?: string
  }>
}

const existsBodySchema = {
  body: {
    type: 'object',
    required: ['ids'],
    additionalProperties: true,
    properties: {
      ids: {
        type: 'array',
        maxItems: ASSET_EXISTS_MAX_IDS,
        items: { type: 'string' },
      },
    },
  },
} as const

function applyAssetHeaders(reply: FastifyReply, contentType: string, size: number): void {
  reply.header('content-type', contentType)
  reply.header('cache-control', IMMUTABLE_CACHE)
  reply.header('content-length', String(size))
}

function assetUploadResponse(result: AddAssetResult): {
  assetId: string
  size: number
  contentType: string
  revision: number
  created: boolean
} {
  return {
    assetId: result.entry.id,
    size: result.entry.size,
    contentType: result.entry.contentType,
    revision: result.revision,
    created: result.created,
  }
}

function readAttachedValidationError(req: { validationError?: unknown }): unknown {
  return req.validationError
}

function assetExistsValidationErrorMessage(error: unknown): string {
  const validation = (error as FastifyValidationError | undefined)?.validation ?? []
  if (validation.some((entry) => entry.keyword === 'maxItems')) {
    return `ids must contain at most ${ASSET_EXISTS_MAX_IDS} items`
  }
  const hasInvalidItem = validation.some((entry) => {
    const path = entry.instancePath ?? entry.dataPath ?? ''
    return entry.keyword === 'type' && /^\/ids\/\d+$/.test(path)
  })
  return hasInvalidItem ? 'ids must be sha256 hex strings' : 'ids: string[] required'
}

async function validateAssetExistsEnvelope(req: { body?: unknown }, reply: FastifyReply): Promise<void> {
  const body = (req.body ?? {}) as ExistsBody
  if (!Array.isArray(body.ids)) {
    reply.code(400).send({ error: 'ids: string[] required' })
  }
}

function emitAssetByteReadMetric(
  logger: FastifyInstance['log'],
  assetId: string,
  found: boolean,
  contentType?: string,
  size?: number,
): void {
  emitProtocolMetric(
    'asset_byte_read',
    {
      assetId,
      found,
      ...(contentType !== undefined ? { contentType } : {}),
      ...(size !== undefined ? { size } : {}),
    },
    logger,
  )
}

function readJsonBulkAssets(body: BulkAssetsBody): { bytes: Buffer; contentType: string }[] {
  if (!Array.isArray(body.assets)) {
    throw new ValidationError('assets: { contentType: string; data: base64 }[] required')
  }
  return body.assets.map((asset, index) => {
    if (!asset || typeof asset !== 'object') {
      throw new ValidationError(`assets[${index}] must be an object`)
    }
    const record = asset as Record<string, unknown>
    if (typeof record.contentType !== 'string') {
      throw new ValidationError(`assets[${index}].contentType must be a string`)
    }
    if (typeof record.data !== 'string' || !BASE64_RE.test(record.data)) {
      throw new ValidationError(`assets[${index}].data must be base64`)
    }
    return {
      contentType: record.contentType,
      bytes: Buffer.from(record.data, 'base64'),
    }
  })
}

function readBinaryBulkAssets(body: Buffer): { bytes: Buffer; contentType: string }[] {
  if (body.byteLength < 4) {
    throw new ValidationError('binary bulk asset body must start with a manifest length')
  }
  const manifestLength = body.readUInt32BE(0)
  const manifestStart = 4
  const assetBytesStart = manifestStart + manifestLength
  if (manifestLength === 0 || assetBytesStart > body.byteLength) {
    throw new ValidationError('binary bulk asset manifest is invalid')
  }

  let manifest: BulkAssetBinaryManifest
  try {
    manifest = JSON.parse(body.subarray(manifestStart, assetBytesStart).toString('utf8')) as BulkAssetBinaryManifest
  } catch {
    throw new ValidationError('binary bulk asset manifest must be JSON')
  }
  if (!Array.isArray(manifest.assets)) {
    throw new ValidationError('binary bulk asset manifest assets required')
  }

  let offset = assetBytesStart
  const uploads = manifest.assets.map((asset, index) => {
    if (!asset || typeof asset !== 'object') {
      throw new ValidationError(`assets[${index}] must be an object`)
    }
    const record = asset as Record<string, unknown>
    if (typeof record.contentType !== 'string') {
      throw new ValidationError(`assets[${index}].contentType must be a string`)
    }
    if (typeof record.size !== 'number' || !Number.isSafeInteger(record.size) || record.size < 0) {
      throw new ValidationError(`assets[${index}].size must be a non-negative integer`)
    }
    const nextOffset = offset + record.size
    if (nextOffset > body.byteLength) {
      throw new ValidationError(`assets[${index}] exceeds binary bulk asset body length`)
    }
    const bytes = body.subarray(offset, nextOffset)
    offset = nextOffset
    return {
      contentType: record.contentType,
      bytes,
    }
  })
  if (offset !== body.byteLength) {
    throw new ValidationError('binary bulk asset body has trailing bytes')
  }
  return uploads
}

function readBulkAssets(body: unknown): { bytes: Buffer; contentType: string }[] {
  if (Buffer.isBuffer(body)) {
    return readBinaryBulkAssets(body)
  }
  return readJsonBulkAssets((body ?? {}) as BulkAssetsBody)
}

export function registerAssetsRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  authState: AuthState,
  dataDir: string,
  activeWriterState: ActiveWriterState,
  canReadFile: (file: string) => boolean = (file) => allowApplicationFileRead({ dataDir }, file),
): void {
  const requireUploadAccess = async (req: Parameters<typeof requireAuth>[1], reply: FastifyReply) => {
    if (!(await requireAuth(authState, req, reply))) return
    requireActiveWriter(activeWriterState, req, reply)
  }

  app.post('/api/v1/assets', { onRequest: requireUploadAccess }, async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string') {
      reply.code(400)
      return { error: 'Content-Type header required' }
    }
    if (!Buffer.isBuffer(req.body)) {
      reply.code(400)
      return { error: 'Body must be raw bytes of a supported asset type' }
    }
    try {
      const result = addAsset(db, dataDir, { bytes: req.body, contentType })
      reply.code(result.created ? 201 : 200)
      if (prefersMinimalResponse(req.headers.prefer)) {
        reply.header('preference-applied', PREFER_RETURN_MINIMAL)
        return {
          assetId: result.entry.id,
          revision: result.revision,
        }
      }
      return {
        assetId: result.entry.id,
        size: result.entry.size,
        contentType: result.entry.contentType,
        revision: result.revision,
      }
    } catch (err) {
      if (err instanceof ValidationError) {
        reply.code(400)
        return { error: err.message }
      }
      throw err
    }
  })

  app.post('/api/v1/assets/bulk', { onRequest: requireUploadAccess }, async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    try {
      const uploads = readBulkAssets(req.body)
      const results = addAssets(db, dataDir, uploads)
      reply.code(results.some((result) => result.created) ? 201 : 200)
      const revision = results.at(-1)?.revision ?? getSchemaState(db).revision
      if (prefersMinimalResponse(req.headers.prefer)) {
        reply.header('preference-applied', PREFER_RETURN_MINIMAL)
        return {
          assetIds: results.map((result) => result.entry.id),
          revision,
        }
      }
      return {
        assets: results.map(assetUploadResponse),
        revision,
      }
    } catch (err) {
      if (err instanceof ValidationError) {
        reply.code(400)
        return { error: err.message }
      }
      throw err
    }
  })

  app.get<{ Params: { id: string } }>('/api/v1/assets/:id', { exposeHeadRoute: false }, async (req, reply) => {
    const entry = assetById(db, req.params.id)
    if (!entry) {
      emitAssetByteReadMetric(req.log, req.params.id, false)
      reply.code(404).send({ error: 'not found' })
      return
    }
    const file = assetPath(dataDir, entry)
    if (!fs.existsSync(file) || !canReadFile(file)) {
      emitAssetByteReadMetric(req.log, req.params.id, false)
      reply.code(404).send({ error: 'not found' })
      return
    }
    // Measurement-only: count every single-asset byte read at the response
    // boundary, including JS-driven and `<img src>` fetches.
    emitAssetByteReadMetric(req.log, req.params.id, true, entry.contentType, entry.size)
    applyAssetHeaders(reply, entry.contentType, entry.size)
    return reply.send(fs.createReadStream(file))
  })

  app.head<{ Params: { id: string } }>('/api/v1/assets/:id', async (req, reply) => {
    const entry = assetById(db, req.params.id)
    if (!entry) {
      reply.code(404).send()
      return
    }
    const file = assetPath(dataDir, entry)
    if (!fs.existsSync(file) || !canReadFile(file)) {
      reply.code(404).send()
      return
    }
    applyAssetHeaders(reply, entry.contentType, entry.size)
    reply.code(200).send()
  })

  app.post(
    '/api/v1/assets/exists',
    {
      attachValidation: true,
      bodyLimit: ASSET_EXISTS_BODY_LIMIT,
      config: { rateLimit: assetExistsRateLimit },
      preValidation: validateAssetExistsEnvelope,
      schema: existsBodySchema,
    },
    async (req, reply) => {
      const validationError = readAttachedValidationError(req)
      if (validationError) {
        reply.code(400)
        return { error: assetExistsValidationErrorMessage(validationError) }
      }
      const body = (req.body ?? {}) as ExistsBody
      if (!Array.isArray(body.ids)) {
        reply.code(400)
        return { error: 'ids: string[] required' }
      }
      const validIds = new Set<string>()
      for (const id of body.ids) {
        if (typeof id !== 'string' || !isValidAssetId(id)) {
          reply.code(400)
          return { error: 'ids must be sha256 hex strings' }
        }
        validIds.add(id)
      }
      return { missing: missingAssetIds(db, [...validIds]) }
    },
  )
}
