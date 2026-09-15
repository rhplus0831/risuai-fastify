import type { ActiveChatTarget } from '../chatCommands'
import { isClientChatOccupancyAuthorityCurrent } from '../server/chatOccupancy'
import { getChatMessageOwnerState, hydrateChatMessages } from '../server/chatMessageHydration.svelte'
import { readGenerationOperationStatus, type GenerationOperationChatOccupancy } from '../server/generationOperations'
import { recoverCurrentChatOccupancyGenerationEffects } from './recoveredGenerationEffects'

export interface CompletedTargetedGenerationRecoveryInput {
  readonly operationId: string
  readonly target: ActiveChatTarget
  readonly mode: 'continue' | 'regenerate'
  readonly targetMessageId: string
  readonly chatOccupancy: GenerationOperationChatOccupancy
  readonly signal?: AbortSignal
}

function hasExactResultMessage(chatId: string, resultMessageId: string): boolean {
  const messages = getChatMessageOwnerState(chatId)?.messages ?? []
  return messages.filter((message) => message.role === 'char' && message.chatId === resultMessageId).length === 1
}

/**
 * A detached targeted operation can finish before its first stream observer is
 * attached. Reconcile that terminal authority without ever replaying the
 * already-accepted submit: status, transcript, and effect reads all retain the
 * frozen operation/occupancy tuple.
 */
export async function reconcileCompletedTargetedGenerationOperation(
  input: CompletedTargetedGenerationRecoveryInput,
): Promise<boolean> {
  const authority = input.chatOccupancy.authority
  const chatId = input.target.chatId
  const characterId = input.target.characterId
  const isCurrent = () =>
    input.signal?.aborted !== true &&
    chatId === authority.chatId &&
    isClientChatOccupancyAuthorityCurrent(authority, { requireEnabled: false })
  if (!chatId || !characterId || !isCurrent()) return false

  const status = await readGenerationOperationStatus(input.operationId, input.signal, input.chatOccupancy, {
    operationId: input.operationId,
    chatId,
    databaseLineage: authority.databaseLineage,
    sessionId: authority.sessionId,
    occupancyEpoch: authority.occupancyEpoch,
    interaction: input.chatOccupancy.interaction,
    intentKind: input.mode,
  })
  if (!isCurrent() || status.status !== 'accepted') return false

  const operation = status.response.operation
  const resultMessageId = operation.resultMessageId
  if (
    operation.state !== 'completed' ||
    operation.operationId !== input.operationId ||
    operation.characterId !== characterId ||
    operation.chatId !== chatId ||
    operation.mode !== input.mode ||
    operation.targetMessageId !== input.targetMessageId ||
    !resultMessageId
  ) {
    return false
  }

  try {
    await hydrateChatMessages(chatId, { force: true, strict: true, signal: input.signal })
    if (!isCurrent() || !hasExactResultMessage(chatId, resultMessageId)) return false
    await recoverCurrentChatOccupancyGenerationEffects({ refresh: true })
  } catch {
    return false
  }
  return isCurrent() && hasExactResultMessage(chatId, resultMessageId)
}
