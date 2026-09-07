import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptChatEvent } from '@risuai/protocol/generation-sse'

const auth = vi.hoisted(() => vi.fn())
vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: auth }))

import {
  observeReaderGenerationStream,
  READER_GENERATION_IDLE_TIMEOUT_MS,
  READER_GENERATION_REQUEST_TIMEOUT_MS,
} from './readerGenerationStream'
import type { ReaderGenerationIdentity } from './readerGenerationTypes'

const identity: ReaderGenerationIdentity = {
  databaseLineage: 'database-a',
  characterId: 'character-a',
  chatId: 'chat-a',
  operationId: 'operation-a',
  attemptNo: 2,
  jobId: 'job-a',
  projectionEpoch: 12,
}
const envelope = {
  databaseLineage: identity.databaseLineage,
  operationId: identity.operationId,
  attemptNo: identity.attemptNo,
  jobId: identity.jobId,
  writerSessionId: 'writer-a',
  writerEpoch: 1,
  operationStateVersion: 3,
  projectionEpoch: identity.projectionEpoch,
}
const snapshotHref = '/api/v1/generate/chat/job-a/terminal-snapshot'
const terminalSnapshot = { version: 1, href: snapshotHref, bytes: 200 }
const encoder = new TextEncoder()
const fetchMock = vi.fn<typeof fetch>()

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function viewer() {
  const controller = new AbortController()
  const onEvent = vi.fn<(event: PromptChatEvent) => void>()
  let current = true
  return {
    controller,
    onEvent,
    retire: () => {
      current = false
    },
    start: () =>
      observeReaderGenerationStream({ identity, signal: controller.signal, isCurrent: () => current, onEvent }),
  }
}

function stream() {
  let source!: ReadableStreamDefaultController<Uint8Array>
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller
    },
    cancel,
  })
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    cancel,
    raw: (text: string) => source.enqueue(encoder.encode(text)),
    send: (type: string, data: Record<string, unknown>, durable = true) => {
      source.enqueue(
        encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ ...(durable ? envelope : {}), ...data })}\n\n`),
      )
    },
    close: () => source.close(),
    fail: (error: unknown) => source.error(error),
  }
}

async function tick() {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  auth.mockReset().mockResolvedValue('reader-auth')
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0)
  // Every request in these actual adapter lifecycle tests is an authenticated
  // read. A submit/cancel/retry/effect request or writer header fails the suite.
  for (const [url, options] of fetchMock.mock.calls) {
    expect(options?.method).toBe('GET')
    expect(new Headers(options?.headers).get('risu-auth')).toBe('reader-auth')
    expect([...new Headers(options?.headers).keys()].sort()).toEqual(['accept', 'risu-auth'])
    expect(options?.body).toBeUndefined()
    expect(options?.redirect).toBe('error')
    expect(String(url)).toMatch(
      /^\/api\/v1\/(generation-operations\/[^/]+\/stream\?|generate\/chat\/[^/]+\/terminal-snapshot$)/,
    )
  }
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('reader generation stream', () => {
  it('opens the exact self-derived descriptor and preserves protected replay and the newer terminal epoch', async () => {
    const source = stream()
    fetchMock.mockResolvedValue(source.response)
    source.send('job_accepted', {})
    source.send('info', { generationId: 'generation-a', projectionEpoch: 8, operationStateVersion: 1 })
    source.send('token', { content: 'partial', projectionEpoch: 8 })
    source.send('done', { result: 'complete', outcome: 'completed', projectionEpoch: 14, operationStateVersion: 5 })
    const observation = viewer()
    const result = await observation.start()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/v1/generation-operations/operation-a/stream?attemptNo=2&jobId=job-a&projectionEpoch=12',
    )
    expect(observation.onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'job_accepted',
      'info',
      'token',
      'done',
    ])
    expect(result).toEqual({
      status: 'terminal',
      event: {
        ...envelope,
        type: 'done',
        result: 'complete',
        outcome: 'completed',
        projectionEpoch: 14,
        operationStateVersion: 5,
      },
    })
    expect(source.cancel).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('does not require the acceptance frame when a durable token proves the same attempt', async () => {
    const source = stream()
    fetchMock.mockResolvedValue(source.response)
    source.send('token', { content: 'already running' })
    source.send('done', { outcome: 'cancelled', result: 'partial' })
    const observation = viewer()
    expect(await observation.start()).toMatchObject({
      status: 'terminal',
      event: { outcome: 'cancelled', result: 'partial' },
    })
    expect(observation.onEvent.mock.calls.map(([event]) => event.type)).toEqual(['token', 'done'])
  })

  it.each([
    ['databaseLineage', 'old-database'],
    ['operationId', 'old-operation'],
    ['attemptNo', 1],
    ['jobId', 'old-job'],
    ['characterId', 'other-character'],
    ['chatId', 'other-chat'],
  ])('ignores %s mismatches on both content and terminal frames', async (key, value) => {
    const source = stream()
    fetchMock.mockResolvedValue(source.response)
    source.send('token', { content: 'stale', [key]: value })
    source.send('done', { result: 'stale final', [key]: value })
    source.close()
    const observation = viewer()
    expect(await observation.start()).toMatchObject({ status: 'ended' })
    expect(observation.onEvent).not.toHaveBeenCalled()
  })

  it('rejects missing lineage, inconsistent nested identities, malformed JSON and unknown events', async () => {
    const source = stream()
    fetchMock.mockResolvedValue(source.response)
    source.send('token', { content: 'no lineage', jobId: identity.jobId }, false)
    source.send('info', { generationInfo: { operationId: 'other-operation' } })
    source.send('error', {
      error: 'wrong chat',
      generationProjection: { characterId: 'character-a', chatId: 'wrong', generationId: 'generation-a', mode: 'send' },
    })
    source.send('token', { content: 42 })
    source.send('unknown', { content: 'unknown' })
    source.raw('event: done\ndata: {\n\n')
    source.raw(': heartbeat\n\n')
    source.close()
    const observation = viewer()
    expect(await observation.start()).toMatchObject({ status: 'ended' })
    expect(observation.onEvent).not.toHaveBeenCalled()
  })

  it('returns the exact verified durable error without interpreting it as a transport failure', async () => {
    const source = stream()
    fetchMock.mockResolvedValue(source.response)
    const error = { error: 'persistence_failed', persistenceDisposition: 'queued', result: 'retained' }
    source.send('error', error)
    const observation = viewer()
    const result = await observation.start()
    expect(result).toEqual({ status: 'terminal', event: { ...envelope, ...error, type: 'error' } })
    expect(observation.onEvent).toHaveBeenCalledTimes(1)
  })

  it('delivers effect and patch data without making writer or effect requests', async () => {
    const source = stream()
    fetchMock.mockResolvedValueOnce(source.response)
    source.send('side_effect', { kind: 'tts', payload: { text: 'read only' } })
    source.send('message_patch', {
      patch: {
        characterId: identity.characterId,
        chatId: identity.chatId,
        selectedCharID: 0,
        chatPage: 0,
        varChanged: false,
        messageMutations: [],
        chatVarMutations: [],
        additionalSystemPrompt: [],
      },
    })
    source.send('done', { result: 'complete', postGeneration: { resendChat: true } })
    const observation = viewer()
    expect(await observation.start()).toMatchObject({ status: 'terminal' })
    expect(observation.onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'side_effect',
      'message_patch',
      'done',
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('captures an immutable descriptor before auth resolves', async () => {
    const pendingAuth = deferred<string>()
    auth.mockReturnValueOnce(pendingAuth.promise)
    const source = stream()
    fetchMock.mockResolvedValueOnce(source.response)
    source.send('done', { result: 'complete' })
    const mutableIdentity = { ...identity }
    const result = observeReaderGenerationStream({
      identity: mutableIdentity,
      signal: new AbortController().signal,
      isCurrent: () => true,
      onEvent: vi.fn(),
    })
    mutableIdentity.operationId = 'superseded'
    mutableIdentity.attemptNo = 3
    pendingAuth.resolve('reader-auth')
    expect(await result).toMatchObject({
      status: 'terminal',
      event: { operationId: identity.operationId, attemptNo: 2 },
    })
    expect(fetchMock.mock.calls[0][0]).toContain('/operation-a/stream?attemptNo=2&')
  })

  it('classifies fetch rejection as unavailable and callback failure as ended, cleaning up each viewer', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network offline'))
    const observation = viewer()
    expect(await observation.start()).toEqual({ status: 'unavailable', error: 'network offline' })
    const source = stream()
    fetchMock.mockResolvedValueOnce(source.response)
    source.send('done', { result: 'complete' })
    observation.onEvent.mockImplementation(() => {
      throw new Error('callback failed')
    })
    expect(await observation.start()).toEqual({ status: 'ended', error: 'callback failed' })
    expect(source.cancel).toHaveBeenCalledTimes(1)
  })

  it.each(['EOF', 'read failure'])(
    'classifies %s as observation failure and never reopens on its own',
    async (failure) => {
      const source = stream()
      fetchMock.mockResolvedValue(source.response)
      source.send('token', { content: 'partial' })
      const observation = viewer()
      const result = observation.start()
      await tick()
      if (failure === 'EOF') source.close()
      else source.fail(new Error('connection lost'))
      expect(await result).toMatchObject({ status: 'ended' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(observation.onEvent.mock.calls.map(([event]) => event.type)).toEqual(['token'])
    },
  )

  it.each([401, 404, 409, 503])('returns unavailable HTTP %s without consuming control authority', async (status) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'not available' }), { status }))
    const observation = viewer()
    expect(await observation.start()).toMatchObject({ status: 'unavailable', httpStatus: status })
    expect(observation.onEvent).not.toHaveBeenCalled()
  })

  it('rejects a non-streaming response and auth rejection without a terminal callback', async () => {
    fetchMock.mockResolvedValue(Response.json({ done: true }))
    const observation = viewer()
    expect(await observation.start()).toMatchObject({ status: 'unavailable' })
    auth.mockRejectedValueOnce(new Error('auth unavailable'))
    expect(await observation.start()).toEqual({ status: 'unavailable', error: 'auth unavailable' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(observation.onEvent).not.toHaveBeenCalled()
  })

  it('aborts before authentication if the viewer was already detached', async () => {
    const observation = viewer()
    observation.controller.abort()
    expect(await observation.start()).toEqual({ status: 'aborted' })
    expect(auth).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts pending auth immediately and ignores its late resolution', async () => {
    const pendingAuth = deferred<string>()
    auth.mockReturnValueOnce(pendingAuth.promise)
    const observation = viewer()
    const result = observation.start()
    observation.controller.abort()
    expect(await result).toEqual({ status: 'aborted' })
    pendingAuth.resolve('reader-auth')
    await tick()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['auth', 'open', 'read', 'snapshot open', 'snapshot body'])(
    'fences currentness after awaited %s',
    async (boundary) => {
      const observation = viewer()
      const source = stream()
      const pendingAuth = deferred<string>()
      const pendingResponse = deferred<Response>()
      const pendingBody = deferred<unknown>()
      if (boundary === 'auth') auth.mockReturnValueOnce(pendingAuth.promise)
      else if (boundary === 'open') fetchMock.mockReturnValueOnce(pendingResponse.promise)
      else {
        fetchMock.mockResolvedValueOnce(source.response)
        if (boundary.startsWith('snapshot')) {
          source.send('job_accepted', {})
          source.send('done', { jobId: identity.jobId, terminalSnapshot }, false)
          if (boundary === 'snapshot open') fetchMock.mockReturnValueOnce(pendingResponse.promise)
          else {
            const response = Response.json({})
            vi.spyOn(response, 'json').mockReturnValue(pendingBody.promise)
            fetchMock.mockResolvedValueOnce(response)
          }
        }
      }
      const result = observation.start()
      await tick()
      observation.retire()
      if (boundary === 'auth') pendingAuth.resolve('reader-auth')
      else if (boundary === 'open' || boundary === 'snapshot open') pendingResponse.resolve(source.response)
      else if (boundary === 'read') source.send('done', { result: 'late' })
      else pendingBody.resolve({ result: 'late' })
      expect(await result).toEqual({ status: 'aborted' })
      expect(observation.onEvent.mock.calls.every(([event]) => event.type === 'job_accepted')).toBe(true)
      if (boundary === 'auth') expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it.each(['open', 'read', 'snapshot open', 'snapshot body'])(
    'aborts a pending %s without waiting for network cooperation',
    async (boundary) => {
      const observation = viewer()
      const source = stream()
      const pendingResponse = deferred<Response>()
      const pendingBody = deferred<unknown>()
      if (boundary === 'open') fetchMock.mockReturnValueOnce(pendingResponse.promise)
      else {
        fetchMock.mockResolvedValueOnce(source.response)
        if (boundary.startsWith('snapshot')) {
          source.send('job_accepted', {})
          source.send('done', { terminalSnapshot })
          if (boundary === 'snapshot open') fetchMock.mockReturnValueOnce(pendingResponse.promise)
          else {
            const response = Response.json({})
            vi.spyOn(response, 'json').mockReturnValue(pendingBody.promise)
            fetchMock.mockResolvedValueOnce(response)
          }
        }
      }
      const result = observation.start()
      await tick()
      observation.controller.abort()
      expect(await result).toEqual({ status: 'aborted' })
      const lateSource = stream()
      pendingResponse.resolve(lateSource.response)
      pendingBody.resolve({ result: 'late final' })
      await tick()
      expect(observation.onEvent.mock.calls.every(([event]) => event.type === 'job_accepted')).toBe(true)
      expect(fetchMock.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true)
      if (boundary === 'open' || boundary === 'snapshot open') expect(lateSource.cancel).toHaveBeenCalledTimes(1)
    },
  )

  it('fences immediately after callbacks before delivering buffered frames or reporting terminal success', async () => {
    for (const type of ['token', 'done'] as const) {
      const source = stream()
      fetchMock.mockResolvedValueOnce(source.response)
      source.send(type, type === 'token' ? { content: 'first' } : { result: 'complete' })
      source.send('done', { result: 'late final' })
      const observation = viewer()
      observation.onEvent.mockImplementation(() => observation.retire())
      expect(await observation.start()).toEqual({ status: 'aborted' })
      expect(observation.onEvent).toHaveBeenCalledTimes(1)
      expect(source.cancel).toHaveBeenCalledTimes(1)
    }
  })

  it.each(['auth', 'open'])('bounds stalled %s', async (boundary) => {
    if (boundary === 'auth') auth.mockReturnValueOnce(new Promise(() => {}))
    else fetchMock.mockReturnValueOnce(new Promise(() => {}))
    const result = viewer().start()
    await vi.advanceTimersByTimeAsync(READER_GENERATION_REQUEST_TIMEOUT_MS)
    expect(await result).toMatchObject({ status: 'unavailable', error: expect.stringContaining('timed out') })
  })

  it('extends the read watchdog on heartbeat comments, then bounds a silent connection', async () => {
    const source = stream()
    fetchMock.mockResolvedValueOnce(source.response)
    const observation = viewer()
    const result = observation.start()
    let settled = false
    void result.then(() => {
      settled = true
    })
    await tick()
    await vi.advanceTimersByTimeAsync(READER_GENERATION_IDLE_TIMEOUT_MS - 1)
    source.raw(': heartbeat\r\n\r\n')
    await tick()
    await vi.advanceTimersByTimeAsync(READER_GENERATION_IDLE_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({ status: 'ended', error: expect.stringContaining('stopped responding') })
    expect(source.cancel).toHaveBeenCalledTimes(1)
    expect(observation.onEvent).not.toHaveBeenCalled()
  })

  it('does not block terminal cleanup on a stalled reader cancellation callback', async () => {
    const source = stream()
    source.cancel.mockImplementation(() => new Promise(() => {}))
    fetchMock.mockResolvedValueOnce(source.response)
    source.send('done', { result: 'complete' })
    expect(await viewer().start()).toMatchObject({ status: 'terminal' })
    expect(source.cancel).toHaveBeenCalledTimes(1)
  })

  it('allows verified job-only replay wrappers and merges a newer terminal snapshot with exact immutable identity', async () => {
    const source = stream()
    fetchMock.mockResolvedValueOnce(source.response).mockResolvedValueOnce(
      Response.json({
        result: 'canonical complete result',
        generationId: 'generation-a',
        outcome: 'completed',
        projectionEpoch: 15,
        operationStateVersion: 6,
        operationState: 'completed',
        postGeneration: { messageId: 'message-a', finalText: 'persisted text' },
      }),
    )
    source.send('job_accepted', {})
    source.send(
      'replay_gap',
      { jobId: identity.jobId, reason: 'replay_budget_exceeded', evictedEvents: 100, evictedBytes: 2000 },
      false,
    )
    source.send('token', { content: 'suffix', projectionEpoch: 8 })
    source.send('done', { jobId: identity.jobId, terminalSnapshot }, false)
    const observation = viewer()
    const result = await observation.start()
    expect(result).toMatchObject({
      status: 'terminal',
      event: {
        type: 'done',
        databaseLineage: identity.databaseLineage,
        operationId: identity.operationId,
        attemptNo: identity.attemptNo,
        jobId: identity.jobId,
        result: 'canonical complete result',
        projectionEpoch: 15,
        postGeneration: { messageId: 'message-a' },
      },
    })
    expect(observation.onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'job_accepted',
      'replay_gap',
      'token',
      'done',
    ])
    expect(observation.onEvent.mock.calls[1][0]).toMatchObject({
      databaseLineage: identity.databaseLineage,
      attemptNo: 2,
    })
    expect(fetchMock.mock.calls[1][0]).toBe(snapshotHref)
  })

  it('does not let job-only wrappers establish stream authority or fetch a snapshot', async () => {
    const source = stream()
    fetchMock.mockResolvedValueOnce(source.response)
    source.send(
      'replay_gap',
      { jobId: identity.jobId, reason: 'replay_budget_exceeded', evictedEvents: 1, evictedBytes: 1 },
      false,
    )
    source.send('done', { jobId: identity.jobId, terminalSnapshot }, false)
    source.close()
    const observation = viewer()
    expect(await observation.start()).toMatchObject({ status: 'ended' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(observation.onEvent).not.toHaveBeenCalled()
  })

  it.each([
    'https://example.test/steal',
    '/api/v1/generate/chat/other-job/terminal-snapshot',
    `${snapshotHref}?redirect=1`,
  ])('rejects snapshot URL %s without making a request', async (href) => {
    const source = stream()
    fetchMock.mockResolvedValueOnce(source.response)
    source.send('done', { terminalSnapshot: { ...terminalSnapshot, href } })
    const observation = viewer()
    expect(await observation.start()).toMatchObject({ status: 'ended', error: expect.stringContaining('reference') })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(observation.onEvent).not.toHaveBeenCalled()
  })

  it.each([
    null,
    [],
    { result: 3 },
    { type: 'error', error: 'not a done snapshot' },
    { result: 'wrong', databaseLineage: 'other-db' },
    { result: 'wrong', operationId: 'other-operation' },
    { result: 'wrong', attemptNo: 1 },
    { result: 'wrong', jobId: 'other-job' },
    { result: 'wrong', generationInfo: { operationId: 'other-operation' } },
    { terminalSnapshot },
  ])('rejects invalid snapshot payload %j', async (payload) => {
    const source = stream()
    fetchMock.mockResolvedValueOnce(source.response).mockResolvedValueOnce(Response.json(payload))
    source.send('done', { terminalSnapshot })
    const observation = viewer()
    expect(await observation.start()).toMatchObject({ status: 'ended', error: expect.stringContaining('payload') })
    expect(observation.onEvent).not.toHaveBeenCalled()
  })

  it.each(['HTTP', 'JSON', 'timeout'])(
    'classifies snapshot %s failure as an ended observation, not a durable terminal',
    async (failure) => {
      const source = stream()
      fetchMock.mockResolvedValueOnce(source.response)
      if (failure === 'HTTP') fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
      else if (failure === 'JSON') fetchMock.mockResolvedValueOnce(new Response('{bad'))
      else fetchMock.mockReturnValueOnce(new Promise(() => {}))
      source.send('done', { terminalSnapshot })
      const observation = viewer()
      const result = observation.start()
      if (failure === 'timeout') await vi.advanceTimersByTimeAsync(READER_GENERATION_REQUEST_TIMEOUT_MS)
      expect(await result).toMatchObject({ status: 'ended' })
      expect(observation.onEvent).not.toHaveBeenCalled()
    },
  )
})
