import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DurableMutationIntent } from './pendingMutationOutbox'

const commandApi = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  inlineReplay: vi.fn(),
  withoutReceipt: vi.fn(<T>(execute: () => Promise<T>) => execute()),
  withReceipt: vi.fn(<T>(execute: () => Promise<T>) => execute()),
}))

vi.mock('./commands', () => ({
  acknowledgeServerMutationReceipts: commandApi.acknowledge,
  replayDurableMutationRequestsInline: commandApi.inlineReplay,
  enqueueDurableMutationReplay: vi.fn(async (execute: () => Promise<unknown>) => execute()),
  runServerCommandWithoutMutationReceipt: commandApi.withoutReceipt,
  runServerCommandWithMutationReceipt: commandApi.withReceipt,
}))
vi.mock('./activeWriterSession', () => ({
  schedulePendingMutationRecoveryReload: vi.fn(),
}))

type OutboxModule = typeof import('./pendingMutationOutbox')
type DurableDispatchModule = typeof import('./durableMutationDispatch')

const databaseName = 'risu-pending-mutations-v1'
const databaseLineage = 'database-cross-tab'
const writerSessionId = 'writer-cross-tab'

function settingsIntent(value: string): DurableMutationIntent {
  return {
    version: 1,
    requests: [
      {
        method: 'PATCH',
        path: '/settings/runtime',
        body: { patch: { openAIKey: value } },
      },
    ],
  }
}

class DeterministicExclusiveLockManager {
  private readonly tails = new Map<string, Promise<void>>()

  request<T>(
    name: string,
    _options: { mode: 'exclusive' },
    task: (lock: { mode: 'exclusive'; name: string }) => T | PromiseLike<T>,
  ): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve()
    const running = previous.then(() => task({ mode: 'exclusive', name }))
    const tail = running.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(name, tail)
    void tail.finally(() => {
      if (this.tails.get(name) === tail) this.tails.delete(name)
    })
    return running
  }
}

let tabA: OutboxModule | null = null
let tabB: OutboxModule | null = null

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('navigator', { locks: new DeterministicExclusiveLockManager() })
  commandApi.acknowledge.mockReset()
  commandApi.acknowledge.mockResolvedValue(true)
  commandApi.inlineReplay.mockReset()
  commandApi.inlineReplay.mockResolvedValue({ status: 'ok' })
  commandApi.withoutReceipt.mockClear()
  commandApi.withReceipt.mockClear()
})

afterEach(async () => {
  await tabB?.clearPendingMutationOutbox()
  tabA?.resetPendingMutationOutboxForTests()
  tabB?.resetPendingMutationOutboxForTests()
  tabA = null
  tabB = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('pending mutation outbox cross-tab staging', () => {
  it('keeps a later tab behind the earlier encryption and publishes order only with each row', async () => {
    tabA = await importFreshOutboxModule()
    await prepare(tabA, 1)
    tabB = await importFreshOutboxModule()
    await prepare(tabB, 1)

    const encryptionGate = deferred<void>()
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
    const encryptSpy = vi
      .spyOn(globalThis.crypto.subtle, 'encrypt')
      .mockImplementationOnce(async (algorithm, key, data) => {
        await encryptionGate.promise
        return originalEncrypt(algorithm, key, data)
      })

    const older = tabA.stagePendingMutation('settings:runtime', settingsIntent('old'))
    await vi.waitFor(() => expect(encryptSpy).toHaveBeenCalledOnce())
    const newer = tabB.stagePendingMutation('settings:runtime', settingsIntent('new'))

    await expect(settlementWithin(newer.ready, 30)).resolves.toBe('pending')
    expect(await readRawState()).toEqual({ counters: [], mutations: [] })

    encryptionGate.resolve()
    await expect(Promise.all([older.ready, newer.ready])).resolves.toEqual(['persisted', 'persisted'])

    const state = await readRawState()
    expect(state.mutations.map((row) => row.order)).toEqual([1, 2])
    expect(state.mutations.map((row) => row.mutationId)).toEqual([older.mutationId, newer.mutationId])
    expect(state.counters).toEqual([
      {
        version: 1,
        writerSessionId,
        databaseLineage,
        lastCommittedOrder: 2,
      },
    ])
    await expect(tabB.listPendingMutations()).resolves.toEqual([
      expect.objectContaining({ intent: settingsIntent('old') }),
      expect.objectContaining({ intent: settingsIntent('new') }),
    ])
  })

  it('drains the earlier tab before the later request and never resends the settled predecessor', async () => {
    tabA = await importFreshOutboxModule()
    await prepare(tabA, 1)
    const durableA = await import('./durableMutationDispatch')
    tabB = await importFreshOutboxModule()
    await prepare(tabB, 1)
    const durableB = await import('./durableMutationDispatch')

    const encryptionGate = deferred<void>()
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
    const encryptSpy = vi
      .spyOn(globalThis.crypto.subtle, 'encrypt')
      .mockImplementationOnce(async (algorithm, key, data) => {
        await encryptionGate.promise
        return originalEncrypt(algorithm, key, data)
      })
    const oldIntent = settingsIntent('old')
    const newIntent = settingsIntent('new')
    const older = tabA.stagePendingMutation('settings:runtime', oldIntent)
    await vi.waitFor(() => expect(encryptSpy).toHaveBeenCalledOnce())
    const newer = tabB.stagePendingMutation('settings:runtime', newIntent)
    const requestOrder: string[] = []
    commandApi.inlineReplay.mockImplementation(async (_requests, mutationId) => {
      requestOrder.push(`replay:${mutationId}`)
      return { status: 'ok' }
    })
    const newerRequest = vi.fn(async () => {
      requestOrder.push(`request:${newer.mutationId}`)
      return acceptedResult()
    })
    const newerDispatch = durableB.dispatchDurableMutation(newer, newIntent, wrappedDispatch(newerRequest))

    await expect(settlementWithin(newer.ready, 30)).resolves.toBe('pending')
    expect(newerRequest).not.toHaveBeenCalled()
    expect(commandApi.inlineReplay).not.toHaveBeenCalled()

    encryptionGate.resolve()
    await expect(newerDispatch).resolves.toMatchObject({ status: 'ok' })
    expect(requestOrder).toEqual([`replay:${older.mutationId}`, `request:${newer.mutationId}`])
    expect(commandApi.inlineReplay).toHaveBeenCalledWith(oldIntent.requests, older.mutationId, databaseLineage)
    expect(await readRawState()).toMatchObject({
      counters: [expect.objectContaining({ lastCommittedOrder: 2 })],
      mutations: [],
    })
    expect(commandApi.acknowledge.mock.calls.map(([mutationId]) => mutationId)).toEqual([
      older.mutationId,
      newer.mutationId,
    ])

    const olderRequest = vi.fn(async () => acceptedResult())
    await expect(durableA.dispatchDurableMutation(older, oldIntent, wrappedDispatch(olderRequest))).resolves.toEqual({
      status: 'unavailable',
    })
    expect(olderRequest).not.toHaveBeenCalled()
  })

  it('retries a cross-tab CAS loss with a fresh IV and a higher committed order', async () => {
    // Without Web Locks, separate tabs have separate FIFO fallbacks. The IDB
    // compare-and-swap remains the durable ordering defense.
    vi.stubGlobal('navigator', {})
    tabA = await importFreshOutboxModule()
    await prepare(tabA, 1)
    tabB = await importFreshOutboxModule()
    await prepare(tabB, 1)

    const encryptionGate = deferred<void>()
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
    const encryptionIvs: number[][] = []
    const encryptSpy = vi
      .spyOn(globalThis.crypto.subtle, 'encrypt')
      .mockImplementation(async (algorithm, key, data) => {
        encryptionIvs.push(Array.from(new Uint8Array((algorithm as AesGcmParams).iv as ArrayBuffer)))
        if (encryptionIvs.length === 1) await encryptionGate.promise
        return originalEncrypt(algorithm, key, data)
      })

    const older = tabA.stagePendingMutation('settings:runtime', settingsIntent('old'))
    await vi.waitFor(() => expect(encryptSpy).toHaveBeenCalledOnce())
    const newer = tabB.stagePendingMutation('settings:runtime', settingsIntent('new'))
    await expect(newer.ready).resolves.toBe('persisted')
    expect(await readRawState()).toMatchObject({
      counters: [expect.objectContaining({ lastCommittedOrder: 1 })],
      mutations: [expect.objectContaining({ mutationId: newer.mutationId, order: 1 })],
    })

    encryptionGate.resolve()
    await expect(older.ready).resolves.toBe('persisted')

    expect(encryptSpy).toHaveBeenCalledTimes(3)
    expect(encryptionIvs[2]).not.toEqual(encryptionIvs[0])
    expect(await readRawState()).toMatchObject({
      counters: [expect.objectContaining({ lastCommittedOrder: 2 })],
      mutations: [
        expect.objectContaining({ mutationId: newer.mutationId, order: 1 }),
        expect.objectContaining({ mutationId: older.mutationId, order: 2 }),
      ],
    })
    expect((await tabA.listPendingMutations()).map((entry) => entry.intent)).toEqual([
      settingsIntent('new'),
      settingsIntent('old'),
    ])
  })

  it('shares the stage lock and committed counter across writer epochs', async () => {
    tabA = await importFreshOutboxModule()
    await prepare(tabA, 1)
    const oldEpoch = tabA.stagePendingMutation('settings:runtime', settingsIntent('old-epoch'))
    await oldEpoch.ready

    tabB = await importFreshOutboxModule()
    await prepare(tabB, 2)
    const newEpoch = tabB.stagePendingMutation('settings:runtime', settingsIntent('new-epoch'))
    await newEpoch.ready

    const state = await readRawState()
    expect(state.counters).toEqual([
      expect.objectContaining({
        writerSessionId,
        databaseLineage,
        lastCommittedOrder: 2,
      }),
    ])
    expect(state.mutations).toEqual([
      expect.objectContaining({ mutationId: oldEpoch.mutationId, order: 1, writerEpoch: 1 }),
      expect.objectContaining({ mutationId: newEpoch.mutationId, order: 2, writerEpoch: 2 }),
    ])
    expect((await tabB.listPendingMutations()).map((entry) => entry.intent)).toEqual([
      settingsIntent('old-epoch'),
      settingsIntent('new-epoch'),
    ])
    await expect(tabB.listPendingMutationPredecessors(newEpoch)).resolves.toMatchObject({
      status: 'ok',
      entries: [
        expect.objectContaining({
          handle: expect.objectContaining({ mutationId: oldEpoch.mutationId, writerEpoch: 1 }),
          intent: settingsIntent('old-epoch'),
        }),
      ],
    })
  })

  it('releases the stage lock after pre-commit encryption failure without publishing an order', async () => {
    tabA = await importFreshOutboxModule()
    await prepare(tabA, 1)
    tabB = await importFreshOutboxModule()
    await prepare(tabB, 1)

    const encryptionEntered = deferred<void>()
    const encryptionGate = deferred<void>()
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(globalThis.crypto.subtle, 'encrypt')
      .mockImplementationOnce(async () => {
        encryptionEntered.resolve()
        await encryptionGate.promise
        throw new Error('simulated tab death before commit')
      })
      .mockImplementation((algorithm, key, data) => originalEncrypt(algorithm, key, data))

    const failed = tabA.stagePendingMutation('settings:runtime', settingsIntent('failed'))
    await encryptionEntered.promise
    const recovered = tabB.stagePendingMutation('settings:runtime', settingsIntent('recovered'))
    await expect(settlementWithin(recovered.ready, 30)).resolves.toBe('pending')

    encryptionGate.resolve()
    await expect(failed.ready).resolves.toBe('unavailable')
    await expect(recovered.ready).resolves.toBe('persisted')
    expect(await readRawState()).toMatchObject({
      counters: [expect.objectContaining({ lastCommittedOrder: 1 })],
      mutations: [expect.objectContaining({ mutationId: recovered.mutationId, order: 1 })],
    })
  })

  it('recovers a committed row from a cold module without relying on lock state', async () => {
    tabA = await importFreshOutboxModule()
    await prepare(tabA, 1)
    const committed = tabA.stagePendingMutation('settings:runtime', settingsIntent('committed'))
    await committed.ready

    tabA = null
    tabB = await importFreshOutboxModule()
    await prepare(tabB, 1)
    const durableB = await import('./durableMutationDispatch')

    const recovered = await tabB.listPendingMutations()
    expect(recovered).toEqual([
      expect.objectContaining({
        intent: settingsIntent('committed'),
        handle: expect.objectContaining({ mutationId: committed.mutationId }),
      }),
    ])
    await expect(durableB.dispatchDurableMutationReplay(recovered[0]!.handle, recovered[0]!.intent)).resolves.toEqual({
      disposition: 'succeeded',
      result: { status: 'ok' },
    })
    expect(commandApi.inlineReplay).toHaveBeenCalledWith(
      settingsIntent('committed').requests,
      committed.mutationId,
      databaseLineage,
    )
    expect((await readRawState()).mutations).toEqual([])
  })
})

async function importFreshOutboxModule(): Promise<OutboxModule> {
  vi.resetModules()
  return import('./pendingMutationOutbox')
}

async function prepare(outbox: OutboxModule, writerEpoch: number): Promise<void> {
  await outbox.preparePendingMutationOutbox({
    writerSessionId,
    writerEpoch,
    databaseLineage,
    requestedWriterWasActive: true,
  })
}

async function settlementWithin(ready: Promise<unknown>, timeoutMs: number): Promise<'pending' | 'settled'> {
  return Promise.race([
    ready.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), timeoutMs)),
  ])
}

async function readRawState(): Promise<{
  counters: Array<Record<string, unknown>>
  mutations: Array<Record<string, unknown>>
}> {
  const database = await openRawDatabase()
  try {
    const transaction = database.transaction(['orders', 'mutations'], 'readonly')
    const counters = await requestResult<Array<Record<string, unknown>>>(transaction.objectStore('orders').getAll())
    const mutations = await requestResult<Array<Record<string, unknown>>>(transaction.objectStore('mutations').getAll())
    await transactionDone(transaction)
    mutations.sort((left, right) => Number(left.order) - Number(right.order))
    return { counters, mutations }
  } finally {
    database.close()
  }
}

function openRawDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 3)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function acceptedResult() {
  return {
    status: 'ok' as const,
    revision: 2,
    event: { type: 'settings.updated', revision: 2, resource: 'settings' },
  }
}

function wrappedDispatch<T>(request: () => Promise<T>) {
  return vi.fn((options: { executionWrapper?: (execute: () => Promise<T>) => Promise<T> }) => {
    return options.executionWrapper ? options.executionWrapper(request) : request()
  })
}
