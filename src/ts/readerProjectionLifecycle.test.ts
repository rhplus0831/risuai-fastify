import { IDBFactory } from 'fake-indexeddb'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./process/modules', () => ({
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModules: vi.fn(() => []),
  moduleUpdate: vi.fn(),
}))
vi.mock('./model/modellist', () => ({ getModelInfo: vi.fn(() => ({ type: 'chat' })) }))

import { discardReaderProjectionState } from './readerProjectionLifecycle'
import {
  peekReaderRouteIntent,
  recordReaderRouteIntent,
  resetReaderRouteIntentForTests,
} from './readerRouteIntent'
import { readerWorkspaceLifecycleStore, resetReaderWorkspaceLifecycleForTests } from './readerWorkspaceLifecycle.svelte'
import { characterShellHydrationState } from './server/characterShellHydration.svelte'
import {
  acknowledgeCreatedChatTranscriptLocalEffect,
  isChatMessageTranscriptHydrated,
} from './server/chatMessageHydration.svelte'
import {
  clearAppliedServerResourceRevision,
  clearCachedServerCommandRevision,
  peekAppliedServerResourceRevision,
  peekCachedServerCommandRevision,
  setAppliedServerResourceRevision,
  setCachedServerCommandRevision,
} from './server/commands'
import {
  clearResourceCache,
  persistResourceCache,
  readResourceCacheSnapshots,
  sha256JsonValue,
} from './server/resourceCache'
import { isCharacterLorebookHydrated, markCharacterLorebookHydrated } from './server/lorebookOwner.svelte'
import { isPromptTemplateHydrated, markPromptTemplateProjectionApplied } from './server/promptTemplateHydration'
import { replaceResourceDatabase, resetServerResourceState } from './server/resourceState.svelte'
import { type Database } from './storage/database.svelte'
import { selectedCharID } from './stores.svelte'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

function seedReaderProjection(): void {
  replaceResourceDatabase({
    characterOrder: ['char-a'],
    characters: [
      {
        chaId: 'char-a',
        name: 'Ada',
        type: 'character',
        chats: [{ id: 'chat-a', name: 'Chat', message: [] }],
        chatPage: 0,
      },
    ],
    currentChar: 0,
    username: 'Observer',
  } as unknown as Database)
  selectedCharID.set(0)
  recordReaderRouteIntent({ kind: 'character', path: '/character/char-a', chaId: 'char-a' })
  characterShellHydrationState.rows = {
    'char-a': { status: 'ready', error: null },
  }
}

describe('observer projection lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetServerResourceState()
    resetReaderRouteIntentForTests()
    resetReaderWorkspaceLifecycleForTests()
    clearCachedServerCommandRevision()
    clearAppliedServerResourceRevision()
    selectedCharID.set(-1)
  })

  afterEach(async () => {
    await clearResourceCache()
    resetServerResourceState()
    resetReaderRouteIntentForTests()
    resetReaderWorkspaceLifecycleForTests()
    clearCachedServerCommandRevision()
    clearAppliedServerResourceRevision()
    selectedCharID.set(-1)
    vi.unstubAllGlobals()
  })

  it.each(['database-replacement', 'lineage-change'] as const)(
    'keeps the authenticated shell visible but clears reader-only intent for %s',
    async (reason) => {
      seedReaderProjection()
      expect(acknowledgeCreatedChatTranscriptLocalEffect('chat-a')).toBe(true)
      markCharacterLorebookHydrated('char-a')
      markPromptTemplateProjectionApplied('preset-a')
      const value = { id: `cached-${reason}` }
      const hash = await sha256JsonValue(value)
      await persistResourceCache([{ key: 'collection:modules', hashes: [hash], values: [value] }])

      await discardReaderProjectionState(reason)

      expect(getResourceDatabase().characters?.[0]?.chaId).toBe('char-a')
      expect(get(selectedCharID)).toBe(0)
      expect(peekReaderRouteIntent()).toBeNull()
      expect(characterShellHydrationState.rows).toEqual({})
      expect(isChatMessageTranscriptHydrated('chat-a')).toBe(false)
      expect(isCharacterLorebookHydrated('char-a')).toBe(false)
      expect(isPromptTemplateHydrated('preset-a')).toBe(false)
      expect((await readResourceCacheSnapshots(['collection:modules']))?.get('collection:modules')?.hashes).toEqual([])
      expect(get(readerWorkspaceLifecycleStore)).toMatchObject({ mode: 'waiting', lastDiscardReason: reason })
    },
  )

  it('clears authenticated resources, revisions, cache, and local intent on auth loss', async () => {
    seedReaderProjection()
    setCachedServerCommandRevision(17)
    setAppliedServerResourceRevision(17)
    const value = { id: 'cached-observer-value' }
    const hash = await sha256JsonValue(value)
    await persistResourceCache([{ key: 'collection:modules', hashes: [hash], values: [value] }])

    await discardReaderProjectionState('auth-loss')

    expect(getResourceDatabase().characters).toEqual([])
    expect(get(selectedCharID)).toBe(-1)
    expect(peekReaderRouteIntent()).toBeNull()
    expect(characterShellHydrationState.rows).toEqual({})
    expect(peekCachedServerCommandRevision()).toBeNull()
    expect(peekAppliedServerResourceRevision()).toBeNull()
    expect((await readResourceCacheSnapshots(['collection:modules']))?.get('collection:modules')?.hashes).toEqual([])
    expect(get(readerWorkspaceLifecycleStore)).toEqual({ mode: 'auth-lost', lastDiscardReason: 'auth-loss' })
  })
})
