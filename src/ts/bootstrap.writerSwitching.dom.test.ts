import {
  setupBootstrapTests,
  deferred,
  bootstrapMocks,
  runtimeBootstrap,
  runtimeOwnership,
} from './bootstrap.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { loadData, promoteConnectedReader, stopConnectedClientServices } from './bootstrap'
import {
  canUseClientWriteAccess,
  clientSessionStore,
  getClientSessionSnapshot,
  observeClientWriter,
} from './clientSession'
import { loadPlugins, startPluginRuntimeSync } from './plugins/plugins.svelte'
import { alertError, alertRequiredSelect } from './alert'
import { language } from 'src/lang'
import { getActiveWriterSessionId } from './server/activeWriterSession'
import { getStartupChatReadinessEvaluations, getStartupCoordinatorSnapshot } from './startupReadiness'
import { selectedCharID } from './stores.svelte'
import { currentRoute } from './router'
import { getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

const {
  readerApi,
  identityApi,
  bootstrapApi,
  resourceApi,
  commandApi,
  eventApi,
  hydrationApi,
  promptTemplateApi,
  runtimeApi,
  recoveredGenerationApi,
  ownerMutationLifecycleApi,
  pendingMutationApi,
  ownershipApi,
  projectionLifecycleApi,
} = bootstrapMocks

setupBootstrapTests()

describe('explicit connected writer switching', () => {
  async function startReader() {
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ writer: { sessionId: 'foreign-writer', epoch: 1 } }),
    )
    await loadData()
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
    bootstrapApi.fetch.mockResolvedValue(
      runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: getActiveWriterSessionId(), epoch: 2 } }),
    )
  }

  function newerWriter() {
    const writer = { sessionId: 'newer-writer', epoch: 3 }
    bootstrapApi.fetchReadOnly.mockResolvedValue(runtimeBootstrap({ writer, writerEpoch: 3 }))
    observeClientWriter(writer)
    return writer
  }

  it('waits for explicit setup before acquiring an empty server without exclusive tab identity', async () => {
    identityApi.exclusive = false
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({
        initialized: false,
        requestedWriterWasActive: false,
        writerEpoch: 0,
        writer: { sessionId: null, epoch: 0 },
      }),
    )
    bootstrapApi.fetch.mockResolvedValue(runtimeBootstrap({ initialized: false, requestedWriterWasActive: false }))
    const setup = deferred<string>()
    vi.mocked(alertRequiredSelect).mockImplementationOnce(() => setup.promise)
    const loading = loadData()
    await vi.waitFor(() => expect(alertRequiredSelect).toHaveBeenCalledOnce())
    expect(alertRequiredSelect).toHaveBeenCalledWith(
      [language.connectedReaders.setupThisServer],
      language.connectedReaders.setupServerBody,
      language.connectedReaders.setupServerTitle,
      { signal: expect.any(AbortSignal), purpose: 'client-session' },
    )
    expect(bootstrapApi.fetch).not.toHaveBeenCalled()
    expect(commandApi.initialize).not.toHaveBeenCalled()
    expect(readerApi.start).not.toHaveBeenCalled()
    expect(canUseClientWriteAccess()).toBe(false)
    expect(getClientSessionSnapshot().projectionReady).toBe(false)
    setup.resolve('0')
    await loading
    expect(bootstrapApi.fetch).toHaveBeenCalledExactlyOnceWith(null, {
      expectedWriter: { epoch: 0, databaseLineage: 'database-a' },
    })
    expect(commandApi.initialize).toHaveBeenCalledOnce()
    expect(pendingMutationApi.prepare).toHaveBeenCalledOnce()
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'writing',
      projectionReady: true,
      connection: 'live',
    })
  })

  it('abandons a pending empty-server setup decision on pagehide', async () => {
    identityApi.exclusive = false
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ initialized: false, writerEpoch: 0, writer: { sessionId: null, epoch: 0 } }),
    )
    const setup = deferred<string>()
    vi.mocked(alertRequiredSelect).mockImplementationOnce(() => setup.promise)
    const loading = loadData()
    await vi.waitFor(() => expect(alertRequiredSelect).toHaveBeenCalledOnce())
    const signal = vi.mocked(alertRequiredSelect).mock.calls[0]![3]!.signal!
    window.dispatchEvent(new Event('pagehide'))
    expect(signal.aborted).toBe(true)
    setup.resolve('0')
    await loading
    expect(bootstrapApi.fetch).not.toHaveBeenCalled()
    expect(commandApi.initialize).not.toHaveBeenCalled()
    expect(alertError).not.toHaveBeenCalled()
    expect(canUseClientWriteAccess()).toBe(false)
  })

  it('cannot initialize from a late acquisition after setup pagehide', async () => {
    identityApi.exclusive = false
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ initialized: false, writerEpoch: 0, writer: { sessionId: null, epoch: 0 } }),
    )
    const acquisition = deferred<ReturnType<typeof runtimeBootstrap>>()
    bootstrapApi.fetch.mockImplementationOnce(() => acquisition.promise)
    const loading = loadData()
    await vi.waitFor(() => expect(bootstrapApi.fetch).toHaveBeenCalledOnce())
    window.dispatchEvent(new Event('pagehide'))
    acquisition.resolve(runtimeBootstrap({ initialized: false }))
    await loading
    expect(commandApi.initialize).not.toHaveBeenCalled()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    expect(alertError).not.toHaveBeenCalled()
    expect(canUseClientWriteAccess()).toBe(false)
  })

  it('shares one confirmed acquisition/recovery chain and keeps the chosen reader route', async () => {
    await startReader()
    currentRoute.set({ kind: 'character', path: '/character/char-a/chat-a', chaId: 'char-a', chatId: 'chat-a' })
    const held = deferred<{ status: 'ok'; revision: number; scope: 'shell' }>()
    resourceApi.loadInitial.mockImplementationOnce(() => held.promise)
    bootstrapApi.fetch.mockResolvedValueOnce({ status: 'active-writer-connected', error: 'active_writer_connected' })
    const switching = promoteConnectedReader()
    expect(promoteConnectedReader()).toBe(switching)
    await vi.waitFor(() => expect(resourceApi.loadInitial).toHaveBeenCalledTimes(2))
    expect(promoteConnectedReader()).toBe(switching)
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'recovering-writer', projectionReady: true })
    expect(canUseClientWriteAccess()).toBe(false)
    expect(readerApi.start).toHaveBeenCalledTimes(2)
    expect(bootstrapApi.fetch).toHaveBeenNthCalledWith(1, expect.any(AbortSignal), {
      expectedWriter: { epoch: 1, databaseLineage: 'database-a' },
    })
    expect(bootstrapApi.fetch).toHaveBeenNthCalledWith(2, expect.any(AbortSignal), {
      expectedWriter: { epoch: 1, databaseLineage: 'database-a' },
      disconnectExistingWriter: true,
    })
    expect(alertRequiredSelect).toHaveBeenCalledWith(
      [language.writerConnectDisconnectExisting, language.cancel],
      language.writerConnectConflictBody,
      language.writerConnectConflictTitle,
      { signal: expect.any(AbortSignal), purpose: 'client-session' },
    )
    held.resolve({ status: 'ok', revision: 9, scope: 'shell' })
    await expect(switching).resolves.toEqual({ status: 'promoted' })
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'writing',
      connection: 'live',
      writer: { sessionId: getActiveWriterSessionId(), epoch: 2 },
    })
    expect(getStartupCoordinatorSnapshot().capabilities).toMatchObject({ canMutate: true, canGenerate: true })
    expect(get(currentRoute)).toMatchObject({ chaId: 'char-a', chatId: 'chat-a' })
    expect(pendingMutationApi.readOwner).not.toHaveBeenCalled()
    expect(pendingMutationApi.prepare).toHaveBeenCalledOnce()
    expect(pendingMutationApi.flushAcknowledgements).toHaveBeenCalledOnce()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
    expect(eventApi.subscribe).toHaveBeenCalledOnce()
    expect(pendingMutationApi.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      pendingMutationApi.flushAcknowledgements.mock.invocationCallOrder[0]!,
    )
    expect(pendingMutationApi.flushAcknowledgements.mock.invocationCallOrder[0]).toBeLessThan(
      pendingMutationApi.replay.mock.invocationCallOrder[0]!,
    )
    expect(pendingMutationApi.replay.mock.invocationCallOrder[0]).toBeLessThan(
      resourceApi.loadInitial.mock.invocationCallOrder[1]!,
    )
    expect(resourceApi.loadInitial.mock.invocationCallOrder[1]).toBeLessThan(
      eventApi.subscribe.mock.invocationCallOrder[0]!,
    )
  })

  it('settles the restored reader target when selection changes during writer startup hydration', async () => {
    await startReader()
    currentRoute.set({ kind: 'character', path: '/character/char-a/chat-a', chaId: 'char-a', chatId: 'chat-a' })
    const selectedChat = deferred<void>()
    hydrationApi.hydrateActiveChat.mockImplementationOnce(async () => {
      const selectedIndex = get(selectedCharID)
      await selectedChat.promise
      // The real active-chat owner rejects readiness for a chat that stopped
      // being selected while its message request was in flight.
      return get(selectedCharID) === selectedIndex
    })

    const switching = promoteConnectedReader()
    await vi.waitFor(() => expect(hydrationApi.hydrateActiveChat).toHaveBeenCalledOnce())
    expect(get(selectedCharID)).toBe(1)
    expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(false)
    expect(getDatabase().characters[get(selectedCharID)].chaId).toBe('char-b')
    expect(get(currentRoute)).toMatchObject({ chaId: 'char-a', chatId: 'chat-a' })
    expect(runtimeApi.prepareOpenChatGenerationReattach).not.toHaveBeenCalled()

    // Writer recovery restores the persisted B selection before App finishes
    // applying this reader's retained A route.
    selectedCharID.set(0)
    selectedChat.resolve()

    await expect(switching).resolves.toEqual({ status: 'promoted' })
    expect(getStartupCoordinatorSnapshot().capabilities).toMatchObject({ canMutate: true, canGenerate: true })
    expect(getStartupCoordinatorSnapshot().failures.canGenerate).toBeUndefined()
    expect(hydrationApi.hydrateActiveChat).toHaveBeenCalledTimes(2)
    expect(getDatabase().characters[get(selectedCharID)].chaId).toBe('char-a')
    expect(runtimeApi.prepareOpenChatGenerationReattach).toHaveBeenCalledOnce()
    expect(getStartupChatReadinessEvaluations()).toEqual([])
  })

  it('keeps generation gated for a prompt owner changed during writer startup hydration', async () => {
    await startReader()
    withTestDatabaseWrite(() => {
      getDatabase().characters[1].chats[0].generationSettings = { promptPresetId: 'prompt-older' }
    })
    const olderPrompt = deferred<boolean>()
    const newerPrompt = deferred<boolean>()
    promptTemplateApi.ensure
      .mockImplementationOnce(() => olderPrompt.promise)
      .mockImplementationOnce(() => newerPrompt.promise)

    const switching = promoteConnectedReader()
    try {
      await vi.waitFor(() => expect(promptTemplateApi.ensure).toHaveBeenCalledOnce())
      expect(promptTemplateApi.ensure).toHaveBeenLastCalledWith({
        applyProjection: false,
        promptPresetId: 'prompt-older',
        minimumRevision: 5,
      })
      withTestDatabaseWrite(() => {
        getDatabase().characters[1].chats[0].generationSettings = { promptPresetId: 'prompt-newer' }
      })
      olderPrompt.resolve(true)

      await vi.waitFor(() => expect(promptTemplateApi.ensure).toHaveBeenCalledTimes(2))
      expect(promptTemplateApi.ensure).toHaveBeenLastCalledWith({
        applyProjection: false,
        promptPresetId: 'prompt-newer',
        minimumRevision: 5,
      })
      expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(false)
      expect(runtimeApi.prepareOpenChatGenerationReattach).not.toHaveBeenCalled()
      newerPrompt.resolve(true)

      await expect(switching).resolves.toEqual({ status: 'promoted' })
      expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true)
      expect(runtimeApi.prepareOpenChatGenerationReattach).toHaveBeenCalledOnce()
    } finally {
      olderPrompt.resolve(true)
      newerPrompt.resolve(true)
      await switching
    }
  })

  it('keeps a failed unchanged writer startup target gated without automatically retrying it', async () => {
    await startReader()
    hydrationApi.hydrateActiveChat.mockResolvedValueOnce(false)

    await expect(promoteConnectedReader()).resolves.toEqual({ status: 'promoted' })

    expect(getStartupCoordinatorSnapshot()).toMatchObject({
      capabilities: { canMutate: true, canGenerate: false },
      failures: {
        canGenerate: expect.objectContaining({ failureCode: 'selected-chat-hydration-failed' }),
      },
    })
    expect(hydrationApi.hydrateActiveChat).toHaveBeenCalledOnce()
    expect(runtimeApi.prepareOpenChatGenerationReattach).not.toHaveBeenCalled()
  })

  it('does not retry a changed startup target after writer ownership is superseded', async () => {
    await startReader()
    const selectedChat = deferred<boolean>()
    hydrationApi.hydrateActiveChat.mockImplementationOnce(() => selectedChat.promise)

    const switching = promoteConnectedReader()
    await vi.waitFor(() => expect(hydrationApi.hydrateActiveChat).toHaveBeenCalledOnce())
    const pendingEvaluations = getStartupChatReadinessEvaluations()
    expect(pendingEvaluations).toHaveLength(1)
    expect(pendingEvaluations[0]).toMatchObject({
      sessionGeneration: getClientSessionSnapshot().generation,
      phase: 'chat-and-prompt',
    })
    selectedCharID.set(0)
    newerWriter()
    selectedChat.resolve(false)

    await expect(switching).resolves.toEqual({ status: 'superseded' })
    expect(getStartupCoordinatorSnapshot().capabilities).toMatchObject({ canMutate: false, canGenerate: false })
    expect(hydrationApi.hydrateActiveChat).toHaveBeenCalledOnce()
    expect(runtimeApi.prepareOpenChatGenerationReattach).not.toHaveBeenCalled()
    expect(getStartupChatReadinessEvaluations()).toEqual([])
  })

  it('cancels without takeover, replay, or blocking a fresh reader subscription', async () => {
    await startReader()
    bootstrapApi.fetch.mockResolvedValueOnce({ status: 'active-writer-connected', error: 'active_writer_connected' })
    vi.mocked(alertRequiredSelect).mockResolvedValueOnce('1')
    await expect(promoteConnectedReader()).resolves.toEqual({ status: 'cancelled' })
    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledTimes(3))
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    expect(pendingMutationApi.replay).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      projectionReady: true,
      connection: 'live',
    })
    expect(canUseClientWriteAccess()).toBe(false)
  })

  it('aborts its own confirmation when a newer writer wins and ignores a late confirm', async () => {
    await startReader()
    bootstrapApi.fetch.mockResolvedValueOnce({ status: 'active-writer-connected', error: 'active_writer_connected' })
    const selection = deferred<string>()
    vi.mocked(alertRequiredSelect).mockImplementationOnce(() => selection.promise)
    const switching = promoteConnectedReader()
    await vi.waitFor(() => expect(alertRequiredSelect).toHaveBeenCalledOnce())
    const signal = vi.mocked(alertRequiredSelect).mock.calls[0]![3]!.signal!
    newerWriter()
    expect(signal.aborted).toBe(true)
    selection.resolve('0')
    await expect(switching).resolves.toEqual({ status: 'superseded' })
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('live'))
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
  })

  it('rejects a held acquisition success after a later writer without applying its bootstrap', async () => {
    await startReader()
    const acquisition = deferred<ReturnType<typeof runtimeBootstrap>>()
    bootstrapApi.fetch.mockImplementationOnce(() => acquisition.promise)
    const switching = promoteConnectedReader()
    await vi.waitFor(() => expect(bootstrapApi.fetch).toHaveBeenCalledOnce())
    const writer = newerWriter()
    acquisition.resolve(
      runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: getActiveWriterSessionId(), epoch: 2 } }),
    )
    await expect(switching).resolves.toEqual({ status: 'superseded' })
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    expect(eventApi.subscribe).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'reading', writer })
  })

  it.each(['prepare', 'receipt', 'replay', 'hydration', 'events'] as const)(
    'does not continue writer work after supersession during %s',
    async (phase) => {
      await startReader()
      const held = deferred<unknown>()
      const step =
        phase === 'prepare'
          ? pendingMutationApi.prepare
          : phase === 'receipt'
            ? pendingMutationApi.flushAcknowledgements
            : phase === 'replay'
              ? pendingMutationApi.replay
              : phase === 'hydration'
                ? resourceApi.loadInitial
                : eventApi.subscribe
      const oldCount = step.mock.calls.length
      step.mockImplementationOnce(() => held.promise)
      const switching = promoteConnectedReader()
      await vi.waitFor(() => expect(step).toHaveBeenCalledTimes(oldCount + 1))
      expect(canUseClientWriteAccess()).toBe(false)
      newerWriter()
      held.resolve(
        phase === 'prepare'
          ? { discarded: 0 }
          : phase === 'receipt'
            ? undefined
            : phase === 'replay'
              ? { attempted: 0, discarded: 0, retained: 0, succeeded: 0 }
              : phase === 'hydration'
                ? { status: 'ok', revision: 7, scope: 'shell' }
                : { status: 'ok', unsubscribe: eventApi.unsubscribe },
      )
      await expect(switching).resolves.toEqual({ status: 'superseded' })
      expect(canUseClientWriteAccess()).toBe(false)
      expect(loadPlugins).not.toHaveBeenCalled()
      expect(recoveredGenerationApi.reconcilePendingRecoveredGenerationEffects).not.toHaveBeenCalled()
      if (phase === 'prepare') expect(pendingMutationApi.flushAcknowledgements).not.toHaveBeenCalled()
      if (phase === 'prepare' || phase === 'receipt') expect(pendingMutationApi.replay).not.toHaveBeenCalled()
      if (phase !== 'events') expect(eventApi.subscribe).not.toHaveBeenCalled()
      else expect(eventApi.unsubscribe).toHaveBeenCalled()
      await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('live'))
      expect(getClientSessionSnapshot().lifecycle).toBe('reading')
    },
  )

  it.each(['retained', 'unreadable'] as const)(
    'preserves %s recovery work while returning to a usable reader',
    async (reason) => {
      await startReader()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (reason === 'retained')
        pendingMutationApi.replay.mockResolvedValueOnce({ attempted: 1, discarded: 0, retained: 1, succeeded: 0 })
      else pendingMutationApi.count.mockResolvedValueOnce(null)
      bootstrapApi.fetchReadOnly.mockResolvedValue(
        runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: getActiveWriterSessionId(), epoch: 2 } }),
      )
      await expect(promoteConnectedReader()).resolves.toEqual({ status: 'failed', reason: 'retained-work' })
      await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledTimes(3))
      expect(getClientSessionSnapshot()).toMatchObject({
        lifecycle: 'reading',
        projectionReady: true,
        connection: 'live',
      })
      expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
      expect(pendingMutationApi.prepare).toHaveBeenCalledOnce()
      expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
      expect(ownershipApi.discard).not.toHaveBeenCalled()
      expect(loadPlugins).not.toHaveBeenCalled()
    },
  )

  it.each(['prepare', 'receipt', 'replay', 'hydration', 'events'] as const)(
    'keeps failed promotion during %s gated and permits a successful explicit retry',
    async (phase) => {
      await startReader()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      // Acquisition succeeded before this failure; subsequent discovery must
      // report that durable owner, including when the client returns to reading.
      bootstrapApi.fetchReadOnly.mockResolvedValue(
        runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: getActiveWriterSessionId(), epoch: 2 } }),
      )
      const step =
        phase === 'prepare'
          ? pendingMutationApi.prepare
          : phase === 'receipt'
            ? pendingMutationApi.flushAcknowledgements
            : phase === 'replay'
              ? pendingMutationApi.replay
              : phase === 'hydration'
                ? resourceApi.loadInitial
                : eventApi.subscribe
      step.mockRejectedValueOnce(new Error(`Injected ${phase} failure`))
      const lifecycles: string[] = []
      const stop = clientSessionStore.subscribe((state) => lifecycles.push(state.lifecycle))
      try {
        await expect(promoteConnectedReader()).resolves.toEqual({ status: 'failed', reason: 'unavailable' })
        expect(lifecycles).not.toContain('writing')
        expect(canUseClientWriteAccess()).toBe(false)
        expect(loadPlugins).not.toHaveBeenCalled()
        await vi.waitFor(() =>
          expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'reading', connection: 'live' }),
        )
        await expect(promoteConnectedReader()).resolves.toEqual({ status: 'promoted' })
        expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'writing', connection: 'live' })
        expect(getStartupCoordinatorSnapshot().capabilities).toMatchObject({ canMutate: true, canGenerate: true })
      } finally {
        stop()
      }
    },
  )

  it.each(['replay-unavailable', 'unavailable'] as const)(
    'requires a fresh writer connection when the promotion subscription is %s',
    async (status) => {
      await startReader()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const refresh = deferred<{ status: 'ok'; revision: number }>()
      resourceApi.forceRefresh.mockImplementationOnce(() => refresh.promise)
      resourceApi.forceReplacement.mockImplementationOnce(() => refresh.promise)
      let connectionAfterInitialClose: string | undefined
      eventApi.subscribe.mockImplementationOnce(async (input) => {
        if (status === 'replay-unavailable') {
          input.onClose?.()
          connectionAfterInitialClose = getClientSessionSnapshot().connection
          return { status, currentRevision: 12 }
        }
        return { status }
      })
      const acquired = runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: getActiveWriterSessionId(), epoch: 2 } })
      bootstrapApi.fetch.mockImplementationOnce(async () => {
        bootstrapApi.fetchReadOnly.mockResolvedValue(acquired)
        bootstrapApi.fetchOwnership.mockResolvedValue(
          runtimeOwnership({ writer: { sessionId: getActiveWriterSessionId(), epoch: 2 } }),
        )
        return acquired
      })
      const lifecycles: string[] = []
      const stop = clientSessionStore.subscribe((state) => lifecycles.push(state.lifecycle))
      try {
        const switching = promoteConnectedReader()
        if (status === 'replay-unavailable') {
          await vi.waitFor(() => expect(resourceApi.forceRefresh).toHaveBeenCalled())
          refresh.resolve({ status: 'ok', revision: 12 })
        }
        await expect(switching).resolves.toEqual({
          status: 'failed',
          reason: status === 'replay-unavailable' ? 'interrupted' : 'unavailable',
        })
        expect(lifecycles).not.toContain('writing')
        expect(canUseClientWriteAccess()).toBe(false)
        expect(loadPlugins).not.toHaveBeenCalled()
        if (status === 'replay-unavailable') expect(connectionAfterInitialClose).toBe('connecting')
        await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('live'), { timeout: 5_000 })
        expect(getClientSessionSnapshot().lifecycle).toBe(status === 'replay-unavailable' ? 'writing' : 'reading')
        expect(eventApi.subscribe).toHaveBeenCalledTimes(status === 'replay-unavailable' ? 2 : 1)
      } finally {
        refresh.resolve({ status: 'ok', revision: 12 })
        stop()
      }
    },
  )

  it('does not automatically reacquire after the conditional server check loses a race', async () => {
    await startReader()
    bootstrapApi.fetch.mockResolvedValueOnce({ status: 'error', error: 'active_writer_changed', httpStatus: 409 })
    await expect(promoteConnectedReader()).resolves.toEqual({ status: 'failed', reason: 'unavailable' })
    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledTimes(3))
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
  })

  it('requires fresh explicit action after an interrupted confirmation', async () => {
    await startReader()
    bootstrapApi.fetch.mockResolvedValueOnce({ status: 'active-writer-connected', error: 'active_writer_connected' })
    const selection = deferred<string>()
    vi.mocked(alertRequiredSelect).mockImplementationOnce(() => selection.promise)
    const switching = promoteConnectedReader()
    await vi.waitFor(() => expect(alertRequiredSelect).toHaveBeenCalledOnce())
    window.dispatchEvent(new Event('offline'))
    selection.resolve('0')
    await expect(switching).resolves.toEqual({ status: 'failed', reason: 'interrupted' })
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('live'))
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
  })

  it('releases a pending explicit switch after pagehide and refreshes the reader on pageshow', async () => {
    await startReader()
    let acquisitionSignal: AbortSignal | undefined
    bootstrapApi.fetch.mockImplementationOnce(
      (signal: AbortSignal) =>
        new Promise((resolve) => {
          acquisitionSignal = signal
          signal.addEventListener('abort', () => resolve({ status: 'unavailable' }), { once: true })
        }),
    )

    const switching = promoteConnectedReader()
    await vi.waitFor(() => expect(acquisitionSignal).toBeInstanceOf(AbortSignal))
    const readsBeforePageHide = bootstrapApi.fetchReadOnly.mock.calls.length
    window.dispatchEvent(new Event('pagehide'))

    await expect(switching).resolves.toEqual({ status: 'failed', reason: 'interrupted' })
    expect(acquisitionSignal?.aborted).toBe(true)
    expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledTimes(readsBeforePageHide)
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))
    await vi.waitFor(() => expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledTimes(readsBeforePageHide + 1))
    await vi.waitFor(() =>
      expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'reading', connection: 'live' }),
    )
  })

  it('cancels reader connection setup when a pending explicit switch is hidden', async () => {
    await startReader()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let promotionSignal: AbortSignal | undefined
    let settleReady!: () => void
    const stop = vi.fn(() => settleReady())
    readerApi.start.mockImplementationOnce((options: { signal?: AbortSignal }) => {
      promotionSignal = options.signal
      const ready = new Promise<void>((resolve) => {
        settleReady = resolve
      })
      options.signal?.addEventListener('abort', stop, { once: true })
      return { stop, retry: readerApi.retry, ready }
    })
    bootstrapApi.fetchReadOnly.mockImplementation(async (signal?: AbortSignal | null) =>
      signal?.aborted
        ? { status: 'unavailable' }
        : runtimeBootstrap({ writer: { sessionId: 'foreign-writer', epoch: 1 } }),
    )

    const switching = promoteConnectedReader()
    await vi.waitFor(() => expect(promotionSignal).toBeInstanceOf(AbortSignal))
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    await expect(switching).resolves.toEqual({ status: 'failed', reason: 'interrupted' })
    expect(promotionSignal?.aborted).toBe(true)
    expect(stop).toHaveBeenCalled()
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')

    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('live'))
  })

  it('starts fresh writer recovery while retired promotion startup is still unresolved', async () => {
    await startReader()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const retiredPlugins = deferred<void>()
    vi.mocked(loadPlugins).mockImplementationOnce(() => retiredPlugins.promise)

    const retiredSwitch = promoteConnectedReader()
    await vi.waitFor(() => expect(loadPlugins).toHaveBeenCalledOnce())
    expect(getClientSessionSnapshot().lifecycle).toBe('writing')
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await expect(retiredSwitch).resolves.toEqual({ status: 'failed', reason: 'interrupted' })

    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() =>
      expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'writing', connection: 'live' }),
    )
    expect(loadPlugins).toHaveBeenCalledTimes(2)
    expect(getStartupCoordinatorSnapshot().capabilities).toMatchObject({ canMutate: true, canGenerate: true })

    retiredPlugins.resolve()
    await Promise.resolve()
    expect(loadPlugins).toHaveBeenCalledTimes(2)
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'writing', connection: 'live' })
  })

  it('replaces cancelled writer recovery before durable preparation settles and adopts its event stream', async () => {
    await loadData()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const retiredPreparation = deferred<{ discarded: number }>()
    const preparationsBeforeRecovery = pendingMutationApi.prepare.mock.calls.length
    const replaysBeforeRecovery = pendingMutationApi.replay.mock.calls.length
    const subscriptionsBeforeRecovery = eventApi.subscriptions.length
    pendingMutationApi.prepare.mockImplementationOnce(() => retiredPreparation.promise)
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

    window.dispatchEvent(new Event('offline'))
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(pendingMutationApi.prepare).toHaveBeenCalledTimes(preparationsBeforeRecovery + 1))

    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))

    await vi.waitFor(() => expect(pendingMutationApi.prepare).toHaveBeenCalledTimes(preparationsBeforeRecovery + 2))
    await vi.waitFor(() =>
      expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'writing', connection: 'live' }),
    )
    expect(pendingMutationApi.replay).toHaveBeenCalledTimes(replaysBeforeRecovery + 1)
    expect(eventApi.subscriptions).toHaveLength(subscriptionsBeforeRecovery + 1)
    expect(getStartupCoordinatorSnapshot().capabilities.canMutate).toBe(true)

    const activeSubscription = eventApi.subscriptions.at(-1)!
    activeSubscription.onCommandEvent({
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'display',
    })
    await vi.waitFor(() => expect(resourceApi.refreshInvalidated).toHaveBeenCalled())

    const alertsBeforeRetiredCompletion = vi.mocked(alertError).mock.calls.length
    retiredPreparation.resolve({ discarded: 1 })
    await Promise.resolve()
    expect(alertError).toHaveBeenCalledTimes(alertsBeforeRetiredCompletion)
    expect(pendingMutationApi.replay).toHaveBeenCalledTimes(replaysBeforeRecovery + 1)
    expect(eventApi.subscriptions).toHaveLength(subscriptionsBeforeRecovery + 1)
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'writing', connection: 'live' })
  })

  it('clears a newly discovered lineage without claiming its writer', async () => {
    await startReader()
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({
        databaseLineage: 'database-b',
        writerEpoch: 0,
        writer: { sessionId: 'replacement-writer', epoch: 0 },
      }),
    )
    await expect(promoteConnectedReader()).resolves.toEqual({ status: 'superseded' })
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('live'))
    expect(projectionLifecycleApi.discard).toHaveBeenCalledWith('lineage-change')
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'reading', databaseLineage: 'database-b' })
    expect(bootstrapApi.fetch).not.toHaveBeenCalled()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
  })

  it('does not let an older held result demote a later successful explicit switch', async () => {
    await startReader()
    const oldAcquisition = deferred<ReturnType<typeof runtimeBootstrap>>()
    bootstrapApi.fetch.mockImplementationOnce(() => oldAcquisition.promise)
    const oldSwitch = promoteConnectedReader()
    await vi.waitFor(() => expect(bootstrapApi.fetch).toHaveBeenCalledOnce())
    newerWriter()
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('live'))
    bootstrapApi.fetch.mockResolvedValue(
      runtimeBootstrap({
        writerEpoch: 4,
        writer: { sessionId: getActiveWriterSessionId(), epoch: 4 },
      }),
    )
    const newSwitch = promoteConnectedReader()
    expect(newSwitch).not.toBe(oldSwitch)
    await expect(newSwitch).resolves.toEqual({ status: 'promoted' })
    const generation = getClientSessionSnapshot().generation
    oldAcquisition.resolve(
      runtimeBootstrap({
        writerEpoch: 2,
        writer: { sessionId: getActiveWriterSessionId(), epoch: 2 },
      }),
    )
    await expect(oldSwitch).resolves.toEqual({ status: 'superseded' })
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'writing',
      generation,
      writer: { sessionId: getActiveWriterSessionId(), epoch: 4 },
    })
    expect(canUseClientWriteAccess()).toBe(true)
    expect(pendingMutationApi.prepare).toHaveBeenCalledOnce()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
  })

  it('does not publish resources from a stale ownership discovery after demotion', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadData()
    const writer = { sessionId: 'newer-writer', epoch: 3 }
    bootstrapApi.fetchReadOnly
      .mockResolvedValueOnce(runtimeBootstrap())
      .mockResolvedValue(runtimeBootstrap({ writer, writerEpoch: 3 }))
    eventApi.subscriptions[0]!.onWriterEvent!(writer)
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('interrupted'))
    expect(resourceApi.readAll).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledOnce(), { timeout: 3000 })
    expect(resourceApi.readAll).toHaveBeenCalledOnce()
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'reading', connection: 'live', writer })
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
  })

  it('fences deferred services when teardown follows completed writer recovery', async () => {
    await startReader()
    const plugins = deferred<void>()
    vi.mocked(loadPlugins).mockImplementationOnce(() => plugins.promise)
    const switching = promoteConnectedReader()
    await vi.waitFor(() => expect(loadPlugins).toHaveBeenCalledOnce())
    expect(getClientSessionSnapshot().lifecycle).toBe('writing')
    const ownerStops = ownerMutationLifecycleApi.stop.mock.calls.length
    stopConnectedClientServices()
    expect(canUseClientWriteAccess()).toBe(false)
    expect(ownerMutationLifecycleApi.stop.mock.calls.length).toBeGreaterThan(ownerStops)
    plugins.resolve()
    await expect(switching).resolves.toEqual({ status: 'superseded' })
    expect(startPluginRuntimeSync).not.toHaveBeenCalled()
    expect(recoveredGenerationApi.reconcilePendingRecoveredGenerationEffects).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
  })

  it('tears down a held operation without allowing it to acquire afterward', async () => {
    await startReader()
    const discovery = deferred<ReturnType<typeof runtimeBootstrap>>()
    bootstrapApi.fetchReadOnly.mockImplementationOnce(() => discovery.promise)
    const switching = promoteConnectedReader()
    await vi.waitFor(() => expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledTimes(2))
    stopConnectedClientServices()
    discovery.resolve(runtimeBootstrap())
    await expect(switching).resolves.toEqual({ status: 'superseded' })
    expect(bootstrapApi.fetch).not.toHaveBeenCalled()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
  })
})
