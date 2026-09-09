import { IDBFactory, IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: async () => 'delivery-token' }))
vi.mock('../readerProjectionLifecycle', () => ({
  discardReaderProjectionState: async () => {
    const { clearResourceCache } = await import('./resourceCache')
    await clearResourceCache()
  },
}))

import {
  clearResourceCache,
  flushResourceCacheMaintenanceForTests,
  getPendingResourceCacheWriteCount,
  invalidateResourceCacheWork,
  persistResourceCache,
  readResourceCacheSnapshots,
  sha256JsonValue,
} from './resourceCache'
import { fetchServerCharacters, fetchServerCollection, fetchServerSettings } from './resourceReads'
import {
  fetchServerBulkCharacterLorebooks,
  fetchServerBulkChatMessages,
  fetchServerChatMessages,
  fetchServerCharacterLorebook,
  fetchServerLegacyPreset,
  fetchServerPromptPresetTemplate,
} from './hydrationReads'
import {
  SERVER_CHARACTER_SHELL_MARKER,
  SERVER_CHARACTER_SUMMARY_VERSION,
} from '@risuai/protocol/character-summary-resource'

const summary = {
  [SERVER_CHARACTER_SHELL_MARKER]: true,
  chaId: 'char-a',
  type: 'character',
  name: 'Ada',
  displayName: '',
  image: '',
  creatorNotes: '',
  trashTime: null,
  creation_date: 1,
  modification_date: 1,
  lastInteraction: 1,
  chatCount: 1,
  activeChatId: 'chat-a',
  chatIds: ['chat-a'],
  pinnedChats: [],
}
const fixtures = [
  { name: 'settings', read: () => fetchServerSettings(), key: 'settings:all', body: { settings: { language: 'en' } } },
  {
    name: 'collections',
    read: () => fetchServerCollection('modules'),
    key: 'collection:modules',
    body: { collections: { modules: [{ value: { id: 'module-a', name: 'A' } }] } },
  },
  {
    name: 'characters',
    read: () => fetchServerCharacters(),
    key: `characters:summary:v${SERVER_CHARACTER_SUMMARY_VERSION}`,
    body: {
      version: SERVER_CHARACTER_SUMMARY_VERSION,
      characters: [{ value: summary }],
      characterOrder: ['char-a'],
      currentChar: 0,
    },
  },
  {
    name: 'legacy preset',
    read: () => fetchServerLegacyPreset('preset-a'),
    key: 'legacy-preset:preset-a',
    body: { preset: { id: 'preset-a', name: 'A' } },
  },
  {
    name: 'prompt template',
    read: () => fetchServerPromptPresetTemplate('prompt-a'),
    key: 'prompt-preset-template:prompt-a',
    body: { promptPresetId: 'prompt-a', promptTemplate: [{ value: { type: 'plain', text: 'A' } }] },
  },
  {
    name: 'character lorebook',
    read: () => fetchServerCharacterLorebook('char-a'),
    key: 'character-lorebook:char-a',
    body: { characterId: 'char-a', globalLore: [{ value: { key: 'A', content: 'A' } }] },
  },
]

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function within(promise: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Resource waited for held cache maintenance')), 1_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Hold the completion notification consumed by the actual prune routine. The
// IndexedDB transaction itself may finish; resource reads remain free to run.
function holdNextPrune() {
  const reached = deferred()
  const release = deferred()
  const original = FakeIDBObjectStore.prototype.getAll
  let armed = true
  vi.spyOn(FakeIDBObjectStore.prototype, 'getAll').mockImplementation(function (...args) {
    const request = original.apply(this, args)
    if (!armed || this.name !== 'manifests') return request
    armed = false
    return new Proxy(request, {
      get(target, property) {
        return Reflect.get(target, property, target)
      },
      set(target, property, callback) {
        if (property === 'onsuccess' && typeof callback === 'function') {
          target.onsuccess = function (event) {
            reached.resolve()
            void release.promise.then(() => callback.call(target, event))
          }
          return true
        }
        return Reflect.set(target, property, callback, target)
      },
    })
  })
  return { reached: reached.promise, release: release.resolve }
}

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  await clearResourceCache()
})

afterEach(async () => {
  await clearResourceCache()
  await flushResourceCacheMaintenanceForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('validated resource delivery and optional cache maintenance', () => {
  for (const transport of [
    { name: 'root', read: () => fetchServerSettings() },
    { name: 'preset hydration', read: () => fetchServerLegacyPreset('unauthorized') },
    { name: 'chat hydration', read: () => fetchServerChatMessages('chat-a') },
    { name: 'bulk chat hydration', read: () => fetchServerBulkChatMessages(['chat-a']) },
    { name: 'bulk lorebook hydration', read: () => fetchServerBulkCharacterLorebooks(['char-a']) },
  ]) {
    it(`fences a held response when ${transport.name} transport reports authentication loss`, async () => {
      const requested = deferred()
      const response = deferred()
      let requests = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          if (++requests > 1) return Response.json({ error: 'Authentication required' }, { status: 401 })
          requested.resolve()
          await response.promise
          return Response.json({
            revision: 2,
            cache: { version: 2, algorithm: 'sha256' },
            settings: { language: 'en' },
          })
        }),
      )
      const read = fetchServerSettings()
      try {
        await within(requested.promise)
        const denied = transport.read()
        expect(await denied).toMatchObject({ status: 'error', error: 'Authentication required' })
      } finally {
        response.resolve()
      }
      expect(await within(read)).toMatchObject({ status: 'ok' })
      await flushResourceCacheMaintenanceForTests()
      expect((await readResourceCacheSnapshots(['settings:all']))?.get('settings:all')?.hashes).toEqual([])
    })
  }

  for (const fixture of fixtures) {
    it(`${fixture.name} resolves while global pruning is held`, async () => {
      const seed = { seed: true }
      const hash = await sha256JsonValue(seed)
      await persistResourceCache([{ key: 'seed', hashes: [hash], values: [seed] }])
      await flushResourceCacheMaintenanceForTests()
      const gate = holdNextPrune()
      let maintenance: Promise<void> | undefined
      try {
        await persistResourceCache([{ key: 'seed-dirty', hashes: [hash], values: [seed] }])
        maintenance = flushResourceCacheMaintenanceForTests()
        await within(gate.reached)
        const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
          expect(init?.method).toBe('POST')
          return Response.json({ revision: 2, cache: { version: 2, algorithm: 'sha256' }, ...fixture.body })
        })
        vi.stubGlobal('fetch', fetchMock)
        expect(await within(fixture.read())).toMatchObject({ status: 'ok', revision: 2 })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(getPendingResourceCacheWriteCount()).toBeGreaterThan(0)
      } finally {
        gate.release()
        await maintenance
      }
      await flushResourceCacheMaintenanceForTests()
      expect(getPendingResourceCacheWriteCount()).toBe(0)
      const snapshots = await readResourceCacheSnapshots([fixture.key])
      expect(snapshots?.get(fixture.key)?.hashes.length).toBeGreaterThan(0)
    })

    for (const invalidation of ['clear', 'writer scope'] as const) {
      it(`${fixture.name} cannot repopulate after ${invalidation} during its response`, async () => {
        const requested = deferred()
        const response = deferred()
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => {
            requested.resolve()
            await response.promise
            return Response.json({ revision: 2, cache: { version: 2, algorithm: 'sha256' }, ...fixture.body })
          }),
        )
        const read = fixture.read()
        try {
          await within(requested.promise)
          if (invalidation === 'clear') await clearResourceCache()
          else invalidateResourceCacheWork()
        } finally {
          response.resolve()
        }
        expect(await within(read)).toMatchObject({ status: 'ok', revision: 2 })
        await flushResourceCacheMaintenanceForTests()
        expect((await readResourceCacheSnapshots([fixture.key]))?.get(fixture.key)?.hashes).toEqual([])
      })
    }
  }
})
