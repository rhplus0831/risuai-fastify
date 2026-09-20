import { setupBootstrapTests, bootstrapMocks, runtimeBootstrap, runtimeOwnership } from './bootstrap.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import {
  loadData,
  stopDeferredStartupRuntimes,
  stopConnectedClientServices,
  stopServerResourceEvents,
} from './bootstrap'
import { getClientSessionSnapshot } from './clientSession'
import { loadPlugins } from './plugins/plugins.svelte'
import { alertRequiredSelect } from './alert'
import {
  clearAppliedServerResourceRevision,
  clearCachedServerCommandRevision,
  peekAppliedServerResourceRevision,
} from './server/commands'
import { getActiveWriterSessionId } from './server/activeWriterSession'
import { backgroundReady, getStartupCoordinatorSnapshot } from './startupReadiness'
import { selectedCharID } from './stores.svelte'

const {
  readerApi,
  autoWriterApi,
  bootstrapApi,
  resourceApi,
  eventApi,
  hydrationApi,
  lorebookApi,
  recoveredGenerationApi,
  pendingMutationApi,
  projectionLifecycleApi,
} = bootstrapMocks

setupBootstrapTests()

describe('API-backed client bootstrap', () => {
  it.each([true, false])('foreground reader acquisition respects enabled=%s', async (enabled) => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ writer: { sessionId: 'foreign-writer', epoch: 1 } }),
    )
    await loadData()
    autoWriterApi.enabled.mockResolvedValue(enabled)
    bootstrapApi.fetch.mockResolvedValue(
      runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: getActiveWriterSessionId(), epoch: 2 } }),
    )
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(autoWriterApi.enabled).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(getClientSessionSnapshot().lifecycle).toBe(enabled ? 'writing' : 'reading'))
    expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledTimes(enabled ? 2 : 1)
    if (enabled) {
      expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
      expect(bootstrapApi.fetch.mock.calls[0][1]).not.toHaveProperty('disconnectExistingWriter')
      expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
    } else expect(bootstrapApi.fetch).not.toHaveBeenCalled()
  })

  it.each([true, false])('resuming former writer respects automatic acquisition=%s', async (enabled) => {
    await loadData()
    autoWriterApi.enabled.mockResolvedValue(enabled)
    bootstrapApi.fetchOwnership.mockResolvedValue(
      runtimeOwnership({ writer: { sessionId: 'foreign-writer', epoch: 2 } }),
    )
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: 'foreign-writer', epoch: 2 } }),
    )
    bootstrapApi.fetch.mockResolvedValue(
      runtimeBootstrap({ writerEpoch: 3, writer: { sessionId: getActiveWriterSessionId(), epoch: 3 } }),
    )
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))
    await vi.waitFor(() => expect(autoWriterApi.enabled).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(getClientSessionSnapshot().lifecycle).toBe(enabled ? 'writing' : 'reading'))
    expect(bootstrapApi.fetch).toHaveBeenCalledTimes(enabled ? 2 : 1)
    if (enabled)
      expect(bootstrapApi.fetch.mock.calls[1][1]).toEqual({
        expectedWriter: { epoch: 2, databaseLineage: 'database-a' },
      })
  })

  it('automatically returning readers never disconnect a connected writer', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ writer: { sessionId: 'foreign-writer', epoch: 1 } }),
    )
    await loadData()
    autoWriterApi.enabled.mockResolvedValue(true)
    bootstrapApi.fetch.mockResolvedValue({ status: 'active-writer-connected', error: 'active_writer_connected' })
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(bootstrapApi.fetch).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(getClientSessionSnapshot().lifecycle).toBe('reading'))
    expect(bootstrapApi.fetch.mock.calls[0][1]).not.toHaveProperty('disconnectExistingWriter')
    expect(alertRequiredSelect).not.toHaveBeenCalled()
    expect(pendingMutationApi.replay).not.toHaveBeenCalled()
  })

  it('keeps retained pending intent in hidden writer recovery until ownership is revalidated', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    pendingMutationApi.replay.mockResolvedValue({ attempted: 1, discarded: 0, retained: 1, succeeded: 0 })
    await loadData()
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'recovering-writer',
      connection: 'interrupted',
      projectionReady: false,
    })
    expect(getStartupCoordinatorSnapshot().capabilities.canMutate).toBe(false)
    expect(getStartupCoordinatorSnapshot().capabilities.canRenderShell).toBe(false)
    expect(readerApi.start).not.toHaveBeenCalled()
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
    expect(resourceApi.loadInitial).not.toHaveBeenCalled()
    expect(resourceApi.readAll).not.toHaveBeenCalled()
    expect(loadPlugins).not.toHaveBeenCalled()
  })

  it('passively becomes a reader after a foreign writer frame and never asks for the legacy offline choice', async () => {
    await loadData()
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: 'new-writer', epoch: 2 } }),
    )
    eventApi.subscriptions[0]!.onWriterEvent!({ sessionId: 'new-writer', epoch: 2 })
    expect(getStartupCoordinatorSnapshot().capabilities.canMutate).toBe(false)
    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledOnce())
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      writer: { sessionId: 'new-writer', epoch: 2 },
    })
    expect(eventApi.unsubscribe).toHaveBeenCalledOnce()
    expect(alertRequiredSelect).not.toHaveBeenCalled()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
  })

  it('retries a failed demotion read without acquiring, replaying, or claiming a live connection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadData()
    bootstrapApi.fetchReadOnly
      .mockResolvedValueOnce({ status: 'error', error: 'temporary network failure' })
      .mockResolvedValue(runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: 'new-writer', epoch: 2 } }))
    eventApi.subscriptions[0]!.onWriterEvent!({ sessionId: 'new-writer', epoch: 2 })
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('interrupted'))
    expect(readerApi.start).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledOnce(), { timeout: 3000 })
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'reading', connection: 'live' })
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(pendingMutationApi.replay).toHaveBeenCalledOnce()
  })

  it.each(['success', 'failure'] as const)(
    'supersedes an aborted reader refresh before its late %s',
    async (lateResult) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await loadData()
      let heldSignal: AbortSignal | undefined
      let releaseHeld!: (value: ReturnType<typeof runtimeBootstrap> | { status: 'error'; error: string }) => void
      bootstrapApi.fetchReadOnly.mockImplementationOnce(
        (signal: AbortSignal) =>
          new Promise((resolve) => {
            heldSignal = signal
            releaseHeld = resolve
          }),
      )
      bootstrapApi.fetchReadOnly.mockResolvedValue(
        runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: 'new-writer', epoch: 2 } }),
      )
      const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)

      eventApi.subscriptions[0]!.onWriterEvent!({ sessionId: 'new-writer', epoch: 2 })
      await vi.waitFor(() => expect(heldSignal).toBeInstanceOf(AbortSignal))
      online.mockReturnValue(false)
      window.dispatchEvent(new Event('offline'))
      expect(heldSignal?.aborted).toBe(true)
      online.mockReturnValue(true)
      window.dispatchEvent(new Event('online'))

      await vi.waitFor(() => expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledTimes(3))
      await vi.waitFor(() =>
        expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'reading', connection: 'live' }),
      )
      const replacement = getClientSessionSnapshot()
      releaseHeld(
        lateResult === 'success'
          ? runtimeBootstrap({ writerEpoch: 99, writer: { sessionId: 'obsolete-writer', epoch: 99 } })
          : { status: 'error', error: 'late aborted refresh' },
      )
      await Promise.resolve()
      expect(getClientSessionSnapshot()).toEqual(replacement)
      expect(warn).not.toHaveBeenCalledWith('Reader refresh failed:', expect.anything())
    },
  )

  it('revokes writer dispatch while offline and reuses an unchanged writer projection after revalidation', async () => {
    await loadData()
    bootstrapApi.fetch.mockResolvedValue(
      runtimeBootstrap({ revision: 5, writer: { sessionId: getActiveWriterSessionId(), epoch: 1 } }),
    )
    const selectedBeforeRecovery = get(selectedCharID)
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'recovering-writer', connection: 'interrupted' })
    expect(getStartupCoordinatorSnapshot().capabilities.canMutate).toBe(false)
    expect(eventApi.unsubscribe).toHaveBeenCalledOnce()
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(eventApi.subscriptions).toHaveLength(2))
    await vi.waitFor(() => expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true))
    expect(getClientSessionSnapshot().lifecycle).toBe('writing')
    expect(bootstrapApi.fetch).toHaveBeenLastCalledWith(expect.any(AbortSignal), {
      expectedWriter: { epoch: 1, databaseLineage: 'database-a' },
    })
    expect(resourceApi.loadInitial).toHaveBeenCalledOnce()
    expect(hydrationApi.resetChatHydration).toHaveBeenCalledOnce()
    expect(lorebookApi.resetLorebookHydration).toHaveBeenCalledOnce()
    expect(get(selectedCharID)).toBe(selectedBeforeRecovery)
    expect(readerApi.start).not.toHaveBeenCalled()
  })

  it('falls back to conditional full bootstrap when the writer ownership probe is uncertain', async () => {
    await loadData()
    bootstrapApi.fetchOwnership.mockResolvedValue({ status: 'error', error: 'invalid ownership response' })
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

    window.dispatchEvent(new Event('offline'))
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))

    await vi.waitFor(() => expect(bootstrapApi.fetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(getClientSessionSnapshot().lifecycle).toBe('writing'))
    expect(bootstrapApi.fetch).toHaveBeenLastCalledWith(expect.any(AbortSignal), {
      expectedWriter: { epoch: 1, databaseLineage: 'database-a' },
    })
    expect(bootstrapApi.fetchOwnership).toHaveBeenCalledOnce()
  })

  it('keeps writer recovery after an inconclusive conditional bootstrap failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadData()
    bootstrapApi.fetchOwnership.mockResolvedValue({ status: 'error', error: 'temporary ownership failure' })
    bootstrapApi.fetch.mockResolvedValue({ status: 'error', error: 'temporary bootstrap failure' })
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

    window.dispatchEvent(new Event('offline'))
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))

    await vi.waitFor(() => expect(bootstrapApi.fetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(getClientSessionSnapshot()).toMatchObject({
        lifecycle: 'recovering-writer',
        connection: 'interrupted',
      }),
    )
    expect(readerApi.start).not.toHaveBeenCalled()
    expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledOnce()
  })

  it('aborts a suspended writer recovery and resumes it on pageshow', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadData()
    let suspendedSignal: AbortSignal | undefined
    bootstrapApi.fetchOwnership
      .mockImplementationOnce(
        (signal: AbortSignal) =>
          new Promise((resolve) => {
            suspendedSignal = signal
            signal.addEventListener('abort', () => resolve({ status: 'error', error: 'suspended ownership request' }), {
              once: true,
            })
          }),
      )
      .mockResolvedValue(runtimeOwnership())
    bootstrapApi.fetch.mockImplementation(async (signal?: AbortSignal | null) =>
      signal?.aborted ? { status: 'unavailable' } : runtimeBootstrap(),
    )
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

    window.dispatchEvent(new Event('offline'))
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(suspendedSignal).toBeInstanceOf(AbortSignal))

    window.dispatchEvent(new Event('pagehide'))
    await vi.waitFor(() => expect(suspendedSignal?.aborted).toBe(true))
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('interrupted'))
    await Promise.resolve()
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))

    await vi.waitFor(() => expect(bootstrapApi.fetchOwnership).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(bootstrapApi.fetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(getClientSessionSnapshot().lifecycle).toBe('writing'))
    expect(readerApi.start).not.toHaveBeenCalled()
  })

  it('supersedes aborted writer hydration before a pageshow recovery completes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadData()
    let hydrationSignal: AbortSignal | undefined
    let releaseHydration!: (value: { status: 'ok'; revision: number; scope: 'shell' }) => void
    resourceApi.loadInitial.mockImplementationOnce(
      (options: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          hydrationSignal = options.signal
          releaseHydration = resolve
        }),
    )
    bootstrapApi.fetch.mockResolvedValue(
      runtimeBootstrap({ revision: 6, writer: { sessionId: getActiveWriterSessionId(), epoch: 1 } }),
    )
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

    window.dispatchEvent(new Event('offline'))
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(hydrationSignal).toBeInstanceOf(AbortSignal))

    window.dispatchEvent(new Event('pagehide'))
    await vi.waitFor(() => expect(hydrationSignal?.aborted).toBe(true))
    await vi.waitFor(() => expect(getClientSessionSnapshot().connection).toBe('interrupted'))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))

    await vi.waitFor(() => expect(resourceApi.loadInitial).toHaveBeenCalledTimes(3))
    await vi.waitFor(() =>
      expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'writing', connection: 'live' }),
    )
    const recoveredGeneration = getClientSessionSnapshot().generation
    releaseHydration({ status: 'ok', revision: 6, scope: 'shell' })
    await Promise.resolve()
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'writing',
      connection: 'live',
      generation: recoveredGeneration,
    })
  })

  it('tears down authenticated state when the writer ownership probe is rejected', async () => {
    await loadData()
    bootstrapApi.fetchOwnership.mockResolvedValue({ status: 'error', error: 'missing_auth', httpStatus: 401 })
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

    window.dispatchEvent(new Event('offline'))
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))

    await vi.waitFor(() => expect(projectionLifecycleApi.discard).toHaveBeenCalledExactlyOnceWith('auth-loss'))
    expect(bootstrapApi.fetchOwnership).toHaveBeenCalledOnce()
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
  })

  it('rehydrates an established writer when reconnect bootstrap has a newer revision', async () => {
    await loadData()
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ revision: 6, writer: { sessionId: getActiveWriterSessionId(), epoch: 1 } }),
    )
    bootstrapApi.fetch.mockResolvedValue(
      runtimeBootstrap({ revision: 6, writer: { sessionId: getActiveWriterSessionId(), epoch: 1 } }),
    )
    resourceApi.loadInitial.mockResolvedValue({ status: 'ok', revision: 6, scope: 'shell' })
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

    window.dispatchEvent(new Event('offline'))
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))

    await vi.waitFor(() => expect(eventApi.subscriptions).toHaveLength(2))
    await vi.waitFor(() => expect(getClientSessionSnapshot().lifecycle).toBe('writing'))
    expect(resourceApi.loadInitial).toHaveBeenCalledTimes(2)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('rehydrates an established writer after reconnect replay attempts pending intent', async () => {
    pendingMutationApi.replay
      .mockResolvedValueOnce({ attempted: 0, discarded: 0, retained: 0, succeeded: 0 })
      .mockResolvedValueOnce({ attempted: 1, discarded: 0, retained: 0, succeeded: 1 })
    await loadData()
    bootstrapApi.fetch.mockResolvedValue(
      runtimeBootstrap({ revision: 5, writer: { sessionId: getActiveWriterSessionId(), epoch: 1 } }),
    )
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

    window.dispatchEvent(new Event('offline'))
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))

    await vi.waitFor(() => expect(eventApi.subscriptions).toHaveLength(2))
    await vi.waitFor(() => expect(getClientSessionSnapshot().lifecycle).toBe('writing'))
    expect(pendingMutationApi.replay).toHaveBeenCalledTimes(2)
    expect(resourceApi.loadInitial).toHaveBeenCalledTimes(2)
  })

  it('retries a replacement reader read in the new lineage without adopting writer or pending scope', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ writer: { sessionId: 'foreign-writer', epoch: 1 } }),
    )
    await loadData()
    const callbacks = readerApi.start.mock.calls[0]![0]
    const replacement = { databaseLineage: 'database-b', writer: { sessionId: 'replacement-writer', epoch: 0 } }
    projectionLifecycleApi.discard.mockImplementationOnce(async () => {
      clearCachedServerCommandRevision()
      clearAppliedServerResourceRevision()
    })
    bootstrapApi.fetchReadOnly
      .mockResolvedValueOnce({ status: 'error', error: 'temporary replacement read failure' })
      .mockResolvedValue(runtimeBootstrap({ ...replacement, writerEpoch: 0, revision: 1 }))
    resourceApi.readAll.mockResolvedValue({ status: 'ok', revision: 1, scope: 'full' })
    await callbacks.onLineageChange(replacement)
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      databaseLineage: 'database-b',
      connection: 'interrupted',
    })
    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      databaseLineage: 'database-b',
      projectionReady: true,
      connection: 'live',
    })
    expect(peekAppliedServerResourceRevision()).toBe(1)
    expect(bootstrapApi.fetch).not.toHaveBeenCalled()
    expect(pendingMutationApi.prepare).not.toHaveBeenCalled()
    expect(pendingMutationApi.replay).not.toHaveBeenCalled()
    expect(pendingMutationApi.flushAcknowledgements).not.toHaveBeenCalled()
    expect(projectionLifecycleApi.discard).toHaveBeenCalledExactlyOnceWith('lineage-change')
  })

  it('restarts a lineage-change reader whose aborted refresh never settles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ writer: { sessionId: 'foreign-writer', epoch: 1 } }),
    )
    await loadData()
    const callbacks = readerApi.start.mock.calls[0]![0]
    const replacement = { databaseLineage: 'database-b', writer: { sessionId: 'replacement-writer', epoch: 0 } }
    let refreshSignal: AbortSignal | undefined
    let releaseRefresh!: (value: { status: 'error'; error: string }) => void
    bootstrapApi.fetchReadOnly
      .mockImplementationOnce(
        (signal: AbortSignal) =>
          new Promise((resolve) => {
            refreshSignal = signal
            releaseRefresh = resolve
          }),
      )
      .mockResolvedValue(runtimeBootstrap({ ...replacement, writerEpoch: 0, revision: 1 }))
    resourceApi.readAll.mockResolvedValue({ status: 'ok', revision: 1, scope: 'full' })

    const changingLineage = callbacks.onLineageChange(replacement)
    await vi.waitFor(() => expect(refreshSignal).toBeInstanceOf(AbortSignal))
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(refreshSignal?.aborted).toBe(true)
    await changingLineage

    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledTimes(2))
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      databaseLineage: 'database-b',
      connection: 'live',
    })

    releaseRefresh({ status: 'error', error: 'late aborted replacement read' })
    await Promise.resolve()
    expect(readerApi.start).toHaveBeenCalledTimes(2)
    expect(warn).not.toHaveBeenCalledWith('Reader refresh failed:', expect.anything())
  })

  it('starts replacement reader recovery while retired lineage cleanup is still pending', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ writer: { sessionId: 'foreign-writer', epoch: 1 } }),
    )
    await loadData()
    const callbacks = readerApi.start.mock.calls[0]![0]
    const replacement = { databaseLineage: 'database-b', writer: { sessionId: 'replacement-writer', epoch: 0 } }
    let finishRetiredDiscard!: () => void
    const retiredDiscard = new Promise<void>((resolve) => {
      finishRetiredDiscard = resolve
    })
    projectionLifecycleApi.discard.mockImplementationOnce(() => retiredDiscard)
    bootstrapApi.fetchReadOnly.mockResolvedValue(runtimeBootstrap({ ...replacement, writerEpoch: 0, revision: 1 }))
    resourceApi.readAll.mockResolvedValue({ status: 'ok', revision: 1, scope: 'full' })

    const changingLineage = callbacks.onLineageChange(replacement)
    await vi.waitFor(() => expect(projectionLifecycleApi.discard).toHaveBeenCalledExactlyOnceWith('lineage-change'))
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      databaseLineage: 'database-b',
      projectionReady: false,
    })

    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await changingLineage
    expect(getClientSessionSnapshot().connection).toBe('interrupted')

    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledTimes(2))
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      databaseLineage: 'database-b',
      projectionReady: true,
      connection: 'live',
    })

    finishRetiredDiscard()
    await Promise.resolve()
    expect(readerApi.start).toHaveBeenCalledTimes(2)
    expect(getClientSessionSnapshot()).toMatchObject({
      lifecycle: 'reading',
      databaseLineage: 'database-b',
      connection: 'live',
    })
  })

  it.each(['plugin', 'generation', 'chat'] as const)(
    'ignores old %s startup completion after a newer writer recovery finishes',
    async (heldStep) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const step =
        heldStep === 'plugin'
          ? vi.mocked(loadPlugins)
          : heldStep === 'generation'
            ? recoveredGenerationApi.reconcilePendingRecoveredGenerationEffects
            : hydrationApi.hydrateActiveChat
      if (heldStep === 'chat')
        hydrationApi.hydrateActiveChat.mockImplementationOnce(async () => {
          await held
          return true
        })
      else
        step.mockImplementationOnce(async () => {
          await held
        })
      const oldStartup = loadData()
      await vi.waitFor(() => expect(step).toHaveBeenCalledOnce())
      eventApi.subscriptions[0]!.onClose!()
      await vi.waitFor(() => expect(eventApi.subscriptions).toHaveLength(2), { timeout: 3000 })
      await vi.waitFor(() => expect(getStartupCoordinatorSnapshot().capabilities.canGenerate).toBe(true))
      const currentGeneration = getClientSessionSnapshot().generation
      release()
      await oldStartup
      expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'writing', generation: currentGeneration })
      expect(getStartupCoordinatorSnapshot().capabilities).toMatchObject({ canMutate: true, canGenerate: true })
      expect(readerApi.start).not.toHaveBeenCalled()
      expect(backgroundReady()).toBe(true)
    },
  )
})

describe('resource event reconnect backoff', () => {
  it.each(['success', 'failure'] as const)(
    'replaces a suspended writer probe before its late %s and stops retired callbacks',
    async (lateResult) => {
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
      await loadData()
      vi.useFakeTimers()
      let release!: (value: ReturnType<typeof runtimeOwnership> | { status: 'error'; error: string }) => void
      let oldSignal: AbortSignal | undefined
      bootstrapApi.fetchOwnership.mockImplementationOnce((signal: AbortSignal) => {
        oldSignal = signal
        return new Promise((resolve) => {
          release = resolve
        })
      })
      const foreground = () => {
        visibility.mockReturnValue('hidden')
        document.dispatchEvent(new Event('visibilitychange'))
        visibility.mockReturnValue('visible')
        document.dispatchEvent(new Event('visibilitychange'))
      }
      foreground()
      await vi.advanceTimersByTimeAsync(0)
      expect(oldSignal?.aborted).toBe(false)
      foreground()
      await vi.advanceTimersByTimeAsync(0)
      expect(oldSignal?.aborted).toBe(true)
      expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'writing', connection: 'live' })
      expect(bootstrapApi.fetchOwnership).toHaveBeenCalledTimes(2)
      const replacement = getClientSessionSnapshot()
      const subscriptions = eventApi.subscribe.mock.calls.length
      release(
        lateResult === 'success'
          ? runtimeOwnership({ writer: { sessionId: 'obsolete-foreign-writer', epoch: 99 } })
          : { status: 'error', error: 'late ownership failure' },
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(getClientSessionSnapshot()).toEqual(replacement)
      expect(getStartupCoordinatorSnapshot().capabilities).toMatchObject({ canMutate: true, canGenerate: true })
      expect(eventApi.subscribe).toHaveBeenCalledTimes(subscriptions)

      stopConnectedClientServices()
      stopDeferredStartupRuntimes()
      stopServerResourceEvents()
      const requestsAfterStop = bootstrapApi.fetchOwnership.mock.calls.length
      await vi.advanceTimersByTimeAsync(120_000)
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
      expect(bootstrapApi.fetchOwnership).toHaveBeenCalledTimes(requestsAfterStop)
      expect(eventApi.subscribe).toHaveBeenCalledTimes(subscriptions)
    },
  )

  it('ignores ordinary focus for a healthy managed writer and uses ownership after suspension evidence', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await loadData()
    bootstrapApi.fetchOwnership.mockClear()

    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(bootstrapApi.fetchOwnership).not.toHaveBeenCalled()

    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(bootstrapApi.fetchOwnership).toHaveBeenCalledOnce())

    expect(eventApi.subscribe).toHaveBeenCalledOnce()
    expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledOnce()
  })

  it('reclaims a disconnected writer after a foreground ownership probe without a reader projection', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await loadData()
    autoWriterApi.enabled.mockResolvedValue(true)
    bootstrapApi.fetchOwnership.mockResolvedValue(
      runtimeOwnership({ writer: { sessionId: 'foreign-writer', epoch: 2 } }),
    )
    bootstrapApi.fetch.mockResolvedValue(
      runtimeBootstrap({ writerEpoch: 3, writer: { sessionId: getActiveWriterSessionId(), epoch: 3 } }),
    )
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(bootstrapApi.fetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(getClientSessionSnapshot().lifecycle).toBe('writing'))
    expect(readerApi.start).not.toHaveBeenCalled()
    expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledOnce()
    expect(bootstrapApi.fetch.mock.calls[1][1]).toEqual({ expectedWriter: { epoch: 2, databaseLineage: 'database-a' } })
  })

  it('uses full reader recovery when the foreground ownership probe finds another writer', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await loadData()
    bootstrapApi.fetchOwnership.mockClear()
    bootstrapApi.fetchReadOnly.mockResolvedValue(
      runtimeBootstrap({ writerEpoch: 2, writer: { sessionId: 'different-writer', epoch: 2 } }),
    )
    bootstrapApi.fetchOwnership.mockResolvedValue(
      runtimeOwnership({ writer: { sessionId: 'different-writer', epoch: 2 } }),
    )

    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))

    await vi.waitFor(() => expect(readerApi.start).toHaveBeenCalledOnce())
    expect(bootstrapApi.fetchOwnership).toHaveBeenCalledOnce()
    expect(bootstrapApi.fetchReadOnly).toHaveBeenCalledTimes(2)
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
  })
})
