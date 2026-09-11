import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import {
  BARDWIKI_PROTOCOL_VERSION,
  DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
  type BardWikiChatResource,
  type BardWikiJobSummary,
} from '@risuai/protocol'
import type { ServerMemoryEvent, ServerMemoryJobSnapshot, SubscribeServerCommandEventsInput } from './events'
import type { ServerResourceRefreshOptions } from './resourceInvalidation'
import type { ServerMemoryJob } from '../process/request/serverMemory'

const api = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  ownership: vi.fn(),
  subscribe: vi.fn(),
  targeted: vi.fn(),
  full: vi.fn(),
  applyChat: vi.fn(() => true),
  applyLorebook: vi.fn(() => true),
  markLorebook: vi.fn(),
  resetChat: vi.fn(),
  resetShell: vi.fn(),
  resetLorebook: vi.fn(),
  clearTranslation: vi.fn(),
  greeting: vi.fn(),
  applyGreeting: vi.fn(),
  lifecycle: vi.fn(),
  stopLifecycle: vi.fn(),
  known: null as number | null,
  applied: null as number | null,
}))
vi.mock('./bootstrap', () => ({
  fetchServerBootstrapReadOnly: api.bootstrap,
  fetchServerOwnership: api.ownership,
}))
vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: async () => 'reader-auth' }))
vi.mock('./events', () => ({ subscribeServerCommandEvents: api.subscribe }))
vi.mock('./commands', () => ({
  peekCachedServerCommandRevision: () => api.known,
  peekAppliedServerResourceRevision: () => api.applied,
  setAppliedServerResourceRevision: (revision: number) => {
    api.applied = Math.max(api.applied ?? 0, revision)
  },
  setCachedServerCommandRevision: (revision: number) => {
    api.known = Math.max(api.known ?? 0, revision)
  },
}))
vi.mock('./resourceInvalidation', () => ({
  refreshInvalidatedServerResources: api.targeted,
  refreshAllServerResources: api.full,
}))
vi.mock('./chatMessageHydration.svelte', () => ({
  applyServerChatMessagesResource: api.applyChat,
  resetChatHydration: api.resetChat,
}))
vi.mock('./characterShellHydration.svelte', () => ({ clearCharacterShellHydrationState: api.resetShell }))
vi.mock('./lorebookOwner.svelte', () => ({
  applyServerCharacterLorebookResource: api.applyLorebook,
  markCharacterLorebookHydrated: api.markLorebook,
  resetLorebookHydration: api.resetLorebook,
}))
vi.mock('./messageTranslationJobs', () => ({ clearActiveMessageTranslation: api.clearTranslation }))
vi.mock('./greetingTranslations.svelte', () => ({
  applyGreetingTranslationProjection: api.applyGreeting,
  fetchGreetingTranslationProjection: api.greeting,
  getGreetingTranslationProjection: () => null,
}))
vi.mock('./resourceState.svelte', () => ({ charactersResourceState: { characters: [] } }))
vi.mock('./lifecycleRecovery', () => ({ subscribeBrowserLifecycleRecovery: api.lifecycle }))

import {
  beginClientPromotion,
  beginClientSession,
  canUseClientWriteAccess,
  clientSessionStore,
  getClientSessionSnapshot,
  requireClientAuthentication,
  resetClientSessionForTests,
  setClientProjectionReady,
  settleClientReader,
} from '../clientSession'
import {
  calculateConnectedReaderReconnectDelayMs,
  startConnectedReaderSync,
  type ConnectedReaderSync,
} from './connectedReaderSync'
import {
  memoryJobProjectionStore,
  resetMemoryJobProjectionForTests,
  selectMemoryJobs,
  selectMemoryProgress,
} from './memoryJobProjection.svelte'
import {
  publishServerBardWikiJobEvent,
  publishServerBardWikiJobSnapshot,
  subscribeServerBardWikiJobEvents,
  type ServerBardWikiJobEvent,
  type ServerBardWikiJobSnapshot,
} from './bardWikiJobEvents'
import { getBardWikiChatResource, loadBardWikiChatResource, resetBardWikiResource } from './bardWikiResource'
import { charactersResourceState } from './resourceState.svelte'
import { recordReaderRouteIntent, resetReaderRouteIntentForTests } from '../readerRouteIntent'

const ownership = { databaseLineage: 'database-a', writer: { sessionId: 'writer-a', epoch: 1 } }
const streams: { input: SubscribeServerCommandEventsInput; stop: ReturnType<typeof vi.fn> }[] = []
const controllers: ConnectedReaderSync[] = []
const cleanups: (() => void)[] = []

function reader(): void {
  const operation = beginClientSession('reader-a')
  settleClientReader(operation, ownership)
  setClientProjectionReady(true)
}
function start() {
  const callbacks = {
    onAuthLoss: vi.fn(),
    onLineageChange: vi.fn(),
    onWriterEvent: vi.fn(),
    onProjectionRefreshed: vi.fn(),
  }
  const sync = startConnectedReaderSync(callbacks)
  controllers.push(sync)
  return { sync, callbacks }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}
async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve()
}
function command(revision: number) {
  return { type: 'settings.updated', resource: 'settings', id: 'display', revision }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.clearAllMocks()
  api.bootstrap
    .mockReset()
    .mockResolvedValue({ status: 'ok', bootstrap: { initialized: true, revision: 5, ...ownership } })
  api.ownership.mockReset().mockResolvedValue({ status: 'ok', ownership: { version: 1, ...ownership } })
  api.subscribe.mockReset().mockImplementation(async (input) => {
    const stop = vi.fn()
    streams.push({ input, stop })
    return { status: 'ok', unsubscribe: stop }
  })
  api.targeted
    .mockReset()
    .mockImplementation(async (event) => ({ status: 'ok', scope: 'targeted', revision: event.revision }))
  api.full.mockReset().mockImplementation(async (options: ServerResourceRefreshOptions) => {
    options.onFullProjectionApplied?.()
    return { status: 'ok', scope: 'full', revision: 10 }
  })
  api.lifecycle.mockReset().mockReturnValue(api.stopLifecycle)
  api.greeting.mockReset()
  charactersResourceState.characters = []
  resetReaderRouteIntentForTests()
  api.applied = 5
  api.known = 5
  streams.length = 0
  resetClientSessionForTests()
  resetMemoryJobProjectionForTests()
  resetBardWikiResource()
  reader()
})
afterEach(() => {
  for (const sync of controllers.splice(0)) sync.stop()
  for (const stop of cleanups.splice(0)) stop()
  resetClientSessionForTests()
  resetBardWikiResource()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('connected reader synchronization', () => {
  it('reports the browser offline signal immediately and waits for online recovery without acquiring', async () => {
    const events = new EventTarget()
    let online = true
    vi.stubGlobal('window', events)
    vi.stubGlobal('navigator', {
      get onLine() {
        return online
      },
    })
    const { sync } = start()
    await sync.ready
    expect(getClientSessionSnapshot().connection).toBe('live')
    online = false
    events.dispatchEvent(new Event('offline'))
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'reading', connection: 'interrupted' })
    expect(streams[0].stop).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.subscribe).toHaveBeenCalledOnce()
    expect(api.bootstrap).toHaveBeenCalledOnce()
    online = true
    api.lifecycle.mock.calls[0]![0]()
    await flush()
    expect(streams).toHaveLength(2)
    expect(api.ownership).toHaveBeenCalledOnce()
    expect(api.bootstrap).toHaveBeenCalledOnce()
    expect(streams[1].input).toMatchObject({ mode: 'reader', sinceRevision: 5 })
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'reading', connection: 'live' })
    expect(canUseClientWriteAccess()).toBe(false)
    sync.stop()
    online = false
    events.dispatchEvent(new Event('offline'))
    expect(getClientSessionSnapshot().connection).toBe('live')
  })

  it.each(['accepted', 'superseded', 'failed'] as const)(
    'refreshes only the locally viewed greeting projection with a %s result',
    async (outcome) => {
      charactersResourceState.characters = [
        { chaId: 'char-a', chatPage: 0, chats: [{ id: 'canonical-chat' }, { id: 'reader-chat' }] },
      ] as any
      recordReaderRouteIntent({
        kind: 'character',
        path: '/character/char-a',
        chaId: 'char-a',
        chatId: 'reader-chat',
      })
      const held = deferred<any>()
      api.greeting.mockReturnValueOnce(held.promise)
      api.targeted.mockImplementationOnce(async (_event, options: ServerResourceRefreshOptions) => {
        const applied = await options.hooks?.refreshGreetingTranslations?.('char-a', 6)
        return applied
          ? { status: 'ok', scope: 'targeted', revision: 6 }
          : { status: 'error', error: 'greeting read failed' }
      })
      const { sync } = start()
      await sync.ready
      streams[0].input.onCommandEvent({
        type: 'greetingTranslation.updated',
        resource: 'greetingTranslation',
        revision: 6,
        id: 'char-a',
      })
      await flush()
      expect(api.greeting).toHaveBeenCalledExactlyOnceWith('char-a', 'reader-chat', undefined, expect.any(AbortSignal))
      if (outcome === 'superseded') reader()
      held.resolve(outcome === 'failed' ? { status: 'error', error: 'network' } : { status: 'ok', revision: 6 })
      await flush()
      expect(api.applyGreeting).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0)
      expect(api.applied).toBe(outcome === 'accepted' ? 6 : 5)
    },
  )

  it('subscribes from the applied cursor without interpreting newer bootstrap knowledge as projection application', async () => {
    api.bootstrap.mockResolvedValue({ status: 'ok', bootstrap: { initialized: true, revision: 20, ...ownership } })
    const { sync } = start()
    await sync.ready
    expect(api.bootstrap).toHaveBeenCalledWith(expect.any(AbortSignal), { cacheRevision: false })
    expect(streams[0].input).toMatchObject({ mode: 'reader', sinceRevision: 5 })
    expect(api.known).toBe(20)
    expect(api.applied).toBe(5)
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      connection: 'live',
      projectionReady: true,
    })
    expect(canUseClientWriteAccess()).toBe(false)
    expect(api.full).not.toHaveBeenCalled()
  })

  it('keeps initial and later foreign writer frames connected, including a matching session observation', async () => {
    const { sync, callbacks } = start()
    await sync.ready
    const generation = getClientSessionSnapshot().generation
    streams[0].input.onWriterEvent?.(ownership.writer)
    streams[0].input.onWriterEvent?.({ sessionId: 'writer-b', epoch: 2 })
    streams[0].input.onWriterEvent?.({ sessionId: 'reader-a', epoch: 3 })
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'reading', connection: 'live', generation })
    expect(canUseClientWriteAccess()).toBe(false)
    expect(streams[0].stop).not.toHaveBeenCalled()
    expect(callbacks.onLineageChange).not.toHaveBeenCalled()
  })

  it('hands an SSE ownership-lineage change directly to the coordinator', async () => {
    const { sync, callbacks } = start()
    await sync.ready
    streams[0].input.onWriterEvent?.({ databaseLineage: 'database-b', sessionId: 'writer-b', epoch: 2 })
    expect(callbacks.onLineageChange).toHaveBeenCalledWith({
      databaseLineage: 'database-b',
      writer: { sessionId: 'writer-b', epoch: 2 },
    })
    expect(streams[0].stop).toHaveBeenCalledOnce()
  })

  it('serializes event reads and only advances application after each projection callback completes', async () => {
    const held = deferred<any>()
    api.targeted.mockReturnValueOnce(held.promise)
    const { sync, callbacks } = start()
    await sync.ready
    streams[0].input.onCommandEvent(command(6))
    streams[0].input.onCommandEvent(command(7))
    await flush()
    expect(api.known).toBe(7)
    expect(api.applied).toBe(5)
    expect(api.targeted).toHaveBeenCalledTimes(1)
    held.resolve({ status: 'ok', scope: 'targeted', revision: 6 })
    await flush()
    expect(api.targeted).toHaveBeenCalledTimes(2)
    expect(api.targeted.mock.calls[1][1].appliedRevision).toBe(6)
    expect(api.applied).toBe(7)
    expect(callbacks.onProjectionRefreshed).toHaveBeenCalledTimes(2)
    expect(Object.keys(api.targeted.mock.calls[0][1].hooks).sort()).toEqual([
      'applyCharacterLorebook',
      'applyChatMessages',
      'clearActiveMessageTranslation',
      'markCharacterLorebookHydrated',
      'refreshGreetingTranslations',
    ])
    streams[0].input.onCommandEvent(command(7))
    await flush()
    expect(api.targeted).toHaveBeenCalledTimes(2)
  })

  it('replaces a replay gap through read-only resources and forgets hydrated body identities', async () => {
    const { sync } = start()
    await sync.ready
    streams[0].input.onCommandEvent(command(10))
    await flush()
    expect(api.full).toHaveBeenCalledWith(expect.objectContaining({ mode: 'reader', isCurrent: expect.any(Function) }))
    expect(api.applied).toBe(10)
    expect(api.resetChat).toHaveBeenCalledOnce()
    expect(api.resetShell).toHaveBeenCalledOnce()
    expect(api.resetLorebook).toHaveBeenCalledOnce()
  })

  it('retains the usable projection after a failed read and resumes from the unchanged applied cursor', async () => {
    api.targeted.mockResolvedValueOnce({ status: 'error', error: 'offline' })
    const { sync } = start()
    await sync.ready
    streams[0].input.onCommandEvent(command(6))
    await flush()
    expect(api.applied).toBe(5)
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      connection: 'interrupted',
      projectionReady: true,
    })
    expect(api.resetChat).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(streams[1].input.sinceRevision).toBe(5)
    expect(getClientSessionSnapshot().connection).toBe('live')
  })

  it('refreshes an exhausted replay cursor before reconnecting from the successful snapshot', async () => {
    api.subscribe.mockResolvedValueOnce({
      status: 'replay-unavailable',
      error: 'event_replay_unavailable',
      currentRevision: 10,
    })
    const { sync } = start()
    await sync.ready
    await flush()
    expect(api.applied).toBe(10)
    expect(api.full).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(streams[0].input.sinceRevision).toBe(10)
  })

  it('rejects a full snapshot older than the missing event instead of acknowledging the gap', async () => {
    api.full.mockResolvedValue({ status: 'ok', scope: 'full', revision: 8 })
    const { sync } = start()
    await sync.ready
    streams[0].input.onCommandEvent(command(10))
    await flush()
    expect(api.applied).toBe(5)
    expect(getClientSessionSnapshot().connection).toBe('interrupted')
  })

  it.each(['bootstrap', 'stream'] as const)(
    'stops for an authenticated %s rejection without retrying',
    async (target) => {
      api[target === 'bootstrap' ? 'bootstrap' : 'subscribe'].mockResolvedValueOnce({
        status: 'error',
        error: 'missing_auth',
        httpStatus: 401,
      })
      const { sync, callbacks } = start()
      await sync.ready
      expect(callbacks.onAuthLoss).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(api.bootstrap).toHaveBeenCalledTimes(1)
    },
  )

  it('fences held reads and closes all consumers when another auth boundary invalidates the session', async () => {
    const held = deferred<any>()
    api.targeted.mockReturnValueOnce(held.promise)
    const { sync, callbacks } = start()
    await sync.ready
    streams[0].input.onCommandEvent(command(6))
    await flush()
    const refresh = api.targeted.mock.calls[0][1]
    requireClientAuthentication()
    expect(refresh.isCurrent()).toBe(false)
    expect(refresh.signal.aborted).toBe(true)
    held.resolve({ status: 'ok', scope: 'targeted', revision: 6 })
    await flush()
    expect(api.applied).toBe(5)
    expect(callbacks.onProjectionRefreshed).not.toHaveBeenCalled()
    expect(callbacks.onAuthLoss).toHaveBeenCalledOnce()
    expect(api.stopLifecycle).toHaveBeenCalledOnce()
    expect(streams[0].stop).toHaveBeenCalledOnce()
  })

  it('stops the old reader generation during promotion and rejects its later callbacks', async () => {
    const { sync, callbacks } = start()
    await sync.ready
    expect(beginClientPromotion()).not.toBeNull()
    streams[0].input.onCommandEvent(command(6))
    streams[0].input.onWriterEvent?.({ sessionId: 'writer-b', epoch: 2 })
    await flush()
    expect(api.targeted).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot().lifecycle).toBe('promoting')
    expect(callbacks.onAuthLoss).not.toHaveBeenCalled()
    expect(streams[0].stop).toHaveBeenCalledOnce()
  })

  it('hands a replacement lineage to the coordinator before reading or applying its resources', async () => {
    const { sync, callbacks } = start()
    await sync.ready
    api.bootstrap.mockResolvedValue({
      status: 'ok',
      bootstrap: {
        initialized: true,
        revision: 1,
        databaseLineage: 'database-b',
        writer: { sessionId: 'writer-b', epoch: 1 },
      },
    })
    streams[0].input.onCommandEvent({ type: 'state.restored', resource: 'state', revision: 1 })
    await flush()
    expect(callbacks.onLineageChange).toHaveBeenCalledWith({
      databaseLineage: 'database-b',
      writer: { sessionId: 'writer-b', epoch: 1 },
    })
    expect(api.applied).toBe(5)
    expect(api.full).not.toHaveBeenCalled()
    expect(streams[0].stop).toHaveBeenCalledOnce()
  })

  it('skips ordinary focus while live and uses ownership before reconnecting a discarded stream', async () => {
    const held = deferred<any>()
    api.targeted.mockReturnValueOnce(held.promise)
    const { sync } = start()
    await sync.ready
    const connections: string[] = []
    cleanups.push(clientSessionStore.subscribe((state) => connections.push(state.connection)))
    streams[0].input.onCommandEvent(command(6))
    await flush()
    const read = api.targeted.mock.calls[0][1]

    api.lifecycle.mock.calls[0]![0]('focus', { suspensionEvidence: false })
    await flush()
    expect(api.ownership).not.toHaveBeenCalled()
    expect(streams).toHaveLength(1)
    expect(read.isCurrent()).toBe(true)

    api.lifecycle.mock.calls[0]![0]('visibility', { suspensionEvidence: true })
    await flush()
    expect(api.ownership).toHaveBeenCalledOnce()
    expect(streams).toHaveLength(1)
    expect(connections).toEqual(['live'])

    streams[0].input.onClose?.()
    expect(read.isCurrent()).toBe(false)
    api.lifecycle.mock.calls[0]![0]('focus', { suspensionEvidence: false })
    await flush()
    expect(api.ownership).toHaveBeenCalledTimes(2)
    expect(api.bootstrap).toHaveBeenCalledOnce()
    expect(streams).toHaveLength(2)
    expect(streams[1].input.sinceRevision).toBe(5)
    expect(getClientSessionSnapshot().connection).toBe('live')

    held.resolve({ status: 'ok', scope: 'targeted', revision: 6 })
    streams[0].input.onCommandEvent(command(99))
    await flush()
    expect(api.applied).toBe(5)
    expect(api.known).toBe(6)
  })

  it.each([
    [
      'changed',
      {
        status: 'ok',
        ownership: { version: 1, databaseLineage: 'database-a', writer: { sessionId: 'writer-b', epoch: 2 } },
      },
    ],
    ['uncertain', { status: 'error', error: 'invalid ownership response' }],
  ] as const)('falls back to full bootstrap when foreground ownership is %s', async (_kind, result) => {
    const { sync } = start()
    await sync.ready
    api.ownership.mockResolvedValueOnce(result)
    api.lifecycle.mock.calls[0]![0]('visibility', { suspensionEvidence: true })
    await flush()
    expect(api.bootstrap).toHaveBeenCalledTimes(2)
    expect(streams).toHaveLength(2)
  })

  it('stops foreground recovery after an ownership authentication rejection', async () => {
    const { sync, callbacks } = start()
    await sync.ready
    api.ownership.mockResolvedValueOnce({ status: 'error', error: 'missing_auth', httpStatus: 401 })

    api.lifecycle.mock.calls[0]![0]('visibility', { suspensionEvidence: true })
    await flush()

    expect(callbacks.onAuthLoss).toHaveBeenCalledOnce()
    expect(api.bootstrap).toHaveBeenCalledOnce()
    expect(streams[0].stop).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(api.bootstrap).toHaveBeenCalledOnce()
  })

  it('recovers a silent stream with a watchdog and cancels its timers on stop', async () => {
    const { sync } = start()
    await sync.ready
    await vi.advanceTimersByTimeAsync(59_000)
    streams[0].input.onFrame?.({ event: 'message', data: '' })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(streams).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(streams).toHaveLength(2)
    expect(api.ownership).toHaveBeenCalledOnce()
    expect(api.bootstrap).toHaveBeenCalledOnce()
    sync.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(streams).toHaveLength(2)
  })

  it('converges memory and BardWiki projection consumers across independent cursors and teardown without writes', async () => {
    const memoryJob: ServerMemoryJob = {
      id: 'memory-a',
      instanceId: 'memory-instance-a',
      chatId: 'chat-a',
      kind: 'summarize',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      updatedAt: '2026-09-08T00:00:00.000Z',
    }
    const bardJob: BardWikiJobSummary = {
      id: 'bard-a',
      instanceId: 'bard-instance-a',
      chatId: 'chat-a',
      receiptId: null,
      kind: 'rebuild_chat',
      status: 'pending',
      errorCode: null,
      errorSummary: null,
      attemptCount: 0,
      maxAttempts: 3,
      progressCurrent: 0,
      progressTotal: 3,
      nextRunAt: '2026-09-08T00:00:00.000Z',
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
    }
    let serverBardResource: BardWikiChatResource = {
      protocolVersion: BARDWIKI_PROTOCOL_VERSION,
      revision: 5,
      chatId: 'chat-a',
      globalSettings: DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
      chatSettings: null,
      effectiveSettings: DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
      confirmationCandidate: null,
      documents: [],
      receipts: [],
      jobs: [bardJob],
    }
    const transport = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(serverBardResource), { headers: { 'content-type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', transport)
    const bardEvents: ServerBardWikiJobEvent[] = []
    const bardSnapshots: ServerBardWikiJobSnapshot[] = []
    const resourceReads: ReturnType<typeof loadBardWikiChatResource>[] = []
    // Exercise the real event bus and scoped resource reader used by the gated
    // workspace's job listeners. This is projection-consumer proof, not a mounted
    // Reader workspace or authoring surface.
    const stopBard = subscribeServerBardWikiJobEvents(
      (event) => {
        bardEvents.push(event)
        if (event.chatId === 'chat-a') resourceReads.push(loadBardWikiChatResource(event.chatId))
      },
      (snapshot) => {
        bardSnapshots.push(snapshot)
        resourceReads.push(loadBardWikiChatResource('chat-a'))
      },
    )
    cleanups.push(stopBard)
    async function settleBardRead(job: BardWikiJobSummary) {
      expect(await Promise.all(resourceReads.splice(0))).toEqual([
        expect.objectContaining({ status: 'ok', chatId: 'chat-a', jobs: [job] }),
      ])
      expect(getBardWikiChatResource('chat-a')?.jobs).toEqual([job])
    }
    function snapshot(
      streamId: string,
      version: number,
      memory: ServerMemoryJob,
      bard: BardWikiJobSummary,
    ): ServerMemoryJobSnapshot {
      return { type: 'memory.snapshot', streamId, version, jobs: [memory], bardWikiJobs: [bard] }
    }
    function memoryEvent(streamId: string, version: number, job: ServerMemoryJob): ServerMemoryEvent {
      const { chatId, ...eventJob } = job
      return { type: 'memory.job', streamId, version, chatId, job: eventJob }
    }
    function bardEvent(streamId: string, version: number, job: BardWikiJobSummary): ServerBardWikiJobEvent {
      const { chatId, createdAt: _createdAt, nextRunAt: _nextRunAt, ...eventJob } = job
      return { type: 'bardwiki.job', streamId, version, chatId, job: eventJob }
    }

    const { sync } = start()
    await sync.ready
    const first = streams[0].input
    first.onMemorySnapshot?.(snapshot('jobs-a', 10, memoryJob, bardJob))
    await settleBardRead(bardJob)
    expect(selectMemoryJobs(get(memoryJobProjectionStore))).toEqual([memoryJob])
    expect(bardSnapshots).toEqual([{ streamId: 'jobs-a', version: 10, jobs: [bardJob] }])

    const runningMemory = { ...memoryJob, status: 'running' as const, attemptCount: 1 }
    const runningBard = { ...bardJob, status: 'running' as const, attemptCount: 1, progressCurrent: 1 }
    serverBardResource = { ...serverBardResource, jobs: [runningBard] }
    first.onMemoryEvent?.(memoryEvent('jobs-a', 11, runningMemory))
    first.onBardWikiEvent?.(bardEvent('jobs-a', 12, runningBard))
    await settleBardRead(runningBard)
    first.onBardWikiEvent?.(bardEvent('jobs-a', 11, bardJob))
    first.onMemoryEvent?.(memoryEvent('jobs-a', 10, memoryJob))
    first.onMemorySnapshot?.(snapshot('jobs-a', 9, memoryJob, bardJob))
    expect(get(memoryJobProjectionStore)).toMatchObject({ streamId: 'jobs-a', version: 11 })
    expect(selectMemoryProgress(get(memoryJobProjectionStore), 'chat-a', true)).toMatchObject({
      activeCount: 1,
      presentedJobs: [runningMemory],
    })
    expect(bardEvents).toEqual([bardEvent('jobs-a', 12, runningBard)])
    expect(bardSnapshots).toHaveLength(1)
    expect(resourceReads).toHaveLength(0)
    expect(api.applied).toBe(5)
    expect(api.known).toBe(5)
    // Operational versions 10–12 neither skip nor create a command revision.
    first.onCommandEvent(command(6))
    await flush()
    expect(api.targeted).toHaveBeenCalledOnce()
    expect(api.applied).toBe(6)
    expect(api.known).toBe(6)

    sync.retry()
    await flush()
    expect(streams[0].stop).toHaveBeenCalledOnce()
    expect(streams[1].input).toMatchObject({ mode: 'reader', sinceRevision: 6 })
    const second = streams[1].input
    const replacementMemory = { ...memoryJob, instanceId: 'memory-instance-b' }
    const replacementBard = { ...bardJob, instanceId: 'bard-instance-b' }
    serverBardResource = { ...serverBardResource, revision: 6, jobs: [replacementBard] }
    second.onMemorySnapshot?.(snapshot('jobs-b', 1, replacementMemory, replacementBard))
    await settleBardRead(replacementBard)
    first.onMemoryEvent?.(memoryEvent('jobs-a', 999, runningMemory))
    first.onBardWikiEvent?.(bardEvent('jobs-a', 999, runningBard))
    first.onMemorySnapshot?.(snapshot('jobs-a', 1000, memoryJob, bardJob))
    expect(get(memoryJobProjectionStore)).toMatchObject({ streamId: 'jobs-b', version: 1 })
    expect(selectMemoryJobs(get(memoryJobProjectionStore))).toEqual([replacementMemory])
    expect(bardSnapshots).toEqual([
      { streamId: 'jobs-a', version: 10, jobs: [bardJob] },
      { streamId: 'jobs-b', version: 1, jobs: [replacementBard] },
    ])
    expect(bardEvents).toHaveLength(1)
    expect(resourceReads).toHaveLength(0)

    const completedMemory = { ...replacementMemory, status: 'completed' as const, attemptCount: 1 }
    const completedBard = { ...replacementBard, status: 'completed' as const, attemptCount: 1, progressCurrent: 3 }
    serverBardResource = { ...serverBardResource, jobs: [completedBard] }
    second.onMemoryEvent?.(memoryEvent('jobs-b', 2, completedMemory))
    second.onBardWikiEvent?.(bardEvent('jobs-b', 3, completedBard))
    await settleBardRead(completedBard)
    expect(selectMemoryJobs(get(memoryJobProjectionStore))).toEqual([completedMemory])
    expect(selectMemoryProgress(get(memoryJobProjectionStore), 'chat-a', true).activeCount).toBe(0)
    expect(bardEvents).toEqual([bardEvent('jobs-a', 12, runningBard), bardEvent('jobs-b', 3, completedBard)])
    expect(api.applied).toBe(6)
    expect(api.known).toBe(6)
    expect(canUseClientWriteAccess()).toBe(false)

    sync.stop()
    second.onMemoryEvent?.(memoryEvent('jobs-b', 4, replacementMemory))
    second.onBardWikiEvent?.(bardEvent('jobs-b', 5, replacementBard))
    second.onMemorySnapshot?.(snapshot('jobs-b', 6, replacementMemory, replacementBard))
    stopBard()
    publishServerBardWikiJobEvent(bardEvent('jobs-b', 7, replacementBard))
    publishServerBardWikiJobSnapshot({ streamId: 'jobs-b', version: 8, jobs: [replacementBard] })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(bardEvents).toHaveLength(2)
    expect(bardSnapshots).toHaveLength(2)
    expect(resourceReads).toHaveLength(0)
    expect(getBardWikiChatResource('chat-a')?.jobs).toEqual([completedBard])
    expect(selectMemoryJobs(get(memoryJobProjectionStore))).toEqual([completedMemory])
    expect(streams).toHaveLength(2)
    expect(streams[1].stop).toHaveBeenCalledOnce()
    expect(api.stopLifecycle).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(api.targeted).toHaveBeenCalledOnce()
    expect(api.full).not.toHaveBeenCalled()
    // Every callback transport must be this authenticated scoped GET: no
    // mutation, provider, rebuild, retry, cancellation or writer registration.
    expect(transport.mock.calls).toEqual(
      Array.from({ length: 4 }, () => [
        '/api/v1/bardwiki/chats/chat-a',
        { method: 'GET', signal: undefined, headers: { 'risu-auth': 'reader-auth' } },
      ]),
    )
  })

  it('bounds backoff and invalid random inputs', () => {
    expect(calculateConnectedReaderReconnectDelayMs(0, () => 0.5)).toBe(1000)
    expect(calculateConnectedReaderReconnectDelayMs(1, () => 0.5)).toBe(2000)
    expect(calculateConnectedReaderReconnectDelayMs(100, () => 1)).toBe(30_000)
    expect(calculateConnectedReaderReconnectDelayMs(NaN, () => NaN)).toBe(1000)
  })
})
