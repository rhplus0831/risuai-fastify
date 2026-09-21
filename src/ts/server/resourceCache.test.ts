import 'fake-indexeddb/auto'
import { forceCloseDatabase } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureResourceCacheGeneration,
  clearResourceCache,
  flushResourceCacheMaintenanceForTests,
  invalidateResourceCacheWork,
  isResourceCacheMetadata,
  persistResourceCache,
  readResourceCacheSnapshots,
  resolveResourceCacheArray,
  resolveResourceCacheValue,
  selectResourceCacheHashes,
  sha256JsonValue,
} from './resourceCache'

beforeEach(async () => {
  await clearResourceCache()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await clearResourceCache()
  await flushResourceCacheMaintenanceForTests()
})

describe('IndexedDB resource cache', () => {
  it('reconstructs reordered arrays by content hash and persists only the new manifest order', async () => {
    const initial = [
      { id: 'module-a', script: 'A'.repeat(128) },
      { id: 'module-b', script: 'B'.repeat(128) },
    ]
    const emptySnapshots = await readResourceCacheSnapshots(['collection:modules'])
    expect(emptySnapshots).not.toBeNull()
    const empty = emptySnapshots?.get('collection:modules')
    expect(empty).toEqual({ hashes: [], valuesByHash: new Map() })

    const first = await resolveResourceCacheArray(
      initial.map((value) => ({ value })),
      empty!,
      [],
    )
    expect(first?.value).toEqual(initial)
    await persistResourceCache([
      {
        key: 'collection:modules',
        hashes: first!.hashes,
        values: first!.value,
      },
    ])

    const cachedSnapshots = await readResourceCacheSnapshots(['collection:modules'])
    const cached = cachedSnapshots!.get('collection:modules')!
    const requestHashes = selectResourceCacheHashes(cached)
    expect(requestHashes).toEqual(first!.hashes)

    const changed = { id: 'module-c', script: 'C'.repeat(128) }
    const mixedResponse = [{ hash: first!.hashes[1] }, { value: changed }, { hash: first!.hashes[0] }]
    const second = await resolveResourceCacheArray(mixedResponse, cached, requestHashes)
    expect(second?.value).toEqual([initial[1], changed, initial[0]])
    expect(second?.hashes).toEqual([first!.hashes[1], await sha256JsonValue(changed), first!.hashes[0]])

    await persistResourceCache([
      {
        key: 'collection:modules',
        hashes: second!.hashes,
        values: second!.value,
      },
    ])
    const finalSnapshots = await readResourceCacheSnapshots(['collection:modules'])
    expect(finalSnapshots!.get('collection:modules')!.hashes).toEqual(second!.hashes)
  })

  it('materializes duplicate hash hits as independent JSON values', async () => {
    const row = { id: 'same-row', nested: { enabled: true } }
    const hash = await sha256JsonValue(row)
    const snapshot = {
      hashes: [hash],
      valuesByHash: new Map([[hash, row]]),
    }

    const resolved = await resolveResourceCacheArray<typeof row>([{ hash }, { hash }], snapshot, [hash])
    expect(resolved?.value).toEqual([row, row])
    expect(resolved?.value[0]).not.toBe(resolved?.value[1])
    expect(resolved?.value[0]?.nested).not.toBe(resolved?.value[1]?.nested)
  })

  it('stores and restores a whole cached value for settings-style resources', async () => {
    const settings = { language: 'en', agentPresets: [{ id: 'agent-a', prompt: 'large prompt' }] }
    const empty = (await readResourceCacheSnapshots(['settings:all']))!.get('settings:all')!
    const first = await resolveResourceCacheValue(settings, empty, [])
    await persistResourceCache([{ key: 'settings:all', hashes: first!.hashes, values: [first!.value] }])

    const cached = (await readResourceCacheSnapshots(['settings:all']))!.get('settings:all')!
    const requestHashes = selectResourceCacheHashes(cached)
    const hit = await resolveResourceCacheValue(requestHashes[0], cached, requestHashes)

    expect(hit).toEqual({ value: settings, hashes: requestHashes })
  })

  it('isolates verified cache values from caller mutations', async () => {
    const settings = { language: 'en', nested: { value: 'authoritative' } }
    const empty = (await readResourceCacheSnapshots(['settings:all']))!.get('settings:all')!
    const first = await resolveResourceCacheValue(settings, empty, [])
    expect(first).not.toBeNull()
    if (!first) throw new Error('Expected the settings value to resolve')
    await persistResourceCache([{ key: 'settings:all', hashes: first.hashes, values: [first.value] }])

    settings.nested.value = 'optimistic mutation'
    const firstSnapshot = (await readResourceCacheSnapshots(['settings:all']))!.get('settings:all')!
    const [hash] = first.hashes
    if (!hash) throw new Error('Expected a settings cache hash')
    expect(firstSnapshot.valuesByHash.get(hash)).toEqual({
      language: 'en',
      nested: { value: 'authoritative' },
    })
    const exposedValue = firstSnapshot.valuesByHash.get(hash) as typeof settings
    exposedValue.nested.value = 'snapshot mutation'
    const secondSnapshot = (await readResourceCacheSnapshots(['settings:all']))!.get('settings:all')!
    expect(secondSnapshot.valuesByHash.get(hash)).toEqual({
      language: 'en',
      nested: { value: 'authoritative' },
    })
    expect(selectResourceCacheHashes(secondSnapshot)).toEqual([hash])
  })

  it('fails closed when the server references a hash whose body is not resident', async () => {
    const missingHash = 'a'.repeat(64)
    await expect(
      resolveResourceCacheArray([{ hash: missingHash }], { hashes: [missingHash], valuesByHash: new Map() }, [
        missingHash,
      ]),
    ).resolves.toBeNull()
    await expect(
      resolveResourceCacheValue(missingHash, { hashes: [missingHash], valuesByHash: new Map() }, [missingHash]),
    ).resolves.toBeNull()
  })

  it('does not advertise an IndexedDB entry whose bytes do not match its key', { tags: 'core' }, async () => {
    const claimedHash = await sha256JsonValue({ id: 'expected' })
    const request = indexedDB.open('risu-resource-cache-v1', 1)
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => {
        request.result.createObjectStore('entries')
        request.result.createObjectStore('manifests')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction(['entries', 'manifests'], 'readwrite')
    transaction.objectStore('entries').put({ id: 'tampered' }, claimedHash)
    transaction
      .objectStore('manifests')
      .put({ version: 1, hashes: [claimedHash], sizes: [17], updatedAt: Date.now() }, 'collection:modules')
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()

    const cached = (await readResourceCacheSnapshots(['collection:modules']))!.get('collection:modules')!
    expect(cached.hashes).toEqual([claimedHash])
    expect(selectResourceCacheHashes(cached)).toEqual([])
  })

  it('caps each persisted manifest to the request inventory limit', async () => {
    const values = Array.from({ length: 8_300 }, (_, id) => ({ id }))
    const hashes = await Promise.all(values.map((value) => sha256JsonValue(value)))
    await persistResourceCache([{ key: 'collection:modules', hashes, values }])

    const cached = (await readResourceCacheSnapshots(['collection:modules']))!.get('collection:modules')!
    expect(cached.hashes).toHaveLength(8_192)
    expect(selectResourceCacheHashes(cached)).toHaveLength(8_192)
  })

  it('does not retain a value above the per-entry storage budget', async () => {
    const oversized = 'x'.repeat(32 * 1024 * 1024)
    await persistResourceCache([
      {
        key: 'settings:oversized',
        hashes: ['a'.repeat(64)],
        values: [oversized],
      },
    ])

    const cached = (await readResourceCacheSnapshots(['settings:oversized']))!.get('settings:oversized')!
    expect(cached).toEqual({ hashes: [], valuesByHash: new Map() })
  })

  it('prunes the oldest manifest population to the database-wide manifest budget', async () => {
    const values = Array.from({ length: 513 }, (_, index) => ({ index }))
    const hashes = await Promise.all(values.map((value) => sha256JsonValue(value)))
    const keys = values.map(({ index }) => `collection:budget-${index.toString().padStart(3, '0')}`)
    await persistResourceCache(
      values.map((value, index) => ({
        key: keys[index]!,
        hashes: [hashes[index]!],
        values: [value],
      })),
    )

    await flushResourceCacheMaintenanceForTests()
    const snapshots = await readResourceCacheSnapshots(keys)
    expect([...snapshots!.values()].filter((snapshot) => snapshot.hashes.length > 0)).toHaveLength(512)
  })

  it('treats an unreadable manifest row as an empty disposable cache snapshot', async () => {
    const request = indexedDB.open('risu-resource-cache-v1', 1)
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => {
        request.result.createObjectStore('entries')
        request.result.createObjectStore('manifests')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('manifests', 'readwrite')
    transaction
      .objectStore('manifests')
      .put({ version: 1, hashes: ['b'.repeat(64)], sizes: [], updatedAt: Date.now() }, 'collection:corrupt')
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()

    const cached = (await readResourceCacheSnapshots(['collection:corrupt']))!.get('collection:corrupt')!
    expect(cached).toEqual({ hashes: [], valuesByHash: new Map() })
  })

  it('accepts only the negotiated SHA-256 cache metadata', () => {
    expect(isResourceCacheMetadata({ version: 2, algorithm: 'sha256' })).toBe(true)
    expect(isResourceCacheMetadata({ version: 1, algorithm: 'sha256' })).toBe(false)
    expect(isResourceCacheMetadata({ version: 2, algorithm: 'md5' })).toBe(false)
  })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function holdEvent(target: object, name: 'onsuccess' | 'oncomplete') {
  const entered = deferred()
  const release = deferred()
  let callback: ((event: Event) => unknown) | null = null
  Object.defineProperty(target, name, {
    configurable: true,
    get: () =>
      callback &&
      ((event: Event) => {
        entered.resolve()
        void release.promise.then(() => callback?.call(target, event))
      }),
    set: (value: typeof callback) => {
      callback = value
    },
  })
  return { entered: entered.promise, release: release.resolve }
}

async function openTestDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open('risu-resource-cache-v1', 1)
  return await new Promise((resolve, reject) => {
    request.onupgradeneeded = () => {
      request.result.createObjectStore('entries')
      request.result.createObjectStore('manifests')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function seedTestValue(key: string, value: unknown, hash: string, updatedAt = Date.now()): Promise<void> {
  const database = await openTestDatabase()
  const transaction = database.transaction(['entries', 'manifests'], 'readwrite')
  transaction.objectStore('entries').put(value, hash)
  transaction
    .objectStore('manifests')
    .put({ version: 1, hashes: [hash], sizes: [JSON.stringify(value).length], updatedAt }, key)
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
  database.close()
}

async function storedCacheCounts(): Promise<{ manifests: number; entries: number }> {
  const database = await openTestDatabase()
  const transaction = database.transaction(['entries', 'manifests'], 'readonly')
  const counts = await Promise.all(
    ['manifests', 'entries'].map(
      (store) =>
        new Promise<number>((resolve) => {
          const request = transaction.objectStore(store).count()
          request.onsuccess = () => resolve(request.result)
        }),
    ),
  )
  database.close()
  return { manifests: counts[0]!, entries: counts[1]! }
}

async function testUpdate(key = 'settings:all', value: unknown = { version: 'authoritative' }) {
  return { key, hashes: [await sha256JsonValue(value)], values: [value] }
}

describe('cache maintenance ownership and scheduling', () => {
  it('owns nested response values synchronously before a queued write starts', async () => {
    const update = await testUpdate()
    const hash = update.hashes[0]!
    const pending = persistResourceCache([update])
    update.key = 'settings:mutated'
    update.hashes[0] = 'f'.repeat(64)
    ;(update.values[0] as { version: string }).version = 'caller edit'
    update.values.length = 0
    await pending
    const cached = (await readResourceCacheSnapshots(['settings:all']))!.get('settings:all')!
    expect(cached.hashes).toEqual([hash])
    expect(cached.valuesByHash.get(hash)).toEqual({ version: 'authoritative' })
  })

  it('rejects responses captured before clear or writer ownership changes', async () => {
    const update = await testUpdate()
    const beforeClear = captureResourceCacheGeneration()
    await clearResourceCache()
    await persistResourceCache([update], beforeClear)
    const beforeWriterChange = captureResourceCacheGeneration()
    invalidateResourceCacheWork()
    await persistResourceCache([update], beforeWriterChange)
    expect(await storedCacheCounts()).toEqual({ manifests: 0, entries: 0 })
  })

  it('coalesces eight writes into one eventual prune after initializing the connection', async () => {
    await persistResourceCache([await testUpdate('settings:initial')])
    await flushResourceCacheMaintenanceForTests()
    const allKeys = vi.spyOn(IDBObjectStore.prototype, 'getAllKeys')
    const all = vi.spyOn(IDBObjectStore.prototype, 'getAll')
    const update = await testUpdate()
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => persistResourceCache([{ ...update, key: `settings:${index}` }])),
    )
    expect(allKeys).not.toHaveBeenCalled()
    expect(all).not.toHaveBeenCalled()
    await flushResourceCacheMaintenanceForTests()
    expect(allKeys).toHaveBeenCalledTimes(2)
    expect(all).toHaveBeenCalledOnce()
  })

  it('runs fixed-deadline maintenance while requests keep arriving', async () => {
    await persistResourceCache([await testUpdate('settings:initial')])
    await flushResourceCacheMaintenanceForTests()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const all = vi.spyOn(IDBObjectStore.prototype, 'getAll')
      const update = await testUpdate()
      for (let index = 0; index < 6; index += 1) {
        await persistResourceCache([{ ...update, key: `settings:${index}` }])
        await vi.advanceTimersByTimeAsync(10)
      }
      expect(all).toHaveBeenCalledOnce()
      await flushResourceCacheMaintenanceForTests()
      expect(all).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('forces pruning before continuous writes exceed temporary manifest growth', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const update = await testUpdate()
      for (let batch = 0; batch < 6; batch += 1) {
        await persistResourceCache(
          Array.from({ length: 400 }, (_, index) => ({ ...update, key: `settings:${batch}:${index}` })),
        )
        expect((await storedCacheCounts()).manifests).toBeLessThanOrEqual(512 + 1_024)
      }
      const all = vi.spyOn(IDBObjectStore.prototype, 'getAll')
      await flushResourceCacheMaintenanceForTests()
      expect(all).toHaveBeenCalledOnce()
      expect(await storedCacheCounts()).toEqual({ manifests: 512, entries: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps pending jobs across repeated invalidations without snapshotting rejected payloads', async () => {
    await readResourceCacheSnapshots([])
    let held: ReturnType<typeof holdEvent> | undefined
    const getAll = IDBObjectStore.prototype.getAll
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (...args) {
      const request = getAll.apply(this, args)
      held ??= holdEvent(request, 'onsuccess')
      return request
    })
    const update = await testUpdate()
    const pending: Promise<void>[] = [persistResourceCache([update])]
    await vi.waitFor(() => expect(held).toBeDefined())
    await held!.entered
    const toJSON = vi.fn(() => ({ safe: true }))
    for (let index = 1; index <= 100; index += 1) {
      invalidateResourceCacheWork()
      pending.push(persistResourceCache([{ key: `settings:${index}`, hashes: update.hashes, values: [{ toJSON }] }]))
    }
    expect(toJSON).toHaveBeenCalledTimes(63)
    held!.release()
    await Promise.all(pending)
    expect(await storedCacheCounts()).toEqual({ manifests: 0, entries: 0 })
  })

  it('caps queued serialized bytes and value references while maintenance is held', async () => {
    await readResourceCacheSnapshots([])
    let held: ReturnType<typeof holdEvent> | undefined
    const getAll = IDBObjectStore.prototype.getAll
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (...args) {
      const request = getAll.apply(this, args)
      held ??= holdEvent(request, 'onsuccess')
      return request
    })
    const value = 'x'.repeat(16 * 1024 * 1024 - 2)
    const first = persistResourceCache([{ key: 'settings:large-1', hashes: ['a'.repeat(64)], values: [value] }])
    await vi.waitFor(() => expect(held).toBeDefined())
    await held!.entered
    const second = persistResourceCache([{ key: 'settings:large-2', hashes: ['b'.repeat(64)], values: [value] }])
    const dropped = persistResourceCache([{ key: 'settings:dropped', hashes: ['c'.repeat(64)], values: [1] }])
    held!.release()
    await Promise.all([first, second, dropped])
    expect(await storedCacheCounts()).toEqual({ manifests: 2, entries: 2 })
    await clearResourceCache()
    held = undefined
    const values = Array.from({ length: 8_192 }, (_, id) => id)
    const hashes = values.map((id) => id.toString(16).padStart(64, '0'))
    const populated = persistResourceCache([{ key: 'collection:large', hashes, values }])
    await vi.waitFor(() => expect(held).toBeDefined())
    await held!.entered
    const overflow = persistResourceCache([{ key: 'settings:overflow', hashes: ['f'.repeat(64)], values: [1] }])
    held!.release()
    await Promise.all([populated, overflow])
    expect(await storedCacheCounts()).toEqual({ manifests: 1, entries: 8_192 })
  })
})

describe('cache generation fences at asynchronous boundaries', () => {
  it('does not wait for a pending open when clearing and closes its late result', async () => {
    const open = indexedDB.open.bind(indexedDB)
    let held: ReturnType<typeof holdEvent> | undefined
    vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
      const request = open(...args)
      held ??= holdEvent(request, 'onsuccess')
      return request
    })
    const pending = persistResourceCache([await testUpdate()])
    await vi.waitFor(() => expect(held).toBeDefined())
    await held!.entered
    await clearResourceCache()
    held!.release()
    await pending
    vi.restoreAllMocks()
    await clearResourceCache()
    expect(await storedCacheCounts()).toEqual({ manifests: 0, entries: 0 })
  })

  it.each(['manifests', 'entries'] as const)('fences a read suspended at its %s result', async (store) => {
    const update = await testUpdate()
    await seedTestValue(update.key, update.values[0], update.hashes[0]!)
    const get = IDBObjectStore.prototype.get
    let held: ReturnType<typeof holdEvent> | undefined
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (...args) {
      const request = get.apply(this, args)
      if (this.name === store) held ??= holdEvent(request, 'onsuccess')
      return request
    })
    const read = readResourceCacheSnapshots([update.key])
    await vi.waitFor(() => expect(held).toBeDefined())
    await held!.entered
    await clearResourceCache()
    held!.release()
    expect(await read).toBeNull()
    expect(await storedCacheCounts()).toEqual({ manifests: 0, entries: 0 })
  })

  it('does not repopulate verified memory after an old hash verification finishes', async () => {
    const update = await testUpdate()
    const hash = update.hashes[0]!
    await seedTestValue(update.key, update.values[0], hash)
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const entered = deferred()
    const release = deferred()
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      const result = await digest(...args)
      entered.resolve()
      await release.promise
      return result
    })
    const read = readResourceCacheSnapshots([update.key])
    await entered.promise
    await clearResourceCache()
    release.resolve()
    expect(await read).toBeNull()
    await seedTestValue(update.key, { version: 'tampered' }, hash)
    const cached = (await readResourceCacheSnapshots([update.key]))!.get(update.key)!
    expect(selectResourceCacheHashes(cached)).toEqual([])
  })

  it.each(['initial-prune', 'write-complete', 'scheduled-prune', 'prune-delete-complete'] as const)(
    'clearing fences an old write at %s and leaves the new connection usable',
    async (boundary) => {
      const update = await testUpdate()
      if (boundary === 'scheduled-prune' || boundary === 'prune-delete-complete') {
        await persistResourceCache([update])
        await flushResourceCacheMaintenanceForTests()
      }
      let held: ReturnType<typeof holdEvent> | undefined
      if (boundary === 'initial-prune' || boundary === 'scheduled-prune') {
        const getAll = IDBObjectStore.prototype.getAll
        vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (...args) {
          const request = getAll.apply(this, args)
          held ??= holdEvent(request, 'onsuccess')
          return request
        })
      } else {
        const transaction = IDBDatabase.prototype.transaction
        let writes = 0
        vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (...args) {
          const result = transaction.apply(this, args)
          if (args[1] === 'readwrite' && ++writes === (boundary === 'write-complete' ? 1 : 2)) {
            held = holdEvent(result, 'oncomplete')
          }
          return result
        })
      }
      const writes =
        boundary === 'prune-delete-complete'
          ? persistResourceCache(Array.from({ length: 513 }, (_, index) => ({ ...update, key: `settings:${index}` })))
          : persistResourceCache([update])
      const maintenance =
        boundary === 'scheduled-prune' || boundary === 'prune-delete-complete'
          ? writes.then(() => flushResourceCacheMaintenanceForTests())
          : writes
      await vi.waitFor(() => expect(held).toBeDefined())
      await held!.entered
      await clearResourceCache()
      // A new read can open independently of a suspended old maintenance lane.
      expect(await readResourceCacheSnapshots(['settings:new'])).not.toBeNull()
      held!.release()
      await maintenance
      vi.restoreAllMocks()
      const fresh = await testUpdate('settings:new')
      await persistResourceCache([fresh])
      expect(await storedCacheCounts()).toEqual({ manifests: 1, entries: 1 })
      expect((await readResourceCacheSnapshots(['settings:new']))!.get('settings:new')!.hashes).toEqual(fresh.hashes)
    },
  )

  it('invalidates pending work on database versionchange without clobbering a later connection', async () => {
    const update = await testUpdate()
    await persistResourceCache([update])
    await flushResourceCacheMaintenanceForTests()
    const generation = captureResourceCacheGeneration()
    const request = indexedDB.deleteDatabase('risu-resource-cache-v1')
    await new Promise<void>((resolve) => {
      request.onsuccess = () => resolve()
    })
    expect(captureResourceCacheGeneration()).toBeGreaterThan(generation)
    await persistResourceCache([update], generation)
    expect(await storedCacheCounts()).toEqual({ manifests: 0, entries: 0 })
    await persistResourceCache([update])
    expect(await storedCacheCounts()).toEqual({ manifests: 1, entries: 1 })
  })

  it('swallows quota failures, fences queued writes, and can recover on a fresh generation', async () => {
    const update = await testUpdate()
    const put = IDBObjectStore.prototype.put
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('quota exhausted', 'QuotaExceededError')
    })
    await Promise.all([persistResourceCache([update]), persistResourceCache([{ ...update, key: 'settings:queued' }])])
    fault.mockImplementation(put)
    expect(await storedCacheCounts()).toEqual({ manifests: 0, entries: 0 })
    await persistResourceCache([update])
    expect(await storedCacheCounts()).toEqual({ manifests: 1, entries: 1 })
  })

  it('treats unavailable and blocked IndexedDB as optional without rejecting reads or recovery', async () => {
    const realIndexedDB = indexedDB
    vi.stubGlobal('indexedDB', undefined)
    expect(await readResourceCacheSnapshots(['settings:all'])).toBeNull()
    await persistResourceCache([await testUpdate()])
    await clearResourceCache()
    vi.stubGlobal('indexedDB', realIndexedDB)
    const blocker = await openTestDatabase()
    await clearResourceCache()
    expect(await readResourceCacheSnapshots(['settings:all'])).toBeNull()
    await persistResourceCache([await testUpdate()])
    blocker.close()
    await vi.waitFor(async () => expect(await readResourceCacheSnapshots([])).not.toBeNull())
  })
})

describe('cache bounded metadata and connection recovery', () => {
  it('bounds pending manifest metadata independently of job, value and byte budgets', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const update = await testUpdate()
      const first = persistResourceCache(
        Array.from({ length: 1_024 }, (_, index) => ({ ...update, key: `settings:${index}` })),
      )
      const toJSON = vi.fn(() => 1)
      const overflow = persistResourceCache([{ key: 'settings:overflow', hashes: update.hashes, values: [{ toJSON }] }])
      await Promise.all([first, overflow])
      expect(toJSON).not.toHaveBeenCalled()
      expect(await storedCacheCounts()).toEqual({ manifests: 1_024, entries: 1 })
      await flushResourceCacheMaintenanceForTests()
      expect(await storedCacheCounts()).toEqual({ manifests: 512, entries: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps queued key strings before serializing their payloads', async () => {
    const update = await testUpdate()
    const toJSON = vi.fn(() => 1)
    await persistResourceCache([{ key: 'x'.repeat(2_049), hashes: update.hashes, values: [{ toJSON }] }])
    expect(toJSON).not.toHaveBeenCalled()
    expect(await storedCacheCounts()).toEqual({ manifests: 0, entries: 0 })
    await persistResourceCache([{ ...update, key: 'x'.repeat(2_048) }])
    expect(await storedCacheCounts()).toEqual({ manifests: 1, entries: 1 })
  })

  it('retries after synchronous IndexedDB.open failure', async () => {
    const open = indexedDB.open.bind(indexedDB)
    vi.spyOn(indexedDB, 'open')
      .mockImplementationOnce(() => {
        throw new DOMException('blocked', 'SecurityError')
      })
      .mockImplementation(open)
    expect(await readResourceCacheSnapshots([])).toBeNull()
    expect(await readResourceCacheSnapshots([])).not.toBeNull()
    await persistResourceCache([await testUpdate()])
    expect(await storedCacheCounts()).toEqual({ manifests: 1, entries: 1 })
  })

  it('fences work after an unexpected connection close', async () => {
    const transaction = IDBDatabase.prototype.transaction
    let connection: IDBDatabase | undefined
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (...args) {
      connection = this
      return transaction.apply(this, args)
    })
    await persistResourceCache([await testUpdate()])
    await flushResourceCacheMaintenanceForTests()
    const generation = captureResourceCacheGeneration()
    // fake-indexeddb accepts a database instance but its helper declares the constructor type.
    // @ts-expect-error Upstream helper declaration does not match its runtime contract.
    forceCloseDatabase(connection!)
    await vi.waitFor(() => expect(captureResourceCacheGeneration()).toBeGreaterThan(generation))
    await persistResourceCache([await testUpdate('settings:new')])
    expect(await storedCacheCounts()).toEqual({ manifests: 2, entries: 1 })
  })

  it('does not restore a value evicted while an earlier read was hashing it', async () => {
    const old = await testUpdate('settings:old')
    const hash = old.hashes[0]!
    await seedTestValue(old.key, old.values[0], hash, 0)
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const entered = deferred()
    const release = deferred()
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      const result = await digest(...args)
      entered.resolve()
      await release.promise
      return result
    })
    const read = readResourceCacheSnapshots([old.key])
    await entered.promise
    const next = await testUpdate('settings:new', { new: true })
    await persistResourceCache(Array.from({ length: 513 }, (_, index) => ({ ...next, key: `settings:new:${index}` })))
    await flushResourceCacheMaintenanceForTests()
    release.resolve()
    expect((await read)!.get(old.key)!.valuesByHash.has(hash)).toBe(true)
    // Reintroducing a corrupt disk row must force verification, not find the old value in memory.
    await seedTestValue(old.key, { tampered: true }, hash)
    const cached = (await readResourceCacheSnapshots([old.key]))!.get(old.key)!
    expect(selectResourceCacheHashes(cached)).toEqual([])
  })

  it('does not close a new connection when old maintenance fails after clear', async () => {
    await persistResourceCache([await testUpdate()])
    await flushResourceCacheMaintenanceForTests()
    const getAll = IDBObjectStore.prototype.getAll
    const entered = deferred()
    const release = deferred()
    let held = false
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (...args) {
      if (held) return getAll.apply(this, args)
      held = true
      const request = getAll.apply(this, args)
      let onerror: ((event: Event) => unknown) | null = null
      Object.defineProperty(request, 'onerror', {
        configurable: true,
        get: () => onerror,
        set: (value) => {
          onerror = value
        },
      })
      Object.defineProperty(request, 'onsuccess', {
        configurable: true,
        get: () => (event: Event) => {
          entered.resolve()
          void release.promise.then(() => onerror?.call(request, event))
        },
        set: () => {},
      })
      return request
    })
    await persistResourceCache([await testUpdate('settings:dirty')])
    const maintenance = flushResourceCacheMaintenanceForTests()
    await entered.promise
    await clearResourceCache()
    expect(await readResourceCacheSnapshots([])).not.toBeNull()
    release.resolve()
    await maintenance
    vi.restoreAllMocks()
    const open = vi.spyOn(indexedDB, 'open')
    expect(await readResourceCacheSnapshots(['settings:new'])).not.toBeNull()
    expect(open).not.toHaveBeenCalled()
  })
})

async function storedRetainedBytes(): Promise<number> {
  const database = await openTestDatabase()
  const transaction = database.transaction('manifests', 'readonly')
  const request = transaction.objectStore('manifests').getAll()
  const manifests = await new Promise<Array<{ hashes: string[]; sizes: number[] }>>((resolve) => {
    request.onsuccess = () => resolve(request.result)
  })
  database.close()
  const sizes = new Map<string, number>()
  for (const manifest of manifests) manifest.hashes.forEach((hash, index) => sizes.set(hash, manifest.sizes[index]!))
  return [...sizes.values()].reduce((sum, size) => sum + size, 0)
}

describe('cache eventual retention under sustained growth', () => {
  it('keeps stored entry growth bounded and converges to the original entry limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      for (let batch = 0; batch < 6; batch += 1) {
        const values = Array.from({ length: 8_192 }, (_, index) => batch * 8_192 + index)
        const hashes = values.map((value) => value.toString(16).padStart(64, '0'))
        await persistResourceCache([{ key: `collection:${batch}`, values, hashes }])
        expect((await storedCacheCounts()).entries).toBeLessThanOrEqual(32_768 + 8_192)
      }
      await flushResourceCacheMaintenanceForTests()
      expect((await storedCacheCounts()).entries).toBe(32_768)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps stored byte growth bounded and converges to the original byte limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const value = 'x'.repeat(16 * 1024 * 1024 - 2)
      for (let index = 0; index < 7; index += 1) {
        await persistResourceCache([
          { key: `settings:${index}`, values: [value], hashes: [index.toString(16).padStart(64, '0')] },
        ])
        expect(await storedRetainedBytes()).toBeLessThanOrEqual((64 + 32) * 1024 * 1024)
      }
      await flushResourceCacheMaintenanceForTests()
      expect(await storedRetainedBytes()).toBe(64 * 1024 * 1024)
    } finally {
      vi.useRealTimers()
    }
  })
})
