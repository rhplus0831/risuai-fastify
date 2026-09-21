import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { webcrypto } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { EventEmitter } from 'node:events'
import type { FastifyInstance } from 'fastify'
import { REQUEST_RECEIVE_TIMEOUT_MS, buildApp } from '../src/app.js'
import { NON_DURABLE_REQUEST_DEADLINE_MS } from '../src/requestAbort.js'
import {
  PROXY_FETCH_DEFAULT_TIMEOUT_MS,
  PROXY_FETCH_MAX_TIMEOUT_MS,
  createTimeoutController,
  filterPluginResponseHeaders,
  filterResponseHeaders,
  getRequestTimeoutMs,
  normalizeForwardHeaders,
} from '../src/proxy.js'
import { createProxyDisconnectController } from '../src/routes/proxy.js'

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
      bodyLimit: 1024 * 1024,
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

let harness: Harness
let echo: EchoServer

beforeEach(async () => {
  harness = await startHarness()
  echo = await startEcho()
})

afterEach(async () => {
  vi.useRealTimers()
  await echo.close()
  await stopHarness(harness)
})

async function withShortenedProxyDeadline(timeoutMs: number, run: () => Promise<void>): Promise<void> {
  const realSetTimeout = globalThis.setTimeout
  const spy = vi.spyOn(globalThis, 'setTimeout')
  spy.mockImplementation(((
    callback: Parameters<typeof setTimeout>[0],
    delay?: Parameters<typeof setTimeout>[1],
    ...args: unknown[]
  ) => {
    return realSetTimeout(callback, delay === timeoutMs ? 0 : delay, ...(args as []))
  }) as typeof setTimeout)
  try {
    await run()
  } finally {
    spy.mockRestore()
  }
}

describe('proxy disconnect lifecycle', () => {
  function rawPair(options: {
    requestComplete: boolean
    responseEnded: boolean
    requestAborted?: boolean
    requestDestroyed?: boolean
    responseDestroyed?: boolean
  }) {
    const request = Object.assign(new EventEmitter(), {
      aborted: options.requestAborted ?? false,
      complete: options.requestComplete,
      destroyed: options.requestDestroyed ?? false,
    })
    const response = Object.assign(new EventEmitter(), {
      destroyed: options.responseDestroyed ?? false,
      writableEnded: options.responseEnded,
    })
    return { request, response }
  }

  it('does not abort when a normally completed inbound request closes', () => {
    const { request, response } = rawPair({ requestComplete: true, responseEnded: false })
    const disconnect = createProxyDisconnectController(request as any, response as any)

    request.emit('close')

    expect(disconnect.signal.aborted).toBe(false)
    disconnect.cleanup()
  })

  it('aborts on a premature request close or unfinished response close', () => {
    const first = rawPair({ requestComplete: false, responseEnded: false })
    const requestDisconnect = createProxyDisconnectController(first.request as any, first.response as any)
    first.request.emit('close')
    expect(requestDisconnect.signal.aborted).toBe(true)

    const second = rawPair({ requestComplete: true, responseEnded: false })
    const responseDisconnect = createProxyDisconnectController(second.request as any, second.response as any)
    second.response.emit('close')
    expect(responseDisconnect.signal.aborted).toBe(true)
  })

  it('does not abort when the completed response closes', () => {
    const { request, response } = rawPair({ requestComplete: true, responseEnded: true })
    const disconnect = createProxyDisconnectController(request as any, response as any)

    response.emit('close')

    expect(disconnect.signal.aborted).toBe(false)
    disconnect.cleanup()
  })

  it('starts aborted when the inbound connection was already destroyed', () => {
    const requestClosed = rawPair({
      requestComplete: false,
      requestDestroyed: true,
      responseEnded: false,
    })
    expect(
      createProxyDisconnectController(requestClosed.request as any, requestClosed.response as any).signal.aborted,
    ).toBe(true)

    const responseClosed = rawPair({
      requestComplete: true,
      responseDestroyed: true,
      responseEnded: false,
    })
    expect(
      createProxyDisconnectController(responseClosed.request as any, responseClosed.response as any).signal.aborted,
    ).toBe(true)
  })
})

function appPort(app: FastifyInstance): number {
  const addr = app.server.address() as AddressInfo
  return addr.port
}

function requestProxyFetchOverSocket(
  app: FastifyInstance,
  assertion: string,
  upstreamUrl: string,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const req = http.request(
      {
        host: '127.0.0.1',
        port: appPort(app),
        method: 'POST',
        path: '/api/v1/proxy/fetch',
        headers: {
          'risu-auth': assertion,
          'risu-url': encodeURIComponent(upstreamUrl),
        },
      },
      (res) => {
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        res.once('error', reject)
        res.once('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
      },
    )
    req.setTimeout(3_000, () => {
      req.destroy(new Error('proxy fetch socket request timed out'))
    })
    req.once('error', reject)
    req.end()
  })
}

describe('POST /api/v1/proxy/fetch', () => {
  it('normalizes proxy fetch timeout headers to the default, explicit value, or cap', () => {
    expect(PROXY_FETCH_DEFAULT_TIMEOUT_MS).toBe(NON_DURABLE_REQUEST_DEADLINE_MS)
    expect(getRequestTimeoutMs(undefined)).toBe(PROXY_FETCH_DEFAULT_TIMEOUT_MS)
    expect(getRequestTimeoutMs('')).toBe(PROXY_FETCH_DEFAULT_TIMEOUT_MS)
    expect(getRequestTimeoutMs('not-a-timeout')).toBe(PROXY_FETCH_DEFAULT_TIMEOUT_MS)
    expect(getRequestTimeoutMs('250')).toBe(250)
    expect(getRequestTimeoutMs(`${PROXY_FETCH_MAX_TIMEOUT_MS + 1}`)).toBe(PROXY_FETCH_MAX_TIMEOUT_MS)
  })

  it('cleanup clears proxy fetch timeout timers before they abort', () => {
    vi.useFakeTimers()
    const timeout = createTimeoutController(25)
    timeout.cleanup()
    vi.advanceTimersByTime(25)
    expect(timeout.signal.aborted).toBe(false)
    expect(timeout.timedOut()).toBe(false)
  })

  it('strips decompression-sensitive upstream response framing headers', () => {
    expect(
      filterResponseHeaders(
        new Headers({
          'content-encoding': 'gzip',
          'content-length': '73',
          'transfer-encoding': 'chunked',
          'x-custom': 'preserved',
        }),
      ),
    ).toEqual({ 'x-custom': 'preserved' })
  })

  it('strips static and Connection-nominated hop-by-hop headers in both directions', () => {
    expect(
      normalizeForwardHeaders({
        connection: 'keep-alive, x-remove-me',
        'keep-alive': 'timeout=5',
        te: 'trailers',
        'x-remove-me': 'secret',
        'x-keep-me': 'yes',
      }),
    ).toEqual({ 'x-keep-me': 'yes' })
    expect(
      filterResponseHeaders(
        new Headers({
          connection: 'keep-alive, x-remove-me',
          'keep-alive': 'timeout=5',
          trailer: 'x-checksum',
          'x-remove-me': 'secret',
          'x-keep-me': 'yes',
        }),
      ),
    ).toEqual({ 'x-keep-me': 'yes' })
  })

  it('strips cookie setters and origin-scoped auth challenges from plugin proxy responses', () => {
    expect(
      filterPluginResponseHeaders(
        new Headers({
          'proxy-authenticate': 'Basic realm="proxy"',
          'set-cookie': 'session=attacker',
          'set-cookie2': 'legacy=attacker',
          'www-authenticate': 'Basic realm="upstream"',
          'content-encoding': 'gzip',
          'content-length': '123',
          'x-custom': 'preserved',
        }),
      ),
    ).toEqual({ 'content-encoding': 'gzip', 'x-custom': 'preserved' })
  })

  it('returns 401 without auth once a password is set', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/fetch',
      headers: { 'risu-url': encodeURIComponent(echo.url) },
    })
    expect(res.statusCode).toBe(401)
    expect(echo.requests).toHaveLength(0)
  })

  it('returns 400 when risu-url is missing', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/fetch',
      headers: { 'risu-auth': assertion },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'URL has no param' })
    expect(echo.requests).toHaveLength(0)
  })

  it.each(['http://127.0.0.1/private', 'http://169.254.169.254/latest/meta-data', 'http://[::ffff:7f00:1]/private'])(
    'blocks plugin proxy access to non-public target %s without affecting the generic route',
    async (url) => {
      const { assertion } = await setupAuthedClient(harness.app)
      const blocked = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/proxy/plugin-fetch',
        headers: {
          'risu-auth': assertion,
          'risu-url': encodeURIComponent(url),
        },
      })
      expect(blocked.statusCode).toBe(403)
      expect(echo.requests).toHaveLength(0)

      const firstParty = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/proxy/fetch',
        headers: {
          'risu-auth': assertion,
          'risu-url': encodeURIComponent(echo.url),
        },
      })
      expect(firstParty.statusCode).toBe(200)
      expect(echo.requests).toHaveLength(1)
    },
  )

  it.each(['PATCH', 'HEAD', 'OPTIONS'] as const)(
    'registers plugin proxy method %s without widening the generic route',
    async (method) => {
      const { assertion } = await setupAuthedClient(harness.app)
      const plugin = await harness.app.inject({
        method,
        url: '/api/v1/proxy/plugin-fetch',
        headers: {
          'risu-auth': assertion,
          'risu-url': encodeURIComponent('http://127.0.0.1/private'),
        },
      })
      expect(plugin.statusCode).toBe(403)

      const generic = await harness.app.inject({
        method,
        url: '/api/v1/proxy/fetch',
        headers: {
          'risu-auth': assertion,
          'risu-url': encodeURIComponent(echo.url),
        },
      })
      expect(generic.statusCode).toBe(404)
    },
  )

  it('forwards upstream status, body, and filters response headers', async () => {
    echo.setResponder((_req, res) => {
      res.writeHead(202, {
        'content-type': 'text/plain',
        'cache-control': 'no-store',
        'content-encoding': 'identity',
        'content-security-policy': "default-src 'none'",
        'content-security-policy-report-only': 'whatever',
        'clear-site-data': '"cache"',
        'x-custom': 'preserved',
      })
      res.end('hello upstream')
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/fetch',
      headers: {
        'risu-auth': assertion,
        'risu-url': encodeURIComponent(echo.url),
      },
    })
    expect(res.statusCode).toBe(202)
    expect(res.headers['content-type']).toBe('text/plain')
    expect(res.headers['x-custom']).toBe('preserved')
    expect(res.headers['cache-control']).toBeUndefined()
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.headers['content-security-policy']).toBeUndefined()
    expect(res.headers['content-security-policy-report-only']).toBeUndefined()
    expect(res.headers['clear-site-data']).toBeUndefined()
    expect(res.body).toBe('hello upstream')
  })

  it('streams decompressed gzip responses without stale content-length', async () => {
    const plain = 'proxy gzip payload\n'.repeat(750)
    const compressed = gzipSync(Buffer.from(plain, 'utf8'))
    expect(compressed.length).toBeLessThan(Buffer.byteLength(plain))

    echo.setResponder((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': String(compressed.length),
        'x-upstream-compressed-length': String(compressed.length),
      })
      res.end(compressed)
    })

    const { assertion } = await setupAuthedClient(harness.app)
    await harness.app.listen({ port: 0, host: '127.0.0.1' })

    const res = await requestProxyFetchOverSocket(harness.app, assertion, echo.url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.headers['content-length']).toBeUndefined()
    expect(res.headers['x-upstream-compressed-length']).toBe(String(compressed.length))
    expect(res.body.toString('utf8')).toBe(plain)
  })

  it.each([
    { method: 'GET' as const, payload: undefined },
    { method: 'POST' as const, payload: Buffer.from(JSON.stringify({ method: 'post' })) },
    { method: 'PUT' as const, payload: Buffer.from(JSON.stringify({ method: 'put' })) },
    { method: 'DELETE' as const, payload: undefined },
  ])('forwards $method and its body upstream', async ({ method, payload }) => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method,
      url: '/api/v1/proxy/fetch',
      headers: {
        'risu-auth': assertion,
        'risu-url': encodeURIComponent(echo.url),
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload ? { payload } : {}),
    })
    expect(res.statusCode).toBe(200)
    expect(echo.requests).toHaveLength(1)
    expect(echo.requests[0].method).toBe(method)
    expect(echo.requests[0].body).toEqual(payload ?? Buffer.alloc(0))
    if (payload) {
      expect(echo.requests[0].headers['content-type']).toBe('application/json')
    }
  })

  it('strips risu-* and host-class headers from the upstream request', { tags: 'core' }, async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/fetch',
      headers: {
        'risu-auth': assertion,
        'risu-url': encodeURIComponent(echo.url),
        'risu-timeout-ms': '5000',
        'risu-header': 'not-json',
        connection: 'keep-alive',
        'x-keep-me': 'yes',
      },
      payload: Buffer.from(''),
    })
    expect(echo.requests).toHaveLength(1)
    const fwd = echo.requests[0].headers
    expect(fwd['risu-auth']).toBeUndefined()
    expect(fwd['risu-url']).toBeUndefined()
    expect(fwd['risu-timeout-ms']).toBeUndefined()
    expect(fwd['risu-header']).toBeUndefined()
    expect(fwd['x-keep-me']).toBe('yes')
    // host is rewritten by undici to the upstream's host, not the inbound's
    expect(fwd['host']).toMatch(/^127\.0\.0\.1:/)
  })

  it('uses risu-header JSON override and discards inbound headers', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const overrideHeaders = {
      'x-only-from-override': 'yes',
      authorization: 'Bearer fake',
    }
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/fetch',
      headers: {
        'risu-auth': assertion,
        'risu-url': encodeURIComponent(echo.url),
        'risu-header': encodeURIComponent(JSON.stringify(overrideHeaders)),
        'x-inbound-only': 'should-be-dropped',
      },
      payload: Buffer.from(''),
    })
    expect(echo.requests).toHaveLength(1)
    const fwd = echo.requests[0].headers
    expect(fwd['x-only-from-override']).toBe('yes')
    expect(fwd['authorization']).toBe('Bearer fake')
    expect(fwd['x-inbound-only']).toBeUndefined()
  })

  it('applies the default deadline when risu-timeout-ms is absent', async () => {
    echo.setResponder(() => {
      // Keep the upstream open until the proxy deadline aborts it.
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await withShortenedProxyDeadline(PROXY_FETCH_DEFAULT_TIMEOUT_MS, async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/proxy/fetch',
        headers: {
          'risu-auth': assertion,
          'risu-url': encodeURIComponent(echo.url),
        },
      })
      expect(res.statusCode).toBe(504)
      expect(res.json()).toEqual({
        error: `Proxy request timed out after ${PROXY_FETCH_DEFAULT_TIMEOUT_MS}ms`,
      })
    })
  })

  it('caps excessive risu-timeout-ms values at the proxy fetch maximum', async () => {
    echo.setResponder(() => {
      // Keep the upstream open until the capped proxy deadline aborts it.
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await withShortenedProxyDeadline(PROXY_FETCH_MAX_TIMEOUT_MS, async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/proxy/fetch',
        headers: {
          'risu-auth': assertion,
          'risu-url': encodeURIComponent(echo.url),
          'risu-timeout-ms': `${PROXY_FETCH_MAX_TIMEOUT_MS + 60_000}`,
        },
      })
      expect(res.statusCode).toBe(504)
      expect(res.json()).toEqual({
        error: `Proxy request timed out after ${PROXY_FETCH_MAX_TIMEOUT_MS}ms`,
      })
    })
  })

  it('returns 504 when a valid explicit risu-timeout-ms elapses first', async () => {
    echo.setResponder((_req, res) => {
      setTimeout(() => {
        res.writeHead(200)
        res.end('late')
      }, 500)
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/fetch',
      headers: {
        'risu-auth': assertion,
        'risu-url': encodeURIComponent(echo.url),
        'risu-timeout-ms': '50',
      },
    })
    expect(res.statusCode).toBe(504)
    expect(res.json()).toEqual({
      error: 'Proxy request timed out after 50ms',
    })
    expect(echo.requests).toHaveLength(1)
  })

  it('normalizes invalid risu-timeout-ms headers to the default deadline', async () => {
    echo.setResponder(() => {
      // Keep the upstream open until the default proxy deadline aborts it.
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await withShortenedProxyDeadline(PROXY_FETCH_DEFAULT_TIMEOUT_MS, async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/proxy/fetch',
        headers: {
          'risu-auth': assertion,
          'risu-url': encodeURIComponent(echo.url),
          'risu-timeout-ms': 'definitely-not-a-number',
        },
      })
      expect(res.statusCode).toBe(504)
      expect(res.json()).toEqual({
        error: `Proxy request timed out after ${PROXY_FETCH_DEFAULT_TIMEOUT_MS}ms`,
      })
    })
  })

  it('streams a multi-chunk upstream body through unbuffered', async () => {
    echo.setResponder((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: one\n\n')
      setTimeout(() => {
        res.write('data: two\n\n')
        res.end()
      }, 20)
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/fetch',
      headers: {
        'risu-auth': assertion,
        'risu-url': encodeURIComponent(echo.url),
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.body).toBe('data: one\n\ndata: two\n\n')
  })

  it('configures the generous request-receive timeout backstop (600s reference)', () => {
    expect(REQUEST_RECEIVE_TIMEOUT_MS).toBe(600_000)
    expect(harness.app.server.requestTimeout).toBe(REQUEST_RECEIVE_TIMEOUT_MS)
  })

  it('a client disconnect mid-fetch aborts the upstream request', async () => {
    let resolveUpstreamStarted!: () => void
    const upstreamStarted = new Promise<void>((r) => {
      resolveUpstreamStarted = r
    })
    let resolveUpstreamClosed!: () => void
    const upstreamClosed = new Promise<void>((r) => {
      resolveUpstreamClosed = r
    })
    echo.setResponder((_req, res) => {
      // Hold the upstream open without responding; `close` then only fires
      // when the proxy aborts the upstream connection.
      res.on('close', () => resolveUpstreamClosed())
      resolveUpstreamStarted()
    })

    const { assertion } = await setupAuthedClient(harness.app)
    await harness.app.listen({ port: 0, host: '127.0.0.1' })
    const addr = harness.app.server.address() as AddressInfo

    const creq = http.request({
      host: '127.0.0.1',
      port: addr.port,
      method: 'POST',
      path: '/api/v1/proxy/fetch',
      headers: {
        'risu-auth': assertion,
        'risu-url': encodeURIComponent(echo.url),
      },
    })
    creq.on('error', () => {
      // The local destroy below surfaces as ECONNRESET; irrelevant here.
    })
    creq.end()

    await upstreamStarted
    creq.destroy()

    const outcome = await Promise.race([
      upstreamClosed.then(() => 'upstream-aborted' as const),
      new Promise<'still-open'>((r) => setTimeout(() => r('still-open'), 2_000)),
    ])
    expect(outcome).toBe('upstream-aborted')
  })
})
