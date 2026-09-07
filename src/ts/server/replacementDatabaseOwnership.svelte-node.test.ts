import {
  authorizeClientWriterRecovery,
  beginClientPromotion,
  beginClientSession,
  completeClientWriterRecovery,
  demoteClientSession,
  getClientSessionSnapshot,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
} from '../clientSession'
import * as outboxApi from './pendingMutationOutbox'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

vi.mock('../process/modules', () => ({
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModules: vi.fn(() => []),
  moduleUpdate: vi.fn(),
}))

import { getActiveWriterSessionId } from './activeWriterSession'
import { registerDurableMutationSettlementListener } from './durableMutationDispatch'
import {
  clearPendingMutationOutbox,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
  stagePendingMutation,
} from './pendingMutationOutbox'
import {
  adoptReplacementDatabaseOwnership,
  beginLocalReplacementDatabaseOperation,
  hasPendingReplacementDatabaseRefresh,
  isReplacementDatabaseOwnershipRefreshPending,
  markReplacementDatabaseOwnershipRefreshed,
  waitForLocalReplacementDatabaseOperations,
  wasReplacementDatabaseOwnershipRefreshed,
} from './replacementDatabaseOwnership'

beforeEach(async () => {
  resetClientSessionForTests()
  vi.stubGlobal('indexedDB', new IDBFactory())
  resetPendingMutationOutboxForTests()
  await preparePendingMutationOutbox({
    writerSessionId: getActiveWriterSessionId(),
    writerEpoch: 1,
    databaseLineage: 'database-before',
    requestedWriterWasActive: true,
  })
})

afterEach(async () => {
  await clearPendingMutationOutbox()
  resetPendingMutationOutboxForTests()
  resetClientSessionForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('replacement database ownership', () => {
  it('settles local listeners even when another tab already removed the shared outbox row', async () => {
    const handle = stagePendingMutation('settings:exact', {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/display', body: { patch: { notification: false } } }],
    })
    await expect(handle.ready).resolves.toBe('persisted')
    const listener = vi.fn()
    const cleanup = registerDurableMutationSettlementListener(handle.mutationId, listener)
    await clearPendingMutationOutbox()

    await expect(
      adoptReplacementDatabaseOwnership({ databaseLineage: 'database-restored', writerEpoch: 2 }),
    ).resolves.toEqual({ discarded: 1, ownershipChanged: true })

    expect(listener).toHaveBeenCalledWith('discarded', {})
    expect(hasPendingReplacementDatabaseRefresh()).toBe(true)
    expect(isReplacementDatabaseOwnershipRefreshPending({ databaseLineage: 'database-restored', writerEpoch: 2 })).toBe(
      true,
    )
    expect(wasReplacementDatabaseOwnershipRefreshed({ databaseLineage: 'database-restored', writerEpoch: 2 })).toBe(
      false,
    )
    await expect(
      adoptReplacementDatabaseOwnership({ databaseLineage: 'database-restored', writerEpoch: 2 }),
    ).resolves.toEqual({ discarded: 0, ownershipChanged: false })
    expect(listener).toHaveBeenCalledOnce()
    markReplacementDatabaseOwnershipRefreshed({ databaseLineage: 'database-restored', writerEpoch: 2 })
    expect(hasPendingReplacementDatabaseRefresh()).toBe(false)
    expect(wasReplacementDatabaseOwnershipRefreshed({ databaseLineage: 'database-restored', writerEpoch: 2 })).toBe(
      true,
    )
    cleanup()
  })

  it('holds replacement events until the initiating local operation finishes', async () => {
    const finish = beginLocalReplacementDatabaseOperation()
    let settled = false
    const waiting = waitForLocalReplacementDatabaseOperations().then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    await waiting
    expect(settled).toBe(true)
  })
})

function enterManagedReplacementWriter(): void {
  const sessionId = getActiveWriterSessionId()
  const operation = beginClientSession(sessionId)
  authorizeClientWriterRecovery(operation, { databaseLineage: 'database-before', writer: { sessionId, epoch: 1 } })
  setClientConnectionState('live')
  setClientProjectionReady(true)
  expect(completeClientWriterRecovery(operation)).toBe(true)
}

function repromoteReplacementWriter(): void {
  demoteClientSession()
  const operation = beginClientPromotion()!
  const session = getClientSessionSnapshot()
  authorizeClientWriterRecovery(operation, {
    databaseLineage: session.databaseLineage!,
    writer: { sessionId: session.sessionId, epoch: session.writer!.epoch + 1 },
  })
  expect(completeClientWriterRecovery(operation)).toBe(true)
}

describe('replacement ownership session guards', () => {
  it('does not prepare or adopt replacement ownership from a reader', async () => {
    enterManagedReplacementWriter()
    demoteClientSession()
    const prepare = vi.spyOn(outboxApi, 'preparePendingMutationOutbox')
    await expect(
      adoptReplacementDatabaseOwnership({ databaseLineage: 'database-replaced', writerEpoch: 2 }),
    ).resolves.toEqual({ discarded: 0, ownershipChanged: false })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('does not invoke delayed owner reset or settlement callbacks after repromotion', async () => {
    enterManagedReplacementWriter()
    const handle = stagePendingMutation('settings:retained', {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/display', body: { patch: { notification: false } } }],
    })
    await handle.ready
    const listener = vi.fn()
    const unregister = registerDurableMutationSettlementListener(handle.mutationId, listener)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(outboxApi, 'preparePendingMutationOutbox').mockImplementationOnce(async (input) => {
      await gate
      input.onOwnershipChange?.()
      return { discarded: 0 }
    })
    const pending = adoptReplacementDatabaseOwnership({ databaseLineage: 'database-replaced', writerEpoch: 2 })
    repromoteReplacementWriter()
    release()
    await expect(pending).resolves.toEqual({ discarded: 0, ownershipChanged: false })
    expect(listener).not.toHaveBeenCalled()
    expect(await outboxApi.isPendingMutationCurrent(handle)).toBe(true)
    unregister()
  })

  it('does not dispose retained settlements when only the managed writer epoch changes', async () => {
    enterManagedReplacementWriter()
    const handle = stagePendingMutation('settings:retained', {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/display', body: { patch: { notification: false } } }],
    })
    await handle.ready
    const listener = vi.fn()
    const unregister = registerDurableMutationSettlementListener(handle.mutationId, listener)
    repromoteReplacementWriter()
    await expect(
      adoptReplacementDatabaseOwnership({ databaseLineage: 'database-before', writerEpoch: 2 }),
    ).resolves.toEqual({ discarded: 0, ownershipChanged: false })
    expect(listener).not.toHaveBeenCalled()
    expect(await outboxApi.isPendingMutationCurrent(handle)).toBe(true)
    unregister()
  })
})
