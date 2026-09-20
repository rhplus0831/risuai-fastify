import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureClientSessionGeneration } from '../clientSession'
import {
  beginPendingMutationDispatch,
  clearPendingMutationOutbox,
  countBlockingPendingMutationRecords,
  countPendingMutationRecords,
  listPendingMutations,
  listChatOccupancyGenerationMutations,
  listOriginatingChatOccupancyGenerationMutations,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
  stageChatOccupancyGenerationMutation,
  type DurableMutationIntent,
} from './pendingMutationOutbox'
import { resetPersistenceActivityForTests } from './persistenceActivity.svelte'
import { settingsIntent } from './pendingMutationOutbox.testSupport'

const occupancyEvidence = vi.hoisted(() => ({ current: true, enabled: true, expectedEpoch: null as number | null }))

vi.mock('./chatOccupancy', () => ({
  isClientChatOccupancyAuthorityCurrent: (
    authority: { occupancyEpoch?: number },
    options?: { requireEnabled?: boolean },
  ) =>
    occupancyEvidence.current &&
    (occupancyEvidence.expectedEpoch === null || authority.occupancyEpoch === occupancyEvidence.expectedEpoch) &&
    (options?.requireEnabled !== true || occupancyEvidence.enabled),
}))

beforeEach(async () => {
  occupancyEvidence.current = true
  occupancyEvidence.enabled = true
  occupancyEvidence.expectedEpoch = null
  // This suite owns one isolated database; cross-tab locking has its own suite.
  vi.stubGlobal('navigator', {})
  vi.stubGlobal('indexedDB', new IDBFactory())
  resetPendingMutationOutboxForTests()
  resetPersistenceActivityForTests()
  await preparePendingMutationOutbox({
    writerSessionId: 'writer-a',
    writerEpoch: 1,
    databaseLineage: 'database-a',
    requestedWriterWasActive: true,
  })
})

afterEach(async () => {
  vi.useRealTimers()
  await clearPendingMutationOutbox()
  resetPendingMutationOutboxForTests()
  resetPersistenceActivityForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function occupancyAuthority(claimClass: 'owner' | 'chat_only' = 'chat_only') {
  return {
    version: 1 as const,
    databaseLineage: 'database-a',
    chatId: 'chat-a',
    sessionId: 'reader-a',
    sessionGeneration: captureClientSessionGeneration(),
    occupancyEpoch: 7,
    claimClass,
  }
}

function occupiedSendIntent(): DurableMutationIntent {
  return {
    version: 1,
    kind: 'generation-operation-submit',
    requests: [
      {
        method: 'POST',
        path: '/generation-operations',
        body: {
          protocolVersion: 1,
          operationId: '11111111-1111-4111-8111-111111111111',
          baseRevision: 7,
          characterId: 'character-a',
          chatId: 'chat-a',
          mode: 'send',
          acceptedMessageId: '22222222-2222-4222-8222-222222222222',
          message: { role: 'user', data: 'hello', chatId: '22222222-2222-4222-8222-222222222222' },
          draftGeneration: null,
          generation: {},
          chatOccupancy: { version: 1, interaction: 'send' },
        },
      },
    ],
  }
}

function occupiedStopIntent(): DurableMutationIntent {
  return {
    version: 1,
    kind: 'generation-operation-cancel',
    requests: [
      {
        method: 'PUT',
        path: '/generation-operations/11111111-1111-4111-8111-111111111111/cancellation',
        body: {
          reason: 'user_stop',
          chatId: 'chat-a',
          chatOccupancy: { version: 1, interaction: 'send' },
        },
      },
    ],
  }
}

describe('pending mutation outbox occupied-chat authority', () => {
  it('isolates occupied-chat generation rows from every general owner listing and counter', async () => {
    const authority = occupancyAuthority()
    const handle = stageChatOccupancyGenerationMutation(
      'generation-operation-submit:11111111-1111-4111-8111-111111111111',
      occupiedSendIntent(),
      authority,
    )
    await expect(handle.ready).resolves.toBe('persisted')

    await expect(listPendingMutations()).resolves.toEqual([])
    await expect(countPendingMutationRecords()).resolves.toBe(0)
    await expect(countBlockingPendingMutationRecords()).resolves.toBe(0)
    await expect(listChatOccupancyGenerationMutations(authority)).resolves.toEqual([
      expect.objectContaining({ intent: expect.objectContaining({ kind: 'generation-operation-submit' }) }),
    ])
  })

  it('rejects non-generation and wrong-chat intents from the occupied-chat lane', () => {
    const authority = occupancyAuthority()
    expect(() =>
      stageChatOccupancyGenerationMutation('settings:runtime', settingsIntent('forbidden'), authority),
    ).toThrow(/generation/u)
    const wrongChat = occupiedSendIntent()
    wrongChat.requests[0]!.body.chatId = 'chat-b'
    expect(() =>
      stageChatOccupancyGenerationMutation('generation-operation-submit:wrong-chat', wrongChat, authority),
    ).toThrow(/scoped/u)
    const smuggled = occupiedSendIntent()
    smuggled.requests.push({ method: 'PUT', path: '/settings', body: { patch: { username: 'forbidden' } } })
    expect(() =>
      stageChatOccupancyGenerationMutation('generation-operation-submit:smuggled', smuggled, authority),
    ).toThrow(/[Gg]eneration/u)
    const continueIntent = occupiedSendIntent()
    continueIntent.requests[0]!.body.mode = 'continue'
    continueIntent.requests[0]!.body.targetMessageId = 'assistant-a'
    ;(continueIntent.requests[0]!.body.chatOccupancy as Record<string, unknown>).interaction = 'continue'
    delete continueIntent.requests[0]!.body.acceptedMessageId
    expect(() =>
      stageChatOccupancyGenerationMutation('generation-operation-submit:continue', continueIntent, authority),
    ).toThrow(/scoped/u)
  })

  it('persists owner Continue in the exact occupied-chat lane', async () => {
    const authority = occupancyAuthority('owner')
    const intent = occupiedSendIntent()
    intent.requests[0]!.body.mode = 'continue'
    intent.requests[0]!.body.targetMessageId = 'assistant-a'
    ;(intent.requests[0]!.body.chatOccupancy as Record<string, unknown>).interaction = 'continue'
    delete intent.requests[0]!.body.acceptedMessageId
    delete intent.requests[0]!.body.message

    const handle = stageChatOccupancyGenerationMutation(
      'generation-operation-submit:11111111-1111-4111-8111-111111111111',
      intent,
      authority,
    )
    await expect(handle.ready).resolves.toBe('persisted')
    await expect(listChatOccupancyGenerationMutations(authority)).resolves.toEqual([
      expect.objectContaining({
        intent: expect.objectContaining({
          kind: 'generation-operation-submit',
          requests: [
            expect.objectContaining({
              body: expect.objectContaining({
                mode: 'continue',
                targetMessageId: 'assistant-a',
                chatOccupancy: { version: 1, interaction: 'continue' },
              }),
            }),
          ],
        }),
      }),
    ])
  })

  it.each([
    { label: 'Continue extend', mode: 'continue', interaction: 'continue', syntheticSayNothing: false },
    { label: 'Continue append', mode: 'continue', interaction: 'continue', syntheticSayNothing: true },
    { label: 'Regenerate', mode: 'regenerate', interaction: 'regenerate', syntheticSayNothing: false },
  ] as const)(
    'retains an accepted owner $label row and permits its new Stop after same-tuple normalization',
    async (scenario) => {
      const ownerAuthority = occupancyAuthority('owner')
      const intent = occupiedSendIntent()
      intent.requests[0]!.body.mode = scenario.mode
      intent.requests[0]!.body.targetMessageId = 'assistant-a'
      intent.requests[0]!.body.generation = { syntheticSayNothing: scenario.syntheticSayNothing }
      ;(intent.requests[0]!.body.chatOccupancy as Record<string, unknown>).interaction = scenario.interaction
      delete intent.requests[0]!.body.acceptedMessageId
      delete intent.requests[0]!.body.message
      const submit = stageChatOccupancyGenerationMutation(
        'generation-operation-submit:11111111-1111-4111-8111-111111111111',
        intent,
        ownerAuthority,
      )
      await expect(submit.ready).resolves.toBe('persisted')

      const normalizedAuthority = { ...ownerAuthority, claimClass: 'chat_only' as const }
      expect(() =>
        stageChatOccupancyGenerationMutation(
          'generation-operation-submit:fresh-after-normalization',
          intent,
          normalizedAuthority,
        ),
      ).toThrow(/scoped/u)
      await expect(listChatOccupancyGenerationMutations(normalizedAuthority)).resolves.toEqual([
        expect.objectContaining({
          handle: expect.objectContaining({
            ownerWriterSessionId: ownerAuthority.sessionId,
            writerEpoch: ownerAuthority.occupancyEpoch,
            databaseLineage: ownerAuthority.databaseLineage,
          }),
          intent: expect.objectContaining({
            requests: [
              expect.objectContaining({
                body: expect.objectContaining({
                  mode: scenario.mode,
                  targetMessageId: 'assistant-a',
                  generation: { syntheticSayNothing: scenario.syntheticSayNothing },
                  chatOccupancy: { version: 1, interaction: scenario.interaction },
                }),
              }),
            ],
          }),
        }),
      ])

      const stopIntent = occupiedStopIntent()
      ;(stopIntent.requests[0]!.body.chatOccupancy as Record<string, unknown>).interaction = scenario.interaction
      const stop = stageChatOccupancyGenerationMutation(
        'generation-operation-cancel:11111111-1111-4111-8111-111111111111',
        stopIntent,
        normalizedAuthority,
        { requireEnabled: false },
      )
      await expect(stop.ready).resolves.toBe('persisted')
      const recovered = await listOriginatingChatOccupancyGenerationMutations(normalizedAuthority)
      expect(recovered).toHaveLength(2)
      expect(recovered.map((entry) => entry.intent.kind)).toEqual([
        'generation-operation-submit',
        'generation-operation-cancel',
      ])
      expect(recovered.every((entry) => entry.epochDisposition === 'current')).toBe(true)
      await expect(beginPendingMutationDispatch(stop)).resolves.toBe('persisted')
    },
  )

  it('supersedes delayed occupied-chat dispatch when the exact authority changes', async () => {
    const handle = stageChatOccupancyGenerationMutation(
      'generation-operation-submit:11111111-1111-4111-8111-111111111111',
      occupiedSendIntent(),
      occupancyAuthority(),
    )
    await expect(handle.ready).resolves.toBe('persisted')
    occupancyEvidence.current = false

    await expect(beginPendingMutationDispatch(handle)).resolves.toBe('superseded')
  })

  it('keeps only exact Stop settlement available after rollout disables new submits', async () => {
    const authority = occupancyAuthority()
    const submit = stageChatOccupancyGenerationMutation(
      'generation-operation-submit:send',
      occupiedSendIntent(),
      authority,
    )
    const stop = stageChatOccupancyGenerationMutation(
      'generation-operation-cancel:11111111-1111-4111-8111-111111111111',
      occupiedStopIntent(),
      authority,
      { requireEnabled: false },
    )
    await expect(Promise.all([submit.ready, stop.ready])).resolves.toEqual(['persisted', 'persisted'])
    occupancyEvidence.enabled = false

    await expect(listChatOccupancyGenerationMutations(authority, { requireEnabled: false })).resolves.toEqual([
      expect.objectContaining({ intent: expect.objectContaining({ kind: 'generation-operation-cancel' }) }),
    ])
    await expect(beginPendingMutationDispatch(stop)).resolves.toBe('persisted')
    await expect(beginPendingMutationDispatch(submit)).resolves.toBe('superseded')
  })

  it('classifies an originating expired-epoch intent without transplanting its dispatch authority', async () => {
    const expiredAuthority = occupancyAuthority()
    const handle = stageChatOccupancyGenerationMutation(
      'generation-operation-submit:expired',
      occupiedSendIntent(),
      expiredAuthority,
    )
    await expect(handle.ready).resolves.toBe('persisted')
    const reacquiredAuthority = { ...expiredAuthority, occupancyEpoch: expiredAuthority.occupancyEpoch + 1 }
    occupancyEvidence.expectedEpoch = reacquiredAuthority.occupancyEpoch

    await expect(listChatOccupancyGenerationMutations(reacquiredAuthority)).resolves.toEqual([])
    const recovered = await listOriginatingChatOccupancyGenerationMutations(reacquiredAuthority)
    expect(recovered).toEqual([
      expect.objectContaining({
        chatId: 'chat-a',
        occupancyEpoch: 7,
        epochDisposition: 'stale',
        intent: expect.objectContaining({ kind: 'generation-operation-submit' }),
      }),
    ])
    await expect(beginPendingMutationDispatch(recovered[0]!.handle)).resolves.toBe('superseded')
    await expect(listPendingMutations()).resolves.toEqual([])
  })
})
