import { captureClientSessionGeneration } from '../clientSession'
import { isClientWriteOperationCurrent } from '../clientWriteOperation'
import { get } from 'svelte/store'
import {
  type Database,
  type character,
  type Chat,
  type Message,
  type MessageGenerationInfo,
  type MessagePresetInfo,
} from '../storage/database.svelte'
import { selectedCharID } from '../stores.svelte'
import { safeStructuredClone } from '../polyfill'
import { getInlayAssetMetadata, getServerInlayAssetId } from './files/inlays'
import { runInlayScreen } from './inlayScreen'
import { applyServerChatRestoration, applyServerMessagePatch } from './request/serverMessagePatch'
import {
  requestServerChat,
  requestServerChatGeneration,
  SERVER_CHAT_CLIENT_CAPABILITIES,
  type ServerChatInput,
  type ServerChatOperationStream,
  type ServerChatTerminal,
} from './request/serverChat'
import type { ServerChatMessagePatch, ServerChatPostGeneration } from '@risuai/protocol/generation-sse'
import type { DispatchSuccessReq } from './dispatch/dispatchRequest'
import type { OpenAIChat } from './index.svelte'
import { seedRerollBufferFromAlternates } from './rerollNavigation.svelte'
import { sayTTS } from './tts'
import {
  applyChatMetadataOwnerPatch,
  captureChatBodyProjectionEpoch,
  charactersResourceState,
  getCharacterResourceOwner,
  hasChatBodyProjectionEpochChanged,
  hasNewerChatBodyResourceRevision,
  restoreChatMetadataOwnerSnapshot,
  settingsResourceState,
} from '../server/resourceState.svelte'
import { captureChatMessageMutationIntentEpoch } from '../server/chatMessageMutationIntent'
import { finalizeServerBackedInlayMessage } from './inlayFinalization'
import { hydrateChatMessages } from '../server/chatMessageHydration.svelte'
import type { StreamMessageProjection } from './postGeneration/streamResponse'
import type { IgpMessageTarget } from './postGeneration/igp'
import { clearGenerationPersistence, markGenerationPersistenceQueued } from './generationPersistenceState'
import { yieldBeforeCompletionEffect } from './completionEffectScheduling'
import { chatOutputListeners, runChatOutputListeners } from '../plugins/chatOutputListeners'
import { alertConfirm } from '../alert'
import { language } from '../../lang'
import { currentChatScopedSnapshot, dispatchUpdateChatScopedWithOutcome } from '../chatCommands'
import { HYPA_CONTEXT_TRUNCATION_CONFIRMATION_REQUIRED } from './request/hypaContextTruncation'
import { sendChatFailureFromServerCode, type SendChatFailure } from './sendChatFailure'
import type { GenerationReattachOutcomeStatus } from './generationReattachOutcome'
import {
  completedGenerationEffect,
  runLedgeredGenerationEffect,
  skippedGenerationEffect,
} from './generationEffectLedger'
import type { ServerGenerationEffectLedgerRef } from '@risuai/protocol/generation-sse'
import { readBrowserClientContext } from './request/clientContext'
import {
  canUseGenerationOperationProtocol,
  stageTargetedGenerationOperation,
  submitStagedTargetedGenerationOperation,
} from '../server/generationOperations'
import {
  beginGenerationDisplayProjection,
  finishGenerationDisplayProjection,
  updateGenerationDisplayProjection,
  type GenerationDisplayProjectionRef,
} from './generationDisplayProjection.svelte'
import { updateChatGenerationActivityMetadata } from './generationActivity.svelte'
import { waitForPendingCharacterScriptDefinitionSave } from '../server/scriptDefinitionOwner.svelte'

export interface ServerBackedStageTimings {
  stage1Start: number
  stage1Duration: number
}

type ServerChatAnyResult =
  | Awaited<ReturnType<typeof requestServerChat>>
  | Awaited<ReturnType<typeof requestServerChatGeneration>>

export type ServerBackedDispatch = {
  req: DispatchSuccessReq
  generationId: string
  generationInfo: MessageGenerationInfo
  terminal: Promise<ServerChatTerminal>
  restorationGuard?: ServerBackedRestorationGuard
}

export interface ServerBackedRestorationGuard {
  chatId: string
  mutationIntentEpoch: number
  projectionEpoch: number
}

export function captureServerBackedRestorationGuard(
  chatId: string | undefined,
): ServerBackedRestorationGuard | undefined {
  if (!chatId) return undefined
  return {
    chatId,
    mutationIntentEpoch: captureChatMessageMutationIntentEpoch(chatId),
    projectionEpoch: captureChatBodyProjectionEpoch(chatId),
  }
}

function isServerBackedRestorationGuardFresh(guard: ServerBackedRestorationGuard): boolean {
  return (
    captureChatMessageMutationIntentEpoch(guard.chatId) === guard.mutationIntentEpoch &&
    !hasChatBodyProjectionEpochChanged(guard.chatId, guard.projectionEpoch)
  )
}

export type ServerBackedAssemblyResult =
  | { status: 'aborted' }
  | {
      status: 'failed'
      error: string
      currentChat: Chat
      failure?: SendChatFailure
      reattachOutcome?: GenerationReattachOutcomeStatus
    }
  | { status: 'preview'; formated?: OpenAIChat[]; body?: string }
  | {
      status: 'assembled'
      currentChat: Chat
      formated: OpenAIChat[]
      biases: [string, number][]
      inputTokens: number
      outputTokens: number
      dispatch?: ServerBackedDispatch
    }

export type ServerBackedTerminalResult =
  | {
      status: 'ok'
      currentChat: Chat
      resendChat: boolean
      igpTarget?: IgpMessageTarget
      effectLedger?: ServerGenerationEffectLedgerRef
    }
  | {
      status: 'cancelled'
      currentChat: Chat
      resendChat: false
      reattachOutcome?: GenerationReattachOutcomeStatus
    }
  | {
      status: 'failed'
      error: string
      currentChat: Chat
      resendChat: boolean
      reattachOutcome?: GenerationReattachOutcomeStatus
    }

function numberFrom(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** @legacy-compatibility Older servers omit the response-budget field. */
export function olderServerResponseBudgetFallback(): number {
  const ownerValue = numberFrom((settingsResourceState.value as Partial<Database>).maxResponse)
  return settingsResourceState.status === 'ready' && ownerValue !== undefined ? ownerValue : 500
}

function isServerChatGenerationOk(
  served: ServerChatAnyResult,
): served is Extract<Awaited<ReturnType<typeof requestServerChatGeneration>>, { status: 'ok' }> {
  return served.status === 'ok' && 'req' in served
}

// Exported for regression tests; not part of the public API.
export function findGeneratedAssistantMessage(chat: Chat, generationId: string): Message | undefined {
  const byId = chat.message.find((message) => message.chatId === generationId)
  if (byId?.role === 'char') return byId
  // Scan newest-to-oldest in place — the former
  // `[...chat.message].reverse().find(...)` copied the whole transcript on
  // every terminal lookup just to find the last match.
  for (let i = chat.message.length - 1; i >= 0; i--) {
    const message = chat.message[i]
    if (message.role === 'char' && message.generationInfo?.generationId === generationId) {
      return message
    }
  }
  return undefined
}

function activeChatId(): string | undefined {
  const character = characterOwnerAt(get(selectedCharID))
  return character?.chats?.[character.chatPage]?.id
}

async function acknowledgeHypaContextTruncation(args: {
  selectedChar: number
  selectedChat: number
  characterId: string
  chatId: string
  currentChat: Chat
}): Promise<{ status: 'ok'; currentChat: Chat } | { status: 'failed'; currentChat: Chat }> {
  const previous = currentChatScopedSnapshot({ selectedChar: args.selectedChar, selectedChat: args.selectedChat })
  const previousAcknowledgement = args.currentChat.hypaContextTruncationAcknowledged
  if (!applyChatMetadataOwnerPatch(args.characterId, args.chatId, { hypaContextTruncationAcknowledged: true })) {
    return { status: 'failed', currentChat: args.currentChat }
  }

  const pending = dispatchUpdateChatScopedWithOutcome(
    args.chatId,
    { hypaContextTruncationAcknowledged: true },
    previous,
  )
  if (!pending) {
    restoreChatMetadataOwnerSnapshot({
      characterId: args.characterId,
      chatId: args.chatId,
      metadata: { hypaContextTruncationAcknowledged: previousAcknowledgement },
      attempted: { hypaContextTruncationAcknowledged: true },
    })
    return { status: 'failed', currentChat: args.currentChat }
  }

  const outcome = await pending
  const accepted =
    outcome.status === 'accepted' || (outcome.status === 'queued' && (await outcome.settlement).status === 'accepted')
  const currentChat = resolveServerBackedCurrentChat({
    selectedChar: args.selectedChar,
    selectedChat: args.selectedChat,
    characterId: args.characterId,
    chatId: args.chatId,
    currentChat: args.currentChat,
  })
  return accepted ? { status: 'ok', currentChat } : { status: 'failed', currentChat }
}

/**
 * Turn provider multi-generation text choices into live reroll candidates. The
 * deterministic ids match the server's durable alternate records, so an
 * immediate live swipe and the next hydration address the same candidates.
 */
export function buildServerBackedAlternateMessages(
  assistant: Message,
  alternates: readonly unknown[],
  generationId: string,
): Message[] {
  const baseId = assistant.chatId || generationId || 'server-generation'
  return alternates.flatMap((value, index) => {
    if (typeof value !== 'string') return []
    const candidate = safeStructuredClone(assistant)
    candidate.data = value
    candidate.chatId = `${baseId}:alternate:${index + 1}`
    // A translation of the primary choice is stale for different source text.
    delete candidate.translation
    return [candidate]
  })
}

function serverChatMode(args: {
  preview?: boolean
  previewPrompt?: boolean
  regenerateMessageId?: string
  continue?: boolean
}): ServerChatInput['mode'] {
  if (args.previewPrompt) return 'preview_prompt'
  if (args.preview) return 'preview'
  if (typeof args.regenerateMessageId === 'string') return 'regenerate'
  if (args.continue) return 'continue'
  return 'send'
}

interface ServerBackedStableChatTarget {
  characterId?: string
  chatId?: string
}

interface ServerBackedLiveChatTarget extends ServerBackedStableChatTarget {
  selectedChar: number
  selectedChat: number
}

interface ServerBackedLiveChatResolution {
  character: character
  chat: Chat
}

function nonEmptyTargetId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function hasStableChatTarget(target: ServerBackedStableChatTarget | undefined): boolean {
  return nonEmptyTargetId(target?.characterId) && nonEmptyTargetId(target?.chatId)
}

/**
 * The character collection is the generation target owner once it is ready.
 * Stable ids have to identify exactly one ready owner row before a terminal
 * effect may write.
 */
function characterOwnerAt(index: number): character | undefined {
  const characters = characterRowsForGeneration()
  const candidate = characters[index]
  if (!candidate?.chaId) return undefined
  return getCharacterResourceOwner(candidate.chaId)
}

function characterRowsForGeneration(): readonly character[] {
  return charactersResourceState.status === 'ready' ? charactersResourceState.characters : []
}

function characterOwnerById(characterId: string): character | undefined {
  if (!characterId) return undefined
  return charactersResourceState.status === 'ready' ? getCharacterResourceOwner(characterId) : undefined
}

function uniqueChatOwner(character: character | undefined, chatId: string): Chat | undefined {
  if (!character || !chatId) return undefined
  const matches = (character.chats ?? []).filter((chat) => chat?.id === chatId)
  return matches.length === 1 ? matches[0] : undefined
}

function targetFromPayloadOrContext(
  payload: ServerBackedStableChatTarget | undefined,
  context: ServerBackedStableChatTarget,
): ServerBackedStableChatTarget {
  if (hasStableChatTarget(payload)) return payload ?? {}
  return hasStableChatTarget(context) ? context : {}
}

function resolveServerBackedLiveChat(target: ServerBackedLiveChatTarget): ServerBackedLiveChatResolution | undefined {
  if (hasStableChatTarget(target)) {
    // Stable ids are resolved through the character-row owner. The aggregate
    // database remains a compatibility mirror, and its position can change
    // while a detached generation is still delivering terminal effects.
    const character = characterOwnerById(target.characterId!)
    const chat = uniqueChatOwner(character, target.chatId!)
    return character && chat ? { character, chat } : undefined
  }

  const character = characterOwnerAt(target.selectedChar)
  const chat = character?.chats?.[target.selectedChat]
  return character && chat ? { character, chat } : undefined
}

function unresolvedServerBackedChat(): Chat {
  return { message: [], note: '', name: '', localLore: [] } as Chat
}

function resolveServerBackedCurrentChat(target: ServerBackedLiveChatTarget & { currentChat?: Chat }): Chat {
  return resolveServerBackedLiveChat(target)?.chat ?? target.currentChat ?? unresolvedServerBackedChat()
}

async function reconcileRejectedGenerationProjection(args: {
  selectedChar: number
  selectedChat: number
  target: ServerBackedStableChatTarget
  streamProjection?: StreamMessageProjection
}): Promise<void> {
  const chatId = args.target.chatId
  const projection = args.streamProjection
  if (chatId && projection?.chatId === chatId) {
    const resolution = resolveServerBackedLiveChat({
      selectedChar: args.selectedChar,
      selectedChat: args.selectedChat,
      characterId: args.target.characterId,
      chatId,
    })
    const messages = resolution?.chat.message
    if (messages) {
      const messageId = projection.messageId || projection.generationId
      const index = messages.findIndex(
        (message) =>
          message.chatId === messageId ||
          (message.role === 'char' && message.generationInfo?.generationId === projection.generationId),
      )
      if (index >= 0 && messages[index]?.data === projection.ownedData) {
        if (projection.appended) messages.splice(index, 1)
        else messages[index].data = projection.previousData
      }
    }
  }
  if (chatId) {
    await hydrateChatMessages(chatId, { force: true, strict: true }).catch(() => {})
  }
}

function applyInterruptedTerminalSnapshot(args: {
  selectedChar: number
  selectedChat: number
  target: ServerBackedStableChatTarget
  generationId: string
  generationInfo: MessageGenerationInfo
  postGeneration?: ServerChatPostGeneration
  streamProjection?: StreamMessageProjection
}): void {
  const finalText = args.postGeneration?.finalText
  const projection = args.streamProjection
  if (typeof finalText !== 'string' || !args.target.chatId || projection?.chatId !== args.target.chatId) {
    return
  }

  const resolution = resolveServerBackedLiveChat({
    selectedChar: args.selectedChar,
    selectedChat: args.selectedChat,
    characterId: args.target.characterId,
    chatId: args.target.chatId,
  })
  if (!resolution) return
  const assistant =
    (args.postGeneration?.messageId
      ? resolution.chat.message.find(
          (message) => message.chatId === args.postGeneration?.messageId && message.role === 'char',
        )
      : undefined) ?? findGeneratedAssistantMessage(resolution.chat, args.generationId)
  // Reconcile only the row still owned by this stream. A user edit that landed
  // after the last token must win over the cancelled terminal snapshot.
  if (assistant) {
    if (assistant.data === projection.ownedData) assistant.data = finalText
    return
  }
  // Half-streaming Stop can remove its still-empty generated placeholder
  // before the cancelled terminal arrives. Recreate only that known-owned
  // append; detached/user-mutated streams must never resurrect a row.
  if (!projection.appended || projection.detached) return
  const messageId = args.postGeneration?.messageId ?? projection.messageId ?? args.generationId
  if (!messageId || resolution.chat.message.some((message) => message.chatId === messageId)) return
  const restored: Message = {
    role: 'char',
    data: finalText,
    chatId: messageId,
    saying: resolution.character.chaId,
    time: Date.now(),
    generationInfo: args.generationInfo,
  }
  const index = Math.min(
    Math.max(projection.messageIndex ?? resolution.chat.message.length, 0),
    resolution.chat.message.length,
  )
  resolution.chat.message.splice(index, 0, restored)
}

// Apply the server's `message_patch` to the local projection only. `/generate/chat`
// persists assembly-time chat-var deltas itself, so the browser no longer replays
// them as `PATCH .../scriptstate` commands. `applyServerMessagePatch` still writes
// `chatVarMutations` into the live chat so the local view reflects the write
// without a refresh; the SSE revision keeps the cached command revision in sync.
function applyServerMessagePatches(args: {
  patches: ServerChatMessagePatch[]
  selectedChar: number
  selectedChat: number
  targetCharacterId?: string
  targetChatId?: string
  currentChat: Chat
}): Chat {
  const { patches, selectedChar, selectedChat } = args
  const contextTarget = { characterId: args.targetCharacterId, chatId: args.targetChatId }
  for (const patch of patches) {
    const target = targetFromPayloadOrContext(patch, contextTarget)
    const resolution = resolveServerBackedLiveChat({
      selectedChar,
      selectedChat,
      characterId: target.characterId,
      chatId: target.chatId,
    })
    if (resolution) applyServerMessagePatch(resolution.chat, patch, resolution.character)
  }
  return resolveServerBackedCurrentChat({
    selectedChar,
    selectedChat,
    characterId: args.targetCharacterId,
    chatId: args.targetChatId,
    currentChat: args.currentChat,
  })
}

/** Legacy browser-local inlay id mapped to a server-owned asset id. */
interface ServerInlayAssetRefPayload {
  id: string
  assetId: string
  width?: number
  height?: number
}

const INLAY_MARKER_RE = /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g

/**
 * New Fastify inlay ids are server asset ids. For legacy browser-local ids,
 * upload the bytes once through the asset route and send only an id mapping so
 * the server resolves all prompt-time bytes from its own asset store.
 *
 * Id-collection mirrors the local history formatter: `char`-role messages surface
 * only `inlayeddata` ids (the SPA quirk where `inlay`/`inlayed` tags are stripped
 * from a bot turn without surfacing their assets); every other role surfaces all
 * three tag types.
 */
export async function collectServerInlayAssetRefs(chat: Chat): Promise<ServerInlayAssetRefPayload[]> {
  const ids = new Set<string>()
  for (const message of chat.message ?? []) {
    if (typeof message.data !== 'string') continue
    for (const match of message.data.matchAll(INLAY_MARKER_RE)) {
      if (message.role === 'char' && match[1] !== 'inlayeddata') continue
      ids.add(match[2])
    }
  }

  const refs: ServerInlayAssetRefPayload[] = []
  for (const id of ids) {
    const assetId = await getServerInlayAssetId(id)
    if (!assetId || assetId === id) continue
    const metadata = await getInlayAssetMetadata(id)
    refs.push({
      id,
      assetId,
      ...(typeof metadata?.width === 'number' ? { width: metadata.width } : {}),
      ...(typeof metadata?.height === 'number' ? { height: metadata.height } : {}),
    })
  }
  return refs
}

export async function assembleServerBackedSendChat(args: {
  selectedChar: number
  selectedChat: number
  currentChar: character
  currentChat: Chat
  promptInfo: MessagePresetInfo
  stageTimings: ServerBackedStageTimings
  abortSignal: AbortSignal
  setProcessStage: (stage: number) => void
  preview?: boolean
  previewPrompt?: boolean
  continue?: boolean
  regenerateMessageId?: string
  syntheticSayNothing?: boolean
  /**
   * `resolveDurableGeneration === 'durable'` for this send. The server runs it as
   * a detached job and persists the result, so the coordinator suppresses the
   * browser's generation-result persist.
   */
  durable?: boolean
}): Promise<ServerBackedAssemblyResult> {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (!isCurrent()) return { status: 'aborted' }
  const restorationGuard = captureServerBackedRestorationGuard(args.currentChat.id)
  // `resolveServerPromptAssembly` has already verified that a send ends in a
  // text user or assistant row. A user tail supplies the submitted text; an
  // assistant tail is Original's empty-send dispatch and appends no user row.
  const mode = serverChatMode(args)
  const lastMessage = args.currentChat.message.at(-1)
  const userMessage = mode === 'send' && lastMessage?.role === 'user' ? lastMessage.data : undefined
  const emptySend = mode === 'send' && lastMessage?.role === 'char'

  args.setProcessStage(1)
  args.stageTimings.stage1Start = Date.now()
  const input: ServerChatInput = {
    chatId: args.currentChat.id ?? '',
    characterId: args.currentChar.chaId,
    mode,
  }
  if (typeof userMessage === 'string') {
    input.userMessage = userMessage
  }
  if (emptySend) {
    input.emptySend = true
  }
  if (mode === 'send' && args.syntheticSayNothing === true) {
    input.syntheticSayNothing = true
  }
  if (mode === 'regenerate') {
    input.regenerateMessageId = args.regenerateMessageId
  }
  // `send`, `continue`, and `regenerate` are durable-eligible. The caller already
  // gated `durable` on `resolveDurableGeneration`, so the server owns result
  // persistence for this job and the browser skips its own write.
  if (args.durable && (mode === 'send' || mode === 'continue' || mode === 'regenerate')) {
    input.durable = true
  }
  const wantsServerDispatch = !args.preview && !args.previewPrompt
  if (wantsServerDispatch) {
    const scripts = await waitForPendingCharacterScriptDefinitionSave(args.currentChar.chaId)
    if (!isCurrent()) return { status: 'aborted' }
    if (scripts === 'queued' || scripts === 'failed') {
      return {
        status: 'failed',
        error: language.composerDraftRecovery.sendFailureDetails.characterDefinitions,
        currentChat: args.currentChat,
      }
    }
  }
  // New inlay tokens are server asset ids already. Legacy browser-local ids are
  // uploaded before dispatch and sent as id->assetId aliases only; no inlay bytes
  // ride the chat request anymore.
  const inlayAssetRefs = await collectServerInlayAssetRefs(args.currentChat)
  if (!isCurrent()) return { status: 'aborted' }
  if (inlayAssetRefs.length > 0) {
    input.inlayAssetRefs = inlayAssetRefs
  }

  let served: ServerChatAnyResult
  const targetMessageId = mode === 'regenerate' ? args.regenerateMessageId : lastMessage?.chatId
  let regenerateDisplayProjection: GenerationDisplayProjectionRef | undefined
  if (
    wantsServerDispatch &&
    args.durable &&
    (mode === 'continue' || mode === 'regenerate') &&
    targetMessageId &&
    canUseGenerationOperationProtocol()
  ) {
    const staged = await stageTargetedGenerationOperation({
      target: {
        selectedCharID: args.selectedChar,
        chatPage: args.selectedChat,
        characterId: args.currentChar.chaId,
        chatId: args.currentChat.id,
      },
      mode,
      targetMessageId,
      generation: {
        syntheticSayNothing: false,
        resetMessages: false,
        inlayAssetRefs,
        clientContext: readBrowserClientContext(),
        clientCapabilities: { ...SERVER_CHAT_CLIENT_CAPABILITIES },
      },
    })
    if (!isCurrent()) return { status: 'aborted' }
    if ('status' in staged) {
      return { status: 'failed', error: staged.error, currentChat: args.currentChat }
    }
    const submitted = await submitStagedTargetedGenerationOperation(staged)
    if (!isCurrent()) return { status: 'aborted' }
    if (submitted.status !== 'accepted' || !submitted.stream) {
      return {
        status: 'failed',
        error: submitted.status === 'accepted' ? 'Generation operation returned no live stream.' : submitted.error,
        currentChat: args.currentChat,
      }
    }
    if (mode === 'regenerate') {
      regenerateDisplayProjection = {
        operationId: submitted.stream.operationId,
        attemptNo: submitted.stream.attemptNo,
        characterId: args.currentChar.chaId,
        chatId: args.currentChat.id ?? '',
        mode: 'regenerate',
        targetMessageId,
        projectionEpoch: submitted.stream.projectionEpoch,
      }
      beginGenerationDisplayProjection(regenerateDisplayProjection)
      updateChatGenerationActivityMetadata(
        {
          selectedCharID: args.selectedChar,
          chatPage: args.selectedChat,
          characterId: args.currentChar.chaId,
          chatId: args.currentChat.id,
        },
        {
          operationId: submitted.stream.operationId,
          mode: 'regenerate',
          targetMessageId,
          attemptNo: submitted.stream.attemptNo,
          projectionEpoch: submitted.stream.projectionEpoch,
        },
      )
    }
    served = await requestServerChatGeneration(input, args.abortSignal, undefined, submitted.stream)
  } else {
    served = wantsServerDispatch
      ? await requestServerChatGeneration(input, args.abortSignal)
      : await requestServerChat(input, args.abortSignal)
  }

  if (!isCurrent()) return { status: 'aborted' }
  if (
    wantsServerDispatch &&
    served.status === 'error' &&
    served.code === HYPA_CONTEXT_TRUNCATION_CONFIRMATION_REQUIRED
  ) {
    const confirmed = await alertConfirm(language.hypaContextTruncationConfirm)
    if (!isCurrent()) return { status: 'aborted' }
    if (!confirmed || args.abortSignal.aborted) return { status: 'aborted' }

    const acknowledgement = await acknowledgeHypaContextTruncation({
      selectedChar: args.selectedChar,
      selectedChat: args.selectedChat,
      characterId: args.currentChar.chaId,
      chatId: args.currentChat.id ?? '',
      currentChat: args.currentChat,
    })
    if (!isCurrent()) return { status: 'aborted' }
    if (acknowledgement.status === 'failed') {
      return {
        status: 'failed',
        error: language.errors.hypaContextTruncationAcknowledgementFailed,
        currentChat: acknowledgement.currentChat,
      }
    }
    if (args.abortSignal.aborted || activeChatId() !== input.chatId) return { status: 'aborted' }
    served = await requestServerChatGeneration(input, args.abortSignal)
  }

  if (!isCurrent()) return { status: 'aborted' }
  if (served.status === 'aborted') {
    if (regenerateDisplayProjection) finishGenerationDisplayProjection(regenerateDisplayProjection)
    return { status: 'aborted' }
  }
  if (served.status === 'error') {
    if (regenerateDisplayProjection) finishGenerationDisplayProjection(regenerateDisplayProjection)
    const currentChat = applyServerMessagePatches({
      patches: served.messagePatches ?? [],
      selectedChar: args.selectedChar,
      selectedChat: args.selectedChat,
      targetCharacterId: args.currentChar.chaId,
      targetChatId: args.currentChat.id,
      currentChat: args.currentChat,
    })
    const failure = sendChatFailureFromServerCode(served.code)
    const reattachOutcome =
      'reattachOutcome' in served ? (served.reattachOutcome as GenerationReattachOutcomeStatus | undefined) : undefined
    return {
      status: 'failed',
      error: served.error,
      currentChat,
      ...(failure ? { failure } : {}),
      ...(reattachOutcome ? { reattachOutcome } : {}),
    }
  }
  if (
    regenerateDisplayProjection &&
    isServerChatGenerationOk(served) &&
    served.req.type === 'streaming' &&
    !served.req.generationDisplayProjection
  ) {
    finishGenerationDisplayProjection(regenerateDisplayProjection)
    regenerateDisplayProjection = undefined
  }

  args.stageTimings.stage1Duration =
    numberFrom(served.info?.timings?.prompt) ?? Date.now() - args.stageTimings.stage1Start

  if (args.preview || args.previewPrompt) {
    if (args.previewPrompt) {
      const promptText = served.prompt.promptInfo?.promptText
      return {
        status: 'preview',
        body: typeof promptText === 'string' ? promptText : JSON.stringify(Array.isArray(promptText) ? promptText : []),
      }
    }
    return {
      status: 'preview',
      formated: (served.prompt.formated as OpenAIChat[]) ?? [],
    }
  }

  const currentChat = applyServerMessagePatches({
    patches: served.messagePatches,
    selectedChar: args.selectedChar,
    selectedChat: args.selectedChat,
    targetCharacterId: args.currentChar.chaId,
    targetChatId: args.currentChat.id,
    currentChat: args.currentChat,
  })

  const promptText = served.prompt.promptInfo?.promptText
  if (Array.isArray(promptText)) {
    args.promptInfo.promptText = promptText as OpenAIChat[]
  }

  const dispatch =
    wantsServerDispatch && isServerChatGenerationOk(served)
      ? {
          req: served.req,
          generationId: served.generationId,
          generationInfo: served.generationInfo,
          terminal: served.terminal,
          ...(restorationGuard ? { restorationGuard } : {}),
        }
      : undefined

  return {
    status: 'assembled',
    currentChat,
    // Provider dispatch is server-owned on this branch. New servers omit the
    // potentially large prompt rows; retain the empty fallback for older call
    // sites whose common result type still includes `formated`.
    formated: served.prompt.formated ?? [],
    biases: served.prompt.biases ?? [],
    inputTokens: numberFrom(served.info?.tokens?.prompt) ?? numberFrom(served.prompt.promptInfo?.inputTokens) ?? 0,
    outputTokens:
      numberFrom(served.info?.responseBudget) ??
      numberFrom(served.prompt.promptInfo?.outputTokens) ??
      olderServerResponseBudgetFallback(),
    ...(dispatch ? { dispatch } : {}),
  }
}

/**
 * Re-attach to a live durable generation instead of starting a fresh send. The
 * server replays buffered `prompt` / `info` / `token` frames over
 * `GET /generate/chat/:jobId/stream`, so the coordinator can drive the same
 * orchestrate -> terminal -> stage4 flow. There is no client-side assembly; the
 * running job already owns the prompt. Typed failure metadata lets the
 * reattach owner decide whether the consumed job may be retried.
 */
export async function reattachServerBackedSendChat(args: {
  selectedChar: number
  selectedChat: number
  currentChar: character
  currentChat: Chat
  promptInfo: MessagePresetInfo
  stageTimings: ServerBackedStageTimings
  abortSignal: AbortSignal
  setProcessStage: (stage: number) => void
  jobId: string
  /** Protocol-v1 attach uses the operation-addressed URL returned by submit/status. */
  operationStream?: ServerChatOperationStream
  /** The running job's generating mode, so the reattach renders correctly. */
  continue?: boolean
  regenerateMessageId?: string
}): Promise<ServerBackedAssemblyResult> {
  const sourceGeneration = captureClientSessionGeneration()
  const restorationGuard = captureServerBackedRestorationGuard(args.currentChat.id)
  args.setProcessStage(1)
  args.stageTimings.stage1Start = Date.now()
  // The reattach stream is keyed by jobId (the body mode is not what selects the
  // buffered frames), but carrying the real mode keeps `input.mode` honest and lets
  // the caller render continue/regenerate on the right row.
  const mode: ServerChatInput['mode'] =
    typeof args.regenerateMessageId === 'string' ? 'regenerate' : args.continue ? 'continue' : 'send'
  const input: ServerChatInput = {
    chatId: args.currentChat.id ?? '',
    characterId: args.currentChar.chaId,
    mode,
  }
  if (mode === 'regenerate') input.regenerateMessageId = args.regenerateMessageId
  const regenerateDisplayProjection =
    mode === 'regenerate' && args.operationStream && args.regenerateMessageId
      ? {
          operationId: args.operationStream.operationId,
          attemptNo: args.operationStream.attemptNo,
          characterId: args.currentChar.chaId,
          chatId: args.currentChat.id ?? '',
          mode: 'regenerate' as const,
          targetMessageId: args.regenerateMessageId,
          projectionEpoch: args.operationStream.projectionEpoch,
        }
      : undefined
  if (regenerateDisplayProjection) beginGenerationDisplayProjection(regenerateDisplayProjection)
  const served = await requestServerChatGeneration(
    input,
    args.abortSignal,
    args.operationStream ? undefined : args.jobId,
    args.operationStream,
  )

  if (!isClientWriteOperationCurrent(sourceGeneration)) return { status: 'aborted' }
  if (served.status === 'aborted') {
    if (regenerateDisplayProjection) finishGenerationDisplayProjection(regenerateDisplayProjection)
    return { status: 'aborted' }
  }
  if (served.status === 'error') {
    if (regenerateDisplayProjection) finishGenerationDisplayProjection(regenerateDisplayProjection)
    const currentChat = applyServerMessagePatches({
      patches: served.messagePatches ?? [],
      selectedChar: args.selectedChar,
      selectedChat: args.selectedChat,
      targetCharacterId: args.currentChar.chaId,
      targetChatId: args.currentChat.id,
      currentChat: args.currentChat,
    })
    const failure = sendChatFailureFromServerCode(served.code)
    return {
      status: 'failed',
      error: served.error,
      currentChat,
      ...(failure ? { failure } : {}),
      ...(served.reattachOutcome ? { reattachOutcome: served.reattachOutcome } : {}),
    }
  }
  if (
    regenerateDisplayProjection &&
    isServerChatGenerationOk(served) &&
    served.req.type === 'streaming' &&
    !served.req.generationDisplayProjection
  ) {
    finishGenerationDisplayProjection(regenerateDisplayProjection)
  }

  args.stageTimings.stage1Duration =
    numberFrom(served.info?.timings?.prompt) ?? Date.now() - args.stageTimings.stage1Start

  const currentChat = applyServerMessagePatches({
    patches: served.messagePatches,
    selectedChar: args.selectedChar,
    selectedChat: args.selectedChat,
    targetCharacterId: args.currentChar.chaId,
    targetChatId: args.currentChat.id,
    currentChat: args.currentChat,
  })

  const promptText = served.prompt.promptInfo?.promptText
  if (Array.isArray(promptText)) {
    args.promptInfo.promptText = promptText as OpenAIChat[]
  }

  const dispatch = isServerChatGenerationOk(served)
    ? {
        req: served.req,
        generationId: served.generationId,
        generationInfo: served.generationInfo,
        terminal: served.terminal,
        ...(restorationGuard ? { restorationGuard } : {}),
      }
    : undefined

  return {
    status: 'assembled',
    currentChat,
    formated: served.prompt.formated ?? [],
    biases: served.prompt.biases ?? [],
    inputTokens: numberFrom(served.info?.tokens?.prompt) ?? numberFrom(served.prompt.promptInfo?.inputTokens) ?? 0,
    outputTokens:
      numberFrom(served.info?.responseBudget) ??
      numberFrom(served.prompt.promptInfo?.outputTokens) ??
      olderServerResponseBudgetFallback(),
    ...(dispatch ? { dispatch } : {}),
  }
}

export async function applyServerBackedTerminal(args: {
  terminal: ServerChatTerminal
  currentChar: character
  currentChat: Chat
  selectedChar: number
  selectedChat: number
  targetCharacterId?: string
  targetChatId?: string
  generationInfo: MessageGenerationInfo
  /** Continue/regenerate target message id, so the post-gen final text + inlay land
   * on the right row when it is not keyed by `generationId` (the continue case). */
  targetMessageId?: string
  restorationGuard?: ServerBackedRestorationGuard
  streamProjection?: StreamMessageProjection
}): Promise<ServerBackedTerminalResult> {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  const superseded = (): ServerBackedTerminalResult => ({
    status: 'cancelled',
    currentChat: args.currentChat,
    resendChat: false,
    reattachOutcome: 'observer_superseded',
  })
  if (!isCurrent()) return superseded()
  const displayProjection = args.streamProjection?.displayProjection
  const observeDisplayProjectionAuthority = async (messageId?: string): Promise<boolean> => {
    if (!displayProjection) return false
    const generationId = messageId ?? args.generationInfo.generationId ?? displayProjection.generationId
    updateGenerationDisplayProjection(displayProjection, {
      status: 'finalizing',
      ...(generationId ? { generationId } : {}),
    })
    if (!displayProjection.chatId || !generationId) return false
    await hydrateChatMessages(displayProjection.chatId, { force: true, strict: true }).catch(() => {})
    if (!isCurrent()) return false
    const resolution = resolveServerBackedLiveChat({
      selectedChar: args.selectedChar,
      selectedChat: args.selectedChat,
      characterId: displayProjection.characterId,
      chatId: displayProjection.chatId,
    })
    return !!resolution?.chat.message.some(
      (message) =>
        message.role === 'char' &&
        (message.chatId === generationId || message.generationInfo?.generationId === generationId),
    )
  }
  const terminalInfo = args.terminal.done?.generationInfo
  if (terminalInfo && typeof terminalInfo === 'object') {
    Object.assign(args.generationInfo, terminalInfo)
  }
  const contextTarget = { characterId: args.targetCharacterId, chatId: args.targetChatId }
  if (args.terminal.status === 'error') {
    const target = targetFromPayloadOrContext(
      args.terminal.restoration ?? args.terminal.generationProjection,
      contextTarget,
    )
    const restorationIsFresh =
      !args.restorationGuard ||
      (target.chatId === args.restorationGuard.chatId && isServerBackedRestorationGuardFresh(args.restorationGuard))
    const retainedPartial =
      typeof args.terminal.done?.postGeneration?.finalText === 'string' &&
      args.terminal.persistenceDisposition !== 'rejected' &&
      args.terminal.persistenceDisposition !== 'unconfirmed'
    const displayAuthorityObserved = retainedPartial
      ? await observeDisplayProjectionAuthority(args.terminal.done?.postGeneration?.messageId)
      : false
    if (!isCurrent()) return superseded()
    if (retainedPartial) {
      applyInterruptedTerminalSnapshot({
        selectedChar: args.selectedChar,
        selectedChat: args.selectedChat,
        target,
        generationId: args.generationInfo.generationId ?? '',
        generationInfo: args.generationInfo,
        postGeneration: args.terminal.done?.postGeneration,
        streamProjection: args.streamProjection,
      })
    } else if (args.terminal.restoration && restorationIsFresh) {
      const resolution = resolveServerBackedLiveChat({
        selectedChar: args.selectedChar,
        selectedChat: args.selectedChat,
        characterId: target.characterId,
        chatId: target.chatId,
      })
      if (resolution) applyServerChatRestoration(resolution.chat, args.terminal.restoration!)
    }
    if (displayProjection && (!retainedPartial || displayAuthorityObserved)) {
      finishGenerationDisplayProjection(displayProjection)
    }
    if (args.terminal.persistenceDisposition === 'rejected' || args.terminal.persistenceDisposition === 'unconfirmed') {
      const generationId =
        args.terminal.generationProjection?.generationId ??
        args.streamProjection?.generationId ??
        args.generationInfo.generationId
      if (target.chatId && generationId) clearGenerationPersistence(target.chatId, generationId)
      await reconcileRejectedGenerationProjection({
        selectedChar: args.selectedChar,
        selectedChat: args.selectedChat,
        target,
        streamProjection: args.streamProjection,
      })
    } else if (args.terminal.persistenceDisposition === 'queued') {
      const generationId =
        args.terminal.generationProjection?.generationId ??
        args.streamProjection?.generationId ??
        args.generationInfo.generationId
      const messageId =
        args.streamProjection?.messageId ??
        args.terminal.generationProjection?.targetMessageId ??
        args.targetMessageId ??
        generationId
      if (target.chatId && generationId && messageId) {
        markGenerationPersistenceQueued({ chatId: target.chatId, messageId, generationId })
      }
    }
    return {
      status: 'failed',
      error: args.terminal.error ?? 'Server returned an error without details during generation.',
      currentChat: resolveServerBackedCurrentChat({
        selectedChar: args.selectedChar,
        selectedChat: args.selectedChat,
        characterId: target.characterId,
        chatId: target.chatId,
        currentChat: args.currentChat,
      }),
      resendChat: false,
      ...(args.terminal.reattachOutcome ? { reattachOutcome: args.terminal.reattachOutcome } : {}),
    }
  }

  if (args.terminal.status === 'cancelled') {
    const postGeneration = args.terminal.done?.postGeneration
    const retainedPartial = typeof postGeneration?.finalText === 'string'
    const displayAuthorityObserved = retainedPartial
      ? await observeDisplayProjectionAuthority(postGeneration?.messageId)
      : false
    if (!isCurrent()) return superseded()
    const target = targetFromPayloadOrContext(postGeneration?.messagePatch, contextTarget)
    const generationId = args.generationInfo.generationId ?? ''
    applyInterruptedTerminalSnapshot({
      selectedChar: args.selectedChar,
      selectedChat: args.selectedChat,
      target,
      generationId,
      generationInfo: args.generationInfo,
      postGeneration,
      streamProjection: args.streamProjection,
    })
    if (displayProjection && (!retainedPartial || displayAuthorityObserved)) {
      finishGenerationDisplayProjection(displayProjection)
    }
    if (target.chatId && generationId) clearGenerationPersistence(target.chatId, generationId)
    return {
      status: 'cancelled',
      currentChat: resolveServerBackedCurrentChat({
        selectedChar: args.selectedChar,
        selectedChat: args.selectedChat,
        characterId: target.characterId,
        chatId: target.chatId,
        currentChat: args.currentChat,
      }),
      resendChat: false,
      ...(args.terminal.reattachOutcome ? { reattachOutcome: args.terminal.reattachOutcome } : {}),
    }
  }

  const pendingTtsTexts: string[] = []
  for (const sideEffect of args.terminal.sideEffects ?? []) {
    switch (sideEffect.kind) {
      case 'tts': {
        const payload = sideEffect.payload
        if (!payload || typeof payload !== 'object') break
        const text = (payload as { text?: unknown }).text
        if (typeof text === 'string' && text.length > 0) {
          pendingTtsTexts.push(text)
        }
        break
      }
      case 'hypav3_progress':
        // Memory job progress is projected from identified memory events and
        // authoritative snapshots. A legacy display-only side effect cannot
        // safely mutate that projection.
        break
      default:
        break
    }
  }

  // Apply the server-owned post-generation derivation. The browser skipped
  // `editoutput` and `applyOutputTrigger` on this path, so here it applies the
  // post-gen patch, renders the inlay screen over the server-owned final text, and
  // reports any resend request back to the coordinator.
  const postGen = args.terminal.done?.postGeneration
  const effectLedger = postGen?.effectLedger
  const resendChat = !!postGen?.resendChat
  const generationId = args.generationInfo.generationId ?? ''
  const terminalTarget = targetFromPayloadOrContext(postGen?.messagePatch, contextTarget)
  const displayAuthorityObserved = await observeDisplayProjectionAuthority(postGen?.messageId ?? generationId)
  if (!isCurrent()) return superseded()
  const terminalProjectionIsFresh = (() => {
    const guard = args.restorationGuard
    if (
      guard &&
      (terminalTarget.chatId !== guard.chatId ||
        captureChatMessageMutationIntentEpoch(guard.chatId) !== guard.mutationIntentEpoch)
    ) {
      return false
    }
    const postGenerationRevision = postGen?.revision
    if (
      typeof postGenerationRevision === 'number' &&
      Number.isInteger(postGenerationRevision) &&
      terminalTarget.chatId &&
      hasNewerChatBodyResourceRevision(terminalTarget.chatId, postGenerationRevision)
    ) {
      return false
    }
    const projection = args.streamProjection
    if (!projection) return true
    if (projection.detached || (projection.chatId && projection.chatId !== terminalTarget.chatId)) return false
    const resolution = resolveServerBackedLiveChat({
      selectedChar: args.selectedChar,
      selectedChat: args.selectedChat,
      characterId: terminalTarget.characterId,
      chatId: terminalTarget.chatId,
    })
    const messageId = projection.messageId ?? projection.generationId
    const assistant = resolution?.chat.message.find(
      (message) =>
        message.role === 'char' &&
        (message.chatId === messageId || message.generationInfo?.generationId === projection.generationId),
    )
    return assistant?.data === projection.ownedData
  })()
  if (terminalTarget.chatId && generationId) clearGenerationPersistence(terminalTarget.chatId, generationId)
  type InlayFinalizationState = {
    messageId: string
    expectedServerData: string
    expectedProjectionData: string
    mutationIntentEpoch: number
    projectionEpoch: number
  }
  let immediateInlay: InlayFinalizationState | undefined
  let pendingInlay: (InlayFinalizationState & { promise: Promise<string> }) | undefined
  let processedPrimaryTtsText: string | undefined
  if (terminalProjectionIsFresh) {
    const resolution = resolveServerBackedLiveChat({
      selectedChar: args.selectedChar,
      selectedChat: args.selectedChat,
      characterId: terminalTarget.characterId,
      chatId: terminalTarget.chatId,
    })
    if (resolution) {
      const liveChat = resolution.chat
      if (postGen?.messagePatch) {
        applyServerMessagePatch(liveChat, postGen.messagePatch, resolution.character)
      }
      const assistant =
        findGeneratedAssistantMessage(liveChat, generationId) ??
        (args.targetMessageId
          ? liveChat.message.find((message) => message.chatId === args.targetMessageId && message.role === 'char')
          : undefined)
      if (assistant) {
        if (
          postGen?.translation?.status === 'succeeded' &&
          postGen.messageId &&
          assistant.chatId === postGen.messageId
        ) {
          const translation = { ...postGen.translation.translation }
          if (JSON.stringify(assistant.translation) !== JSON.stringify(translation)) assistant.translation = translation
        }
        const baseText = typeof postGen?.finalText === 'string' ? postGen.finalText : assistant.data
        const inlay = runInlayScreen(resolution.character, baseText)
        if (assistant.data !== inlay.text) assistant.data = inlay.text
        if (pendingTtsTexts[0] === baseText) {
          processedPrimaryTtsText = inlay.text
        }
        const messageId = assistant.chatId ?? args.targetMessageId ?? generationId
        if (inlay.text !== baseText && messageId && generationId) {
          const finalization = {
            messageId,
            expectedServerData: baseText,
            expectedProjectionData: inlay.text,
            mutationIntentEpoch: captureChatMessageMutationIntentEpoch(terminalTarget.chatId),
            projectionEpoch: captureChatBodyProjectionEpoch(terminalTarget.chatId),
          }
          if (inlay.promise) {
            pendingInlay = { ...finalization, promise: inlay.promise }
          } else {
            immediateInlay = finalization
          }
        }
      }
    }
  }

  // A fresh terminal patch is already durable on the server. Mirror it before
  // waiting on best-effort client TTS; stale terminal projections are left to
  // the newer local/server authority selected above.
  await runLedgeredGenerationEffect(effectLedger, 'tts', 'live_terminal', async (effectContext) => {
    if (!isCurrent() || !effectContext.isCurrent()) return skippedGenerationEffect('writer_session_changed')
    if (pendingTtsTexts.length === 0) return skippedGenerationEffect('not_requested')
    for (let index = 0; index < pendingTtsTexts.length; index++) {
      if (!isCurrent() || !effectContext.isCurrent()) return skippedGenerationEffect('writer_session_changed')
      const text = pendingTtsTexts[index]
      // The server payload is post-editoutput; inlay remains browser-owned. Reuse
      // the primary display pass when possible, then process each alternate in
      // provider choice order before speaking it (baseline buffered semantics).
      const processedText =
        index === 0 && processedPrimaryTtsText !== undefined
          ? processedPrimaryTtsText
          : runInlayScreen(args.currentChar, text).text
      await sayTTS(args.currentChar, processedText)
    }
    return completedGenerationEffect(undefined)
  })

  if (!isCurrent()) return superseded()
  const settleInlayProjection = (finalization: InlayFinalizationState, finalData: string, persisted: boolean): void => {
    if (!isCurrent()) return
    if (captureChatMessageMutationIntentEpoch(terminalTarget.chatId) !== finalization.mutationIntentEpoch) return
    const resolution = resolveServerBackedLiveChat({
      selectedChar: args.selectedChar,
      selectedChat: args.selectedChat,
      characterId: terminalTarget.characterId,
      chatId: terminalTarget.chatId,
    })
    const assistant = resolution?.chat.message.find(
      (message) => message.chatId === finalization.messageId && message.role === 'char',
    )
    if (!assistant) return
    if (assistant.data !== finalization.expectedProjectionData && assistant.data !== finalData) return
    assistant.data = persisted ? finalData : finalization.expectedServerData
  }

  if (immediateInlay) {
    const persisted = await finalizeServerBackedInlayMessage({
      chatId: terminalTarget.chatId,
      messageId: immediateInlay.messageId,
      generationId,
      expectedData: immediateInlay.expectedServerData,
      finalData: immediateInlay.expectedProjectionData,
    })
    settleInlayProjection(immediateInlay, immediateInlay.expectedProjectionData, persisted)
  }

  if (pendingInlay) {
    let resolved = ''
    let promiseFailed = false
    try {
      resolved = await pendingInlay.promise
    } catch {
      settleInlayProjection(pendingInlay, pendingInlay.expectedServerData, false)
      promiseFailed = true
    }
    if (!isCurrent()) return superseded()
    let canFinalize = !promiseFailed
    if (
      captureChatMessageMutationIntentEpoch(terminalTarget.chatId) !== pendingInlay.mutationIntentEpoch ||
      hasChatBodyProjectionEpochChanged(terminalTarget.chatId, pendingInlay.projectionEpoch)
    ) {
      canFinalize = false
    } else {
      const resolution = resolveServerBackedLiveChat({
        selectedChar: args.selectedChar,
        selectedChat: args.selectedChat,
        characterId: terminalTarget.characterId,
        chatId: terminalTarget.chatId,
      })
      const liveChat = resolution?.chat
      const assistant = liveChat
        ? liveChat.message.find((message) => message.chatId === pendingInlay.messageId && message.role === 'char')
        : undefined
      if (!assistant || assistant.data !== pendingInlay!.expectedProjectionData) canFinalize = false
    }
    if (canFinalize) {
      const persisted = await finalizeServerBackedInlayMessage({
        chatId: terminalTarget.chatId,
        messageId: pendingInlay.messageId,
        generationId,
        expectedData: pendingInlay.expectedServerData,
        finalData: resolved,
      })
      settleInlayProjection(pendingInlay, resolved, persisted)
    }
  }

  if (!isCurrent()) return superseded()
  const providerAlternates = args.terminal.done?.alternates
  if (terminalProjectionIsFresh && Array.isArray(providerAlternates) && providerAlternates.length > 0) {
    const resolution = resolveServerBackedLiveChat({
      selectedChar: args.selectedChar,
      selectedChat: args.selectedChat,
      characterId: terminalTarget.characterId,
      chatId: terminalTarget.chatId,
    })
    const liveChat = resolution?.chat
    if (liveChat && resolution) {
      const assistant =
        findGeneratedAssistantMessage(liveChat, generationId) ??
        (args.targetMessageId
          ? liveChat.message.find((message) => message.chatId === args.targetMessageId && message.role === 'char')
          : undefined)
      if (assistant) {
        const alternates = buildServerBackedAlternateMessages(assistant, providerAlternates, generationId)
        if (alternates.length > 0) {
          seedRerollBufferFromAlternates(
            liveChat.message,
            // Match persisted alternate-row ordering (newest-added first), including
            // the active primary candidate so it remains swipe index zero.
            [...alternates.reverse(), assistant],
            {
              selectedCharID: characterRowsForGeneration().indexOf(resolution.character),
              chatPage: resolution.character.chats.indexOf(liveChat),
              characterId: resolution.character.chaId,
              chatId: liveChat.id,
            },
          )
        }
      }
    }
  }

  const finalResolution = resolveServerBackedLiveChat({
    selectedChar: args.selectedChar,
    selectedChat: args.selectedChat,
    characterId: terminalTarget.characterId,
    chatId: terminalTarget.chatId,
  })
  const finalChat = finalResolution?.chat ?? args.currentChat
  const finalAssistant =
    findGeneratedAssistantMessage(finalChat, generationId) ??
    (args.targetMessageId
      ? finalChat.message.find((message) => message.chatId === args.targetMessageId && message.role === 'char')
      : undefined)

  if (chatOutputListeners.size > 0) await yieldBeforeCompletionEffect()
  if (!isCurrent()) return superseded()
  await runLedgeredGenerationEffect(effectLedger, 'plugin_output', 'live_terminal', async (effectContext) => {
    if (!isCurrent() || !effectContext.isCurrent()) return skippedGenerationEffect('writer_session_changed')
    if (!finalResolution || chatOutputListeners.size === 0) return skippedGenerationEffect('not_configured')
    const characters = characterRowsForGeneration()
    await runChatOutputListeners(
      {
        char: finalResolution.character,
        chat: finalChat,
        characterIndex: characters.indexOf(finalResolution.character),
        chatIndex: finalResolution.character.chats.indexOf(finalChat),
        messageIndex: finalAssistant ? finalChat.message.indexOf(finalAssistant) : -1,
        effectIdempotencyKey: effectContext.idempotencyKey,
      },
      effectContext,
    )
    return completedGenerationEffect(undefined)
  })

  if (!isCurrent()) return superseded()
  if (postGen?.agentPresetError) {
    if (displayProjection && displayAuthorityObserved) finishGenerationDisplayProjection(displayProjection)
    return {
      status: 'failed',
      error: postGen.agentPresetError.message,
      currentChat: resolveServerBackedCurrentChat({
        selectedChar: args.selectedChar,
        selectedChat: args.selectedChat,
        characterId: terminalTarget.characterId,
        chatId: terminalTarget.chatId,
        currentChat: args.currentChat,
      }),
      resendChat: false,
    }
  }

  const finalMessageId = finalAssistant?.chatId ?? args.targetMessageId
  const igpTarget =
    finalResolution &&
    finalAssistant &&
    nonEmptyTargetId(finalResolution.character.chaId) &&
    nonEmptyTargetId(finalResolution.chat.id) &&
    nonEmptyTargetId(finalMessageId)
      ? {
          characterId: finalResolution.character.chaId,
          chatId: finalResolution.chat.id,
          messageId: finalMessageId,
          expectedData: finalAssistant?.data ?? '',
          ...(finalAssistant?.generationInfo?.generationId === generationId
            ? { expectedGenerationId: generationId }
            : {}),
        }
      : undefined

  if (displayProjection && displayAuthorityObserved) finishGenerationDisplayProjection(displayProjection)
  return {
    status: 'ok',
    currentChat: finalChat,
    resendChat,
    ...(igpTarget ? { igpTarget } : {}),
    ...(effectLedger ? { effectLedger } : {}),
  }
}
