import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import type { SubscribeServerCommandEventsInput } from './events'
import type { ServerResourceRefreshOptions } from './resourceInvalidation'

const api = vi.hoisted(() => ({
  bootstrap: vi.fn(),
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
vi.mock('./bootstrap', () => ({ fetchServerBootstrapReadOnly: api.bootstrap }))
vi.mock('./events', () => ({ subscribeServerCommandEvents: api.subscribe }))
vi.mock('./commands', () => ({
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
import { memoryJobProjectionStore, resetMemoryJobProjectionForTests } from './memoryJobProjection.svelte'
import { subscribeServerBardWikiJobEvents } from './bardWikiJobEvents'
import { charactersResourceState } from './resourceState.svelte'
import { recordObserverRouteIntent, resetObserverRouteIntentForTests } from '../observerRouteIntent'

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
  resetObserverRouteIntentForTests()
  api.applied = 5
  api.known = 5
  streams.length = 0
  resetClientSessionForTests()
  resetMemoryJobProjectionForTests()
  reader()
})
afterEach(() => {
  for (const sync of controllers.splice(0)) sync.stop()
  for (const stop of cleanups.splice(0)) stop()
  resetClientSessionForTests()
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
      recordObserverRouteIntent({
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

  it('fences a held response across a lifecycle reconnect and ignores callbacks from the old stream', async () => {
    const held = deferred<any>()
    api.targeted.mockReturnValueOnce(held.promise)
    const { sync } = start()
    await sync.ready
    streams[0].input.onCommandEvent(command(6))
    await flush()
    const read = api.targeted.mock.calls[0][1]
    api.lifecycle.mock.calls[0][0]('focus')
    await flush()
    expect(streams[1].input.sinceRevision).toBe(5)
    expect(read.isCurrent()).toBe(false)
    held.resolve({ status: 'ok', scope: 'targeted', revision: 6 })
    streams[0].input.onCommandEvent(command(99))
    await flush()
    expect(api.applied).toBe(5)
    expect(api.known).toBe(6)
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
    sync.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(streams).toHaveLength(2)
  })

  it('keeps memory and BardWiki stream versions independent from the command cursor', async () => {
    const bardEvent = vi.fn(),
      bardSnapshot = vi.fn()
    cleanups.push(subscribeServerBardWikiJobEvents(bardEvent, bardSnapshot))
    const { sync } = start()
    await sync.ready
    const first = streams[0].input
    first.onMemorySnapshot?.({ type: 'memory.snapshot', streamId: 'jobs-a', version: 10, jobs: [], bardWikiJobs: [] })
    first.onMemoryEvent?.({
      type: 'memory.job',
      streamId: 'jobs-a',
      version: 11,
      chatId: 'chat-a',
      job: {
        id: 'job-a',
        instanceId: 'instance-a',
        kind: 'summarize',
        status: 'running',
        attemptCount: 1,
        maxAttempts: 3,
      },
    })
    first.onBardWikiEvent?.({ streamId: 'jobs-a', version: 12 } as any)
    first.onBardWikiEvent?.({ streamId: 'jobs-a', version: 11 } as any)
    first.onMemorySnapshot?.({ type: 'memory.snapshot', streamId: 'jobs-a', version: 9, jobs: [], bardWikiJobs: [] })
    expect(get(memoryJobProjectionStore)).toMatchObject({ streamId: 'jobs-a', version: 11 })
    expect(bardEvent).toHaveBeenCalledOnce()
    expect(bardSnapshot).toHaveBeenCalledOnce()
    expect(api.applied).toBe(5)
    expect(api.known).toBe(5)
    sync.retry()
    await flush()
    streams[1].input.onMemorySnapshot?.({
      type: 'memory.snapshot',
      streamId: 'jobs-b',
      version: 1,
      jobs: [],
      bardWikiJobs: [],
    })
    first.onBardWikiEvent?.({ streamId: 'jobs-a', version: 999 } as any)
    expect(get(memoryJobProjectionStore)).toMatchObject({ streamId: 'jobs-b', version: 1 })
    expect(bardSnapshot).toHaveBeenCalledTimes(2)
    expect(bardEvent).toHaveBeenCalledOnce()
    expect(api.targeted).not.toHaveBeenCalled()
  })

  it('bounds backoff and invalid random inputs', () => {
    expect(calculateConnectedReaderReconnectDelayMs(0, () => 0.5)).toBe(1000)
    expect(calculateConnectedReaderReconnectDelayMs(1, () => 0.5)).toBe(2000)
    expect(calculateConnectedReaderReconnectDelayMs(100, () => 1)).toBe(30_000)
    expect(calculateConnectedReaderReconnectDelayMs(NaN, () => NaN)).toBe(1000)
  })
})
