import {
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  getClientSessionSnapshot,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import type { Message, character } from '../storage/database.svelte'
import { chatOutputListeners, isChatOutputRuntimeReady, runChatOutputListeners } from '../plugins/chatOutputListeners'
import { getChatMessageOwnerState, hydrateChatMessages } from '../server/chatMessageHydration.svelte'
import type { PendingGenerationEffect } from '../server/bootstrap'
import { evaluateIgpOutcome } from './postGeneration/igp'
import { captureContinueExtendIgpAuthority, type IgpContinueExtendAuthority } from './postGeneration/igpTargetAuthority'
import { loadAndTrimCharEmotion } from './postGeneration/charEmotionStore'
import { runEmotionEmbeddingFallback } from './postGeneration/emotionFallbackEmbedding'
import { runEmotionLlmFallback } from './postGeneration/emotionFallbackLlm'
import { runImggenStableDiff } from './postGeneration/imggenStableDiff'
import { stablePostGenerationMessageTarget } from './postGeneration/stableTarget'
import { chatCompletionNotificationInput, fireDesktopNotification } from './postGeneration/notification'
import { playMessageCompletionSoundIfEnabled } from './messageCompletionSound'
import { isChatVisible, markChatUnread } from './chatUnread.svelte'
import {
  abandonPreparedGenerationInlay,
  completedGenerationEffect,
  generationEffectRefFromMessage,
  generationEffectRefFromPending,
  hasActiveGenerationInlayPreparation,
  isGenerationInlayPreparationActive,
  runLedgeredGenerationEffect,
  skippedGenerationEffect,
} from './generationEffectLedger'
import type { ServerGenerationEffectLedgerRef } from '@risuai/protocol/generation-sse'
import type { ActiveChatTarget } from '../chatCommands'
import { resolveActiveChatGenerationSettings } from '../activeChatGenerationSettings'
import { getGenerationOperationsRuntime, registerRecoveredEffectsRuntime } from './generationRuntimeBridge'
import { ensureResourceSurfaces } from '../server/routeResourceLoader'
import {
  charactersResourceState,
  getCharacterResourceOwner,
  settingsResourceState,
} from '../server/resourceState.svelte'
import {
  captureClientChatOccupancyAuthority,
  isClientChatOccupancyAuthorityCurrent,
  listClientChatOccupancyAuthorities,
  registerClientChatOccupancyRecoveryHandler,
  type ClientChatOccupancyAuthority,
} from '../server/chatOccupancy'
import { get } from 'svelte/store'

function recoveryIsCurrent(generation: number, authority?: ClientChatOccupancyAuthority): boolean {
  return (
    isClientSessionGenerationCurrent(generation) &&
    (authority
      ? authority.sessionGeneration === generation && isClientChatOccupancyAuthorityCurrent(authority)
      : canUseClientWriteAccess())
  )
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
  continueExtendAuthority?: IgpContinueExtendAuthority
}

export interface RecoveredGenerationEffectResult {
  durableEffectsReconciled: boolean
  allEffectsReconciled: boolean
}

export function setPendingRecoveredGenerationEffects(effects: readonly PendingGenerationEffect[]): void {
  bootstrapPendingEffects = [...effects]
}

let currentScopedEffectRecovery: Promise<void> | null = null
let scopedEffectRefreshRequestedAgain = false

function effectMatchesAnyAuthority(
  effect: PendingGenerationEffect,
  authorities: readonly ClientChatOccupancyAuthority[],
): boolean {
  const scope = effect.generationScope
  if (!scope || scope.admissionKind === 'legacy_owner') return canUseClientWriteAccess()
  if (
    (scope.admissionKind === 'owner_occupancy' && scope.occupancyClaimClass !== 'owner') ||
    (scope.admissionKind === 'chat_only' && scope.occupancyClaimClass !== 'chat_only')
  ) {
    return false
  }
  return authorities.some(
    (authority) =>
      effect.databaseLineage === authority.databaseLineage &&
      effect.chatId === authority.chatId &&
      scope.occupancyDatabaseLineage === authority.databaseLineage &&
      scope.occupancySessionId === authority.sessionId &&
      scope.occupancyEpoch === authority.occupancyEpoch &&
      scope.permissionScopeVersion === 1,
  )
}

/** Refresh and settle only effects admitted by this page's exact occupied-chat tuple. */
export function recoverCurrentChatOccupancyGenerationEffects(options: { readonly refresh: boolean }): Promise<void> {
  if (currentScopedEffectRecovery) {
    scopedEffectRefreshRequestedAgain ||= options.refresh
    return currentScopedEffectRecovery
  }
  const sourceGeneration = captureClientSessionGeneration()
  const session = getClientSessionSnapshot()
  const authorities = listClientChatOccupancyAuthorities()
  if (!session.authenticated || session.connection !== 'live' || authorities.length === 0) {
    bootstrapPendingEffects = bootstrapPendingEffects.filter(
      (effect) => effect.generationScope?.admissionKind === 'legacy_owner',
    )
    return Promise.resolve()
  }
  const run = (async () => {
    if (options.refresh) {
      const { fetchServerBootstrapReadOnly } = await import('../server/bootstrap')
      const result = await fetchServerBootstrapReadOnly(null, { cacheRevision: false })
      if (!isClientSessionGenerationCurrent(sourceGeneration) || result.status !== 'ok') return
      const generationOperations = getGenerationOperationsRuntime()
      if (!generationOperations.applyGenerationOperationBootstrap(result.bootstrap, 'bootstrap')) return
      bootstrapPendingEffects = (result.bootstrap.pendingGenerationEffects ?? []).filter((effect) =>
        effectMatchesAnyAuthority(effect, authorities),
      )
    } else {
      bootstrapPendingEffects = bootstrapPendingEffects.filter((effect) =>
        effectMatchesAnyAuthority(effect, authorities),
      )
    }
    if (!isClientSessionGenerationCurrent(sourceGeneration) || bootstrapPendingEffects.length === 0) return
    await reconcilePendingRecoveredGenerationEffects()
  })()
  const wrapped = run.finally(() => {
    if (currentScopedEffectRecovery === wrapped) currentScopedEffectRecovery = null
    if (scopedEffectRefreshRequestedAgain) {
      scopedEffectRefreshRequestedAgain = false
      void recoverCurrentChatOccupancyGenerationEffects({ refresh: true })
    }
  })
  currentScopedEffectRecovery = wrapped
  return wrapped
}

interface PendingEffectRecoveryAuthority {
  authority: ClientChatOccupancyAuthority
  generationScope: NonNullable<PendingGenerationEffect['generationScope']>
  operationAttemptNo: number
}

function pendingEffectAuthority(
  effects: readonly PendingGenerationEffect[],
): PendingEffectRecoveryAuthority | undefined {
  const scoped = effects.find(
    (effect) => effect.generationScope && effect.generationScope.admissionKind !== 'legacy_owner',
  )
  const scope = scoped?.generationScope
  if (!scoped || !scope) return undefined
  const authority = captureClientChatOccupancyAuthority(scoped.chatId)
  const operationAttemptNo = scoped.operationAttemptNo
  if (
    !authority ||
    scoped.keyType !== 'operation' ||
    scoped.operationId !== scoped.keyId ||
    !Number.isSafeInteger(operationAttemptNo) ||
    operationAttemptNo === undefined ||
    operationAttemptNo < 1 ||
    scoped.databaseLineage !== authority.databaseLineage ||
    scope.occupancyDatabaseLineage !== authority.databaseLineage ||
    scope.occupancySessionId !== authority.sessionId ||
    scope.occupancyEpoch !== authority.occupancyEpoch ||
    (scope.admissionKind === 'owner_occupancy' && scope.occupancyClaimClass !== 'owner') ||
    (scope.admissionKind === 'chat_only' && scope.occupancyClaimClass !== 'chat_only') ||
    scope.permissionScopeVersion !== 1 ||
    effects.some(
      (effect) =>
        effect.databaseLineage !== scoped.databaseLineage ||
        effect.generationId !== scoped.generationId ||
        effect.characterId !== scoped.characterId ||
        effect.chatId !== scoped.chatId ||
        effect.messageId !== scoped.messageId ||
        effect.keyType !== scoped.keyType ||
        effect.keyId !== scoped.keyId ||
        effect.operationId !== scoped.operationId ||
        effect.operationAttemptNo !== operationAttemptNo ||
        JSON.stringify(effect.generationScope) !== JSON.stringify(scope),
    )
  ) {
    return undefined
  }
  return { authority, generationScope: scope, operationAttemptNo }
}

export async function reconcilePendingRecoveredGenerationEffects(): Promise<void> {
  const sourceGeneration = captureClientSessionGeneration()
  if (!isClientSessionGenerationCurrent(sourceGeneration)) throw new Error('client_write_access_required')
  const pendingEffects = bootstrapPendingEffects
  const refs = new Map<string, { ref: ServerGenerationEffectLedgerRef; effects: PendingGenerationEffect[] }>()
  for (const effect of pendingEffects) {
    const ref = generationEffectRefFromPending(effect)
    const key = `${ref.databaseLineage}:${ref.generationId}`
    const existing = refs.get(key)
    if (existing) existing.effects.push(effect)
    else refs.set(key, { ref, effects: [effect] })
  }
  const settled = new Set<string>()
  const failures: unknown[] = []
  for (const [key, grouped] of refs) {
    const { ref, effects } = grouped
    const recoveryAuthority = pendingEffectAuthority(effects)
    const authority = recoveryAuthority?.authority
    if (
      effects.some((effect) => effect.generationScope && effect.generationScope.admissionKind !== 'legacy_owner') &&
      !recoveryAuthority
    ) {
      failures.push(new Error(`Generation effects remain unavailable for ${ref.generationId}`))
      continue
    }
    if (!recoveryIsCurrent(sourceGeneration, authority)) {
      failures.push(new Error(`Generation effects remain unavailable for ${ref.generationId}`))
      continue
    }
    try {
      if (effects.some((effect) => effect.kind === 'igp') && hasActiveGenerationInlayPreparation(ref)) {
        // The live owner registers before sending the durable preparation.
        // Bootstrap can therefore observe the pending IGP before it can
        // observe the marker. Retain the whole generation until that exact
        // operation/message registration retires and schedules another pass.
        continue
      }
      const inlayPreparationId = effects.find((effect) => effect.kind === 'igp')?.inlayPreparationId
      if (inlayPreparationId) {
        if (isGenerationInlayPreparationActive(ref, inlayPreparationId)) {
          // A generated-translation event can wake recovery while this same
          // page still owns the image provider. Retain the bootstrap row; the
          // finalization/abandonment event will schedule the next pass.
          continue
        }
        if (!authority || ref.keyType !== 'operation') {
          throw new Error(`Generation inlay preparation remains unavailable for ${ref.generationId}`)
        }
        const abandoned = await abandonPreparedGenerationInlay(ref, authority, {
          operationId: ref.keyId,
          preparationId: inlayPreparationId,
        })
        if (abandoned === 'ambiguous') {
          throw new Error(`Generation inlay preparation remains ambiguous for ${ref.generationId}`)
        }
      }
      await hydrateChatMessages(ref.chatId, { force: true, strict: true })
      if (!recoveryIsCurrent(sourceGeneration, authority)) throw new Error('client_write_operation_stale')
      const result = await reconcileRecoveredGenerationEffects(
        ref,
        authority,
        recoveryAuthority?.generationScope,
        recoveryAuthority?.operationAttemptNo,
      )
      if (!result.allEffectsReconciled) {
        throw new Error(`Generation effects remain unavailable for ${ref.generationId}`)
      }
      settled.add(key)
    } catch (error) {
      // A failed chat retains its own work, while later chats can still settle.
      failures.push(error)
    }
  }
  if (!isClientSessionGenerationCurrent(sourceGeneration)) throw new Error('client_write_operation_stale')
  // A newer bootstrap owns its complete pending snapshot. This pass can retire
  // only the exact snapshot it captured, even if generation identities match.
  if (bootstrapPendingEffects === pendingEffects) {
    bootstrapPendingEffects = pendingEffects.filter(
      (effect) => !settled.has(`${effect.databaseLineage}:${effect.generationId}`),
    )
  }
  if (failures.length > 0) throw failures[0]
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
  authority?: ClientChatOccupancyAuthority,
  generationScope?: NonNullable<PendingGenerationEffect['generationScope']>,
  operationAttemptNo?: number,
): Promise<RecoveredGenerationEffectResult> {
  const sourceGeneration = captureClientSessionGeneration()
  if (authority && !generationScope) return unavailableEffects()
  if (!recoveryIsCurrent(sourceGeneration, authority)) return unavailableEffects()
  if (!authority && !isChatOutputRuntimeReady()) {
    throw new Error('Plugin runtime is not ready for recovered output effects')
  }
  // Recovery precedes ordinary chat readiness on a returning/promoted writer.
  // An omitted unloaded setting is not proof that an effect is disabled, and
  // must never become a permanent not-configured receipt.
  await ensureResourceSurfaces(['runtime:chat-generation'])
  if (!recoveryIsCurrent(sourceGeneration, authority)) return unavailableEffects()
  const ledgerOptions = authority ? { chatOccupancyAuthority: authority } : undefined
  const recovered = resolveGeneration(ref, operationAttemptNo)
  const unexpectedEphemeral = () => completedGenerationEffect(undefined)
  const ephemeral = await Promise.all([
    runLedgeredGenerationEffect(
      ref,
      'notification',
      'late_recovery',
      async (effectContext) => {
        if (!effectContext.isCurrent() || !recovered) return skippedGenerationEffect('target_changed')
        if (
          settingsResourceState.status !== 'ready' ||
          !(settingsResourceState.value as Record<string, unknown>).notification
        ) {
          return skippedGenerationEffect('not_configured')
        }
        await fireDesktopNotification(chatCompletionNotificationInput(recovered.character, recovered.message.data))
        return completedGenerationEffect(undefined)
      },
      { recoverRecentCompletionAlert: true, ...(authority ? { chatOccupancyAuthority: authority } : {}) },
    ),
    runLedgeredGenerationEffect(ref, 'tts', 'late_recovery', unexpectedEphemeral, ledgerOptions),
    runLedgeredGenerationEffect(
      ref,
      'completion_sound',
      'late_recovery',
      () =>
        playMessageCompletionSoundIfEnabled()
          ? completedGenerationEffect(undefined)
          : skippedGenerationEffect('not_configured'),
      { recoverRecentCompletionAlert: true, ...(authority ? { chatOccupancyAuthority: authority } : {}) },
    ),
  ])

  if (!recoveryIsCurrent(sourceGeneration, authority)) return unavailableEffects()
  // A recent claim also owns the unread indication when the user disabled
  // desktop/audio alerts. Replayed or stale claims must not re-mark read chats.
  if (recovered && !isChatVisible(ref.chatId) && (ephemeral[0].executed || ephemeral[2].executed)) {
    markChatUnread(ref.chatId)
  }

  const initial = recovered ?? resolveGeneration(ref, operationAttemptNo)
  if (!initial) return { durableEffectsReconciled: false, allEffectsReconciled: false }
  const completionText = initial.message.data

  // Match the uninterrupted ordering: plugin automation observes the terminal
  // transcript before IGP appends its durable prompt output.
  const plugin = await runLedgeredGenerationEffect(
    ref,
    'plugin_output',
    'late_recovery',
    async (effectContext) => {
      if (generationScope?.admissionKind === 'chat_only') {
        return skippedGenerationEffect('unsupported_chat_only_scope')
      }
      const resolution = resolveGeneration(ref, operationAttemptNo)
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
    },
    ledgerOptions,
  )

  if (!recoveryIsCurrent(sourceGeneration, authority)) return unavailableEffects()
  // A recovery pass can begin before the terminal owner registers its inlay
  // request. Recheck at the IGP boundary so prior plugin work may settle but
  // the raw transcript is never claimed while this exact preparation is live.
  if (hasActiveGenerationInlayPreparation(ref)) return unavailableEffects()
  const igp = await runLedgeredGenerationEffect(
    ref,
    'igp',
    'late_recovery',
    async (effectContext) => {
      const resolution = resolveGeneration(ref, operationAttemptNo)
      const promptTemplate =
        settingsResourceState.status === 'ready' ? String(settingsResourceState.value.igpPrompt ?? '') : ''
      const exactOccupiedIgp = !!effectContext.igpEffect && !!authority
      if (!resolution || (!exactOccupiedIgp && !promptTemplate.trim())) {
        return skippedGenerationEffect('not_configured')
      }
      const database = exactOccupiedIgp ? undefined : resolveRecoveredGenerationDatabase(resolution)
      if (!exactOccupiedIgp && !database) throw new Error('Recovered generation settings are unavailable')
      const outcome = await evaluateIgpOutcome({
        promptTemplate,
        ...(database ? { database } : {}),
        igpEffect: effectContext.igpEffect,
        effectLedgerRef: ref,
        ...(authority ? { chatOccupancyAuthority: authority } : {}),
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
          ...(resolution.continueExtendAuthority
            ? { continueExtendAuthority: resolution.continueExtendAuthority }
            : {}),
        },
      })
      return outcome === 'updated' ? completedGenerationEffect(undefined) : skippedGenerationEffect(outcome)
    },
    ledgerOptions,
  )

  if (!recoveryIsCurrent(sourceGeneration, authority)) return unavailableEffects()
  const emotion = await runLedgeredGenerationEffect(
    ref,
    'emotion_image_state',
    'late_recovery',
    async (effectContext) => {
      if (generationScope?.admissionKind === 'chat_only') {
        return skippedGenerationEffect('unsupported_chat_only_scope')
      }
      const resolution = resolveGeneration(ref, operationAttemptNo)
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
    ledgerOptions,
  )

  if (!recoveryIsCurrent(sourceGeneration, authority)) return unavailableEffects()
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

function resolveGeneration(
  ref: ServerGenerationEffectLedgerRef,
  operationAttemptNo?: number,
): RecoveredGenerationResolution | undefined {
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
      if (message.role !== 'char') continue
      const continueExtendAuthority =
        message.generationInfo?.generationId === ref.generationId
          ? undefined
          : captureContinueExtendIgpAuthority({
              ref,
              operationAttemptNo,
              message,
              operation: get(getGenerationOperationsRuntime().generationOperationProjections).find(
                (operation) => operation.operationId === ref.keyId,
              ),
            })
      if (message.generationInfo?.generationId !== ref.generationId && !continueExtendAuthority) continue
      resolutions.push({
        character,
        chat: { ...chat, message: messages },
        message,
        characterIndex,
        chatIndex,
        messageIndex,
        ...(continueExtendAuthority ? { continueExtendAuthority } : {}),
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

registerClientChatOccupancyRecoveryHandler(recoverCurrentChatOccupancyGenerationEffects)
