import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { webcrypto } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { buildApp } from '../src/app.js'
import { JobRegistry, type StreamJob } from '../src/streamJobs.js'

const subtle = webcrypto.subtle

interface Harness {
  app: FastifyInstance
  dataDir: string
}

async function startHarness(agentDevAuthBypass = false): Promise<Harness> {
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
      agentDevAuthBypass,
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

interface JobCompletionBarrier {
  waitFor(jobId: string): Promise<void>
  restore(): void
}

function observeJobCompletion(): JobCompletionBarrier {
  const completed = new Set<string>()
  const waiters = new Map<string, () => void>()
  const originalMarkDone = JobRegistry.prototype.markDone
  const spy = vi.spyOn(JobRegistry.prototype, 'markDone').mockImplementation(function (
    this: JobRegistry,
    job: StreamJob,
    now?: number,
  ): void {
    originalMarkDone.call(this, job, now)
    completed.add(job.id)
    waiters.get(job.id)?.()
  })

  return {
    waitFor(jobId) {
      if (completed.has(jobId)) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(jobId)
          reject(new Error(`stream job ${jobId} did not complete`))
        }, 5_000)
        waiters.set(jobId, () => {
          clearTimeout(timer)
          waiters.delete(jobId)
          resolve()
        })
      })
    },
    restore() {
      spy.mockRestore()
    },
  }
}

async function createCompletedStreamJob(app: FastifyInstance, assertion: string, url: string): Promise<string> {
  const completion = observeJobCompletion()
  try {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/proxy/stream-jobs',
      headers: { 'risu-auth': assertion },
      payload: { url },
    })
    const { jobId } = create.json() as { jobId: string }
    await completion.waitFor(jobId)
    return jobId
  } finally {
    completion.restore()
  }
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

interface CollectedRun {
  ws: WebSocket
  events: { type: string }[]
  chunks: Buffer[]
}

async function injectAndCollect(
  app: FastifyInstance,
  url: string,
  upgradeContext: Record<string, unknown>,
  until: (event: { type: string }) => boolean,
): Promise<CollectedRun> {
  return new Promise<CollectedRun>((resolve, reject) => {
    const events: { type: string }[] = []
    const chunks: Buffer[] = []
    let resolved = false
    const onInit = (ws: WebSocket): void => {
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          chunks.push(Buffer.from(data as Buffer))
          return
        }
        const text = typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8')
        const ev = JSON.parse(text) as { type: string }
        events.push(ev)
        if (until(ev) && !resolved) {
          resolved = true
          resolve({ ws, events, chunks })
        }
      })
      ws.once('error', (err) => {
        if (!resolved) reject(err)
      })
      ws.once('close', () => {
        if (!resolved) {
          resolved = true
          resolve({ ws, events, chunks })
        }
      })
    }
    app.injectWS(url, upgradeContext, { onInit }).catch((err) => {
      if (!resolved) reject(err)
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
  await echo.close()
  await stopHarness(harness)
})

describe('POST /api/v1/proxy/stream-jobs', () => {
  it('returns 401 before password setup', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/stream-jobs',
      payload: { url: echo.url },
    })
    expect(res.statusCode).toBe(401)
  })

  it('honors the agent-development auth bypass consistently', async () => {
    await stopHarness(harness)
    harness = await startHarness(true)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/stream-jobs',
      payload: { url: echo.url },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ jobId: expect.any(String) })
  })

  it('returns 401 without auth once a password is set', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/stream-jobs',
      payload: { url: echo.url },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns jobId and heartbeatSec on success', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/stream-jobs',
      headers: { 'risu-auth': assertion },
      payload: { url: echo.url, heartbeatSec: 30 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { jobId: string; heartbeatSec: number }
    expect(typeof body.jobId).toBe('string')
    expect(body.jobId.length).toBeGreaterThan(0)
    expect(body.heartbeatSec).toBe(30)
  })

  it('returns 400 when target URL is non-local', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/stream-jobs',
      headers: { 'risu-auth': assertion },
      payload: { url: 'https://example.com' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      error: expect.stringContaining('Invalid target URL'),
    })
  })

  it('returns 400 on disallowed method', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/stream-jobs',
      headers: { 'risu-auth': assertion },
      payload: { url: echo.url, method: 'CONNECT' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 413 when bodyBase64 exceeds the cap', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const oversize = 'a'.repeat(8 * 1024 * 1024 + 1)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/stream-jobs',
      headers: { 'risu-auth': assertion },
      payload: { url: echo.url, bodyBase64: oversize },
    })
    expect(res.statusCode).toBe(413)
  })
})

describe('DELETE /api/v1/proxy/stream-jobs/:id', () => {
  it('cancels an existing job and is idempotent for unknown ids', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    echo.setResponder((_req, res) => {
      setTimeout(() => {
        res.writeHead(200)
        res.end('late')
      }, 500)
    })

    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/stream-jobs',
      headers: { 'risu-auth': assertion },
      payload: { url: echo.url, timeoutMs: 30_000 },
    })
    const { jobId } = create.json() as { jobId: string }

    const del = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/proxy/stream-jobs/${encodeURIComponent(jobId)}`,
      headers: { 'risu-auth': assertion },
    })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ success: true })

    const del2 = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/proxy/stream-jobs/no-such-id',
      headers: { 'risu-auth': assertion },
    })
    expect(del2.statusCode).toBe(200)
    expect(del2.json()).toEqual({ success: true })
  })
})

describe('WebSocket /api/v1/proxy/stream-jobs/:id/ws', () => {
  it('streams job_accepted, upstream_headers, chunk, done in order', async () => {
    echo.setResponder((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'x-keep-me': 'yes',
        'cache-control': 'no-store',
        'content-encoding': 'identity',
        'content-security-policy': "default-src 'none'",
        'content-security-policy-report-only': 'whatever',
        'clear-site-data': '"cache"',
      })
      res.write('one')
      setTimeout(() => {
        res.write('two')
        res.end()
      }, 20)
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/stream-jobs',
      headers: { 'risu-auth': assertion },
      payload: { url: echo.url },
    })
    const { jobId } = create.json() as { jobId: string }

    const { ws, events, chunks } = await injectAndCollect(
      harness.app,
      `/api/v1/proxy/stream-jobs/${jobId}/ws`,
      { headers: { 'risu-auth': assertion } },
      (e) => e.type === 'done',
    )
    ws.close()
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('job_accepted')
    expect(types).toContain('upstream_headers')
    expect(types.at(-1)).toBe('done')
    const head = events.find((e) => e.type === 'upstream_headers') as
      | { type: 'upstream_headers'; status: number; headers: Record<string, string> }
      | undefined
    expect(head?.status).toBe(200)
    expect(head?.headers['content-type']).toBe('text/plain')
    expect(head?.headers['x-keep-me']).toBe('yes')
    expect(head?.headers['cache-control']).toBeUndefined()
    expect(head?.headers['content-encoding']).toBeUndefined()
    expect(head?.headers['content-security-policy']).toBeUndefined()
    expect(head?.headers['content-security-policy-report-only']).toBeUndefined()
    expect(head?.headers['clear-site-data']).toBeUndefined()
    const combined = chunks.map((chunk) => chunk.toString('utf8')).join('')
    expect(combined).toBe('onetwo')
  })

  it('accepts the assertion via a WebSocket subprotocol without putting it in the URL', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/proxy/stream-jobs',
      headers: { 'risu-auth': assertion },
      payload: { url: echo.url },
    })
    const { jobId } = create.json() as { jobId: string }

    const url = `/api/v1/proxy/stream-jobs/${jobId}/ws`
    const { ws, events } = await injectAndCollect(
      harness.app,
      url,
      { headers: { 'sec-websocket-protocol': `risu-stream-v1, risu-auth.${assertion}` } },
      (e) => e.type === 'done',
    )
    ws.close()
    expect(events[0].type).toBe('job_accepted')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('does not accept credentials from the WebSocket query string', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await expect(
      harness.app.injectWS(`/api/v1/proxy/stream-jobs/anything/ws?risu-auth=${encodeURIComponent(assertion)}`),
    ).rejects.toThrow(/401/)
  })

  it('rejects WS upgrade without auth once a password is set', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    await expect(harness.app.injectWS('/api/v1/proxy/stream-jobs/anything/ws')).rejects.toThrow(/401/)
  })

  it('rejects WS upgrade for unknown job id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await expect(
      harness.app.injectWS('/api/v1/proxy/stream-jobs/no-such-id/ws', { headers: { 'risu-auth': assertion } }),
    ).rejects.toThrow(/404/)
  })

  it('flushes events emitted before the WS attaches', async () => {
    echo.setResponder((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello')
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const jobId = await createCompletedStreamJob(harness.app, assertion, echo.url)

    const { ws, events, chunks } = await injectAndCollect(
      harness.app,
      `/api/v1/proxy/stream-jobs/${jobId}/ws`,
      { headers: { 'risu-auth': assertion } },
      (e) => e.type === 'done',
    )
    ws.close()
    expect(events[0].type).toBe('job_accepted')
    expect(events.some((e) => e.type === 'upstream_headers')).toBe(true)
    expect(chunks.map((chunk) => chunk.toString('utf8')).join('')).toBe('hello')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('closes a viewer that attaches to an already-done job instead of pinning it', async () => {
    echo.setResponder((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello')
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const jobId = await createCompletedStreamJob(harness.app, assertion, echo.url)

    // A real socket (not the inject transport): the assertion is that the
    // SERVER initiates the close handshake — the viewer never hangs up.
    // Pre-fix this attached client pinned the job (and its ping timer)
    // until the client disconnected.
    await harness.app.listen({ host: '127.0.0.1', port: 0 })
    const port = (harness.app.server.address() as AddressInfo).port
    const { WebSocket: WsClient } = await import('ws')
    const ws = new WsClient(`ws://127.0.0.1:${port}/api/v1/proxy/stream-jobs/${jobId}/ws`, [
      'risu-stream-v1',
      `risu-auth.${assertion}`,
    ])
    const events: { type: string }[] = []
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      events.push(JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as { type: string })
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not close the done-job viewer')), 3_000)
      ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    // The buffered tail was still flushed before the close...
    expect(events.some((event) => event.type === 'done')).toBe(true)
    // ...and the job is unpinned: detaching the last viewer of a done job
    // cleans it up, so a fresh attach now 404s.
    await expect(
      harness.app.injectWS(`/api/v1/proxy/stream-jobs/${jobId}/ws`, {
        headers: { 'risu-auth': assertion },
      }),
    ).rejects.toThrow(/404/)
  })
})
