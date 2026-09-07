import { captureClientSessionGeneration } from '../clientSession'
import { isClientWriteOperationCurrent } from '../clientWriteOperation'
import { get, writable } from 'svelte/store'
import { isServerCharacterShell, type character, type MessageGenerationInfo } from '../storage/database.svelte'
import { settingsResourceState } from '../server/resourceState.svelte'
import { reportSendChatError } from './sendChatErrors'
import { setupSendChatContext } from './sendChatContext'
import { orchestrateResponse } from './postGeneration/orchestrateResponse'
import { evaluateIgp } from './postGeneration/igp'
import { runStage4 } from './postGeneration/runStage4'
import { dispatchRequest } from './dispatch/dispatchRequest'
import type { DispatchSuccessReq } from './dispatch/dispatchRequest'
import { resolveServerPromptAssembly } from './request/serverPromptAssembly'
import { resolveDurableGeneration } from './request/durableGeneration'
import {
  applyServerBackedTerminal,
  assembleServerBackedSendChat,
  reattachServerBackedSendChat,
  type ServerBackedDispatch,
} from './serverBackedSendChat'
import {
  assembleLocalSendChatPrompt,
  createSendChatCharacterCache,
  runSendChatMessageVariables,
} from './sendChatPromptAssembly'
import {
  guardActiveChatGenerationSettingsForSend,
  resolveActiveChatGenerationSettings,
} from '../activeChatGenerationSettings'
import { alertError } from '../alert'
import {
  captureActiveChatTarget,
  isActiveChatTargetFresh,
  waitForPendingChatGenerationSettingsSave,
  type ActiveChatTarget,
} from '../chatCommands'
import { flushPendingSelectedPersonaUpdate } from '../persona'
import { language } from '../../lang'
import {
  activeChatGenerations,
  beginChatGenerationActivity,
  findChatGenerationActivity,
  finishChatGenerationActivity,
  updateChatGenerationActivityMetadata,
  updateChatGenerationActivityPhase,
  updateChatGenerationActivityStage,
  type ChatGenerationActivity,
} from './generationActivity.svelte'
import { playMessageCompletionSoundIfEnabled } from './messageCompletionSound'
import type { SendChatFailure } from './sendChatFailure'
import type { GenerationReattachOutcome } from './generationReattachOutcome'
import type { ServerChatOperationStream } from './request/serverChat'
import { abortChat } from './generationStop.svelte'
export { abortActiveGeneration, abortChat } from './generationStop.svelte'
import {
  stablePostGenerationChatTarget,
  stablePostGenerationMessageTarget,
  type StablePostGenerationChatTarget,
} from './postGeneration/stableTarget'
import {
  completedGenerationEffect,
  runLedgeredGenerationEffect,
  skippedGenerationEffect,
} from './generationEffectLedger'
import type { ServerGenerationEffectLedgerRef } from '@risuai/protocol/generation-sse'
import { isChatVisible, markChatUnread } from './chatUnread.svelte'
import { registerGenerationProcessRuntime } from './generationRuntimeBridge'
import { hydrateCharacterShell } from '../server/characterShellHydration.svelte'

export interface OpenAIChat {
  role: 'system' | 'user' | 'assistant' | 'function'
  content: string
  memo?: string
  name?: string
  removable?: boolean
  attr?: string[]
  multimodals?: MultiModal[]
  thoughts?: string[]
  cachePoint?: boolean
}

export interface MultiModal {
  type: 'image' | 'video' | 'audio' | 'signature'
  base64: string
  height?: number
  width?: number
}

export interface requestTokenPart {
  name: string
  tokens: number
}

/** Aggregate compatibility projection. Chat-owned gates must use `activeChatGenerations`. */
export const doingChat = writable(false)
export const activeGenerationTarget = writable<ActiveChatTarget | null>(null)
export const chatProcessStage = writable(0)
export let requestTokenParts: { [key: string]: requestTokenPart[] } = {}
export let previewFormated: OpenAIChat[] = []
export let previewBody: string = ''

const generationControllerBySignal = new WeakMap<AbortSignal, AbortController>()
const MAX_SERVER_RESEND_DEPTH = 1
const SERVER_RESEND_CAP_ERROR = 'Server-requested resend limit reached. Stopping to avoid a repeated generation loop.'
const CHAT_GENERATION_SETTINGS_SAVE_ERROR =
  'Chat generation settings could not be saved before generation. Please retry.'
const SELECTED_PERSONA_SAVE_ERROR = 'Persona settings could not be saved before generation. Please retry.'

export interface SendChatArgs {
  chatAdditonalTokens?: number
  signal?: AbortSignal
  continue?: boolean
  preview?: boolean
  previewPrompt?: boolean
  regenerateMessageId?: string
  /** True only for the UI-created `*says nothing*` empty-send sentinel. */
  syntheticSayNothing?: boolean
  expectedTarget?: ActiveChatTarget | null
  /** Receives classified start failures without changing the legacy boolean result. */
  onFailure?: (failure: SendChatFailure) => void
  /** Internal typed result channel for a durable-job reattach. */
  onReattachOutcome?: (outcome: GenerationReattachOutcome) => void
  /** Internal circuit-breaker depth for server-owned postGeneration resends. */
  serverResendDepth?: number
  /**
   * Re-attach to this live durable generation (server job id) instead of
   * starting a fresh send. Skips assembly + the provider POST; the server
   * replays the in-flight stream.
   */
  reattachJobId?: string
  /** Attach the just-accepted protocol-v1 operation without issuing a legacy generation POST. */
  generationOperationStream?: ServerChatOperationStream
}

function chatGenerationSettingsSaveError(
  result: NonNullable<Awaited<ReturnType<typeof waitForPendingChatGenerationSettingsSave>>>,
): string {
  if (result.status === 'error') return result.error
  if (result.status === 'conflict') return CHAT_GENERATION_SETTINGS_SAVE_ERROR
  return CHAT_GENERATION_SETTINGS_SAVE_ERROR
}

function selectedPersonaSaveError(
  result: NonNullable<Awaited<ReturnType<typeof flushPendingSelectedPersonaUpdate>>>,
): string {
  if (result.status === 'error') return result.error
  if (result.status === 'conflict') return SELECTED_PERSONA_SAVE_ERROR
  return SELECTED_PERSONA_SAVE_ERROR
}

export function createActiveGenerationAbortController(): AbortController {
  const controller = new AbortController()
  generationControllerBySignal.set(controller.signal, controller)
  abortChat.set(false)
  return controller
}

export function clearActiveGenerationAbortController(controller: AbortController): void {
  generationControllerBySignal.delete(controller.signal)
}

function refreshLegacyGenerationProjection(): void {
  const activities = get(activeChatGenerations)
  const latest = activities.at(-1)
  doingChat.set(activities.length > 0)
  activeGenerationTarget.set(latest?.target ?? null)
  // Preserve the completed stage when the final activity leaves, matching the
  // legacy store contract. A new send resets it to zero on entry.
  if (latest) chatProcessStage.set(latest.stage)
}

export async function sendChat(chatProcessIndex = -1, arg: SendChatArgs = {}): Promise<boolean> {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (!isCurrent()) return false
  chatProcessStage.set(0)
  const abortSignal = arg.signal ?? new AbortController().signal
  const attachesDurableGeneration = !!arg.reattachJobId || !!arg.generationOperationStream

  // NOTE: `throwError()` can be called before these are populated (e.g. HypaV3 early validation errors).
  // Keep them declared up-front to avoid TDZ ReferenceErrors in production builds.
  let selectedChar = -1
  let selectedChat = -1
  let currentChar: character
  let generationInfo: MessageGenerationInfo | undefined = undefined
  let reattachOutcome: GenerationReattachOutcome | undefined
  let errorTarget: StablePostGenerationChatTarget | null = null
  let errorTargetMessageId: string | undefined

  const isObserverFailure = (status: GenerationReattachOutcome['status'] | undefined): boolean =>
    status === 'retryable_transport_failure' ||
    status === 'missing_job' ||
    status === 'authority_reconciliation_required' ||
    status === 'observer_superseded'

  const stageTimings = {
    stage1Start: 0,
    stage2Start: 0,
    stage3Start: 0,
    stage4Start: 0,
    stage1Duration: 0,
    stage2Duration: 0,
    stage3Duration: 0,
    stage4Duration: 0,
  }

  const findCharacterbyIdwithCache = createSendChatCharacterCache()
  const runCurrentChatFunction = (chat: Parameters<typeof runSendChatMessageVariables>[0]) =>
    runSendChatMessageVariables(chat, currentChar)

  function reformatContent(data: string) {
    if (chatProcessIndex === -1) {
      return data.trim()
    }
    return data.trim()
  }

  function throwError(error: string) {
    if (!isCurrent()) return
    reportSendChatError(error, {
      target: errorTarget,
      ...(errorTargetMessageId ? { messageId: errorTargetMessageId } : {}),
      generationInfo,
    })
  }

  const generationTarget = arg.expectedTarget === undefined ? captureActiveChatTarget() : arg.expectedTarget
  if (!generationTarget) return false
  let generationSettingsState = resolveActiveChatGenerationSettings({ target: generationTarget })
  if (generationSettingsState.character && isServerCharacterShell(generationSettingsState.character)) {
    const characterId = generationSettingsState.character.chaId
    if (!characterId || !(await hydrateCharacterShell(characterId))) return false
    if (!isCurrent() || !isActiveChatTargetFresh(generationTarget)) return false
    generationSettingsState = resolveActiveChatGenerationSettings({ target: generationTarget })
  }
  if (!generationSettingsState.character || !generationSettingsState.chat) return false
  errorTarget = stablePostGenerationChatTarget(generationTarget.characterId, generationTarget.chatId)
  errorTargetMessageId =
    arg.regenerateMessageId ?? (arg.continue ? generationSettingsState.chat.message.at(-1)?.chatId : undefined)

  const existingActivity = findChatGenerationActivity(generationTarget)
  // Tests and compatibility callers can still drive the legacy store directly.
  // In the live app, a non-empty activity registry is the source of truth and
  // permits a different chat to start concurrently.
  const legacyOnlyDoing = get(doingChat) && get(activeChatGenerations).length === 0
  const isDoing = existingActivity !== undefined || legacyOnlyDoing

  if (isDoing) {
    if (chatProcessIndex === -1) {
      return false
    }
  }

  if (!attachesDurableGeneration) {
    const generationSettingsGuard = guardActiveChatGenerationSettingsForSend(generationSettingsState)
    if (generationSettingsGuard.status === 'error') {
      alertError(generationSettingsGuard.error)
      return false
    }
  }

  // This call owns only its chat-keyed activity. Re-entrant compatibility calls
  // do not add one; a stage-4 resend explicitly hands the activity off to the
  // recursive call before the outer `finally` runs.
  let ownsGenerationActivity = false
  let generationActivity: ChatGenerationActivity | undefined = existingActivity
  if (!isDoing && generationTarget) {
    generationActivity =
      beginChatGenerationActivity({
        target: generationTarget,
        kind: arg.preview || arg.previewPrompt ? 'preview' : 'message',
        controller: generationControllerBySignal.get(abortSignal),
        operationId: arg.generationOperationStream?.operationId,
        acceptedMessageId: arg.generationOperationStream?.acceptedMessageId,
        mode: arg.regenerateMessageId ? 'regenerate' : arg.continue ? 'continue' : 'send',
        targetMessageId: arg.regenerateMessageId,
        attemptNo: arg.generationOperationStream?.attemptNo,
        projectionEpoch: arg.generationOperationStream?.projectionEpoch,
      }) ?? undefined
    if (!generationActivity) return false
    refreshLegacyGenerationProjection()
    ownsGenerationActivity = true
  }

  try {
    const setProcessStage = (stage: number) => {
      if (!isCurrent()) return
      if (!generationActivity) {
        chatProcessStage.set(stage)
        return
      }
      updateChatGenerationActivityStage(generationActivity.id, stage)
      refreshLegacyGenerationProjection()
    }
    const setGenerationPhase = (phase: Parameters<typeof updateChatGenerationActivityPhase>[1]) => {
      if (!isCurrent()) return
      if (!generationActivity) return
      updateChatGenerationActivityPhase(generationActivity.id, phase)
    }
    const ctx = setupSendChatContext({
      database: generationSettingsState.db,
      chatProcessIndex,
      chatAdditonalTokens: arg.chatAdditonalTokens,
      writeMaintenance: !attachesDurableGeneration,
      target: generationTarget,
    })
    selectedChar = ctx.selectedChar
    selectedChat = ctx.selectedChat
    const nowChatroom = ctx.nowChatroom
    const promptInfo = ctx.promptInfo
    const tokenizer = ctx.tokenizer
    const maxContextTokens = ctx.maxContextTokens

    currentChar = nowChatroom
    let currentChat = nowChatroom.chats[selectedChat]

    if (!attachesDurableGeneration) {
      const contextPersistence = await ctx.persistence
      if (!isCurrent()) return false
      if (contextPersistence.status !== 'ok') {
        alertError(language.errors.sendContextPersistenceFailed)
        return false
      }
      const settingsSaveResult = await waitForPendingChatGenerationSettingsSave(currentChat.id)
      if (!isCurrent()) return false
      if (settingsSaveResult && settingsSaveResult.status !== 'ok') {
        throwError(chatGenerationSettingsSaveError(settingsSaveResult))
        return false
      }
      const personaSaveResult = await flushPendingSelectedPersonaUpdate()
      if (!isCurrent()) return false
      if (personaSaveResult && personaSaveResult.status !== 'ok') {
        throwError(selectedPersonaSaveError(personaSaveResult))
        return false
      }
      currentChat = nowChatroom.chats[selectedChat]
    }

    let formated: OpenAIChat[] = []
    let biases: [string, number][] = []
    let inputTokens = 0
    // Every dispatch path replaces this with the assembled server/profile
    // budget before it is consumed. Keep the initialization model-neutral.
    let outputTokens = 0
    let assembledByServer = false
    let serverDispatch: ServerBackedDispatch | undefined
    // When the send is durable-eligible, the server runs it as a detached job and
    // persists the result itself, so the browser drops its own generation-result
    // persist.
    let serverDurable = false

    // Server-side prompt assembly with browser-side patch replay. Send-like calls
    // consume the `/chat` provider stream; preview modes only read the assembled
    // prompt payload. In Fastify mode, supported text sends are server-mandatory
    // and out-of-subset sends hard-fail instead of silently falling through to
    // local assembly. The local branch remains for compatibility tests.
    if (attachesDurableGeneration) {
      // Re-attach to a live durable generation instead of assembling and
      // dispatching a fresh send. The job is server-persisted, so the browser only
      // renders the replayed stream.
      serverDurable = true
      const reattached = await reattachServerBackedSendChat({
        selectedChar,
        selectedChat,
        currentChar,
        currentChat,
        promptInfo,
        stageTimings,
        abortSignal,
        setProcessStage,
        jobId: arg.generationOperationStream?.jobId ?? arg.reattachJobId!,
        operationStream: arg.generationOperationStream,
        // Carry the running job's mode so the replayed stream renders on the
        // correct row; see `serverGenerationTargetMessageId`.
        continue: arg.continue,
        regenerateMessageId: arg.regenerateMessageId,
      })
      if (!isCurrent()) return false
      if (reattached.status === 'aborted') {
        reattachOutcome = { status: 'aborted' }
        return false
      }
      if (reattached.status === 'failed') {
        reattachOutcome = {
          status: reattached.reattachOutcome ?? 'terminal_failure',
          error: reattached.error,
        }
        // Job GC'd / already completed: the result is persisted, so the
        // projection refresh surfaces it. Nothing to render live.
        return false
      }
      if (reattached.status === 'assembled') {
        currentChat = reattached.currentChat
        formated = reattached.formated
        biases = reattached.biases
        inputTokens = reattached.inputTokens
        outputTokens = reattached.outputTokens
        assembledByServer = true
        serverDispatch = reattached.dispatch
        generationInfo = reattached.dispatch?.generationInfo
      }
    }

    const assemblyRoute = attachesDurableGeneration
      ? ({ type: 'local' } as const)
      : resolveServerPromptAssembly({
          database: generationSettingsState.db,
          currentChar,
          currentChat,
          preview: arg.preview,
          previewPrompt: arg.previewPrompt,
          continue: arg.continue,
          regenerateMessageId: arg.regenerateMessageId,
        })
    if (assemblyRoute.type === 'unsupported') {
      throwError(assemblyRoute.reason)
      return false
    }
    if (assemblyRoute.type === 'server') {
      // Durable server-assembled sends survive disconnect and are persisted
      // server-side. This can only be `durable` after prompt assembly routes to
      // the server.
      serverDurable =
        resolveDurableGeneration({
          database: generationSettingsState.db,
          currentChar,
          currentChat,
          preview: arg.preview,
          previewPrompt: arg.previewPrompt,
          continue: arg.continue,
          regenerateMessageId: arg.regenerateMessageId,
        }).type === 'durable'
      const serverAssembly = await assembleServerBackedSendChat({
        selectedChar,
        selectedChat,
        currentChar,
        currentChat,
        promptInfo,
        stageTimings,
        abortSignal,
        setProcessStage,
        preview: arg.preview,
        previewPrompt: arg.previewPrompt,
        continue: arg.continue,
        regenerateMessageId: arg.regenerateMessageId,
        syntheticSayNothing: arg.syntheticSayNothing,
        durable: serverDurable,
      })
      if (!isCurrent()) return false
      if (serverAssembly.status === 'aborted') {
        return false
      }
      if (serverAssembly.status === 'failed') {
        currentChat = serverAssembly.currentChat
        if (serverAssembly.failure) {
          try {
            arg.onFailure?.(serverAssembly.failure)
          } catch (error) {
            console.error(error)
          }
        }
        if (!isObserverFailure(serverAssembly.reattachOutcome)) throwError(serverAssembly.error)
        return false
      }
      if (serverAssembly.status === 'preview') {
        if (!isCurrent() || !isActiveChatTargetFresh(generationTarget)) return false
        if (serverAssembly.body !== undefined) previewBody = serverAssembly.body
        if (serverAssembly.formated !== undefined) previewFormated = serverAssembly.formated
        return true
      }
      if (serverAssembly.status === 'assembled') {
        currentChat = serverAssembly.currentChat
        formated = serverAssembly.formated
        biases = serverAssembly.biases
        inputTokens = serverAssembly.inputTokens
        outputTokens = serverAssembly.outputTokens
        assembledByServer = true
        serverDispatch = serverAssembly.dispatch
        generationInfo = serverAssembly.dispatch?.generationInfo
      }
    }
    // assemblyRoute.type === 'local' falls through to the local assembler below.

    if (!assembledByServer) {
      const localAssembly = await assembleLocalSendChatPrompt({
        database: generationSettingsState.db,
        currentChar,
        currentChat,
        nowChatroom,
        selectedChar,
        selectedChat,
        tokenizer,
        promptInfo,
        maxContextTokens,
        stageTimings,
        isContinue: !!arg.continue,
        findCharacterbyIdwithCache,
        throwError,
        setProcessStage,
      })
      if (!isCurrent()) return false
      if (localAssembly.status === 'stopped') {
        return false
      }
      currentChat = localAssembly.currentChat
      formated = localAssembly.formated
      biases = localAssembly.biases
      inputTokens = localAssembly.inputTokens
      outputTokens = localAssembly.outputTokens
    }

    let req: DispatchSuccessReq
    let generationId: string
    let serverTerminal: ServerBackedDispatch['terminal'] | undefined
    let effectLedger: ServerGenerationEffectLedgerRef | undefined
    const serverGenerationTargetCharacterId = serverDispatch ? currentChar.chaId : undefined
    const serverGenerationTargetChatId = serverDispatch ? currentChat.id : undefined
    const serverGenerationTargetMessageId =
      serverDispatch &&
      (arg.regenerateMessageId ||
        (arg.continue &&
          (serverDispatch.req.type !== 'streaming' || serverDispatch.req.continueDisposition !== 'append')))
        ? (arg.regenerateMessageId ?? currentChat.message.at(-1)?.chatId)
        : undefined
    if (serverDispatch) {
      setProcessStage(3)
      stageTimings.stage3Start = Date.now()
      req = serverDispatch.req
      generationId = serverDispatch.generationId
      generationInfo = serverDispatch.generationInfo
      serverTerminal = serverDispatch.terminal
      if (generationTarget && generationActivity) {
        updateChatGenerationActivityMetadata(generationTarget, {
          generationId,
          ...(serverDispatch.req.type === 'streaming' && serverDispatch.req.generationDisplayProjection
            ? {
                operationId: serverDispatch.req.generationDisplayProjection.operationId,
                mode: serverDispatch.req.generationDisplayProjection.mode,
                targetMessageId: serverDispatch.req.generationDisplayProjection.targetMessageId,
                attemptNo: serverDispatch.req.generationDisplayProjection.attemptNo,
                projectionEpoch: serverDispatch.req.generationDisplayProjection.projectionEpoch,
              }
            : {}),
        })
      }
      // Durable cancel-on-abort is owned by the SSE consumer
      // (`requestServerChatGeneration`): it captures the jobId from `job_accepted`
      // and issues the DELETE on any abort — including mid-assembly — so it is not
      // wired here (a bare disconnect only detaches; an explicit stop cancels).
    } else {
      const dispatch = await dispatchRequest({
        database: generationSettingsState.db,
        formated,
        biases,
        currentChar,
        nowChatroom,
        inputTokens,
        outputTokens,
        maxContextTokens,
        stageTimings,
        abortSignal,
        isContinue: !!arg.continue,
        isPreview: !!arg.preview,
        isPreviewPrompt: !!arg.previewPrompt,
        setProcessStage,
      })
      if (!isCurrent()) return false
      if (dispatch.status === 'preview') {
        if (!isCurrent() || !isActiveChatTargetFresh(generationTarget)) return false
        previewFormated = dispatch.formated
        return true
      }
      if (dispatch.status === 'previewPrompt') {
        if (!isCurrent() || !isActiveChatTargetFresh(generationTarget)) return false
        previewBody = dispatch.body
        return true
      }
      if (dispatch.status === 'aborted') {
        return false
      }
      if (dispatch.status === 'failed') {
        generationInfo = dispatch.generationInfo
        throwError(dispatch.reason)
        return false
      }
      req = dispatch.req
      generationId = dispatch.generationId
      generationInfo = dispatch.generationInfo
      if (generationTarget && generationActivity) {
        updateChatGenerationActivityMetadata(generationTarget, { generationId })
      }
    }
    // New/append-style generations own the row keyed by generationId. In-place
    // Continue and regenerate keep the pre-dispatch target identity.
    errorTargetMessageId ??= generationId

    const orchestrate = await orchestrateResponse({
      req,
      arg,
      nowChatroom,
      currentChar,
      currentChat,
      selectedChar,
      selectedChat,
      targetCharacterId: serverGenerationTargetCharacterId ?? currentChar.chaId,
      targetChatId: serverGenerationTargetChatId ?? currentChat.id,
      generationId,
      generationInfo,
      promptInfo,
      abortSignal,
      reformatContent,
      runCurrentChatFunction,
      suppressStreamingTts: !!serverDispatch,
      onGenerationText: () => setGenerationPhase('generating'),
      // The server owns post-gen derivation on the server-dispatch path; the
      // browser relays the stream and applies the terminal patch instead.
      serverOwnsPostGeneration: !!serverDispatch,
    })
    if (!isCurrent()) return false
    if (orchestrate.status === 'aborted') {
      return false
    }
    currentChat = orchestrate.currentChat
    if (orchestrate.messageId) errorTargetMessageId = orchestrate.messageId
    const result = orchestrate.result
    const emoChanged = orchestrate.emoChanged
    // On the server-dispatch path, the resend request rides the terminal
    // (`done.postGeneration.resendChat`); orchestrate no longer derives it.
    let resendChat = orchestrate.resendChat

    let serverRequestedResend = false
    if (serverTerminal) {
      const terminal = await serverTerminal
      if (!isCurrent()) return false
      const terminalResult = await applyServerBackedTerminal({
        terminal,
        currentChar,
        currentChat,
        selectedChar,
        selectedChat,
        targetCharacterId: serverGenerationTargetCharacterId,
        targetChatId: serverGenerationTargetChatId,
        generationInfo,
        targetMessageId: serverGenerationTargetMessageId,
        restorationGuard: serverDispatch?.restorationGuard,
        streamProjection: orchestrate.streamProjection,
      })
      if (!isCurrent()) return false
      currentChat = terminalResult.currentChat
      if (terminalResult.status === 'cancelled') {
        if (attachesDurableGeneration) {
          reattachOutcome = { status: terminalResult.reattachOutcome ?? 'cancelled' }
        }
        return false
      }
      if (terminalResult.status === 'failed') {
        if (attachesDurableGeneration) {
          reattachOutcome = {
            status: terminalResult.reattachOutcome ?? 'terminal_failure',
            error: terminalResult.error,
          }
        }
        if (!isObserverFailure(terminalResult.reattachOutcome)) throwError(terminalResult.error)
        return false
      }
      effectLedger = terminalResult.effectLedger
      // Server-backed streams only expose the derived editoutput/trigger/inlay
      // text after the terminal frame is reconciled. Append IGP to that exact
      // stable row; if the terminal cannot identify it safely, do not fall back
      // to whichever chat happens to be selected now.
      await runLedgeredGenerationEffect(effectLedger, 'igp', 'live_terminal', async (effectContext) => {
        if (!isCurrent() || !effectContext.isCurrent()) return skippedGenerationEffect('writer_session_changed')
        const promptTemplate =
          settingsResourceState.status === 'ready' ? String(settingsResourceState.value.igpPrompt ?? '') : ''
        if (!terminalResult.igpTarget || !promptTemplate.trim()) {
          return skippedGenerationEffect('not_configured')
        }
        errorTargetMessageId = terminalResult.igpTarget.messageId
        const updated = await evaluateIgp({
          promptTemplate,
          isCurrent: effectContext.isCurrent,
          abortSignal: AbortSignal.any([abortSignal, effectContext.signal]),
          waitForPersistence: !!effectLedger,
          target: terminalResult.igpTarget,
        })
        return updated ? completedGenerationEffect(undefined) : skippedGenerationEffect('target_changed')
      })
      if (!isCurrent()) return false
      if (terminalResult.resendChat) {
        serverRequestedResend = true
        if ((arg.serverResendDepth ?? 0) >= MAX_SERVER_RESEND_DEPTH) {
          throwError(SERVER_RESEND_CAP_ERROR)
          return false
        }
        resendChat = true
      }
    }

    if (!isCurrent()) return false
    const stage4 = await runStage4({
      database: generationSettingsState.db,
      req,
      currentChar,
      result,
      resendChat,
      emoChanged,
      abortSignal,
      target: stablePostGenerationMessageTarget(errorTarget?.characterId, errorTarget?.chatId, errorTargetMessageId),
      stageTimings,
      generationInfo,
      throwError,
      setProcessStage,
      effectLedger,
      effectDelivery: 'live_terminal',
    })
    if (!isCurrent()) return false
    if (stage4.status === 'resend') {
      await runLedgeredGenerationEffect(effectLedger, 'completion_sound', 'live_terminal', () =>
        skippedGenerationEffect('resend'),
      )
      if (!isCurrent()) return false
      // Handoff — see the activity ownership contract above.
      if (generationActivity && ownsGenerationActivity) {
        finishChatGenerationActivity(generationActivity.id)
        refreshLegacyGenerationProjection()
      }
      ownsGenerationActivity = false
      return await sendChat(chatProcessIndex, {
        signal: abortSignal,
        ...(arg.expectedTarget !== undefined ? { expectedTarget: arg.expectedTarget } : {}),
        ...(arg.onFailure ? { onFailure: arg.onFailure } : {}),
        serverResendDepth: serverRequestedResend ? (arg.serverResendDepth ?? 0) + 1 : 0,
      })
    }
    // The server is the sole author of generation results on every
    // server-dispatch path. Durable jobs persist at completion; inline
    // continue/regenerate persists in the post-gen pass. The browser only
    // reconciles the terminal-frame revision and issues no generation-result
    // commands.
    await runLedgeredGenerationEffect(effectLedger, 'completion_sound', 'live_terminal', () =>
      playMessageCompletionSoundIfEnabled()
        ? completedGenerationEffect(undefined)
        : skippedGenerationEffect('not_configured'),
    )
    if (!isCurrent()) return false
    if (attachesDurableGeneration) reattachOutcome = { status: 'completed' }
    if (!arg.preview && !arg.previewPrompt && generationTarget.chatId && !isChatVisible(generationTarget.chatId)) {
      markChatUnread(generationTarget.chatId)
    }
    return true
  } finally {
    if (ownsGenerationActivity && generationActivity) {
      finishChatGenerationActivity(generationActivity.id)
      refreshLegacyGenerationProjection()
    }
    if (attachesDurableGeneration) {
      const outcome: GenerationReattachOutcome = reattachOutcome ?? {
        status: !isCurrent() ? 'observer_superseded' : abortSignal.aborted ? 'aborted' : 'terminal_failure',
      }
      try {
        arg.onReattachOutcome?.(outcome)
      } catch (error) {
        console.error(error)
      }
    }
  }
}

registerGenerationProcessRuntime({
  clearActiveGenerationAbortController,
  createActiveGenerationAbortController,
  sendChat,
})
