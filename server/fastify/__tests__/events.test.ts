import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { webcrypto } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import {
  InMemoryCommandEventSink,
  createCommandEventSink,
  listPersistedCommandEventHistory,
  persistCommandEvent,
  selectPersistedCommandEventReplay,
  type CommandEvent,
  type CommandEventListener,
  type CommandEventSink,
} from '../src/commands/events.js'
import { bumpRevision, openDatabase } from '../src/db.js'
import { ACTIVE_WRITER_SESSION_HEADER, DISCONNECT_EXISTING_WRITER_HEADER } from '../src/activeWriter.js'
import { createMemoryEventBus, type MemoryEvent, type MemoryEventSink } from '../src/memoryEvents.js'
import { createEventStreamMetricTracker } from '../src/routes/events.js'
import { enqueueBardWikiJob } from '../src/bardWikiJobs.js'

interface CapturedProtocolMetric extends Record<string, unknown> {
  metric: string
}

const capturedMetrics = vi.hoisted((): CapturedProtocolMetric[] => [])

vi.mock('../src/protocolMetrics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/protocolMetrics.js')>()
  return {
    ...actual,
    emitProtocolMetric: (name: string, fields: Record<string, unknown> | (() => Record<string, unknown>)) => {
      if (!actual.protocolMetricsEnabled()) return
      capturedMetrics.push({ metric: name, ...(typeof fields === 'function' ? fields() : fields) })
    },
  }
})

const subtle = webcrypto.subtle

class TrackingCommandEventSink implements CommandEventSink {
  private readonly inner = createCommandEventSink()
  activeListeners = 0
  onBeforeSubscribe?: () => void

  emit(event: CommandEvent): void {
    this.inner.emit(event)
  }

  list(): readonly CommandEvent[] {
    return this.inner.list()
  }

  clear(): void {
    this.inner.clear()
  }

  subscribe(listener: CommandEventListener): () => void {
    this.onBeforeSubscribe?.()
    const unsubscribeInner = this.inner.subscribe(listener)
    this.activeListeners++
    return () => {
      unsubscribeInner()
      this.activeListeners--
    }
  }
}

interface Harness {
  app: FastifyInstance
  dataDir: string
  commandEvents: TrackingCommandEventSink
  closed: boolean
}

async function startHarness(opts: { dataDir?: string; memoryEvents?: MemoryEventSink } = {}): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = opts.dataDir ?? mkdtempSync(path.join(tmpdir(), 'risu-fastify-events-'))
  const commandEvents = new TrackingCommandEventSink()
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
    memoryEvents: opts.memoryEvents,
    memoryWorker: false,
    bardWikiWorker: false,
  })
  return { app, dataDir, commandEvents, closed: false }
}

async function stopHarness(h: Harness, removeDataDir = true): Promise<void> {
  if (!h.closed) {
    await h.app.close()
    h.closed = true
  }
  if (removeDataDir) {
    rmSync(h.dataDir, { recursive: true, force: true })
  }
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
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

  return { assertion: await signAssertion(keypair.privateKey, publicKey) }
}

async function importDatabase(
  app: FastifyInstance,
  assertion: string,
  database: Record<string, unknown>,
): Promise<number> {
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion },
    payload: { database },
  })
  expect(imported.statusCode).toBe(200)
  return imported.json().revision as number
}

function clearPersistedCommandEvents(dataDir: string): void {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    db.exec('DELETE FROM command_events')
  } finally {
    db.close()
  }
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 2_000
  let text = ''
  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for SSE data')), 250),
      ),
    ])
    if (result.done) break
    text += Buffer.from(result.value).toString('utf8')
    if (predicate(text)) return text
  }
  throw new Error(`timed out waiting for SSE data; received ${JSON.stringify(text)}`)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}

function parseSseJsonEvents(text: string, eventName: string): unknown[] {
  return text.split('\n\n').flatMap((frame) => {
    const lines = frame.split('\n')
    if (!lines.includes(`event: ${eventName}`)) return []
    const dataLine = lines.find((line) => line.startsWith('data: '))
    return dataLine ? [JSON.parse(dataLine.slice('data: '.length))] : []
  })
}

function commandDataLine(text: string): string | undefined {
  return text
    .split('\n')
    .find((line) => line.startsWith('data: ') && line.includes('"type"') && line.includes('"revision"'))
}

let harness: Harness
const PREVIOUS_PROTOCOL_METRICS = process.env.RISU_PROTOCOL_METRICS

beforeEach(async () => {
  delete process.env.RISU_PROTOCOL_METRICS
  capturedMetrics.length = 0
  harness = await startHarness()
})

afterEach(async () => {
  await stopHarness(harness)
  if (PREVIOUS_PROTOCOL_METRICS === undefined) {
    delete process.env.RISU_PROTOCOL_METRICS
  } else {
    process.env.RISU_PROTOCOL_METRICS = PREVIOUS_PROTOCOL_METRICS
  }
})

describe('command events stream', () => {
  it('bounds retained command event history while preserving live fanout', () => {
    const sink = new InMemoryCommandEventSink(2)
    const seen: CommandEvent[] = []
    sink.subscribe((event) => {
      seen.push(event)
    })

    const events: CommandEvent[] = [
      { type: 'settings.updated', revision: 1, resource: 'settings' },
      { type: 'preset.updated', revision: 2, resource: 'preset', id: 'preset-1' },
      { type: 'chat.updated', revision: 3, resource: 'chat', id: 'chat-1' },
    ]

    for (const event of events) {
      sink.emit(event)
    }

    expect(seen).toEqual(events)
    expect(sink.list()).toEqual(events.slice(1))

    sink.clear()
    expect(sink.list()).toEqual([])
  })

  it('bounds persisted command event history while preserving contiguous replay', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-event-history-'))
    const db = openDatabase(dataDir)
    try {
      persistCommandEvent(db, { type: 'settings.updated', revision: 1, resource: 'settings' }, 2)
      persistCommandEvent(db, { type: 'preset.updated', revision: 2, resource: 'preset' }, 2)
      persistCommandEvent(db, { type: 'chat.updated', revision: 3, resource: 'chat' }, 2)

      expect(listPersistedCommandEventHistory(db)).toEqual([
        { type: 'preset.updated', revision: 2, resource: 'preset' },
        { type: 'chat.updated', revision: 3, resource: 'chat' },
      ])
      expect(selectPersistedCommandEventReplay(db, 2, 3)).toEqual({
        status: 'ok',
        events: [{ type: 'chat.updated', revision: 3, resource: 'chat' }],
      })
      expect(selectPersistedCommandEventReplay(db, 0, 3)).toEqual({
        status: 'unavailable',
        currentRevision: 3,
        oldestRevision: 2,
        latestRevision: 3,
      })
    } finally {
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('round-trips optional generation-operation lineage through persisted replay', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-event-lineage-'))
    const db = openDatabase(dataDir)
    try {
      const event: CommandEvent = {
        type: 'generation.persisted',
        revision: 1,
        resource: 'chatMessages',
        id: 'assistant-a',
        parentId: 'chat-a',
        databaseLineage: 'database-a',
        operationId: 'operation-a',
        sourceMessageId: 'user-a',
        jobId: 'job-a',
      }
      persistCommandEvent(db, event)
      expect(listPersistedCommandEventHistory(db)).toEqual([event])
    } finally {
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('prunes by revision keep-window with a bounded range delete, not an OFFSET walk', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-event-prune-'))
    const db = openDatabase(dataDir)
    try {
      // Contiguous case: identical retention to the former keep-latest-N-rows
      // walk — the newest `historyLimit` revisions survive.
      for (let revision = 1; revision <= 5; revision++) {
        persistCommandEvent(db, { type: 'settings.updated', revision, resource: 'settings' }, 3)
      }
      expect(listPersistedCommandEventHistory(db).map((event) => event.revision)).toEqual([3, 4, 5])

      // Keep-window semantics: retention is the revision window ending at the
      // just-persisted revision (12 - 3 = 9; everything <= 9 is deleted), not
      // a count of surviving rows. One range DELETE bounds the work.
      persistCommandEvent(db, { type: 'settings.updated', revision: 12, resource: 'settings' }, 3)
      expect(listPersistedCommandEventHistory(db).map((event) => event.revision)).toEqual([12])

      // Below the window nothing is deleted (negative threshold is a no-op).
      persistCommandEvent(db, { type: 'settings.updated', revision: 13, resource: 'settings' }, 1000)
      expect(listPersistedCommandEventHistory(db).map((event) => event.revision)).toEqual([12, 13])
    } finally {
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('keeps memory event bus delivery best-effort across throwing subscribers', () => {
    const bus = createMemoryEventBus()
    const event: MemoryEvent = {
      type: 'memory.job',
      chatId: 'chat-1',
      job: {
        id: 'job-1',
        instanceId: 'job-instance-1',
        kind: 'summarize',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        updatedAt: '2026-08-11T00:00:00.000Z',
      },
    }
    const seen: MemoryEvent[] = []

    bus.subscribe(() => {
      throw new Error('memory subscriber exploded')
    })
    bus.subscribe((received) => {
      seen.push(received)
    })

    expect(() => bus.emit(event)).not.toThrow()
    expect(seen).toEqual([
      {
        ...event,
        streamId: expect.any(String),
        version: 1,
      },
    ])
  })

  it('emits one opt-in memory fanout metric per event and no metric when disabled', () => {
    const event: MemoryEvent = {
      type: 'memory.job',
      chatId: 'chat-metric',
      job: {
        id: 'job-metric',
        instanceId: 'job-metric-instance',
        kind: 'summarize',
        status: 'running',
        attemptCount: 1,
        maxAttempts: 3,
        updatedAt: '2026-08-11T00:00:00.000Z',
      },
    }
    const bus = createMemoryEventBus()
    const published: MemoryEvent[] = []
    bus.subscribe((value) => published.push(value))
    bus.subscribe(() => {})

    bus.emit(event)
    expect(capturedMetrics).toEqual([])

    process.env.RISU_PROTOCOL_METRICS = '1'
    bus.emit(event)

    const metrics = capturedMetrics.filter((metric) => metric.metric === 'memory_event_fanout')
    expect(metrics).toHaveLength(1)
    const publishedEvent = published.at(-1)!
    const payloadBytes = Buffer.byteLength(JSON.stringify(publishedEvent), 'utf8')
    const frameBytes = Buffer.byteLength(`event: memory\ndata: ${JSON.stringify(publishedEvent)}\n\n`, 'utf8')
    expect(metrics[0]).toMatchObject({
      payloadBytes,
      frameBytes,
      listenerCount: 2,
      deliveredBytes: frameBytes * 2,
      jobKind: 'summarize',
      jobStatus: 'running',
      hasSideEffect: false,
    })
  })

  it('emits one body-free event-stream metric for normal cleanup and slow-consumer overflow', () => {
    expect(createEventStreamMetricTracker()).toBeNull()
    process.env.RISU_PROTOCOL_METRICS = '1'
    const normal = createEventStreamMetricTracker()
    normal?.recordFrame('writer', 'event: writer\ndata: {"epoch":0}\n\n')
    normal?.recordFrame('connected', ': connected\n\n')
    normal?.finish('normal_close')
    normal?.finish('client_abort')

    const overflow = createEventStreamMetricTracker()
    overflow?.recordFrame('memory', 'event: memory\ndata: {}\n\n')
    overflow?.finish('slow_consumer_overflow')

    const metrics = capturedMetrics.filter((metric) => metric.metric === 'event_stream_connection')
    expect(metrics).toHaveLength(2)
    expect(metrics[0]).toMatchObject({
      frameCount: 2,
      frameCounts: { writer: 1, connected: 1, command: 0, memory: 0, heartbeat: 0 },
      closeReason: 'normal_close',
      writeOverflow: false,
      connectionLifetimeMs: expect.any(Number),
    })
    expect(metrics[1]).toMatchObject({
      frameCount: 1,
      closeReason: 'slow_consumer_overflow',
      writeOverflow: true,
    })
    expect(metrics.every((metric) => !('body' in metric) && !('frames' in metric))).toBe(true)
  })

  it('rejects unauthenticated event streams once a password is set', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })

    const res = await harness.app.inject({ method: 'GET', url: '/api/v1/events' })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Auth required' })
  })

  it('sets up an authenticated SSE stream', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const baseUrl = await listen(harness.app)
    const abort = new AbortController()

    const res = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { 'risu-auth': assertion },
      signal: abort.signal,
    })
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()

    try {
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      const text = await readUntil(reader!, (chunk) => chunk.includes(': connected\n\n'))
      expect(parseSseJsonEvents(text, 'writer')).toEqual([
        { databaseLineage: expect.any(String), sessionId: null, epoch: 0 },
      ])
      expect(text).not.toContain('id: ')
      expect(text).toContain(': connected\n\n')
    } finally {
      abort.abort()
      reader?.releaseLock()
    }
  })

  it('requires confirmation before replacing a writer with an open event stream', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const firstWriter = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, [ACTIVE_WRITER_SESSION_HEADER]: 'writer-old' },
    })
    expect(firstWriter.statusCode).toBe(200)
    const baseUrl = await listen(harness.app)
    const abort = new AbortController()
    const res = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { 'risu-auth': assertion, [ACTIVE_WRITER_SESSION_HEADER]: 'writer-old' },
      signal: abort.signal,
    })
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    await readUntil(reader!, (chunk) => chunk.includes(': connected\n\n'))

    const unconfirmedTakeover = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, [ACTIVE_WRITER_SESSION_HEADER]: 'writer-new' },
    })
    expect(unconfirmedTakeover.statusCode).toBe(409)
    expect(unconfirmedTakeover.json()).toMatchObject({ error: 'active_writer_connected' })

    const takeover = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: {
        'risu-auth': assertion,
        [ACTIVE_WRITER_SESSION_HEADER]: 'writer-new',
        [DISCONNECT_EXISTING_WRITER_HEADER]: 'true',
      },
    })
    expect(takeover.statusCode).toBe(200)

    try {
      const text = await readUntil(reader!, (chunk) => chunk.includes('writer-new'))
      expect(parseSseJsonEvents(text, 'writer')).toEqual([
        { databaseLineage: firstWriter.json().databaseLineage, sessionId: 'writer-new', epoch: 2 },
      ])
    } finally {
      abort.abort()
      reader?.releaseLock()
    }
  })

  it('does not broadcast a same-session re-latch', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const firstWriter = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
    })
    expect(firstWriter.statusCode).toBe(200)

    const baseUrl = await listen(harness.app)
    const abort = new AbortController()
    const res = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { 'risu-auth': assertion },
      signal: abort.signal,
    })
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    const initial = await readUntil(reader!, (chunk) => chunk.includes(': connected\n\n'))
    expect(parseSseJsonEvents(initial, 'writer')).toEqual([
      { databaseLineage: firstWriter.json().databaseLineage, sessionId: 'writer-a', epoch: 1 },
    ])

    const sameWriter = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
    })
    expect(sameWriter.statusCode).toBe(200)
    const nextWriter = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-b' },
    })
    expect(nextWriter.statusCode).toBe(200)

    try {
      const text = await readUntil(reader!, (chunk) => chunk.includes('writer-b'))
      expect(parseSseJsonEvents(text, 'writer')).toEqual([
        { databaseLineage: firstWriter.json().databaseLineage, sessionId: 'writer-b', epoch: 2 },
      ])
    } finally {
      abort.abort()
      reader?.releaseLock()
    }
  })

  it('delivers command events from successful command mutations', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      streamGeminiThoughts: false,
    })
    const baseUrl = await listen(harness.app)
    const abort = new AbortController()

    const res = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { 'risu-auth': assertion },
      signal: abort.signal,
    })
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    await readUntil(reader!, (chunk) => chunk.includes(': connected\n\n'))

    const command = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { streamGeminiThoughts: true } },
    })
    expect(command.statusCode).toBe(200)

    try {
      const text = await readUntil(reader!, (chunk) => chunk.includes('settings.updated'))
      expect(text).toContain('id: 2')
      expect(text).toContain('event: command')
      const dataLine = commandDataLine(text)
      expect(dataLine).toBeDefined()
      expect(JSON.parse(dataLine!.slice('data: '.length))).toEqual({
        type: 'settings.updated',
        revision: 2,
        resource: 'settings',
        id: 'runtime',
      })
    } finally {
      abort.abort()
      reader?.releaseLock()
    }
  })

  it('replays retained command events after the requested revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      streamGeminiThoughts: false,
    })
    const command = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { streamGeminiThoughts: true } },
    })
    expect(command.statusCode).toBe(200)
    const nextRevision = command.json().revision as number

    const baseUrl = await listen(harness.app)
    const abort = new AbortController()
    const res = await fetch(`${baseUrl}/api/v1/events?sinceRevision=${revision}`, {
      headers: { 'risu-auth': assertion },
      signal: abort.signal,
    })
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()

    try {
      expect(res.status).toBe(200)
      const text = await readUntil(reader!, (chunk) => chunk.includes('settings.updated'))
      expect(text).toContain(`id: ${nextRevision}`)
      expect(text).toContain('event: command')
      const dataLine = commandDataLine(text)
      expect(dataLine).toBeDefined()
      expect(JSON.parse(dataLine!.slice('data: '.length))).toEqual({
        type: 'settings.updated',
        revision: nextRevision,
        resource: 'settings',
        id: 'runtime',
      })
    } finally {
      abort.abort()
      reader?.releaseLock()
    }
  })

  it('replays the writer-session origin so reconnect keeps own-echo suppression', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      streamGeminiThoughts: false,
    })
    // Claim the writer session, then mutate as that writer.
    const boot = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-l29' },
    })
    expect(boot.statusCode).toBe(200)
    const command = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-l29' },
      payload: { baseRevision: revision, patch: { streamGeminiThoughts: true } },
    })
    expect(command.statusCode).toBe(200)
    const nextRevision = command.json().revision as number

    // The origin persists with the event row...
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      const persisted = listPersistedCommandEventHistory(db).find((event) => event.revision === nextRevision)
      expect(persisted?.origin).toEqual({ writerSessionId: 'writer-l29' })
    } finally {
      db.close()
    }

    // ...and a reconnect replay carries it, identical to the live emit.
    const baseUrl = await listen(harness.app)
    const abort = new AbortController()
    const res = await fetch(`${baseUrl}/api/v1/events?sinceRevision=${revision}`, {
      headers: { 'risu-auth': assertion },
      signal: abort.signal,
    })
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    try {
      const text = await readUntil(reader!, (chunk) => chunk.includes('settings.updated'))
      const dataLine = commandDataLine(text)
      expect(dataLine).toBeDefined()
      expect(JSON.parse(dataLine!.slice('data: '.length))).toEqual({
        type: 'settings.updated',
        revision: nextRevision,
        resource: 'settings',
        id: 'runtime',
        origin: { writerSessionId: 'writer-l29' },
      })
    } finally {
      abort.abort()
      reader?.releaseLock()
    }
  })

  it('replays stored command events after app restart', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      streamGeminiThoughts: false,
    })
    const command = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { streamGeminiThoughts: true } },
    })
    expect(command.statusCode).toBe(200)
    const nextRevision = command.json().revision as number

    const dataDir = harness.dataDir
    await stopHarness(harness, false)
    harness = await startHarness({ dataDir })

    const baseUrl = await listen(harness.app)
    const abort = new AbortController()
    const res = await fetch(`${baseUrl}/api/v1/events?sinceRevision=${revision}`, {
      headers: { 'risu-auth': assertion },
      signal: abort.signal,
    })
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()

    try {
      expect(res.status).toBe(200)
      const text = await readUntil(reader!, (chunk) => chunk.includes('settings.updated'))
      expect(text).toContain(`id: ${nextRevision}`)
      const dataLine = commandDataLine(text)
      expect(dataLine).toBeDefined()
      expect(JSON.parse(dataLine!.slice('data: '.length))).toEqual({
        type: 'settings.updated',
        revision: nextRevision,
        resource: 'settings',
        id: 'runtime',
      })
    } finally {
      abort.abort()
      reader?.releaseLock()
    }
  })

  it('replays a command committed during event stream setup', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      streamGeminiThoughts: false,
    })
    const setupEvent: CommandEvent = {
      type: 'settings.updated',
      revision: revision + 1,
      resource: 'settings',
    }
    let emittedDuringSetup = false
    harness.commandEvents.onBeforeSubscribe = () => {
      if (emittedDuringSetup) return
      emittedDuringSetup = true
      const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
      try {
        expect(bumpRevision(db)).toBe(setupEvent.revision)
        persistCommandEvent(db, setupEvent)
      } finally {
        db.close()
      }
      harness.commandEvents.emit(setupEvent)
    }

    const baseUrl = await listen(harness.app)
    const abort = new AbortController()
    const res = await fetch(`${baseUrl}/api/v1/events?sinceRevision=${revision}`, {
      headers: { 'risu-auth': assertion },
      signal: abort.signal,
    })
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()

    try {
      expect(res.status).toBe(200)
      const text = await readUntil(reader!, (chunk) => chunk.includes('settings.updated'))
      expect(text).toContain(`id: ${setupEvent.revision}`)
      const dataLine = commandDataLine(text)
      expect(dataLine).toBeDefined()
      expect(JSON.parse(dataLine!.slice('data: '.length))).toEqual(setupEvent)
      expect(emittedDuringSetup).toBe(true)
    } finally {
      harness.commandEvents.onBeforeSubscribe = undefined
      abort.abort()
      reader?.releaseLock()
    }
  })

  it('accepts Last-Event-ID as a replay cursor', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      streamGeminiThoughts: false,
    })
    const command = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { streamGeminiThoughts: true } },
    })
    expect(command.statusCode).toBe(200)
    const nextRevision = command.json().revision as number

    const baseUrl = await listen(harness.app)
    const abort = new AbortController()
    const res = await fetch(`${baseUrl}/api/v1/events`, {
      headers: {
        'risu-auth': assertion,
        'Last-Event-ID': String(revision),
      },
      signal: abort.signal,
    })
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()

    try {
      expect(res.status).toBe(200)
      const text = await readUntil(reader!, (chunk) => chunk.includes('settings.updated'))
      expect(text).toContain(`id: ${nextRevision}`)
    } finally {
      abort.abort()
      reader?.releaseLock()
    }
  })

  it('reports replay unavailable when retained history cannot cover the cursor', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      streamGeminiThoughts: false,
    })
    clearPersistedCommandEvents(harness.dataDir)
    process.env.RISU_PROTOCOL_METRICS = '1'
    capturedMetrics.length = 0

    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/events?sinceRevision=0',
      headers: { 'risu-auth': assertion },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({
      error: 'event_replay_unavailable',
      requestedRevision: 0,
      currentRevision: revision,
    })
    expect(capturedMetrics.filter((metric) => metric.metric === 'event_stream_connection')).toEqual([])
  })

  it('reports replay unavailable when the cursor is ahead of the server revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      streamGeminiThoughts: false,
    })

    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/events?sinceRevision=${revision + 1}`,
      headers: { 'risu-auth': assertion },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({
      error: 'event_replay_unavailable',
      requestedRevision: revision + 1,
      currentRevision: revision,
      oldestRevision: revision,
      latestRevision: revision,
    })
  })

  it('rejects invalid replay cursors before opening the stream', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/events?sinceRevision=wat',
      headers: { 'risu-auth': assertion },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: 'invalid_event_replay_cursor',
      reason: 'sinceRevision must be a non-negative integer',
    })
  })

  it('hydrates active jobs on startup and clears memory jobs authoritatively on reconnect', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const pending = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/memory/jobs',
      headers: { 'risu-auth': assertion },
      payload: {
        chatId: 'chat-snapshot',
        kind: 'embed',
        payload: { chunkId: 'chunk-1', model: 'model-a' },
      },
    })
    expect(pending.statusCode).toBe(201)
    const pendingJob = pending.json().job as { id: string; instanceId: string }
    const db = openDatabase(harness.dataDir)
    try {
      db.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, 0, ?)').run('character-snapshot', '{}')
      db.prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, 0, ?)').run(
        'chat-bard-snapshot',
        'character-snapshot',
        '{}',
      )
      enqueueBardWikiJob(db, {
        id: 'bard-job-active',
        instanceId: 'bard-instance-active',
        chatId: 'chat-bard-snapshot',
        kind: 'rebuild_chat',
        payload: {
          chatId: 'chat-bard-snapshot',
          generation: 1,
          sourceCursor: 0,
          sourceTotal: 2,
          policy: 'full',
          stagingManifestId: 'manifest-active',
        },
      })
      enqueueBardWikiJob(db, {
        id: 'bard-job-failed',
        instanceId: 'bard-instance-failed',
        chatId: 'chat-bard-snapshot',
        kind: 'rebuild_chat',
        payload: {
          chatId: 'chat-bard-snapshot',
          generation: 2,
          sourceCursor: 0,
          sourceTotal: 2,
          policy: 'full',
          stagingManifestId: 'manifest-failed',
        },
      })
      db.prepare(
        `UPDATE bardwiki_jobs
         SET status = 'failed', error_code = 'provider_error',
             error_summary = 'authorization: secret-token'
         WHERE id = 'bard-job-failed'`,
      ).run()
    } finally {
      db.close()
    }
    const baseUrl = await listen(harness.app)

    const firstAbort = new AbortController()
    const first = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { 'risu-auth': assertion },
      signal: firstAbort.signal,
    })
    const firstReader = first.body!.getReader()
    const firstText = await readUntil(firstReader, (chunk) => chunk.includes('event: memory_snapshot\n'))
    const firstSnapshots = parseSseJsonEvents(firstText, 'memory_snapshot') as Array<{
      streamId: string
      version: number
      jobs: Array<{ id: string; instanceId: string; status: string }>
      bardWikiJobs: Array<Record<string, unknown>>
    }>
    expect(firstSnapshots).toHaveLength(1)
    expect(firstSnapshots[0]).toMatchObject({
      streamId: expect.any(String),
      version: expect.any(Number),
      jobs: [{ id: pendingJob.id, instanceId: pendingJob.instanceId, status: 'pending' }],
      bardWikiJobs: [
        { id: 'bard-job-active', instanceId: 'bard-instance-active', status: 'pending' },
        { id: 'bard-job-failed', instanceId: 'bard-instance-failed', status: 'failed' },
      ],
    })
    expect(firstSnapshots[0].bardWikiJobs[0]).not.toHaveProperty('payload')
    expect(firstSnapshots[0].bardWikiJobs[1].errorSummary).toBe('authorization: [redacted]')
    firstAbort.abort()
    firstReader.releaseLock()

    const cancelled = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/memory/jobs/${pendingJob.id}`,
      headers: { 'risu-auth': assertion },
    })
    expect(cancelled.statusCode).toBe(200)

    const reconnectAbort = new AbortController()
    const reconnect = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { 'risu-auth': assertion },
      signal: reconnectAbort.signal,
    })
    const reconnectReader = reconnect.body!.getReader()
    try {
      const reconnectText = await readUntil(reconnectReader, (chunk) => chunk.includes('event: memory_snapshot\n'))
      const reconnectSnapshots = parseSseJsonEvents(reconnectText, 'memory_snapshot') as Array<{
        streamId: string
        version: number
        jobs: unknown[]
        bardWikiJobs: unknown[]
      }>
      expect(reconnectSnapshots).toHaveLength(1)
      expect(reconnectSnapshots[0].streamId).toBe(firstSnapshots[0].streamId)
      expect(reconnectSnapshots[0].version).toBeGreaterThan(firstSnapshots[0].version)
      expect(reconnectSnapshots[0].jobs).toEqual([])
      expect(reconnectSnapshots[0].bardWikiJobs).toHaveLength(2)
    } finally {
      reconnectAbort.abort()
      reconnectReader.releaseLock()
    }
  })

  it('delivers memory progress events from memory job mutations', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const baseUrl = await listen(harness.app)
    const abort = new AbortController()

    const res = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { 'risu-auth': assertion },
      signal: abort.signal,
    })
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    await readUntil(reader!, (chunk) => chunk.includes(': connected\n\n'))

    const memoryJob = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/memory/jobs',
      headers: { 'risu-auth': assertion },
      payload: {
        chatId: 'chat-1',
        kind: 'summarize',
        payload: { chunkId: 'chunk-1', model: 'model-a' },
      },
    })
    expect(memoryJob.statusCode).toBe(201)
    const jobId = memoryJob.json().job.id as string

    try {
      const text = await readUntil(reader!, (chunk) => chunk.includes('event: memory\n'))
      expect(text).toContain('event: memory\n')
      const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
      expect(dataLine).toBeDefined()
      expect(JSON.parse(dataLine!.slice('data: '.length))).toMatchObject({
        type: 'memory.job',
        streamId: expect.any(String),
        version: expect.any(Number),
        chatId: 'chat-1',
        job: {
          id: jobId,
          instanceId: expect.any(String),
          kind: 'summarize',
          status: 'pending',
          attemptCount: 0,
          maxAttempts: 3,
          updatedAt: expect.any(String),
        },
      })
    } finally {
      abort.abort()
      reader?.releaseLock()
    }
  })

  it('continues memory SSE fanout when an external memory sink throws', async () => {
    await stopHarness(harness)
    harness = await startHarness({
      memoryEvents: () => {
        throw new Error('external memory sink exploded')
      },
    })

    const { assertion } = await setupAuthedClient(harness.app)
    const baseUrl = await listen(harness.app)
    const abort = new AbortController()

    const res = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { 'risu-auth': assertion },
      signal: abort.signal,
    })
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    await readUntil(reader!, (chunk) => chunk.includes(': connected\n\n'))

    const memoryJob = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/memory/jobs',
      headers: { 'risu-auth': assertion },
      payload: {
        chatId: 'chat-1',
        kind: 'summarize',
        payload: { chunkId: 'chunk-1', model: 'model-a' },
      },
    })
    expect(memoryJob.statusCode).toBe(201)
    const jobId = memoryJob.json().job.id as string

    try {
      const text = await readUntil(reader!, (chunk) => chunk.includes('event: memory\n'))
      expect(text).toContain('event: memory\n')
      const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
      expect(dataLine).toBeDefined()
      expect(JSON.parse(dataLine!.slice('data: '.length))).toMatchObject({
        type: 'memory.job',
        chatId: 'chat-1',
        job: {
          id: jobId,
          status: 'pending',
        },
      })
    } finally {
      abort.abort()
      reader?.releaseLock()
    }
  })

  it('cleans subscriptions after a snapshot read fails and permits a fresh stream', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    // Induce a real SQLite snapshot failure only in this disposable fixture.
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    db.exec('ALTER TABLE memory_jobs RENAME TO held_memory_jobs')
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await harness.app.inject({
          method: 'GET',
          url: '/api/v1/events',
          headers: { 'risu-auth': assertion },
        })
        expect(response.statusCode).toBe(500)
        expect(harness.commandEvents.activeListeners).toBe(0)
      }
    } finally {
      db.exec('ALTER TABLE held_memory_jobs RENAME TO memory_jobs')
      db.close()
    }
    const baseUrl = await listen(harness.app)
    const abort = new AbortController()
    try {
      const response = await fetch(`${baseUrl}/api/v1/events`, {
        headers: { 'risu-auth': assertion },
        signal: abort.signal,
      })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      await readUntil(reader, (chunk) => chunk.includes('event: memory_snapshot\n'))
      expect(harness.commandEvents.activeListeners).toBe(1)
      abort.abort()
      reader.releaseLock()
      await waitFor(() => harness.commandEvents.activeListeners === 0)
    } finally {
      abort.abort()
    }
  })

  it('unsubscribes listeners when the stream closes', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    process.env.RISU_PROTOCOL_METRICS = '1'
    capturedMetrics.length = 0
    const baseUrl = await listen(harness.app)
    const abort = new AbortController()

    const res = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { 'risu-auth': assertion },
      signal: abort.signal,
    })
    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    await readUntil(reader!, (chunk) => chunk.includes(': connected\n\n'))
    expect(harness.commandEvents.activeListeners).toBe(1)

    abort.abort()
    await waitFor(() => harness.commandEvents.activeListeners === 0)
    await waitFor(() => capturedMetrics.some((metric) => metric.metric === 'event_stream_connection'))
    expect(capturedMetrics.find((metric) => metric.metric === 'event_stream_connection')).toMatchObject({
      frameCount: 3,
      frameCounts: { writer: 1, connected: 1, memory_snapshot: 1 },
      closeReason: 'client_abort',
      writeOverflow: false,
    })
    reader?.releaseLock()
  })

  it('never arms the heartbeat or memory subscription after a mid-handler teardown', async () => {
    // A slow-consumer overflow during the replay flush runs `cleanup` before
    // the live-delivery legs are armed; the `cleanedUp` latch then keeps
    // cleanup from ever running again, so arming anyway would leak both
    // forever. The guard must skip arming entirely.
    const { armSseLiveDelivery } = await import('../src/routes/events.js')

    let heartbeatStarted = 0
    let memorySubscribed = 0
    const tornDown = armSseLiveDelivery({
      tornDown: () => true,
      startHeartbeat: () => {
        heartbeatStarted += 1
        return setInterval(() => {}, 1_000)
      },
      subscribeMemory: () => {
        memorySubscribed += 1
        return () => {}
      },
    })
    expect(tornDown).toEqual({ heartbeat: null, unsubscribeMemory: null })
    expect(heartbeatStarted).toBe(0)
    expect(memorySubscribed).toBe(0)

    // The live path still arms both.
    const armed = armSseLiveDelivery({
      tornDown: () => false,
      startHeartbeat: () => setInterval(() => {}, 1_000),
      subscribeMemory: () => {
        memorySubscribed += 1
        return () => {}
      },
    })
    expect(armed.heartbeat).not.toBeNull()
    expect(memorySubscribed).toBe(1)
    if (armed.heartbeat) clearInterval(armed.heartbeat)
    armed.unsubscribeMemory?.()
  })
})
