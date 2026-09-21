import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { webcrypto } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import {
  HUB_FORWARD_DEFAULT_TIMEOUT_MS,
  REALM_REMOVE_BODY_MAX_BYTES,
  normalizeHubForwardTimeoutMs,
} from '../src/routes/hub.js'
import { MASKED_PROVIDER_SECRET } from '../src/providerSecrets.js'

const subtle = webcrypto.subtle

interface CapturedRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: Buffer
}

interface EchoServer {
  url: string
  requests: CapturedRequest[]
  setResponder(fn: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void | Promise<void>): void
  close(): Promise<void>
}

function startEcho(): Promise<EchoServer> {
  return new Promise((resolve) => {
    const requests: CapturedRequest[] = []
    let responder: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void | Promise<void> = (
      _req,
      res,
    ) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    }
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
        })
        void Promise.resolve(responder(req, res, body)).catch(() => {
          if (!res.headersSent) res.writeHead(500)
          res.end()
        })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        setResponder(fn) {
          responder = fn
        },
        close() {
          return new Promise((r) => server.close(() => r()))
        },
      })
    })
  })
}

interface Harness {
  app: FastifyInstance
  dataDir: string
}

async function startHarness(hubUrl: string): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl,
    },
  })
  return { app, dataDir }
}

async function stopHarness(h: Harness): Promise<void> {
  await h.app.close()
  rmSync(h.dataDir, { recursive: true, force: true })
}

function appBaseUrl(app: FastifyInstance): string {
  const addr = app.server.address() as AddressInfo
  return `http://127.0.0.1:${addr.port}`
}

async function requestHubOverSocket(
  app: FastifyInstance,
  path: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  await app.listen({ host: '127.0.0.1', port: 0 })
  return await withTimeout(
    new Promise((resolve, reject) => {
      const req = http.get(`${appBaseUrl(app)}${path}`, { headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
      })
      req.on('error', reject)
    }),
    1_000,
    'hub socket response did not finish',
  )
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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

function persistRealmAccount(dataDir: string, account: unknown): void {
  const sqlite = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    const row = sqlite.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined
    const settings = row ? (JSON.parse(row.data_json) as Record<string, unknown>) : {}
    settings.account = account
    sqlite
      .prepare(
        `INSERT INTO settings (id, data_json) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json`,
      )
      .run(JSON.stringify(settings))
  } finally {
    sqlite.close()
  }
}

let harness: Harness
let echo: EchoServer

beforeEach(async () => {
  echo = await startEcho()
  harness = await startHarness(echo.url)
})

afterEach(async () => {
  await stopHarness(harness)
  await echo.close()
})

describe('hub passthrough', () => {
  it('defaults hub forwards to the shared upstream deadline', () => {
    expect(normalizeHubForwardTimeoutMs(undefined)).toBe(HUB_FORWARD_DEFAULT_TIMEOUT_MS)
    expect(normalizeHubForwardTimeoutMs('75')).toBe(75)
    expect(normalizeHubForwardTimeoutMs('not-a-number')).toBe(HUB_FORWARD_DEFAULT_TIMEOUT_MS)
  })

  it('allows public GET reads without local auth once a password is set', async () => {
    echo.setResponder((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`hello ${req.url}`)
    })
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/hub/realm/search%3D%3D%20__shared%26%26page%3D%3D0',
      headers: { 'x-risuai-info': '2026.4.181;fastify' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('hello /realm/search%3D%3D%20__shared%26%26page%3D%3D0')
    expect(echo.requests).toHaveLength(1)
    expect(echo.requests[0].headers['x-risuai-info']).toBe('2026.4.181;fastify')
  })

  it('translates local realm query parameters to the cached upstream legacy realm path', async () => {
    echo.setResponder((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`hello ${req.url}`)
    })
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/hub/realm?search=foo+bar+__shared&page=2&nsfw=true&sort=downloads&web=other',
      headers: { 'x-risuai-info': '2026.4.181;fastify' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(
      'hello /realm/search%3D%3Dfoo%20bar%20__shared%26%26page%3D%3D2%26%26nsfw%3D%3Dtrue%26%26sort%3D%3Ddownloads%26%26web%3D%3Dother?cache=30',
    )
    expect(echo.requests).toHaveLength(1)
    expect(echo.requests[0].headers['x-risuai-info']).toBe('2026.4.181;fastify')
  })

  it('does not compress streamed hub responses when browsers advertise zstd', async () => {
    const body = JSON.stringify([{ name: 'realm-card', desc: 'x'.repeat(4096) }])
    echo.setResponder((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-total-count': '1',
      })
      res.end(body)
    })
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })

    const res = await requestHubOverSocket(harness.app, '/api/v1/hub/realm?search=+__shared&page=0', {
      'accept-encoding': 'gzip, deflate, br, zstd',
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.headers['content-length']).toBeUndefined()
    expect(res.headers['x-total-count']).toBe('1')
    expect(res.body.toString('utf8')).toBe(body)
  })

  it('rejects mutating hub requests without auth once a password is set', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/hub/hub/report',
      payload: { id: 'realm-id', report: 'spam' },
    })
    expect(res.statusCode).toBe(401)
    expect(echo.requests).toHaveLength(0)
  })

  it('rejects unauthenticated upstream URL overrides on otherwise public methods', { tags: 'core' }, async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/hub/ignored',
      headers: { 'x-risu-node-path': encodeURIComponent(`${echo.url}/anything`) },
    })
    expect(res.statusCode).toBe(401)
    expect(echo.requests).toHaveLength(0)
  })

  it('forwards GET to hubUrl with the path suffix and query string', async () => {
    echo.setResponder((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`hello ${req.url}`)
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/hub/risuhub/manifests?lang=en',
      headers: { 'risu-auth': assertion },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('hello /risuhub/manifests?lang=en')
    expect(echo.requests).toHaveLength(1)
    expect(echo.requests[0].method).toBe('GET')
  })

  it('forwards POST body bytes and sets origin to the hub origin', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const payload = Buffer.from(JSON.stringify({ name: 'mychar', revision: 1 }))
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/hub/upload',
      headers: {
        'risu-auth': assertion,
        'content-type': 'application/json',
        'x-custom-thing': 'present',
      },
      payload,
    })
    expect(res.statusCode).toBe(200)
    expect(echo.requests).toHaveLength(1)
    expect(echo.requests[0].method).toBe('POST')
    expect(Buffer.compare(echo.requests[0].body, payload)).toBe(0)
    expect(echo.requests[0].headers['content-type']).toBe('application/json')
    expect(echo.requests[0].headers['x-custom-thing']).toBe('present')
    expect(echo.requests[0].headers['origin']).toBe(new URL(echo.url).origin)
  })

  it('injects the persisted Realm token only for the exact removal operation', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    persistRealmAccount(harness.dataDir, {
      id: 'realm-owner',
      token: 'persisted-realm-token',
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/hub/hub/remove',
      headers: {
        'risu-auth': assertion,
        'content-type': 'text/plain',
      },
      payload: JSON.stringify({ id: 'realm-card-id' }),
    })

    expect(res.statusCode).toBe(200)
    expect(echo.requests).toHaveLength(1)
    expect(echo.requests[0].url).toBe('/hub/remove')
    expect(echo.requests[0].headers['content-type']).toBe('application/json')
    expect(JSON.parse(echo.requests[0].body.toString('utf8'))).toEqual({
      id: 'realm-card-id',
      token: 'persisted-realm-token',
    })
  })

  it('does not inject the persisted Realm token into other Hub requests', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    persistRealmAccount(harness.dataDir, {
      id: 'realm-owner',
      token: 'persisted-realm-token',
    })

    const payload = { id: 'realm-card-id', report: 'unsafe content' }
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/hub/hub/report',
      headers: {
        'risu-auth': assertion,
        'content-type': 'application/json',
      },
      payload,
    })

    expect(res.statusCode).toBe(200)
    expect(echo.requests).toHaveLength(1)
    expect(JSON.parse(echo.requests[0].body.toString('utf8'))).toEqual(payload)
  })

  it('rejects removal bodies with caller-supplied credentials or extra fields', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    persistRealmAccount(harness.dataDir, {
      id: 'realm-owner',
      token: 'persisted-realm-token',
    })

    for (const payload of [
      { id: 'realm-card-id', token: 'caller-token' },
      { id: 'realm-card-id', extra: true },
      { id: '' },
      { id: 'path/segment' },
    ]) {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/hub/hub/remove',
        headers: {
          'risu-auth': assertion,
          'content-type': 'application/json',
        },
        payload,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'Invalid Realm removal request' })
    }
    expect(echo.requests).toHaveLength(0)
  })

  it('rejects proxy overrides before a persisted Realm token can be injected', { tags: 'core' }, async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    persistRealmAccount(harness.dataDir, {
      id: 'realm-owner',
      token: 'persisted-realm-token',
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/hub/hub/remove',
      headers: {
        'risu-auth': assertion,
        'content-type': 'application/json',
        'x-risu-node-path': encodeURIComponent(`${echo.url}/attacker-capture`),
      },
      payload: { id: 'realm-card-id' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Invalid Realm removal route' })
    expect(echo.requests).toHaveLength(0)
  })

  it('rejects query variants of the secret-injecting Realm removal route', { tags: 'core' }, async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    persistRealmAccount(harness.dataDir, {
      id: 'realm-owner',
      token: 'persisted-realm-token',
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/hub/hub/remove?forward=elsewhere',
      headers: {
        'risu-auth': assertion,
        'content-type': 'application/json',
      },
      payload: { id: 'realm-card-id' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Invalid Realm removal route' })
    expect(echo.requests).toHaveLength(0)
  })

  it('applies a small independent body cap to Realm removal requests', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    persistRealmAccount(harness.dataDir, {
      id: 'realm-owner',
      token: 'persisted-realm-token',
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/hub/hub/remove',
      headers: {
        'risu-auth': assertion,
        'content-type': 'application/json',
      },
      payload: Buffer.alloc(REALM_REMOVE_BODY_MAX_BYTES + 1, 0x20),
    })

    expect(res.statusCode).toBe(413)
    expect(echo.requests).toHaveLength(0)
  })

  it('refuses removal when no usable persisted Realm credential exists', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    persistRealmAccount(harness.dataDir, {
      id: 'realm-owner',
      token: MASKED_PROVIDER_SECRET,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/hub/hub/remove',
      headers: {
        'risu-auth': assertion,
        'content-type': 'application/json',
      },
      payload: { id: 'realm-card-id' },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'Realm account credentials are unavailable' })
    expect(echo.requests).toHaveLength(0)
  })

  it('uses the shared proxy response-header strip policy', async () => {
    echo.setResponder((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-security-policy': "default-src 'none'",
        'content-security-policy-report-only': "script-src 'none'",
        'clear-site-data': '"cache"',
        'cache-control': 'no-store',
        'content-encoding': 'identity',
        'x-passthrough': 'kept',
      })
      res.end('body')
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/hub/anything',
      headers: { 'risu-auth': assertion },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-security-policy']).toBeUndefined()
    expect(res.headers['content-security-policy-report-only']).toBeUndefined()
    expect(res.headers['clear-site-data']).toBeUndefined()
    expect(res.headers['cache-control']).toBeUndefined()
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.headers['x-passthrough']).toBe('kept')
    expect(res.body).toBe('body')
  })

  it('strips proxy control headers from forwarded headers', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await harness.app.inject({
      method: 'GET',
      url: '/api/v1/hub/anything',
      headers: {
        'risu-auth': assertion,
        'risu-timeout-ms': '1234',
        'risu-url': encodeURIComponent('https://example.invalid/override'),
        'risu-header': encodeURIComponent(JSON.stringify({ 'x-leak': 'nope' })),
        'x-risu-node-path': encodeURIComponent(`${echo.url}/anything`),
        connection: 'keep-alive',
        'x-keep-me': 'yes',
      },
    })
    expect(echo.requests).toHaveLength(1)
    const fwd = echo.requests[0].headers
    expect(fwd['risu-auth']).toBeUndefined()
    expect(fwd['risu-timeout-ms']).toBeUndefined()
    expect(fwd['risu-url']).toBeUndefined()
    expect(fwd['risu-header']).toBeUndefined()
    expect(fwd['x-risu-node-path']).toBeUndefined()
    expect(fwd['x-keep-me']).toBe('yes')
  })

  it('returns 504 when the hub upstream deadline elapses before response', async () => {
    echo.setResponder((_req, res) => {
      const timer = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('late')
      }, 500)
      res.on('close', () => clearTimeout(timer))
    })
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/hub/slow',
      headers: { 'risu-timeout-ms': '50' },
    })
    expect(res.statusCode).toBe(504)
    expect(res.json()).toEqual({
      error: 'Hub request timed out after 50ms',
    })
    expect(echo.requests).toHaveLength(1)
  })

  it('keeps the hub body limit as a hard cap for authenticated uploads', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/hub/upload',
      headers: {
        'risu-auth': assertion,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.alloc(1024 * 1024 + 1),
    })
    expect(res.statusCode).toBe(413)
    expect(echo.requests).toHaveLength(0)
  })

  it('honors x-risu-node-path as a complete URL override', async () => {
    let altCalls = 0
    const altServer = http.createServer((req, res) => {
      altCalls += 1
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`alt ${req.url}`)
    })
    await new Promise<void>((r) => altServer.listen(0, '127.0.0.1', () => r()))
    const altAddr = altServer.address() as AddressInfo
    const altUrl = `http://127.0.0.1:${altAddr.port}/custom/path?x=1`
    try {
      const { assertion } = await setupAuthedClient(harness.app)
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/hub/ignored',
        headers: {
          'risu-auth': assertion,
          'x-risu-node-path': encodeURIComponent(altUrl),
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.body).toBe('alt /custom/path?x=1')
      expect(altCalls).toBe(1)
      expect(echo.requests).toHaveLength(0)
    } finally {
      await new Promise<void>((r) => altServer.close(() => r()))
    }
  })

  it('allows an authenticated complete-URL override to redirect within its own origin', async () => {
    const altPaths: string[] = []
    const altServer = http.createServer((req, res) => {
      altPaths.push(req.url ?? '')
      if (req.url === '/first') {
        res.writeHead(302, { location: '/final?from=override' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('override redirect complete')
    })
    await new Promise<void>((resolve) => altServer.listen(0, '127.0.0.1', () => resolve()))
    const altAddress = altServer.address() as AddressInfo
    const altUrl = `http://127.0.0.1:${altAddress.port}/first`

    try {
      const { assertion } = await setupAuthedClient(harness.app)
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/hub/ignored',
        headers: {
          'risu-auth': assertion,
          'x-risu-node-path': encodeURIComponent(altUrl),
        },
      })

      expect(res.statusCode).toBe(200)
      expect(res.body).toBe('override redirect complete')
      expect(altPaths).toEqual(['/first', '/final?from=override'])
      expect(echo.requests).toHaveLength(0)
    } finally {
      await new Promise<void>((resolve) => altServer.close(() => resolve()))
    }
  })

  it('follows a single 302 redirect and returns the redirected response', async () => {
    const altPaths: string[] = []
    let redirectedTo: string | undefined
    echo.setResponder((req, res) => {
      if (req.url === '/first') {
        redirectedTo = `${echo.url}/final`
        res.writeHead(302, { location: redirectedTo })
        res.end()
        return
      }
      altPaths.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('final body')
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/hub/first',
      headers: { 'risu-auth': assertion },
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('final body')
    expect(altPaths).toEqual(['/final'])
    expect(redirectedTo).toBeDefined()
  })

  it('resolves relative redirects against the original Hub request', async () => {
    echo.setResponder((req, res) => {
      if (req.url === '/nested/first') {
        res.writeHead(302, { location: '../final?from=relative' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`resolved ${req.url}`)
    })
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/hub/nested/first',
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('resolved /final?from=relative')
    expect(echo.requests.map((request) => request.url)).toEqual(['/nested/first', '/final?from=relative'])
  })

  it('rejects redirects that escape the configured Hub origin', async () => {
    const escapedRequests: string[] = []
    const escapedServer = http.createServer((req, res) => {
      escapedRequests.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('private response')
    })
    await new Promise<void>((resolve) => escapedServer.listen(0, '127.0.0.1', () => resolve()))
    const escapedAddress = escapedServer.address() as AddressInfo
    echo.setResponder((_req, res) => {
      res.writeHead(302, {
        location: `http://127.0.0.1:${escapedAddress.port}/private`,
      })
      res.end()
    })

    try {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/hub/redirect-outside',
      })

      expect(res.statusCode).toBe(502)
      expect(res.json()).toEqual({ error: 'Hub redirect target is not allowed' })
      expect(echo.requests).toHaveLength(1)
      expect(escapedRequests).toEqual([])
    } finally {
      await new Promise<void>((resolve) => escapedServer.close(() => resolve()))
    }
  })

  it('rejects redirects to non-HTTP schemes', async () => {
    echo.setResponder((_req, res) => {
      res.writeHead(302, { location: 'file:///etc/passwd' })
      res.end()
    })

    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/hub/redirect-file',
    })

    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: 'Hub redirect target is not allowed' })
    expect(echo.requests).toHaveLength(1)
  })

  it('rejects body-bearing redirects instead of replaying the buffered upload', async () => {
    const payload = Buffer.from(JSON.stringify({ name: 'redirected-body' }))
    echo.setResponder((req, res) => {
      if (req.url === '/first') {
        res.writeHead(302, { location: `${echo.url}/final` })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('unexpected')
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/hub/first',
      headers: {
        'risu-auth': assertion,
        'content-type': 'application/json',
      },
      payload,
    })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({
      error: 'Hub request redirects with bodies are not replayed',
    })
    expect(echo.requests).toHaveLength(1)
    expect(echo.requests[0].url).toBe('/first')
    expect(Buffer.compare(echo.requests[0].body, payload)).toBe(0)
  })

  it('aborts the upstream stream when the client disconnects', async () => {
    let closeUpstream!: () => void
    const upstreamClosed = new Promise<void>((resolve) => {
      closeUpstream = resolve
    })
    echo.setResponder((_req, res) => {
      res.on('close', closeUpstream)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('first chunk\n')
    })

    await harness.app.listen({ host: '127.0.0.1', port: 0 })
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        let destroyed = false
        const req = http.get(`${appBaseUrl(harness.app)}/api/v1/hub/stream`, (res) => {
          expect(res.statusCode).toBe(200)
          res.once('data', (chunk: Buffer) => {
            expect(chunk.toString()).toContain('first chunk')
            destroyed = true
            req.destroy()
            resolve()
          })
        })
        req.on('error', (err) => {
          if (!destroyed) reject(err)
        })
      }),
      1_000,
      'client did not receive the streamed hub chunk',
    )
    await withTimeout(upstreamClosed, 1_000, 'hub did not abort the upstream stream after client disconnect')
  })

  it('returns 502 when the upstream connection fails', async () => {
    // Close the echo server so the upstream is unreachable.
    await echo.close()
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/hub/dead',
      headers: { 'risu-auth': assertion },
    })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({
      error: expect.stringContaining('Proxy request failed'),
    })
  })
})
