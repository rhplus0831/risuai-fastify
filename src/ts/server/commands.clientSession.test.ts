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
  for (const milestone of ['entry', 'shell-mounted', 'observer-ready', 'writer-ready'] as const) {
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
