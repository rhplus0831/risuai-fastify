import { IDBFactory, IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportBrowserWork } from '../__tests__/browserWorkProbe'

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'resource-work-token',
}))
vi.mock('../readerProjectionLifecycle', () => ({
  discardReaderProjectionState: async () => undefined,
}))

import { fetchServerSettings } from './resourceReads'
import {
  clearResourceCache,
  flushResourceCacheMaintenanceForTests,
  persistResourceCache,
  readResourceCacheSnapshots,
  sha256JsonValue,
} from './resourceCache'

const fixtures = [
  { name: 'small', unrelatedManifests: 0 },
  { name: 'intermediate', unrelatedManifests: 64 },
  { name: 'large-at-manifest-budget', unrelatedManifests: 512 },
]

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  await clearResourceCache()
})

afterEach(async () => {
  await clearResourceCache()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function rawCacheCounts(): Promise<{ manifests: number; entries: number }> {
  const request = indexedDB.open('risu-resource-cache-v1', 1)
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const transaction = database.transaction(['manifests', 'entries'], 'readonly')
    const count = (name: string) =>
      new Promise<number>((resolve, reject) => {
        const request = transaction.objectStore(name).count()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const [manifests, entries] = await Promise.all([count('manifests'), count('entries')])
    return { manifests, entries }
  } finally {
    database.close()
  }
}

describe('F04 resource-cache work probe', () => {
  for (const fixture of fixtures) {
    it(`records cold, warm, and burst completion work against ${fixture.name} cache`, async () => {
      const unrelatedValues = Array.from({ length: fixture.unrelatedManifests }, (_, id) => ({
        id,
        text: 'x'.repeat(256),
      }))
      const unrelatedHashes = await Promise.all(unrelatedValues.map(sha256JsonValue))
      await persistResourceCache(
        unrelatedValues.map((value, index) => ({
          key: `settings:unrelated-${index}`,
          hashes: [unrelatedHashes[index]!],
          values: [value],
        })),
      )

      await flushResourceCacheMaintenanceForTests()

      const settings = { language: 'en', username: 'Fixed response', note: 's'.repeat(256) }
      const settingsHash = await sha256JsonValue(settings)
      const advertised: string[][] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
          const body = JSON.parse(String(init.body)) as { cache: { hashes: { settings: string[] } } }
          const hashes = body.cache.hashes.settings
          advertised.push(hashes)
          return new Response(
            JSON.stringify({
              revision: 10,
              cache: { version: 2, algorithm: 'sha256' },
              settings: hashes.includes(settingsHash) ? settingsHash : settings,
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        }),
      )

      const ownershipCapture = { count: 0, bytes: 0 }
      const stringify = JSON.stringify
      vi.spyOn(JSON, 'stringify').mockImplementation((...args) => {
        const serialized = stringify(...args)
        if (serialized !== undefined && new Error().stack?.includes('prepareResourceCacheUpdates')) {
          ownershipCapture.count += 1
          ownershipCapture.bytes += new TextEncoder().encode(serialized).byteLength
        }
        return serialized
      })
      const events: string[] = []
      const enumerations = { manifestKeys: 0, manifestValues: 0, entryKeys: 0, returnedRows: 0 }
      const originalGetAllKeys = FakeIDBObjectStore.prototype.getAllKeys
      const originalGetAll = FakeIDBObjectStore.prototype.getAll
      vi.spyOn(FakeIDBObjectStore.prototype, 'getAllKeys').mockImplementation(function (...args) {
        const request = originalGetAllKeys.apply(this, args)
        if (this.name === 'manifests' || this.name === 'entries') {
          enumerations[this.name === 'manifests' ? 'manifestKeys' : 'entryKeys'] += 1
          events.push(`enumerate:${this.name}:keys`)
          request.addEventListener('success', () => {
            enumerations.returnedRows += request.result.length
          })
        }
        return request
      })
      vi.spyOn(FakeIDBObjectStore.prototype, 'getAll').mockImplementation(function (...args) {
        const request = originalGetAll.apply(this, args)
        if (this.name === 'manifests') {
          enumerations.manifestValues += 1
          events.push('enumerate:manifests:values')
          request.addEventListener('success', () => {
            enumerations.returnedRows += request.result.length
          })
        }
        return request
      })

      const read = async (label: string) => {
        const result = await fetchServerSettings()
        events.push(`resource:${label}:complete`)
        expect(result).toMatchObject({ status: 'ok', revision: 10, settings })
      }
      await read('cold')
      const atColdCompletion = { ...enumerations }
      // This is a functional eventual-persistence assertion, not a latency gate.
      // It allows the same probe to run after persistence leaves the read path.
      await vi.waitFor(async () => {
        const snapshot = (await readResourceCacheSnapshots(['settings:all']))!.get('settings:all')!
        expect(snapshot.hashes).toEqual([settingsHash])
      })
      await flushResourceCacheMaintenanceForTests()
      await read('warm')
      const atWarmCompletion = { ...enumerations }
      expect(advertised[0]).toEqual([])
      expect(advertised[1]).toEqual([settingsHash])
      await flushResourceCacheMaintenanceForTests()
      const beforeBurst = { ...enumerations }
      await Promise.all(Array.from({ length: 8 }, (_, index) => read(`burst-${index}`)))
      const atBurstCompletion = { ...enumerations }
      await flushResourceCacheMaintenanceForTests()
      const burstMaintenance = {
        manifestKeys: enumerations.manifestKeys - beforeBurst.manifestKeys,
        manifestValues: enumerations.manifestValues - beforeBurst.manifestValues,
        entryKeys: enumerations.entryKeys - beforeBurst.entryKeys,
        returnedRows: enumerations.returnedRows - beforeBurst.returnedRows,
      }
      expect(burstMaintenance.manifestKeys).toBeLessThanOrEqual(1)
      expect(burstMaintenance.manifestValues).toBeLessThanOrEqual(1)
      expect(burstMaintenance.entryKeys).toBeLessThanOrEqual(1)
      await vi.waitFor(async () => {
        const counts = await rawCacheCounts()
        expect(counts.manifests).toBeLessThanOrEqual(512)
        expect(counts.entries).toBeLessThanOrEqual(32_768)
      })
      expect(ownershipCapture).toEqual({ count: 10, bytes: 10 * 311 })
      reportBrowserWork('F04', {
        ...fixture,
        unrelatedValueTextBytes: 256,
        fixedResponseBytes: new TextEncoder().encode(JSON.stringify(settings)).byteLength,
        reads: { cold: 1, warm: 1, burst: 8 },
        atColdCompletion,
        atWarmCompletion,
        atBurstCompletion,
        burstMaintenance,
        ownershipCapture,
        afterCacheVisible: { ...enumerations },
        retained: await rawCacheCounts(),
        events,
      })
    })
  }
})
