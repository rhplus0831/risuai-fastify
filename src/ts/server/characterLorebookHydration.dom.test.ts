import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testDatabaseState } from '../__tests__/resourceDatabaseState'
import { resetClientSessionForTests } from '../clientSession'
import { acceptedSendRecoveries } from '../process/acceptedSendRecoveryState'
import { resetRerollNavigation } from '../process/rerollNavigation.svelte'
import { selectedCharID } from '../stores.svelte'
import {
  BULK_HYDRATION_BATCH_SIZE,
  ensureAllCharacterLorebooksHydrated,
  hasCharacterLorebookHydrationFailed,
  hydrateActiveCharacterLorebook,
  isCharacterLorebookHydrationPending,
  resetChatHydration,
} from './chatMessageHydration.svelte'
import { db, deferred, seedTwoStubChats } from './chatMessageHydration.testFixtures'
import { clearRetainedChatProjections } from './chatRetainedProjection'
import { clearCachedServerCommandRevision, setCachedServerCommandRevision } from './commands'
import {
  isCharacterLorebookHydrated,
  recordHydratedCharacterLorebooks,
  resetLorebookHydration,
} from './lorebookOwner.svelte'
import { getProtocolDiagnosticsSnapshot } from './protocolDiagnostics'
import {
  captureCharacterLorebookBodyProjectionEpoch,
  hasCharacterLorebookBodyProjectionEpochChanged,
  hasNewerCharacterLorebookBodyResourceRevision,
  markCharacterLorebookProjectionApplied,
} from './resourceState.svelte'

const browserEvidence = vi.hoisted(() => ({ entries: [] as Record<string, unknown>[], generation: 0 }))

const projectionState = vi.hoisted(() => ({
  canUse: vi.fn(() => true),
  fetchChat: vi.fn(),
  fetchGenerationChat: vi.fn(),
  fetchBulkChat: vi.fn(),
  fetchCharLore: vi.fn(),
  fetchBulkCharLore: vi.fn(),
}))

vi.mock('./browserDiagnostics', () => ({
  recordBrowserDiagnostic: (entry: Record<string, unknown>) => browserEvidence.entries.push(entry),
  resetBrowserDiagnosticsSession: () => {
    browserEvidence.generation++
    browserEvidence.entries = []
  },
  captureBrowserDiagnosticsGeneration: () => browserEvidence.generation,
  isBrowserDiagnosticsGenerationCurrent: (generation: number) => generation === browserEvidence.generation,
}))

vi.mock('./hydrationReads', () => ({
  fetchServerBulkCharacterLorebooks: projectionState.fetchBulkCharLore,
  fetchServerBulkChatMessages: projectionState.fetchBulkChat,
  fetchServerChatMessages: projectionState.fetchChat,
  fetchServerGenerationChatMessages: projectionState.fetchGenerationChat,
  fetchServerCharacterLorebook: projectionState.fetchCharLore,
}))

vi.mock('./resourceReads', () => ({
  canUseServerResourceReads: projectionState.canUse,
}))

function okBulkLorebookResult(characterIds: string[]) {
  return {
    status: 'ok' as const,
    revision: 1,
    characters: characterIds.map((characterId) => ({
      characterId,
      globalLore: [{ key: characterId, content: 'lore' }],
    })),
    missing: [],
  }
}

function seedManyLorebookStubCharacters(count: number) {
  ;(testDatabaseState as { db: unknown }).db = {
    enableLorebookStubs: true,
    currentChar: 0,
    characters: Array.from({ length: count }, (_, index) => ({
      chaId: `char-${index + 1}`,
      chatPage: 0,
      chats: [{ id: `chat-${index + 1}`, message: [] }],
      globalLore: [],
    })),
  }
  selectedCharID.set(0)
}

beforeEach(() => {
  browserEvidence.entries = []
  resetClientSessionForTests()
  projectionState.canUse.mockReturnValue(true)
  projectionState.fetchChat.mockReset()
  projectionState.fetchGenerationChat.mockReset()
  projectionState.fetchBulkChat.mockReset()
  projectionState.fetchCharLore.mockReset()
  projectionState.fetchBulkCharLore.mockReset()
  projectionState.fetchBulkCharLore.mockImplementation(async (characterIds: string[]) =>
    okBulkLorebookResult(characterIds),
  )
  clearCachedServerCommandRevision()
  resetChatHydration()
  resetLorebookHydration()
  resetRerollNavigation()
  acceptedSendRecoveries.set([])
  clearRetainedChatProjections()
  seedTwoStubChats()
})

afterEach(() => {
  clearRetainedChatProjections()
  selectedCharID.set(-1)
})

describe('character globalLore hydration', () => {
  it.each(['success', 'failure'] as const)('shares an in-flight lorebook read through %s', async (outcome) => {
    seedManyLorebookStubCharacters(1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = {
        status: 'ok' as const,
        revision: 1,
        characterId: 'char-1',
        globalLore: [{ key: 'loaded', content: 'lore' }],
      }
      const response = deferred<typeof result | { status: 'error'; error: string }>()
      projectionState.fetchCharLore.mockReturnValue(response.promise)
      const first = hydrateActiveCharacterLorebook()
      const second = hydrateActiveCharacterLorebook()
      const callsWhilePending = projectionState.fetchCharLore.mock.calls.length
      response.resolve(outcome === 'success' ? result : { status: 'error', error: 'offline' })
      await Promise.all([first, second])

      expect(callsWhilePending).toBe(1)
      expect((db().characters[0] as { globalLore?: unknown[] }).globalLore).toEqual(
        outcome === 'success' ? result.globalLore : [],
      )
      expect(isCharacterLorebookHydrated('char-1')).toBe(outcome === 'success')
      if (outcome === 'failure') {
        expect(hasCharacterLorebookHydrationFailed('char-1')).toBe(true)
        projectionState.fetchCharLore.mockResolvedValueOnce(result)
        await hydrateActiveCharacterLorebook()
        expect(projectionState.fetchCharLore).toHaveBeenCalledTimes(2)
        expect((db().characters[0] as { globalLore?: unknown[] }).globalLore).toEqual(result.globalLore)
        expect(isCharacterLorebookHydrated('char-1')).toBe(true)
        expect(hasCharacterLorebookHydrationFailed('char-1')).toBe(false)
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('rejects a single lorebook response from before a hydration reset and permits retry', async () => {
    seedManyLorebookStubCharacters(1)
    const oldResult = {
      status: 'ok' as const,
      revision: 1,
      characterId: 'char-1',
      globalLore: [{ key: 'old', content: 'stale lore' }],
    }
    const response = deferred<typeof oldResult>()
    projectionState.fetchCharLore.mockReturnValueOnce(response.promise)
    const hydration = hydrateActiveCharacterLorebook()
    resetChatHydration()
    response.resolve(oldResult)
    await hydration

    expect((db().characters[0] as { globalLore?: unknown[] }).globalLore).toEqual([])
    expect(isCharacterLorebookHydrated('char-1')).toBe(false)
    expect(isCharacterLorebookHydrationPending('char-1')).toBe(true)
    projectionState.fetchCharLore.mockResolvedValueOnce({
      ...oldResult,
      globalLore: [{ key: 'new', content: 'fresh lore' }],
    })
    await hydrateActiveCharacterLorebook()
    expect(projectionState.fetchCharLore).toHaveBeenCalledTimes(2)
    expect((db().characters[0] as { globalLore?: unknown[] }).globalLore).toEqual([
      { key: 'new', content: 'fresh lore' },
    ])
    expect(isCharacterLorebookHydrated('char-1')).toBe(true)
  })

  it.each([false, true])('rejects a bulk lorebook response from before a reset with strict=%s', async (strict) => {
    seedManyLorebookStubCharacters(65)
    const response = deferred<ReturnType<typeof okBulkLorebookResult>>()
    projectionState.fetchBulkCharLore.mockReturnValueOnce(response.promise)
    const hydration = ensureAllCharacterLorebooksHydrated({ strict })
    const settlement = strict
      ? expect(hydration).rejects.toThrow(/stale after a reset/)
      : expect(hydration).resolves.toBeUndefined()
    resetChatHydration()
    response.resolve(okBulkLorebookResult(Array.from({ length: 32 }, (_, index) => `char-${index + 1}`)))
    await settlement

    expect(projectionState.fetchBulkCharLore).toHaveBeenCalledTimes(1)
    for (const [index, character] of db().characters.entries()) {
      expect((character as { globalLore?: unknown[] }).globalLore).toEqual([])
      expect(isCharacterLorebookHydrated(`char-${index + 1}`)).toBe(false)
      expect(isCharacterLorebookHydrationPending(`char-${index + 1}`)).toBe(true)
    }
  })

  it('exposes a failed hydration and returns to loading while retrying', async () => {
    ;(testDatabaseState.db as { enableLorebookStubs?: boolean }).enableLorebookStubs = true
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    projectionState.fetchCharLore.mockResolvedValueOnce({ status: 'error', error: 'offline' })

    expect(isCharacterLorebookHydrationPending('char-1')).toBe(true)
    expect(hasCharacterLorebookHydrationFailed('char-1')).toBe(false)

    await hydrateActiveCharacterLorebook()

    expect(isCharacterLorebookHydrationPending('char-1')).toBe(false)
    expect(hasCharacterLorebookHydrationFailed('char-1')).toBe(true)

    const retry = deferred<{
      status: 'ok'
      revision: number
      characterId: string
      globalLore: unknown[]
    }>()
    projectionState.fetchCharLore.mockReturnValueOnce(retry.promise)
    const retryHydration = hydrateActiveCharacterLorebook({ force: true })

    expect(isCharacterLorebookHydrationPending('char-1')).toBe(true)
    expect(hasCharacterLorebookHydrationFailed('char-1')).toBe(false)

    retry.resolve({
      status: 'ok',
      revision: 1,
      characterId: 'char-1',
      globalLore: [{ key: 'retry', content: 'loaded' }],
    })
    await retryHydration

    expect(isCharacterLorebookHydrationPending('char-1')).toBe(false)
    expect(hasCharacterLorebookHydrationFailed('char-1')).toBe(false)
    expect(isCharacterLorebookHydrated('char-1')).toBe(true)
    warning.mockRestore()
  })

  it('hydrates + marks the open character globalLore when stubs are on', async () => {
    const projectionEpoch = captureCharacterLorebookBodyProjectionEpoch('char-1')
    ;(testDatabaseState.db as { enableLorebookStubs?: boolean }).enableLorebookStubs = true
    projectionState.fetchCharLore.mockResolvedValue({
      status: 'ok',
      revision: 1,
      characterId: 'char-1',
      globalLore: [{ key: 'k', content: 'lore' }],
    })

    expect(isCharacterLorebookHydrated('char-1')).toBe(false)
    await hydrateActiveCharacterLorebook()

    expect(projectionState.fetchCharLore).toHaveBeenCalledWith('char-1')
    expect((db().characters[0] as { globalLore?: unknown[] }).globalLore).toEqual([{ key: 'k', content: 'lore' }])
    // Marked hydrated → the lorebook watcher will now track (and persist) edits.
    expect(isCharacterLorebookHydrated('char-1')).toBe(true)
    expect(hasNewerCharacterLorebookBodyResourceRevision('char-1', 0)).toBe(true)
    expect(hasCharacterLorebookBodyProjectionEpochChanged('char-1', projectionEpoch)).toBe(true)

    // Deduped on a second call (no refetch).
    await hydrateActiveCharacterLorebook()
    expect(projectionState.fetchCharLore).toHaveBeenCalledTimes(1)
  })

  it('hydrates a resident stub after stub mode is turned off', async () => {
    ;(testDatabaseState.db as { enableLorebookStubs?: boolean }).enableLorebookStubs = true
    recordHydratedCharacterLorebooks([{ chaId: 'char-1' }])
    ;(testDatabaseState.db as { enableLorebookStubs?: boolean }).enableLorebookStubs = false
    projectionState.fetchCharLore.mockResolvedValue({
      status: 'ok',
      revision: 1,
      characterId: 'char-1',
      globalLore: [{ key: 'transition', content: 'real lore' }],
    })

    expect(isCharacterLorebookHydrationPending('char-1')).toBe(true)
    await hydrateActiveCharacterLorebook()

    expect(projectionState.fetchCharLore).toHaveBeenCalledWith('char-1')
    expect((db().characters[0] as { globalLore?: unknown[] }).globalLore).toEqual([
      { key: 'transition', content: 'real lore' },
    ])
    expect(isCharacterLorebookHydrationPending('char-1')).toBe(false)
  })

  it('does not let a forced hydration overwrite a newer local lorebook body', async () => {
    ;(testDatabaseState.db as { enableLorebookStubs?: boolean }).enableLorebookStubs = true
    const oldHydration = deferred<{
      status: 'ok'
      revision: number
      characterId: string
      globalLore: unknown[]
    }>()
    projectionState.fetchCharLore.mockReturnValue(oldHydration.promise)

    const pendingHydration = hydrateActiveCharacterLorebook({ force: true })
    const localLore = [{ key: 'local', content: 'newer local lore' }]
    ;(testDatabaseState.db.characters[0] as { globalLore?: unknown[] }).globalLore = localLore
    markCharacterLorebookProjectionApplied('char-1')
    oldHydration.resolve({
      status: 'ok',
      revision: 1,
      characterId: 'char-1',
      globalLore: [{ key: 'old', content: 'older hydration' }],
    })

    await pendingHydration

    expect((testDatabaseState.db.characters[0] as { globalLore?: unknown[] }).globalLore).toEqual(localLore)
  })

  it('hydrates 65 character lorebooks in sequential 32-id bulk batches', async () => {
    seedManyLorebookStubCharacters(BULK_HYDRATION_BATCH_SIZE * 2 + 1)
    let active = 0
    let maxActive = 0
    projectionState.fetchBulkCharLore.mockImplementation(async (characterIds: string[]) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
      return okBulkLorebookResult(characterIds)
    })

    await ensureAllCharacterLorebooksHydrated()

    expect(projectionState.fetchBulkCharLore.mock.calls.map(([ids]) => ids.length)).toEqual([32, 32, 1])
    expect(projectionState.fetchBulkCharLore.mock.calls.flatMap(([ids]) => ids)).toEqual(
      Array.from({ length: 65 }, (_, index) => `char-${index + 1}`),
    )
    expect(maxActive).toBe(1)
    expect(projectionState.fetchCharLore).not.toHaveBeenCalled()
    expect((testDatabaseState.db.characters[0] as { globalLore?: unknown[] }).globalLore).toEqual([
      { key: 'char-1', content: 'lore' },
    ])
    expect(isCharacterLorebookHydrated('char-1')).toBe(true)
  })

  it('applies bulk lorebooks per id without overwriting a newer local body', async () => {
    seedManyLorebookStubCharacters(2)
    const oldHydration = deferred<ReturnType<typeof okBulkLorebookResult>>()
    projectionState.fetchBulkCharLore.mockReturnValue(oldHydration.promise)

    const pendingHydration = ensureAllCharacterLorebooksHydrated()
    const localLore = [{ key: 'local', content: 'newer local lore' }]
    ;(testDatabaseState.db.characters[0] as { globalLore?: unknown[] }).globalLore = localLore
    markCharacterLorebookProjectionApplied('char-1')
    oldHydration.resolve(okBulkLorebookResult(['char-1', 'char-2']))

    await pendingHydration

    expect((testDatabaseState.db.characters[0] as { globalLore?: unknown[] }).globalLore).toEqual(localLore)
    expect((testDatabaseState.db.characters[1] as { globalLore?: unknown[] }).globalLore).toEqual([
      { key: 'char-2', content: 'lore' },
    ])
  })

  it('keeps all-character lorebook hydration within the request-count budget', async () => {
    seedManyLorebookStubCharacters(BULK_HYDRATION_BATCH_SIZE * 2 + 1)
    const before = getProtocolDiagnosticsSnapshot().hydration.characterLorebook

    await ensureAllCharacterLorebooksHydrated()

    const afterBulk = getProtocolDiagnosticsSnapshot().hydration.characterLorebook
    expect(afterBulk.requestsStarted - before.requestsStarted).toBe(3)
    expect(afterBulk.bulkRuns - before.bulkRuns).toBe(1)
    expect(afterBulk.bulkIds - before.bulkIds).toBe(65)
    expect(projectionState.fetchBulkCharLore).toHaveBeenCalledTimes(3)
    expect(projectionState.fetchCharLore).not.toHaveBeenCalled()

    await ensureAllCharacterLorebooksHydrated()

    const afterCached = getProtocolDiagnosticsSnapshot().hydration.characterLorebook
    expect(afterCached.requestsStarted).toBe(afterBulk.requestsStarted)
    expect(projectionState.fetchBulkCharLore).toHaveBeenCalledTimes(3)
    expect(projectionState.fetchCharLore).not.toHaveBeenCalled()
  })

  it('preserves a lorebook edited between sequential bulk batches', async () => {
    seedManyLorebookStubCharacters(65)
    const localLore = [{ key: 'local', content: 'edited between batches' }]
    projectionState.fetchBulkCharLore.mockImplementationOnce(async (ids: string[]) => {
      ;(testDatabaseState.db.characters[32] as { globalLore?: unknown[] }).globalLore = localLore
      markCharacterLorebookProjectionApplied('char-33')
      return okBulkLorebookResult(ids)
    })

    await ensureAllCharacterLorebooksHydrated()

    expect((testDatabaseState.db.characters[32] as { globalLore?: unknown[] }).globalLore).toEqual(localLore)
    expect(isCharacterLorebookHydrated('char-33')).toBe(false)
    expect(projectionState.fetchBulkCharLore.mock.calls.map(([ids]) => ids.length)).toEqual([32, 32, 1])
  })

  it('keeps failed lorebook batches retryable without refetching successful batches', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      seedManyLorebookStubCharacters(65)
      projectionState.fetchBulkCharLore
        .mockImplementationOnce(async (ids: string[]) => okBulkLorebookResult(ids))
        .mockResolvedValueOnce({ status: 'error', error: 'middle lorebook batch failed' })
        .mockImplementationOnce(async (ids: string[]) => okBulkLorebookResult(ids))

      await ensureAllCharacterLorebooksHydrated()

      expect(projectionState.fetchBulkCharLore.mock.calls.map(([ids]) => ids.length)).toEqual([32, 32, 1])
      expect(isCharacterLorebookHydrated('char-1')).toBe(true)
      expect(isCharacterLorebookHydrated('char-33')).toBe(false)
      expect(isCharacterLorebookHydrated('char-65')).toBe(true)

      projectionState.fetchBulkCharLore.mockClear()
      projectionState.fetchBulkCharLore.mockImplementation(async (ids: string[]) => okBulkLorebookResult(ids))
      await ensureAllCharacterLorebooksHydrated()
      expect(projectionState.fetchBulkCharLore).toHaveBeenCalledTimes(1)
      expect(projectionState.fetchBulkCharLore.mock.calls[0][0]).toEqual(
        Array.from({ length: 32 }, (_, index) => `char-${index + 33}`),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('stops a strict lorebook hydration run at the failed batch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      seedManyLorebookStubCharacters(65)
      projectionState.fetchBulkCharLore
        .mockImplementationOnce(async (ids: string[]) => okBulkLorebookResult(ids))
        .mockResolvedValueOnce({ status: 'error', error: 'strict lorebook batch failed' })
      await expect(ensureAllCharacterLorebooksHydrated({ strict: true })).rejects.toThrow(
        'Bulk character lorebook hydration failed: strict lorebook batch failed',
      )
      expect(projectionState.fetchBulkCharLore).toHaveBeenCalledTimes(2)
      expect((testDatabaseState.db.characters[64] as { globalLore?: unknown[] }).globalLore).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('skips missing bulk character lorebook entries without marking them hydrated', async () => {
    seedManyLorebookStubCharacters(2)
    projectionState.fetchBulkCharLore.mockResolvedValueOnce({
      status: 'ok',
      revision: 1,
      characters: [
        {
          characterId: 'char-1',
          globalLore: [{ key: 'char-1', content: 'lore' }],
        },
      ],
      missing: ['char-2'],
    })

    await ensureAllCharacterLorebooksHydrated()

    expect((testDatabaseState.db.characters[0] as { globalLore?: unknown[] }).globalLore).toEqual([
      { key: 'char-1', content: 'lore' },
    ])
    expect((testDatabaseState.db.characters[1] as { globalLore?: unknown[] }).globalLore).toEqual([])
    expect(isCharacterLorebookHydrated('char-1')).toBe(true)
    expect(isCharacterLorebookHydrated('char-2')).toBe(false)

    projectionState.fetchBulkCharLore.mockClear()
    await ensureAllCharacterLorebooksHydrated()
    expect(projectionState.fetchBulkCharLore).toHaveBeenCalledWith(['char-2'])
  })

  it('strict all-character lorebook hydration rejects missing bulk entries', async () => {
    seedManyLorebookStubCharacters(2)
    projectionState.fetchBulkCharLore.mockResolvedValueOnce({
      status: 'ok',
      revision: 1,
      characters: [
        {
          characterId: 'char-1',
          globalLore: [{ key: 'char-1', content: 'lore' }],
        },
      ],
      missing: ['char-2'],
    })

    await expect(ensureAllCharacterLorebooksHydrated({ strict: true })).rejects.toThrow(
      /did not return data for: char-2/,
    )
  })

  it('drops a stale bulk character lorebook hydration response', async () => {
    seedManyLorebookStubCharacters(2)
    setCachedServerCommandRevision(2)
    projectionState.fetchBulkCharLore.mockResolvedValueOnce({
      status: 'ok',
      revision: 1,
      characters: [
        {
          characterId: 'char-1',
          globalLore: [{ key: 'char-1', content: 'old lore' }],
        },
      ],
      missing: [],
    })

    await ensureAllCharacterLorebooksHydrated()

    expect((testDatabaseState.db.characters[0] as { globalLore?: unknown[] }).globalLore).toEqual([])
    expect(isCharacterLorebookHydrated('char-1')).toBe(false)
    projectionState.fetchBulkCharLore.mockClear()
    await ensureAllCharacterLorebooksHydrated()
    expect(projectionState.fetchBulkCharLore).toHaveBeenCalledWith(['char-1', 'char-2'])
  })

  it('is a no-op when stubs are off (globalLore stays resident, no fetch)', async () => {
    await hydrateActiveCharacterLorebook()
    expect(projectionState.fetchCharLore).not.toHaveBeenCalled()
    expect(projectionState.fetchBulkCharLore).not.toHaveBeenCalled()
    expect(isCharacterLorebookHydrated('char-1')).toBe(false)
  })
})
