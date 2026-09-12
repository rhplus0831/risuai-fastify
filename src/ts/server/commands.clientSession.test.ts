import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeClientWriterRecovery,
  beginClientPromotion,
  beginClientSession,
  canUseClientWriteAccess,
  completeClientWriterRecovery,
  getClientSessionSnapshot,
  observeClientWriter,
  setClientConnectionState,
  setClientProjectionReady,
  settleClientReader,
} from '../clientSession'
import { recordStartupMilestone, resetStartupReadinessForTests } from '../startupReadiness'
import { isWriterAccessLost, resetWriterAccessLostForTests } from './activeWriterSession'
import {
  acknowledgeServerMutationReceipts,
  clearCachedServerCommandRevision,
  deferOwnServerCommandReconciliation,
  drainServerCommandExecutionForTests,
  initializeServerDatabaseForBootstrap,
  patchRuntimeSettings,
  peekCachedServerCommandRevision,
  replayDurableMutationRequests,
  runServerCommand,
  runServerCommandSequence,
  setCachedServerCommandRevision,
  setServerCommandSuccessReconciler,
  withDirectServerCommandEventReconciliation,
  type ServerCommandResult,
  type CommandEvent,
} from './commands'

const mocks = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: mocks.auth }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const ownership = (sessionId: string, epoch: number) => ({
  databaseLineage: 'lineage-a',
  writer: { sessionId, epoch },
})
const receipt = (revision: number) => ({
  revision,
  event: { type: 'settings.updated', revision, resource: 'settings' },
})

function becomeWriter() {
  const operation = beginClientSession('client-a')
  authorizeClientWriterRecovery(operation, ownership('client-a', 1))
  setClientProjectionReady(true)
  setClientConnectionState('live')
  expect(completeClientWriterRecovery(operation)).toBe(true)
}

function loseAndRegainWriteAccess() {
  observeClientWriter({ sessionId: 'client-b', epoch: 2 })
  const promotion = beginClientPromotion()!
  expect(authorizeClientWriterRecovery(promotion, ownership('client-a', 3))).toBe(true)
  expect(completeClientWriterRecovery(promotion)).toBe(true)
}

beforeEach(() => {
  resetStartupReadinessForTests()
  resetWriterAccessLostForTests()
  for (const milestone of ['entry', 'shell-mounted', 'reader-ready', 'writer-ready'] as const) {
    recordStartupMilestone(milestone)
  }
  clearCachedServerCommandRevision()
  setCachedServerCommandRevision(1)
  setServerCommandSuccessReconciler(null)
  mocks.auth.mockReset().mockResolvedValue('test-auth')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(receipt(2))),
  )
})

afterEach(async () => {
  await drainServerCommandExecutionForTests()
  setServerCommandSuccessReconciler(null)
  resetStartupReadinessForTests()
  resetWriterAccessLostForTests()
  vi.unstubAllGlobals()
})

describe('command transport across connected client roles', () => {
  it('releases the command queue when an accepted response body stalls and ignores its late receipt', async () => {
    becomeWriter()
    vi.useFakeTimers()
    const body = deferred<unknown>()
    const json = vi.fn(() => body.promise)
    const response = Response.json(receipt(2))
    response.json = json
    vi.mocked(fetch).mockResolvedValueOnce(response)
    const reconcile = vi.fn()
    setServerCommandSuccessReconciler(reconcile)
    let settled = false
    const first = runServerCommand({
      command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: 4000 } }),
    }).then((result) => {
      settled = true
      return result
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(json).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(settled).toBe(true)
      await expect(first).resolves.toMatchObject({ status: 'error' })
      vi.mocked(fetch).mockResolvedValueOnce(Response.json(receipt(3)))
      await expect(
        runServerCommand({
          command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: 8000 } }),
        }),
      ).resolves.toMatchObject({ status: 'ok', revision: 3 })
      body.resolve(receipt(2))
      await vi.advanceTimersByTimeAsync(0)
      expect(peekCachedServerCommandRevision()).toBe(3)
      expect(reconcile).toHaveBeenCalledOnce()
      expect(reconcile.mock.calls[0][0].revision).toBe(3)
      await vi.advanceTimersByTimeAsync(500) // Normal persistence-indicator linger.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      body.resolve(receipt(2))
      await first
      vi.useRealTimers()
    }
  })

  it.each([
    'auth',
    'fetch',
    'error-body',
    'bootstrap-fetch',
    'bootstrap-body',
    'receipt-auth',
    'receipt-fetch',
  ] as const)('bounds %s without publishing a late response or blocking the next edit', async (boundary) => {
    becomeWriter()
    vi.useFakeTimers()
    const auth = deferred<string>()
    const response = deferred<Response>()
    const body = deferred<unknown>()
    const acknowledgement = boundary.startsWith('receipt-')
    if (boundary.includes('auth')) mocks.auth.mockReturnValueOnce(auth.promise)
    else if (boundary.endsWith('body')) {
      const held = Response.json({}, { status: boundary === 'error-body' ? 423 : 200 })
      held.json = vi.fn(() => body.promise)
      vi.mocked(fetch).mockResolvedValueOnce(held)
    } else vi.mocked(fetch).mockReturnValueOnce(response.promise)
    if (boundary.startsWith('bootstrap-')) clearCachedServerCommandRevision()
    let settled = false
    const first = (
      acknowledgement
        ? acknowledgeServerMutationReceipts('accepted-a', 1, 'lineage-a')
        : runServerCommand({
            command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: 4000 } }),
          })
    ).then((result) => {
      settled = true
      return result
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.auth).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(settled).toBe(true)
      if (acknowledgement) await expect(first).resolves.toBe(false)
      else await expect(first).resolves.toMatchObject({ status: 'error' })
      // A recovered revision is independent of the held old request.
      setCachedServerCommandRevision(2)
      vi.mocked(fetch).mockResolvedValue(Response.json(receipt(3)))
      await expect(
        runServerCommand({
          command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: 8000 } }),
        }),
      ).resolves.toMatchObject({ status: 'ok', revision: 3 })
      const callsBeforeLateDelivery = vi.mocked(fetch).mock.calls.length
      auth.resolve('old-auth')
      response.resolve(Response.json(receipt(99)))
      body.resolve(boundary === 'error-body' ? { error: 'active_writer_stale' } : receipt(99))
      await vi.advanceTimersByTimeAsync(500)
      expect(fetch).toHaveBeenCalledTimes(callsBeforeLateDelivery)
      expect(peekCachedServerCommandRevision()).toBe(3)
      expect(canUseClientWriteAccess()).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      auth.resolve('old-auth')
      response.resolve(Response.json(receipt(99)))
      body.resolve(receipt(99))
      await first
      vi.useRealTimers()
    }
  })

  it('settles explicit cancellation even when response parsing ignores abort', async () => {
    becomeWriter()
    const body = deferred<unknown>()
    const response = Response.json(receipt(2))
    response.json = vi.fn(() => body.promise)
    vi.mocked(fetch).mockResolvedValueOnce(response)
    const controller = new AbortController()
    const request = patchRuntimeSettings({ baseRevision: 1, patch: { maxContext: 4000 } }, controller.signal)
    await vi.waitFor(() => expect(response.json).toHaveBeenCalledOnce())
    controller.abort()
    try {
      await expect(request).resolves.toMatchObject({ status: 'error' })
      expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true)
    } finally {
      body.resolve(receipt(2))
      await request
    }
    expect(peekCachedServerCommandRevision()).toBe(1)
  })

  it('denies reader commands, initialization, replay and receipt writes before even requesting auth', async () => {
    const operation = beginClientSession('client-a')
    settleClientReader(operation, ownership('client-b', 1))
    setClientProjectionReady(true)
    setClientConnectionState('live')
    const factory = vi.fn()
    await expect(runServerCommand({ command: factory })).resolves.toEqual({ status: 'unavailable' })
    await expect(runServerCommandSequence([factory])).resolves.toEqual({ status: 'unavailable' })
    await expect(initializeServerDatabaseForBootstrap()).resolves.toEqual({ status: 'unavailable' })
    await expect(
      replayDurableMutationRequests(
        [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 4000 } } }],
        'retained-mutation',
        'lineage-a',
      ),
    ).resolves.toEqual({ status: 'unavailable' })
    await expect(acknowledgeServerMutationReceipts('accepted-mutation', 1, 'lineage-a')).resolves.toBe(false)
    expect(factory).not.toHaveBeenCalled()
    expect(mocks.auth).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('admits recovery transport after ownership validation while ordinary commands remain closed', async () => {
    const operation = beginClientSession('client-a')
    authorizeClientWriterRecovery(operation, ownership('client-a', 1))
    await expect(runServerCommand({ command: vi.fn() })).resolves.toEqual({ status: 'unavailable' })
    await expect(
      replayDurableMutationRequests(
        [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 4000 } } }],
        'retained-mutation',
        'lineage-a',
      ),
    ).resolves.toEqual({ status: 'ok' })
    await expect(acknowledgeServerMutationReceipts('accepted-mutation', 1, 'lineage-a')).resolves.toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(canUseClientWriteAccess()).toBe(false)
  })

  it('does not revive old queued factories or replay after demotion and a completed new promotion', async () => {
    becomeWriter()
    const hold = deferred<ServerCommandResult>()
    const firstFactory = vi.fn(() => hold.promise)
    const first = runServerCommand({ command: firstFactory })
    await vi.waitFor(() => expect(firstFactory).toHaveBeenCalledOnce())
    const secondFactory = vi.fn()
    const rollback = vi.fn()
    const second = runServerCommand({ command: secondFactory, rollback })
    const replay = replayDurableMutationRequests(
      [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { maxContext: 4000 } } }],
      'still-staged-mutation',
      'lineage-a',
    )
    loseAndRegainWriteAccess()
    setCachedServerCommandRevision(20)
    hold.resolve({ status: 'ok', ...receipt(2) })

    await expect(first).resolves.toMatchObject({ status: 'ok', revision: 2 })
    await expect(second).resolves.toEqual({ status: 'unavailable' })
    await expect(replay).resolves.toEqual({ status: 'unavailable' })
    expect(secondFactory).not.toHaveBeenCalled()
    expect(rollback).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(peekCachedServerCommandRevision()).toBe(20)
    expect(canUseClientWriteAccess()).toBe(true)
  })

  it('checks the originating role again after an auth await even if the client is writing again', async () => {
    becomeWriter()
    const auth = deferred<string>()
    mocks.auth.mockReturnValueOnce(auth.promise)
    const request = patchRuntimeSettings({ baseRevision: 1, patch: { maxContext: 4000 } })
    await vi.waitFor(() => expect(mocks.auth).toHaveBeenCalledOnce())
    loseAndRegainWriteAccess()
    auth.resolve('test-auth')
    await expect(request).resolves.toEqual({ status: 'unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('settles a late accepted receipt without replaying its old optimistic reconciliation', async () => {
    becomeWriter()
    const response = deferred<Response>()
    vi.mocked(fetch).mockReturnValueOnce(response.promise)
    const reconcile = vi.fn()
    setServerCommandSuccessReconciler(reconcile)
    const request = runServerCommand({
      command: (baseRevision) => patchRuntimeSettings({ baseRevision, patch: { maxContext: 4000 } }),
    })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(deferOwnServerCommandReconciliation(receipt(2).event)).toBe(true)
    observeClientWriter({ sessionId: 'client-b', epoch: 2 })
    setCachedServerCommandRevision(20)
    response.resolve(Response.json(receipt(2)))

    await expect(request).resolves.toMatchObject({ status: 'ok', revision: 2 })
    expect(reconcile).not.toHaveBeenCalled()
    expect(peekCachedServerCommandRevision()).toBe(20)
    await expect(acknowledgeServerMutationReceipts('accepted-mutation', 1, 'lineage-a')).resolves.toBe(false)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not let an old genuine 423 demote a newly recovered writer', async () => {
    becomeWriter()
    const response = deferred<Response>()
    vi.mocked(fetch).mockReturnValueOnce(response.promise)
    const request = patchRuntimeSettings({ baseRevision: 1, patch: { maxContext: 4000 } })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    loseAndRegainWriteAccess()
    response.resolve(
      Response.json({ error: 'active_writer_stale', reason: 'A newer browser owns write access.' }, { status: 423 }),
    )
    await expect(request).resolves.toMatchObject({ status: 'error', reason: 'stale-writer' })
    expect(isWriterAccessLost()).toBe(false)
    expect(getClientSessionSnapshot().lifecycle).toBe('writing')
    expect(canUseClientWriteAccess()).toBe(true)
  })

  it('does not advance a newer role cursor from an old revision-conflict response', async () => {
    becomeWriter()
    const response = deferred<Response>()
    vi.mocked(fetch).mockReturnValueOnce(response.promise)
    const request = patchRuntimeSettings({ baseRevision: 1, patch: { maxContext: 4000 } })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    loseAndRegainWriteAccess()
    setCachedServerCommandRevision(20)
    response.resolve(Response.json({ error: 'revision_conflict', currentRevision: 99 }, { status: 409 }))
    await expect(request).resolves.toMatchObject({ status: 'conflict', currentRevision: 99 })
    expect(peekCachedServerCommandRevision()).toBe(20)
  })

  it('does not reconcile a confirmed direct effect after demotion while earlier events drain', async () => {
    becomeWriter()
    const earlier = deferred<void>()
    const reconcile = vi.fn(async (_event: CommandEvent) => earlier.promise)
    setServerCommandSuccessReconciler(reconcile)
    const operation = withDirectServerCommandEventReconciliation(
      () => true,
      async (confirm) => {
        expect(deferOwnServerCommandReconciliation(receipt(2).event)).toBe(true)
        await confirm(receipt(3).event)
        return 'accepted'
      },
    )
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce())
    expect(reconcile.mock.calls[0][0]).toEqual(receipt(2).event)
    observeClientWriter({ sessionId: 'client-b', epoch: 2 })
    earlier.resolve()
    await expect(operation).resolves.toBe('accepted')
    expect(reconcile).toHaveBeenCalledOnce()
  })

  it('retires remaining old events when demotion happens during an active batch flush', async () => {
    becomeWriter()
    const flush = deferred<void>()
    const reconcile = vi.fn(async (_event: CommandEvent) => flush.promise)
    setServerCommandSuccessReconciler(reconcile)
    const first = runServerCommand({ command: async () => ({ status: 'ok', ...receipt(2) }) })
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce())
    const second = runServerCommand({ command: async () => ({ status: 'ok', ...receipt(3) }) })
    await vi.waitFor(() => expect(peekCachedServerCommandRevision()).toBe(3))
    observeClientWriter({ sessionId: 'client-b', epoch: 2 })
    flush.resolve()
    await Promise.all([first, second])
    expect(reconcile).toHaveBeenCalledOnce()
    expect(reconcile.mock.calls[0][0]).toEqual(receipt(2).event)
  })
})
