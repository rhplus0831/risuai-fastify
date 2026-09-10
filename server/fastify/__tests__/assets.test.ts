import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs, { mkdtempSync, rmSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, webcrypto } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { buildApp } from '../src/app.js'
import { ACTIVE_WRITER_SESSION_HEADER } from '../src/activeWriter.js'
import { createCommandEventSink, type CommandEventSink } from '../src/commands/events.js'
import { getAllAssetMetadata, insertAssetMetadataBatch, loadPersisted } from '../src/repository.js'
import { ASSET_BULK_BINARY_CONTENT_TYPE } from '../src/routes/assets.js'
import { assetExistsRateLimit } from '../src/routeRateLimits.js'
import type { FastifyInstance } from 'fastify'

interface AssetByteReadMetric {
  metric: string
  assetId?: string
  found?: boolean
  contentType?: string
  size?: number
}

// Capture opt-in protocol metrics regardless of the logger sink so the
// asset-byte fanout measurement can count per-id byte reads at the route.
const capturedMetrics = vi.hoisted((): AssetByteReadMetric[] => [])

vi.mock('../src/protocolMetrics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/protocolMetrics.js')>()
  return {
    ...actual,
    emitProtocolMetric: (name: string, fields: Record<string, unknown> | (() => Record<string, unknown>)) => {
      if (!actual.protocolMetricsEnabled()) return
      capturedMetrics.push({
        metric: name,
        ...(typeof fields === 'function' ? fields() : fields),
      } as AssetByteReadMetric)
    },
  }
})

const subtle = webcrypto.subtle

interface Harness {
  app: FastifyInstance
  dataDir: string
  commandEvents: CommandEventSink
}

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-'))
  const commandEvents = createCommandEventSink()
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    commandEvents,
  })
  return { app, dataDir, commandEvents }
}

async function stopHarness(h: Harness): Promise<void> {
  await h.app.close()
  rmSync(h.dataDir, { recursive: true, force: true })
}

async function signAssertion(privateKey: CryptoKey, publicJwk: JsonWebKey, ttlSec = 60): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'ES256', typ: 'JWT' }
  const payload = { iat: now, exp: now + ttlSec, pub: publicJwk }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signingInput = `${headerB64}.${payloadB64}`
  const signature = await subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    Buffer.from(signingInput),
  )
  const sigB64 = Buffer.from(signature).toString('base64url')
  return `${signingInput}.${sigB64}`
}

async function setupAuthedClient(app: FastifyInstance): Promise<{ assertion: string }> {
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { password: 'hunter2' },
  })
  expect(setup.statusCode).toBe(200)

  const keypair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicKey = await subtle.exportKey('jwk', keypair.publicKey)

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'hunter2', publicKey },
  })
  expect(login.statusCode).toBe(200)

  const assertion = await signAssertion(keypair.privateKey, publicKey)
  return { assertion }
}

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)
const PNG_SHA = createHash('sha256').update(PNG_BYTES).digest('hex')
const JPEG_BYTES = Buffer.from('ffd8ffe000104a4649460001ffd9', 'hex')
const JPEG_SHA = createHash('sha256').update(JPEG_BYTES).digest('hex')
const AAC_BYTES = Buffer.from('fff15080001ffc0000', 'hex')
const AAC_SHA = createHash('sha256').update(AAC_BYTES).digest('hex')
const OTHER_PNG_BYTES = Buffer.from('other-png-bytes')
const OTHER_PNG_SHA = createHash('sha256').update(OTHER_PNG_BYTES).digest('hex')

function buildBinaryBulkAssetBody(assets: readonly { contentType: string; bytes: Buffer }[]): Buffer {
  const manifest = Buffer.from(
    JSON.stringify({
      assets: assets.map((asset) => ({
        contentType: asset.contentType,
        size: asset.bytes.byteLength,
      })),
    }),
    'utf8',
  )
  const length = 4 + manifest.byteLength + assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0)
  const body = Buffer.alloc(length)
  body.writeUInt32BE(manifest.byteLength, 0)
  manifest.copy(body, 4)
  let offset = 4 + manifest.byteLength
  for (const asset of assets) {
    asset.bytes.copy(body, offset)
    offset += asset.bytes.byteLength
  }
  return body
}

function failCommandEventPersistence(dataDir: string): void {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    db.exec(`
      CREATE TRIGGER fail_command_event_insert
      BEFORE INSERT ON command_events
      BEGIN
        SELECT RAISE(FAIL, 'injected command event failure');
      END;
    `)
  } finally {
    db.close()
  }
}

function failWriteFileSyncWhen(predicate: (file: string) => boolean): void {
  const originalWriteFileSync = fs.writeFileSync.bind(fs) as typeof fs.writeFileSync
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((file, data, options) => {
    const filePath = typeof file === 'string' ? file : file.toString()
    if (predicate(filePath)) {
      throw new Error(`injected write failure: ${filePath}`)
    }
    return originalWriteFileSync(file as never, data as never, options as never)
  }) as typeof fs.writeFileSync)
}

let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await stopHarness(harness)
})

describe('assets', () => {
  it('rejects upload without auth once a password is set', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png' },
      payload: PNG_BYTES,
    })
    expect(res.statusCode).toBe(401)
  })

  it('does not attach request rate limits to authenticated active-writer uploads', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const raw = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    const bulk = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/bulk',
      headers: { 'risu-auth': assertion },
      payload: { assets: [{ contentType: 'image/jpeg', data: JPEG_BYTES.toString('base64') }] },
    })
    const exists = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/exists',
      payload: { ids: [PNG_SHA, JPEG_SHA] },
    })

    expect(raw.statusCode).toBe(201)
    expect(bulk.statusCode).toBe(201)
    expect(raw.headers['x-ratelimit-limit']).toBeUndefined()
    expect(bulk.headers['x-ratelimit-limit']).toBeUndefined()
    expect(exists.headers['x-ratelimit-limit']).toBe(String(assetExistsRateLimit.max))
  })

  it('rejects oversized raw upload without auth before body parsing', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png' },
      payload: Buffer.alloc(1024 * 1024 + 1),
    })

    expect(res.statusCode).toBe(401)
  })

  it('rejects stale-writer raw upload before body parsing', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, [ACTIVE_WRITER_SESSION_HEADER]: 'session-a' },
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: {
        'content-type': 'image/png',
        'risu-auth': assertion,
        [ACTIVE_WRITER_SESSION_HEADER]: 'session-b',
      },
      payload: Buffer.alloc(1024 * 1024 + 1),
    })

    expect(res.statusCode).toBe(423)
    expect(res.json()).toMatchObject({ error: 'active_writer_stale' })
  })

  it('uploads a PNG, computes sha256, writes file, returns metadata', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({
      assetId: PNG_SHA,
      size: PNG_BYTES.length,
      contentType: 'image/png',
      revision: 0,
    })
    const onDisk = path.join(harness.dataDir, 'assets', `${PNG_SHA}.png`)
    expect(existsSync(onDisk)).toBe(true)
    expect(Buffer.from(readFileSync(onDisk))).toEqual(PNG_BYTES)
  })

  it('stores a recognizable JPEG body declared as PNG under its detected type', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: JPEG_BYTES,
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({
      assetId: JPEG_SHA,
      size: JPEG_BYTES.length,
      contentType: 'image/jpeg',
      revision: 0,
    })
    expect(existsSync(path.join(harness.dataDir, 'assets', `${JPEG_SHA}.jpg`))).toBe(true)
    expect(existsSync(path.join(harness.dataDir, 'assets', `${JPEG_SHA}.png`))).toBe(false)

    const read = await harness.app.inject({ method: 'GET', url: `/api/v1/assets/${JPEG_SHA}` })
    expect(read.headers['content-type']).toBe('image/jpeg')
  })

  it('persists JPEG and AAC uploads with their detected media metadata', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const jpeg = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/jpeg', 'risu-auth': assertion },
      payload: JPEG_BYTES,
    })
    const aac = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'audio/aac', 'risu-auth': assertion },
      payload: AAC_BYTES,
    })

    expect(jpeg.statusCode).toBe(201)
    expect(jpeg.json()).toMatchObject({ assetId: JPEG_SHA, contentType: 'image/jpeg' })
    expect(aac.statusCode).toBe(201)
    expect(aac.json()).toMatchObject({ assetId: AAC_SHA, contentType: 'audio/aac' })
    expect(existsSync(path.join(harness.dataDir, 'assets', `${JPEG_SHA}.jpg`))).toBe(true)
    expect(existsSync(path.join(harness.dataDir, 'assets', `${AAC_SHA}.aac`))).toBe(true)

    const readAac = await harness.app.inject({ method: 'GET', url: `/api/v1/assets/${AAC_SHA}` })
    expect(readAac.headers['content-type']).toBe('audio/aac')
  })

  it('reports a conflict when a correct reupload finds corrupt metadata for the same hash', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const seedDb = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      insertAssetMetadataBatch(seedDb, [
        { id: JPEG_SHA, ext: 'png', size: JPEG_BYTES.byteLength, contentType: 'image/png' },
      ])
    } finally {
      seedDb.close()
    }
    const corruptFile = path.join(harness.dataDir, 'assets', `${JPEG_SHA}.png`)
    fs.mkdirSync(path.dirname(corruptFile), { recursive: true })
    fs.writeFileSync(corruptFile, JPEG_BYTES)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/jpeg', 'risu-auth': assertion },
      payload: JPEG_BYTES,
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: 'Asset content-type conflict: existing image/png, uploaded image/jpeg',
    })
  })

  it('returns a compact single-upload acknowledgement when requested', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: {
        'content-type': 'image/png',
        prefer: 'return=minimal',
        'risu-auth': assertion,
      },
      payload: PNG_BYTES,
    })

    expect(res.statusCode).toBe(201)
    expect(res.headers['preference-applied']).toBe('return=minimal')
    expect(res.json()).toEqual({ assetId: PNG_SHA, revision: 0 })
  })

  it('preserves ONNX upload metadata for transformer model assets', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const bytes = Buffer.from('onnx-model-bytes')
    const sha = createHash('sha256').update(bytes).digest('hex')

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'application/x-onnx', 'risu-auth': assertion },
      payload: bytes,
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({
      assetId: sha,
      size: bytes.length,
      contentType: 'application/x-onnx',
      revision: 0,
    })
    const onDisk = path.join(harness.dataDir, 'assets', `${sha}.onnx`)
    expect(existsSync(onDisk)).toBe(true)
    expect(Buffer.from(readFileSync(onDisk))).toEqual(bytes)
  })

  it('preserves inlay signature upload metadata without using the JSON parser', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const bytes = Buffer.from(JSON.stringify({ source: 'gemini', signatures: [] }))
    const sha = createHash('sha256').update(bytes).digest('hex')

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: {
        'content-type': 'application/x-risu-inlay-signature+json',
        'risu-auth': assertion,
      },
      payload: bytes,
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({
      assetId: sha,
      size: bytes.length,
      contentType: 'application/x-risu-inlay-signature+json',
      revision: 0,
    })
    const onDisk = path.join(harness.dataDir, 'assets', `${sha}.json`)
    expect(existsSync(onDisk)).toBe(true)
    expect(Buffer.from(readFileSync(onDisk))).toEqual(bytes)
  })

  it('keeps asset-only writes outside the projected database revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    expect(first.statusCode).toBe(201)
    expect(first.json().revision).toBe(0)
    expect(harness.commandEvents.list()).toEqual([])

    // Re-uploading identical bytes remains idempotent and revision-neutral.
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().revision).toBe(0)
    expect(harness.commandEvents.list()).toEqual([])
  })

  it('does not invalidate a revisioned command captured before an asset upload', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const initialized = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: {},
    })
    expect(initialized.statusCode).toBe(200)
    const baseRevision = initialized.json().revision as number

    const uploaded = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    expect(uploaded.statusCode).toBe(201)
    expect(uploaded.json().revision).toBe(baseRevision)

    const settings = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision,
        patch: { maxContext: 8_192 },
      },
    })
    expect(settings.statusCode).toBe(200)
    expect(settings.json().revision).toBe(baseRevision + 1)
  })

  it('does not depend on command-event persistence for asset metadata', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    failCommandEventPersistence(harness.dataDir)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })

    expect(res.statusCode).toBe(201)
    expect(harness.commandEvents.list()).toEqual([])
    const bootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(0)
    const seedDb = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(getAllAssetMetadata(seedDb)).toEqual([
        { id: PNG_SHA, ext: 'png', size: PNG_BYTES.length, contentType: 'image/png' },
      ])
    } finally {
      seedDb.close()
    }
    expect(existsSync(path.join(harness.dataDir, 'assets', `${PNG_SHA}.png`))).toBe(true)
  })

  it('does not depend on command-event persistence for bulk asset metadata', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    failCommandEventPersistence(harness.dataDir)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/bulk',
      headers: { 'risu-auth': assertion },
      payload: {
        assets: [{ contentType: 'image/png', data: PNG_BYTES.toString('base64') }],
      },
    })

    expect(res.statusCode).toBe(201)
    expect(harness.commandEvents.list()).toEqual([])
    const bootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(0)
    const seedDb = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(getAllAssetMetadata(seedDb)).toEqual([
        { id: PNG_SHA, ext: 'png', size: PNG_BYTES.length, contentType: 'image/png' },
      ])
    } finally {
      seedDb.close()
    }
    expect(existsSync(path.join(harness.dataDir, 'assets', `${PNG_SHA}.png`))).toBe(true)
  })

  it('removes previously staged bulk asset bytes when a later file write fails', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    failWriteFileSyncWhen((file) => file === path.join(harness.dataDir, 'assets', `${OTHER_PNG_SHA}.png`))

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/bulk',
      headers: { 'risu-auth': assertion },
      payload: {
        assets: [
          { contentType: 'image/png', data: PNG_BYTES.toString('base64') },
          { contentType: 'image/png', data: OTHER_PNG_BYTES.toString('base64') },
        ],
      },
    })

    expect(res.statusCode).toBe(500)
    expect(harness.commandEvents.list()).toEqual([])
    const bootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(0)
    const seedDb = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(getAllAssetMetadata(seedDb)).toEqual([])
    } finally {
      seedDb.close()
    }
    expect(existsSync(path.join(harness.dataDir, 'assets', `${PNG_SHA}.png`))).toBe(false)
    expect(existsSync(path.join(harness.dataDir, 'assets', `${OTHER_PNG_SHA}.png`))).toBe(false)
  })

  it('bulk uploads assets with one revision and ordered results', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/bulk',
      headers: { 'risu-auth': assertion },
      payload: {
        assets: [
          { contentType: 'image/png', data: PNG_BYTES.toString('base64') },
          { contentType: 'image/png', data: OTHER_PNG_BYTES.toString('base64') },
        ],
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({
      assets: [
        {
          assetId: PNG_SHA,
          size: PNG_BYTES.length,
          contentType: 'image/png',
          revision: 0,
          created: true,
        },
        {
          assetId: OTHER_PNG_SHA,
          size: OTHER_PNG_BYTES.length,
          contentType: 'image/png',
          revision: 0,
          created: true,
        },
      ],
      revision: 0,
    })
    expect(harness.commandEvents.list()).toEqual([])
    expect(existsSync(path.join(harness.dataDir, 'assets', `${PNG_SHA}.png`))).toBe(true)
    expect(existsSync(path.join(harness.dataDir, 'assets', `${OTHER_PNG_SHA}.png`))).toBe(true)
  })

  it('bulk uploads binary-framed assets with one revision and ordered results', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/bulk',
      headers: {
        'content-type': ASSET_BULK_BINARY_CONTENT_TYPE,
        prefer: 'return=minimal',
        'risu-auth': assertion,
      },
      payload: buildBinaryBulkAssetBody([
        { contentType: 'image/png', bytes: PNG_BYTES },
        { contentType: 'image/png', bytes: OTHER_PNG_BYTES },
      ]),
    })

    expect(res.statusCode).toBe(201)
    expect(res.headers['preference-applied']).toBe('return=minimal')
    expect(res.json()).toEqual({
      assetIds: [PNG_SHA, OTHER_PNG_SHA],
      revision: 0,
    })
    expect(harness.commandEvents.list()).toEqual([])
    expect(existsSync(path.join(harness.dataDir, 'assets', `${PNG_SHA}.png`))).toBe(true)
    expect(existsSync(path.join(harness.dataDir, 'assets', `${OTHER_PNG_SHA}.png`))).toBe(true)
  })

  it('bulk upload is idempotent for existing assets', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/bulk',
      headers: { 'risu-auth': assertion },
      payload: {
        assets: [{ contentType: 'image/png', data: PNG_BYTES.toString('base64') }],
      },
    })
    expect(first.statusCode).toBe(201)

    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/bulk',
      headers: { 'risu-auth': assertion },
      payload: {
        assets: [{ contentType: 'image/png', data: PNG_BYTES.toString('base64') }],
      },
    })

    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({
      assets: [
        {
          assetId: PNG_SHA,
          size: PNG_BYTES.length,
          contentType: 'image/png',
          revision: 0,
          created: false,
        },
      ],
      revision: 0,
    })
    expect(harness.commandEvents.list()).toEqual([])
  })

  it('is idempotent on re-upload of the same bytes', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    expect(first.statusCode).toBe(201)
    expect(first.json().revision).toBe(0)

    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({
      assetId: PNG_SHA,
      size: PNG_BYTES.length,
      contentType: 'image/png',
      revision: 0,
    })
  })

  it('refreshes an existing deduplicated asset mtime on re-upload', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    expect(first.statusCode).toBe(201)

    const onDisk = path.join(harness.dataDir, 'assets', `${PNG_SHA}.png`)
    const oldMtime = new Date('2000-01-01T00:00:00.000Z')
    fs.utimesSync(onDisk, oldMtime, oldMtime)

    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })

    expect(second.statusCode).toBe(200)
    expect(fs.statSync(onDisk).mtimeMs).toBeGreaterThan(oldMtime.getTime())
  })

  it('heals a missing blob when the same asset is re-uploaded', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    expect(first.statusCode).toBe(201)

    const onDisk = path.join(harness.dataDir, 'assets', `${PNG_SHA}.png`)
    unlinkSync(onDisk)

    const missing = await harness.app.inject({ method: 'GET', url: `/api/v1/assets/${PNG_SHA}` })
    expect(missing.statusCode).toBe(404)

    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({
      assetId: PNG_SHA,
      size: PNG_BYTES.length,
      contentType: 'image/png',
      revision: 0,
    })
    expect(existsSync(onDisk)).toBe(true)

    const healed = await harness.app.inject({ method: 'GET', url: `/api/v1/assets/${PNG_SHA}` })
    expect(healed.statusCode).toBe(200)
    expect(Buffer.from(healed.rawPayload)).toEqual(PNG_BYTES)
  })

  it('returns 415 for an unsupported content-type', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'application/x-evil', 'risu-auth': assertion },
      payload: Buffer.from('hello'),
    })
    expect(res.statusCode).toBe(415)
  })

  it('GET serves stored bytes with content-type and immutable cache header', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    const res = await harness.app.inject({ method: 'GET', url: `/api/v1/assets/${PNG_SHA}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.headers['content-length']).toBe(String(PNG_BYTES.length))
    expect(Buffer.from(res.rawPayload)).toEqual(PNG_BYTES)
  })

  it('GET unknown id returns 404', async () => {
    const unknown = 'a'.repeat(64)
    const res = await harness.app.inject({ method: 'GET', url: `/api/v1/assets/${unknown}` })
    expect(res.statusCode).toBe(404)
  })

  it('GET malformed id returns 404', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/api/v1/assets/not-a-sha' })
    expect(res.statusCode).toBe(404)
  })

  it('HEAD existing asset returns headers with no body', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    const res = await harness.app.inject({ method: 'HEAD', url: `/api/v1/assets/${PNG_SHA}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['content-length']).toBe(String(PNG_BYTES.length))
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.body).toBe('')
  })

  it('HEAD unknown id returns 404', async () => {
    const unknown = 'a'.repeat(64)
    const res = await harness.app.inject({ method: 'HEAD', url: `/api/v1/assets/${unknown}` })
    expect(res.statusCode).toBe(404)
  })

  it('POST /assets/exists reports missing and present ids', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    const otherId = 'b'.repeat(64)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/exists',
      payload: { ids: [PNG_SHA, otherId] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ missing: [otherId] })
  })

  it('POST /assets/exists handles empty and malformed lookup envelopes', async () => {
    const cases = [
      {
        label: 'empty array',
        payload: { ids: [] },
        expectedStatus: 200,
        expectedBody: { missing: [] },
      },
      {
        label: 'non-array ids',
        payload: { ids: 'not-an-array' },
        expectedStatus: 400,
        expectedBody: { error: 'ids: string[] required' },
      },
      {
        label: 'missing ids',
        payload: {},
        expectedStatus: 400,
        expectedBody: { error: 'ids: string[] required' },
      },
      {
        label: 'non-string id',
        payload: { ids: [123] },
        expectedStatus: 400,
        expectedBody: { error: 'ids must be sha256 hex strings' },
      },
      {
        label: 'non-SHA id',
        payload: { ids: ['not-a-sha'] },
        expectedStatus: 400,
        expectedBody: { error: 'ids must be sha256 hex strings' },
      },
      {
        label: '1,025 ids',
        payload: { ids: Array.from({ length: 1025 }, (_, index) => index.toString(16).padStart(64, '0')) },
        expectedStatus: 400,
        expectedBody: { error: 'ids must contain at most 1024 items' },
      },
    ]

    const results = []
    for (const testCase of cases) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/assets/exists',
        payload: testCase.payload,
      })
      results.push({ testCase, response })
    }

    for (const { testCase, response } of results) {
      expect.soft(response.statusCode, `${testCase.label}: ${response.body}`).toBe(testCase.expectedStatus)
      expect.soft(response.json(), testCase.label).toEqual(testCase.expectedBody)
    }
  })

  it('POST /assets/bulk rejects malformed asset payloads', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const badBase64 = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/bulk',
      headers: { 'risu-auth': assertion },
      payload: { assets: [{ contentType: 'image/png', data: 'not base64!!!' }] },
    })
    expect(badBase64.statusCode).toBe(400)

    const badContentType = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/bulk',
      headers: { 'risu-auth': assertion },
      payload: { assets: [{ contentType: 'application/x-evil', data: 'aGVsbG8=' }] },
    })
    expect(badContentType.statusCode).toBe(400)

    const badBinary = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/bulk',
      headers: {
        'content-type': ASSET_BULK_BINARY_CONTENT_TYPE,
        'risu-auth': assertion,
      },
      payload: Buffer.from([0, 0, 0, 20, 123]),
    })
    expect(badBinary.statusCode).toBe(400)
  })
})

// Phase 3 asset-byte fanout measurement (server side). Every single-asset byte
// read lands on `GET /api/v1/assets/:id`, so the opt-in `asset_byte_read` metric
// gives a per-id byte-read baseline for fanout analysis. Route behavior (bytes,
// headers, missing-id) is unchanged.
describe('asset byte read fanout measurement', () => {
  const PREVIOUS_PROTOCOL_METRICS = process.env.RISU_PROTOCOL_METRICS

  beforeEach(() => {
    process.env.RISU_PROTOCOL_METRICS = '1'
    capturedMetrics.length = 0
  })

  afterEach(() => {
    if (PREVIOUS_PROTOCOL_METRICS === undefined) {
      delete process.env.RISU_PROTOCOL_METRICS
    } else {
      process.env.RISU_PROTOCOL_METRICS = PREVIOUS_PROTOCOL_METRICS
    }
  })

  async function uploadPng(assertion: string): Promise<void> {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
  }

  function byteReads(): AssetByteReadMetric[] {
    return capturedMetrics.filter((entry) => entry.metric === 'asset_byte_read')
  }

  it('emits one found byte-read metric per GET, including repeated ids', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await uploadPng(assertion)
    capturedMetrics.length = 0

    // Two GETs of the same id model the repeated-id fanout a bulk route or
    // browser cache would collapse.
    await harness.app.inject({ method: 'GET', url: `/api/v1/assets/${PNG_SHA}` })
    await harness.app.inject({ method: 'GET', url: `/api/v1/assets/${PNG_SHA}` })

    const reads = byteReads()
    expect(reads).toHaveLength(2)
    for (const read of reads) {
      expect(read.assetId).toBe(PNG_SHA)
      expect(read.found).toBe(true)
      expect(read.contentType).toBe('image/png')
      expect(read.size).toBe(PNG_BYTES.length)
    }

    // The repeated-id fanout is visible as duplicate ids across the metrics.
    const uniqueIds = new Set(reads.map((read) => read.assetId))
    expect(uniqueIds.size).toBe(1)
    expect(reads.length - uniqueIds.size).toBe(1)
  })

  it('emits a not-found byte-read metric for a missing id', async () => {
    await setupAuthedClient(harness.app)
    capturedMetrics.length = 0
    const missing = 'a'.repeat(64)

    const res = await harness.app.inject({ method: 'GET', url: `/api/v1/assets/${missing}` })
    expect(res.statusCode).toBe(404)

    const reads = byteReads()
    expect(reads).toHaveLength(1)
    expect(reads[0].assetId).toBe(missing)
    expect(reads[0].found).toBe(false)
    expect(reads[0].size).toBeUndefined()
  })
})
