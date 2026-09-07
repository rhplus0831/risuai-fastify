import {
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import type { Message, character } from '../storage/database.svelte'
import { chatOutputListeners, isChatOutputRuntimeReady, runChatOutputListeners } from '../plugins/chatOutputListeners'
import { getChatMessageOwnerState, hydrateChatMessages } from '../server/chatMessageHydration.svelte'
import type { PendingGenerationEffect } from '../server/bootstrap'
import { evaluateIgp } from './postGeneration/igp'
import { loadAndTrimCharEmotion } from './postGeneration/charEmotionStore'
import { runEmotionEmbeddingFallback } from './postGeneration/emotionFallbackEmbedding'
import { runEmotionLlmFallback } from './postGeneration/emotionFallbackLlm'
import { runImggenStableDiff } from './postGeneration/imggenStableDiff'
import { stablePostGenerationMessageTarget } from './postGeneration/stableTarget'
import {
  completedGenerationEffect,
  generationEffectRefFromMessage,
  generationEffectRefFromPending,
  runLedgeredGenerationEffect,
  skippedGenerationEffect,
} from './generationEffectLedger'
import type { ServerGenerationEffectLedgerRef } from '@risuai/protocol/generation-sse'
import type { ActiveChatTarget } from '../chatCommands'
import { resolveActiveChatGenerationSettings } from '../activeChatGenerationSettings'
import { registerRecoveredEffectsRuntime } from './generationRuntimeBridge'
import { ensureResourceSurfaces } from '../server/routeResourceLoader'
import {
  charactersResourceState,
  getCharacterResourceOwner,
  settingsResourceState,
} from '../server/resourceState.svelte'

function recoveryIsCurrent(generation: number): boolean {
  return canUseClientWriteAccess() && isClientSessionGenerationCurrent(generation)
}

const unavailableEffects = () => ({ durableEffectsReconciled: false, allEffectsReconciled: false })

let bootstrapPendingEffects: PendingGenerationEffect[] = []

interface RecoveredGenerationResolution {
  character: character
  chat: character['chats'][number]
  message: Message
  characterIndex: number
  chatIndex: number
  messageIndex: number
}

export interface RecoveredGenerationEffectResult {
  durableEffectsReconciled: boolean
  allEffectsReconciled: boolean
}

export function setPendingRecoveredGenerationEffects(effects: readonly PendingGenerationEffect[]): void {
  bootstrapPendingEffects = [...effects]
}

export async function reconcilePendingRecoveredGenerationEffects(): Promise<void> {
  const sourceGeneration = captureClientSessionGeneration()
  if (!recoveryIsCurrent(sourceGeneration)) throw new Error('client_write_access_required')
  const pendingEffects = bootstrapPendingEffects
  const refs = new Map<string, ServerGenerationEffectLedgerRef>()
  for (const effect of pendingEffects) {
    const ref = generationEffectRefFromPending(effect)
    refs.set(`${ref.databaseLineage}:${ref.generationId}`, ref)
  }
  for (const ref of refs.values()) {
    if (!recoveryIsCurrent(sourceGeneration)) throw new Error('client_write_operation_stale')
    await hydrateChatMessages(ref.chatId, { force: true, strict: true })
    if (!recoveryIsCurrent(sourceGeneration)) throw new Error('client_write_operation_stale')
    const result = await reconcileRecoveredGenerationEffects(ref)
    if (!result.allEffectsReconciled) {
      throw new Error(`Generation effects remain unavailable for ${ref.generationId}`)
    }
  }
  if (!recoveryIsCurrent(sourceGeneration)) throw new Error('client_write_operation_stale')
  if (bootstrapPendingEffects === pendingEffects) bootstrapPendingEffects = []
}

/** Permanently skip the unfinished client effects so later generations are no longer gated by them. */
export async function discardPendingRecoveredGenerationEffects(): Promise<void> {
  const sourceGeneration = captureClientSessionGeneration()
  if (!recoveryIsCurrent(sourceGeneration)) throw new Error('client_write_access_required')
  const pendingEffects = bootstrapPendingEffects
  for (const effect of pendingEffects) {
    if (!recoveryIsCurrent(sourceGeneration)) throw new Error('client_write_operation_stale')
    if (effect.kind === 'generated_translation') {
      throw new Error(`Server-owned generation effect cannot be discarded by the client: ${effect.kind}`)
    }
    const ref = generationEffectRefFromPending(effect)
    const result = await runLedgeredGenerationEffect(ref, effect.kind, 'late_recovery', () =>
      skippedGenerationEffect('user_discarded_recovery'),
    )
    if (!terminalReceipt(result.status)) {
      throw new Error(`Generation effect could not be discarded for ${effect.generationId}: ${effect.kind}`)
    }
  }
  if (!recoveryIsCurrent(sourceGeneration)) throw new Error('client_write_operation_stale')
  if (bootstrapPendingEffects === pendingEffects) bootstrapPendingEffects = []
}

export async function reconcileAcceptedSendGenerationEffects(
  target: ActiveChatTarget,
  acceptedMessageId: string,
): Promise<RecoveredGenerationEffectResult> {
  const resolution = findAcceptedAssistant(target, acceptedMessageId)
  const ref = resolution
    ? (generationEffectRefFromMessage(resolution.message) ?? legacyGenerationEffectRef(resolution))
    : undefined
  if (!ref) return { durableEffectsReconciled: false, allEffectsReconciled: false }
  return reconcileRecoveredGenerationEffects(ref)
}

export async function reconcileRecoveredGenerationEffects(
  ref: ServerGenerationEffectLedgerRef,
): Promise<RecoveredGenerationEffectResult> {
  const sourceGeneration = captureClientSessionGeneration()
  if (!recoveryIsCurrent(sourceGeneration)) return unavailableEffects()
  if (!isChatOutputRuntimeReady()) throw new Error('Plugin runtime is not ready for recovered output effects')
  // Recovery precedes ordinary chat readiness on a returning/promoted writer.
  // An omitted unloaded setting is not proof that an effect is disabled, and
  // must never become a permanent not-configured receipt.
  await ensureResourceSurfaces(['runtime:chat-generation'])
  if (!recoveryIsCurrent(sourceGeneration)) return unavailableEffects()
  // Late delivery never invokes these callbacks: the server atomically turns
  // each pending ephemeral row into a permanent late_recovery skip.
  const unexpectedEphemeral = () => completedGenerationEffect(undefined)
  const ephemeral = await Promise.all([
    runLedgeredGenerationEffect(ref, 'notification', 'late_recovery', unexpectedEphemeral),
    runLedgeredGenerationEffect(ref, 'tts', 'late_recovery', unexpectedEphemeral),
    runLedgeredGenerationEffect(ref, 'completion_sound', 'late_recovery', unexpectedEphemeral),
  ])

  if (!recoveryIsCurrent(sourceGeneration)) return unavailableEffects()
  const initial = resolveGeneration(ref)
  if (!initial) return { durableEffectsReconciled: false, allEffectsReconciled: false }
  const completionText = initial.message.data

  // Match the uninterrupted ordering: plugin automation observes the terminal
  // transcript before IGP appends its durable prompt output.
  const plugin = await runLedgeredGenerationEffect(ref, 'plugin_output', 'late_recovery', async (effectContext) => {
    const resolution = resolveGeneration(ref)
    if (!isChatOutputRuntimeReady()) throw new Error('Plugin runtime is not ready for recovered output effects')
    if (!resolution || chatOutputListeners.size === 0) return skippedGenerationEffect('not_configured')
    await runChatOutputListeners(
      {
        char: resolution.character,
        chat: resolution.chat,
        characterIndex: resolution.characterIndex,
        chatIndex: resolution.chatIndex,
        messageIndex: resolution.messageIndex,
        effectIdempotencyKey: effectContext.idempotencyKey,
      },
      effectContext,
    )
    return completedGenerationEffect(undefined)
  })

  if (!recoveryIsCurrent(sourceGeneration)) return unavailableEffects()
  const igp = await runLedgeredGenerationEffect(ref, 'igp', 'late_recovery', async (effectContext) => {
    const resolution = resolveGeneration(ref)
    const promptTemplate =
      settingsResourceState.status === 'ready' ? String(settingsResourceState.value.igpPrompt ?? '') : ''
    if (!resolution || !promptTemplate.trim()) return skippedGenerationEffect('not_configured')
    const database = resolveRecoveredGenerationDatabase(resolution)
    if (!database) throw new Error('Recovered generation settings are unavailable')
    const updated = await evaluateIgp({
      promptTemplate,
      database,
      isCurrent: effectContext.isCurrent,
      abortSignal: effectContext.signal,
      waitForPersistence: true,
      target: {
        characterId: resolution.character.chaId,
        chatId: resolution.chat.id ?? ref.chatId,
        messageId: ref.messageId,
        expectedData: resolution.message.data,
        ...(resolution.message.generationInfo?.generationId === ref.generationId
          ? { expectedGenerationId: ref.generationId }
          : {}),
      },
    })
    return updated ? completedGenerationEffect(undefined) : skippedGenerationEffect('target_changed')
  })

  if (!recoveryIsCurrent(sourceGeneration)) return unavailableEffects()
  const emotion = await runLedgeredGenerationEffect(
    ref,
    'emotion_image_state',
    'late_recovery',
    async (effectContext) => {
      const resolution = resolveGeneration(ref)
      if (!resolution || resolution.character.inlayViewScreen) {
        return skippedGenerationEffect('current_state_not_applicable')
      }
      if (resolution.character.viewScreen === 'emotion') {
        const { tempEmotion, charemotions } = loadAndTrimCharEmotion(resolution.character.chaId)
        if (
          settingsResourceState.status !== 'error' &&
          settingsResourceState.groupStatuses.media === 'ready' &&
          settingsResourceState.value.emotionProcesser === 'embedding'
        ) {
          await runEmotionEmbeddingFallback({
            isCurrent: effectContext.isCurrent,
            result: completionText,
            currentChar: resolution.character,
            tempEmotion,
            charemotions,
          })
        } else {
          const generationDatabase = resolveRecoveredGenerationDatabase(resolution)
          if (!generationDatabase) return skippedGenerationEffect('current_state_not_applicable')
          await runEmotionLlmFallback({
            database: generationDatabase,
            isCurrent: effectContext.isCurrent,
            result: completionText,
            currentChar: resolution.character,
            abortSignal: effectContext.signal,
            throwError: (error) => console.error(error),
            emotionPrompt2:
              settingsResourceState.status !== 'error' && settingsResourceState.groupStatuses.advanced === 'ready'
                ? settingsResourceState.value.emotionPrompt2
                : undefined,
            tempEmotion,
            charemotions,
          })
        }
        return completedGenerationEffect(undefined)
      }
      if (resolution.character.viewScreen === 'imggen') {
        await runImggenStableDiff({
          currentChar: resolution.character,
          abortSignal: effectContext.signal,
          target: stablePostGenerationMessageTarget(
            resolution.character.chaId,
            resolution.chat.id,
            resolution.message.chatId,
          ),
        })
        return completedGenerationEffect(undefined)
      }
      return skippedGenerationEffect('current_state_not_applicable')
    },
  )

  if (!recoveryIsCurrent(sourceGeneration)) return unavailableEffects()
  return {
    durableEffectsReconciled: terminalReceipt(plugin.status) && terminalReceipt(igp.status),
    allEffectsReconciled: [...ephemeral, plugin, igp, emotion].every((effect) => terminalReceipt(effect.status)),
  }
}

function terminalReceipt(status: string): boolean {
  return status === 'completed' || status === 'skipped' || status === 'already_receipted'
}

function resolveRecoveredGenerationDatabase(resolution: RecoveredGenerationResolution) {
  const target: ActiveChatTarget = {
    selectedCharID: resolution.characterIndex,
    chatPage: resolution.chatIndex,
    characterId: resolution.character.chaId,
    chatId: resolution.chat.id,
  }
  const state = resolveActiveChatGenerationSettings({ target })
  return state.character?.chaId === target.characterId && state.chat?.id === target.chatId ? state.db : null
}

function legacyGenerationEffectRef(
  resolution: RecoveredGenerationResolution,
): ServerGenerationEffectLedgerRef | undefined {
  const databaseLineage = resolution.message.generationInfo?.databaseLineage?.trim()
  const generationId = resolution.message.generationInfo?.generationId?.trim()
  const messageId = resolution.message.chatId?.trim()
  const characterId = resolution.character.chaId?.trim()
  const chatId = resolution.chat.id?.trim()
  if (!databaseLineage || !generationId || !messageId || !characterId || !chatId) return undefined
  return {
    version: 1,
    databaseLineage,
    keyType: 'generation',
    keyId: generationId,
    generationId,
    characterId,
    chatId,
    messageId,
  }
}

/**
 * Recovered effects must address the character-row owner after the collection
 * is ready. The aggregate remains a startup compatibility projection only.
 */
function characterRowsForRecovery(): readonly character[] {
  return charactersResourceState.status === 'ready' ? charactersResourceState.characters : []
}

function characterOwnerAt(index: number): character | undefined {
  const rows = characterRowsForRecovery()
  const candidate = rows[index]
  if (!candidate?.chaId) return undefined
  return getCharacterResourceOwner(candidate.chaId)
}

function characterOwnerById(characterId: string): character | undefined {
  if (!characterId) return undefined
  if (charactersResourceState.status !== 'ready') return undefined
  return getCharacterResourceOwner(characterId)
}

function uniqueChatOwner(character: character | undefined, chatId: string): ChatOwner | undefined {
  if (!character || !chatId) return undefined
  const matches = (character.chats ?? []).filter((chat) => chat?.id === chatId)
  return matches.length === 1 ? { chat: matches[0], chatIndex: character.chats.indexOf(matches[0]) } : undefined
}

interface ChatOwner {
  chat: character['chats'][number]
  chatIndex: number
}

function resolveGeneration(ref: ServerGenerationEffectLedgerRef): RecoveredGenerationResolution | undefined {
  const characters = characterRowsForRecovery()
  const resolutions: RecoveredGenerationResolution[] = []
  for (let characterIndex = 0; characterIndex < characters.length; characterIndex++) {
    const character = characters[characterIndex]
    if (!character?.chaId || getCharacterResourceOwner(character.chaId) !== character) {
      continue
    }
    if (ref.characterId && character.chaId !== ref.characterId) continue
    for (let chatIndex = 0; chatIndex < (character.chats?.length ?? 0); chatIndex++) {
      const chat = character.chats[chatIndex]
      if (ref.chatId && chat.id !== ref.chatId) continue
      if (!chat.id) continue
      const messages = getChatMessageOwnerState(chat.id)?.messages
      if (!messages) continue
      const matches = messages.filter((message) => message.chatId === ref.messageId)
      if (matches.length !== 1) continue
      const messageIndex = messages.indexOf(matches[0])
      if (messageIndex < 0) continue
      const message = messages[messageIndex]
      if (message.role !== 'char' || message.generationInfo?.generationId !== ref.generationId) continue
      resolutions.push({
        character,
        chat: { ...chat, message: messages },
        message,
        characterIndex,
        chatIndex,
        messageIndex,
      })
    }
  }
  return resolutions.length === 1 ? resolutions[0] : undefined
}

function findAcceptedAssistant(
  target: ActiveChatTarget,
  acceptedMessageId: string,
): RecoveredGenerationResolution | undefined {
  const character = target.characterId
    ? characterOwnerById(target.characterId)
    : characterOwnerAt(target.selectedCharID)
  if (!character) return undefined
  const characterIndex = characterRowsForRecovery().indexOf(character)
  const chatOwner = target.chatId
    ? uniqueChatOwner(character, target.chatId)
    : character.chats[target.chatPage]
      ? { chat: character.chats[target.chatPage], chatIndex: target.chatPage }
      : undefined
  if (!chatOwner) return undefined
  const { chat, chatIndex } = chatOwner
  if (!chat.id) return undefined
  const messages = getChatMessageOwnerState(chat.id)?.messages
  if (!messages) return undefined
  const acceptedMatches = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.chatId === acceptedMessageId && message.role === 'user')
  if (acceptedMatches.length !== 1) return undefined
  const acceptedIndex = acceptedMatches[0].index
  const messageIndex = acceptedIndex + 1
  const message = messages[messageIndex]
  if (acceptedIndex < 0 || message?.role !== 'char') return undefined
  return { character, chat: { ...chat, message: messages }, message, characterIndex, chatIndex, messageIndex }
}

registerRecoveredEffectsRuntime({
  reconcilePendingRecoveredGenerationEffects,
  setPendingRecoveredGenerationEffects,
})
