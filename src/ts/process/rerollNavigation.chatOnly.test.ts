import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const occupancy = vi.hoisted(() => ({
  enabled: true,
  authority: null as null | {
    version: 1
    databaseLineage: string
    chatId: string
    sessionId: string
    sessionGeneration: number
    occupancyEpoch: number
    claimClass: 'owner' | 'chat_only'
  },
  capture: vi.fn(),
  isCurrent: vi.fn(),
}))

vi.mock('../server/chatOccupancy', () => ({
  captureClientChatOccupancyAuthority: occupancy.capture,
  getClientChatOccupancySnapshot: () => ({ support: occupancy.enabled ? 'enabled' : 'disabled' }),
  isClientChatOccupancyAuthorityCurrent: occupancy.isCurrent,
}))

const commandSpies = vi.hoisted(() => ({
  currentChatScopedSnapshot: vi.fn(),
  dispatchReplaceTailMessagesScoped: vi.fn(),
  dispatchUpdateMessageScoped: vi.fn(),
}))

vi.mock('../chatCommands', () => commandSpies)

const prerollSpies = vi.hoisted(() => ({
  Prereroll: vi.fn(() => null),
  PreUnreroll: vi.fn(() => null),
  clearPrererolls: vi.fn(),
}))

vi.mock('./prereroll', () => prerollSpies)

const generationOperations = vi.hoisted(() => ({
  protocolAvailable: true,
  canUseProtocol: vi.fn(),
  stage: vi.fn(),
  submit: vi.fn(),
}))

vi.mock('../server/generationOperations', () => ({
  canUseGenerationOperationProtocol: generationOperations.canUseProtocol,
  stageTargetedGenerationOperation: generationOperations.stage,
  submitStagedTargetedGenerationOperation: generationOperations.submit,
}))
vi.mock('./request/clientContext', () => ({ readBrowserClientContext: () => ({ browserLanguage: 'en-US' }) }))
vi.mock('./request/serverChat', () => ({ SERVER_CHAT_CLIENT_CAPABILITIES: { regenerateTargetProjection: 1 } }))

import {
  beginClientSession,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
  settleClientReader,
} from '../clientSession'
import { selectedCharID } from '../stores.svelte'
import type { ActiveChatTarget } from '../chatCommands'
import { testDatabaseState } from '../__tests__/resourceDatabaseState'
import { getReaderChatMessageOwnerState } from '../server/chatMessageHydration.svelte'
import {
  clearReaderTranscriptProjection,
  recordReaderCharacters,
  recordReaderChatMessages,
} from '../server/readerTranscriptProjection.svelte'
import {
  reroll,
  rerollChatOnlyTarget,
  resetRerollNavigation,
  seedRerollBufferFromAlternates,
} from './rerollNavigation.svelte'

type Msg = { role: 'user' | 'char'; data: string; chatId: string }

const target: ActiveChatTarget = {
  selectedCharID: 0,
  chatPage: 0,
  characterId: 'character-a',
  chatId: 'chat-a',
}

function authority(overrides: Partial<NonNullable<typeof occupancy.authority>> = {}) {
  return {
    version: 1 as const,
    databaseLineage: 'database-a',
    chatId: 'chat-a',
    sessionId: 'reader-a',
    sessionGeneration: 1,
    occupancyEpoch: 7,
    claimClass: 'chat_only' as const,
    ...overrides,
  }
}

function messages(): Msg[] {
  return testDatabaseState.db.characters[0].chats[0].message as unknown as Msg[]
}

function readerMessages(): Msg[] {
  return getReaderChatMessageOwnerState('chat-a')!.messages as unknown as Msg[]
}

function beginReader(): void {
  const operation = beginClientSession('reader-a')
  settleClientReader(operation, {
    databaseLineage: 'database-a',
    writer: { sessionId: 'owner-a', epoch: 1 },
  })
  setClientProjectionReady(true)
  setClientConnectionState('live')
}

beforeEach(() => {
  resetClientSessionForTests()
  clearReaderTranscriptProjection()
  resetRerollNavigation()
  vi.clearAllMocks()
  testDatabaseState.db = {
    characters: [
      {
        chaId: 'character-a',
        chatPage: 0,
        chats: [
          {
            id: 'chat-a',
            message: [
              { role: 'user', data: 'hello', chatId: 'user-a' },
              { role: 'char', data: 'answer', chatId: 'assistant-a' },
            ],
          },
        ],
      },
      {
        chaId: 'character-b',
        chatPage: 0,
        chats: [{ id: 'chat-b', message: [{ role: 'char', data: 'other', chatId: 'assistant-b' }] }],
      },
    ],
  }
  selectedCharID.set(0)
  occupancy.authority = authority()
  occupancy.enabled = true
  generationOperations.protocolAvailable = true
  generationOperations.canUseProtocol.mockImplementation(() => generationOperations.protocolAvailable)
  occupancy.capture.mockImplementation((chatId: string) =>
    occupancy.authority?.chatId === chatId ? occupancy.authority : null,
  )
  occupancy.isCurrent.mockImplementation(
    (captured: NonNullable<typeof occupancy.authority>, options?: { requireEnabled?: boolean }) =>
      options?.requireEnabled === true &&
      occupancy.enabled &&
      occupancy.authority !== null &&
      captured.databaseLineage === occupancy.authority.databaseLineage &&
      captured.chatId === occupancy.authority.chatId &&
      captured.sessionId === occupancy.authority.sessionId &&
      captured.sessionGeneration === occupancy.authority.sessionGeneration &&
      captured.occupancyEpoch === occupancy.authority.occupancyEpoch &&
      captured.claimClass === occupancy.authority.claimClass,
  )
  beginReader()
  recordReaderCharacters(testDatabaseState.db.characters, 1)
  recordReaderChatMessages('chat-a', messages(), 1)
})

afterEach(() => {
  selectedCharID.set(-1)
  clearReaderTranscriptProjection()
  resetClientSessionForTests()
})

describe('chat-only Reroll', () => {
  it('uses the durable targeted-operation pipeline with only the Reroll interaction', async () => {
    const staged = {
      target,
      request: { operationId: 'operation-a' },
      intent: { version: 1, kind: 'generation-operation-submit', requests: [] },
      handle: {},
    }
    generationOperations.stage.mockResolvedValueOnce(staged)
    generationOperations.submit.mockResolvedValueOnce({
      status: 'accepted',
      response: { operation: { operationId: 'operation-a' } },
    })

    await expect(rerollChatOnlyTarget(target)).resolves.toEqual({
      status: 'accepted',
      operationId: 'operation-a',
    })

    expect(generationOperations.stage).toHaveBeenCalledWith({
      target,
      mode: 'regenerate',
      targetMessageId: 'assistant-a',
      chatOccupancy: { authority: authority(), interaction: 'reroll' },
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs: [],
        clientContext: { browserLanguage: 'en-US' },
        clientCapabilities: { regenerateTargetProjection: 1 },
      },
    })
    expect(generationOperations.submit).toHaveBeenCalledWith(staged)
    expect(commandSpies.dispatchReplaceTailMessagesScoped).not.toHaveBeenCalled()
    expect(commandSpies.dispatchUpdateMessageScoped).not.toHaveBeenCalled()
  })

  it('fails closed before staging when the generation-operation protocol is unavailable', async () => {
    generationOperations.protocolAvailable = false

    await expect(rerollChatOnlyTarget(target)).resolves.toEqual({
      status: 'unavailable',
      reason: 'protocol-unavailable',
    })
    expect(generationOperations.stage).not.toHaveBeenCalled()
    expect(generationOperations.submit).not.toHaveBeenCalled()
  })

  it('rechecks the captured reader target after loading the submission pipeline', async () => {
    generationOperations.canUseProtocol.mockImplementationOnce(() => {
      readerMessages()[1] = { role: 'char', data: 'new answer', chatId: 'assistant-new' }
      return true
    })

    await expect(rerollChatOnlyTarget(target)).resolves.toEqual({
      status: 'unavailable',
      reason: 'stale-authority',
    })
    expect(generationOperations.stage).not.toHaveBeenCalled()
    expect(generationOperations.submit).not.toHaveBeenCalled()
  })

  it('submits the captured assistant under the exact self-owned occupancy without a tail command', async () => {
    const submitReroll = vi.fn(async () => ({ status: 'accepted' as const, operationId: 'operation-a' }))

    await expect(rerollChatOnlyTarget(target, { submitReroll })).resolves.toEqual({
      status: 'accepted',
      operationId: 'operation-a',
    })

    expect(submitReroll).toHaveBeenCalledWith({
      target,
      targetMessageId: 'assistant-a',
      readerIncarnation: expect.any(Number),
      occupancy: authority(),
      sourceGeneration: expect.any(Number),
    })
    expect(readerMessages().map((message) => message.chatId)).toEqual(['user-a', 'assistant-a'])
    expect(commandSpies.dispatchReplaceTailMessagesScoped).not.toHaveBeenCalled()
    expect(commandSpies.dispatchUpdateMessageScoped).not.toHaveBeenCalled()
  })

  it('captures the reader transcript rather than a stale writer projection', async () => {
    messages()[1] = { role: 'char', data: 'stale writer answer', chatId: 'assistant-writer-stale' }
    const submitReroll = vi.fn(async () => ({ status: 'accepted' as const, operationId: 'operation-a' }))

    await rerollChatOnlyTarget(target, { submitReroll })

    expect(submitReroll).toHaveBeenCalledWith(expect.objectContaining({ targetMessageId: 'assistant-a' }))
  })

  it('always requests a new regenerate candidate instead of swiping through an existing alternate', async () => {
    seedRerollBufferFromAlternates(readerMessages(), [
      { role: 'char', data: 'answer', chatId: 'assistant-a' },
      { role: 'char', data: 'older', chatId: 'assistant-old' },
    ])
    const submitReroll = vi.fn(async () => ({ status: 'accepted' as const, operationId: 'operation-a' }))

    await rerollChatOnlyTarget(target, { submitReroll })

    expect(submitReroll).toHaveBeenCalledWith(expect.objectContaining({ targetMessageId: 'assistant-a' }))
    expect(commandSpies.dispatchReplaceTailMessagesScoped).not.toHaveBeenCalled()
  })

  it('rejects missing, foreign, and owner-class occupancy before durable staging', async () => {
    const submitReroll = vi.fn()
    occupancy.authority = null
    await expect(rerollChatOnlyTarget(target, { submitReroll })).resolves.toEqual({
      status: 'unavailable',
      reason: 'not-self-occupied',
    })

    occupancy.authority = authority({ sessionId: 'reader-b' })
    await expect(rerollChatOnlyTarget(target, { submitReroll })).resolves.toEqual({
      status: 'unavailable',
      reason: 'not-self-occupied',
    })

    occupancy.authority = authority({ claimClass: 'owner' })
    await expect(rerollChatOnlyTarget(target, { submitReroll })).resolves.toEqual({
      status: 'unavailable',
      reason: 'not-self-occupied',
    })
    expect(submitReroll).not.toHaveBeenCalled()
  })

  it('rejects a chat id paired with the wrong captured character', async () => {
    const submitReroll = vi.fn()

    await expect(rerollChatOnlyTarget({ ...target, characterId: 'character-b' }, { submitReroll })).resolves.toEqual({
      status: 'unavailable',
      reason: 'invalid-target',
    })
    expect(submitReroll).not.toHaveBeenCalled()
  })

  it('does not submit new chat-only work while rollout admission is disabled', async () => {
    const submitReroll = vi.fn()
    occupancy.enabled = false

    await expect(rerollChatOnlyTarget(target, { submitReroll })).resolves.toEqual({
      status: 'unavailable',
      reason: 'protocol-disabled',
    })
    expect(submitReroll).not.toHaveBeenCalled()
  })

  it('fails before submission when the assistant target changes during preflight', async () => {
    const submitReroll = vi.fn()
    occupancy.isCurrent.mockImplementationOnce(() => {
      readerMessages()[1] = { role: 'char', data: 'new answer', chatId: 'assistant-new' }
      return true
    })

    await expect(rerollChatOnlyTarget(target, { submitReroll })).resolves.toEqual({
      status: 'unavailable',
      reason: 'stale-authority',
    })
    expect(submitReroll).not.toHaveBeenCalled()
    expect(commandSpies.dispatchReplaceTailMessagesScoped).not.toHaveBeenCalled()
  })

  it('rejects a user tail without staging a general regenerate operation', async () => {
    readerMessages().push({ role: 'user', data: 'new question', chatId: 'user-new' })
    const submitReroll = vi.fn()

    await expect(rerollChatOnlyTarget(target, { submitReroll })).resolves.toEqual({
      status: 'unavailable',
      reason: 'target-not-assistant',
    })
    expect(submitReroll).not.toHaveBeenCalled()
  })

  it.each([
    ['epoch', authority({ occupancyEpoch: 8 })],
    ['session', authority({ sessionId: 'reader-new' })],
    ['lineage', authority({ databaseLineage: 'database-new' })],
  ] as const)('rejects a stale %s before submission without optimistic mutation', async (_label, replacement) => {
    const submitReroll = vi.fn()
    occupancy.isCurrent.mockImplementationOnce(() => {
      occupancy.authority = replacement
      return false
    })

    await expect(rerollChatOnlyTarget(target, { submitReroll })).resolves.toEqual({
      status: 'unavailable',
      reason: 'stale-authority',
    })
    expect(submitReroll).not.toHaveBeenCalled()
    expect(commandSpies.dispatchReplaceTailMessagesScoped).not.toHaveBeenCalled()
    expect(commandSpies.dispatchUpdateMessageScoped).not.toHaveBeenCalled()
  })

  it('rejects before submission when the captured client-session generation is replaced', async () => {
    const submitReroll = vi.fn()
    occupancy.isCurrent.mockImplementationOnce(() => {
      resetClientSessionForTests()
      return false
    })

    await expect(rerollChatOnlyTarget(target, { submitReroll })).resolves.toEqual({
      status: 'unavailable',
      reason: 'stale-authority',
    })
    expect(submitReroll).not.toHaveBeenCalled()
    expect(commandSpies.dispatchReplaceTailMessagesScoped).not.toHaveBeenCalled()
    expect(commandSpies.dispatchUpdateMessageScoped).not.toHaveBeenCalled()
  })

  it('keeps a delayed shortcut bound to its captured chat when local navigation changes', async () => {
    const submitReroll = vi.fn(async (submission) => {
      selectedCharID.set(1)
      expect(submission.target).toEqual(target)
      expect(submission.targetMessageId).toBe('assistant-a')
      return { status: 'accepted' as const, operationId: 'operation-a' }
    })

    await expect(rerollChatOnlyTarget(target, { submitReroll })).resolves.toMatchObject({ status: 'accepted' })
    expect(readerMessages().map((message) => message.chatId)).toEqual(['user-a', 'assistant-a'])
  })

  it('preserves the existing owner Reroll callback and authoritative target behavior', async () => {
    resetClientSessionForTests()
    const sendChatMain = vi.fn(async () => true)

    await reroll({ sendChatMain, closeMenu: vi.fn() })

    expect(sendChatMain).toHaveBeenCalledWith(false, 'assistant-a')
    expect(messages().map((message) => message.chatId)).toEqual(['user-a', 'assistant-a'])
    expect(commandSpies.dispatchReplaceTailMessagesScoped).not.toHaveBeenCalled()
  })
})
