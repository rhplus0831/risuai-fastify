import {
  dispatchDurableMutation,
  dispatchDurableMutationReplay,
  setPendingMutationDiscardNotifier,
  flushPendingMutationReceiptAcknowledgements,
} from './durableMutationDispatch'
const dispatchApi = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  inlineReplay: vi.fn(),
  notify: vi.fn(),
  reload: vi.fn(),
}))
vi.mock('./commands', () => ({
  acknowledgeServerMutationReceipts: dispatchApi.acknowledge,
  enqueueDurableMutationReplay: (execute: () => Promise<unknown>) => execute(),
  replayDurableMutationRequestsInline: dispatchApi.inlineReplay,
  runServerCommandWithoutMutationReceipt: (execute: () => unknown) => execute(),
  runServerCommandWithMutationReceipt: (execute: () => unknown) => execute(),
}))
vi.mock('./activeWriterSession', () => ({ schedulePendingMutationRecoveryReload: dispatchApi.reload }))
vi.mock('../alert', () => ({ alertError: vi.fn() }))
import { IDBFactory, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { registerRetainedChatProjection } from './chatRetainedProjection'
import {
  beginPendingMutationDispatch,
  clearPendingMutationOutbox,
  completePendingMutation,
  countBlockingPendingMutationRecords,
  isPendingMutationCurrent,
  isPendingMutationProjectionFenceCurrent,
  pendingMutationProjectionFence,
  pendingMutationSettingsFieldProjectionTarget,
  listPendingMutationReceiptAcknowledgements,
  listPendingMutations,
  preparePendingMutationOutbox,
  readSinglePendingMutationOwner,
  registerPendingMutationDiscardListener,
  replaceStagedPendingMutationIntent,
  resetPendingMutationOutboxForTests,
  stagePendingMutation,
  type DurableMutationIntent,
} from './pendingMutationOutbox'

const initialScope = {
  writerSessionId: 'writer-a',
  writerEpoch: 1,
  databaseLineage: 'database-a',
  requestedWriterWasActive: true,
}
const intent = (value = 'draft'): DurableMutationIntent => ({
  version: 1,
  requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { openAIKey: value } } }],
})

function enterRecovery() {
  const operation = beginClientSession('writer-a')
  authorizeClientWriterRecovery(operation, {
    databaseLineage: 'database-a',
    writer: { sessionId: 'writer-a', epoch: 1 },
  })
  setClientConnectionState('live')
  setClientProjectionReady(true)
  return operation
}

function enterWriter(): void {
  expect(completeClientWriterRecovery(enterRecovery())).toBe(true)
}

function demoteAndRepromote(): void {
  demoteClientSession()
  const operation = beginClientPromotion()!
  const current = getClientSessionSnapshot()
  authorizeClientWriterRecovery(operation, {
    databaseLineage: current.databaseLineage!,
    writer: { sessionId: current.sessionId, epoch: current.writer!.epoch + 1 },
  })
  expect(completeClientWriterRecovery(operation)).toBe(true)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(async () => {
  resetClientSessionForTests()
  dispatchApi.acknowledge.mockReset().mockResolvedValue(true)
  dispatchApi.inlineReplay.mockReset().mockResolvedValue({ status: 'ok' })
  dispatchApi.notify.mockReset()
  dispatchApi.reload.mockReset()
  setPendingMutationDiscardNotifier(dispatchApi.notify)
  vi.stubGlobal('indexedDB', new IDBFactory())
  resetPendingMutationOutboxForTests()
  await preparePendingMutationOutbox(initialScope)
})

afterEach(async () => {
  setPendingMutationDiscardNotifier(null)
  await clearPendingMutationOutbox()
  resetPendingMutationOutboxForTests()
  resetClientSessionForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('pending mutation reader admission', () => {
  it('does not prepare, discover, stage, mark or list replay intent from a reader', async () => {
    const existing = stagePendingMutation('existing', intent())
    await existing.ready
    enterWriter()
    demoteClientSession()
    const onOwnershipChange = vi.fn()
    const reads = vi.spyOn(FakeObjectStore.prototype, 'getAll')
    await expect(
      preparePendingMutationOutbox({ ...initialScope, databaseLineage: 'replacement', onOwnershipChange }),
    ).rejects.toThrow('client_recovery_access_required')
    expect(() => stagePendingMutation('reader', intent())).toThrow('client_write_access_required')
    await expect(replaceStagedPendingMutationIntent(existing, intent('changed'))).resolves.toEqual({
      status: 'superseded',
    })
    await expect(beginPendingMutationDispatch(existing)).resolves.toBe('superseded')
    expect(existing.phase).toBe('staged')
    await expect(listPendingMutations()).resolves.toEqual([])
    await expect(readSinglePendingMutationOwner()).resolves.toBeNull()
    await expect(countBlockingPendingMutationRecords()).resolves.toBe(0)
    expect(reads).not.toHaveBeenCalled()
    expect(onOwnershipChange).not.toHaveBeenCalled()
    expect(await isPendingMutationCurrent(existing)).toBe(true)
  })

  it('admits authenticated recovery for prepare/replay but not ordinary stages or placeholder successors', async () => {
    const existing = stagePendingMutation('existing', intent())
    await existing.ready
    enterRecovery()
    await expect(preparePendingMutationOutbox(initialScope)).resolves.toEqual({ discarded: 0 })
    expect((await listPendingMutations()).map(({ handle }) => handle.mutationId)).toEqual([existing.mutationId])
    expect(() => stagePendingMutation('ordinary', intent())).toThrow('client_write_access_required')
    await expect(replaceStagedPendingMutationIntent(existing, intent('new'))).resolves.toEqual({ status: 'superseded' })
    await expect(beginPendingMutationDispatch((await listPendingMutations())[0].handle)).resolves.toBe('persisted')
    expect(await rawMutation(existing.mutationId)).toMatchObject({ dispatchStarted: true })
  })

  it('cannot stage after a body normalizer crosses demotion and repromotion', () => {
    enterWriter()
    const request = intent()
    request.requests[0].body = {
      toJSON() {
        demoteAndRepromote()
        return { patch: { openAIKey: 'stale' } }
      },
    }
    expect(() => stagePendingMutation('stale-normalization', request)).toThrow('client_write_operation_stale')
  })

  it('does not revive optimistic fences on a same-epoch writer resume', async () => {
    enterWriter()
    const handle = stagePendingMutation('same-epoch', intent())
    await handle.ready
    const fence = pendingMutationProjectionFence(handle, pendingMutationSettingsFieldProjectionTarget('openAIKey'))!
    expect(isPendingMutationProjectionFenceCurrent(fence)).toBe(true)
    demoteClientSession()
    const promotion = beginClientPromotion()!
    authorizeClientWriterRecovery(promotion, {
      databaseLineage: 'database-a',
      writer: { sessionId: 'writer-a', epoch: 1 },
    })
    await preparePendingMutationOutbox(initialScope)
    expect(completeClientWriterRecovery(promotion)).toBe(true)
    expect(isPendingMutationProjectionFenceCurrent(fence)).toBe(false)
    expect(await isPendingMutationCurrent(handle)).toBe(true)
  })

  it('does not reset retained drafts or discard encrypted intent on a managed epoch change', async () => {
    enterWriter()
    const existing = stagePendingMutation('existing', intent())
    await existing.ready
    const invalidated = vi.fn()
    const resetOwners = vi.fn()
    const discarded = vi.fn()
    const releaseProjection = registerRetainedChatProjection(
      { kind: 'chat-body', chatId: 'chat-a' },
      vi.fn(),
      invalidated,
    )
    const stopDiscard = registerPendingMutationDiscardListener(discarded)
    demoteAndRepromote()
    await expect(
      preparePendingMutationOutbox({
        ...initialScope,
        writerEpoch: 2,
        requestedWriterWasActive: false,
        onOwnershipChange: resetOwners,
      }),
    ).resolves.toEqual({ discarded: 0 })
    expect(resetOwners).not.toHaveBeenCalled()
    expect(invalidated).not.toHaveBeenCalled()
    expect(discarded).not.toHaveBeenCalled()
    expect(await isPendingMutationCurrent(existing)).toBe(true)
    expect((await listPendingMutations())[0]?.handle.writerEpoch).toBe(1)
    releaseProjection()
    stopDiscard()
  })

  it('finishes an admitted original-scope encrypted write after demotion, then lets recovery see it', async () => {
    enterWriter()
    const gate = deferred<void>()
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle)
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      await gate.promise
      return encrypt(...args)
    })
    const handle = stagePendingMutation('queued-before-loss', intent())
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
    demoteClientSession()
    await expect(listPendingMutations()).resolves.toEqual([])
    gate.resolve(undefined)
    await expect(handle.ready).resolves.toBe('persisted')
    expect(await rawMutation(handle.mutationId)).toMatchObject({
      ownerWriterSessionId: 'writer-a',
      writerEpoch: 1,
      dispatchStarted: false,
    })
    const promotion = beginClientPromotion()!
    authorizeClientWriterRecovery(promotion, {
      databaseLineage: 'database-a',
      writer: { sessionId: 'writer-a', epoch: 2 },
    })
    await preparePendingMutationOutbox({ ...initialScope, writerEpoch: 2 })
    expect((await listPendingMutations()).map(({ handle }) => handle.mutationId)).toEqual([handle.mutationId])
  })

  it('stops stale preparation behind admitted encryption without ownership callbacks or deletion', async () => {
    enterWriter()
    const gate = deferred<void>()
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle)
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      await gate.promise
      return encrypt(...args)
    })
    const handle = stagePendingMutation('queued-before-loss', intent())
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
    const onOwnershipChange = vi.fn()
    const preparation = preparePendingMutationOutbox({
      ...initialScope,
      databaseLineage: 'database-b',
      onOwnershipChange,
    })
    const rejected = expect(preparation).rejects.toThrow('client_recovery_operation_stale')
    demoteAndRepromote()
    gate.resolve(undefined)
    await rejected
    await expect(handle.ready).resolves.toBe('persisted')
    expect(onOwnershipChange).not.toHaveBeenCalled()
    expect(await isPendingMutationCurrent(handle)).toBe(true)
    expect((await listPendingMutations()).map(({ handle }) => handle.mutationId)).toEqual([handle.mutationId])
  })

  it('aborts the actual prepare transaction when a read callback crosses demotion and repromotion', async () => {
    const existing = stagePendingMutation('existing', intent())
    await existing.ready
    enterWriter()
    const getAll = FakeObjectStore.prototype.getAll
    let injected = false
    const spy = vi.spyOn(FakeObjectStore.prototype, 'getAll').mockImplementation(function (...args) {
      const request = getAll.apply(this, args)
      if (!injected && this.name === 'mutations') {
        injected = true
        request.addEventListener('success', demoteAndRepromote, { once: true })
      }
      return request
    })
    const onOwnershipChange = vi.fn()
    await expect(
      preparePendingMutationOutbox({ ...initialScope, databaseLineage: 'database-b', onOwnershipChange }),
    ).rejects.toThrow('client_recovery_operation_stale')
    spy.mockRestore()
    expect(onOwnershipChange).not.toHaveBeenCalled()
    expect(await isPendingMutationCurrent(existing)).toBe(true)
    expect((await listPendingMutations()).map(({ handle }) => handle.mutationId)).toEqual([existing.mutationId])
  })

  it('does not replace a placeholder after its encryption crosses demotion and repromotion', async () => {
    enterWriter()
    const handle = stagePendingMutation('placeholder', intent('before'))
    await handle.ready
    const gate = deferred<void>()
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle)
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      await gate.promise
      return encrypt(...args)
    })
    const replacement = replaceStagedPendingMutationIntent(handle, intent('after'))
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
    demoteAndRepromote()
    gate.resolve(undefined)
    await expect(replacement).resolves.toEqual({ status: 'superseded' })
    expect((await listPendingMutations())[0]?.intent).toEqual(intent('before'))
  })

  it('does not return decrypted replay entries from a previous role generation', async () => {
    const handle = stagePendingMutation('existing', intent())
    await handle.ready
    enterWriter()
    const gate = deferred<void>()
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
    const spy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => {
      await gate.promise
      return decrypt(...args)
    })
    const listing = listPendingMutations()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
    demoteAndRepromote()
    gate.resolve(undefined)
    await expect(listing).resolves.toEqual([])
    expect(await isPendingMutationCurrent(handle)).toBe(true)
  })

  it('does not dispatch a real replay queued behind a lock from an older role generation', async () => {
    enterWriter()
    const handle = stagePendingMutation('queued-replay', intent())
    await handle.ready
    const gate = deferred<void>()
    let lockHeld = false
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, _options: unknown, task: () => Promise<unknown>) => {
          if (!lockHeld) {
            lockHeld = true
            await gate.promise
          }
          return task()
        },
      },
    })
    const pending = dispatchDurableMutationReplay(handle, intent())
    await vi.waitFor(() => expect(lockHeld).toBe(true))
    demoteAndRepromote()
    gate.resolve(undefined)
    await expect(pending).resolves.toEqual({ disposition: 'retained' })
    expect(dispatchApi.inlineReplay).not.toHaveBeenCalled()
    expect(await rawMutation(handle.mutationId)).toMatchObject({ dispatchStarted: false })
    const fresh = (await listPendingMutations())[0]
    await expect(dispatchDurableMutationReplay(fresh.handle, fresh.intent)).resolves.toMatchObject({
      disposition: 'succeeded',
    })
    expect(dispatchApi.inlineReplay).toHaveBeenCalledOnce()
  })

  it('parks the server ACK after an old replay receives accepted success across repromotion', async () => {
    enterWriter()
    const handle = stagePendingMutation('accepted-replay', intent())
    await handle.ready
    const response = deferred<{ status: 'ok' }>()
    dispatchApi.inlineReplay.mockReturnValueOnce(response.promise)
    const pending = dispatchDurableMutationReplay(handle, intent())
    await vi.waitFor(() => expect(dispatchApi.inlineReplay).toHaveBeenCalledOnce())
    demoteAndRepromote()
    response.resolve({ status: 'ok' })
    await expect(pending).resolves.toMatchObject({ disposition: 'succeeded' })
    expect(dispatchApi.acknowledge).not.toHaveBeenCalled()
    expect(await listPendingMutationReceiptAcknowledgements()).toMatchObject([{ mutationId: handle.mutationId }])
  })

  it('does not revive receipt cleanup held behind a lock after repromotion', async () => {
    enterWriter()
    for (const key of ['first-accepted', 'second-accepted']) {
      const handle = stagePendingMutation(key, intent())
      await handle.ready
      await completePendingMutation(handle, 1)
    }
    const gate = deferred<void>()
    let lockHeld = false
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, _options: unknown, task: () => Promise<unknown>) => {
          if (!lockHeld) {
            lockHeld = true
            await gate.promise
          }
          return task()
        },
      },
    })
    const pending = flushPendingMutationReceiptAcknowledgements()
    await vi.waitFor(() => expect(lockHeld).toBe(true))
    demoteAndRepromote()
    gate.resolve(undefined)
    await pending
    expect(dispatchApi.acknowledge).not.toHaveBeenCalled()
    expect(await listPendingMutationReceiptAcknowledgements()).toHaveLength(2)
    await flushPendingMutationReceiptAcknowledgements()
    expect(dispatchApi.acknowledge).toHaveBeenCalledTimes(2)
  })

  it.each(['accepted', 'rejected'] as const)(
    'settles an ordinary delayed %s result without new-role ACK or notification effects',
    async (outcome) => {
      enterWriter()
      const handle = stagePendingMutation('ordinary-held', intent())
      const response = deferred<any>()
      const request = vi.fn(() => response.promise)
      const pending = dispatchDurableMutation(handle, intent(), (options) => options.executionWrapper!(request))
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
      demoteAndRepromote()
      const result =
        outcome === 'accepted'
          ? {
              status: 'ok' as const,
              revision: 1,
              event: { type: 'settings.updated', resource: 'settings', revision: 1 },
            }
          : { status: 'error' as const, reason: 'invalid-request' as const, error: 'invalid request' }
      response.resolve(result)
      await expect(pending).resolves.toEqual(result)
      expect(await isPendingMutationCurrent(handle)).toBe(false)
      expect(dispatchApi.acknowledge).not.toHaveBeenCalled()
      expect(dispatchApi.notify).not.toHaveBeenCalled()
      expect(dispatchApi.reload).not.toHaveBeenCalled()
      const acknowledgements = await listPendingMutationReceiptAcknowledgements()
      expect(acknowledgements).toHaveLength(outcome === 'accepted' ? 1 : 0)
      if (outcome === 'accepted') expect(acknowledgements[0].mutationId).toBe(handle.mutationId)
    },
  )

  it.each(['accepted', 'rejected'] as const)(
    'settles a delayed %s predecessor without ACK, notification, reload or successor dispatch',
    async (outcome) => {
      enterWriter()
      const predecessor = stagePendingMutation('predecessor-held', intent('before'))
      await predecessor.ready
      const successor = stagePendingMutation('predecessor-held', intent('after'))
      const response = deferred<any>()
      dispatchApi.inlineReplay.mockReturnValueOnce(response.promise)
      const request = vi.fn(async () => ({
        status: 'ok' as const,
        revision: 2,
        event: { type: 'settings.updated', resource: 'settings', revision: 2 },
      }))
      const pending = dispatchDurableMutation(successor, intent('after'), (options) =>
        options.executionWrapper!(request),
      )
      await vi.waitFor(() => expect(dispatchApi.inlineReplay).toHaveBeenCalledOnce())
      demoteAndRepromote()
      response.resolve(
        outcome === 'accepted'
          ? { status: 'ok' }
          : { status: 'error', reason: 'invalid-request', error: 'invalid predecessor' },
      )
      await expect(pending).resolves.toEqual({ status: 'unavailable' })
      expect(await isPendingMutationCurrent(predecessor)).toBe(false)
      expect(await isPendingMutationCurrent(successor)).toBe(true)
      expect(request).not.toHaveBeenCalled()
      expect(dispatchApi.acknowledge).not.toHaveBeenCalled()
      expect(dispatchApi.notify).not.toHaveBeenCalled()
      expect(dispatchApi.reload).not.toHaveBeenCalled()
      expect(await listPendingMutationReceiptAcknowledgements()).toHaveLength(outcome === 'accepted' ? 1 : 0)
    },
  )

  it('settles an already accepted exact handle locally while a reader and retains its server ACK', async () => {
    enterWriter()
    const handle = stagePendingMutation('sent-before-loss', intent())
    await beginPendingMutationDispatch(handle)
    demoteClientSession()
    await expect(completePendingMutation(handle, 1)).resolves.toBe('deleted')
    expect(await isPendingMutationCurrent(handle)).toBe(false)
    expect(await listPendingMutationReceiptAcknowledgements()).toMatchObject([
      { mutationId: handle.mutationId, requestCount: 1, databaseLineage: 'database-a' },
    ])
  })
})

async function rawMutation(mutationId: string): Promise<unknown> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('risu-pending-mutations-v1', 3)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction('mutations', 'readonly').objectStore('mutations').get(mutationId)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}
