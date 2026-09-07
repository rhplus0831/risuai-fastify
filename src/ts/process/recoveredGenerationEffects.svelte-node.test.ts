import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerGenerationEffectLedgerRef } from '@risuai/protocol/generation-sse'

const state = vi.hoisted(() => ({
  order: [] as string[],
  pluginRuntimeReady: true,
  db: {
    igpPrompt: 'IGP prompt',
    emotionProcesser: 'embedding',
    characters: [
      {
        chaId: 'character-a',
        name: 'Character',
        viewScreen: 'emotion',
        inlayViewScreen: false,
        emotionImages: [['happy', 'happy.png']],
        chats: [
          {
            id: 'chat-a',
            message: [
              { role: 'user', data: 'hello', chatId: 'user-a' },
              {
                role: 'char',
                data: 'reply',
                chatId: 'message-a',
                generationInfo: { generationId: 'generation-a', databaseLineage: 'lineage-a' },
              },
            ],
          },
        ],
      },
    ],
  },
  ownerCharacters: [] as Array<Record<string, any>>,
}))

vi.mock('../storage/database.svelte', () => ({ getDatabase: () => state.db }))
vi.mock('../activeChatGenerationSettings', () => ({
  resolveActiveChatGenerationSettings: ({ target }: { target: { characterId: string; chatId: string } }) => {
    const character = state.ownerCharacters.find((candidate) => candidate.chaId === target.characterId)
    const chat = character?.chats.find((candidate: { id?: string }) => candidate.id === target.chatId)
    return {
      character,
      chat,
      db: { ...state.db, characters: state.ownerCharacters },
    }
  },
}))
vi.mock('../plugins/chatOutputListeners', () => ({
  chatOutputListeners: new Set([vi.fn()]),
  isChatOutputRuntimeReady: () => state.pluginRuntimeReady,
  runChatOutputListeners: vi.fn(async () => {
    state.order.push('plugin_output')
  }),
}))
const hydration = vi.hoisted(() => ({
  hydrateChatMessages: vi.fn(async () => undefined),
  getChatMessageOwnerState: vi.fn((chatId: string) => {
    const chats = state.ownerCharacters.flatMap((character) => character.chats ?? [])
    const matches = chats.filter((chat) => chat.id === chatId)
    return matches.length === 1 ? { messages: matches[0].message, projectionEpoch: 0 } : undefined
  }),
}))
const effectResources = vi.hoisted(() => ({ ensure: vi.fn() }))
vi.mock('../server/routeResourceLoader', () => ({ ensureResourceSurfaces: effectResources.ensure }))
vi.mock('../server/chatMessageHydration.svelte', () => hydration)
vi.mock('./postGeneration/igp', () => ({
  evaluateIgp: vi.fn(async () => {
    state.order.push('igp')
    return true
  }),
}))
vi.mock('./postGeneration/charEmotionStore', () => ({
  loadAndTrimCharEmotion: () => ({ tempEmotion: [], charemotions: {} }),
}))
vi.mock('./postGeneration/emotionFallbackEmbedding', () => ({
  runEmotionEmbeddingFallback: vi.fn(async () => {
    state.order.push('emotion_image_state')
  }),
}))
vi.mock('./postGeneration/emotionFallbackLlm', () => ({ runEmotionLlmFallback: vi.fn() }))
vi.mock('./postGeneration/imggenStableDiff', () => ({ runImggenStableDiff: vi.fn() }))
vi.mock('./postGeneration/stableTarget', () => ({ stablePostGenerationMessageTarget: vi.fn() }))

const ledger = vi.hoisted(() => ({
  calls: [] as string[],
  receipts: new Set<string>(),
  unavailableKinds: new Set<string>(),
}))
vi.mock('./generationEffectLedger', async (importOriginal) => {
  const original = await importOriginal<typeof import('./generationEffectLedger')>()
  return {
    ...original,
    runLedgeredGenerationEffect: vi.fn(async (_ref, kind, delivery, effect) => {
      ledger.calls.push(`${delivery}:${kind}`)
      if (ledger.unavailableKinds.has(kind)) return { executed: false, status: 'unavailable' }
      if (kind === 'notification' || kind === 'tts' || kind === 'completion_sound') {
        return { executed: false, status: 'already_receipted' }
      }
      if (ledger.receipts.has(kind)) return { executed: false, status: 'already_receipted' }
      const result = await effect({
        idempotencyKey: `test:${kind}`,
        reclaimed: false,
        ...(kind === 'igp' ? { igpEffect: { generationId: _ref.generationId, claimId: 'recovered-igp-claim' } } : {}),
        isCurrent: () => true,
        signal: new AbortController().signal,
      })
      ledger.receipts.add(kind)
      return { executed: true, status: result.status, value: result.value }
    }),
  }
})

import {
  discardPendingRecoveredGenerationEffects,
  reconcilePendingRecoveredGenerationEffects,
  reconcileAcceptedSendGenerationEffects,
  reconcileRecoveredGenerationEffects,
  setPendingRecoveredGenerationEffects,
} from './recoveredGenerationEffects'
import { charactersResourceState, settingsResourceState } from '../server/resourceState.svelte'
import { resetClientSessionForTests } from '../clientSession'
import { demoteAndRepromoteForTest, setManagedWriterForTest } from '../__tests__/managedClientSession'
import { evaluateIgp } from './postGeneration/igp'

const ref: ServerGenerationEffectLedgerRef = {
  version: 1,
  databaseLineage: 'lineage-a',
  keyType: 'operation',
  keyId: 'operation-a',
  generationId: 'generation-a',
  characterId: 'character-a',
  chatId: 'chat-a',
  messageId: 'message-a',
}

beforeEach(() => {
  resetClientSessionForTests()
  effectResources.ensure.mockReset().mockResolvedValue(undefined)
  state.db.characters = [
    {
      ...state.db.characters[0],
      chats: [
        {
          ...state.db.characters[0].chats[0],
          message: [
            { role: 'user', data: 'hello', chatId: 'user-a' },
            {
              role: 'char',
              data: 'reply',
              chatId: 'message-a',
              generationInfo: { generationId: 'generation-a', databaseLineage: 'lineage-a' },
            },
          ],
        },
      ],
    },
  ]
  state.order = []
  state.ownerCharacters = structuredClone(state.db.characters)
  state.pluginRuntimeReady = true
  ledger.calls = []
  ledger.receipts.clear()
  ledger.unavailableKinds.clear()
  hydration.hydrateChatMessages.mockReset()
  hydration.hydrateChatMessages.mockResolvedValue(undefined)
  charactersResourceState.characters = state.ownerCharacters as never
  charactersResourceState.status = 'ready'
  settingsResourceState.value = {
    igpPrompt: state.db.igpPrompt,
    emotionProcesser: state.db.emotionProcesser,
  } as never
  settingsResourceState.status = 'ready'
  settingsResourceState.groupStatuses = { media: 'ready', advanced: 'ready' }
})

afterEach(() => {
  resetClientSessionForTests()
  charactersResourceState.characters = []
  charactersResourceState.status = 'idle'
  settingsResourceState.value = {}
  settingsResourceState.status = 'idle'
  settingsResourceState.groupStatuses = {}
})

describe('late recovered generation effects', () => {
  it('waits for scoped generation resources before claiming or skipping a configured durable effect', async () => {
    setManagedWriterForTest()
    let release!: () => void
    effectResources.ensure.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    settingsResourceState.value = {}
    settingsResourceState.groupStatuses = {}
    const pending = reconcileRecoveredGenerationEffects(ref)
    await Promise.resolve()
    expect(ledger.calls).toEqual([])
    expect(effectResources.ensure).toHaveBeenCalledWith(['runtime:chat-generation'])
    settingsResourceState.value = {
      igpPrompt: state.db.igpPrompt,
      emotionProcesser: state.db.emotionProcesser,
    } as never
    settingsResourceState.groupStatuses = { advanced: 'ready', media: 'ready' }
    release()
    await expect(pending).resolves.toMatchObject({ durableEffectsReconciled: true })
    expect(state.order).toEqual(['plugin_output', 'igp', 'emotion_image_state'])
    expect(vi.mocked(evaluateIgp)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        promptTemplate: state.db.igpPrompt,
        database: expect.objectContaining({ characters: state.ownerCharacters }),
        igpEffect: { generationId: ref.generationId, claimId: 'recovered-igp-claim' },
      }),
    )
  })

  it('retains effect work when generation resources fail instead of receipting not-configured', async () => {
    effectResources.ensure.mockRejectedValueOnce(new Error('Advanced settings unavailable'))
    await expect(reconcileRecoveredGenerationEffects(ref)).rejects.toThrow('Advanced settings unavailable')
    expect(ledger.calls).toEqual([])
    expect(ledger.receipts.size).toBe(0)
    await expect(reconcileRecoveredGenerationEffects(ref)).resolves.toMatchObject({ allEffectsReconciled: true })
    expect(state.order).toEqual(['plugin_output', 'igp', 'emotion_image_state'])
  })

  it('does not claim effects after resource hydration completes under a replaced writer generation', async () => {
    setManagedWriterForTest()
    let release!: () => void
    effectResources.ensure.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    const pending = reconcileRecoveredGenerationEffects(ref)
    await Promise.resolve()
    demoteAndRepromoteForTest()
    release()
    await expect(pending).resolves.toEqual({ durableEffectsReconciled: false, allEffectsReconciled: false })
    expect(ledger.calls).toEqual([])
    expect(state.order).toEqual([])
  })

  it('replays durable automation in live order, skips ephemerals, and recomputes emotion state', async () => {
    await expect(reconcileRecoveredGenerationEffects(ref)).resolves.toEqual({
      durableEffectsReconciled: true,
      allEffectsReconciled: true,
    })

    expect(state.order).toEqual(['plugin_output', 'igp', 'emotion_image_state'])
    expect(ledger.calls).toEqual(
      expect.arrayContaining([
        'late_recovery:notification',
        'late_recovery:tts',
        'late_recovery:completion_sound',
        'late_recovery:plugin_output',
        'late_recovery:igp',
        'late_recovery:emotion_image_state',
      ]),
    )

    await expect(reconcileRecoveredGenerationEffects(ref)).resolves.toEqual({
      durableEffectsReconciled: true,
      allEffectsReconciled: true,
    })
    expect(state.order).toEqual(['plugin_output', 'igp', 'emotion_image_state'])
  })

  it('runs only missing durable effects when one already has a receipt', async () => {
    ledger.receipts.add('igp')

    await expect(reconcileRecoveredGenerationEffects(ref)).resolves.toEqual({
      durableEffectsReconciled: true,
      allEffectsReconciled: true,
    })

    expect(state.order).toEqual(['plugin_output', 'emotion_image_state'])
  })

  it('reconciles from the ready character owner when the aggregate mirror is stale', async () => {
    const aggregate = state.db.characters[0]
    const owner = structuredClone(aggregate)
    owner.chats[0].message[1].data = 'owner reply'
    state.db = {
      ...state.db,
      characters: [{ ...aggregate, chats: [{ ...aggregate.chats[0], message: [] }] }],
    }
    state.ownerCharacters = [owner]
    charactersResourceState.characters = state.ownerCharacters as never
    charactersResourceState.status = 'ready'

    await expect(reconcileRecoveredGenerationEffects(ref)).resolves.toEqual({
      durableEffectsReconciled: true,
      allEffectsReconciled: true,
    })
    expect(state.order).toEqual(['plugin_output', 'igp', 'emotion_image_state'])
  })

  it('does not receipt recovered plugin output while the plugin runtime is incoherent', async () => {
    state.pluginRuntimeReady = false

    await expect(reconcileRecoveredGenerationEffects(ref)).rejects.toThrow('Plugin runtime is not ready')

    expect(ledger.calls).toEqual([])
    expect(ledger.receipts.has('plugin_output')).toBe(false)
    expect(state.order).toEqual([])
  })

  it('retains pending bootstrap effects when strict chat hydration must be retried', async () => {
    setPendingRecoveredGenerationEffects([
      {
        ledgerVersion: 1,
        databaseLineage: 'lineage-a',
        keyType: 'operation',
        keyId: 'operation-a',
        kind: 'plugin_output',
        effectClass: 'durable',
        operationId: 'operation-a',
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-a',
        status: 'pending',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      },
    ])
    hydration.hydrateChatMessages.mockRejectedValueOnce(new Error('chat body unavailable'))

    await expect(reconcilePendingRecoveredGenerationEffects()).rejects.toThrow('chat body unavailable')
    await expect(reconcilePendingRecoveredGenerationEffects()).resolves.toBeUndefined()

    expect(hydration.hydrateChatMessages).toHaveBeenCalledTimes(2)
    expect(hydration.hydrateChatMessages).toHaveBeenLastCalledWith('chat-a', { force: true, strict: true })
  })

  it('retains pending bootstrap effects when a ledger claim is temporarily unavailable', async () => {
    setPendingRecoveredGenerationEffects([
      {
        ledgerVersion: 1,
        databaseLineage: 'lineage-a',
        keyType: 'operation',
        keyId: 'operation-a',
        kind: 'plugin_output',
        effectClass: 'durable',
        operationId: 'operation-a',
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-a',
        status: 'pending',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      },
    ])
    ledger.unavailableKinds.add('plugin_output')

    await expect(reconcilePendingRecoveredGenerationEffects()).rejects.toThrow(
      'Generation effects remain unavailable for generation-a',
    )

    ledger.unavailableKinds.clear()
    await expect(reconcilePendingRecoveredGenerationEffects()).resolves.toBeUndefined()
    expect(ledger.receipts.has('plugin_output')).toBe(true)
  })

  it('permanently skips pending recovery effects without running their callbacks', async () => {
    setPendingRecoveredGenerationEffects([
      {
        ledgerVersion: 1,
        databaseLineage: 'lineage-a',
        keyType: 'operation',
        keyId: 'operation-a',
        kind: 'plugin_output',
        effectClass: 'durable',
        operationId: 'operation-a',
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-a',
        status: 'pending',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      },
      {
        ledgerVersion: 1,
        databaseLineage: 'lineage-a',
        keyType: 'operation',
        keyId: 'operation-a',
        kind: 'igp',
        effectClass: 'durable',
        operationId: 'operation-a',
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-a',
        status: 'pending',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      },
    ])

    await expect(discardPendingRecoveredGenerationEffects()).resolves.toBeUndefined()
    await expect(reconcilePendingRecoveredGenerationEffects()).resolves.toBeUndefined()

    expect(state.order).toEqual([])
    expect(ledger.calls).toEqual(['late_recovery:plugin_output', 'late_recovery:igp'])
    expect(hydration.hydrateChatMessages).not.toHaveBeenCalled()
  })

  it('retains pending recovery effects when discard cannot receipt one', async () => {
    setPendingRecoveredGenerationEffects([
      {
        ledgerVersion: 1,
        databaseLineage: 'lineage-a',
        keyType: 'operation',
        keyId: 'operation-a',
        kind: 'plugin_output',
        effectClass: 'durable',
        operationId: 'operation-a',
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-a',
        status: 'pending',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      },
    ])
    ledger.unavailableKinds.add('plugin_output')

    await expect(discardPendingRecoveredGenerationEffects()).rejects.toThrow('Generation effect could not be discarded')

    ledger.unavailableKinds.clear()
    await expect(discardPendingRecoveredGenerationEffects()).resolves.toBeUndefined()
    expect(ledger.calls).toEqual(['late_recovery:plugin_output', 'late_recovery:plugin_output'])
  })

  it('derives a generation-keyed ledger reference for pre-ref compatibility transcripts', async () => {
    await expect(
      reconcileAcceptedSendGenerationEffects(
        { selectedCharID: 0, chatPage: 0, characterId: 'character-a', chatId: 'chat-a' },
        'user-a',
      ),
    ).resolves.toEqual({ durableEffectsReconciled: true, allEffectsReconciled: true })

    expect(state.order).toEqual(['plugin_output', 'igp', 'emotion_image_state'])
  })
})
