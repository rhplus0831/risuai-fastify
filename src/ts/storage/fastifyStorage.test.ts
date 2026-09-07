import { resetClientSessionForTests } from '../clientSession'
import {
  setManagedReaderForTest,
  setManagedWriterForTest,
  demoteAndRepromoteForTest,
} from '../__tests__/managedClientSession'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const alertState = vi.hoisted(() => ({
  alertInput: vi.fn(async () => 'hunter2'),
}))

vi.mock('../alert', () => ({
  alertError: vi.fn(),
  alertInput: alertState.alertInput,
  waitAlert: vi.fn(async () => undefined),
}))

vi.mock('src/lang', () => ({
  language: {
    setNodePassword: 'Set Fastify password',
    inputNodePassword: 'Input Fastify password',
  },
}))

vi.mock('../util', () => ({
  base64url: vi.fn((value: Uint8Array) => Buffer.from(value).toString('base64url')),
  getKeypairStore: vi.fn(async () => null),
  saveKeypairStore: vi.fn(async () => undefined),
}))

import { FastifyStorage } from './fastifyStorage'

interface CapturedFetch {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  })
}

function captureFetch(handler: (url: string, init: RequestInit) => Response): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      calls.push({
        url: String(input),
        method: init.method ?? 'GET',
        headers: headers ?? {},
        body: typeof init.body === 'string' ? init.body : undefined,
      })
      return handler(String(input), init)
    }) as unknown as typeof fetch,
  )
  return calls
}

function stubStorage(name: 'localStorage' | 'sessionStorage'): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal(name, {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, String(value))
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key)
    }),
    clear: vi.fn(() => {
      store.clear()
    }),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    get length() {
      return store.size
    },
  } as Storage)
  return store
}

describe('FastifyStorage client', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    alertState.alertInput.mockClear()
  })

  it('uses only Fastify storage endpoints for persisted app data', async () => {
    const calls = captureFetch((url) => {
      if (url === '/api/v1/storage/read') return textResponse('hello')
      if (url === '/api/v1/storage/exists') return jsonResponse({ success: true, exists: true })
      if (url === '/api/v1/storage/list') return jsonResponse({ content: ['database/database.bin'] })
      return jsonResponse({ success: true })
    })
    const storage = new FastifyStorage()
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('auth-token')

    await storage.setItem('database/database.bin', new Uint8Array([1, 2, 3]))
    await expect(storage.getItem('database/database.bin')).resolves.toEqual(Buffer.from('hello'))
    await expect(storage.hasItem('remotes/char.local.bin')).resolves.toBe(true)
    await expect(storage.keys()).resolves.toEqual(['database/database.bin'])
    await storage.removeItem(['coldstorage/a', 'coldstorage/b'])

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/v1/storage/write',
      'GET /api/v1/storage/read',
      'GET /api/v1/storage/exists',
      'GET /api/v1/storage/list',
      'POST /api/v1/storage/remove',
    ])
    expect(calls.every((call) => call.headers['risu-auth'] === 'auth-token')).toBe(true)
    expect(calls[0].headers['file-path']).toBe(Buffer.from('database/database.bin').toString('hex'))
    expect(calls[2].headers['file-path']).toBe(Buffer.from('remotes/char.local.bin').toString('hex'))
    expect(calls[4].headers['file-path']).toBe(
      `${Buffer.from('coldstorage/a').toString('hex')}$$${Buffer.from('coldstorage/b').toString('hex')}`,
    )
    expect(calls.map((call) => call.url).some((url) => url.startsWith('/api/v1/'))).toBe(true)
    expect(calls.map((call) => call.url).some((url) => /^\/api\/(write|read|list|remove)$/.test(url))).toBe(false)
  })

  it('sets up auth through Fastify auth and crypto endpoints', async () => {
    const calls = captureFetch((url) => {
      if (url === '/api/v1/auth/status') return jsonResponse({ noPassword: true })
      if (url === '/api/v1/auth/crypto') return textResponse('hashed-password')
      return jsonResponse({ success: true })
    })
    const storage = new FastifyStorage()
    vi.spyOn(storage, 'createAuth').mockResolvedValue('auth-token')

    await storage.setItem('database/database.bin', new Uint8Array([1]))

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/v1/auth/status',
      'POST /api/v1/auth/crypto',
      'POST /api/v1/auth/setup',
      'POST /api/v1/storage/write',
    ])
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({ data: 'hunter2' })
    expect(JSON.parse(calls[2].body ?? '{}')).toEqual({
      password: 'hashed-password',
      publicKey: expect.objectContaining({ kty: 'EC' }),
    })
    expect(alertState.alertInput).toHaveBeenCalledTimes(1)
  })

  it('uses server-issued session auth when WebCrypto is unavailable', async () => {
    vi.stubGlobal('crypto', {})
    const sessionToken = `session.${(Math.floor(Date.now() / 1000) + 3600).toString(36)}.test-token`
    const local = stubStorage('localStorage')
    const session = stubStorage('sessionStorage')
    const calls = captureFetch((url) => {
      if (url === '/api/v1/auth/status') return jsonResponse({ noPassword: true })
      if (url === '/api/v1/auth/crypto') return textResponse('hashed-password')
      if (url === '/api/v1/auth/setup') {
        return jsonResponse({ status: 'success', authToken: sessionToken })
      }
      return jsonResponse({ success: true })
    })
    const storage = new FastifyStorage()

    await storage.setItem('database/database.bin', new Uint8Array([1]))

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/v1/auth/status',
      'POST /api/v1/auth/crypto',
      'POST /api/v1/auth/setup',
      'POST /api/v1/storage/write',
    ])
    expect(calls[0].headers['risu-auth']).toBe('')
    expect(JSON.parse(calls[2].body ?? '{}')).toEqual({
      password: 'hashed-password',
      sessionAuth: true,
    })
    expect(calls[3].headers['risu-auth']).toBe(sessionToken)
    expect(session.get('risuauth')).toBe(sessionToken)
    expect(local.has('risuauth')).toBe(false)
  })

  it('renews an expired session token in a long-lived WebCrypto-less tab', async () => {
    vi.stubGlobal('crypto', {})
    const now = 2_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000)
    const expiredToken = `session.${(now - 1).toString(36)}.expired-token`
    const replacementToken = `session.${(now + 3600).toString(36)}.replacement-token`
    stubStorage('localStorage')
    const session = stubStorage('sessionStorage')
    session.set('risuauth', expiredToken)
    const calls = captureFetch((url) => {
      if (url === '/api/v1/auth/status') return jsonResponse({ authorized: false })
      if (url === '/api/v1/auth/crypto') return textResponse('hashed-password')
      if (url === '/api/v1/auth/login') {
        return jsonResponse({ status: 'success', authToken: replacementToken })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const storage = new FastifyStorage()
    storage.authChecked = true

    await expect(storage.getProxyAuth()).resolves.toBe(replacementToken)

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/v1/auth/status',
      'POST /api/v1/auth/crypto',
      'POST /api/v1/auth/login',
    ])
    expect(calls[0].headers['risu-auth']).toBe('')
    expect(session.get('risuauth')).toBe(replacementToken)
    expect(alertState.alertInput).toHaveBeenCalledTimes(1)
  })
})

beforeEach(() => resetClientSessionForTests())

describe('legacy server-file writer admission', () => {
  it('does not authenticate or mutate a file from a reader', async () => {
    setManagedReaderForTest()
    const storage = new FastifyStorage()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(storage.setItem('save/database.bin', new Uint8Array([1]))).rejects.toThrow(
      'client_write_access_required',
    )
    await expect(storage.removeItem('save/database.bin')).rejects.toThrow('client_write_access_required')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['setItem', 'removeItem'] as const)(
    'does not dispatch %s after delayed auth and repromotion',
    async (method) => {
      setManagedWriterForTest()
      const storage = new FastifyStorage()
      vi.spyOn(storage as any, 'checkAuth').mockResolvedValue(undefined)
      let release!: (auth: string) => void
      vi.spyOn(storage, 'createAuth').mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve
        }),
      )
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const pending =
        method === 'setItem'
          ? storage.setItem('save/test.bin', new Uint8Array([1]))
          : storage.removeItem('save/test.bin')
      await vi.waitFor(() => expect(storage.createAuth).toHaveBeenCalledOnce())
      demoteAndRepromoteForTest()
      release('old-auth')
      await expect(pending).rejects.toThrow('client_write_operation_stale')
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )
})
