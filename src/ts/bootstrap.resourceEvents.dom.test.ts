import {
  setupBootstrapTests,
  bootstrapMocks,
  runtimeBootstrap,
  runtimeOwnership,
  coreIt,
  type TestMemoryEvent,
  type TestMemorySnapshot,
} from './bootstrap.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import {
  calculateServerResourceReconnectDelayMs,
  loadData,
  loadWebInitialDatabase,
  stopServerResourceEvents,
} from './bootstrap'
import { canUseClientWriteAccess, getClientSessionSnapshot } from './clientSession'
import { alertError } from './alert'
import {
  peekAppliedServerResourceRevision,
  peekCachedServerCommandRevision,
  patchRuntimeSettings,
  withDirectServerCommandEventReconciliation,
} from './server/commands'
import { getActiveWriterSessionId } from './server/activeWriterSession'
import { adoptReplacementDatabaseOwnership } from './server/replacementDatabaseOwnership'
import { selectedCharID } from './stores.svelte'
import { getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

const {
  bootstrapApi,
  resourceApi,
  commandApi,
  eventApi,
  hydrationApi,
  characterHydrationApi,
  lorebookApi,
  promptTemplateApi,
  runtimeApi,
  ownerMutationLifecycleApi,
  pendingMutationApi,
  ownershipApi,
  projectionLifecycleApi,
  memoryApi,
  occupancyApi,
  activeWriterApi,
} = bootstrapMocks

setupBootstrapTests()

describe('API-backed client bootstrap', () => {
  it('refreshes the targeted API resources for a contiguous command event', async () => {
    await loadWebInitialDatabase()
    const event = { type: 'persona.updated', revision: 6, resource: 'persona', id: 'persona-a' }
    eventApi.subscriptions[0].onCommandEvent(event)

    await vi.waitFor(() => expect(resourceApi.refreshInvalidated).toHaveBeenCalledTimes(1))
    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
    await vi.waitFor(() => expect(peekAppliedServerResourceRevision()).toBe(6))
  })

  it.each(['state.restored', 'state.imported'])(
    'reconciles replacement ownership before applying a cross-tab %s event',
    async (type) => {
      await loadWebInitialDatabase()
      const event = { type, revision: 6, resource: 'state' }
      const order: string[] = []
      bootstrapApi.fetchOwnership.mockReset()
      bootstrapApi.fetchOwnership.mockImplementationOnce(async () => {
        order.push('ownership')
        return runtimeOwnership({
          databaseLineage: 'database-restored',
          writer: { sessionId: getActiveWriterSessionId(), epoch: 2 },
        })
      })
      pendingMutationApi.prepare.mockReset()
      pendingMutationApi.prepare.mockImplementationOnce(async (input) => {
        order.push('prepare')
        input.onOwnershipChange?.()
        pendingMutationApi.scope = `${input.writerSessionId}\u0000${input.writerEpoch}\u0000${input.databaseLineage}`
        return { discarded: 2 }
      })
      ownershipApi.reset.mockImplementationOnce(() => {
        order.push('reset')
      })
      resourceApi.forceReplacement.mockImplementationOnce(async () => {
        order.push('refresh')
        return { status: 'ok', revision: 3 }
      })
      let finishProjectionDiscard!: () => void
      const projectionDiscard = new Promise<void>((resolve) => {
        finishProjectionDiscard = resolve
      })
      projectionLifecycleApi.discard.mockImplementationOnce(async () => {
        order.push('discard')
        await projectionDiscard
      })

      eventApi.subscriptions[0].onCommandEvent({ ...event, revision: 3 })

      try {
        await vi.waitFor(() => expect(projectionLifecycleApi.discard).toHaveBeenCalledExactlyOnceWith('lineage-change'))
        expect(order).toEqual(['ownership', 'prepare', 'reset', 'discard'])
        expect(resourceApi.forceReplacement).not.toHaveBeenCalled()
      } finally {
        finishProjectionDiscard()
      }
      await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledOnce())
      expect(order).toEqual(['ownership', 'prepare', 'reset', 'discard', 'refresh'])
      expect(bootstrapApi.fetchOwnership).toHaveBeenCalledOnce()
      expect(pendingMutationApi.prepare).toHaveBeenCalledWith({
        writerSessionId: getActiveWriterSessionId(),
        writerEpoch: 2,
        databaseLineage: 'database-restored',
        requestedWriterWasActive: true,
        onOwnershipChange: expect.any(Function),
      })
      expect(resourceApi.forceReplacement).toHaveBeenCalledWith('database-replacement-event', {
        resource: 'state',
      })
      expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
      expect(ownershipApi.discard).toHaveBeenCalledOnce()
      expect(alertError).toHaveBeenCalledOnce()
    },
  )

  it('retries a failed replacement snapshot when the state event is replayed', async () => {
    await loadWebInitialDatabase()
    const event = { type: 'state.restored', revision: 3, resource: 'state' }
    bootstrapApi.fetchOwnership.mockResolvedValue(
      runtimeOwnership({
        databaseLineage: 'database-retry',
        writer: { sessionId: getActiveWriterSessionId(), epoch: 2 },
      }),
    )
    resourceApi.forceReplacement
      .mockResolvedValueOnce({ status: 'error', error: 'settings failed' })
      .mockResolvedValueOnce({ status: 'ok', revision: 3 })

    eventApi.subscriptions[0].onCommandEvent(event)
    await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledTimes(1))

    eventApi.subscriptions[0].onCommandEvent(event)
    await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledTimes(2))

    expect(ownershipApi.reset).toHaveBeenCalledOnce()
    expect(resourceApi.forceReplacement).toHaveBeenNthCalledWith(1, 'database-replacement-event', {
      resource: 'state',
    })
    expect(resourceApi.forceReplacement).toHaveBeenNthCalledWith(2, 'database-replacement-event', {
      resource: 'state',
    })
  })

  it('retries a failed replacement snapshot after a normal reconnect without another event', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    await loadWebInitialDatabase()
    const event = { type: 'state.restored', revision: 3, resource: 'state' }
    bootstrapApi.fetchOwnership.mockResolvedValue(
      runtimeOwnership({
        databaseLineage: 'database-reconnect-retry',
        writer: { sessionId: getActiveWriterSessionId(), epoch: 2 },
      }),
    )
    resourceApi.forceReplacement
      .mockResolvedValueOnce({ status: 'error', error: 'settings failed' })
      .mockResolvedValueOnce({ status: 'ok', revision: 3 })

    eventApi.subscriptions[0].onCommandEvent(event)
    await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledTimes(2))

    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
    expect(resourceApi.forceReplacement).toHaveBeenNthCalledWith(1, 'database-replacement-event', {
      resource: 'state',
    })
    expect(resourceApi.forceReplacement).toHaveBeenNthCalledWith(2, 'database-replacement-reconnect')
    expect(ownershipApi.reset).toHaveBeenCalledOnce()
  })

  it('retries a failed replay-unavailable replacement snapshot after a normal reconnect', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    eventApi.subscribe
      .mockResolvedValueOnce({ status: 'replay-unavailable', currentRevision: 3 })
      .mockImplementationOnce(async (input) => {
        eventApi.subscriptions.push(input)
        return { status: 'ok', unsubscribe: eventApi.unsubscribe }
      })
    bootstrapApi.fetchOwnership.mockResolvedValue(
      runtimeOwnership({
        databaseLineage: 'database-replay-retry',
        writer: { sessionId: getActiveWriterSessionId(), epoch: 2 },
      }),
    )
    resourceApi.forceReplacement
      .mockResolvedValueOnce({ status: 'error', error: 'settings failed' })
      .mockResolvedValueOnce({ status: 'ok', revision: 3 })

    await loadWebInitialDatabase()
    await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(resourceApi.forceReplacement).toHaveBeenCalledTimes(2))

    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
    expect(resourceApi.forceReplacement).toHaveBeenNthCalledWith(1, 'event-replay-unavailable', { minimumRevision: 3 })
    expect(resourceApi.forceReplacement).toHaveBeenNthCalledWith(2, 'database-replacement-reconnect')
    expect(ownershipApi.reset).toHaveBeenCalledOnce()
  })

  it('refreshes again after an older targeted read drains behind a successful local restore', async () => {
    await loadWebInitialDatabase()
    const order: string[] = []
    let finishOldRead!: () => void
    const oldReadFinished = new Promise<void>((resolve) => {
      finishOldRead = resolve
    })
    resourceApi.refreshInvalidated.mockImplementationOnce(async () => {
      order.push('old-read-started')
      await oldReadFinished
      order.push('old-read-applied')
      return { status: 'ok', revision: 6, scope: 'targeted' }
    })
    resourceApi.forceReplacement.mockImplementation(async (reason) => {
      order.push(reason)
      return { status: 'ok', revision: 3 }
    })
    bootstrapApi.fetchOwnership.mockResolvedValue(
      runtimeOwnership({
        databaseLineage: 'database-local-restore',
        writer: { sessionId: getActiveWriterSessionId(), epoch: 2 },
      }),
    )

    eventApi.subscriptions[0].onCommandEvent({
      type: 'settings.updated',
      revision: 6,
      resource: 'settings',
      id: 'display',
    })
    await vi.waitFor(() => expect(resourceApi.refreshInvalidated).toHaveBeenCalledOnce())

    await adoptReplacementDatabaseOwnership({ databaseLineage: 'database-local-restore', writerEpoch: 2 })
    await resourceApi.forceReplacement('backup-restore')
    eventApi.subscriptions[0].onCommandEvent({ type: 'state.restored', revision: 3, resource: 'state' })
    finishOldRead()

    await vi.waitFor(() =>
      expect(resourceApi.forceReplacement).toHaveBeenCalledWith('database-replacement-event', {
        resource: 'state',
      }),
    )
    expect(order).toEqual(['old-read-started', 'backup-restore', 'old-read-applied', 'database-replacement-event'])
  })

  it('preserves a newer character selection while a targeted resource invalidation is pending', async () => {
    await loadWebInitialDatabase()
    selectedCharID.set(0)
    const event = { type: 'settings.updated', revision: 6, resource: 'settings', id: 'display' }
    let finishRead!: () => void
    const readFinished = new Promise<void>((resolve) => {
      finishRead = resolve
    })
    resourceApi.refreshInvalidated.mockImplementationOnce(async () => {
      await readFinished
      return { status: 'ok', revision: event.revision, scope: 'targeted' }
    })

    const reconciliation = commandApi.reconciler?.(event, [event], new Map())
    await vi.waitFor(() => expect(resourceApi.refreshInvalidated).toHaveBeenCalledTimes(1))
    selectedCharID.set(1)
    finishRead()
    await reconciliation

    expect(getDatabase().characters[get(selectedCharID)]?.chaId).toBe('char-b')
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('deduplicates an own direct event before, during, and after response resource reconciliation', async () => {
    await loadWebInitialDatabase()
    const event = {
      type: 'character.created',
      revision: 6,
      resource: 'character',
      id: 'char-imported',
      origin: { writerSessionId: getActiveWriterSessionId() },
    }
    let startRead!: () => void
    const readStarted = new Promise<void>((resolve) => {
      startRead = resolve
    })
    let finishRead!: () => void
    const readFinished = new Promise<void>((resolve) => {
      finishRead = resolve
    })
    let characterReadCount = 0
    resourceApi.refreshInvalidated.mockImplementation(async (_events, options) => {
      if (event.revision <= (options?.appliedRevision ?? -1)) {
        return { status: 'ok', revision: options?.appliedRevision ?? event.revision, scope: 'none' }
      }
      characterReadCount += 1
      startRead()
      await readFinished
      return { status: 'ok', revision: event.revision, scope: 'targeted' }
    })

    await withDirectServerCommandEventReconciliation(
      (candidate) => candidate.type === 'character.created' && candidate.resource === 'character',
      async (reconcileResponseEvent) => {
        eventApi.subscriptions[0].onCommandEvent(event)
        const applyingResponse = reconcileResponseEvent(event)
        await readStarted
        eventApi.subscriptions[0].onCommandEvent(event)
        finishRead()
        await applyingResponse
      },
    )

    expect(characterReadCount).toBe(1)
    expect(peekAppliedServerResourceRevision()).toBe(6)

    eventApi.subscriptions[0].onCommandEvent(event)
    await vi.waitFor(() => expect(resourceApi.refreshInvalidated).toHaveBeenCalledTimes(2))
    expect(characterReadCount).toBe(1)
  })

  it('uses a full resource result revision and invalidates chat hydration after a gap', async () => {
    await loadWebInitialDatabase()
    characterHydrationApi.hydrateSelected.mockClear()
    hydrationApi.requestReadinessRefresh.mockClear()
    resourceApi.refreshInvalidated.mockResolvedValueOnce({ status: 'ok', revision: 12, scope: 'full' })
    eventApi.subscriptions[0].onCommandEvent({ type: 'state.changed', revision: 9, resource: 'state' })

    await vi.waitFor(() => expect(peekAppliedServerResourceRevision()).toBe(12))
    expect(hydrationApi.resetChatHydration).toHaveBeenCalledTimes(2)
    expect(hydrationApi.hydrateActiveChat).toHaveBeenCalledWith({ force: true })
    expect(hydrationApi.requestReadinessRefresh).toHaveBeenCalledOnce()
    expect(characterHydrationApi.hydrateSelected).toHaveBeenCalledWith({
      supersede: true,
      rebindSupersededSubscribers: true,
      minimumRevision: 12,
    })
    expect(characterHydrationApi.hydrateSelected.mock.invocationCallOrder[0]).toBeLessThan(
      hydrationApi.requestReadinessRefresh.mock.invocationCallOrder[0]!,
    )
    expect(promptTemplateApi.ensure).toHaveBeenLastCalledWith({ force: true, minimumRevision: 12 })
    expect(runtimeApi.triggerOpenChatGenerationReattach).toHaveBeenCalledTimes(1)
  })

  it('preserves the selected-character readiness subscriber across full-to-targeted refresh supersession', async () => {
    await loadWebInitialDatabase()
    characterHydrationApi.hydrateSelected.mockClear()
    resourceApi.refreshInvalidated
      .mockResolvedValueOnce({ status: 'ok', revision: 12, scope: 'full' })
      .mockResolvedValueOnce({ status: 'ok', revision: 13, scope: 'targeted' })

    eventApi.subscriptions[0].onCommandEvent({ type: 'state.changed', revision: 9, resource: 'state' })
    await vi.waitFor(() => expect(peekAppliedServerResourceRevision()).toBe(12))

    eventApi.subscriptions[0].onCommandEvent({ type: 'settings.updated', revision: 13, resource: 'settings' })
    await vi.waitFor(() => expect(peekAppliedServerResourceRevision()).toBe(13))

    expect(characterHydrationApi.hydrateSelected).toHaveBeenNthCalledWith(1, {
      supersede: true,
      rebindSupersededSubscribers: true,
      minimumRevision: 12,
    })
    expect(characterHydrationApi.hydrateSelected).toHaveBeenNthCalledWith(2, {
      supersede: true,
      rebindSupersededSubscribers: true,
      minimumRevision: 13,
    })
  })

  it('invalidates body hydration without advancing the cursor when full-refresh prompt hydration fails', async () => {
    await loadWebInitialDatabase()
    promptTemplateApi.ensure.mockResolvedValueOnce(false)
    resourceApi.refreshInvalidated.mockResolvedValueOnce({ status: 'ok', revision: 12, scope: 'full' })
    eventApi.subscriptions[0].onCommandEvent({ type: 'state.changed', revision: 9, resource: 'state' })

    await vi.waitFor(() => expect(promptTemplateApi.ensure).toHaveBeenCalledOnce())
    expect(promptTemplateApi.ensure).toHaveBeenLastCalledWith({ force: true, minimumRevision: 12 })
    expect(peekAppliedServerResourceRevision()).toBe(5)
    expect(hydrationApi.resetChatHydration).toHaveBeenCalledTimes(2)
    expect(lorebookApi.resetLorebookHydration).toHaveBeenCalledTimes(2)
    expect(hydrationApi.hydrateActiveChat).toHaveBeenCalledWith({ force: true })
    expect(runtimeApi.triggerOpenChatGenerationReattach).not.toHaveBeenCalled()
  })

  it('does not advance the applied cursor when an invalidation read fails', async () => {
    await loadWebInitialDatabase()
    resourceApi.refreshInvalidated.mockResolvedValueOnce({ status: 'error', error: 'network down' })
    eventApi.subscriptions[0].onCommandEvent({ type: 'persona.updated', revision: 6, resource: 'persona' })

    await vi.waitFor(() => expect(resourceApi.refreshInvalidated).toHaveBeenCalledTimes(1))
    expect(peekAppliedServerResourceRevision()).toBe(5)
  })

  // prettier-ignore
  coreIt('reconciles ownership before replay-unavailable recovery when a disconnected tab missed a restore', async () => {
    eventApi.subscribe.mockResolvedValueOnce({ status: 'replay-unavailable', currentRevision: 3 })
    bootstrapApi.fetchOwnership.mockResolvedValue(
      runtimeOwnership({
        databaseLineage: 'database-missed-restore',
        writer: { sessionId: getActiveWriterSessionId(), epoch: 2 },
      }),
    )

    await loadWebInitialDatabase()

    await vi.waitFor(() =>
      expect(resourceApi.forceReplacement).toHaveBeenCalledWith('event-replay-unavailable', { minimumRevision: 3 }),
    )
    expect(ownershipApi.reset).toHaveBeenCalledOnce()
    expect(ownershipApi.discard).toHaveBeenCalledOnce()
    expect(resourceApi.forceRefresh).not.toHaveBeenCalledWith('event-replay-unavailable', expect.anything())
  })

  it('repairs replay and malformed-frame failures through a complete resource refresh', async () => {
    eventApi.subscribe.mockResolvedValueOnce({ status: 'replay-unavailable', currentRevision: 9 })
    await loadWebInitialDatabase()
    await vi.waitFor(() =>
      expect(resourceApi.forceRefresh).toHaveBeenCalledWith('event-replay-unavailable', { minimumRevision: 9 }),
    )

    stopServerResourceEvents()
    eventApi.subscribe.mockImplementationOnce(async (input) => {
      eventApi.subscriptions.push(input)
      return { status: 'ok', unsubscribe: eventApi.unsubscribe }
    })
    await loadWebInitialDatabase()
    eventApi.subscriptions.at(-1)?.onError?.('Malformed command event frame: bad JSON')
    await vi.waitFor(() => expect(resourceApi.forceRefresh).toHaveBeenCalledWith('malformed-command-event'))
  })

  it('publishes memory events without refreshing durable resources', async () => {
    await loadWebInitialDatabase()
    const event: TestMemoryEvent = {
      type: 'memory.job',
      streamId: 'memory-stream-1',
      version: 2,
      chatId: 'chat-a',
      job: {
        id: 'job-a',
        instanceId: 'job-instance-a',
        kind: 'summarize',
        status: 'running',
        attemptCount: 1,
        maxAttempts: 3,
      },
    }
    eventApi.subscriptions[0].onMemoryEvent?.(event)

    expect(memoryApi.applyEvent).toHaveBeenCalledWith(event)
    expect(memoryApi.publish).toHaveBeenCalledWith(event)
    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
  })

  it('does not publish memory events rejected by the projection', async () => {
    await loadWebInitialDatabase()
    memoryApi.applyEvent.mockReturnValueOnce(false)
    const event: TestMemoryEvent = {
      type: 'memory.job',
      streamId: 'memory-stream-1',
      version: 1,
      chatId: 'chat-a',
      job: {
        id: 'job-a',
        instanceId: 'job-instance-a',
        kind: 'summarize',
        status: 'running',
        attemptCount: 1,
        maxAttempts: 3,
      },
    }

    eventApi.subscriptions[0].onMemoryEvent!(event)

    expect(memoryApi.applyEvent).toHaveBeenCalledWith(event)
    expect(memoryApi.publish).not.toHaveBeenCalled()
    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(peekAppliedServerResourceRevision()).toBe(5)
  })

  it('hydrates memory projection snapshots without refreshing durable resources', async () => {
    await loadWebInitialDatabase()
    const snapshot: TestMemorySnapshot = {
      type: 'memory.snapshot',
      streamId: 'memory-stream-1',
      version: 1,
      jobs: [
        {
          id: 'job-a',
          instanceId: 'job-instance-a',
          chatId: 'chat-a',
          kind: 'summarize',
          status: 'pending',
          attemptCount: 0,
          maxAttempts: 3,
        },
      ],
    }
    eventApi.subscriptions[0].onMemorySnapshot?.(snapshot)

    expect(memoryApi.applySnapshot).toHaveBeenCalledWith(snapshot)
    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
  })

  it('installs bootstrap occupancy and applies owner-stream occupancy frames without changing command revision', async () => {
    const chatOccupancyProtocol = { version: 1, enabled: true, leaseMs: 90_000, renewAfterMs: 30_000 }
    const chatOccupancies = { version: 1, databaseLineage: 'database-a', occupancies: [] }
    bootstrapApi.fetch.mockResolvedValue(runtimeBootstrap({ chatOccupancyProtocol, chatOccupancies }))
    await loadWebInitialDatabase()
    const revision = peekCachedServerCommandRevision()
    const event = { type: 'occupancy.snapshot', ...chatOccupancies }

    expect(occupancyApi.configure).toHaveBeenCalledWith(
      chatOccupancyProtocol,
      chatOccupancies,
      getClientSessionSnapshot().generation,
    )
    expect(occupancyApi.recover).toHaveBeenCalledOnce()
    eventApi.subscriptions[0].onOccupancyEvent?.(event)
    expect(occupancyApi.applyEvent).toHaveBeenCalledWith(event, {
      generation: getClientSessionSnapshot().generation,
      sessionId: getClientSessionSnapshot().sessionId,
    })
    expect(peekCachedServerCommandRevision()).toBe(revision)
  })

  it('enters the takeover flow only for a different non-null writer session', async () => {
    await loadWebInitialDatabase()
    const ownSessionId = getActiveWriterSessionId()

    eventApi.subscriptions[0].onWriterEvent?.({ sessionId: null, epoch: 0 })
    eventApi.subscriptions[0].onWriterEvent?.({ sessionId: ownSessionId, epoch: 1 })
    expect(activeWriterApi.enterTakeover).not.toHaveBeenCalled()

    eventApi.subscriptions[0].onWriterEvent?.({ sessionId: 'different-writer', epoch: 2 })
    expect(activeWriterApi.enterTakeover).toHaveBeenCalledOnce()
  })

  it('revokes writes and refreshes when a same-writer event changes database lineage', async () => {
    await loadData()
    expect(canUseClientWriteAccess()).toBe(true)
    const writer = { sessionId: getActiveWriterSessionId(), epoch: 1 }
    bootstrapApi.fetchReadOnly.mockResolvedValue(runtimeBootstrap({ databaseLineage: 'database-b', writer }))

    eventApi.subscriptions[0].onWriterEvent!({ ...writer, databaseLineage: 'database-b' })

    expect(canUseClientWriteAccess()).toBe(false)
    await vi.waitFor(() => expect(projectionLifecycleApi.discard).toHaveBeenCalledWith('lineage-change'))
    await vi.waitFor(() =>
      expect(getClientSessionSnapshot()).toMatchObject({
        lifecycle: 'reading',
        databaseLineage: 'database-b',
        connection: 'live',
      }),
    )
    expect(bootstrapApi.fetch).toHaveBeenCalledOnce()
    expect(canUseClientWriteAccess()).toBe(false)
  })

  it('stops the resource event subscription and owner mutation lifecycle', async () => {
    await loadWebInitialDatabase()
    stopServerResourceEvents()
    expect(eventApi.unsubscribe).toHaveBeenCalledTimes(1)
    expect(ownerMutationLifecycleApi.stop).toHaveBeenCalledTimes(1)
  })
})

describe('resource event reconnect backoff', () => {
  it('uses a live heartbeat to retry retained mutations without a reconnect', async () => {
    await loadWebInitialDatabase()
    expect(pendingMutationApi.replay).toHaveBeenCalledTimes(1)

    eventApi.subscriptions[0].onFrame?.({ event: 'message', data: '' })

    await vi.waitFor(() => expect(pendingMutationApi.replay).toHaveBeenCalledTimes(2))
    expect(eventApi.subscribe).toHaveBeenCalledTimes(1)
  })

  it('reconnects a stream that stops delivering heartbeat frames', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    await loadWebInitialDatabase()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(1)
    eventApi.subscriptions[0].onFrame?.({ event: 'message', data: '' })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(eventApi.unsubscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
  })

  it('resubscribes on online, visibility, pageshow, and focus recovery', async () => {
    await loadWebInitialDatabase()
    expect(pendingMutationApi.replay).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(eventApi.subscribe).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(pendingMutationApi.replay).toHaveBeenCalledTimes(2))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(eventApi.subscribe).toHaveBeenCalledTimes(3))
    window.dispatchEvent(new Event('pageshow'))
    await vi.waitFor(() => expect(eventApi.subscribe).toHaveBeenCalledTimes(4))
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(eventApi.subscribe).toHaveBeenCalledTimes(5))

    expect(eventApi.unsubscribe).toHaveBeenCalledTimes(4)
  })

  it('refreshes and resubscribes when a conflict proves the applied projection is behind', async () => {
    await loadWebInitialDatabase()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'revision_conflict', currentRevision: 9 }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

    await expect(
      patchRuntimeSettings({
        baseRevision: 5,
        patch: { streamGeminiThoughts: true },
      }),
    ).resolves.toEqual({ status: 'conflict', currentRevision: 9 })

    await vi.waitFor(() =>
      expect(resourceApi.forceRefresh).toHaveBeenCalledWith('conflict-gap', { minimumRevision: 9 }),
    )
    await vi.waitFor(() => expect(eventApi.subscribe).toHaveBeenCalledTimes(2))
  })

  it('schedules increasing reconnect delays during a simulated outage', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    eventApi.subscribe.mockImplementation(async (input) => {
      eventApi.subscriptions.push(input)
      if (eventApi.subscriptions.length === 1) {
        return { status: 'ok', unsubscribe: eventApi.unsubscribe }
      }
      return { status: 'error', error: 'offline' }
    })

    await loadWebInitialDatabase()
    eventApi.subscriptions[0].onClose?.()

    await vi.advanceTimersByTimeAsync(999)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(3)
  })

  it('keeps one pending reconnect timer for repeated stream failures', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    await loadWebInitialDatabase()
    eventApi.subscriptions[0].onClose?.()
    eventApi.subscriptions[0].onClose?.()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
  })

  it('resets reconnect backoff to the base delay after a successful subscribe', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    await loadWebInitialDatabase()
    eventApi.subscriptions[0].onClose?.()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)

    eventApi.subscriptions[1].onClose?.()
    await vi.advanceTimersByTimeAsync(999)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(3)
  })

  it('stop clears pending reconnect and resets the next outage to base delay', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    await loadWebInitialDatabase()
    eventApi.subscriptions[0].onClose?.()
    stopServerResourceEvents()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(1)

    await loadWebInitialDatabase()
    eventApi.subscriptions[1].onClose?.()
    await vi.advanceTimersByTimeAsync(999)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(eventApi.subscribe).toHaveBeenCalledTimes(3)
  })

  it('uses capped exponential delay with bounded jitter', () => {
    expect(calculateServerResourceReconnectDelayMs(0, () => 0.5)).toBe(1000)
    expect(calculateServerResourceReconnectDelayMs(1, () => 0.5)).toBe(2000)
    expect(calculateServerResourceReconnectDelayMs(2, () => 0.5)).toBe(4000)
    expect(calculateServerResourceReconnectDelayMs(5, () => 0.5)).toBe(30000)
    expect(calculateServerResourceReconnectDelayMs(10, () => 1)).toBe(30000)
    expect(calculateServerResourceReconnectDelayMs(0, () => Number.NaN)).toBe(1000)
  })
})
