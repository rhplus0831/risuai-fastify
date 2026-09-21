import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClientSessionForTests } from '../clientSession'
import { acceptedSendRecoveries } from '../process/acceptedSendRecoveryState'
import {
  getRerollBuffer,
  getRerollId,
  resetRerollNavigation,
  seedRerollBufferFromAlternates,
} from '../process/rerollNavigation.svelte'
import { isServerChatMessagePlaceholder, type Message } from '../storage/database.svelte'
import { selectedCharID } from '../stores.svelte'
import {
  acknowledgeCreatedChatTranscriptLocalEffect,
  acknowledgeMessageMutationLocalEffect,
  applyMessageTranslationLocalEffect,
  applyServerChatMessagesResource,
  hydrateActiveChat,
  hydrateActiveChatFully,
  hydrateActiveChatWindow,
  hydrateChatMessages,
  invalidateChatHydration,
  isChatMessageHydrationPending,
  resetChatHydration,
} from './chatMessageHydration.svelte'
import {
  acceptedSendTarget,
  db,
  deferred,
  okResult,
  okWindowResult,
  seedTwoStubChats,
} from './chatMessageHydration.testFixtures'
import { clearRetainedChatProjections, registerRetainedChatProjection } from './chatRetainedProjection'
import { clearCachedServerCommandRevision, setCachedServerCommandRevision } from './commands'
import { resetLorebookHydration } from './lorebookOwner.svelte'
import { getProtocolDiagnosticsSnapshot } from './protocolDiagnostics'
import {
  captureChatBodyProjectionEpoch,
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

describe('chat hydration freshness', () => {
  it('reapplies a retained transcript projection after authoritative hydration', async () => {
    projectionState.fetchChat.mockResolvedValue(
      okResult('chat-1', [{ role: 'char', data: 'persisted', chatId: 'message-a' }]),
    )
    const release = registerRetainedChatProjection({ kind: 'chat-body', chatId: 'chat-1' }, () => {
      const message = db().characters[0].chats[0].message[0] as Record<string, unknown> | undefined
      if (message?.chatId === 'message-a') message.data = 'retained edit'
    })

    await hydrateActiveChat()

    expect(db().characters[0].chats[0].message).toEqual([{ role: 'char', data: 'retained edit', chatId: 'message-a' }])
    release()
  })

  it('drops an invalidated in-flight response while allowing an immediate replacement request', async () => {
    const stale = deferred<ReturnType<typeof okResult>>()
    const fresh = deferred<ReturnType<typeof okResult>>()
    projectionState.fetchChat.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)

    const staleRequest = hydrateChatMessages('chat-1')
    expect(projectionState.fetchChat).toHaveBeenCalledTimes(1)
    invalidateChatHydration('chat-1')
    const freshRequest = hydrateChatMessages('chat-1')
    expect(projectionState.fetchChat).toHaveBeenCalledTimes(2)

    stale.resolve(okResult('chat-1', [{ role: 'user', data: 'stale', chatId: 'm-stale' }]))
    await staleRequest
    expect(db().characters[0].chats[0].message).toEqual([])

    fresh.resolve(okResult('chat-1', [{ role: 'user', data: 'fresh', chatId: 'm-fresh' }]))
    await freshRequest
    expect(db().characters[0].chats[0].message).toEqual([{ role: 'user', data: 'fresh', chatId: 'm-fresh' }])
  })

  it('still applies a response when an unrelated command bumps the revision mid-flight', async () => {
    // Real char-open (changeChar) sets selectedCharID (starting this slow chat
    // hydration) AND dispatches a `character.selected` command. That tiny command
    // commits first and advances the cached revision, while the big hydration
    // response carries the older revision it was built at. The messages are NOT
    // stale (select never touched them) and must still render.
    setCachedServerCommandRevision(1)
    projectionState.fetchChat.mockImplementation(async () => {
      // The concurrent select command lands while this fetch is in flight.
      setCachedServerCommandRevision(2)
      return { ...okResult('chat-1', [{ role: 'user', data: 'hi', chatId: 'm1' }]), revision: 1 }
    })

    await hydrateActiveChat()

    expect(db().characters[0].chats[0].message).toEqual([{ role: 'user', data: 'hi', chatId: 'm1' }])
  })

  it('does not let an older hydration replace a newer targeted message projection', async () => {
    const oldHydration = deferred<ReturnType<typeof okResult> & { hypaV3Data: unknown }>()
    projectionState.fetchChat.mockReturnValueOnce(oldHydration.promise)

    const pendingHydration = hydrateActiveChatFully()
    expect(projectionState.fetchChat).toHaveBeenCalledWith('chat-1', {})

    const projectedMessages = [{ role: 'char', data: 'projected', chatId: 'm-projected' }]
    const projectedAlternates = [
      projectedMessages[0],
      { role: 'char', data: 'projected alternate', chatId: 'm-projected-alt' },
    ]
    expect(
      applyServerChatMessagesResource('chat-1', projectedMessages, { source: 'new projection' }, projectedAlternates),
    ).toBe(true)

    oldHydration.resolve({
      ...okResult('chat-1', [{ role: 'char', data: 'old hydration', chatId: 'm-old' }]),
      hypaV3Data: { source: 'old hydration' },
      alternates: [{ role: 'char', data: 'old alternate', chatId: 'm-old-alt' }],
    })
    await pendingHydration

    expect(db().characters[0].chats[0].message).toEqual(projectedMessages)
    expect((db().characters[0].chats[0] as { hypaV3Data?: unknown }).hypaV3Data).toEqual({
      source: 'new projection',
    })
    expect(
      getRerollBuffer()
        .flat()
        .map((message) => message.data),
    ).toEqual(['projected alternate', 'projected'])
  })

  it('applies a translation by stable ids and drops an older transcript hydration', async () => {
    const oldHydration = deferred<ReturnType<typeof okResult>>()
    projectionState.fetchChat.mockReturnValueOnce(oldHydration.promise)
    const pendingHydration = hydrateActiveChatFully()
    const resident = { role: 'user', data: 'hello', chatId: 'm-resident' }
    db().characters[0].chats[0].message.push(resident)
    const translation = {
      source: 'raw' as const,
      text: 'translated',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm' as const,
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }

    expect(applyMessageTranslationLocalEffect('chat-1', 'm-resident', translation)).toBe(true)
    oldHydration.resolve(okResult('chat-1', [{ role: 'user', data: 'stale', chatId: 'm-stale' }]))
    await pendingHydration

    expect(db().characters[0].chats[0].message).toEqual([{ ...resident, translation }])
    expect(applyMessageTranslationLocalEffect('chat-1', 'm-resident', null)).toBe(true)
    expect(db().characters[0].chats[0].message[0].translation).toBeNull()
    expect(applyMessageTranslationLocalEffect('chat-2', 'm-resident', translation)).toBe(false)
  })

  it('acknowledges a byte-identical optimistic mutation and drops an older hydration', async () => {
    const resident = { role: 'user', data: 'resident', chatId: 'm-resident' }
    db().characters[0].chats[0].message.push(resident)
    const oldHydration = deferred<ReturnType<typeof okResult>>()
    projectionState.fetchChat.mockReturnValueOnce(oldHydration.promise)
    const pendingHydration = hydrateActiveChatFully()
    const projectionEpoch = captureChatBodyProjectionEpoch('chat-1')

    expect(acknowledgeMessageMutationLocalEffect('chat-1')).toBe(true)
    expect(hasChatBodyProjectionEpochChanged('chat-1', projectionEpoch)).toBe(true)
    oldHydration.resolve(okResult('chat-1', [{ role: 'user', data: 'stale', chatId: 'm-stale' }]))
    await pendingHydration

    expect(db().characters[0].chats[0].message).toEqual([resident])
    expect(acknowledgeMessageMutationLocalEffect('missing-chat')).toBe(false)
  })

  it('applies hydration that starts after an unacknowledged direct transcript edit', async () => {
    const optimisticMessage = { role: 'user', data: 'optimistic edit', chatId: 'm-resident' }
    db().characters[0].chats[0].message.push(optimisticMessage)
    const optimisticProjectionEpoch = captureChatBodyProjectionEpoch('chat-1')
    const staleHydration = deferred<ReturnType<typeof okResult>>()
    projectionState.fetchChat.mockReturnValueOnce(staleHydration.promise)

    // This request starts after the optimistic edit, so its freshness snapshot
    // alone cannot distinguish a pre-command server response from the edit.
    const pendingHydration = hydrateActiveChatFully()
    staleHydration.resolve(okResult('chat-1', [{ role: 'user', data: 'pre-command body', chatId: 'm-resident' }]))
    await pendingHydration

    expect(db().characters[0].chats[0].message).toEqual([
      { role: 'user', data: 'pre-command body', chatId: 'm-resident' },
    ])
    expect(hasChatBodyProjectionEpochChanged('chat-1', optimisticProjectionEpoch)).toBe(true)
  })

  it('marks a complete created transcript hydrated and drops an older hydration', async () => {
    const resident = { role: 'user', data: 'created locally', chatId: 'm-created' }
    db().characters[0].chats[0].message.push(resident)
    const oldHydration = deferred<ReturnType<typeof okResult>>()
    projectionState.fetchChat.mockReturnValueOnce(oldHydration.promise)
    const pendingHydration = hydrateActiveChatFully()

    expect(acknowledgeCreatedChatTranscriptLocalEffect('chat-1')).toBe(true)
    oldHydration.resolve(okResult('chat-1', [{ role: 'user', data: 'stale', chatId: 'm-stale' }]))
    await pendingHydration

    expect(db().characters[0].chats[0].message).toEqual([resident])
    expect(isChatMessageHydrationPending('chat-1', 0)).toBe(false)
    expect(acknowledgeCreatedChatTranscriptLocalEffect('missing-chat')).toBe(false)
  })

  it('does not let an older hydration erase an optimistic local message or settle its rolled-back stub', async () => {
    const oldHydration = deferred<ReturnType<typeof okResult> & { hypaV3Data: unknown }>()
    projectionState.fetchChat.mockReturnValueOnce(oldHydration.promise)
    const pendingHydration = hydrateActiveChatFully()

    const localMessage = { role: 'char', data: 'optimistic local', chatId: 'm-local' }
    db().characters[0].chats[0].message.push(localMessage)
    ;(db().characters[0].chats[0] as { hypaV3Data?: unknown }).hypaV3Data = { source: 'optimistic local' }
    seedRerollBufferFromAlternates(
      [localMessage],
      [localMessage, { role: 'char', data: 'local alternate', chatId: 'm-local-alt' }],
    )

    oldHydration.resolve({
      ...okResult('chat-1', [{ role: 'char', data: 'old hydration', chatId: 'm-old' }]),
      hypaV3Data: { source: 'old hydration' },
      alternates: [{ role: 'char', data: 'old alternate', chatId: 'm-old-alt' }],
    })
    await pendingHydration

    expect(db().characters[0].chats[0].message).toEqual([localMessage])
    expect((db().characters[0].chats[0] as { hypaV3Data?: unknown }).hypaV3Data).toEqual({
      source: 'optimistic local',
    })
    expect(
      getRerollBuffer()
        .flat()
        .map((message) => message.data),
    ).toEqual(['local alternate', 'optimistic local'])

    // If the optimistic command then rolls back, the stale response must not
    // have marked this empty stub as an attempted/settled hydration.
    db().characters[0].chats[0].message = []
    delete (db().characters[0].chats[0] as { hypaV3Data?: unknown }).hypaV3Data
    expect(isChatMessageHydrationPending('chat-1', 0)).toBe(true)

    projectionState.fetchChat.mockResolvedValueOnce(
      okResult('chat-1', [{ role: 'user', data: 'fresh retry', chatId: 'm-fresh' }]),
    )
    await hydrateActiveChatFully()
    expect(projectionState.fetchChat).toHaveBeenCalledTimes(2)
    expect(db().characters[0].chats[0].message).toEqual([{ role: 'user', data: 'fresh retry', chatId: 'm-fresh' }])
  })

  it('preserves a reroll-only change while a full transcript read is pending', async () => {
    const resident = [{ role: 'char', data: 'resident reply', chatId: 'resident' }]
    db().characters[0].chats[0].message = resident
    const response = deferred<ReturnType<typeof okResult>>()
    projectionState.fetchChat.mockReturnValueOnce(response.promise)
    const hydration = hydrateActiveChatFully()
    const epoch = captureChatBodyProjectionEpoch('chat-1')

    seedRerollBufferFromAlternates(
      resident,
      [resident[0], { role: 'char', data: 'new local alternate', chatId: 'local-alternate' }],
      acceptedSendTarget(),
    )
    // Keep the transcript and epoch unchanged so only the reroll fence can reject this read.
    expect(db().characters[0].chats[0].message).toEqual(resident)
    expect(captureChatBodyProjectionEpoch('chat-1')).toBe(epoch)
    response.resolve(okResult('chat-1', [{ role: 'char', data: 'old server reply', chatId: 'old-reply' }]))
    await hydration

    expect(db().characters[0].chats[0].message).toEqual(resident)
    expect(getRerollBuffer(acceptedSendTarget()).map((candidate) => candidate[0]?.data)).toEqual([
      'new local alternate',
      'resident reply',
    ])
    expect(getRerollId(acceptedSendTarget())).toBe(1)
  })

  it('keeps a pending full hydration fresh across a compatible range hydration write', async () => {
    const tailHydration = deferred<ReturnType<typeof okWindowResult> & { hypaV3Data: unknown }>()
    const fullHydration = deferred<ReturnType<typeof okResult> & { hypaV3Data: unknown }>()
    projectionState.fetchChat.mockImplementation((_chatId: string, range: { tail?: number }) =>
      range.tail === 1 ? tailHydration.promise : fullHydration.promise,
    )

    const pendingTail = hydrateActiveChat({ loadPages: 1 })
    const pendingFull = hydrateActiveChatFully()

    tailHydration.resolve({
      ...okWindowResult('chat-1', [{ role: 'char', data: 'tail', chatId: 'm-tail' }], 1, 2),
      hypaV3Data: { source: 'tail hydration' },
    })
    await pendingTail

    fullHydration.resolve({
      ...okResult('chat-1', [
        { role: 'user', data: 'full head', chatId: 'm-head' },
        { role: 'char', data: 'full tail', chatId: 'm-tail' },
      ]),
      hypaV3Data: { source: 'full hydration' },
    })
    await pendingFull

    expect(db().characters[0].chats[0].message).toEqual([
      { role: 'user', data: 'full head', chatId: 'm-head' },
      { role: 'char', data: 'full tail', chatId: 'm-tail' },
    ])
    expect((db().characters[0].chats[0] as { hypaV3Data?: unknown }).hypaV3Data).toEqual({
      source: 'full hydration',
    })
  })

  it('drops an older deferred range before it overwrites a newer overlapping range', async () => {
    const olderHydration = deferred<ReturnType<typeof okWindowResult>>()
    const newerHydration = deferred<ReturnType<typeof okWindowResult>>()
    projectionState.fetchChat.mockImplementation((_chatId: string, range: { tail?: number }) =>
      range.tail === 3 ? olderHydration.promise : newerHydration.promise,
    )
    const staleDropsBefore = getProtocolDiagnosticsSnapshot().hydration.chat.staleResponseDrops

    const pendingOlder = hydrateActiveChat({ loadPages: 3 })
    const pendingNewer = hydrateActiveChat({ loadPages: 2 })

    newerHydration.resolve({
      ...okWindowResult(
        'chat-1',
        [
          { role: 'user', data: 'newer overlap 2', chatId: 'm2-new' },
          { role: 'char', data: 'newer overlap 3', chatId: 'm3-new' },
        ],
        2,
        4,
      ),
      revision: 2,
    })
    await expect(pendingNewer).resolves.toBe(true)

    olderHydration.resolve({
      ...okWindowResult(
        'chat-1',
        [
          { role: 'char', data: 'older non-overlap', chatId: 'm1-old' },
          { role: 'user', data: 'older overlap 2', chatId: 'm2-old' },
          { role: 'char', data: 'older overlap 3', chatId: 'm3-old' },
        ],
        1,
        4,
      ),
      revision: 1,
    })
    await expect(pendingOlder).resolves.toBe(false)
    expect(browserEvidence.entries).toContainEqual(
      expect.objectContaining({ stage: 'stale-response', outcome: 'stale-rejected' }),
    )
    expect(JSON.stringify(browserEvidence.entries)).not.toMatch(/older overlap|newer overlap|chat-1|m1-old/)

    const messages = db().characters[0].chats[0].message as Message[]
    expect(isServerChatMessagePlaceholder(messages[1])).toBe(true)
    expect(messages.slice(2)).toEqual([
      { role: 'user', data: 'newer overlap 2', chatId: 'm2-new' },
      { role: 'char', data: 'newer overlap 3', chatId: 'm3-new' },
    ])
    expect(hasNewerChatBodyResourceRevision('chat-1', 1)).toBe(true)
    expect(getProtocolDiagnosticsSnapshot().hydration.chat.staleResponseDrops).toBe(staleDropsBefore + 1)

    projectionState.fetchChat.mockReset()
    projectionState.fetchChat.mockResolvedValueOnce({
      ...okWindowResult('chat-1', [{ role: 'char', data: 'fresh retry', chatId: 'm1-fresh' }], 1, 4),
      revision: 3,
    })
    await expect(hydrateActiveChatWindow(3)).resolves.toBe(true)
    expect(projectionState.fetchChat).toHaveBeenCalledWith('chat-1', { start: 1, limit: 1 })
    expect(db().characters[0].chats[0].message.slice(1)).toEqual([
      { role: 'char', data: 'fresh retry', chatId: 'm1-fresh' },
      { role: 'user', data: 'newer overlap 2', chatId: 'm2-new' },
      { role: 'char', data: 'newer overlap 3', chatId: 'm3-new' },
    ])
  })

  it('still drops a response older than the revision already applied at request start', async () => {
    // The genuine stale case the revision guard exists for: we had already applied
    // revision 5 BEFORE issuing this fetch, and the response reflects an older
    // revision 3 -> drop it rather than regress.
    setCachedServerCommandRevision(5)
    projectionState.fetchChat.mockResolvedValue({
      ...okResult('chat-1', [{ role: 'user', data: 'stale', chatId: 'm-old' }]),
      revision: 3,
    })

    await hydrateActiveChat()

    expect(db().characters[0].chats[0].message).toEqual([])
  })
})
