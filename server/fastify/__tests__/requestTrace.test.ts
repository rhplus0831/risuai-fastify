import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import type { RequestTraceMode } from '../src/config.js'
import { REQUEST_UID_HEADER } from '../src/requestTrace.js'

interface Harness {
  app: FastifyInstance
  dataDir: string
}

interface TraceEntry {
  Method: string
  Url: string
  Route?: string
  Caller?: string
  'Request-Header': string
  'Request-Body'?: TraceBodyEntry
  'Response-Header': string
  'Response-Body'?: TraceBodyEntry
  'X-Request-UID': string
  Timing: {
    process: number
    send: number
  }
}

type TraceBodyEntry =
  | {
      storage: 'inline'
      contentType?: string
      contentLength?: number
      bytes: number
      sha256: string
      redacted?: true
      text: string
    }
  | {
      storage: 'gzip'
      contentType?: string
      contentLength?: number
      bytes: number
      gzipBytes: number
      sha256: string
      redacted?: true
      path: string
      preview: string
    }
  | {
      storage: 'omitted'
      contentType?: string
      contentLength?: number
      bytes?: number
      gzipBytes?: number
      sha256?: string
      redacted?: true
      preview?: string
      reason: string
    }

const uidHeaderName = REQUEST_UID_HEADER.toLowerCase()

async function startHarness(
  mode?: RequestTraceMode,
  options: { bodySidecarMaxGzipBytes?: number; entryLimit?: number } = {},
): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-trace-'))
  const requestTrace = mode
    ? {
        mode,
        ...(options.bodySidecarMaxGzipBytes !== undefined
          ? { bodySidecarMaxGzipBytes: options.bodySidecarMaxGzipBytes }
          : {}),
        ...(options.entryLimit !== undefined ? { entryLimit: options.entryLimit } : {}),
      }
    : undefined
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      requestTrace,
    },
    memoryWorker: false,
    assetGc: false,
    generationChat: { finalizationRetry: false },
  })
  return { app, dataDir }
}

async function stopHarness(h: Harness): Promise<void> {
  await h.app.close()
  rmSync(h.dataDir, { recursive: true, force: true })
}

function tracePath(h: Harness, mode: RequestTraceMode): string {
  return path.join(h.dataDir, 'trace', `${mode}.jsonl`)
}

function readTraceEntries(h: Harness, mode: RequestTraceMode): TraceEntry[] {
  const contents = readFileSync(tracePath(h, mode), 'utf8').trim()
  if (!contents) return []
  return contents.split('\n').map((line) => JSON.parse(line) as TraceEntry)
}

async function waitForTraceEntries(
  h: Harness,
  mode: RequestTraceMode,
  count: number,
  predicate: (entries: TraceEntry[]) => boolean = () => true,
): Promise<TraceEntry[]> {
  const deadline = Date.now() + 1000
  let lastEntries: TraceEntry[] = []
  while (Date.now() < deadline) {
    if (existsSync(tracePath(h, mode))) {
      lastEntries = readTraceEntries(h, mode)
      if (lastEntries.length === count && predicate(lastEntries)) return lastEntries
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(lastEntries).toHaveLength(count)
  return lastEntries
}

async function waitForDirectoryEntries(directory: string, expected: string[]): Promise<string[]> {
  const deadline = Date.now() + 1000
  let lastEntries: string[] = []
  while (Date.now() < deadline) {
    lastEntries = existsSync(directory) ? readdirSync(directory).sort() : []
    if (JSON.stringify(lastEntries) === JSON.stringify(expected)) return lastEntries
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return lastEntries
}

function expectTiming(value: unknown): void {
  expect(typeof value).toBe('number')
  expect(value).toBeGreaterThanOrEqual(0)
}

function requireTraceBody(entry: TraceEntry, key: 'Request-Body' | 'Response-Body'): TraceBodyEntry {
  const body = entry[key]
  expect(body).toBeDefined()
  return body!
}

function deterministicLowCompressionText(length: number): string {
  let state = 0x12345678
  let text = ''
  while (text.length < length) {
    state = (state * 1664525 + 1013904223) >>> 0
    text += state.toString(16).padStart(8, '0')
  }
  return text.slice(0, length)
}

let harness: Harness

afterEach(async () => {
  if (harness) {
    await stopHarness(harness)
  }
})

describe('request trace', () => {
  it('does not add request UIDs or logs when tracing is disabled', async () => {
    harness = await startHarness()

    const res = await harness.app.inject({ method: 'GET', url: '/api/v1/health' })

    expect(res.statusCode).toBe(200)
    expect(res.headers[uidHeaderName]).toBeUndefined()
    expect(existsSync(tracePath(harness, 'agent'))).toBe(false)
    expect(existsSync(tracePath(harness, 'human'))).toBe(false)
  })

  it('adds a UID response header to non-API requests without writing JSONL', async () => {
    harness = await startHarness('agent')

    const res = await harness.app.inject({ method: 'GET', url: '/character/123' })

    expect(res.statusCode).toBe(404)
    expect(res.headers[uidHeaderName]).toMatch(/^[a-f0-9]{64}$/)
    expect(existsSync(tracePath(harness, 'agent'))).toBe(false)
  })

  it('appends API request trace entries as JSONL', { tags: 'core' }, async () => {
    harness = await startHarness('agent')

    const authorizationSecret = 'Bearer TRACE-AUTHORIZATION-SENTINEL'
    const apiKeySecret = 'TRACE-X-API-KEY-SENTINEL'

    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: {
        'risu-auth': 'secret-auth-token',
        'sec-websocket-protocol': 'risu-stream-v1, risu-auth.secret-websocket-token',
        authorization: authorizationSecret,
        'x-api-key': apiKeySecret,
        'user-agent': '',
        'x-debug-test': 'trace-me',
      },
    })

    const responseUid = String(res.headers[uidHeaderName])
    expect(responseUid).toMatch(/^[a-f0-9]{64}$/)
    const [entry] = await waitForTraceEntries(harness, 'agent', 1)
    expect(entry.Method).toBe('GET')
    expect(entry.Url).toBe('/api/v1/health')
    expect(entry.Route).toBe('/api/v1/health')
    expect(entry.Caller).toBeUndefined()
    expect(entry['X-Request-UID']).toBe(responseUid)
    expectTiming(entry.Timing.process)
    expectTiming(entry.Timing.send)

    const requestHeaders = JSON.parse(entry['Request-Header']) as Record<string, string>
    const responseHeaders = JSON.parse(entry['Response-Header']) as Record<string, string>
    expect(requestHeaders['x-debug-test']).toBe('trace-me')
    expect(requestHeaders['risu-auth']).toBe('[redacted]')
    expect(requestHeaders['sec-websocket-protocol']).toBe('[redacted]')
    expect(requestHeaders.authorization).toBe('[redacted]')
    expect(requestHeaders['x-api-key']).toBe('[redacted]')
    expect(requestHeaders[uidHeaderName]).toBe(responseUid)
    expect(responseHeaders[uidHeaderName]).toBe(responseUid)
    const persisted = readFileSync(tracePath(harness, 'agent'), 'utf8')
    expect(persisted).not.toContain(authorizationSecret)
    expect(persisted).not.toContain(apiKeySecret)
  })

  it('records route metadata, explicit caller, and redacted query params', { tags: 'core' }, async () => {
    harness = await startHarness('agent')

    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/chats/chat-1/messages?token=secret-token&api_key=secret-key&safe=visible',
      headers: {
        'x-risu-caller': 'client-bootstrap?access_token=secret-caller-token&view=main',
      },
    })

    expect(res.statusCode).toBe(401)
    const [entry] = await waitForTraceEntries(harness, 'agent', 1)
    expect(entry.Method).toBe('GET')
    expect(entry.Url).toBe('/api/v1/chats/chat-1/messages?token=[redacted]&api_key=[redacted]&safe=visible')
    expect(entry.Route).toBe('/api/v1/chats/:id/messages')
    expect(entry.Caller).toBe('x-risu-caller=client-bootstrap?access_token=[redacted]&view=main')
  })

  it('falls back to referer, user-agent, and writer session caller details', async () => {
    harness = await startHarness('agent')

    await harness.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: {
        referer: 'http://localhost:6418/?token=secret-token&panel=chat',
        'user-agent': 'trace-test-agent',
        'risu-writer-session': 'writer-a',
      },
    })

    const [entry] = await waitForTraceEntries(harness, 'agent', 1)
    expect(entry.Caller).toBe(
      'referer=http://localhost:6418/?token=[redacted]&panel=chat; user-agent=trace-test-agent; risu-writer-session=writer-a',
    )
  })

  it('inlines small JSON request and response bodies with body redaction', { tags: 'core' }, async () => {
    harness = await startHarness('agent')

    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/exists',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        ids: [],
        apiKey: 'secret-api-key',
        nested: {
          accessToken: 'secret-access-token',
          visible: 'keep-me',
        },
      }),
    })

    const [entry] = await waitForTraceEntries(harness, 'agent', 1)
    const requestBody = requireTraceBody(entry, 'Request-Body')
    expect(requestBody.storage).toBe('inline')
    expect(requestBody.contentType).toContain('application/json')
    if (requestBody.storage === 'inline') {
      expect(requestBody.redacted).toBe(true)
      const parsed = JSON.parse(requestBody.text) as {
        apiKey: string
        nested: { accessToken: string; visible: string }
      }
      expect(parsed.apiKey).toBe('[redacted]')
      expect(parsed.nested.accessToken).toBe('[redacted]')
      expect(parsed.nested.visible).toBe('keep-me')
      expect(requestBody.bytes).toBe(Buffer.byteLength(requestBody.text, 'utf8'))
      expect(requestBody.sha256).toMatch(/^[a-f0-9]{64}$/)
    }

    const responseBody = requireTraceBody(entry, 'Response-Body')
    expect(responseBody.storage).toBe('inline')
    if (responseBody.storage === 'inline') {
      expect(JSON.parse(responseBody.text)).toEqual({ missing: [] })
    }
  })

  it('never retains startup telemetry request bodies, including rejected content-bearing fields', async () => {
    harness = await startHarness('agent')
    const sentinel = 'private-character-and-chat-content-must-not-be-retained'

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/telemetry/startup',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        version: 1,
        events: [],
        rejectedContent: sentinel,
      }),
    })

    expect(res.statusCode).toBe(401)
    const [entry] = await waitForTraceEntries(harness, 'agent', 1)
    expect(entry.Route).toBe('/api/v1/telemetry/startup')
    expect(requireTraceBody(entry, 'Request-Body')).toMatchObject({
      storage: 'omitted',
      contentType: 'application/json',
      reason: 'telemetry-metadata',
    })
    expect(readFileSync(tracePath(harness, 'agent'), 'utf8')).not.toContain(sentinel)
  })

  it('stores large text bodies as gzip sidecars', async () => {
    harness = await startHarness('agent', { bodySidecarMaxGzipBytes: 512 })

    const note = 'x'.repeat(5 * 1024)
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/exists',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        ids: [],
        note,
      }),
    })

    const [entry] = await waitForTraceEntries(harness, 'agent', 1)
    const requestBody = requireTraceBody(entry, 'Request-Body')
    expect(requestBody.storage).toBe('gzip')
    if (requestBody.storage !== 'gzip') return

    expect(requestBody.path).toMatch(/^trace\/bodies\/agent\/[a-f0-9]{64}\.request\.json\.gz$/)
    expect(requestBody.preview.length).toBeGreaterThan(0)
    expect(requestBody.bytes).toBeGreaterThan(4 * 1024)
    expect(requestBody.gzipBytes).toBeGreaterThan(0)

    const sidecarPath = path.join(harness.dataDir, requestBody.path)
    expect(existsSync(sidecarPath)).toBe(true)
    const sidecarText = gunzipSync(readFileSync(sidecarPath)).toString('utf8')
    expect(JSON.parse(sidecarText)).toEqual({ ids: [], note })
  })

  it('omits text sidecars above the compressed body size cap', async () => {
    harness = await startHarness('agent', { bodySidecarMaxGzipBytes: 512 })

    const note = deterministicLowCompressionText(8 * 1024)
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/exists',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        ids: [],
        note,
      }),
    })

    const [entry] = await waitForTraceEntries(harness, 'agent', 1)
    const requestBody = requireTraceBody(entry, 'Request-Body')
    expect(requestBody.storage).toBe('omitted')
    if (requestBody.storage !== 'omitted') return

    expect(requestBody.reason).toBe('compressed-too-large')
    expect(requestBody.bytes).toBeGreaterThan(4 * 1024)
    expect(requestBody.gzipBytes).toBeGreaterThan(512)
    expect(requestBody.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(requestBody.preview).toContain('"note"')
    expect(requestBody.preview!.length).toBeGreaterThan(0)
  })

  it('records omitted metadata for streaming response bodies', async () => {
    harness = await startHarness('agent')
    harness.app.get('/api/test/trace-stream', async (_req, reply) => {
      reply.header('content-type', 'text/plain')
      return reply.send(Readable.from(['streamed body']))
    })

    await harness.app.inject({ method: 'GET', url: '/api/test/trace-stream' })

    const [entry] = await waitForTraceEntries(harness, 'agent', 1)
    const responseBody = requireTraceBody(entry, 'Response-Body')
    expect(responseBody).toEqual({
      storage: 'omitted',
      contentType: 'text/plain',
      reason: 'stream',
    })
  })

  it('uses the selected trace mode file', async () => {
    harness = await startHarness('human')

    await harness.app.inject({ method: 'GET', url: '/api/v1/health' })
    await waitForTraceEntries(harness, 'human', 1)

    expect(existsSync(tracePath(harness, 'human'))).toBe(true)
    expect(existsSync(tracePath(harness, 'agent'))).toBe(false)
  })

  it('keeps only the newest trace entries and deletes trimmed body sidecars', async () => {
    harness = await startHarness('agent', { entryLimit: 2 })
    const note = 'x'.repeat(5 * 1024)

    for (const seq of [1, 2, 3]) {
      await harness.app.inject({
        method: 'POST',
        url: `/api/v1/assets/exists?seq=${seq}`,
        headers: {
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          ids: [],
          note,
        }),
      })
    }

    const expectedUrls = ['/api/v1/assets/exists?seq=2', '/api/v1/assets/exists?seq=3']
    const entries = await waitForTraceEntries(harness, 'agent', 2, (rows) => {
      return rows.map((entry) => entry.Url).join('\n') === expectedUrls.join('\n')
    })
    expect(entries.map((entry) => entry.Url)).toEqual(expectedUrls)

    const bodyPaths = entries.map((entry) => {
      const requestBody = requireTraceBody(entry, 'Request-Body')
      expect(requestBody.storage).toBe('gzip')
      return requestBody.storage === 'gzip' ? requestBody.path : ''
    })
    for (const bodyPath of bodyPaths) {
      expect(existsSync(path.join(harness.dataDir, bodyPath))).toBe(true)
    }

    const bodiesDir = path.join(harness.dataDir, 'trace', 'bodies', 'agent')
    const traceContents = readFileSync(tracePath(harness, 'agent'), 'utf8')
    const expectedBodyFiles = Array.from(new Set(bodyPaths))
      .map((bodyPath) => path.basename(bodyPath))
      .sort()
    expect(traceContents).not.toContain('seq=1')
    expect(existsSync(bodiesDir)).toBe(true)
    expect(await waitForDirectoryEntries(bodiesDir, expectedBodyFiles)).toEqual(expectedBodyFiles)
  })
})
