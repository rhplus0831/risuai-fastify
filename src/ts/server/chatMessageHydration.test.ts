import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testDatabaseState } from '../__tests__/resourceDatabaseState'
import { resetClientSessionForTests } from '../clientSession'
import { acceptedSendRecoveries, recordAcceptedSendRecovery } from '../process/acceptedSendRecoveryState'
import { resetRerollNavigation } from '../process/rerollNavigation.svelte'
import { isServerChatMessagePlaceholder, type Message } from '../storage/database.svelte'
import { selectedCharID } from '../stores.svelte'
import {
  ACTIVE_CHAT_INITIAL_MESSAGE_WINDOW,
  acknowledgeMessageMutationLocalEffect,
  applyServerChatMessagesResource,
  ensureAllChatsHydrated,
  getChatMessageOwnerState,
  getReaderChatMessageOwnerState,
  hasChatMessageHydrationFailed,
  hydrateActiveChat,
  hydrateActiveChatFully,
  hydrateActiveChatWindow,
  hydrateChatMessageWindow,
  hydrateChatMessages,
  invalidateChatHydration,
  isChatMessageHydrationPending,
  resetChatHydration,
} from './chatMessageHydration.svelte'
import { db, deferred, okResult, okWindowResult, seedTwoStubChats } from './chatMessageHydration.testFixtures'
import { clearRetainedChatProjections } from './chatRetainedProjection'
import { clearCachedServerCommandRevision } from './commands'
import { resetLorebookHydration } from './lorebookOwner.svelte'
import {
  captureChatBodyProjectionEpoch,
  charactersResourceState,
  hasChatBodyProjectionEpochChanged,
  hasNewerChatBodyResourceRevision,
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

beforeEach(() => {
  browserEvidence.entries = []
  resetClientSessionForTests()
  projectionState.canUse.mockReturnValue(true)
  projectionState.fetchChat.mockReset()
  projectionState.fetchGenerationChat.mockReset()
  projectionState.fetchBulkChat.mockReset()
  projectionState.fetchCharLore.mockReset()
  projectionState.fetchBulkCharLore.mockReset()
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

describe('chat message hydration owner', () => {
  it.each(['full', 'tail'] as const)('rejects a wrong-chat response during %s hydration', async (kind) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      projectionState.fetchChat.mockResolvedValueOnce(
        okResult('chat-2', [{ role: 'user', data: 'another conversation', chatId: 'foreign-message' }]),
      )

      if (kind === 'full') await hydrateChatMessages('chat-1')
      else await expect(hydrateActiveChat()).resolves.toBe(false)

      expect(db().characters[0].chats.map((chat) => chat.message)).toEqual([[], []])
      expect(hasChatMessageHydrationFailed('chat-1', 0)).toBe(true)
      expect(isChatMessageHydrationPending('chat-2', 0)).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it.each(['success', 'failure'] as const)('shares an in-flight full read through %s', async (outcome) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const response = deferred<ReturnType<typeof okResult> | { status: 'error'; error: string }>()
      projectionState.fetchChat.mockReturnValue(response.promise)
      const first = hydrateChatMessages('chat-1')
      const second = hydrateChatMessages('chat-1')
      const callsWhilePending = projectionState.fetchChat.mock.calls.length
      const message = [{ role: 'user', data: 'loaded once', chatId: 'message-a' }]

      response.resolve(outcome === 'success' ? okResult('chat-1', message) : { status: 'error', error: 'offline' })
      await Promise.all([first, second])

      expect(callsWhilePending).toBe(1)
      expect(db().characters[0].chats[0].message).toEqual(outcome === 'success' ? message : [])
      expect(hasChatMessageHydrationFailed('chat-1', 0)).toBe(outcome === 'failure')
      if (outcome === 'failure') {
        projectionState.fetchChat.mockResolvedValueOnce(okResult('chat-1', message))
        await hydrateChatMessages('chat-1')
        expect(projectionState.fetchChat).toHaveBeenCalledTimes(2)
        expect(db().characters[0].chats[0].message).toEqual(message)
        expect(hasChatMessageHydrationFailed('chat-1', 0)).toBe(false)
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('fails closed when a ready resource collection has duplicate chat owners', async () => {
    testDatabaseState.db.characters.push({
      chaId: 'char-2',
      chatPage: 0,
      chats: [{ id: 'chat-1', message: [] }],
    } as never)
    projectionState.fetchChat.mockResolvedValue(okResult('chat-1', [{ role: 'user', data: 'ambiguous', chatId: 'm' }]))

    expect(charactersResourceState.status).toBe('ready')
    await hydrateActiveChatFully()

    expect(projectionState.fetchChat).not.toHaveBeenCalled()
    expect(getChatMessageOwnerState('chat-1')).toBeUndefined()
  })

  it('fails closed when a ready resource collection has duplicate character owners', async () => {
    testDatabaseState.db.characters.push({
      chaId: 'char-1',
      chatPage: 0,
      chats: [{ id: 'chat-distinct', message: [] }],
    } as never)

    expect(charactersResourceState.status).toBe('ready')
    expect(getChatMessageOwnerState('chat-distinct')).toBeUndefined()
    await hydrateChatMessages('chat-distinct')

    expect(projectionState.fetchChat).not.toHaveBeenCalled()
  })

  it.each(['idle', 'loading', 'error'] as const)(
    'does not hydrate through retained character rows while the owner is %s',
    async (status) => {
      charactersResourceState.status = status
      projectionState.fetchChat.mockResolvedValue(
        okResult('chat-1', [{ role: 'user', data: 'bootstrap', chatId: 'm-bootstrap' }]),
      )

      await expect(hydrateActiveChatFully()).resolves.toBeUndefined()

      expect(projectionState.fetchChat).not.toHaveBeenCalled()
      expect(db().characters[0].chats[0].message).toEqual([])
    },
  )

  it('hydrates only the active chat, and dedupes a second call', async () => {
    const projectionEpoch = captureChatBodyProjectionEpoch('chat-1')
    projectionState.fetchChat.mockResolvedValue(okResult('chat-1', [{ role: 'user', data: 'hi', chatId: 'm1' }]))

    await hydrateActiveChat()

    expect(projectionState.fetchChat).toHaveBeenCalledTimes(1)
    expect(projectionState.fetchChat).toHaveBeenCalledWith('chat-1', {
      tail: ACTIVE_CHAT_INITIAL_MESSAGE_WINDOW,
    })
    expect(db().characters[0].chats[0].message).toEqual([{ role: 'user', data: 'hi', chatId: 'm1' }])
    expect(hasNewerChatBodyResourceRevision('chat-1', 0)).toBe(true)
    expect(hasChatBodyProjectionEpochChanged('chat-1', projectionEpoch)).toBe(true)
    // The unrelated chat stays a stub.
    expect(db().characters[0].chats[1].message).toEqual([])

    // Second call is deduped (no refetch).
    await hydrateActiveChat()
    expect(projectionState.fetchChat).toHaveBeenCalledTimes(1)
  })

  it('hydrates an unselected route target without changing the active chat', async () => {
    projectionState.fetchChat.mockResolvedValue(
      okResult('chat-2', [{ role: 'char', data: 'next route', chatId: 'm-route' }]),
    )

    await expect(hydrateChatMessageWindow('chat-2', ACTIVE_CHAT_INITIAL_MESSAGE_WINDOW)).resolves.toBe(true)

    expect(projectionState.fetchChat).toHaveBeenCalledWith('chat-2', {
      tail: ACTIVE_CHAT_INITIAL_MESSAGE_WINDOW,
    })
    expect(db().characters[0].chatPage).toBe(0)
    expect(db().characters[0].chats[0].message).toEqual([])
    expect(db().characters[0].chats[1].message).toEqual([{ role: 'char', data: 'next route', chatId: 'm-route' }])
  })

  it('uses the configured initial chat load count for the active window size', async () => {
    ;(testDatabaseState.db as { chatLoadInitialPages?: number }).chatLoadInitialPages = 12
    projectionState.fetchChat.mockResolvedValue(okResult('chat-1', [{ role: 'user', data: 'hi', chatId: 'm1' }]))

    await hydrateActiveChat()

    expect(projectionState.fetchChat).toHaveBeenCalledWith('chat-1', { tail: 12 })
  })

  it('force re-hydrates even when already cached', async () => {
    projectionState.fetchChat.mockResolvedValue(okResult('chat-1', [{ role: 'user', data: 'a', chatId: 'm1' }]))
    await hydrateActiveChat()
    projectionState.fetchChat.mockResolvedValue(okResult('chat-1', [{ role: 'user', data: 'b', chatId: 'm1' }]))
    await hydrateActiveChat({ force: true })
    expect(projectionState.fetchChat).toHaveBeenCalledTimes(2)
    expect(db().characters[0].chats[0].message).toEqual([{ role: 'user', data: 'b', chatId: 'm1' }])
  })

  it('invalidates only one cached chat so it can hydrate again', async () => {
    projectionState.fetchChat.mockImplementation(async (chatId: string) =>
      okResult(chatId, [{ role: 'user', data: `load ${chatId}`, chatId: `m-${chatId}` }]),
    )

    await hydrateChatMessages('chat-1')
    await hydrateChatMessages('chat-2')
    await hydrateChatMessages('chat-1')
    expect(projectionState.fetchChat).toHaveBeenCalledTimes(2)

    invalidateChatHydration('chat-1')
    await hydrateChatMessages('chat-1')
    await hydrateChatMessages('chat-2')

    expect(projectionState.fetchChat).toHaveBeenCalledTimes(3)
    expect(projectionState.fetchChat).toHaveBeenLastCalledWith('chat-1', {})
  })

  it('rejects strict single-chat hydration when the full transcript cannot be loaded', async () => {
    projectionState.fetchChat.mockResolvedValue({ status: 'error', error: 'offline' })

    await expect(hydrateChatMessages('chat-1', { strict: true })).rejects.toThrow(
      'Chat hydration incomplete for: chat-1',
    )
    expect(db().characters[0].chats[0].message).toEqual([])
  })

  it('aborts strict single-chat hydration even when the resource read never settles', async () => {
    projectionState.fetchChat.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()

    const hydration = hydrateChatMessages('chat-1', {
      force: true,
      strict: true,
      signal: controller.signal,
    })
    expect(projectionState.fetchChat).toHaveBeenCalledWith('chat-1', { signal: controller.signal })

    controller.abort()

    await expect(hydration).rejects.toThrow('Chat hydration aborted for: chat-1')
  })

  it('rejects a failed forced strict refresh even when an older hydration marker exists', async () => {
    projectionState.fetchChat.mockResolvedValueOnce(
      okResult('chat-1', [{ role: 'user', data: 'resident', chatId: 'm-resident' }]),
    )
    await hydrateChatMessages('chat-1', { strict: true })
    projectionState.fetchChat.mockResolvedValueOnce({ status: 'error', error: 'offline' })

    await expect(hydrateChatMessages('chat-1', { force: true, strict: true })).rejects.toThrow(
      'Chat hydration incomplete for: chat-1',
    )
    expect(db().characters[0].chats[0].message).toEqual([{ role: 'user', data: 'resident', chatId: 'm-resident' }])
  })

  it('preserves a fully loaded prefix when a ranged generation projection appends', async () => {
    const existingMessages = [
      { role: 'user', data: 'first', chatId: 'm1' },
      { role: 'char', data: 'second', chatId: 'm2' },
    ]
    projectionState.fetchChat.mockResolvedValue(okResult('chat-1', existingMessages))
    await hydrateActiveChatFully()

    const appended = { role: 'char', data: 'generated', chatId: 'm3' }
    expect(applyServerChatMessagesResource('chat-1', [appended], undefined, [], { start: 2, total: 3 })).toBe(true)

    expect(db().characters[0].chats[0].message).toEqual([...existingMessages, appended])
    expect((db().characters[0].chats[0].message as Message[]).some(isServerChatMessagePlaceholder)).toBe(false)

    projectionState.fetchChat.mockClear()
    await hydrateActiveChatWindow(3)
    expect(projectionState.fetchChat).not.toHaveBeenCalled()
  })

  it('exposes the live owner array and advances its epoch after authoritative projection', async () => {
    const before = getChatMessageOwnerState('chat-1')
    expect(before?.messages).toBe(charactersResourceState.characters[0].chats[0].message)
    const initialEpoch = before?.projectionEpoch

    projectionState.fetchChat.mockResolvedValue(
      okResult('chat-1', [{ role: 'user', data: 'owner', chatId: 'm-owner' }]),
    )
    await hydrateActiveChatFully()

    const after = getChatMessageOwnerState('chat-1')
    expect(after?.messages).not.toBe(db().characters[0].chats[0].message)
    expect(after?.messages).toEqual([{ role: 'user', data: 'owner', chatId: 'm-owner' }])
    expect(after?.projectionEpoch).not.toBe(initialEpoch)
    expect(after?.resourceLoaded).toBe(true)
  })

  it('keeps owner rows independent from aggregate divergence and syncs accepted local changes', async () => {
    projectionState.fetchChat.mockResolvedValue(
      okResult('chat-1', [{ role: 'user', data: 'owner', chatId: 'm-owner' }]),
    )
    await hydrateActiveChatFully()

    const ownerBefore = getChatMessageOwnerState('chat-1')
    db().characters[0].chats[0].message = [{ role: 'user', data: 'aggregate-only', chatId: 'm-aggregate' }]
    expect(getChatMessageOwnerState('chat-1')?.messages).toEqual(ownerBefore?.messages)

    expect(acknowledgeMessageMutationLocalEffect('chat-1')).toBe(true)
    expect(getChatMessageOwnerState('chat-1')?.messages).toEqual(db().characters[0].chats[0].message)
  })

  it('clears owner projections on reset and repopulates them on the next hydration', async () => {
    projectionState.fetchChat.mockResolvedValue(
      okResult('chat-1', [{ role: 'user', data: 'before', chatId: 'm-before' }]),
    )
    await hydrateActiveChatFully()
    const ownedBeforeReset = getChatMessageOwnerState('chat-1')?.messages
    expect(ownedBeforeReset).toEqual([{ role: 'user', data: 'before', chatId: 'm-before' }])

    resetChatHydration()
    db().characters[0].chats[0].message = [{ role: 'user', data: 'legacy fallback', chatId: 'm-fallback' }]
    expect(getChatMessageOwnerState('chat-1')?.messages).toEqual(db().characters[0].chats[0].message)
    expect(getChatMessageOwnerState('chat-1')?.messages).not.toBe(ownedBeforeReset)

    projectionState.fetchChat.mockResolvedValue(
      okResult('chat-1', [{ role: 'user', data: 'after', chatId: 'm-after' }]),
    )
    await hydrateActiveChatFully()
    expect(getChatMessageOwnerState('chat-1')?.messages).toEqual([{ role: 'user', data: 'after', chatId: 'm-after' }])
  })

  it('preserves resident Hypa state when a narrow generation payload omits it', async () => {
    const existingMessages = [{ role: 'user', data: 'first', chatId: 'm1' }]
    projectionState.fetchChat.mockResolvedValue({
      ...okResult('chat-1', existingMessages),
      hypaV3Data: { resident: true },
    })
    await hydrateActiveChatFully()

    expect(
      applyServerChatMessagesResource(
        'chat-1',
        [{ role: 'char', data: 'generated', chatId: 'm2' }],
        undefined,
        [],
        { start: 1, total: 2 },
        { hypaV3DataIncluded: false },
      ),
    ).toBe(true)

    expect((db().characters[0].chats[0] as { hypaV3Data?: unknown }).hypaV3Data).toEqual({ resident: true })
  })

  it('clears an accepted-send warning when a ranged generation projection supplies the persisted reply', async () => {
    const accepted = { role: 'user', data: 'hello', chatId: 'message-a' }
    projectionState.fetchChat.mockResolvedValue(okResult('chat-1', [accepted]))
    await hydrateActiveChatFully()
    recordAcceptedSendRecovery(
      {
        id: 'chat-1:message:message-a',
        target: { selectedCharID: 0, chatPage: 0, characterId: 'char-1', chatId: 'chat-1' },
        messageId: 'message-a',
        syntheticSayNothing: false,
      },
      'generation_failed',
    )

    expect(
      applyServerChatMessagesResource(
        'chat-1',
        [{ role: 'char', data: 'completed while backgrounded', chatId: 'generation-a' }],
        undefined,
        [],
        { start: 1, total: 2 },
      ),
    ).toBe(true)

    expect(get(acceptedSendRecoveries)).toEqual([])
  })

  it('hydrates only the active chat tail window and keeps absolute indexes stable', async () => {
    const projectionEpoch = captureChatBodyProjectionEpoch('chat-1')
    projectionState.fetchChat.mockResolvedValue(
      okWindowResult(
        'chat-1',
        [
          { role: 'user', data: 'tail-2', chatId: 'm3' },
          { role: 'char', data: 'tail-1', chatId: 'm4' },
        ],
        2,
        4,
      ),
    )

    await hydrateActiveChat({ loadPages: 2 })

    const messages = db().characters[0].chats[0].message as Message[]
    expect(messages).toHaveLength(4)
    expect(isServerChatMessagePlaceholder(messages[0])).toBe(true)
    expect(isServerChatMessagePlaceholder(messages[1])).toBe(true)
    expect(messages[2]).toEqual({ role: 'user', data: 'tail-2', chatId: 'm3' })
    expect(messages[3]).toEqual({ role: 'char', data: 'tail-1', chatId: 'm4' })
    expect(projectionState.fetchChat).toHaveBeenCalledWith('chat-1', { tail: 2 })
    expect(hasChatBodyProjectionEpochChanged('chat-1', projectionEpoch)).toBe(true)
  })

  it('fetches only newly visible unloaded ranges when the active window expands', async () => {
    projectionState.fetchChat.mockResolvedValueOnce({
      ...okWindowResult('chat-1', [{ role: 'char', data: 'tail', chatId: 'm4' }], 3, 4),
      revision: 2,
    })
    await hydrateActiveChat({ loadPages: 1 })
    projectionState.fetchChat.mockResolvedValueOnce({
      ...okWindowResult(
        'chat-1',
        [
          { role: 'user', data: 'older-1', chatId: 'm1' },
          { role: 'char', data: 'older-2', chatId: 'm2' },
          { role: 'user', data: 'older-3', chatId: 'm3' },
        ],
        0,
        4,
      ),
      revision: 1,
    })

    await hydrateActiveChatWindow(4)

    expect(projectionState.fetchChat).toHaveBeenNthCalledWith(1, 'chat-1', { tail: 1 })
    expect(projectionState.fetchChat).toHaveBeenNthCalledWith(2, 'chat-1', {
      start: 0,
      limit: 3,
    })
    const messages = db().characters[0].chats[0].message as Array<{ data: string }>
    expect(messages.map((message) => message.data)).toEqual(['older-1', 'older-2', 'older-3', 'tail'])
    expect(hasNewerChatBodyResourceRevision('chat-1', 1)).toBe(true)
    expect(getReaderChatMessageOwnerState('chat-1')?.messages).toEqual(messages)
  })

  it('reports an older-window hydration failure without claiming the range is resident', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      projectionState.fetchChat.mockResolvedValueOnce(
        okWindowResult('chat-1', [{ role: 'char', data: 'tail', chatId: 'm4' }], 3, 4),
      )
      await hydrateActiveChat({ loadPages: 1 })
      projectionState.fetchChat.mockResolvedValueOnce({ status: 'error', error: 'older range unavailable' })

      await expect(hydrateActiveChatWindow(4)).resolves.toBe(false)

      const messages = db().characters[0].chats[0].message as Message[]
      expect(messages.slice(0, 3).every(isServerChatMessagePlaceholder)).toBe(true)
      expect(messages[3]).toEqual({ role: 'char', data: 'tail', chatId: 'm4' })
    } finally {
      warn.mockRestore()
    }
  })

  it('hydrateChatMessages targets a specific (non-active) chat', async () => {
    projectionState.fetchChat.mockResolvedValue(okResult('chat-2', [{ role: 'char', data: 'yo', chatId: 'm2' }]))
    await hydrateChatMessages('chat-2')
    expect(projectionState.fetchChat).toHaveBeenCalledWith('chat-2', {})
    expect(db().characters[0].chats[1].message).toEqual([{ role: 'char', data: 'yo', chatId: 'm2' }])
  })

  it('full active hydration replaces a partial window and marks the chat cached', async () => {
    projectionState.fetchChat.mockResolvedValueOnce(
      okWindowResult('chat-1', [{ role: 'char', data: 'tail', chatId: 'm2' }], 1, 2),
    )
    await hydrateActiveChat({ loadPages: 1 })
    projectionState.fetchChat.mockResolvedValueOnce(
      okResult('chat-1', [
        { role: 'user', data: 'full-1', chatId: 'm1' },
        { role: 'char', data: 'full-2', chatId: 'm2' },
      ]),
    )

    await hydrateActiveChatFully()
    await hydrateActiveChatFully()

    expect(projectionState.fetchChat).toHaveBeenCalledTimes(2)
    expect(projectionState.fetchChat).toHaveBeenNthCalledWith(2, 'chat-1', {})
    expect(db().characters[0].chats[0].message).toEqual([
      { role: 'user', data: 'full-1', chatId: 'm1' },
      { role: 'char', data: 'full-2', chatId: 'm2' },
    ])
  })

  it('is a no-op when server projection is unavailable', async () => {
    projectionState.canUse.mockReturnValue(false)
    await hydrateActiveChat()
    await ensureAllChatsHydrated()
    expect(projectionState.fetchChat).not.toHaveBeenCalled()
    expect(projectionState.fetchBulkChat).not.toHaveBeenCalled()
  })

  it('is pending for an un-hydrated empty stub, and clears once messages arrive', async () => {
    // A fresh open chat: empty stub, never fetched -> loading.
    expect(isChatMessageHydrationPending('chat-1', 0)).toBe(true)

    projectionState.fetchChat.mockResolvedValue(okResult('chat-1', [{ role: 'user', data: 'hi', chatId: 'm1' }]))
    await hydrateActiveChat()

    // Messages present -> not loading.
    expect(isChatMessageHydrationPending('chat-1', 1)).toBe(false)
    // ...and still not loading even if asked with a stale zero count, because the
    // chat is now marked hydrated.
    expect(isChatMessageHydrationPending('chat-1', 0)).toBe(false)
  })

  it('clears for a legitimately empty chat once hydration settles', async () => {
    projectionState.fetchChat.mockResolvedValue(okResult('chat-1', []))
    await hydrateActiveChat()
    // Empty result, but the attempt is done -> show the greeting, not a spinner.
    expect(isChatMessageHydrationPending('chat-1', 0)).toBe(false)
  })

  it('surfaces a failed fetch and returns to loading while it retries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      projectionState.fetchChat.mockResolvedValue({ status: 'error', error: 'boom' })
      await hydrateActiveChat()
      expect(isChatMessageHydrationPending('chat-1', 0)).toBe(false)
      expect(hasChatMessageHydrationFailed('chat-1', 0)).toBe(true)
      expect(warn).toHaveBeenCalledWith('chat chat-1 hydration failed: boom')
      expect(browserEvidence.entries).toContainEqual(
        expect.objectContaining({ stage: 'hydration', outcome: 'failed', durationMs: expect.any(Number) }),
      )
      expect(JSON.stringify(browserEvidence.entries)).not.toContain('boom')

      const retry = deferred<ReturnType<typeof okResult>>()
      projectionState.fetchChat.mockReturnValueOnce(retry.promise)
      const retryPromise = hydrateActiveChat({ force: true })

      expect(hasChatMessageHydrationFailed('chat-1', 0)).toBe(false)
      expect(isChatMessageHydrationPending('chat-1', 0)).toBe(true)

      retry.resolve(okResult('chat-1', []))
      await retryPromise

      expect(hasChatMessageHydrationFailed('chat-1', 0)).toBe(false)
      expect(isChatMessageHydrationPending('chat-1', 0)).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('does not surface a failed response from before a hydration reset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = deferred<{ status: 'error'; error: string }>()
    try {
      projectionState.fetchChat.mockReturnValueOnce(response.promise)
      const hydration = hydrateActiveChat()
      resetChatHydration()

      response.resolve({ status: 'error', error: 'stale failure' })
      await hydration

      expect(hasChatMessageHydrationFailed('chat-1', 0)).toBe(false)
      expect(isChatMessageHydrationPending('chat-1', 0)).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it.each(['ready', 'failed'] as const)(
    'discards late %s hydration evidence after the browser session resets',
    async (outcome) => {
      const response = deferred<ReturnType<typeof okResult> | { status: 'error'; error: string }>()
      projectionState.fetchChat.mockReturnValueOnce(response.promise)
      const hydration = hydrateActiveChat()
      expect(browserEvidence.entries).toContainEqual(
        expect.objectContaining({ stage: 'hydration', outcome: 'pending' }),
      )
      resetChatHydration()
      browserEvidence.generation++
      browserEvidence.entries = []
      response.resolve(outcome === 'ready' ? okResult('chat-1', []) : { status: 'error', error: 'OLD_SESSION_CANARY' })
      await hydration
      expect(browserEvidence.entries).toEqual([])
    },
  )

  it('is never pending when messages are already present', () => {
    expect(isChatMessageHydrationPending('chat-1', 3)).toBe(false)
  })

  it('is never pending when server projection is off', () => {
    projectionState.canUse.mockReturnValue(false)
    expect(isChatMessageHydrationPending('chat-1', 0)).toBe(false)
  })

  it('is never pending without a chat id', () => {
    expect(isChatMessageHydrationPending(undefined, 0)).toBe(false)
  })

  it('becomes pending again after a resync re-stubs the chat', async () => {
    projectionState.fetchChat.mockResolvedValue(okResult('chat-1', [{ role: 'user', data: 'hi', chatId: 'm1' }]))
    await hydrateActiveChat()
    expect(isChatMessageHydrationPending('chat-1', 1)).toBe(false)

    // A foreign re-stub wipes messages and clears the hydration cache.
    resetChatHydration()
    expect(isChatMessageHydrationPending('chat-1', 0)).toBe(true)
  })
})
