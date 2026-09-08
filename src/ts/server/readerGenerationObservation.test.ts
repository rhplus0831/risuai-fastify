import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptChatEvent } from '@risuai/protocol/generation-sse'
import type { GenerationOperationProjection, ServerBootstrapRuntime } from './bootstrap'
import type { Message } from '../storage/database.svelte'
import type { ReaderGenerationView } from './readerGenerationTypes'
import type { ReaderGenerationStreamResult } from './readerGenerationStream'

const api = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  stream: vi.fn(),
  hydrate: vi.fn(),
  discard: vi.fn(),
  revision: vi.fn(),
  lifecycle: vi.fn(),
  stopLifecycle: vi.fn(),
  incarnation: 1 as number | null,
  messages: [] as Message[],
  bodyCurrent: true,
}))
vi.mock('./bootstrap', () => ({ fetchServerBootstrapReadOnly: api.bootstrap }))
vi.mock('./readerGenerationStream', () => ({ observeReaderGenerationStream: api.stream }))
vi.mock('./chatMessageHydration.svelte', () => ({
  hydrateReaderChatMessageWindow: api.hydrate,
  hydrateReaderGenerationMessages: api.hydrate,
}))
vi.mock('../observerProjectionLifecycle', () => ({ discardObserverProjectionState: api.discard }))
vi.mock('./commands', () => ({ setCachedServerCommandRevision: api.revision }))
vi.mock('./lifecycleRecovery', () => ({ subscribeBrowserLifecycleRecovery: api.lifecycle }))
vi.mock('./readerTranscriptProjection.svelte', () => ({
  getReaderChatIncarnation: () => api.incarnation,
  getReaderChatMessages: () => ({ messages: api.messages, current: api.bodyCurrent, incarnation: api.incarnation }),
}))

import {
  beginClientPromotion,
  beginClientSession,
  getClientSessionSnapshot,
  requireClientAuthentication,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
  settleClientReader,
} from '../clientSession'
import {
  READER_GENERATION_IDLE_POLL_MS,
  READER_GENERATION_POLL_MS,
  READER_GENERATION_READ_TIMEOUT_MS,
  startReaderGenerationObservation,
  type ReaderGenerationObservation,
} from './readerGenerationObservation'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

type StreamInput = Parameters<typeof import('./readerGenerationStream').observeReaderGenerationStream>[0]
const streams: Array<{ input: StreamInput; finish: (result: ReaderGenerationStreamResult) => void }> = []
const observations: ReaderGenerationObservation[] = []
let runtime: ServerBootstrapRuntime

function operation(overrides: Partial<GenerationOperationProjection> = {}): GenerationOperationProjection {
  return {
    operationId: 'operation-a',
    protocolVersion: 1,
    requestOrigin: 'accepted_send',
    state: 'owned_by_job',
    stateVersion: 2,
    projectionEpoch: 2,
    creatorWriterSessionId: 'writer-a',
    creatorWriterEpoch: 1,
    characterId: 'character-a',
    chatId: 'chat-a',
    mode: 'send',
    acceptedMessageId: 'user-a',
    providerMayHaveRun: true,
    currentAttempt: {
      attemptNo: 1,
      retryRequestId: 'request-a',
      jobId: 'job-a',
      status: 'running',
      serverInstanceId: 'server-a',
      actorWriterSessionId: 'writer-a',
      actorWriterEpoch: 1,
      launchRevision: 1,
    },
    ...overrides,
  }
}

function reader(lineage = 'lineage-a'): void {
  const owner = beginClientSession('reader-a')
  settleClientReader(owner, { databaseLineage: lineage, writer: { sessionId: 'writer-a', epoch: 1 } })
  setClientProjectionReady(true)
  setClientConnectionState('live')
}

function start() {
  const changes: ReaderGenerationView[] = []
  const observation = startReaderGenerationObservation({
    characterId: 'character-a',
    chatId: 'chat-a',
    incarnation: 1,
    loadPages: () => 30,
    onChange: (view) => changes.push(view),
  })
  observations.push(observation)
  return { observation, changes, view: () => changes.at(-1) }
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function emit(index: number, payload: Record<string, unknown> & { type: PromptChatEvent['type'] }) {
  const stream = streams[index]!
  const event = { ...stream.input.identity, ...payload } as PromptChatEvent
  stream.input.onEvent(event)
  return event
}

function partial(index = 0, text = 'Live partial') {
  emit(index, { type: 'info', generationId: streams[index]!.input.identity.jobId })
  emit(index, { type: 'token', content: text })
}

function completed(overrides: Partial<GenerationOperationProjection> = {}) {
  runtime.generationOperationProjectionEpoch = 3
  runtime.generationOperations = [
    operation({
      state: 'completed',
      currentAttempt: undefined,
      projectionEpoch: 3,
      stateVersion: 3,
      resultMessageId: 'result-a',
      ...overrides,
    }),
  ]
}

function canonical(overrides: Partial<Message> = {}): Message {
  return {
    role: 'char',
    data: 'Persisted result',
    chatId: 'result-a',
    generationInfo: { databaseLineage: 'lineage-a', operationId: 'operation-a', attemptNo: 1, generationId: 'job-a' },
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  resetClientSessionForTests()
  api.incarnation = 1
  api.messages = []
  api.bodyCurrent = true
  reader()
  runtime = {
    initialized: true,
    revision: 1,
    databaseLineage: 'lineage-a',
    writer: { sessionId: 'writer-a', epoch: 1 },
    generationOperationProjectionEpoch: 2,
    generationOperations: [operation()],
    activeGenerationJobs: [],
  }
  api.bootstrap.mockReset().mockImplementation(async () => ({ status: 'ok', bootstrap: runtime }))
  api.hydrate.mockReset().mockResolvedValue(true)
  api.discard.mockReset().mockImplementation(async () => requireClientAuthentication())
  api.lifecycle.mockReset().mockReturnValue(api.stopLifecycle)
  api.stream.mockReset().mockImplementation((input: StreamInput) => {
    const pending = deferred<ReaderGenerationStreamResult>()
    streams.push({ input, finish: pending.resolve })
    input.signal.addEventListener('abort', () => pending.resolve({ status: 'aborted' }), { once: true })
    return pending.promise
  })
})

afterEach(() => {
  observations.splice(0).forEach((observation) => observation.stop())
  streams.length = 0
  resetClientSessionForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('selected reader generation observation', () => {
  it('discovers only the selected chat and publishes partial text without changing canonical messages', async () => {
    runtime.generationOperations!.push(
      operation({ operationId: 'other-operation', characterId: 'other-character', chatId: 'other-chat' }),
    )
    const { view } = start()
    await flush()
    expect(api.bootstrap).toHaveBeenCalledWith(expect.any(AbortSignal), { cacheRevision: false })
    expect(streams).toHaveLength(1)
    expect(streams[0]!.input.identity).toEqual({
      databaseLineage: 'lineage-a',
      characterId: 'character-a',
      chatId: 'chat-a',
      operationId: 'operation-a',
      attemptNo: 1,
      jobId: 'job-a',
      projectionEpoch: 2,
    })
    partial()
    expect(view()).toMatchObject({
      status: 'watching',
      projection: { text: 'Live partial', status: 'streaming', generationId: 'job-a' },
    })
    expect(api.messages).toEqual([])
    expect(api.hydrate).not.toHaveBeenCalled()
    const before = view()
    emit(0, { type: 'side_effect', kind: 'plugin_output', data: 'untrusted effect' })
    emit(0, { type: 'message_patch', patch: { mutations: [] } })
    expect(view()).toBe(before)
  })

  it.each(['unmanaged', 'resolving', 'auth-required', 'unready', 'missing-incarnation'])(
    'does no generation work in %s scope',
    async (state) => {
      if (state === 'unmanaged') resetClientSessionForTests()
      if (state === 'resolving') beginClientSession('reader-b')
      if (state === 'auth-required') requireClientAuthentication()
      if (state === 'unready') setClientProjectionReady(false)
      if (state === 'missing-incarnation') api.incarnation = null
      start()
      await flush()
      expect(api.bootstrap).not.toHaveBeenCalled()
      expect(api.stream).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('discovers a generation started after an idle reader mounted', async () => {
    runtime.generationOperations = []
    const { view } = start()
    await flush()
    expect(view()).toEqual({ status: 'idle', projection: null })
    expect(streams).toHaveLength(0)
    runtime.generationOperations = [operation()]
    await vi.advanceTimersByTimeAsync(READER_GENERATION_IDLE_POLL_MS)
    expect(streams).toHaveLength(1)
  })

  it('starts when a retained reader scope becomes coherent without recreating the service', async () => {
    setClientProjectionReady(false)
    start()
    await flush()
    expect(api.bootstrap).not.toHaveBeenCalled()
    setClientProjectionReady(true)
    await flush()
    expect(streams).toHaveLength(1)
    setClientConnectionState('interrupted')
    expect(streams[0]!.input.signal.aborted).toBe(true)
    setClientConnectionState('live')
    await flush()
    expect(streams).toHaveLength(2)
  })

  it('keeps incomplete operation eligibility and attaches when its descriptor arrives without any submission', async () => {
    runtime.generationOperations = [operation({ currentAttempt: undefined })]
    const { view } = start()
    await flush()
    expect(view()).toEqual({ status: 'interrupted', projection: null })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(api.bootstrap).toHaveBeenCalledTimes(4)
    expect(streams).toHaveLength(0)
    runtime.generationOperations = [operation()]
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    expect(streams).toHaveLength(1)
    expect(view()?.status).toBe('watching')
  })

  it('treats accepted work without a launched attempt as waiting and retires a previous operation overlay', async () => {
    const { view } = start()
    await flush()
    partial()
    runtime.generationOperationProjectionEpoch = 3
    runtime.generationOperations = [
      operation({ operationId: 'operation-b', state: 'accepted', currentAttempt: undefined, projectionEpoch: 3 }),
    ]
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    expect(view()).toEqual({ status: 'watching', projection: null })
    expect(streams[0]!.input.signal.aborted).toBe(true)
    runtime.generationOperationProjectionEpoch = 4
    runtime.generationOperations = [
      operation({
        operationId: 'operation-b',
        state: 'terminal_failed',
        currentAttempt: undefined,
        projectionEpoch: 4,
      }),
    ]
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    expect(view()).toEqual({ status: 'idle', projection: null })
  })

  it('replays Continue from its immutable base without appending partial text into that base', async () => {
    runtime.generationOperations = [operation({ mode: 'continue', targetMessageId: 'target-a' })]
    api.messages = [
      canonical({ chatId: 'target-a', data: 'Original base', generationInfo: { generationId: 'older-job' } }),
    ]
    const { view, observation } = start()
    await flush()
    emit(0, { type: 'info', generationId: 'job-a', continueDisposition: 'extend', continueBase: 'Original base' })
    emit(0, { type: 'token', content: ' plus partial' })
    expect(view()?.projection?.text).toBe('Original base plus partial')
    observation.refresh()
    await flush()
    emit(1, { type: 'info', generationId: 'job-a', continueDisposition: 'extend', continueBase: 'Original base' })
    emit(1, { type: 'token', content: ' plus' })
    emit(1, { type: 'token', content: ' complete' })
    expect(view()?.projection?.text).toBe('Original base plus complete')
    expect(api.messages[0]!.data).toBe('Original base')
  })

  it('buffers half-stream text and ignores a lossy replay suffix until the terminal snapshot', async () => {
    const { view } = start()
    await flush()
    emit(0, { type: 'info', generationId: 'job-a', halfStreaming: true })
    emit(0, { type: 'token', content: 'secret partial', generatedTokens: 4, elapsedMs: 500 })
    expect(view()?.projection).toMatchObject({ text: null, halfStreaming: true, generatedTokens: 4, elapsedMs: 500 })
    emit(0, { type: 'replay_gap', reason: 'replay_budget_exceeded', evictedEvents: 1, evictedBytes: 10 })
    emit(0, { type: 'token', content: 'suffix' })
    expect(view()?.projection?.text).toBeNull()
    emit(0, { type: 'done', result: 'Full canonical raw snapshot', projectionEpoch: 3 })
    expect(view()?.projection).toMatchObject({
      text: 'Full canonical raw snapshot',
      status: 'finalizing',
      gapTruncated: false,
    })
  })

  it('keeps a terminal projection until exact certified result hydration completes', async () => {
    const { view } = start()
    await flush()
    partial()
    const terminal = emit(0, {
      type: 'done',
      result: 'Raw final',
      projectionEpoch: 3,
      postGeneration: { messageId: 'result-a', resendChat: true, effectLedger: { keyId: 'do-not-run' } },
    })
    completed()
    const hydration = deferred<boolean>()
    api.hydrate.mockReturnValueOnce(hydration.promise)
    streams[0]!.finish({ status: 'terminal', event: terminal as Extract<PromptChatEvent, { type: 'done' }> })
    await vi.advanceTimersByTimeAsync(0)
    expect(view()?.projection).toMatchObject({ text: 'Raw final', status: 'finalizing' })
    expect(api.hydrate).toHaveBeenCalledWith('chat-a', 'result-a', { signal: expect.any(AbortSignal) })
    api.messages = [canonical({ data: 'Server postprocessed final' })]
    hydration.resolve(true)
    await flush()
    expect(view()).toEqual({ status: 'idle', projection: null })
    expect(api.messages[0]!.data).toBe('Server postprocessed final')
    expect(api.discard).not.toHaveBeenCalled()
  })

  it('accepts command-before-done convergence and only detaches its viewer', async () => {
    const { view } = start()
    await flush()
    partial()
    completed()
    api.messages = [canonical()]
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    expect(view()).toEqual({ status: 'idle', projection: null })
    expect(streams[0]!.input.signal.aborted).toBe(true)
    expect(api.hydrate).not.toHaveBeenCalled()
  })

  it('does not confuse the preexisting Continue target with the new persisted result', async () => {
    runtime.generationOperations = [operation({ mode: 'continue', targetMessageId: 'target-a' })]
    api.messages = [canonical({ chatId: 'target-a', generationInfo: { generationId: 'older-job' } })]
    const { view } = start()
    await flush()
    partial()
    completed({ resultMessageId: 'target-a', mode: 'continue', targetMessageId: 'target-a' })
    api.messages = [
      canonical({
        chatId: 'target-a',
        generationInfo: {
          databaseLineage: 'lineage-a',
          operationId: 'older-operation',
          attemptNo: 1,
          generationId: 'older-job',
        },
      }),
    ]
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    expect(view()?.status).toBe('interrupted')
    expect(view()?.projection).not.toBeNull()
    api.messages = [canonical({ chatId: 'target-a' })]
    await vi.advanceTimersByTimeAsync(500)
    expect(view()).toEqual({ status: 'idle', projection: null })
  })

  it('hydrates an older regenerate target by exact identity before attaching and its replacement by exact result', async () => {
    runtime.generationOperations = [operation({ mode: 'regenerate', targetMessageId: 'older-target' })]
    api.messages = [canonical({ chatId: 'tail-message', generationInfo: { generationId: 'other-job' } })]
    const target = deferred<boolean>()
    api.hydrate.mockReturnValueOnce(target.promise)
    const { view } = start()
    await flush()
    expect(api.hydrate).toHaveBeenCalledWith('chat-a', 'older-target', { signal: expect.any(AbortSignal) })
    expect(streams).toHaveLength(0)
    api.messages.unshift(
      canonical({ chatId: 'older-target', data: 'Original target', generationInfo: { generationId: 'old-job' } }),
    )
    target.resolve(true)
    await flush()
    expect(streams).toHaveLength(1)
    partial()
    expect(view()?.projection).toMatchObject({
      mode: 'regenerate',
      targetMessageId: 'older-target',
      text: 'Live partial',
    })
    expect(api.messages[0]!.data).toBe('Original target')
    completed({ mode: 'regenerate', targetMessageId: 'older-target' })
    api.hydrate.mockImplementationOnce(async () => {
      api.messages[0] = canonical()
      return true
    })
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    expect(api.hydrate).toHaveBeenLastCalledWith('chat-a', 'result-a', { signal: expect.any(AbortSignal) })
    expect(view()).toEqual({ status: 'idle', projection: null })
  })

  it('retires an older attempt when the next discovered attempt already has an exact canonical terminal', async () => {
    const { view } = start()
    await flush()
    partial()
    completed({ projectionEpoch: 6, stateVersion: 6, resultMessageId: 'result-b' })
    runtime.generationOperationProjectionEpoch = 6
    api.messages = [
      canonical({
        chatId: 'result-b',
        generationInfo: {
          databaseLineage: 'lineage-a',
          operationId: 'operation-a',
          attemptNo: 2,
          generationId: 'job-b',
        },
      }),
    ]
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    expect(view()).toEqual({ status: 'idle', projection: null })
    expect(streams).toHaveLength(1)
  })

  it('does not clear a result with a mismatched lineage, attempt or operation', async () => {
    const { view } = start()
    await flush()
    partial()
    completed()
    api.messages = [
      canonical({
        generationInfo: {
          databaseLineage: 'other-lineage',
          operationId: 'operation-a',
          attemptNo: 1,
          generationId: 'job-a',
        },
      }),
    ]
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    expect(view()?.projection?.text).toBe('Live partial')
    expect(view()?.status).toBe('interrupted')
  })

  it('settles a cancellation without a retained assistant only after a successful authoritative read', async () => {
    const { view } = start()
    await flush()
    partial()
    completed({ state: 'cancelled', resultMessageId: undefined })
    api.hydrate.mockResolvedValueOnce(false)
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    expect(view()?.projection).not.toBeNull()
    await vi.advanceTimersByTimeAsync(500)
    expect(view()).toEqual({ status: 'idle', projection: null })
    expect(api.messages).toEqual([])
  })

  it('keeps observing server finalization without issuing a finalization retry', async () => {
    const { view } = start()
    await flush()
    partial()
    runtime.generationOperationProjectionEpoch = 3
    runtime.generationOperations = [operation({ state: 'finalizing', projectionEpoch: 3 })]
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    expect(view()?.projection).toMatchObject({ status: 'finalizing', phase: 'finalizing', text: 'Live partial' })
    expect(streams[0]!.input.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(streams).toHaveLength(1)
    completed({ projectionEpoch: 4 })
    runtime.generationOperationProjectionEpoch = 4
    api.messages = [canonical()]
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    expect(view()).toEqual({ status: 'idle', projection: null })
  })

  it('caps stream EOF retries while continuing bounded status discovery and allows explicit refresh', async () => {
    const { view, observation } = start()
    await flush()
    for (let index = 0; index < 4; index++) {
      partial(index)
      streams[index]!.finish({ status: 'ended', error: 'unrequested EOF' })
      await flush()
      await vi.advanceTimersByTimeAsync([500, 2_000, 5_000, 5_000][index]!)
    }
    expect(streams).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(streams).toHaveLength(4)
    expect(view()?.status).toBe('interrupted')
    expect(vi.getTimerCount()).toBe(1)
    observation.refresh()
    await flush()
    expect(streams).toHaveLength(5)
    partial(4, 'Recovered')
    expect(view()?.projection?.text).toBe('Recovered')
  })

  it('replaces the exact attempt and ignores late frames from the detached stream', async () => {
    const { view } = start()
    await flush()
    partial()
    runtime.generationOperationProjectionEpoch = 4
    const firstAttempt = operation().currentAttempt!
    runtime.generationOperations = [
      operation({
        projectionEpoch: 4,
        stateVersion: 4,
        currentAttempt: { ...firstAttempt, attemptNo: 2, jobId: 'job-b' },
      }),
    ]
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    expect(streams).toHaveLength(2)
    expect(streams[0]!.input.signal.aborted).toBe(true)
    partial(1, 'New attempt')
    partial(0, 'Old attempt late token')
    expect(view()?.projection).toMatchObject({ attemptNo: 2, jobId: 'job-b', text: 'New attempt' })
  })

  it('fences a held old active bootstrap after a newer terminal stream frame', async () => {
    const { view } = start()
    await flush()
    partial()
    const held = deferred<unknown>()
    const stale = structuredClone(runtime)
    api.bootstrap.mockReturnValueOnce(held.promise)
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    const terminal = emit(0, { type: 'done', result: 'Finished raw', projectionEpoch: 3 })
    streams[0]!.finish({ status: 'terminal', event: terminal as Extract<PromptChatEvent, { type: 'done' }> })
    await flush()
    held.resolve({ status: 'ok', bootstrap: stale })
    await flush()
    expect(streams).toHaveLength(1)
    expect(view()?.projection?.text).toBe('Finished raw')
    completed()
    api.messages = [canonical()]
    await vi.advanceTimersByTimeAsync(500)
    expect(view()).toEqual({ status: 'idle', projection: null })
  })

  it('does not let a superseded false hydration interrupt or reschedule a newer viewer', async () => {
    const { view, observation, changes } = start()
    await flush()
    partial()
    completed()
    const hydration = deferred<boolean>()
    api.hydrate.mockReturnValueOnce(hydration.promise)
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    runtime.generationOperationProjectionEpoch = 5
    runtime.generationOperations = [
      operation({
        operationId: 'operation-b',
        projectionEpoch: 5,
        currentAttempt: { ...operation().currentAttempt!, jobId: 'job-b' },
      }),
    ]
    observation.refresh()
    await flush()
    partial(1, 'Current live attempt')
    const count = changes.length
    const timers = vi.getTimerCount()
    hydration.resolve(false)
    await flush()
    expect(changes).toHaveLength(count)
    expect(vi.getTimerCount()).toBe(timers)
    expect(view()?.projection).toMatchObject({
      operationId: 'operation-b',
      text: 'Current live attempt',
      status: 'streaming',
    })
  })

  it('bounds non-cooperative status and hydration reads and rejects their late publications', async () => {
    const held = deferred<unknown>()
    api.bootstrap.mockReturnValueOnce(held.promise)
    const { view, observation } = start()
    await vi.advanceTimersByTimeAsync(READER_GENERATION_READ_TIMEOUT_MS)
    expect(view()?.status).toBe('interrupted')
    await vi.advanceTimersByTimeAsync(500)
    expect(streams).toHaveLength(1)
    held.resolve({ status: 'ok', bootstrap: { ...runtime, databaseLineage: 'old-lineage' } })
    await flush()
    expect(view()?.projection?.operationId).toBe('operation-a')
    partial()
    completed()
    const hydration = deferred<boolean>()
    api.hydrate.mockReturnValueOnce(hydration.promise)
    observation.refresh()
    await flush()
    await vi.advanceTimersByTimeAsync(READER_GENERATION_READ_TIMEOUT_MS)
    expect(view()?.status).toBe('interrupted')
    api.messages = [canonical()]
    await vi.advanceTimersByTimeAsync(500)
    expect(view()).toEqual({ status: 'idle', projection: null })
    hydration.resolve(false)
    await flush()
    expect(view()).toEqual({ status: 'idle', projection: null })
  })

  it('stops automatic failed-status retries after their bounded sequence', async () => {
    api.bootstrap.mockImplementation(() => new Promise(() => {}))
    const { view, observation } = start()
    await vi.advanceTimersByTimeAsync(100_000)
    expect(api.bootstrap).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
    expect(view()?.status).toBe('interrupted')
    api.bootstrap.mockResolvedValue({ status: 'ok', bootstrap: runtime })
    observation.refresh()
    await flush()
    expect(streams).toHaveLength(1)
  })

  it('clears transient output on database replacement and cannot revive the old lineage', async () => {
    const first = start()
    await flush()
    partial()
    runtime = { ...runtime, databaseLineage: 'lineage-b' }
    await vi.advanceTimersByTimeAsync(READER_GENERATION_POLL_MS)
    expect(first.view()).toEqual({ status: 'interrupted', projection: null })
    expect(streams[0]!.input.signal.aborted).toBe(true)
    reader('lineage-b')
    const second = start()
    await flush()
    partial(0, 'Stale lineage')
    partial(1, 'New database')
    expect(second.view()?.projection).toMatchObject({ databaseLineage: 'lineage-b', text: 'New database' })
  })

  it.each(['promotion', 'auth', 'incarnation', 'stop'])(
    'invalidates callbacks and releases all work on %s',
    async (reason) => {
      const { observation, changes } = start()
      await flush()
      partial()
      if (reason === 'promotion') beginClientPromotion()
      if (reason === 'auth') requireClientAuthentication()
      if (reason === 'incarnation') {
        api.incarnation = 2
        observation.stop()
      }
      if (reason === 'stop') observation.stop()
      const count = changes.length
      partial(0, 'Late output')
      await flush()
      expect(changes).toHaveLength(count)
      expect(streams[0]!.input.signal.aborted).toBe(true)
      expect(api.stopLifecycle).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('silently detaches while hidden, reports offline failure, and reattaches in the foreground', async () => {
    const browser = new EventTarget()
    const documentEvents = new EventTarget()
    let visibility = 'visible'
    let online = true
    Object.defineProperty(documentEvents, 'visibilityState', { get: () => visibility })
    vi.stubGlobal('window', browser)
    vi.stubGlobal('document', documentEvents)
    vi.stubGlobal('navigator', {
      get onLine() {
        return online
      },
    })
    const { view, observation } = start()
    await flush()
    partial()
    visibility = 'hidden'
    documentEvents.dispatchEvent(new Event('visibilitychange'))
    expect(streams[0]!.input.signal.aborted).toBe(true)
    expect(view()).toMatchObject({
      status: 'watching',
      projection: { status: 'streaming', text: 'Live partial' },
    })
    expect(vi.getTimerCount()).toBe(0)
    visibility = 'visible'
    api.lifecycle.mock.calls[0]![0]('visibility')
    await flush()
    expect(streams).toHaveLength(2)
    online = false
    browser.dispatchEvent(new Event('offline'))
    expect(streams[1]!.input.signal.aborted).toBe(true)
    expect(view()?.status).toBe('interrupted')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(streams).toHaveLength(2)
    online = true
    api.lifecycle.mock.calls[0]![0]('online')
    await flush()
    expect(streams).toHaveLength(3)
    browser.dispatchEvent(new Event('pagehide'))
    expect(streams[2]!.input.signal.aborted).toBe(true)
    observation.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the existing authentication-loss boundary for current 401 but rejects a stale 401', async () => {
    const held = deferred<unknown>()
    api.bootstrap.mockReturnValueOnce(held.promise)
    const { observation } = start()
    observation.refresh()
    await flush()
    held.resolve({ status: 'error', httpStatus: 401, error: 'Old auth response' })
    await flush()
    expect(api.discard).not.toHaveBeenCalled()
    streams[0]!.finish({ status: 'unavailable', httpStatus: 401, error: 'Auth expired' })
    await flush()
    expect(api.discard).toHaveBeenCalledWith('auth-loss')
    expect(getClientSessionSnapshot().lifecycle).toBe('auth-required')
    expect(vi.getTimerCount()).toBe(0)
  })
})
