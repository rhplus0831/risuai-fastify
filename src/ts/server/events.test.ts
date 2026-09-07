import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../platform', () => ({ isFastifyServer: true }))
const authApi = vi.hoisted(() => ({ get: vi.fn(async () => 'events-auth-token') }))

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: authApi.get,
}))

import { subscribeServerCommandEvents } from './events'
import { ACTIVE_WRITER_SESSION_HEADER } from './activeWriterSession'
import * as activeWriterSession from './activeWriterSession'
import {
  beginClientSession,
  demoteClientSession,
  requireClientAuthentication,
  resetClientSessionForTests,
  settleClientReader,
} from '../clientSession'
import { enterClientWriter } from '../__tests__/clientSession'
import type { CommandEvent } from './commands'
import type { ServerMemoryEvent, ServerMemoryJobSnapshot, ServerWriterEvent } from './events'
import type { ServerBardWikiJobEvent } from './bardWikiJobEvents'

interface CapturedFetch {
  url: string
  method: string
  authHeader: string | null
  writerSessionHeader: string | null
  lastEventIdHeader: string | null
  signal: AbortSignal | null
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(text))
      controller.close()
    },
  })
}

function stubEventsFetch(body: string | null, status = 200): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      calls.push({
        url: String(input),
        method: init.method ?? 'GET',
        authHeader: headers?.['risu-auth'] ?? null,
        writerSessionHeader: headers?.[ACTIVE_WRITER_SESSION_HEADER] ?? null,
        lastEventIdHeader: headers?.['Last-Event-ID'] ?? null,
        signal: init.signal ?? null,
      })
      return new Response(body === null ? null : streamOf(body), { status })
    }) as unknown as typeof fetch,
  )
  return calls
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for condition')
}

afterEach(() => {
  resetClientSessionForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  authApi.get.mockReset().mockResolvedValue('events-auth-token')
})

describe('server command event subscription helper', () => {
  it('cannot open a writer stream after losing its session during authentication', async () => {
    enterClientWriter()
    let release!: (value: string) => void
    authApi.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const calls = stubEventsFetch(': connected\n\n')
    const subscription = subscribeServerCommandEvents({ onCommandEvent: vi.fn() })
    demoteClientSession()
    release('late-auth-token')
    await expect(subscription).resolves.toEqual({ status: 'unavailable' })
    expect(calls).toHaveLength(0)
  })

  it('reports authentication loss directly for a managed writer stream', async () => {
    enterClientWriter()
    stubEventsFetch('{"error":"missing_auth"}', 401)
    await expect(subscribeServerCommandEvents({ onCommandEvent: vi.fn() })).resolves.toEqual({
      status: 'error',
      error: 'HTTP 401',
      httpStatus: 401,
    })
  })
  it('keeps reader transport available after writer loss and omits the writer registration header', async () => {
    vi.spyOn(activeWriterSession, 'isWriterAccessLost').mockReturnValue(true)
    const operation = beginClientSession('reader-a')
    settleClientReader(operation, { databaseLineage: 'database-a', writer: { sessionId: 'writer-a', epoch: 1 } })
    const calls = stubEventsFetch(
      'event: writer\ndata: {"sessionId":"writer-a","epoch":1}\n\nevent: command\ndata: {"type":"settings.updated","resource":"settings","revision":8}\n\n',
    )
    const onWriterEvent = vi.fn(),
      onCommandEvent = vi.fn()
    const subscription = await subscribeServerCommandEvents({
      mode: 'reader',
      sinceRevision: 7,
      onWriterEvent,
      onCommandEvent,
    })
    expect(subscription.status).toBe('ok')
    await waitFor(() => onCommandEvent.mock.calls.length === 1)
    expect(calls[0]).toMatchObject({
      writerSessionHeader: null,
      authHeader: 'events-auth-token',
      lastEventIdHeader: '7',
    })
    expect(onWriterEvent).toHaveBeenCalledWith({ sessionId: 'writer-a', epoch: 1 })
    expect(await subscribeServerCommandEvents({ onCommandEvent: vi.fn() })).toEqual({ status: 'unavailable' })
  })

  it('does not start a reader stream without authenticated read access', async () => {
    beginClientSession('reader-a')
    requireClientAuthentication()
    const calls = stubEventsFetch(': connected\n\n')
    expect(await subscribeServerCommandEvents({ mode: 'reader', onCommandEvent: vi.fn() })).toEqual({
      status: 'unavailable',
    })
    expect(calls).toHaveLength(0)
  })

  it('reports reader auth status distinctly for coordinator teardown', async () => {
    stubEventsFetch('{"error":"missing_auth"}', 401)
    expect(await subscribeServerCommandEvents({ mode: 'reader', onCommandEvent: vi.fn() })).toEqual({
      status: 'error',
      error: 'HTTP 401',
      httpStatus: 401,
    })
  })

  it('fetches the event stream with auth and emits command, memory, and writer events', async () => {
    const commandEvent: CommandEvent = {
      type: 'generation.persisted',
      revision: 3,
      resource: 'generation',
      id: 'message-a',
      parentId: 'chat-a',
      databaseLineage: 'database-a',
      operationId: 'operation-a',
      sourceMessageId: 'message-user-a',
      jobId: 'job-a',
      origin: { writerSessionId: 'writer-a' },
    }
    const memoryEvent: ServerMemoryEvent = {
      type: 'memory.job',
      streamId: 'memory-stream-1',
      version: 2,
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
    const memorySnapshot: ServerMemoryJobSnapshot = {
      type: 'memory.snapshot',
      streamId: 'memory-stream-1',
      version: 1,
      jobs: [
        {
          id: 'snapshot-job',
          instanceId: 'snapshot-instance',
          chatId: 'chat-2',
          kind: 'embed',
          status: 'running',
          attemptCount: 1,
          maxAttempts: 3,
          updatedAt: '2026-08-11T00:00:00.000Z',
        },
      ],
      bardWikiJobs: [
        {
          id: 'bard-job-1',
          instanceId: 'bard-instance-1',
          chatId: 'chat-1',
          receiptId: 'receipt-1',
          kind: 'apply_turn',
          status: 'running',
          errorCode: null,
          errorSummary: null,
          attemptCount: 1,
          maxAttempts: 3,
          progressCurrent: null,
          progressTotal: null,
          nextRunAt: '2026-08-11T00:00:00.000Z',
          createdAt: '2026-08-11T00:00:00.000Z',
          updatedAt: '2026-08-11T00:00:00.000Z',
        },
      ],
    }
    const bardWikiEvent: ServerBardWikiJobEvent = {
      type: 'bardwiki.job',
      streamId: 'memory-stream-1',
      version: 3,
      chatId: 'chat-1',
      job: {
        id: 'bard-job-1',
        instanceId: 'bard-instance-1',
        receiptId: 'receipt-1',
        kind: 'apply_turn',
        status: 'failed',
        errorCode: 'provider_error',
        errorSummary: 'Provider failed',
        attemptCount: 3,
        maxAttempts: 3,
        progressCurrent: null,
        progressTotal: null,
        updatedAt: '2026-08-11T00:01:00.000Z',
      },
    }
    const writerEvent: ServerWriterEvent = { sessionId: 'writer-b', epoch: 2 }
    const calls = stubEventsFetch(
      [
        ': connected',
        '',
        'event: writer',
        `data: ${JSON.stringify(writerEvent)}`,
        '',
        'event: command',
        `data: ${JSON.stringify(commandEvent)}`,
        '',
        'event: message',
        'data: ignored',
        '',
        'event: memory_snapshot',
        `data: ${JSON.stringify(memorySnapshot)}`,
        '',
        'event: memory',
        `data: ${JSON.stringify(memoryEvent)}`,
        '',
        'event: memory',
        `data: ${JSON.stringify(bardWikiEvent)}`,
        '',
        'event: memory',
        'data: {"type":"memory.job","chatId":"chat-1"}',
        '',
      ].join('\n'),
    )
    const seen: CommandEvent[] = []
    const memorySeen: ServerMemoryEvent[] = []
    const memorySnapshots: ServerMemoryJobSnapshot[] = []
    const bardWikiSeen: ServerBardWikiJobEvent[] = []
    const writerSeen: ServerWriterEvent[] = []

    const subscription = await subscribeServerCommandEvents({
      onCommandEvent: (event) => seen.push(event),
      onMemoryEvent: (event) => memorySeen.push(event),
      onBardWikiEvent: (event) => bardWikiSeen.push(event),
      onMemorySnapshot: (snapshot) => memorySnapshots.push(snapshot),
      onWriterEvent: (event) => writerSeen.push(event),
    })

    expect(subscription.status).toBe('ok')
    await waitFor(() => seen.length === 1)
    await waitFor(() => memorySeen.length === 1)
    await waitFor(() => memorySnapshots.length === 1)
    await waitFor(() => bardWikiSeen.length === 1)
    await waitFor(() => writerSeen.length === 1)
    expect(seen).toEqual([commandEvent])
    expect(memorySeen).toEqual([memoryEvent])
    expect(memorySnapshots).toEqual([memorySnapshot])
    expect(bardWikiSeen).toEqual([bardWikiEvent])
    expect(writerSeen).toEqual([writerEvent])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: '/api/v1/events',
      method: 'GET',
      authHeader: 'events-auth-token',
      writerSessionHeader: expect.any(String),
    })
  })

  it('ignores malformed writer frames', async () => {
    stubEventsFetch(
      [
        'event: writer',
        'data: {"sessionId":"writer-a"}',
        '',
        'event: writer',
        'data: {"sessionId":12,"epoch":1}',
        '',
        'event: writer',
        'data: {"sessionId":"","epoch":1}',
        '',
        'event: writer',
        'data: {"sessionId":null,"epoch":-1}',
        '',
        'event: writer',
        'data: not-json',
        '',
      ].join('\n'),
    )
    const onWriterEvent = vi.fn()

    const subscription = await subscribeServerCommandEvents({
      onCommandEvent: vi.fn(),
      onWriterEvent,
    })

    expect(subscription.status).toBe('ok')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onWriterEvent).not.toHaveBeenCalled()
  })

  it('reports malformed command events instead of dropping them', async () => {
    stubEventsFetch('event: command\ndata: {"type":"broken"}\n\n')
    const onError = vi.fn()

    const subscription = await subscribeServerCommandEvents({
      onCommandEvent: vi.fn(),
      onError,
    })

    expect(subscription.status).toBe('ok')
    await waitFor(() => onError.mock.calls.length === 1)
    expect(onError.mock.calls[0][0]).toContain('Malformed command event frame')
  })

  it('rejects command frames with malformed recovery lineage metadata', async () => {
    stubEventsFetch(
      'event: command\ndata: {"type":"generation.persisted","revision":3,"resource":"generation","operationId":7}\n\n',
    )
    const onCommandEvent = vi.fn()
    const onError = vi.fn()

    const subscription = await subscribeServerCommandEvents({ onCommandEvent, onError })

    expect(subscription.status).toBe('ok')
    await waitFor(() => onError.mock.calls.length === 1)
    expect(onCommandEvent).not.toHaveBeenCalled()
    expect(onError.mock.calls[0][0]).toContain('Malformed command event frame')
  })

  it('returns an error for event stream HTTP failures', async () => {
    stubEventsFetch('{"error":"missing_auth"}', 401)

    await expect(subscribeServerCommandEvents({ onCommandEvent: vi.fn() })).resolves.toEqual({
      status: 'error',
      error: 'HTTP 401',
    })
  })

  it('requests command-event replay with the cached revision cursor', async () => {
    const calls = stubEventsFetch(': connected\n\n')

    const subscription = await subscribeServerCommandEvents({
      sinceRevision: 7,
      onCommandEvent: vi.fn(),
    })

    expect(subscription.status).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: '/api/v1/events?sinceRevision=7',
      method: 'GET',
      authHeader: 'events-auth-token',
      lastEventIdHeader: '7',
    })
  })

  it('reports heartbeat comment frames for stream liveness tracking', async () => {
    stubEventsFetch(': connected\n\n: heartbeat\n\n')
    const onFrame = vi.fn()

    const subscription = await subscribeServerCommandEvents({
      onCommandEvent: vi.fn(),
      onFrame,
    })

    expect(subscription.status).toBe('ok')
    await waitFor(() => onFrame.mock.calls.length === 2)
  })

  it('returns replay-unavailable for exhausted server history', async () => {
    stubEventsFetch(
      JSON.stringify({
        error: 'event_replay_unavailable',
        requestedRevision: 3,
        currentRevision: 12,
        oldestRevision: 8,
        latestRevision: 12,
      }),
      409,
    )

    await expect(subscribeServerCommandEvents({ sinceRevision: 3, onCommandEvent: vi.fn() })).resolves.toEqual({
      status: 'replay-unavailable',
      error: 'event_replay_unavailable',
      currentRevision: 12,
      oldestRevision: 8,
      latestRevision: 12,
    })
  })

  it('notifies callers when the event stream closes cleanly', async () => {
    stubEventsFetch(': connected\n\n')
    const onClose = vi.fn()

    const subscription = await subscribeServerCommandEvents({
      onCommandEvent: vi.fn(),
      onClose,
    })

    expect(subscription.status).toBe('ok')
    await waitFor(() => onClose.mock.calls.length === 1)
  })

  it('aborts the stream when unsubscribed', async () => {
    const calls = stubEventsFetch(': connected\n\n')
    const subscription = await subscribeServerCommandEvents({
      onCommandEvent: vi.fn(),
    })

    expect(subscription.status).toBe('ok')
    if (subscription.status !== 'ok') return

    expect(calls[0].signal?.aborted).toBe(false)
    subscription.unsubscribe()
    expect(calls[0].signal?.aborted).toBe(true)
  })
})
