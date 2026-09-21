import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { webcrypto } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'

const subtle = webcrypto.subtle

interface Harness {
  app: FastifyInstance
  dataDir: string
}

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 16 * 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
  })
  return { app, dataDir }
}

async function stopHarness(h: Harness): Promise<void> {
  await h.app.close()
  rmSync(h.dataDir, { recursive: true, force: true })
}

function legacyStorageTempFiles(dataDir: string): string[] {
  const savePath = path.join(dataDir, 'save')
  if (!existsSync(savePath)) return []
  return readdirSync(savePath).filter((name) => name.startsWith('.legacy-storage-') && name.endsWith('.tmp'))
}

function isLegacyStorageTempPath(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const basename = path.basename(value)
  return basename.startsWith('.legacy-storage-') && basename.endsWith('.tmp')
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
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { password: 'hunter2' },
  })
  const keypair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicKey = await subtle.exportKey('jwk', keypair.publicKey)
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'hunter2', publicKey },
  })
  return { assertion: await signAssertion(keypair.privateKey, publicKey) }
}

const HELLO_KEY = 'database/database.bin'
const HELLO_HEX = Buffer.from(HELLO_KEY, 'utf-8').toString('hex')

let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await stopHarness(harness)
})

describe('/api/v1/storage', () => {
  it('rejects without auth once a password is set', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/storage/list',
    })
    expect(res.statusCode).toBe(401)
  })

  it('writes raw bytes under a hex-encoded path and reads them back', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const payload = Buffer.from(Array.from({ length: 256 }, (_, value) => value))

    const writeRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/write',
      headers: { 'risu-auth': assertion, 'file-path': HELLO_HEX },
      payload,
    })
    expect(writeRes.statusCode).toBe(200)
    expect(writeRes.json()).toEqual({ success: true })
    const onDisk = path.join(harness.dataDir, 'save', HELLO_HEX)
    expect(existsSync(onDisk)).toBe(true)
    expect(Buffer.from(readFileSync(onDisk))).toEqual(payload)

    const readRes = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/storage/read',
      headers: { 'risu-auth': assertion, 'file-path': HELLO_HEX },
    })
    expect(readRes.statusCode).toBe(200)
    expect(readRes.headers['content-type']).toContain('application/octet-stream')
    expect(Buffer.from(readRes.rawPayload)).toEqual(payload)
  })

  it('preserves the old legacy storage file and removes temp bytes after a mid-write failure', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const oldPayload = Buffer.from('old-final-bytes')
    const writeOld = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/write',
      headers: { 'risu-auth': assertion, 'file-path': HELLO_HEX },
      payload: oldPayload,
    })
    expect(writeOld.statusCode).toBe(200)
    const onDisk = path.join(harness.dataDir, 'save', HELLO_HEX)
    expect(Buffer.from(readFileSync(onDisk))).toEqual(oldPayload)

    const originalWriteFile = fs.promises.writeFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      if (isLegacyStorageTempPath(file)) {
        writeFileSync(String(file), Buffer.from('partial-new-bytes'))
        throw new Error('simulated mid-write failure')
      }
      await originalWriteFile(file, data, options)
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/write',
      headers: { 'risu-auth': assertion, 'file-path': HELLO_HEX },
      payload: Buffer.from('replacement-bytes'),
    })
    expect(res.statusCode).toBe(500)
    expect(Buffer.from(readFileSync(onDisk))).toEqual(oldPayload)
    expect(legacyStorageTempFiles(harness.dataDir)).toEqual([])
  })

  it('preserves the old legacy storage file and removes temp bytes after a rename failure', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const oldPayload = Buffer.from('old-final-before-rename')
    const writeOld = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/write',
      headers: { 'risu-auth': assertion, 'file-path': HELLO_HEX },
      payload: oldPayload,
    })
    expect(writeOld.statusCode).toBe(200)
    const onDisk = path.join(harness.dataDir, 'save', HELLO_HEX)
    expect(Buffer.from(readFileSync(onDisk))).toEqual(oldPayload)

    const originalRename = fs.promises.rename.bind(fs.promises)
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (isLegacyStorageTempPath(oldPath)) {
        throw new Error('simulated rename failure')
      }
      await originalRename(oldPath, newPath)
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/write',
      headers: { 'risu-auth': assertion, 'file-path': HELLO_HEX },
      payload: Buffer.from('replacement-after-rename'),
    })
    expect(res.statusCode).toBe(500)
    expect(Buffer.from(readFileSync(onDisk))).toEqual(oldPayload)
    expect(legacyStorageTempFiles(harness.dataDir)).toEqual([])
  })

  it('preserves existing bytes after a file flush failure and accepts a later replacement', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const headers = { 'risu-auth': assertion, 'file-path': HELLO_HEX }
    const oldPayload = Buffer.from([0, 255, 128, 1])
    const replacement = Buffer.from([254, 0, 129, 2, 3])
    const initial = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/write',
      headers,
      payload: oldPayload,
    })
    expect(initial.statusCode).toBe(200)
    const onDisk = path.join(harness.dataDir, 'save', HELLO_HEX)
    expect(readFileSync(onDisk)).toEqual(oldPayload)
    const sibling = path.join(harness.dataDir, 'save', Buffer.from('coldstorage/sibling').toString('hex'))
    const siblingBytes = Buffer.from([17, 0, 240, 18])
    writeFileSync(sibling, siblingBytes)

    const originalOpen = fs.promises.open.bind(fs.promises)
    const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      if (isLegacyStorageTempPath(args[0])) {
        vi.spyOn(handle, 'sync').mockRejectedValue(new Error('simulated file flush failure'))
      }
      return handle
    })
    const failed = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/write',
      headers,
      payload: replacement,
    })
    expect(failed.statusCode).toBe(500)
    expect(readFileSync(onDisk)).toEqual(oldPayload)
    expect(readFileSync(sibling)).toEqual(siblingBytes)
    expect(legacyStorageTempFiles(harness.dataDir)).toEqual([])

    open.mockRestore()
    const retried = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/write',
      headers,
      payload: replacement,
    })
    expect(retried.statusCode).toBe(200)
    expect(retried.json()).toEqual({ success: true })
    expect(readFileSync(onDisk)).toEqual(replacement)
    expect(readFileSync(sibling)).toEqual(siblingBytes)
    expect(legacyStorageTempFiles(harness.dataDir)).toEqual([])
  })

  it('returns an empty body for read of a missing path', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const missing = Buffer.from('missing/key', 'utf-8').toString('hex')
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/storage/read',
      headers: { 'risu-auth': assertion, 'file-path': missing },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/octet-stream')
    expect(res.rawPayload.length).toBe(0)
  })

  it('rejects missing and invalid file paths consistently across path-based routes', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const routes = [
      { method: 'GET' as const, url: '/api/v1/storage/exists' },
      { method: 'GET' as const, url: '/api/v1/storage/read' },
      { method: 'POST' as const, url: '/api/v1/storage/write', payload: Buffer.from('x') },
      { method: 'POST' as const, url: '/api/v1/storage/remove' },
    ]

    for (const route of routes) {
      const payload = 'payload' in route ? { payload: route.payload } : {}
      const missingPath = await harness.app.inject({
        method: route.method,
        url: route.url,
        headers: { 'risu-auth': assertion },
        ...payload,
      })
      expect(missingPath.statusCode, `${route.method} ${route.url} without file-path`).toBe(400)
      expect(missingPath.json()).toEqual({ error: 'File path required' })

      const invalidPath = await harness.app.inject({
        method: route.method,
        url: route.url,
        headers: { 'risu-auth': assertion, 'file-path': 'not-hex' },
        ...payload,
      })
      expect(invalidPath.statusCode, `${route.method} ${route.url} with invalid file-path`).toBe(400)
      expect(invalidPath.json()).toEqual({ error: 'Invalid path' })
    }
  })

  it('rejects empty write body', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/write',
      headers: { 'risu-auth': assertion, 'file-path': HELLO_HEX },
      payload: Buffer.alloc(0),
    })
    expect(res.statusCode).toBe(400)
  })

  it('list returns utf-8 decoded keys for existing hex files', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/write',
      headers: { 'risu-auth': assertion, 'file-path': HELLO_HEX },
      payload: Buffer.from('x'),
    })
    const otherKey = 'coldstorage/abc'
    const otherHex = Buffer.from(otherKey, 'utf-8').toString('hex')
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/write',
      headers: { 'risu-auth': assertion, 'file-path': otherHex },
      payload: Buffer.from('y'),
    })

    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/storage/list',
      headers: { 'risu-auth': assertion },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { success: boolean; content: string[] }
    expect(body.success).toBe(true)
    expect(body.content.sort()).toEqual([HELLO_KEY, otherKey].sort())
  })

  it('remove deletes one or many keys joined by $$', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const keyA = Buffer.from('coldstorage/a', 'utf-8').toString('hex')
    const keyB = Buffer.from('coldstorage/b', 'utf-8').toString('hex')
    for (const hex of [keyA, keyB, HELLO_HEX]) {
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/storage/write',
        headers: { 'risu-auth': assertion, 'file-path': hex },
        payload: Buffer.from('x'),
      })
    }
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/remove',
      headers: { 'risu-auth': assertion, 'file-path': `${keyA}$$${keyB}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true })
    expect(existsSync(path.join(harness.dataDir, 'save', keyA))).toBe(false)
    expect(existsSync(path.join(harness.dataDir, 'save', keyB))).toBe(false)
    expect(existsSync(path.join(harness.dataDir, 'save', HELLO_HEX))).toBe(true)
  })

  it('validates every remove path before deleting any entry', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const payload = Buffer.from('must-survive-invalid-batch')
    const writeRes = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/write',
      headers: { 'risu-auth': assertion, 'file-path': HELLO_HEX },
      payload,
    })
    expect(writeRes.statusCode).toBe(200)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/remove',
      headers: { 'risu-auth': assertion, 'file-path': `${HELLO_HEX}$$not-hex` },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Invalid path' })
    expect(Buffer.from(readFileSync(path.join(harness.dataDir, 'save', HELLO_HEX)))).toEqual(payload)
  })

  it('remove of a missing key is idempotent (success: true, no throw)', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const missing = Buffer.from('coldstorage/missing', 'utf-8').toString('hex')
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/remove',
      headers: { 'risu-auth': assertion, 'file-path': missing },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ success: true })
  })

  it('POST /api/v1/auth/crypto returns sha256 hex of input', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/crypto',
      payload: { data: 'hunter2' },
    })
    expect(res.statusCode).toBe(200)
    // Sha256("hunter2") = "f52fbd32b2b3b86ff88ef6c490628285f482af15ddcb29541f94bcf526a3f6c7"
    expect(res.body).toBe('f52fbd32b2b3b86ff88ef6c490628285f482af15ddcb29541f94bcf526a3f6c7')
  })

  it('POST /api/v1/auth/crypto rejects non-string data', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/crypto',
      payload: { data: 42 },
    })
    expect(res.statusCode).toBe(400)
  })
})
