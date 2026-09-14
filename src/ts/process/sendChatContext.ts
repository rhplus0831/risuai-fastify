import { v4 } from 'uuid'
import type { Database, MessagePresetInfo, Message, character } from '../storage/database.svelte'
import { ChatTokenizer, resolveMainTokenizerProfile, resolveTokenizerDatabaseSnapshot } from '../tokenizer'
import {
  dispatchCharacterOwnedDurableBatch,
  toMessageSnapshot,
  type ActiveChatTarget,
  type CharacterOwnedDurableBatchResult,
} from '../chatCommands'
import { resolveActiveChatGenerationSettings } from '../activeChatGenerationSettings'
import { createPromptInfoSnapshot } from '../promptInfo'
import { canUseServerCommands, replaceTailMessagesCommand, updateCharacterCommand } from '../server/commands'
import { isServerChatMessagePlaceholder } from '../server/chatMessagePlaceholders'
import {
  captureChatBodyProjectionEpoch,
  charactersResourceState,
  getCharacterResourceOwner,
  settingsResourceState,
} from '../server/resourceState.svelte'
import { resolveModelProfileTokenizerSelection } from '../model/modelProfileResolver'

export interface SendChatContextResult {
  selectedChar: number
  selectedChat: number
  nowChatroom: character
  promptInfo: MessagePresetInfo
  tokenizer: ChatTokenizer
  maxContextTokens: number
  persistence: Promise<CharacterOwnedDurableBatchResult>
}

export type SendChatContextMaintenanceScope = 'owner' | 'chat-local' | 'none'

interface SendRollbackSnapshot {
  characterId: string | undefined
  characterIndex: number
  chatId: string | undefined
  chatIndex: number
  lastInteraction: number | undefined
  attemptedLastInteraction: number
  messageIds?: Array<{
    previous: string | undefined
    attempted: string
  }>
}

function currentSendRollbackSnapshot(input: {
  characterIndex: number
  character: character
  chatIndex: number
  attemptedLastInteraction: number
  previousLastInteraction: number | undefined
  messagesBeforeBackfill?: Message[]
}): SendRollbackSnapshot {
  const chat = input.character.chats?.[input.chatIndex]
  return {
    characterId: input.character.chaId,
    characterIndex: input.characterIndex,
    chatId: chat?.id,
    chatIndex: input.chatIndex,
    lastInteraction: input.previousLastInteraction,
    attemptedLastInteraction: input.attemptedLastInteraction,
    ...(input.messagesBeforeBackfill
      ? {
          messageIds: input.messagesBeforeBackfill.flatMap((message, index) => {
            const attempted = chat?.message[index]?.chatId
            return message.chatId == null && typeof attempted === 'string' && attempted.length > 0
              ? [{ previous: message.chatId, attempted }]
              : []
          }),
        }
      : {}),
  }
}

function restoreLastInteraction(snapshot: SendRollbackSnapshot): void {
  const character = locateSendSnapshotCharacter(snapshot)
  if (!character) return
  if (character.lastInteraction === snapshot.attemptedLastInteraction) {
    character.lastInteraction = snapshot.lastInteraction
  }
}

function restoreBackfilledMessageIds(snapshot: SendRollbackSnapshot): void {
  if (!snapshot.messageIds?.length) return
  const character = locateSendSnapshotCharacter(snapshot)
  if (!character) return
  const chatIndex = locateSendSnapshotChatIndex(character, snapshot)
  if (chatIndex < 0) return
  const messages = character.chats[chatIndex].message
  for (const messageId of snapshot.messageIds) {
    const message = messages.find((candidate) => candidate.chatId === messageId.attempted)
    if (message) message.chatId = messageId.previous
  }
}

function locateSendSnapshotCharacter(snapshot: SendRollbackSnapshot): character | undefined {
  if (charactersResourceState.status !== 'ready') return undefined
  const characters = charactersResourceState.characters
  if (snapshot.characterId) {
    return getCharacterResourceOwner(snapshot.characterId)
  }
  return characters[snapshot.characterIndex]
}

function locateSendSnapshotChatIndex(character: character, snapshot: SendRollbackSnapshot): number {
  if (snapshot.chatId) {
    return character.chats?.findIndex((candidate) => candidate.id === snapshot.chatId) ?? -1
  }
  const index = snapshot.chatIndex
  return index >= 0 && index < (character.chats?.length ?? 0) ? index : -1
}

function messageIdBackfillTail(messages: Message[]): { startIndex: number; afterMessageId: string } | null {
  if (messages.some(isServerChatMessagePlaceholder)) return null

  const firstMissingIndex = messages.findIndex((message) => message.chatId == null)
  if (firstMissingIndex <= 0) return null
  if (messages.slice(firstMissingIndex).some((message) => message.chatId != null)) return null

  const afterMessageId = messages[firstMissingIndex - 1]?.chatId
  return typeof afterMessageId === 'string' && afterMessageId.length > 0
    ? { startIndex: firstMissingIndex, afterMessageId }
    : null
}

/**
 * Run the sendChat entry-context setup: owner-backed character + chat lookup,
 * lastInteraction stamp, chatId backfill, promptInfo seed (gated on
 * `promptInfoInsideChat`), and tokenizer creation. The optimistic context is
 * returned synchronously together with the exact durable maintenance promise.
 * Occupied-chat callers select `chat-local`: they may use the authoritative
 * configured settings but cannot stamp the character, backfill ids, or issue a
 * general command. Reattach callers select `none` and only reconstruct render
 * context. `writeMaintenance` remains as a compatibility alias for older tests.
 *
 * The coordinator handles the closures (`throwError`,
 * `runCurrentChatFunction`, etc.) and the chat-keyed generation lifecycle around
 * this helper.
 */
export function setupSendChatContext(args: {
  chatProcessIndex: number
  chatAdditonalTokens?: number
  maintenanceScope?: SendChatContextMaintenanceScope
  writeMaintenance?: boolean
  target?: ActiveChatTarget | null
  database?: Database
}): SendChatContextResult {
  const { chatAdditonalTokens: argChatAdditonalTokens, target } = args
  const maintenanceScope = args.maintenanceScope ?? (args.writeMaintenance === false ? 'none' : 'owner')
  const serverBacked = canUseServerCommands()
  const selectedChar = resolveOwnedCharacterIndex(target)
  const lastInteraction = Date.now()
  let persistence: Promise<CharacterOwnedDurableBatchResult> = Promise.resolve({
    status: 'ok',
    acceptedCount: 0,
  })

  if (maintenanceScope === 'owner' && serverBacked) {
    const steps: Parameters<typeof dispatchCharacterOwnedDurableBatch>[1][number][] = []
    let rollbackSnapshot: SendRollbackSnapshot | null = null
    let characterId: string | undefined

    const nowChatroom = resolveOwnedCharacter(target)
    if (nowChatroom) {
      characterId = nowChatroom.chaId
      const selectedChat = resolveSendChatIndex(nowChatroom, target)
      const selectedChatRecord = nowChatroom.chats[selectedChat]
      const hasUnloadedMessages = selectedChatRecord.message.some(isServerChatMessagePlaceholder)
      const needsMessageIdBackfill = !hasUnloadedMessages && selectedChatRecord.message.some((v) => v.chatId == null)
      const backfillTail =
        needsMessageIdBackfill && selectedChatRecord.id ? messageIdBackfillTail(selectedChatRecord.message) : null
      const previousLastInteraction = nowChatroom.lastInteraction
      const messagesBeforeBackfill = needsMessageIdBackfill
        ? selectedChatRecord.message.map((message) => ({ ...message }))
        : undefined

      nowChatroom.lastInteraction = lastInteraction
      if (needsMessageIdBackfill) {
        selectedChatRecord.message = selectedChatRecord.message.map((message) => {
          message.chatId = message.chatId ?? v4()
          return message
        })
      }

      rollbackSnapshot = currentSendRollbackSnapshot({
        characterIndex: selectedChar,
        character: nowChatroom,
        chatIndex: selectedChat,
        attemptedLastInteraction: lastInteraction,
        previousLastInteraction,
        messagesBeforeBackfill,
      })

      if (characterId) {
        const pathCharacterId = characterId
        steps.push({
          method: 'PATCH',
          path: `/characters/${encodeURIComponent(pathCharacterId)}`,
          body: { patch: { lastInteraction } },
          bodyIsOwned: true,
          command: (baseRevision, frozenBody) =>
            updateCharacterCommand({
              baseRevision,
              characterId: pathCharacterId,
              patch: frozenBody.patch as { lastInteraction: number },
            }),
          rollback: () => {
            if (rollbackSnapshot) restoreLastInteraction(rollbackSnapshot)
            if (!backfillTail && rollbackSnapshot) restoreBackfilledMessageIds(rollbackSnapshot)
          },
        })
      }

      if (selectedChatRecord.id && backfillTail) {
        const chatId = selectedChatRecord.id
        const optimisticChatBodyProjectionEpoch = captureChatBodyProjectionEpoch(chatId)
        steps.push({
          method: 'POST',
          path: `/chats/${encodeURIComponent(chatId)}/messages/tail`,
          body: {
            afterMessageId: backfillTail.afterMessageId,
            messages: selectedChatRecord.message.slice(backfillTail.startIndex).map(toMessageSnapshot),
          },
          bodyIsOwned: true,
          command: (baseRevision, frozenBody) =>
            replaceTailMessagesCommand({
              baseRevision,
              chatId,
              afterMessageId: frozenBody.afterMessageId as string,
              messages: frozenBody.messages as ReturnType<typeof toMessageSnapshot>[],
              optimisticChatBodyProjectionEpoch,
            }),
          rollback: () => {
            if (rollbackSnapshot) restoreBackfilledMessageIds(rollbackSnapshot)
          },
        })
      }
    }

    if (!characterId) {
      if (rollbackSnapshot) {
        restoreLastInteraction(rollbackSnapshot)
        restoreBackfilledMessageIds(rollbackSnapshot)
      }
      persistence = Promise.resolve({
        status: 'failure',
        acceptedCount: 0,
        failure: { status: 'error', error: 'Missing character mutation owner', reason: 'invalid-request' },
      })
    } else if (steps.length > 0) {
      persistence = dispatchCharacterOwnedDurableBatch(characterId, steps)
    }
  }
  const nowChatroom = resolveOwnedCharacter(target)
  if (!nowChatroom) {
    throw new Error('Missing character owner for send context')
  }
  const selectedChat = resolveSendChatIndex(nowChatroom, target)

  const promptInfo = createInitialPromptInfo(target)
  const database = args.database ?? resolveTokenizerDatabaseSnapshot()
  const mainProfile = resolveMainTokenizerProfile(database)
  const mainModelId = mainProfile.modelId

  let caculatedChatTokens = 0
  if (mainModelId.startsWith('gpt')) {
    caculatedChatTokens += 5
  } else {
    caculatedChatTokens += 3
  }

  const chatAdditonalTokens = argChatAdditonalTokens ?? caculatedChatTokens
  const tokenizer = new ChatTokenizer(
    chatAdditonalTokens,
    mainModelId.startsWith('gpt') ? 'noName' : 'name',
    mainProfile,
    resolveModelProfileTokenizerSelection(database, mainProfile),
    database,
  )
  const maxContextTokens = mainProfile.runtimeOptions.maxContext ?? database.maxContext

  return {
    selectedChar,
    selectedChat,
    nowChatroom,
    promptInfo,
    tokenizer,
    maxContextTokens,
    persistence,
  }
}

function createInitialPromptInfo(target: ActiveChatTarget | null | undefined): MessagePresetInfo {
  if (
    settingsResourceState.status === 'error' ||
    settingsResourceState.groupStatuses.advanced !== 'ready' ||
    !settingsResourceState.value.promptInfoInsideChat
  ) {
    return {}
  }
  return createServerBackedPromptInfo(target)
}

function createServerBackedPromptInfo(target: ActiveChatTarget | null | undefined): MessagePresetInfo {
  const activeSettings = resolveActiveChatGenerationSettings({ target })
  return createPromptInfoSnapshot({
    enabled: true,
    promptPreset: activeSettings.promptPreset,
    requiredSidebarToggles: activeSettings.requiredSidebarToggles,
    sidebarToggles: activeSettings.settings?.sidebarToggles,
  })
}

function resolveOwnedCharacter(target: ActiveChatTarget | null | undefined): character | undefined {
  if (charactersResourceState.status !== 'ready') return undefined
  if (target?.characterId !== undefined) return getCharacterResourceOwner(target.characterId)
  const selectedIndex = target?.selectedCharID ?? charactersResourceState.currentChar
  const candidate = charactersResourceState.characters[selectedIndex]
  return candidate
}

function resolveOwnedCharacterIndex(target: ActiveChatTarget | null | undefined): number {
  const character = resolveOwnedCharacter(target)
  return character ? charactersResourceState.characters.indexOf(character) : -1
}

function resolveSendChatIndex(character: character, target: ActiveChatTarget | null | undefined): number {
  if (!target) return character.chatPage
  if (target.chatId !== undefined) {
    return character.chats.findIndex((chat) => chat.id === target.chatId)
  }
  return target.chatPage
}
