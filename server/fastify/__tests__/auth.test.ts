/** @module-tag core */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  createAuthState,
  registerPublicKey,
  registerSessionToken,
  SESSION_TOKEN_TTL_SECONDS,
  verifyAssertion,
} from '../src/auth.js'

describe('auth.knownKeyHashes (bounded accumulator)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-auth-cap-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('keeps the known-key set bounded by the soft cap and evicts the LRU', () => {
    const cap = 4096
    const state = createAuthState(tmpDir)

    // Fill the set to the cap with deterministic keys.
    for (let i = 0; i < cap; i++) {
      registerPublicKey(state, { kty: 'EC', crv: 'P-256', id: i })
    }
    expect(state.knownKeyHashes.size).toBe(cap)

    // Add one more — the oldest entry (id=0) must be evicted.
    const oldestPayload = { kty: 'EC', crv: 'P-256', id: 0 }
    registerPublicKey(state, { kty: 'EC', crv: 'P-256', id: cap })
    expect(state.knownKeyHashes.size).toBe(cap)

    // Round-trip: re-register the evicted payload; it must be missing first
    // and present afterwards.
    const oldestHashHex = require('node:crypto')
      .createHash('sha256')
      .update(JSON.stringify(oldestPayload))
      .digest('hex')
    expect(state.knownKeyHashes.has(oldestHashHex)).toBe(false)

    registerPublicKey(state, oldestPayload)
    expect(state.knownKeyHashes.has(oldestHashHex)).toBe(true)
    expect(state.knownKeyHashes.size).toBe(cap)
  })

  it('persists the bounded set to disk on every register', () => {
    const state = createAuthState(tmpDir)
    registerPublicKey(state, { id: 'k1' })
    registerPublicKey(state, { id: 'k2' })

    const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, '__known_public_key_hashes.json'), 'utf-8'))
    expect(Array.isArray(persisted)).toBe(true)
    expect(persisted).toHaveLength(2)
  })

  it('trims a pre-existing oversize cache on load', () => {
    // Seed the cache file with 4097 entries.
    const oversize: string[] = []
    for (let i = 0; i < 4097; i++) {
      oversize.push(`hash-${i.toString().padStart(4, '0')}`)
    }
    fs.writeFileSync(path.join(tmpDir, '__known_public_key_hashes.json'), JSON.stringify(oversize), 'utf-8')

    const state = createAuthState(tmpDir)
    expect(state.knownKeyHashes.size).toBe(4096)
    // The oldest entry is evicted (insertion order).
    expect(state.knownKeyHashes.has('hash-0000')).toBe(false)
    expect(state.knownKeyHashes.has('hash-4096')).toBe(true)
  })
})

describe('agent dev auth bypass', () => {
  it('reports authorized and allows protected routes without password setup', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-auth-agent-bypass-'))
    try {
      const { buildApp } = await import('../src/app.js')
      const { app } = await buildApp({
        config: {
          host: '127.0.0.1',
          port: 0,
          dataDir,
          bodyLimit: 1024 * 1024,
          importMaxBytes: Infinity,
          trustProxy: false,
          hubUrl: 'https://sv.risuai.xyz',
          agentDevAuthBypass: true,
        },
        assetGc: false,
        memoryWorker: false,
      })

      try {
        const status = await app.inject({
          method: 'GET',
          url: '/api/v1/auth/status',
        })
        expect(status.statusCode).toBe(200)
        expect(status.json()).toEqual({ noPassword: false, authorized: true })

        const storageList = await app.inject({
          method: 'GET',
          url: '/api/v1/storage/list',
        })
        expect(storageList.statusCode).toBe(200)
        expect(storageList.json()).toEqual({ success: true, content: [] })
        const storageExists = await app.inject({
          method: 'GET',
          url: '/api/v1/storage/exists',
          headers: { 'file-path': Buffer.from('database/database.bin').toString('hex') },
        })
        expect(storageExists.statusCode).toBe(200)
        expect(storageExists.json()).toEqual({ success: true, exists: false })
        expect(fs.existsSync(path.join(dataDir, '__password'))).toBe(false)
      } finally {
        await app.close()
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('refuses an explicit non-loopback app configuration before opening the data directory', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-auth-agent-bypass-bind-'))
    try {
      const { buildApp } = await import('../src/app.js')
      await expect(
        buildApp({
          config: {
            host: '0.0.0.0',
            port: 0,
            dataDir,
            bodyLimit: 1024 * 1024,
            importMaxBytes: Infinity,
            trustProxy: false,
            hubUrl: 'https://sv.risuai.xyz',
            agentDevAuthBypass: true,
          },
          assetGc: false,
          memoryWorker: false,
        }),
      ).rejects.toThrow(/requires a loopback/)
      expect(fs.readdirSync(dataDir)).toEqual([])
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('password setup', () => {
  it('rejects a whitespace-only password without creating auth state', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-auth-password-setup-'))
    try {
      const { buildApp } = await import('../src/app.js')
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
        assetGc: false,
        memoryWorker: false,
      })

      try {
        const rejected = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: { password: '   ' },
        })
        expect(rejected.statusCode).toBe(400)
        expect(rejected.json()).toEqual({ error: 'Password required' })
        expect(fs.existsSync(path.join(dataDir, '__password'))).toBe(false)

        const accepted = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: { password: 'hunter2' },
        })
        expect(accepted.statusCode).toBe(200)
      } finally {
        await app.close()
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('fallback session authentication', () => {
  it('accepts an unexpired fallback token after reopening persisted auth state', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-auth-session-reopen-'))
    try {
      const token = registerSessionToken(createAuthState(dataDir))
      const reopenedState = createAuthState(dataDir)

      await expect(verifyAssertion(reopenedState, token)).resolves.toEqual({ ok: true })
      expect(reopenedState.knownSessionTokenHashes.size).toBe(1)
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('expires server-issued fallback tokens and removes their stored hash', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-auth-session-'))
    const now = Date.UTC(2026, 0, 1)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const state = createAuthState(dataDir)
      const token = registerSessionToken(state)
      expect(token.split('.')).toHaveLength(3)
      await expect(verifyAssertion(state, token)).resolves.toEqual({ ok: true })

      clock.mockReturnValue(now + (SESSION_TOKEN_TTL_SECONDS + 1) * 1000)
      await expect(verifyAssertion(state, token)).resolves.toEqual({ ok: false, reason: 'expired' })
      expect(state.knownSessionTokenHashes.size).toBe(0)
    } finally {
      clock.mockRestore()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('resource bulk route auth', () => {
  it('rejects unauthenticated requests and verifies authenticated requests exactly once', async () => {
    vi.resetModules()
    let verifyCount = 0
    vi.doMock('../src/auth.js', async () => {
      const actual = await vi.importActual<typeof import('../src/auth.js')>('../src/auth.js')
      return {
        ...actual,
        verifyAssertion: async (...args: Parameters<typeof actual.verifyAssertion>) => {
          verifyCount += 1
          return actual.verifyAssertion(...args)
        },
      }
    })

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-auth-bulk-'))
    try {
      const { buildApp } = await import('../src/app.js')
      const { setupAuthedClient } = await import('./helpers/auth.js')
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
        assetGc: false,
        memoryWorker: false,
      })

      try {
        const { assertion } = await setupAuthedClient(app)
        const routes = ['/api/v1/chats/messages/bulk', '/api/v1/characters/lorebooks/bulk']

        for (const url of routes) {
          verifyCount = 0
          const rejected = await app.inject({
            method: 'POST',
            url,
            payload: { ids: ['missing-id'] },
          })
          expect(rejected.statusCode).toBe(401)
          expect(rejected.json()).toEqual({ error: 'Auth required' })
          expect(verifyCount).toBe(0)

          verifyCount = 0
          const accepted = await app.inject({
            method: 'POST',
            url,
            headers: { 'risu-auth': assertion },
            payload: { ids: ['missing-id'] },
          })
          expect(accepted.statusCode).toBe(200)
          expect(verifyCount).toBe(1)
        }
      } finally {
        await app.close()
      }
    } finally {
      vi.doUnmock('../src/auth.js')
      vi.resetModules()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('proxy and hub route auth', () => {
  it('proxy and hub route auth verifies exactly once when protected', async () => {
    vi.resetModules()
    let verifyCount = 0
    vi.doMock('../src/auth.js', async () => {
      const actual = await vi.importActual<typeof import('../src/auth.js')>('../src/auth.js')
      return {
        ...actual,
        verifyAssertion: async (...args: Parameters<typeof actual.verifyAssertion>) => {
          verifyCount += 1
          return actual.verifyAssertion(...args)
        },
      }
    })

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('upstream ok', { status: 200 }))
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-auth-proxy-hub-'))
    try {
      const { buildApp } = await import('../src/app.js')
      const { setupAuthedClient } = await import('./helpers/auth.js')
      const { app } = await buildApp({
        config: {
          host: '127.0.0.1',
          port: 0,
          dataDir,
          bodyLimit: 1024 * 1024,
          importMaxBytes: Infinity,
          trustProxy: false,
          hubUrl: 'https://hub.example.test',
        },
        assetGc: false,
        memoryWorker: false,
      })

      try {
        const { assertion } = await setupAuthedClient(app)

        verifyCount = 0
        fetchSpy.mockClear()
        const proxy = await app.inject({
          method: 'POST',
          url: '/api/v1/proxy/fetch',
          headers: {
            'risu-auth': assertion,
            'risu-url': encodeURIComponent('https://upstream.example.test/proxy'),
          },
        })
        expect(proxy.statusCode).toBe(200)
        expect(verifyCount).toBe(1)
        expect(fetchSpy).toHaveBeenCalledTimes(1)

        verifyCount = 0
        fetchSpy.mockClear()
        const hubPost = await app.inject({
          method: 'POST',
          url: '/api/v1/hub/upload',
          headers: { 'risu-auth': assertion },
          payload: Buffer.from('hub body'),
        })
        expect(hubPost.statusCode).toBe(200)
        expect(verifyCount).toBe(1)
        expect(fetchSpy).toHaveBeenCalledTimes(1)

        verifyCount = 0
        fetchSpy.mockClear()
        const hubOverride = await app.inject({
          method: 'GET',
          url: '/api/v1/hub/public-path',
          headers: {
            'risu-auth': assertion,
            'x-risu-node-path': encodeURIComponent('https://override.example.test/path'),
          },
        })
        expect(hubOverride.statusCode).toBe(200)
        expect(verifyCount).toBe(1)
        expect(fetchSpy).toHaveBeenCalledTimes(1)

        verifyCount = 0
        fetchSpy.mockClear()
        const publicHub = await app.inject({
          method: 'GET',
          url: '/api/v1/hub/public-path',
        })
        expect(publicHub.statusCode).toBe(200)
        expect(verifyCount).toBe(0)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      } finally {
        await app.close()
      }
    } finally {
      fetchSpy.mockRestore()
      vi.doUnmock('../src/auth.js')
      vi.resetModules()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('unauthenticated proxy and hub requests stop before body parsing or forwarding', async () => {
    vi.resetModules()
    let verifyCount = 0
    vi.doMock('../src/auth.js', async () => {
      const actual = await vi.importActual<typeof import('../src/auth.js')>('../src/auth.js')
      return {
        ...actual,
        verifyAssertion: async (...args: Parameters<typeof actual.verifyAssertion>) => {
          verifyCount += 1
          return actual.verifyAssertion(...args)
        },
      }
    })

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('unexpected', { status: 200 }))
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-auth-proxy-hub-raw-'))
    try {
      const { buildApp } = await import('../src/app.js')
      const { setupAuthedClient } = await import('./helpers/auth.js')
      const { app } = await buildApp({
        config: {
          host: '127.0.0.1',
          port: 0,
          dataDir,
          bodyLimit: 1024 * 1024,
          importMaxBytes: Infinity,
          trustProxy: false,
          hubUrl: 'https://hub.example.test',
        },
        assetGc: false,
        memoryWorker: false,
      })

      try {
        await setupAuthedClient(app)
        const oversizedBody = Buffer.alloc(1024 * 1024 + 1)

        verifyCount = 0
        const proxy = await app.inject({
          method: 'POST',
          url: '/api/v1/proxy/fetch',
          headers: {
            'content-type': 'application/octet-stream',
            'risu-url': encodeURIComponent('https://upstream.example.test/proxy'),
          },
          payload: oversizedBody,
        })
        expect(proxy.statusCode).toBe(401)
        expect(proxy.json()).toEqual({ error: 'Auth required' })
        expect(verifyCount).toBe(0)
        expect(fetchSpy).toHaveBeenCalledTimes(0)

        verifyCount = 0
        const hub = await app.inject({
          method: 'POST',
          url: '/api/v1/hub/upload',
          headers: { 'content-type': 'application/octet-stream' },
          payload: oversizedBody,
        })
        expect(hub.statusCode).toBe(401)
        expect(hub.json()).toEqual({ error: 'Auth required' })
        expect(verifyCount).toBe(0)
        expect(fetchSpy).toHaveBeenCalledTimes(0)
      } finally {
        await app.close()
      }
    } finally {
      fetchSpy.mockRestore()
      vi.doUnmock('../src/auth.js')
      vi.resetModules()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
