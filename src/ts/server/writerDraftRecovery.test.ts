import { webcrypto } from 'node:crypto'
import { IDBDatabase as FakeDatabase, IDBFactory } from 'fake-indexeddb'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeClientWriterRecovery,
  beginClientPromotion,
  beginClientSession,
  canUseClientWriteAccess,
  clientSessionStore,
  completeClientWriterRecovery,
  demoteClientSession,
  getClientSessionSnapshot,
  requireClientAuthentication,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
} from '../clientSession'
import {
  initializeDraftRecoveryScope,
  resetDraftRecoveryScopeForTests,
  type DraftRecoveryScope,
} from './draftRecoveryScope'
import {
  WRITER_DRAFT_MAX_AGE_MS,
  WRITER_DRAFT_MAX_RECORD_BYTES,
  WRITER_DRAFT_MAX_RECORDS,
  captureWriterDraftsForReload,
  clearWriterDraftRecoveryView,
  discardWriterDraft,
  flushWriterDraftRecoveryForTests,
  loadWriterDrafts,
  readWriterDraft,
  registerWriterDraftCapture,
  resetWriterDraftRecoveryForTests,
  writerDraftRecoveryStore,
  type WriterDraftCapture,
} from './writerDraftRecovery'

const scope: DraftRecoveryScope = { databaseLineage: 'database-a', writerSessionId: 'writer-a' }

function startWriter(owner = scope): void {
  initializeDraftRecoveryScope(owner)
  const operation = beginClientSession(owner.writerSessionId)
  authorizeClientWriterRecovery(operation, {
    databaseLineage: owner.databaseLineage,
    writer: { sessionId: owner.writerSessionId, epoch: 1 },
  })
  setClientConnectionState('live')
  setClientProjectionReady(true)
  expect(completeClientWriterRecovery(operation)).toBe(true)
}

function promote(): void {
  const operation = beginClientPromotion()
  const state = getClientSessionSnapshot()
  expect(operation).not.toBeNull()
  authorizeClientWriterRecovery(operation!, {
    databaseLineage: state.databaseLineage!,
    writer: { sessionId: state.sessionId, epoch: state.writer!.epoch + 1 },
  })
  expect(completeClientWriterRecovery(operation!)).toBe(true)
}

function draft(value = 'unsaved edit', key = 'settings-model-profile'): WriterDraftCapture {
  return {
    key,
    label: 'Model profile draft',
    route: '/settings/providers',
    fields: [
      { label: 'Model', value },
      { label: 'API key', value: 'secret-credential', secret: true },
    ],
    data: { model: value, apiKey: 'secret-credential', nested: ['unsaved lore'] },
    baseline: { model: 'old model' },
  }
}

async function captureAndSave(input = draft()): Promise<string> {
  const unregister = registerWriterDraftCapture(() => input)
  demoteClientSession()
  unregister()
  const generation = readWriterDraft(input.key)!.generation
  await flushWriterDraftRecoveryForTests()
  return generation
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(async () => {
  await resetWriterDraftRecoveryForTests()
  resetClientSessionForTests()
  resetDraftRecoveryScopeForTests()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('crypto', webcrypto)
  startWriter()
})

afterEach(async () => {
  await resetWriterDraftRecoveryForTests()
  resetDraftRecoveryScopeForTests()
  resetClientSessionForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('writer draft capture boundary', () => {
  it('clones mounted inputs synchronously after revocation and before reader subscribers unmount them', async () => {
    const input = draft()
    let readerPublished = false
    const capture = vi.fn(() => {
      expect(canUseClientWriteAccess()).toBe(false)
      expect(readerPublished).toBe(false)
      return input
    })
    const unregister = registerWriterDraftCapture(capture)
    const stopView = clientSessionStore.subscribe((session) => {
      if (session.lifecycle !== 'reading') return
      readerPublished = true
      unregister()
      input.fields[0].value = 'unmounted'
      ;(input.data as { nested: string[] }).nested[0] = 'cleared'
    })
    demoteClientSession()
    expect(capture).toHaveBeenCalledOnce()
    expect(get(writerDraftRecoveryStore).drafts[0]).toMatchObject({
      ...draft(),
      scope,
      generation: expect.any(String),
      updatedAt: expect.any(Number),
    })
    const returned = readWriterDraft(input.key)!
    returned.fields[0].value = 'consumer changed its copy'
    expect(readWriterDraft(input.key)?.fields[0].value).toBe('unsaved edit')
    await flushWriterDraftRecoveryForTests()
    stopView()
  })

  it('keeps other mounted captures when a callback throws, and respects unregistration', async () => {
    registerWriterDraftCapture(() => {
      throw new Error('component already disposed')
    })
    const unregister = registerWriterDraftCapture(() => draft('not mounted', 'removed'))
    unregister()
    registerWriterDraftCapture(() => draft('still mounted', 'remaining'))
    demoteClientSession()
    await flushWriterDraftRecoveryForTests()
    expect(get(writerDraftRecoveryStore)).toMatchObject({ storageFailed: true, drafts: [{ key: 'remaining' }] })
  })

  it('surfaces a first capture failure even when no recovery view existed', () => {
    registerWriterDraftCapture(() => {
      throw new Error('unavailable optional editor snapshot')
    })
    demoteClientSession()
    expect(get(writerDraftRecoveryStore)).toEqual({ drafts: [], storageFailed: true, loading: false })
  })

  it('keeps primitive fields and a valid baseline when optional structured data cannot be cloned', async () => {
    const input = { ...draft(), data: { callback: () => 'uncloneable' } }
    registerWriterDraftCapture(() => input)
    demoteClientSession()
    await flushWriterDraftRecoveryForTests()
    const retained = readWriterDraft(input.key)!
    expect(retained.fields).toEqual(input.fields)
    expect(retained.baseline).toEqual(input.baseline)
    expect(retained).not.toHaveProperty('data')
    expect(get(writerDraftRecoveryStore).storageFailed).toBe(true)
    expect(await indexedDB.databases()).toEqual([])
  })

  it('copies nested reactive proxies without losing long primitive text', async () => {
    const nested = { name: 'long reactive text '.repeat(200) }
    const input = { ...draft(), data: { nested: new Proxy(nested, {}) } }
    await captureAndSave(input)
    nested.name = 'changed after capture'
    await resetWriterDraftRecoveryForTests()
    await loadWriterDrafts()
    expect(readWriterDraft(input.key)?.data).toEqual({ nested: { name: 'long reactive text '.repeat(200) } })
    expect(get(writerDraftRecoveryStore).storageFailed).toBe(false)
  })

  it('retains the newest generation across repeated promotions without epoch disposal', async () => {
    let input = draft('first')
    registerWriterDraftCapture(() => input)
    demoteClientSession()
    const first = readWriterDraft(input.key)!
    promote()
    input = draft('second')
    demoteClientSession()
    const second = readWriterDraft(input.key)!
    expect(second.generation).not.toBe(first.generation)
    expect(second.scope).toEqual(first.scope)
    expect(second.fields[0].value).toBe('second')
    await flushWriterDraftRecoveryForTests()
    expect(await rawRows()).toHaveLength(1)
    await expect(discardWriterDraft(first.generation)).resolves.toBe(false)
    expect(readWriterDraft(input.key)?.generation).toBe(second.generation)
    await expect(discardWriterDraft(second.generation)).resolves.toBe(true)
    await loadWriterDrafts()
    expect(get(writerDraftRecoveryStore).drafts).toEqual([])
    expect(await rawRows()).toHaveLength(0)
  })

  it('does not delete a newer capture while an old discard waits behind storage', async () => {
    let input = draft('first')
    registerWriterDraftCapture(() => input)
    demoteClientSession()
    const first = readWriterDraft(input.key)!
    const pendingDiscard = discardWriterDraft(first.generation)
    promote()
    input = draft('second')
    demoteClientSession()
    await expect(pendingDiscard).resolves.toBe(false)
    await flushWriterDraftRecoveryForTests()
    expect(readWriterDraft(input.key)?.fields[0].value).toBe('second')
    expect(await rawRows()).toHaveLength(1)
  })
})

describe('controlled reload and page exit capture', () => {
  it('captures an active writer synchronously and flushes before controlled reload completes', async () => {
    const input = draft('before reload')
    registerWriterDraftCapture(() => input)
    const pending = captureWriterDraftsForReload()
    expect(canUseClientWriteAccess()).toBe(true)
    expect(readWriterDraft(input.key)?.fields[0].value).toBe('before reload')
    input.fields[0].value = 'mutated after capture'
    await pending
    expect(await rawRows()).toHaveLength(1)
    await resetWriterDraftRecoveryForTests()
    await loadWriterDrafts()
    expect(readWriterDraft(input.key)?.fields[0].value).toBe('before reload')
  })

  it('captures on pagehide, but an explicitly unmounted registration is not captured', async () => {
    const page = new EventTarget()
    vi.stubGlobal('window', page)
    const mounted = vi.fn(() => draft('mounted', 'mounted'))
    const cancelled = vi.fn(() => draft('cancelled', 'cancelled'))
    registerWriterDraftCapture(mounted)
    registerWriterDraftCapture(cancelled)()
    page.dispatchEvent(new Event('pagehide'))
    expect(mounted).toHaveBeenCalledOnce()
    expect(cancelled).not.toHaveBeenCalled()
    expect(readWriterDraft('mounted')?.fields[0].value).toBe('mounted')
    await flushWriterDraftRecoveryForTests()
    expect(await rawRows()).toHaveLength(1)
  })
})

describe('encrypted writer draft storage', () => {
  it('roundtrips the entire capture with non-extractable AES-GCM and no plaintext capture metadata', async () => {
    const input = draft()
    const generation = await captureAndSave(input)
    const rows = await rawRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ...scope, version: 1, generation, keyKind: 'subtle' })
    const text = JSON.stringify(rows) + new TextDecoder().decode(rows[0].ciphertext)
    for (const secret of ['secret-credential', input.key, input.label, input.route!, 'unsaved lore', 'old model']) {
      expect(text).not.toContain(secret)
    }
    expect(await rawKey('subtle')).toMatchObject({
      extractable: false,
      type: 'secret',
      algorithm: { name: 'AES-GCM', length: 256 },
    })
    await resetWriterDraftRecoveryForTests()
    await loadWriterDrafts()
    expect(get(writerDraftRecoveryStore)).toMatchObject({
      storageFailed: false,
      loading: false,
      drafts: [{ ...input, scope, generation }],
    })
  })

  it('uses authenticated noble encryption when secure randomness exists without SubtleCrypto', async () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })
    const generation = await captureAndSave()
    expect((await rawRows())[0].keyKind).toBe('raw')
    const key = await rawKey('raw')
    expect(key).toBeInstanceOf(Uint8Array)
    expect((key as Uint8Array).byteLength).toBe(32)
    await resetWriterDraftRecoveryForTests()
    await loadWriterDrafts()
    expect(readWriterDraft(draft().key)).toMatchObject({ ...draft(), generation })
    expect(get(writerDraftRecoveryStore).storageFailed).toBe(false)
  })

  it('roundtrips large text fields below the byte limit', async () => {
    const input = draft('long draft '.repeat(10_000))
    await captureAndSave(input)
    await resetWriterDraftRecoveryForTests()
    await loadWriterDrafts()
    expect(readWriterDraft(input.key)?.fields).toEqual(input.fields)
  })

  it('preserves nested cloneable values without aliasing the mounted draft', async () => {
    const nested = { bytes: new Uint8Array([1, 2]), list: new Set(['draft']), undefinedValue: undefined }
    const input = { ...draft(), data: nested }
    await captureAndSave(input)
    nested.bytes[0] = 99
    nested.list.clear()
    await resetWriterDraftRecoveryForTests()
    await loadWriterDrafts()
    expect(readWriterDraft(input.key)?.data).toEqual({
      bytes: new Uint8Array([1, 2]),
      list: new Set(['draft']),
      undefinedValue: undefined,
    })
  })

  it.each(['ciphertext', 'updatedAt', 'scope'])(
    'rejects corrupt authenticated %s without exposing its payload',
    async (field) => {
      await captureAndSave(draft('persisted'))
      await mutateRow((row) => {
        if (field === 'ciphertext') {
          const bytes = new Uint8Array(row.ciphertext)
          bytes[0] ^= 1
          return { ...row, ciphertext: bytes.buffer }
        }
        if (field === 'updatedAt') return { ...row, updatedAt: row.updatedAt + 1 }
        return { ...row, writerSessionId: 'writer-b' }
      })
      await resetWriterDraftRecoveryForTests()
      if (field === 'scope') startWriter({ ...scope, writerSessionId: 'writer-b' })
      await loadWriterDrafts()
      expect(get(writerDraftRecoveryStore)).toMatchObject({ drafts: [], storageFailed: true, loading: false })
    },
  )

  it('keeps a new capture in memory when an IndexedDB commit aborts and retains the previous ciphertext', async () => {
    await captureAndSave(draft('persisted'))
    promote()
    const transaction = FakeDatabase.prototype.transaction
    const spy = vi.spyOn(FakeDatabase.prototype, 'transaction').mockImplementation(function (stores, mode, options) {
      const result = transaction.call(this, stores, mode, options)
      if (stores === 'drafts' && mode === 'readwrite') queueMicrotask(() => result.abort())
      return result
    })
    const generation = await captureAndSave(draft('cannot save'))
    expect(get(writerDraftRecoveryStore)).toMatchObject({ storageFailed: true, drafts: [{ generation }] })
    expect(readWriterDraft(draft().key)?.fields[0].value).toBe('cannot save')
    spy.mockRestore()
    await loadWriterDrafts()
    expect(readWriterDraft(draft().key)?.fields[0].value).toBe('cannot save')
    expect(await rawRows()).toHaveLength(1)
  })

  it.each(['indexedDB', 'randomness'])('retains a captured credential when %s is unavailable', async (missing) => {
    if (missing === 'indexedDB') vi.stubGlobal('indexedDB', undefined)
    else vi.stubGlobal('crypto', {})
    await captureAndSave()
    expect(get(writerDraftRecoveryStore)).toMatchObject({ storageFailed: true, drafts: [{ fields: draft().fields }] })
  })
})

describe('origin and authentication fences', () => {
  it('filters other same-origin writers and lineages without erasing their records', async () => {
    await captureAndSave(draft('writer a'))
    startWriter({ ...scope, writerSessionId: 'writer-b' })
    await loadWriterDrafts()
    expect(get(writerDraftRecoveryStore).drafts).toEqual([])
    await captureAndSave(draft('writer b'))
    startWriter({ databaseLineage: 'database-b', writerSessionId: 'writer-a' })
    await loadWriterDrafts()
    expect(get(writerDraftRecoveryStore).drafts).toEqual([])
    expect(await rawRows()).toHaveLength(2)
    startWriter()
    await loadWriterDrafts()
    expect(readWriterDraft(draft().key)?.fields[0].value).toBe('writer a')
  })

  it('captures auth-loss drafts under the last writer scope and hides them until that scope authenticates', async () => {
    registerWriterDraftCapture(() => draft('auth-loss edit'))
    requireClientAuthentication()
    expect(get(writerDraftRecoveryStore).drafts).toEqual([])
    expect(readWriterDraft(draft().key)).toBeNull()
    await flushWriterDraftRecoveryForTests()
    await loadWriterDrafts()
    expect(get(writerDraftRecoveryStore).drafts).toEqual([])
    expect(await rawRows()).toHaveLength(1)
    startWriter()
    await loadWriterDrafts()
    expect(readWriterDraft(draft().key)?.fields[0].value).toBe('auth-loss edit')
    const generation = readWriterDraft(draft().key)!.generation
    clearWriterDraftRecoveryView()
    await expect(discardWriterDraft(generation)).resolves.toBe(false)
    expect(await rawRows()).toHaveLength(1)
  })

  it('does not expose a decryption completed after authentication was lost', async () => {
    await captureAndSave()
    await resetWriterDraftRecoveryForTests()
    const release = deferred<void>()
    const decrypt = webcrypto.subtle.decrypt.bind(webcrypto.subtle)
    const spy = vi.spyOn(webcrypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => {
      const value = await decrypt(...args)
      await release.promise
      return value
    })
    const pending = loadWriterDrafts()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
    requireClientAuthentication()
    release.resolve(undefined)
    await pending
    expect(get(writerDraftRecoveryStore)).toEqual({ drafts: [], storageFailed: false, loading: false })
  })

  it('keeps a newer synchronous capture when an older load crosses demotion and repromotion', async () => {
    await captureAndSave(draft('old disk'))
    await resetWriterDraftRecoveryForTests()
    const release = deferred<void>()
    const decrypt = webcrypto.subtle.decrypt.bind(webcrypto.subtle)
    const spy = vi.spyOn(webcrypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => {
      const value = await decrypt(...args)
      await release.promise
      return value
    })
    const pending = loadWriterDrafts()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
    promote()
    registerWriterDraftCapture(() => draft('new mounted edit'))
    demoteClientSession()
    expect(readWriterDraft(draft().key)?.fields[0].value).toBe('new mounted edit')
    release.resolve(undefined)
    await pending
    await flushWriterDraftRecoveryForTests()
    expect(get(writerDraftRecoveryStore).loading).toBe(false)
    expect(readWriterDraft(draft().key)?.fields[0].value).toBe('new mounted edit')
  })
})

describe('bounded retention', () => {
  it('evicts the oldest successfully persisted records at the count bound', async () => {
    for (let index = 0; index <= WRITER_DRAFT_MAX_RECORDS; index++) {
      registerWriterDraftCapture(() => draft(`value-${index}`, `key-${index}`))
    }
    demoteClientSession()
    await flushWriterDraftRecoveryForTests()
    expect(await rawRows()).toHaveLength(WRITER_DRAFT_MAX_RECORDS)
    expect(readWriterDraft('key-0')).toBeNull()
    expect(readWriterDraft(`key-${WRITER_DRAFT_MAX_RECORDS}`)).not.toBeNull()
  })

  it('expires old stored records while preserving an oversized failed capture in memory', async () => {
    await captureAndSave(draft('old', 'old'))
    promote()
    await captureAndSave(draft('x'.repeat(WRITER_DRAFT_MAX_RECORD_BYTES), 'oversized'))
    expect(get(writerDraftRecoveryStore).storageFailed).toBe(true)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + WRITER_DRAFT_MAX_AGE_MS + 10)
    await loadWriterDrafts()
    expect(readWriterDraft('old')).toBeNull()
    expect(readWriterDraft('oversized')?.fields[0].value.length).toBe(WRITER_DRAFT_MAX_RECORD_BYTES)
    expect(await rawRows()).toHaveLength(0)
  })
})

async function rawDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('risu-writer-recovery-drafts-v1', 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function rawRows(): Promise<any[]> {
  const database = await rawDatabase()
  try {
    return await result(database.transaction('drafts', 'readonly').objectStore('drafts').getAll())
  } finally {
    database.close()
  }
}

async function rawKey(kind: string): Promise<unknown> {
  const database = await rawDatabase()
  try {
    return await result(
      database.transaction('keys', 'readonly').objectStore('keys').get(`writer-draft-aes-gcm-${kind}-v1`),
    )
  } finally {
    database.close()
  }
}

async function mutateRow(mutator: (row: any) => any): Promise<void> {
  const database = await rawDatabase()
  try {
    const transaction = database.transaction('drafts', 'readwrite')
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
    })
    const store = transaction.objectStore('drafts')
    const rows = await result(store.getAll())
    store.put(mutator(rows[0]))
    await done
  } finally {
    database.close()
  }
}
