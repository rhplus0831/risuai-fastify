import { vi } from 'vitest'
import type { DurableMutationIntent } from './pendingMutationOutbox'

export function settingsIntent(value: string): DurableMutationIntent {
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

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export function stubCryptoWithoutSubtle(): void {
  const cryptoApi = globalThis.crypto
  vi.stubGlobal('crypto', {
    getRandomValues: cryptoApi.getRandomValues.bind(cryptoApi),
    randomUUID: cryptoApi.randomUUID.bind(cryptoApi),
  })
}

export async function readRawMutation(mutationId: string): Promise<Record<string, unknown> | undefined> {
  const database = await openRawOutboxDatabase()
  try {
    const transaction = database.transaction('mutations', 'readonly')
    const record = await rawRequestResult<Record<string, unknown> | undefined>(
      transaction.objectStore('mutations').get(mutationId),
    )
    await rawTransactionDone(transaction)
    return record
  } finally {
    database.close()
  }
}

export async function readRawOrderCounters(): Promise<Array<Record<string, unknown>>> {
  const database = await openRawOutboxDatabase()
  try {
    const transaction = database.transaction('orders', 'readonly')
    const counters = await rawRequestResult<Array<Record<string, unknown>>>(transaction.objectStore('orders').getAll())
    await rawTransactionDone(transaction)
    return counters
  } finally {
    database.close()
  }
}

export async function deleteRawOrderCounters(): Promise<void> {
  const database = await openRawOutboxDatabase()
  try {
    const transaction = database.transaction('orders', 'readwrite')
    transaction.objectStore('orders').clear()
    await rawTransactionDone(transaction)
  } finally {
    database.close()
  }
}

export async function mutateRawOrderCounter(
  mutate: (counter: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const database = await openRawOutboxDatabase()
  try {
    const transaction = database.transaction('orders', 'readwrite')
    const store = transaction.objectStore('orders')
    const [keys, counters] = await Promise.all([
      rawRequestResult<IDBValidKey[]>(store.getAllKeys()),
      rawRequestResult<Array<Record<string, unknown>>>(store.getAll()),
    ])
    if (keys.length !== 1 || counters.length !== 1) throw new Error('Expected one pending-mutation order counter')
    store.put(mutate(counters[0]!), keys[0])
    await rawTransactionDone(transaction)
  } finally {
    database.close()
  }
}

export async function mutateRawMutation(
  mutationId: string,
  mutate: (record: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const database = await openRawOutboxDatabase()
  try {
    const transaction = database.transaction('mutations', 'readwrite')
    const store = transaction.objectStore('mutations')
    const record = await rawRequestResult<Record<string, unknown> | undefined>(store.get(mutationId))
    if (!record) throw new Error(`Missing pending mutation ${mutationId}`)
    mutate(record)
    if (record.mutationId !== mutationId) store.delete(mutationId)
    store.put(record)
    await rawTransactionDone(transaction)
    return record
  } finally {
    database.close()
  }
}

export async function removeRawKeyKind(mutationId: string): Promise<void> {
  await mutateRawMutation(mutationId, (record) => {
    delete record.keyKind
  })
}

export function openRawOutboxDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('risu-pending-mutations-v1', 3)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function rawRequestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function rawTransactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function removeRawDispatchStarted(mutationId: string): Promise<void> {
  await mutateRawMutation(mutationId, (record) => {
    delete record.dispatchStarted
  })
}

export async function corruptRawMutationCiphertext(mutationId: string): Promise<void> {
  await mutateRawMutation(mutationId, (record) => {
    record.ciphertext = new ArrayBuffer(1)
  })
}
