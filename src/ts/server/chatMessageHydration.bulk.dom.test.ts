import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testDatabaseState } from '../__tests__/resourceDatabaseState'
import { resetClientSessionForTests } from '../clientSession'
import { acceptedSendRecoveries } from '../process/acceptedSendRecoveryState'
import { getRerollBuffer, getRerollId, resetRerollNavigation } from '../process/rerollNavigation.svelte'
import { selectedCharID } from '../stores.svelte'
import {
  BULK_HYDRATION_BATCH_SIZE,
  applyServerChatMessagesResource,
  ensureAllChatsHydrated,
  hydrateActiveChat,
  resetChatHydration,
} from './chatMessageHydration.svelte'
import { db, deferred, okBulkResult, okWindowResult, seedTwoStubChats } from './chatMessageHydration.testFixtures'
import { clearRetainedChatProjections } from './chatRetainedProjection'
import { clearCachedServerCommandRevision, setCachedServerCommandRevision } from './commands'
import { resetLorebookHydration } from './lorebookOwner.svelte'
import { getProtocolDiagnosticsSnapshot } from './protocolDiagnostics'

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

function seedManyStubChats(count: number) {
  ;(testDatabaseState as { db: unknown }).db = {
    currentChar: 0,
    characters: [
      {
        chaId: 'char-1',
        chatPage: 0,
        chats: Array.from({ length: count }, (_, index) => ({
          id: `chat-${index + 1}`,
          message: [],
        })),
      },
    ],
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
  projectionState.fetchBulkChat.mockImplementation(async (chatIds: string[]) => okBulkResult(chatIds))
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

describe('bulk chat hydration', () => {
  it('ensureAllChatsHydrated fills every chat', async () => {
    await ensureAllChatsHydrated()

    expect(projectionState.fetchBulkChat).toHaveBeenCalledTimes(1)
    expect(projectionState.fetchBulkChat).toHaveBeenCalledWith(['chat-1', 'chat-2'])
    expect(projectionState.fetchChat).not.toHaveBeenCalled()
    expect(db().characters[0].chats[0].message).toEqual([{ role: 'user', data: 'chat-1', chatId: 'm-chat-1' }])
    expect(db().characters[0].chats[1].message).toEqual([{ role: 'user', data: 'chat-2', chatId: 'm-chat-2' }])
  })

  it('keeps background reroll candidates available when an already-hydrated chat is opened', async () => {
    projectionState.fetchBulkChat.mockResolvedValueOnce({
      status: 'ok',
      revision: 1,
      chats: [
        {
          chatId: 'chat-1',
          message: [{ role: 'user', data: 'active chat', chatId: 'chat-1-user' }],
          alternates: [],
        },
        {
          chatId: 'chat-2',
          message: [{ role: 'char', data: 'background primary', chatId: 'chat-2-primary' }],
          alternates: [
            { role: 'char', data: 'background alternate', chatId: 'chat-2-alternate' },
            { role: 'char', data: 'background primary', chatId: 'chat-2-primary' },
          ],
        },
      ],
      missing: [],
    })

    await ensureAllChatsHydrated()
    expect(getRerollBuffer()).toEqual([])

    db().characters[0].chatPage = 1
    await hydrateActiveChat()

    expect(projectionState.fetchChat).not.toHaveBeenCalled()
    expect(getRerollBuffer().map((candidate) => candidate[0]?.data)).toEqual([
      'background primary',
      'background alternate',
    ])
    expect(getRerollId()).toBe(0)
  })

  it('ensureAllChatsHydrated includes chats that only have a partial active window', async () => {
    projectionState.fetchChat.mockResolvedValueOnce(
      okWindowResult('chat-1', [{ role: 'char', data: 'tail', chatId: 'm2' }], 1, 2),
    )
    await hydrateActiveChat({ loadPages: 1 })
    projectionState.fetchBulkChat.mockClear()

    await ensureAllChatsHydrated()

    expect(projectionState.fetchBulkChat).toHaveBeenCalledWith(['chat-1', 'chat-2'])
    expect(db().characters[0].chats[0].message).toEqual([{ role: 'user', data: 'chat-1', chatId: 'm-chat-1' }])
  })

  it('hydrates 65 chats in sequential 32-id bulk batches', async () => {
    seedManyStubChats(BULK_HYDRATION_BATCH_SIZE * 2 + 1)
    let active = 0
    let maxActive = 0
    projectionState.fetchBulkChat.mockImplementation(async (chatIds: string[]) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
      return okBulkResult(chatIds)
    })

    await ensureAllChatsHydrated()

    expect(projectionState.fetchBulkChat.mock.calls.map(([ids]) => ids.length)).toEqual([32, 32, 1])
    expect(projectionState.fetchBulkChat.mock.calls.flatMap(([ids]) => ids)).toEqual(
      Array.from({ length: 65 }, (_, index) => `chat-${index + 1}`),
    )
    expect(maxActive).toBe(1)
    expect(projectionState.fetchChat).not.toHaveBeenCalled()
    expect(db().characters[0].chats.every((chat) => chat.message.length === 1)).toBe(true)
  })

  it('keeps all-chat hydration within the request-count budget', async () => {
    seedManyStubChats(BULK_HYDRATION_BATCH_SIZE * 2 + 1)
    const before = getProtocolDiagnosticsSnapshot().hydration.chat

    await ensureAllChatsHydrated()

    const afterBulk = getProtocolDiagnosticsSnapshot().hydration.chat
    expect(afterBulk.requestsStarted - before.requestsStarted).toBe(3)
    expect(afterBulk.bulkRuns - before.bulkRuns).toBe(1)
    expect(afterBulk.bulkIds - before.bulkIds).toBe(65)
    expect(projectionState.fetchBulkChat).toHaveBeenCalledTimes(3)
    expect(projectionState.fetchChat).not.toHaveBeenCalled()

    await ensureAllChatsHydrated()

    const afterCached = getProtocolDiagnosticsSnapshot().hydration.chat
    expect(afterCached.requestsStarted).toBe(afterBulk.requestsStarted)
    expect(projectionState.fetchBulkChat).toHaveBeenCalledTimes(3)
    expect(projectionState.fetchChat).not.toHaveBeenCalled()
  })

  it('keeps failed chat batches retryable without refetching successful batches', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      seedManyStubChats(65)
      projectionState.fetchBulkChat
        .mockImplementationOnce(async (ids: string[]) => okBulkResult(ids))
        .mockResolvedValueOnce({ status: 'error', error: 'middle batch failed' })
        .mockImplementationOnce(async (ids: string[]) => okBulkResult(ids))

      await ensureAllChatsHydrated()

      expect(projectionState.fetchBulkChat.mock.calls.map(([ids]) => ids.length)).toEqual([32, 32, 1])
      expect(
        db()
          .characters[0].chats.slice(0, 32)
          .every((chat) => chat.message.length === 1),
      ).toBe(true)
      expect(
        db()
          .characters[0].chats.slice(32, 64)
          .every((chat) => chat.message.length === 0),
      ).toBe(true)
      expect(db().characters[0].chats[64].message).toHaveLength(1)

      projectionState.fetchBulkChat.mockClear()
      projectionState.fetchBulkChat.mockImplementation(async (ids: string[]) => okBulkResult(ids))
      await ensureAllChatsHydrated()
      expect(projectionState.fetchBulkChat).toHaveBeenCalledTimes(1)
      expect(projectionState.fetchBulkChat.mock.calls[0][0]).toEqual(
        Array.from({ length: 32 }, (_, index) => `chat-${index + 33}`),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('stops a strict chat hydration run at the failed batch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      seedManyStubChats(65)
      projectionState.fetchBulkChat
        .mockImplementationOnce(async (ids: string[]) => okBulkResult(ids))
        .mockResolvedValueOnce({ status: 'error', error: 'strict middle batch failed' })
      await expect(ensureAllChatsHydrated({ strict: true })).rejects.toThrow(
        'Bulk chat hydration failed: strict middle batch failed',
      )
      expect(projectionState.fetchBulkChat).toHaveBeenCalledTimes(2)
      expect(db().characters[0].chats[64].message).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('stops a non-strict chat batch run when its hydration generation resets', async () => {
    seedManyStubChats(65)
    const secondBatch = deferred<ReturnType<typeof okBulkResult>>()
    projectionState.fetchBulkChat
      .mockImplementationOnce(async (ids: string[]) => okBulkResult(ids))
      .mockReturnValueOnce(secondBatch.promise)

    const pending = ensureAllChatsHydrated()
    await vi.waitFor(() => expect(projectionState.fetchBulkChat).toHaveBeenCalledTimes(2))
    resetChatHydration()
    secondBatch.resolve(okBulkResult(Array.from({ length: 32 }, (_, index) => `chat-${index + 33}`)))
    await pending

    expect(projectionState.fetchBulkChat).toHaveBeenCalledTimes(2)
  })

  it('resetChatHydration makes ensureAllChatsHydrated refetch re-stubbed chats', async () => {
    await ensureAllChatsHydrated()
    expect(projectionState.fetchBulkChat).toHaveBeenCalledTimes(1)

    // Simulate a foreign `characters` event re-stubbing every chat: messages
    // wiped in testDatabaseState AND the hydration cache cleared (bootstrap.ts does both).
    for (const chat of db().characters[0].chats) chat.message = []
    resetChatHydration()
    projectionState.fetchBulkChat.mockClear()

    // Without the reset this would skip the cached ids and export empty stubs.
    await ensureAllChatsHydrated()
    expect(projectionState.fetchBulkChat).toHaveBeenCalledTimes(1)
    expect(db().characters[0].chats[0].message).toEqual([{ role: 'user', data: 'chat-1', chatId: 'm-chat-1' }])
  })

  it('hydrates hypaV3Data alongside messages, and clears it when absent', async () => {
    // chat-1 has hypaV3Data; chat-2 has none.
    projectionState.fetchBulkChat.mockResolvedValue({
      status: 'ok',
      revision: 1,
      chats: [
        {
          chatId: 'chat-1',
          message: [],
          hypaV3Data: { mainChunks: [1] },
          alternates: [],
        },
        { chatId: 'chat-2', message: [], alternates: [] },
      ],
      missing: [],
    })
    // Seed a stale hypaV3Data on chat-2 to prove an absent value clears it.
    ;(db().characters[0].chats[1] as { hypaV3Data?: unknown }).hypaV3Data = { stale: true }

    await ensureAllChatsHydrated()

    expect((db().characters[0].chats[0] as { hypaV3Data?: unknown }).hypaV3Data).toEqual({
      mainChunks: [1],
    })
    expect((db().characters[0].chats[1] as { hypaV3Data?: unknown }).hypaV3Data).toBeUndefined()
  })

  it('skips missing bulk chat entries without marking them hydrated', async () => {
    projectionState.fetchBulkChat.mockResolvedValueOnce({
      status: 'ok',
      revision: 1,
      chats: [
        {
          chatId: 'chat-1',
          message: [{ role: 'user', data: 'chat-1', chatId: 'm-chat-1' }],
          alternates: [],
        },
      ],
      missing: ['chat-2'],
    })

    await ensureAllChatsHydrated()

    expect(db().characters[0].chats[0].message).toEqual([{ role: 'user', data: 'chat-1', chatId: 'm-chat-1' }])
    expect(db().characters[0].chats[1].message).toEqual([])

    projectionState.fetchBulkChat.mockClear()
    await ensureAllChatsHydrated()
    expect(projectionState.fetchBulkChat).toHaveBeenCalledWith(['chat-2'])
  })

  it('strict all-chat hydration rejects missing bulk chat entries', async () => {
    projectionState.fetchBulkChat.mockResolvedValueOnce({
      status: 'ok',
      revision: 1,
      chats: [
        {
          chatId: 'chat-1',
          message: [{ role: 'user', data: 'chat-1', chatId: 'm-chat-1' }],
          alternates: [],
        },
      ],
      missing: ['chat-2'],
    })

    await expect(ensureAllChatsHydrated({ strict: true })).rejects.toThrow(/did not return messages for: chat-2/)
  })

  it('keeps a newer chat projection while applying its valid sibling from the same held bulk response', async () => {
    const response = deferred<ReturnType<typeof okBulkResult>>()
    projectionState.fetchBulkChat.mockReturnValueOnce(response.promise)
    const pending = ensureAllChatsHydrated()
    expect(projectionState.fetchBulkChat).toHaveBeenCalledWith(['chat-1', 'chat-2'])
    const newer = [{ role: 'char', data: 'newer targeted chat one', chatId: 'newer-one' }]
    expect(applyServerChatMessagesResource('chat-1', newer, undefined, [])).toBe(true)
    response.resolve(okBulkResult(['chat-1', 'chat-2']))
    await pending
    expect(db().characters[0].chats[0].message).toEqual(newer)
    expect(db().characters[0].chats[1].message).toEqual([{ role: 'user', data: 'chat-2', chatId: 'm-chat-2' }])
    projectionState.fetchBulkChat.mockClear()
    await ensureAllChatsHydrated()
    expect(projectionState.fetchBulkChat).not.toHaveBeenCalled()
  })

  it('drops a stale bulk chat hydration response', async () => {
    setCachedServerCommandRevision(2)
    projectionState.fetchBulkChat.mockResolvedValueOnce({
      status: 'ok',
      revision: 1,
      chats: [
        {
          chatId: 'chat-1',
          message: [{ role: 'user', data: 'old', chatId: 'm-old' }],
          alternates: [],
        },
      ],
      missing: [],
    })

    await ensureAllChatsHydrated()

    expect(db().characters[0].chats[0].message).toEqual([])
    projectionState.fetchBulkChat.mockClear()
    await ensureAllChatsHydrated()
    expect(projectionState.fetchBulkChat).toHaveBeenCalledWith(['chat-1', 'chat-2'])
  })
})
