import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClientSessionForTests } from '../clientSession'
import { acceptedSendRecoveries, recordAcceptedSendRecovery } from '../process/acceptedSendRecoveryState'
import { getRerollBuffer, resetRerollNavigation } from '../process/rerollNavigation.svelte'
import { selectedCharID } from '../stores.svelte'
import {
  acknowledgeMessageMutationLocalEffect,
  applyServerChatMessagesResource,
  reconcileAcceptedSendCompletion,
  resetChatHydration,
} from './chatMessageHydration.svelte'
import { acceptedSendTarget, db, deferred, seedTwoStubChats } from './chatMessageHydration.testFixtures'
import { clearRetainedChatProjections, registerRetainedChatProjection } from './chatRetainedProjection'
import { clearCachedServerCommandRevision, setCachedServerCommandRevision } from './commands'
import { resetLorebookHydration } from './lorebookOwner.svelte'
import { hasNewerChatBodyResourceRevision, markChatBodyResourceRevision } from './resourceState.svelte'

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

function completedGenerationResult(
  options: {
    revision?: number
    chatId?: string
    message?: Array<Record<string, unknown>>
    messageStart?: number
    messageTotal?: number
    hypaV3Data?: unknown
    alternates?: unknown[]
  } = {},
) {
  const message = options.message ?? [
    { role: 'user', data: 'hello', chatId: 'message-a' },
    { role: 'char', data: 'complete reply', chatId: 'generation-a' },
  ]
  return {
    status: 'ok' as const,
    revision: options.revision ?? 7,
    chatId: options.chatId ?? 'chat-1',
    message,
    messageStart: options.messageStart ?? 0,
    messageTotal: options.messageTotal ?? message.length,
    hypaV3Data: options.hypaV3Data,
    alternates: options.alternates ?? [],
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

describe('accepted-send authoritative completion barrier', () => {
  it.each([
    { name: 'matching identities', operationId: 'operation-a', resultMessageId: 'generation-a', matches: true },
    { name: 'wrong result identity', operationId: 'operation-a', resultMessageId: 'other-reply', matches: false },
    {
      name: 'wrong operation identity',
      operationId: 'other-operation',
      resultMessageId: 'generation-a',
      matches: false,
    },
  ])(
    'checks $name in the downloaded completion',
    { tags: 'core' },
    async ({ operationId, resultMessageId, matches }) => {
      const accepted = { role: 'user', data: 'hello', chatId: 'message-a' }
      const reply = {
        role: 'char',
        data: 'complete reply',
        chatId: 'generation-a',
        generationInfo: { operationId: 'operation-a' },
      }
      db().characters[0].chats[0].message = [accepted]
      projectionState.fetchGenerationChat.mockResolvedValueOnce(
        completedGenerationResult({ message: [accepted, reply] }),
      )

      await expect(
        reconcileAcceptedSendCompletion(acceptedSendTarget(), 'message-a', { operationId, resultMessageId }),
      ).resolves.toEqual(
        matches ? { status: 'reconciled', source: 'applied' } : { status: 'not_reconciled', reason: 'reply_missing' },
      )
      expect(db().characters[0].chats[0].message).toEqual(matches ? [accepted, reply] : [accepted])
    },
  )

  it.each([
    { name: 'matching identities', operationId: 'operation-a', resultMessageId: 'generation-a', matches: true },
    { name: 'wrong result identity', operationId: 'operation-a', resultMessageId: 'other-reply', matches: false },
    {
      name: 'wrong operation identity',
      operationId: 'other-operation',
      resultMessageId: 'generation-a',
      matches: false,
    },
  ])('checks $name in a newer resident completion', async ({ operationId, resultMessageId, matches }) => {
    const accepted = { role: 'user', data: 'hello', chatId: 'message-a' }
    const reply = {
      role: 'char',
      data: 'newer reply',
      chatId: 'generation-a',
      generationInfo: { operationId: 'operation-a' },
    }
    db().characters[0].chats[0].message = [accepted]
    const response = deferred<ReturnType<typeof completedGenerationResult>>()
    projectionState.fetchGenerationChat.mockReturnValueOnce(response.promise)

    const reconciliation = reconcileAcceptedSendCompletion(acceptedSendTarget(), 'message-a', {
      operationId,
      resultMessageId,
    })
    expect(applyServerChatMessagesResource('chat-1', [accepted, reply], undefined, [])).toBe(true)
    markChatBodyResourceRevision('chat-1', 8)
    response.resolve(completedGenerationResult({ revision: 7 }))

    await expect(reconciliation).resolves.toEqual(
      matches
        ? { status: 'reconciled', source: 'newer_resident_projection' }
        : { status: 'not_reconciled', reason: 'superseded' },
    )
    expect(db().characters[0].chats[0].message).toEqual([accepted, reply])
  })

  it.each([
    { name: 'result identity', chatId: 'other-reply', operationId: 'operation-a' },
    { name: 'operation identity', chatId: 'generation-a', operationId: 'other-operation' },
  ])('rechecks $name after retained projections replace an adjacent reply', async ({ chatId, operationId }) => {
    const accepted = { role: 'user', data: 'hello', chatId: 'message-a' }
    const authoritativeReply = {
      role: 'char',
      data: 'complete reply',
      chatId: 'generation-a',
      generationInfo: { operationId: 'operation-a' },
    }
    const retainedReply = { role: 'char', data: 'retained reply', chatId, generationInfo: { operationId } }
    db().characters[0].chats[0].message = [accepted]
    projectionState.fetchGenerationChat.mockResolvedValueOnce(
      completedGenerationResult({ message: [accepted, authoritativeReply] }),
    )
    const release = registerRetainedChatProjection({ kind: 'chat-body', chatId: 'chat-1' }, () => {
      db().characters[0].chats[0].message = [accepted, retainedReply]
    })
    try {
      await expect(
        reconcileAcceptedSendCompletion(acceptedSendTarget(), 'message-a', {
          operationId: 'operation-a',
          resultMessageId: 'generation-a',
        }),
      ).resolves.toEqual({ status: 'not_reconciled', reason: 'post_apply_verification_failed' })
      expect(db().characters[0].chats[0].message).toEqual([accepted, retainedReply])
    } finally {
      release()
    }
  })

  it('applies a generation suffix to a background user-only chat before reporting reconciliation', async () => {
    const prefix = [
      { role: 'user', data: 'older user', chatId: 'older-user' },
      { role: 'char', data: 'older reply', chatId: 'older-reply' },
    ]
    const accepted = { role: 'user', data: 'optimistic hello', chatId: 'message-a' }
    const authoritativeAccepted = { role: 'user', data: 'hello', chatId: 'message-a' }
    const assistant = { role: 'char', data: 'complete reply', chatId: 'generation-a' }
    const alternate = { role: 'char', data: 'alternate reply', chatId: 'generation-alt' }
    db().characters[0].chats[0].message = [...prefix, accepted]
    db().characters[0].chatPage = 1
    projectionState.fetchGenerationChat.mockResolvedValueOnce(
      completedGenerationResult({
        message: [authoritativeAccepted, assistant],
        messageStart: 2,
        messageTotal: 4,
        hypaV3Data: { source: 'server' },
        alternates: [assistant, alternate],
      }),
    )
    recordAcceptedSendRecovery(
      {
        id: 'chat-1:message:message-a',
        target: acceptedSendTarget(),
        messageId: 'message-a',
        syntheticSayNothing: false,
      },
      'generation_failed',
    )

    await expect(reconcileAcceptedSendCompletion(acceptedSendTarget(), 'message-a')).resolves.toEqual({
      status: 'reconciled',
      source: 'applied',
    })

    expect(projectionState.fetchGenerationChat).toHaveBeenCalledWith('chat-1', 'message-a', {
      signal: undefined,
    })
    expect(db().characters[0].chats[0].message).toEqual([...prefix, authoritativeAccepted, assistant])
    expect((db().characters[0].chats[0] as { hypaV3Data?: unknown }).hypaV3Data).toEqual({ source: 'server' })
    expect(
      getRerollBuffer(acceptedSendTarget())
        .flat()
        .map((message) => message.data),
    ).toEqual(['alternate reply', 'complete reply'])
    expect(hasNewerChatBodyResourceRevision('chat-1', 6)).toBe(true)
    expect(get(acceptedSendRecoveries)).toEqual([])
  })

  it('replaces a partial assistant with the authoritative row without duplicating it', async () => {
    const accepted = { role: 'user', data: 'hello', chatId: 'message-a' }
    db().characters[0].chats[0].message = [accepted, { role: 'char', data: 'partial', chatId: 'generation-a' }]
    projectionState.fetchGenerationChat.mockResolvedValueOnce(
      completedGenerationResult({
        message: [accepted, { role: 'char', data: 'complete reply', chatId: 'generation-a' }],
      }),
    )

    await expect(reconcileAcceptedSendCompletion(acceptedSendTarget(), 'message-a')).resolves.toEqual({
      status: 'reconciled',
      source: 'applied',
    })
    expect(db().characters[0].chats[0].message).toEqual([
      accepted,
      { role: 'char', data: 'complete reply', chatId: 'generation-a' },
    ])
  })

  it.each([
    {
      name: 'wrong chat identity',
      response: completedGenerationResult({ chatId: 'chat-2' }),
      reason: 'wrong_chat',
    },
    {
      name: 'incomplete suffix range',
      response: completedGenerationResult({ messageStart: 0, messageTotal: 3 }),
      reason: 'invalid_range',
    },
    {
      name: 'missing accepted-message adjacency',
      response: completedGenerationResult({
        message: [
          { role: 'user', data: 'other', chatId: 'other-message' },
          { role: 'char', data: 'other reply', chatId: 'other-generation' },
        ],
      }),
      reason: 'reply_missing',
    },
  ])('fails closed for $name', async ({ response, reason }) => {
    const resident = [{ role: 'user', data: 'hello', chatId: 'message-a' }]
    db().characters[0].chats[0].message = resident
    projectionState.fetchGenerationChat.mockResolvedValueOnce(response)

    await expect(reconcileAcceptedSendCompletion(acceptedSendTarget(), 'message-a')).resolves.toEqual({
      status: 'not_reconciled',
      reason,
    })
    expect(db().characters[0].chats[0].message).toEqual(resident)
  })

  it('rejects a response older than the revision known when the fetch began', async () => {
    const resident = [{ role: 'user', data: 'hello', chatId: 'message-a' }]
    db().characters[0].chats[0].message = resident
    setCachedServerCommandRevision(8)
    projectionState.fetchGenerationChat.mockResolvedValueOnce(completedGenerationResult({ revision: 7 }))

    await expect(reconcileAcceptedSendCompletion(acceptedSendTarget(), 'message-a')).resolves.toEqual({
      status: 'not_reconciled',
      reason: 'older_revision',
    })
    expect(db().characters[0].chats[0].message).toEqual(resident)
  })

  it('accepts a newer authoritative projection that supersedes the fetched body and proves residency', async () => {
    const accepted = { role: 'user', data: 'hello', chatId: 'message-a' }
    const assistant = { role: 'char', data: 'newer reply', chatId: 'generation-newer' }
    db().characters[0].chats[0].message = [accepted]
    const response = deferred<ReturnType<typeof completedGenerationResult>>()
    projectionState.fetchGenerationChat.mockReturnValueOnce(response.promise)

    const reconciliation = reconcileAcceptedSendCompletion(acceptedSendTarget(), 'message-a')
    expect(
      applyServerChatMessagesResource('chat-1', [accepted, assistant], undefined, [], { start: 0, total: 2 }),
    ).toBe(true)
    markChatBodyResourceRevision('chat-1', 8)
    response.resolve(completedGenerationResult({ revision: 7 }))

    await expect(reconciliation).resolves.toEqual({
      status: 'reconciled',
      source: 'newer_resident_projection',
    })
    expect(db().characters[0].chats[0].message).toEqual([accepted, assistant])
  })

  it('does not mistake a locally superseding partial row for authoritative completion', async () => {
    const accepted = { role: 'user', data: 'hello', chatId: 'message-a' }
    db().characters[0].chats[0].message = [accepted]
    const response = deferred<ReturnType<typeof completedGenerationResult>>()
    projectionState.fetchGenerationChat.mockReturnValueOnce(response.promise)

    const reconciliation = reconcileAcceptedSendCompletion(acceptedSendTarget(), 'message-a')
    const partial = { role: 'char', data: 'partial local stream', chatId: 'generation-a' }
    db().characters[0].chats[0].message.push(partial)
    expect(acknowledgeMessageMutationLocalEffect('chat-1')).toBe(true)
    response.resolve(completedGenerationResult())

    await expect(reconciliation).resolves.toEqual({ status: 'not_reconciled', reason: 'superseded' })
    expect(db().characters[0].chats[0].message).toEqual([accepted, partial])
  })

  it('fails closed when the stable target no longer exists', async () => {
    db().characters[0].chats = db().characters[0].chats.filter((chat) => chat.id !== 'chat-1')
    projectionState.fetchGenerationChat.mockResolvedValueOnce(completedGenerationResult())

    await expect(reconcileAcceptedSendCompletion(acceptedSendTarget(), 'message-a')).resolves.toEqual({
      status: 'not_reconciled',
      reason: 'target_missing',
    })
  })

  it('requires post-apply adjacency after retained projections are reapplied', async () => {
    const accepted = { role: 'user', data: 'hello', chatId: 'message-a' }
    db().characters[0].chats[0].message = [accepted]
    recordAcceptedSendRecovery(
      {
        id: 'chat-1:message:message-a',
        target: acceptedSendTarget(),
        messageId: 'message-a',
        syntheticSayNothing: false,
      },
      'generation_failed',
    )
    const release = registerRetainedChatProjection({ kind: 'chat-body', chatId: 'chat-1' }, () => {
      db().characters[0].chats[0].message = [accepted]
    })
    projectionState.fetchGenerationChat.mockResolvedValueOnce(completedGenerationResult())

    await expect(reconcileAcceptedSendCompletion(acceptedSendTarget(), 'message-a')).resolves.toEqual({
      status: 'not_reconciled',
      reason: 'post_apply_verification_failed',
    })
    expect(db().characters[0].chats[0].message).toEqual([accepted])
    expect(get(acceptedSendRecoveries)).toEqual([expect.objectContaining({ messageId: 'message-a' })])
    release()
  })

  it('settles an aborted never-ending transcript fetch as authority unavailable', async () => {
    const controller = new AbortController()
    projectionState.fetchGenerationChat.mockReturnValueOnce(new Promise(() => {}))

    const reconciliation = reconcileAcceptedSendCompletion(acceptedSendTarget(), 'message-a', {
      signal: controller.signal,
    })
    const fetchSignal = projectionState.fetchGenerationChat.mock.calls[0]?.[2]?.signal
    expect(fetchSignal).toBe(controller.signal)
    controller.abort()

    await expect(reconciliation).resolves.toEqual({
      status: 'not_reconciled',
      reason: 'authority_unavailable',
    })
  })
})
