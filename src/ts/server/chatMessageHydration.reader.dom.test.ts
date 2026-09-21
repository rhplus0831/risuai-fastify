import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setManagedReaderForTest, setManagedWriterForTest } from '../__tests__/managedClientSession'
import {
  authorizeClientWriterRecovery,
  beginClientPromotion,
  completeClientWriterRecovery,
  demoteClientSession,
  requireClientAuthentication,
  resetClientSessionForTests,
} from '../clientSession'
import { acceptedSendRecoveries } from '../process/acceptedSendRecoveryState'
import { getRerollBuffer, getRerollId, resetRerollNavigation } from '../process/rerollNavigation.svelte'
import { SERVER_CHARACTER_SHELL_MARKER, isServerChatMessagePlaceholder } from '../storage/database.svelte'
import { selectedCharID } from '../stores.svelte'
import {
  applyServerChatMessagesResource,
  ensureAllChatsHydrated,
  getReaderChatMessageOwnerState,
  hasChatMessageHydrationFailed,
  hydrateActiveChat,
  hydrateActiveChatFully,
  hydrateReaderChatMessageWindow,
  hydrateReaderGenerationMessages,
  invalidateChatHydration,
  resetChatHydration,
} from './chatMessageHydration.svelte'
import {
  db,
  deferred,
  okBulkResult,
  okResult,
  okWindowResult,
  seedTwoStubChats,
} from './chatMessageHydration.testFixtures'
import { clearRetainedChatProjections, registerRetainedChatProjection } from './chatRetainedProjection'
import { clearCachedServerCommandRevision, setCachedServerCommandRevision } from './commands'
import { resetLorebookHydration } from './lorebookOwner.svelte'
import {
  applyCharacterResource,
  applyCharactersResource,
  captureChatBodyProjectionEpoch,
  charactersResourceState,
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

function promoteHydrationReader() {
  const promotion = beginClientPromotion()!
  expect(
    authorizeClientWriterRecovery(promotion, {
      databaseLineage: 'external-operation-database',
      writer: { sessionId: 'external-operation-test', epoch: 2 },
    }),
  ).toBe(true)
  expect(completeClientWriterRecovery(promotion)).toBe(true)
}

function readerRerollResult(start = 0, total = 2) {
  const user = { role: 'user', data: 'greet me', chatId: 'user' }
  const assistant = { role: 'char', data: 'rerolled reply', chatId: 'new-reply' }
  const alternate = { role: 'char', data: 'old reply', chatId: 'old-reply' }
  return {
    ...okWindowResult('chat-1', start === 0 ? [user, assistant] : [assistant], start, total),
    alternates: [assistant, alternate],
  }
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

describe('reader chat hydration and writer handoff', () => {
  it('rebuilds persisted reroll candidates when a reader-filled tail is handed to writer hydration', async () => {
    setManagedReaderForTest()
    seedTwoStubChats()
    resetChatHydration()
    const user = { role: 'user', data: 'greet me', chatId: 'user' }
    const assistant = { role: 'char', data: 'rerolled reply', chatId: 'new-reply' }
    const alternate = { role: 'char', data: 'old reply', chatId: 'old-reply' }
    projectionState.fetchChat.mockResolvedValue({
      ...okWindowResult('chat-1', [user, assistant], 0, 2),
      alternates: [assistant, alternate],
    })

    await expect(hydrateReaderChatMessageWindow('chat-1', 2)).resolves.toBe(true)
    expect(db().characters[0].chats[0].message).toEqual([user, assistant])
    expect(getRerollBuffer()).toEqual([])
    expect(getRerollId()).toBe(-1)

    promoteHydrationReader()
    await expect(hydrateActiveChat({ loadPages: 2 })).resolves.toBe(true)

    expect(getRerollBuffer().map((candidate) => candidate[0]?.data)).toEqual(['old reply', 'rerolled reply'])
    expect(getRerollId()).toBe(1)
    expect(db().characters[0].chats[0].message).toEqual([user, assistant])
  })

  it.each([
    ['cached full transcript', 'none', 'full'],
    ['reset resident tail', 'reset', 'window'],
    ['reset full transcript', 'reset', 'full'],
    ['invalidated resident tail', 'invalidate', 'window'],
    ['invalidated full transcript', 'invalidate', 'full'],
  ] as const)('rebuilds reader alternates through %s', async (_name, reset, entrypoint) => {
    setManagedReaderForTest()
    seedTwoStubChats()
    const result = readerRerollResult()
    projectionState.fetchChat.mockResolvedValue(result)
    await expect(hydrateReaderChatMessageWindow('chat-1', 2)).resolves.toBe(true)
    const resident = db().characters[0].chats[0].message
    expect(getRerollBuffer()).toEqual([])
    if (reset === 'reset') resetChatHydration()
    else if (reset === 'invalidate') invalidateChatHydration('chat-1')
    expect(db().characters[0].chats[0].message).toBe(resident)
    promoteHydrationReader()

    if (entrypoint === 'full') await hydrateActiveChatFully()
    else await expect(hydrateActiveChat({ loadPages: 2 })).resolves.toBe(true)
    expect(getRerollBuffer().map((candidate) => candidate[0]?.data)).toEqual(['old reply', 'rerolled reply'])
    expect(getRerollId()).toBe(1)
    expect(projectionState.fetchChat).toHaveBeenCalledTimes(2)
    await hydrateActiveChat({ loadPages: 2 })
    expect(projectionState.fetchChat).toHaveBeenCalledTimes(2)
  })

  it('restores alternates for a reader-filled resident tail while older history remains unloaded', async () => {
    setManagedReaderForTest()
    seedTwoStubChats()
    projectionState.fetchChat.mockResolvedValue(readerRerollResult(5, 6))
    await expect(hydrateReaderChatMessageWindow('chat-1', 1)).resolves.toBe(true)
    expect(db().characters[0].chats[0].message.slice(0, 5).every(isServerChatMessagePlaceholder)).toBe(true)
    expect(getRerollBuffer()).toEqual([])
    promoteHydrationReader()
    await expect(hydrateActiveChat({ loadPages: 1 })).resolves.toBe(true)
    expect(getRerollBuffer().map((candidate) => candidate[0]?.data)).toEqual(['old reply', 'rerolled reply'])
    expect(db().characters[0].chats[0].message.slice(0, 5).every(isServerChatMessagePlaceholder)).toBe(true)
    expect(projectionState.fetchChat).toHaveBeenLastCalledWith('chat-1', { tail: 1 })
  })

  it.each(['same-revision summary clone', 'newer character detail'])(
    'preserves unseeded alternates through %s',
    async (refresh) => {
      setManagedReaderForTest()
      seedTwoStubChats()
      expect(
        applyCharactersResource({
          version: 1,
          revision: 1,
          characters: charactersResourceState.characters,
          characterOrder: ['char-1'],
          currentChar: 0,
        }),
      ).toBe(true)
      projectionState.fetchChat.mockResolvedValue(readerRerollResult())
      await expect(hydrateReaderChatMessageWindow('chat-1', 2)).resolves.toBe(true)
      const resident = db().characters[0].chats[0].message
      const epoch = captureChatBodyProjectionEpoch('chat-1')
      const metadata = JSON.parse(JSON.stringify(charactersResourceState.characters[0]))
      metadata.chats = metadata.chats.map((chat: { id: string }) => ({ id: chat.id, message: [] }))
      if (refresh === 'same-revision summary clone') {
        expect(
          applyCharactersResource({
            version: 1,
            revision: 1,
            characters: [{ ...metadata, [SERVER_CHARACTER_SHELL_MARKER]: true }],
            characterOrder: ['char-1'],
            currentChar: 0,
          }),
        ).toBe(true)
        expect(db().characters[0].chats[0].message).not.toBe(resident)
      } else {
        expect(applyCharacterResource({ revision: 2, character: metadata })).toBe(true)
        expect(db().characters[0].chats[0].message).toBe(resident)
      }
      expect(db().characters[0].chats[0].message).toEqual(resident)
      expect(captureChatBodyProjectionEpoch('chat-1')).toBe(epoch)
      resetChatHydration()
      promoteHydrationReader()
      await expect(hydrateActiveChat({ loadPages: 2 })).resolves.toBe(true)
      expect(getRerollBuffer().map((candidate) => candidate[0]?.data)).toEqual(['old reply', 'rerolled reply'])
    },
  )

  it.each(['event resource', 'bulk read'])(
    'defers reader %s alternates until authorized writer hydration',
    async (source) => {
      setManagedReaderForTest()
      seedTwoStubChats()
      const result = readerRerollResult()
      projectionState.fetchChat.mockResolvedValue(result)
      if (source === 'event resource') {
        expect(applyServerChatMessagesResource('chat-1', result.message, undefined, result.alternates)).toBe(true)
      } else {
        projectionState.fetchBulkChat.mockResolvedValueOnce({
          ...okBulkResult(['chat-1', 'chat-2']),
          chats: [
            { chatId: 'chat-1', message: result.message, alternates: result.alternates },
            { chatId: 'chat-2', message: [], alternates: [] },
          ],
        })
        await ensureAllChatsHydrated()
      }
      expect(db().characters[0].chats[0].message).toEqual(result.message)
      expect(getRerollBuffer()).toEqual([])
      expect(getRerollId()).toBe(-1)
      promoteHydrationReader()
      await expect(hydrateActiveChat({ loadPages: 2 })).resolves.toBe(true)
      expect(getRerollBuffer().map((candidate) => candidate[0]?.data)).toEqual(['old reply', 'rerolled reply'])
      expect(projectionState.fetchChat).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['failure', 'stale result'])(
    'keeps reader reroll hydration eligible after writer read %s',
    async (failure) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        setManagedReaderForTest()
        seedTwoStubChats()
        const result = readerRerollResult()
        projectionState.fetchChat.mockResolvedValue(result)
        await expect(hydrateReaderChatMessageWindow('chat-1', 2)).resolves.toBe(true)
        promoteHydrationReader()
        setCachedServerCommandRevision(1)
        projectionState.fetchChat.mockResolvedValueOnce(
          failure === 'failure' ? { status: 'error', error: 'offline' } : { ...result, revision: 0 },
        )
        await expect(hydrateActiveChat({ loadPages: 2 })).resolves.toBe(false)
        expect(db().characters[0].chats[0].message).toEqual(result.message)
        expect(getRerollBuffer()).toEqual([])
        await expect(hydrateActiveChat({ loadPages: 2 })).resolves.toBe(true)
        expect(getRerollBuffer().map((candidate) => candidate[0]?.data)).toEqual(['old reply', 'rerolled reply'])
      } finally {
        warn.mockRestore()
      }
    },
  )

  it('aborts a reader window promptly and permits a new read while the old transport is still unresolved', async () => {
    const committed = { role: 'char', data: 'Committed body', chatId: 'committed' }
    applyServerChatMessagesResource('chat-1', [committed], undefined, [])
    const held = deferred<ReturnType<typeof okResult>>()
    projectionState.fetchChat.mockReturnValueOnce(held.promise)
    const controller = new AbortController()
    const reading = hydrateReaderChatMessageWindow('chat-1', 2, { force: true, signal: controller.signal })
    expect(projectionState.fetchChat).toHaveBeenCalledWith('chat-1', { tail: 2, signal: controller.signal })
    controller.abort()
    await expect(reading).resolves.toBe(false)
    expect(getReaderChatMessageOwnerState('chat-1')?.messages).toEqual([committed])
    projectionState.fetchChat.mockResolvedValueOnce(okResult('chat-1', [{ ...committed, data: 'New read' }]))
    await expect(hydrateReaderChatMessageWindow('chat-1', 2, { force: true })).resolves.toBe(true)
    held.resolve(okResult('chat-1', [{ ...committed, data: 'Obsolete transport' }]))
    await Promise.resolve()
    expect(getReaderChatMessageOwnerState('chat-1')?.messages[0]?.data).toBe('New read')
    expect(hasChatMessageHydrationFailed('chat-1', 1)).toBe(false)
  })

  it('fetches an exact reader generation suffix and preserves omitted Hypa state and a certified prefix', async () => {
    const prefix = { role: 'user', data: 'Prefix', chatId: 'prefix' }
    const target = { role: 'char', data: 'Original target', chatId: 'target' }
    applyServerChatMessagesResource('chat-1', [prefix, target], { retained: true }, [])
    const result = { role: 'char', data: 'Replacement result', chatId: 'result' }
    projectionState.fetchGenerationChat.mockResolvedValueOnce({
      ...okWindowResult('chat-1', [result], 1, 2),
      hypaV3DataIncluded: false,
    })
    await expect(hydrateReaderGenerationMessages('chat-1', 'result')).resolves.toBe(true)
    expect(projectionState.fetchGenerationChat).toHaveBeenCalledWith('chat-1', 'result', { signal: undefined })
    expect(projectionState.fetchChat).not.toHaveBeenCalled()
    expect(getReaderChatMessageOwnerState('chat-1')?.messages).toEqual([prefix, result])
    expect((db().characters[0].chats[0] as { hypaV3Data?: unknown }).hypaV3Data).toEqual({ retained: true })
  })

  it('rejects an exact generation read after abort and after a newer reader session', async () => {
    setManagedWriterForTest()
    seedTwoStubChats()
    demoteClientSession()
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(hydrateReaderGenerationMessages('chat-1', 'target', { signal: cancelled.signal })).resolves.toBe(false)
    expect(projectionState.fetchGenerationChat).not.toHaveBeenCalled()
    const held = deferred<ReturnType<typeof okResult>>()
    projectionState.fetchGenerationChat.mockReturnValueOnce(held.promise)
    const reading = hydrateReaderGenerationMessages('chat-1', 'target')
    expect(beginClientPromotion()).not.toBeNull()
    held.resolve(okResult('chat-1', [{ role: 'char', data: 'Obsolete exact generation', chatId: 'target' }]))
    await expect(reading).resolves.toBe(false)
    expect(getReaderChatMessageOwnerState('chat-1')?.messages).toEqual([])
  })

  it('keeps the certified reader body through demotion and failed reads without retaining writer overlays', async () => {
    setManagedWriterForTest()
    seedTwoStubChats()
    const committed = { role: 'user', data: 'committed', chatId: 'committed-id' }
    applyServerChatMessagesResource('chat-1', [committed], undefined, [])
    const pending = { role: 'user', data: 'pending', chatId: 'pending-id' }
    db().characters[0].chats[0].message.push(pending)
    registerRetainedChatProjection({ kind: 'chat-body', chatId: 'chat-1' }, () => {
      db().characters[0].chats[0].message.push(pending)
    })
    demoteClientSession()
    resetChatHydration()
    expect(getReaderChatMessageOwnerState('chat-1')).toMatchObject({ messages: [committed], resourceLoaded: false })
    const held = deferred<ReturnType<typeof okResult>>()
    projectionState.fetchChat.mockReturnValueOnce(held.promise)
    const reading = hydrateReaderChatMessageWindow('chat-1', 2)
    // Cleanup of the parked writer graph must neither leak pending rows nor
    // make this independent reader response stale.
    db().characters[0].chats[0].message = [pending]
    held.resolve(okResult('chat-1', [{ ...committed, data: 'newer server content' }]))
    await expect(reading).resolves.toBe(true)
    expect(getReaderChatMessageOwnerState('chat-1')?.messages.map((message) => message.data)).toEqual([
      'newer server content',
    ])
    expect(db().characters[0].chats[0].message.map((message) => message.data)).toEqual([
      'newer server content',
      'pending',
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    projectionState.fetchChat.mockResolvedValueOnce({ status: 'error', error: 'read failed' })
    await expect(hydrateReaderChatMessageWindow('chat-1', 2, { force: true })).resolves.toBe(false)
    expect(getReaderChatMessageOwnerState('chat-1')?.messages.map((message) => message.data)).toEqual([
      'newer server content',
    ])
    warn.mockRestore()
    requireClientAuthentication()
    expect(getReaderChatMessageOwnerState('chat-1')).toBeUndefined()
  })

  it('rejects a retained-body reader response after promotion starts without a hydration reset', async () => {
    setManagedWriterForTest()
    seedTwoStubChats()
    const committed = { role: 'user', data: 'Last committed content', chatId: 'committed' }
    applyServerChatMessagesResource('chat-1', [committed], undefined, [])
    demoteClientSession()
    expect(getReaderChatMessageOwnerState('chat-1')?.resourceLoaded).toBe(false)
    const held = deferred<ReturnType<typeof okResult>>()
    projectionState.fetchChat.mockReturnValueOnce(held.promise)
    const reading = hydrateReaderChatMessageWindow('chat-1', 2)
    const retainedReaderState = getReaderChatMessageOwnerState('chat-1')
    expect(beginClientPromotion()).not.toBeNull()
    // The same retained snapshot remains current:false on both sides of the
    // operation boundary. Content equality alone cannot fence this response.
    expect(getReaderChatMessageOwnerState('chat-1')).toEqual(retainedReaderState)
    held.resolve(okResult('chat-1', [{ role: 'user', data: 'Obsolete reader response', chatId: 'old-response' }]))
    await expect(reading).resolves.toBe(false)
    expect(getReaderChatMessageOwnerState('chat-1')?.messages).toEqual([committed])
    expect(db().characters[0].chats[0].message).toEqual([committed])
  })

  it('drops a held reader body from a deleted incarnation even when both old and new stubs are empty', async () => {
    const held = deferred<ReturnType<typeof okResult>>()
    projectionState.fetchChat.mockReturnValueOnce(held.promise)
    const reading = hydrateReaderChatMessageWindow('chat-1', 2)
    const source = JSON.parse(JSON.stringify(charactersResourceState.characters[0]))
    applyCharacterResource({
      revision: 2,
      character: { ...source, chats: source.chats.filter((chat: { id: string }) => chat.id !== 'chat-1') },
    })
    applyCharacterResource({ revision: 3, character: source })
    held.resolve(okResult('chat-1', [{ role: 'user', data: 'Deleted incarnation response', chatId: 'old-message' }]))
    await expect(reading).resolves.toBe(false)
    expect(getReaderChatMessageOwnerState('chat-1')?.messages).toEqual([])
    expect(db().characters[0].chats[0].message).toEqual([])
  })

  it('fills reader history from certified placeholders despite a previously full writer and parked append', async () => {
    setManagedWriterForTest()
    seedTwoStubChats()
    applyServerChatMessagesResource(
      'chat-1',
      [
        { role: 'user', data: 'old prefix', chatId: 'm1' },
        { role: 'char', data: 'old tail', chatId: 'm2' },
      ],
      undefined,
      [],
    )
    demoteClientSession()
    projectionState.fetchChat.mockResolvedValueOnce({
      ...okWindowResult('chat-1', [{ role: 'char', data: 'new tail', chatId: 'm3' }], 2, 3),
      revision: 2,
    })
    await expect(hydrateReaderChatMessageWindow('chat-1', 1)).resolves.toBe(true)
    db().characters[0].chats[0].message.push({ role: 'user', data: 'parked writer append', chatId: 'pending' })
    projectionState.fetchChat.mockResolvedValueOnce(
      okWindowResult(
        'chat-1',
        [
          { role: 'user', data: 'certified prefix 1', chatId: 'm1' },
          { role: 'char', data: 'certified prefix 2', chatId: 'm2' },
        ],
        0,
        3,
      ),
    )
    await expect(hydrateReaderChatMessageWindow('chat-1', 3)).resolves.toBe(true)
    expect(projectionState.fetchChat).toHaveBeenLastCalledWith('chat-1', { start: 0, limit: 2 })
    expect(getReaderChatMessageOwnerState('chat-1')?.messages.map((row) => row.data)).toEqual([
      'certified prefix 1',
      'certified prefix 2',
      'new tail',
    ])
  })

  it('replaces deleted reader rows without restoring them from a deferred old body or a reset prefix', async () => {
    setManagedWriterForTest()
    seedTwoStubChats()
    applyServerChatMessagesResource(
      'chat-1',
      [
        { role: 'user', data: 'old prefix', chatId: 'old-prefix' },
        { role: 'char', data: 'old tail', chatId: 'old-tail' },
      ],
      undefined,
      [],
    )
    const held = deferred<ReturnType<typeof okResult>>()
    projectionState.fetchChat.mockReturnValueOnce(held.promise)
    const reading = hydrateReaderChatMessageWindow('chat-1', 2, { force: true })
    applyServerChatMessagesResource('chat-1', [], undefined, [])
    held.resolve(okResult('chat-1', [{ role: 'user', data: 'deleted content', chatId: 'old-prefix' }]))
    await expect(reading).resolves.toBe(false)
    expect(getReaderChatMessageOwnerState('chat-1')?.messages).toEqual([])
    applyServerChatMessagesResource(
      'chat-1',
      [
        { role: 'user', data: 'before reset', chatId: 'old-prefix' },
        { role: 'char', data: 'before reset tail', chatId: 'old-tail' },
      ],
      undefined,
      [],
    )
    resetChatHydration()
    projectionState.fetchChat.mockResolvedValueOnce(
      okWindowResult('chat-1', [{ role: 'char', data: 'replacement tail', chatId: 'replacement' }], 1, 2),
    )
    await expect(hydrateReaderChatMessageWindow('chat-1', 1)).resolves.toBe(true)
    const after = getReaderChatMessageOwnerState('chat-1')!.messages
    expect(isServerChatMessagePlaceholder(after[0])).toBe(true)
    expect(after[1].data).toBe('replacement tail')
    // A server deletion retires the old body even if the same id is later reused.
    const character = JSON.parse(JSON.stringify(charactersResourceState.characters[0]))
    applyCharacterResource({ revision: 3, character: { ...character, chats: [] } })
    expect(getReaderChatMessageOwnerState('chat-1')).toBeUndefined()
    applyCharacterResource({ revision: 4, character })
    expect(getReaderChatMessageOwnerState('chat-1')?.messages).toEqual([])
  })
})
