import { beforeEach, describe, expect, it, vi } from 'vitest'

const recoveryMocks = vi.hoisted(() => ({
  authorityCurrent: vi.fn(),
  hydrateChatMessages: vi.fn(),
  messageOwner: vi.fn(),
  readGenerationOperationStatus: vi.fn(),
  recoverEffects: vi.fn(),
  stageTargetedGenerationOperation: vi.fn(),
  submitStagedTargetedGenerationOperation: vi.fn(),
}))

vi.mock('../server/chatOccupancy', () => ({
  isClientChatOccupancyAuthorityCurrent: recoveryMocks.authorityCurrent,
}))

vi.mock('../server/chatMessageHydration.svelte', () => ({
  getChatMessageOwnerState: recoveryMocks.messageOwner,
  hydrateChatMessages: recoveryMocks.hydrateChatMessages,
}))

vi.mock('../server/generationOperations', () => ({
  readGenerationOperationStatus: recoveryMocks.readGenerationOperationStatus,
  stageTargetedGenerationOperation: recoveryMocks.stageTargetedGenerationOperation,
  submitStagedTargetedGenerationOperation: recoveryMocks.submitStagedTargetedGenerationOperation,
}))

vi.mock('./recoveredGenerationEffects', () => ({
  recoverCurrentChatOccupancyGenerationEffects: recoveryMocks.recoverEffects,
}))

import { reconcileCompletedTargetedGenerationOperation } from './targetedGenerationRecovery'

const authority = {
  version: 1 as const,
  databaseLineage: 'database-a',
  chatId: 'chat-a',
  sessionId: 'session-a',
  sessionGeneration: 3,
  occupancyEpoch: 7,
  claimClass: 'owner' as const,
}

const input = {
  operationId: 'operation-a',
  target: {
    selectedCharID: 0,
    chatPage: 0,
    characterId: 'character-a',
    chatId: 'chat-a',
  },
  mode: 'continue' as const,
  targetMessageId: 'assistant-a',
  chatOccupancy: { authority, interaction: 'continue' as const },
}

function completedOperation() {
  return {
    operationId: 'operation-a',
    state: 'completed',
    characterId: 'character-a',
    chatId: 'chat-a',
    mode: 'continue',
    targetMessageId: 'assistant-a',
    resultMessageId: 'assistant-a',
  }
}

describe('completed targeted generation recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    recoveryMocks.authorityCurrent.mockReturnValue(true)
    recoveryMocks.hydrateChatMessages.mockResolvedValue(undefined)
    recoveryMocks.messageOwner.mockReturnValue({
      messages: [{ role: 'char', chatId: 'assistant-a', data: 'completed continuation' }],
    })
    recoveryMocks.readGenerationOperationStatus.mockResolvedValue({
      status: 'accepted',
      response: { operation: completedOperation() },
    })
    recoveryMocks.recoverEffects.mockResolvedValue(undefined)
  })

  it('hydrates and receipts effects only after exact completed operation authority is proven', async () => {
    await expect(reconcileCompletedTargetedGenerationOperation(input)).resolves.toBe(true)

    expect(recoveryMocks.readGenerationOperationStatus).toHaveBeenCalledWith(
      'operation-a',
      undefined,
      input.chatOccupancy,
      {
        operationId: 'operation-a',
        chatId: 'chat-a',
        databaseLineage: 'database-a',
        sessionId: 'session-a',
        occupancyEpoch: 7,
        interaction: 'continue',
        intentKind: 'continue',
      },
    )
    expect(recoveryMocks.hydrateChatMessages).toHaveBeenCalledWith('chat-a', {
      force: true,
      strict: true,
      signal: undefined,
    })
    expect(recoveryMocks.recoverEffects).toHaveBeenCalledExactlyOnceWith({ refresh: true })
    expect(recoveryMocks.stageTargetedGenerationOperation).not.toHaveBeenCalled()
    expect(recoveryMocks.submitStagedTargetedGenerationOperation).not.toHaveBeenCalled()
  })

  it('does not recover a completed operation whose targeted identity differs', async () => {
    recoveryMocks.readGenerationOperationStatus.mockResolvedValueOnce({
      status: 'accepted',
      response: { operation: { ...completedOperation(), targetMessageId: 'assistant-other' } },
    })

    await expect(reconcileCompletedTargetedGenerationOperation(input)).resolves.toBe(false)

    expect(recoveryMocks.hydrateChatMessages).not.toHaveBeenCalled()
    expect(recoveryMocks.recoverEffects).not.toHaveBeenCalled()
  })

  it('keeps the operation unreconciled when the exact persisted result row is absent', async () => {
    recoveryMocks.messageOwner.mockReturnValueOnce({ messages: [] })

    await expect(reconcileCompletedTargetedGenerationOperation(input)).resolves.toBe(false)

    expect(recoveryMocks.hydrateChatMessages).toHaveBeenCalledOnce()
    expect(recoveryMocks.recoverEffects).not.toHaveBeenCalled()
  })

  it('continues accepted settlement when rollout is disabled but the tuple remains current', async () => {
    await expect(reconcileCompletedTargetedGenerationOperation(input)).resolves.toBe(true)

    expect(recoveryMocks.authorityCurrent).toHaveBeenCalledWith(authority, { requireEnabled: false })
  })
})
