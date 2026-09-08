<script module lang="ts">
  import { sharedChatReadOwners } from './sharedChatReadOwners.svelte'
  let manualTriggerDisplayGeneration = 0
</script>

<script lang="ts">
  import { getContext, onDestroy, untrack } from 'svelte'
  import { getChatReadOwnersContext } from './chatReadOwnersContext'
  import { resolveActiveModuleStates } from 'src/ts/moduleActivation'
  import { denyReaderScriptActivation, hasExecutableMarkupAction } from './readerPassiveHtml'
  import {
    canUseClientWriteAccess,
    captureClientSessionGeneration,
    clientSessionStore,
    isClientSessionGenerationCurrent,
  } from 'src/ts/clientSession'
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'
  import {
    ArrowLeft,
    ArrowLeftRightIcon,
    ArrowRight,
    BookmarkIcon,
    BotIcon,
    CopyIcon,
    PowerOff,
    GitBranch,
    HamburgerIcon,
    LanguagesIcon,
    LoaderCircleIcon,
    PencilIcon,
    RefreshCcwIcon,
    SplitIcon,
    TrashIcon,
    UserIcon,
    Volume2Icon,
    Scissors,
  } from '@lucide/svelte'
  import {
    aiLawApplies,
    changeChatTo,
    foldChatToMessage,
    getFileSrc,
    createChatCopyName,
  } from 'src/ts/globalApi.svelte'
  import { ColorSchemeTypeStore } from 'src/ts/gui/colorscheme'
  import { displaySettingsForPaint } from 'src/ts/gui/displaySettings'
  import { longpress } from 'src/ts/gui/longtouch'
  import { getModelInfo } from 'src/ts/model/modellist'
  import { runLuaButtonTrigger } from 'src/ts/process/scriptings'
  import { risuChatParser } from 'src/ts/process/scripts'
  import {
    clearManualTriggerAbortController,
    createManualTriggerAbortController,
    runTrigger,
  } from 'src/ts/process/triggers'
  import { sayTTS } from 'src/ts/process/tts'
  import {
    ReloadChatPointer,
    CurrentTriggerIdStore,
    popupStore,
    refreshVariableOnlyGui,
    SizeStore,
    closePopupEditorSession,
    isPopupEditorSessionCurrent,
    openPopupEditorSession,
    popUpEditorStore,
  } from 'src/ts/stores.svelte'
  import { capitalize, sleep } from 'src/ts/util'
  import { getUserDisplayName, getUserIcon } from 'src/ts/utilState'
  import { v4 as uuidv4, v4 } from 'uuid'
  import { language } from '../../lang'
  import {
    alertClear,
    alertConfirm,
    alertError,
    alertInput,
    alertNormal,
    alertRequestData,
    alertWait,
  } from '../../ts/alert'
  import { ParseMarkdown, type CbsConditions, type simpleCharacterArgument } from '../../ts/parser/parser.svelte'
  import {
    applyChatMetadataOwnerPatch,
    charactersResourceState,
    getCharacterResourceOwner,
    getChatMetadataOwnerState,
    getChatMetadataOwnerSnapshot,
    settingsResourceState,
  } from 'src/ts/server/resourceState.svelte'
  import {
    type Chat,
    type Database,
    type Message,
    type MessageGenerationInfo,
    type MessageTranslation,
    type character as Character,
  } from '../../ts/storage/database.svelte'
  import { selectedCharID } from '../../ts/stores.svelte'
  import { HideIconStore, ReloadGUIPointer, VariableReloadGUIPointer } from '../../ts/stores.svelte'
  import { moduleRenderRevision } from '../../ts/moduleRenderRevision'
  import AutoresizeArea from '../UI/GUI/TextAreaResizable.svelte'
  import ChatBody from './ChatBody.svelte'
  import PopupButton from '../UI/PopupButton.svelte'
  import RerollList from './RerollList.svelte'
  import PartialEditController from './PartialEditController.svelte'
  import {
    createTranscriptInteractionScope,
    TRANSCRIPT_INTERACTION_CONTEXT,
    type TranscriptInteractionProvider,
  } from './transcriptInteraction'
  import { TRANSCRIPT_MESSAGE_VIEW_CONTEXT, type TranscriptMessageViewOwner } from './transcriptMessageView'
  import { resolveFreshPartialEditSave, type PartialEditSaveDetail } from './partialEditFreshness'
  import {
    chatGenerationLoadingPhaseFromStage,
    getChatGenerationLoadingLanguageKey,
    normalizeChatGenerationLoadingPhase,
    type ChatGenerationLoadingPhase,
  } from './chatGenerationLoading'
  import { agentPresetProgress } from 'src/ts/process/agentPresetProgress'
  import {
    shouldAutoPopupMessageEditor,
    shouldAutoPopupTranslationEditor,
    shouldUseStableMessageEditor,
  } from './messageEditPopup'
  import { renderCustomHtmlTemplate } from './ChatCustomHtmlTemplate'
  import {
    captureChatForkSnapshot,
    currentChatScopedSnapshot,
    cloneJsonValue,
    dispatchCompatibleChatUpdateScoped,
    dispatchDeleteMessageScoped,
    dispatchForkChatWithOutcome,
    dispatchReplaceMessagesScoped,
    dispatchTruncateMessagesScoped,
    dispatchUpdateChatScopedWithOutcome,
    dispatchUpdateMessageScoped,
    ensureMessageId,
    restoreChatRowMetadata,
    type ActiveChatTarget,
    type ChatMutationOutcome,
  } from 'src/ts/chatCommands'
  import { reportWriterAccessLostMutation } from 'src/ts/server/activeWriterSession'
  import {
    canUseServerCommands,
    getServerCommandBaseRevision,
    translateGreetingCommand,
    translateMessageCommand,
  } from 'src/ts/server/commands'
  import {
    activeMessageTranslations,
    beginActiveMessageTranslation,
    clearMessageTranslationJob,
    isCurrentMessageTranslationJob,
  } from 'src/ts/server/messageTranslationJobs'
  import {
    activeGreetingTranslations,
    applyGreetingTranslationCommandReceipt,
    beginActiveGreetingTranslation,
    clearGreetingTranslationJob,
    findGreetingTranslation,
    getGreetingTranslationProjection,
    isCurrentGreetingTranslationJob,
    refreshGreetingTranslationProjection,
  } from 'src/ts/server/greetingTranslations.svelte'
  import {
    captureChatButtonTriggerFreshness,
    chatButtonTriggerChatSignature,
    renderedChatButtonTriggerOperationTracker,
    resolveChatButtonTriggerFreshness,
    resolveChatButtonTriggerTargetAfterHydration,
    type ChatButtonTriggerFreshnessSnapshot,
    type ChatButtonTriggerIdentity,
    type ChatButtonTriggerTarget,
  } from './chatButtonTriggerFreshness'

  import { createBranchComment, parseBranchComment } from './branchComment'
  import { characterRoutePath, navigate, parseRoute } from 'src/ts/router'
  import {
    applyMessageTranslationLocalEffect,
    getChatMessageOwnerState,
    hydrateChatMessages,
  } from 'src/ts/server/chatMessageHydration.svelte'
  import { rekeyClonedChat } from 'src/ts/chatFork'
  import { bilingualInterleave } from 'src/ts/translator/bilingualInterleave'
  import type { GenerationPersistenceIndicatorState } from 'src/ts/process/generationPersistenceState'
  import type { DisplaySourcePriority } from 'src/ts/server/displaySources'
  import type { SettingsGroup } from '@risuai/shared-core/settings-groups'

  let translating = $state(false)
  const renderOwners = getChatReadOwnersContext()
  let editMode = $state(false)
  let messageEditText = $state('')
  let statusMessage: string = $state('')
  let retranslate = $state(false)
  let editTranslationMode = $state(false)
  let editTranslationText = $state('')
  let editTranslationTarget: TranslationMessageTarget | null = $state(null)
  let translationEditOperation = 0
  let activeRawTranslationRequestTarget: RawTranslationTarget | null = $state(null)
  let bodyRoot: HTMLElement | null = $state(null)
  function characterRowsForRead(): readonly Character[] {
    return charactersResourceState.status === 'ready' ? charactersResourceState.characters : []
  }

  function selectedCharacterReadOwner(): Character | undefined {
    return renderOwners.character()
  }

  interface CharacterChatOwner {
    character: Character
    chat: Chat
  }

  function uniqueChatReadOwner(chatId: string): CharacterChatOwner | undefined {
    if (!chatId) return undefined
    const characters = characterRowsForRead()
    let owner: CharacterChatOwner | undefined
    const characterCounts = new Map<string, number>()
    for (const character of characters) {
      if (character?.chaId) characterCounts.set(character.chaId, (characterCounts.get(character.chaId) ?? 0) + 1)
    }
    for (const character of characters) {
      if (!character?.chaId || characterCounts.get(character.chaId) !== 1) {
        continue
      }
      for (const chat of character.chats ?? []) {
        if (chat?.id !== chatId) continue
        if (owner) return undefined
        owner = { character, chat }
      }
    }
    if (!owner) return undefined
    if (getCharacterResourceOwner(owner.character.chaId) !== owner.character) return undefined
    if (!getChatMetadataOwnerState(chatId)) return undefined
    if (!getChatMetadataOwnerSnapshot(owner.character.chaId, chatId)) return undefined
    return owner
  }

  // Mutable access is restricted to ready, uniquely identified character/chat
  // owners while command helpers retain durable mutation authority.
  function mutableChatOwnerRows(): readonly Character[] {
    if (!canChatWrite()) return []
    return characterRowsForRead()
  }

  function mutableCharacterOwnerById(characterId: string): Character | undefined {
    if (!canChatWrite()) return undefined
    if (!characterId || charactersResourceState.status !== 'ready') return undefined
    return getCharacterResourceOwner(characterId)
  }

  function mutableChatOwnerById(characterId: string, chatId: string): CharacterChatOwner | undefined {
    if (!canChatWrite()) return undefined
    const readOwner = uniqueChatReadOwner(chatId)
    return readOwner?.character.chaId === characterId ? readOwner : undefined
  }

  function mutableActiveChatOwner(): CharacterChatOwner | undefined {
    const character = selectedCharacterReadOwner()
    const chatPage = character?.chatPage
    const chatId = typeof chatPage === 'number' ? character?.chats?.[chatPage]?.id : undefined
    if (!character?.chaId || !chatId) return undefined
    return mutableChatOwnerById(character.chaId, chatId)
  }

  function readSettingsGroup(group: SettingsGroup): Partial<Database> {
    if (renderOwners.settings) return renderOwners.settings()
    if (group === 'display') return displaySettingsForPaint()
    const status = settingsResourceState.groupStatuses[group] ?? 'idle'
    if (status === 'ready') return settingsResourceState.value as Partial<Database>
    return {}
  }

  let displaySettings = $derived(readSettingsGroup('display'))
  let languageSettings = $derived(readSettingsGroup('language'))
  let sidebarSettings = $derived(readSettingsGroup('sidebar'))
  let advancedSettings = $derived(readSettingsGroup('advanced'))
  let renderCharacter = $derived(selectedCharacterReadOwner())
  interface Props {
    message?: string
    translation?: MessageTranslation | null
    greetingTarget?: GreetingTranslationTarget | null
    name?: string
    largePortrait?: boolean
    isLastMemory: boolean
    img?: string | Promise<string>
    idx?: number
    messageGenerationInfo?: MessageGenerationInfo | null
    rerollIcon?: boolean | 'dynamic'
    role?: string
    totalLength?: number
    onReroll?: () => void
    unReroll?: () => void
    onNewReroll?: () => void
    onSelectRerollCandidate?: (index: number) => void
    rerollTarget?: ActiveChatTarget | null
    character?: simpleCharacterArgument | string | null
    firstMessage?: boolean
    altGreeting?: boolean
    currentPage?: number
    totalPages?: number
    isComment?: boolean
    isGenerationLoading?: boolean
    isGenerationProjection?: boolean
    generationPresentationMode?: 'send' | 'regenerate'
    isChatGenerating?: boolean
    halfStreamingTokensPerSecond?: number
    halfStreamingGeneratedTokens?: number
    generationPersistenceState?: GenerationPersistenceIndicatorState | null
    generationPhase?: ChatGenerationLoadingPhase
    generationStartedAt?: number
    generationStage?: number
    disabled?: boolean | 'allBefore'
    readOnly?: boolean
    autoTranslateOnReady?: boolean
    onAutoTranslationEligibilityConsumed?: () => void
    onInitialDisplayParseStart?: (registration: symbol) => void
    onInitialDisplayParseSettled?: (registration: symbol) => void
    displayPriority?: DisplaySourcePriority
    displayChatId?: string | null
    displayMessageId?: string | null
  }

  interface CapturedChatButtonTriggerTarget {
    sessionGeneration: number
    snapshot: ChatButtonTriggerFreshnessSnapshot
    previous: ReturnType<typeof currentChatScopedSnapshot>
  }

  interface TranslationMessageTarget {
    sessionGeneration: number
    messageId: string
    chatId?: string
  }

  interface GreetingTranslationTarget {
    characterId: string
    chatId: string
    greetingIndex: number
    source: string
    clientSettingsSignature: string
  }

  type RawTranslationTarget =
    | ({ kind: 'message' } & TranslationMessageTarget & { chatId: string })
    | ({ kind: 'greeting'; sessionGeneration: number } & GreetingTranslationTarget)

  interface MessageEditorTarget {
    sessionGeneration: number
    characterId?: string
    characterReference: object
    chatId?: string
    chatReference: Chat
    messageId?: string
    messageReference: Message
    messageIndex: number
    sourceData: string
  }

  let {
    message = $bindable(''),
    translation = null,
    greetingTarget = null,
    name = '',
    largePortrait = false,
    isLastMemory,
    img = '',
    idx = -1,
    rerollIcon = false,
    messageGenerationInfo = null,
    role = null,
    totalLength = 0,
    onReroll = () => {},
    unReroll = () => {},
    onNewReroll = onReroll,
    onSelectRerollCandidate = () => {},
    rerollTarget = null,
    character = null,
    firstMessage = false,
    altGreeting = false,
    currentPage = 1,
    totalPages = 1,
    isComment = false,
    isGenerationLoading = false,
    isGenerationProjection = false,
    generationPresentationMode = undefined,
    isChatGenerating = false,
    halfStreamingTokensPerSecond = undefined,
    halfStreamingGeneratedTokens = undefined,
    generationPersistenceState = null,
    generationPhase = undefined,
    generationStartedAt = undefined,
    generationStage = 0,
    disabled = false,
    readOnly = false,
    autoTranslateOnReady = false,
    onAutoTranslationEligibilityConsumed = () => {},
    onInitialDisplayParseStart = () => {},
    onInitialDisplayParseSettled = () => {},
    displayPriority = 'normal',
    displayChatId = null,
    displayMessageId = null,
  }: Props = $props()
  let writeActionsAllowed = $derived.by(() => {
    void $clientSessionStore
    return canChatWrite()
  })
  function canChatWrite(): boolean {
    if (readOnly || !canUseClientWriteAccess()) return false
    if (renderOwners.chat() !== sharedChatReadOwners.chat()) return false
    if (displayChatId && displayChatId !== sharedChatReadOwners.chat()?.id) return false
    if (idx >= 0 && displayMessageId && displayMessageId !== sharedChatReadOwners.message(idx)?.chatId) return false
    return true
  }
  function isChatWriteCurrent(generation: number): boolean {
    return canChatWrite() && isClientSessionGenerationCurrent(generation)
  }
  async function awaitChatWrite<T>(generation: number, pending: T | PromiseLike<T>): Promise<T> {
    try {
      return await pending
    } finally {
      if (!isChatWriteCurrent(generation)) throw new Error('chat_write_access_required')
    }
  }
  async function runChatWriteAction<T>(action: (generation: number) => T | Promise<T>): Promise<T | undefined> {
    if (!canChatWrite()) return
    const generation = captureClientSessionGeneration()
    return interactions.run(async () => {
      if (!isChatWriteCurrent(generation)) return
      try {
        return await action(generation)
      } catch (error) {
        if (!isChatWriteCurrent(generation)) return
        throw error
      }
    })
  }

  const interactionProvider = getContext<TranscriptInteractionProvider | undefined>(TRANSCRIPT_INTERACTION_CONTEXT)
  const interactions = createTranscriptInteractionScope(
    interactionProvider,
    () => displayMessageId ?? currentLiveMessage()?.chatId,
    () => alertNormal(language.transcriptInteractionLimit),
  )
  let interactionAvailability = $state(0)
  const unsubscribeInteractionAvailability = interactionProvider?.subscribeAvailable(() => {
    interactionAvailability += 1
  })
  let messageEditorReservation: (() => void) | null = null
  let translationEditorReservation: (() => void) | null = null
  let pendingMessageEdits = $state(0)
  let pendingTranslationEdits = $state(0)
  let autoPopupMessageEditorOpen = $state(false)
  let autoPopupTranslationEditorOpen = $state(false)
  let activeAutoPopupMessageSessionId: number | null = null
  let activeAutoPopupTranslationSessionId: number | null = null
  let suppressAutoPopupTranslationEditor = $state(false)
  const autoPopupMessageEditor = $derived(
    shouldAutoPopupMessageEditor({
      editMode,
      index: idx,
      disableAutoPopupMessageEditor: sidebarSettings.disableAutoPopupMessageEditor,
    }),
  )
  const autoPopupTranslationEditor = $derived(
    shouldAutoPopupTranslationEditor({
      editTranslationMode,
      index: idx,
      disableAutoPopupMessageEditor: sidebarSettings.disableAutoPopupMessageEditor,
      suppressAutoPopupTranslationEditor,
    }),
  )
  const useStableMessageEditor = $derived(
    shouldUseStableMessageEditor({
      editMode,
      index: idx,
      message: editMode ? messageEditText : message,
      theme: displaySettings.theme,
    }),
  )
  const useStableTranslationEditor = $derived(
    shouldUseStableMessageEditor({
      editMode: editTranslationMode,
      index: idx,
      message: editTranslationText,
      theme: displaySettings.theme,
    }),
  )

  const messageViewOwner = getContext<TranscriptMessageViewOwner | undefined>(TRANSCRIPT_MESSAGE_VIEW_CONTEXT)
  const messageView = $derived(messageViewOwner?.capture(displayMessageId ?? currentLiveMessage()?.chatId))
  const restoredMessageView = untrack(() => messageView?.read())
  let msgDisplay = $state('')
  let translated = $state(restoredMessageView?.translated ?? false)
  let suppressAutomaticTranslationDisplay = $state(restoredMessageView?.suppressAutomaticTranslationDisplay ?? false)
  $effect(() => {
    messageView?.write({ translated, suppressAutomaticTranslationDisplay })
  })
  let automaticTranslationEligibilityConsumed = $state(false)
  let partialEditEnabled = $state(true)
  let lastDisplayParseKey = ''
  let rerollMenuButtonId = Math.random()
  let messageEditOriginalText: string | null = $state(null)
  onDestroy(
    registerWriterDraftCapture(() => {
      const text =
        activeAutoPopupMessageSessionId !== null && isPopupEditorSessionCurrent(activeAutoPopupMessageSessionId)
          ? popUpEditorStore.value
          : messageEditText
      if (!editMode || text === (messageEditOriginalText ?? messageEditTarget?.sourceData)) return null
      const target = messageEditTarget
      return {
        key: `message-edit:${target?.chatId ?? displayChatId}:${target?.messageId ?? displayMessageId ?? idx}`,
        label: language.connectedReaders.messageDraft,
        route: globalThis.location?.pathname,
        fields: [{ label: language.connectedReaders.messageDraft, value: text }],
        data: {
          characterId: target?.characterId,
          chatId: target?.chatId ?? displayChatId,
          messageId: target?.messageId ?? displayMessageId,
          text,
        },
        baseline: { source: messageEditOriginalText ?? target?.sourceData },
      }
    }),
  )
  onDestroy(
    registerWriterDraftCapture(() => {
      if (!editTranslationMode) return null
      const text =
        activeAutoPopupTranslationSessionId !== null && isPopupEditorSessionCurrent(activeAutoPopupTranslationSessionId)
          ? popUpEditorStore.value
          : editTranslationText
      const baseline = editTranslationTarget
        ? liveRawTranslationForTarget(editTranslationTarget)?.text
        : activeRawTranslation()?.text
      if (text === baseline) return null
      return {
        key: `translation-edit:${editTranslationTarget?.chatId ?? displayChatId}:${editTranslationTarget?.messageId ?? displayMessageId ?? idx}`,
        label: language.editTranslation,
        route: globalThis.location?.pathname,
        fields: [{ label: language.editTranslation, value: text }],
        data: { target: $state.snapshot(editTranslationTarget), text },
        baseline: { text: baseline },
      }
    }),
  )

  let messageEditTarget: MessageEditorTarget | null = null

  function captureMessageEditorTarget(): MessageEditorTarget | null {
    const owner = mutableActiveChatOwner()
    if (!owner || idx < 0) return null
    const { character, chat } = owner
    const liveMessage = chat?.message?.[idx]
    const readMessage = currentLiveMessage()
    if (!liveMessage?.chatId || readMessage?.chatId !== liveMessage.chatId) return null

    return {
      characterId: character.chaId || undefined,
      sessionGeneration: captureClientSessionGeneration(),
      characterReference: character,
      chatId: chat.id || undefined,
      chatReference: chat,
      messageId: liveMessage.chatId || undefined,
      messageReference: liveMessage,
      messageIndex: idx,
      sourceData: liveMessage.data,
    }
  }

  function matchesMessageEditorIdentity(
    currentId: string | undefined,
    capturedId: string | undefined,
    currentReference: object,
    capturedReference: object,
  ): boolean {
    return capturedId ? currentId === capturedId : currentReference === capturedReference
  }

  function isCurrentMessageEditorTarget(target: MessageEditorTarget): boolean {
    if (!isChatWriteCurrent(target.sessionGeneration)) return false
    // Stable message identity survives unrelated insertions/removals before this row.
    if (!target.messageId && idx !== target.messageIndex) return false

    const owner = mutableActiveChatOwner()
    if (!owner) return false
    const { character, chat } = owner
    const readMessage = currentLiveMessage()
    if (!readMessage?.chatId || chat.message?.[idx]?.chatId !== readMessage.chatId) return false
    if (
      !matchesMessageEditorIdentity(
        character.chaId || undefined,
        target.characterId,
        character,
        target.characterReference,
      )
    ) {
      return false
    }

    if (!matchesMessageEditorIdentity(chat.id || undefined, target.chatId, chat, target.chatReference)) {
      return false
    }

    const liveMessage = chat.message?.[idx]
    return (
      !!liveMessage &&
      liveMessage.data === target.sourceData &&
      matchesMessageEditorIdentity(
        liveMessage.chatId || undefined,
        target.messageId,
        liveMessage,
        target.messageReference,
      )
    )
  }

  function cancelMessageEdit(): void {
    editMode = false
    messageEditOriginalText = null
    messageEditTarget = null
    messageEditText = ''
  }

  $effect(() => {
    void $clientSessionStore
    if (editMode && messageEditTarget && !isChatWriteCurrent(messageEditTarget.sessionGeneration)) {
      if (activeAutoPopupMessageSessionId !== null) closePopupEditorSession(activeAutoPopupMessageSessionId)
      cancelMessageEdit()
    }
    if (editTranslationMode && editTranslationTarget && !isChatWriteCurrent(editTranslationTarget.sessionGeneration)) {
      if (activeAutoPopupTranslationSessionId !== null) closePopupEditorSession(activeAutoPopupTranslationSessionId)
      editTranslationMode = false
      editTranslationTarget = null
    }
  })

  function beginMessageEdit() {
    if (!canChatWrite()) return
    if (translationInProgress) return
    if (editMode) return
    const target = captureMessageEditorTarget()
    if (!target) return
    if (!messageEditorReservation) {
      messageEditorReservation = interactions.acquire()
      if (!messageEditorReservation) return
    }
    messageEditTarget = target
    messageEditOriginalText = message
    messageEditText = message
    editMode = true
  }

  function handleMessageBodyClick(event: MouseEvent): void {
    if (isGenerationProjection || !sidebarSettings.clickToEdit || idx < 0 || event.defaultPrevented) return

    const target = event.target
    if (
      target instanceof Element &&
      target.closest(
        'a, button, input, textarea, select, option, label, summary, audio, video, [role="button"], [role="link"], [contenteditable]:not([contenteditable="false"]), [risu-trigger], [risu-btn]',
      )
    ) {
      return
    }

    beginMessageEdit()
  }

  async function saveMessageEdit() {
    if (!canChatWrite()) return
    if (translationInProgress) return
    if (!editMode) return
    const target = messageEditTarget
    if (!target || !isCurrentMessageEditorTarget(target)) {
      cancelMessageEdit()
      return
    }
    pendingMessageEdits += 1
    editMode = false
    try {
      await edit(target, messageEditText)
    } finally {
      pendingMessageEdits -= 1
      if (!editMode) messageEditText = ''
    }
  }

  function openRerollMenu(e: MouseEvent, children: import('svelte').Snippet): void {
    if (!canChatWrite()) return
    const trigger = e.currentTarget as HTMLButtonElement
    if (popupStore.openId === rerollMenuButtonId && popupStore.children) {
      popupStore.children = null
      popupStore.openId = 0
      popupStore.trigger = null
      return
    }
    const rect = trigger.getBoundingClientRect()
    popupStore.mouseX = e.detail === 0 ? rect.left : e.clientX
    popupStore.mouseY = e.detail === 0 ? rect.bottom : e.clientY
    popupStore.children = children
    popupStore.openId = rerollMenuButtonId
    popupStore.trigger = trigger
  }

  async function openAutoPopupMessageEditor() {
    if (!canChatWrite()) return
    if (autoPopupMessageEditorOpen || popUpEditorStore.open) return

    const target = messageEditTarget
    if (!target || !isCurrentMessageEditorTarget(target)) {
      cancelMessageEdit()
      return
    }

    autoPopupMessageEditorOpen = true
    const initialValue = messageEditText
    const sessionId = openPopupEditorSession(messageEditText)
    activeAutoPopupMessageSessionId = sessionId

    try {
      while (isPopupEditorSessionCurrent(sessionId) && popUpEditorStore.open) {
        await sleep(100)
        if (
          messageEditTarget !== target ||
          !editMode ||
          messageEditText !== initialValue ||
          !isCurrentMessageEditorTarget(target)
        ) {
          closePopupEditorSession(sessionId)
          return
        }
      }

      if (!isPopupEditorSessionCurrent(sessionId)) return
      if (messageEditTarget !== target || !editMode || messageEditText !== initialValue) {
        closePopupEditorSession(sessionId)
        return
      }
      if (!isCurrentMessageEditorTarget(target)) {
        closePopupEditorSession(sessionId)
        cancelMessageEdit()
        return
      }

      messageEditText = popUpEditorStore.value
      await saveMessageEdit()
    } finally {
      if (activeAutoPopupMessageSessionId === sessionId) activeAutoPopupMessageSessionId = null
      autoPopupMessageEditorOpen = false
    }
  }

  async function openAutoPopupTranslationEditor() {
    if (!canChatWrite()) return
    if (autoPopupTranslationEditorOpen || popUpEditorStore.open) return

    const target = editTranslationTarget ?? captureTranslationMessageTarget()
    if (!target || !isRenderingTranslationMessageTarget(target)) return

    autoPopupTranslationEditorOpen = true
    const initialValue = editTranslationText
    const sessionId = openPopupEditorSession(editTranslationText)
    activeAutoPopupTranslationSessionId = sessionId

    try {
      while (isPopupEditorSessionCurrent(sessionId) && popUpEditorStore.open) {
        await sleep(100)
        if (
          !isChatWriteCurrent(target.sessionGeneration) ||
          editTranslationTarget !== target ||
          !editTranslationMode ||
          editTranslationText !== initialValue ||
          !isRenderingTranslationMessageTarget(target)
        ) {
          closePopupEditorSession(sessionId)
          return
        }
      }

      if (!isPopupEditorSessionCurrent(sessionId)) return
      if (
        !isChatWriteCurrent(target.sessionGeneration) ||
        editTranslationTarget !== target ||
        !editTranslationMode ||
        editTranslationText !== initialValue ||
        !isRenderingTranslationMessageTarget(target)
      ) {
        closePopupEditorSession(sessionId)
        return
      }

      suppressAutoPopupTranslationEditor = true
      editTranslationText = popUpEditorStore.value
      await saveTranslationEdit()
    } finally {
      if (activeAutoPopupTranslationSessionId === sessionId) activeAutoPopupTranslationSessionId = null
      autoPopupTranslationEditorOpen = false
    }
  }

  onDestroy(() => {
    unsubscribeInteractionAvailability?.()
    interactions.dispose()
    if (activeAutoPopupMessageSessionId !== null) {
      closePopupEditorSession(activeAutoPopupMessageSessionId)
      activeAutoPopupMessageSessionId = null
    }
    if (activeAutoPopupTranslationSessionId !== null) {
      closePopupEditorSession(activeAutoPopupTranslationSessionId)
      activeAutoPopupTranslationSessionId = null
    }
  })

  $effect(() => {
    if (!editMode && !autoPopupMessageEditorOpen && pendingMessageEdits === 0) {
      untrack(() => messageEditorReservation?.())
      messageEditorReservation = null
    }
    if (!editTranslationMode && !autoPopupTranslationEditorOpen && pendingTranslationEdits === 0) {
      untrack(() => translationEditorReservation?.())
      translationEditorReservation = null
    }
  })

  $effect(() => {
    if (autoPopupMessageEditor) {
      void openAutoPopupMessageEditor()
    }
  })

  $effect(() => {
    if (autoPopupTranslationEditor) {
      void openAutoPopupTranslationEditor()
    }
  })

  function cloneMessagesWithIds(chat: Chat): Message[] {
    const messages = cloneJsonValue(chat.message ?? [])
    for (const item of messages) {
      item.chatId ||= uuidv4()
    }
    return messages
  }

  function dispatchReplaceMessagesForChat(
    chat: Chat,
    messages: Message[],
    previous: ReturnType<typeof currentChatScopedSnapshot>,
  ) {
    if (chat.id) {
      observeMessageMutation(dispatchReplaceMessagesScoped(chat.id, messages, previous))
    }
  }

  function localChatMutation(callback: () => void) {
    if (!canChatWrite() || reportWriterAccessLostMutation()) return
    if (!canUseServerCommands()) {
      callback()
    }
  }

  function recoverFailedChatBranchNavigation(
    characterId: string,
    sourceChatId: string,
    provisionalChatId: string,
  ): void {
    const route = parseRoute(window.location.pathname)
    if (route.kind !== 'character' || route.chaId !== characterId || route.chatId !== provisionalChatId) return

    const character = mutableCharacterOwnerById(characterId)
    if (!character || character.chats?.some((chat) => chat.id === provisionalChatId)) return
    if (mutableChatOwnerById(characterId, sourceChatId)?.chat !== character.chats?.[character.chatPage]) return

    navigate(characterRoutePath(characterId, sourceChatId), { replace: true })
  }

  function observeChatBranchMutation(
    outcome: Promise<ChatMutationOutcome>,
    characterId: string,
    sourceChatId: string,
    provisionalChatId: string,
  ): void {
    const generation = captureClientSessionGeneration()
    const recover = () => {
      if (isChatWriteCurrent(generation))
        recoverFailedChatBranchNavigation(characterId, sourceChatId, provisionalChatId)
    }
    void outcome.then((settled) => {
      if (settled.status === 'failed') {
        recover()
        return
      }
      if (settled.status === 'queued') {
        void settled.settlement.then((finalSettlement) => {
          if (finalSettlement.status === 'failed') recover()
        }, recover)
      }
    }, recover)
  }

  async function branchFromCurrentMessage(target: MessageEditorTarget): Promise<void> {
    if (!isChatWriteCurrent(target.sessionGeneration)) return
    const sourceCharacterId = target.characterId
    const sourceChatId = target.chatId
    const sourceMessageId = target.messageId

    if (canUseServerCommands()) {
      if (!sourceCharacterId || !sourceChatId || !sourceMessageId) {
        alertError(language.chatDataLoadFailed)
        return
      }
      try {
        await awaitChatWrite(target.sessionGeneration, hydrateChatMessages(sourceChatId, { strict: true }))
      } catch {
        if (isChatWriteCurrent(target.sessionGeneration)) alertError(language.chatDataLoadFailed)
        return
      }
    }

    // Resolve the branch source from the target captured at interaction time so a chat switch
    // during the confirm/hydration await cannot retarget the branch to whatever chat is now active.
    if (!sourceCharacterId || !sourceChatId) return
    const owner = mutableChatOwnerById(sourceCharacterId, sourceChatId)
    if (!owner) {
      return
    }
    const { character: currentCharacter, chat: currentChat } = owner

    const branchIndex = sourceMessageId
      ? currentChat.message.findIndex((candidate) => candidate.chatId === sourceMessageId)
      : currentChat.message.findIndex((candidate) => candidate === target.messageReference)
    const currentMessage = currentChat.message[branchIndex]
    if (branchIndex < 0 || !currentMessage) {
      alertError(language.chatDataLoadFailed)
      return
    }

    let folder
    let sourcePatch: { folderId?: string | null } = {}
    if (sidebarSettings.createFolderOnBranch && !currentChat.folderId) {
      const folderId = v4()
      folder = {
        id: folderId,
        name: `Branches of ${currentChat.name}`,
        folded: false,
      }
      sourcePatch = { folderId }
    }

    const newChat = cloneJsonValue(currentChat)
    if (sourcePatch.folderId) {
      newChat.folderId = sourcePatch.folderId
    }
    newChat.name = createChatCopyName(newChat.name, 'Branch')
    newChat.message = newChat.message.slice(0, branchIndex + 1)
    rekeyClonedChat(newChat)
    newChat.message.push({
      role: 'char',
      data: createBranchComment({
        sourceChatId: currentChat.id ?? '',
        sourceChatName: currentChat.name,
        sourceMessageId: currentMessage.chatId ?? '',
      }),
      isComment: true,
      disabled: true,
      chatId: v4(),
    })

    const existingFolder =
      folder ??
      currentCharacter.chatFolders?.find(
        (item) => item.id === currentChat.folderId && item.name === `Branches of ${currentChat.name}`,
      )
    const forkInput = {
      chat: newChat,
      sourcePatch: Object.keys(sourcePatch).length > 0 ? sourcePatch : { folderId: currentChat.folderId ?? null },
      folder: existingFolder,
    }
    const previous = captureChatForkSnapshot(sourceChatId, forkInput)
    if (!previous) {
      alertError(language.chatDataLoadFailed)
      return
    }

    localChatMutation(() => {
      if (folder) {
        currentCharacter.chatFolders ??= []
        currentCharacter.chatFolders.unshift(folder)
        currentChat.folderId = sourcePatch.folderId
      }
      currentCharacter.chats.unshift(newChat)
      changeChatTo(0)
    })
    if (currentChat.id) {
      const outcome = dispatchForkChatWithOutcome(currentChat.id, previous, forkInput)
      if (currentCharacter.chaId && newChat.id) {
        observeChatBranchMutation(outcome, currentCharacter.chaId, currentChat.id, newChat.id)
      }
    }
    if (currentCharacter.chaId && newChat.id) {
      navigate(characterRoutePath(currentCharacter.chaId, newChat.id))
    }
  }

  async function openBranchSource(branchReference: ReturnType<typeof parseBranchComment>): Promise<void> {
    return runChatWriteAction(async (generation) => {
      if (!branchReference) return
      const originTarget = captureMessageEditorTarget()
      if (!originTarget) return

      if (canUseServerCommands()) {
        try {
          await awaitChatWrite(generation, hydrateChatMessages(branchReference.sourceChatId, { strict: true }))
        } catch {
          if (isCurrentMessageEditorTarget(originTarget)) alertError(language.chatDataLoadFailed)
          return
        }
      }

      if (!isCurrentMessageEditorTarget(originTarget)) return
      const currentOwner = mutableActiveChatOwner()
      const currentCharacter = currentOwner?.character
      const sourceOwner = currentCharacter?.chaId
        ? mutableChatOwnerById(currentCharacter.chaId, branchReference.sourceChatId)
        : undefined
      const sourceChat = sourceOwner?.chat
      const sourceMessages =
        sourceChat?.message?.filter((candidate) => candidate.chatId === branchReference.sourceMessageId) ?? []
      if (!currentCharacter || !sourceChat || sourceMessages.length !== 1) {
        alertError(language.chatDataLoadFailed)
        return
      }

      changeChatTo(branchReference.sourceChatId)
      foldChatToMessage(branchReference.sourceMessageId)
      if (currentCharacter.chaId) {
        navigate(characterRoutePath(currentCharacter.chaId, branchReference.sourceChatId))
      }
    })
  }

  function resolveActiveMessageTarget(target: MessageEditorTarget): { chat: Chat; messageIndex: number } | null {
    if (!isChatWriteCurrent(target.sessionGeneration)) return null
    if (!target.characterId || !target.chatId) return null
    const owner = mutableChatOwnerById(target.characterId, target.chatId)
    const character = owner?.character
    const chat = owner?.chat
    if (!character || !chat || character !== target.characterReference) {
      return null
    }

    if (chat !== target.chatReference) return null
    const messageIndex = target.messageId
      ? chat.message.findIndex((candidate) => candidate.chatId === target.messageId)
      : chat.message.findIndex((candidate) => candidate === target.messageReference)
    const liveMessage = chat.message?.[messageIndex]
    if (
      messageIndex < 0 ||
      !liveMessage ||
      (target.messageId ? liveMessage.chatId !== target.messageId : liveMessage !== target.messageReference)
    ) {
      return null
    }
    return { chat, messageIndex }
  }

  async function truncateAtMessageTarget(target: MessageEditorTarget): Promise<void> {
    let resolved = resolveActiveMessageTarget(target)
    if (!resolved) return

    if (
      canUseServerCommands() &&
      resolved.messageIndex > 0 &&
      !resolved.chat.message[resolved.messageIndex - 1]?.chatId
    ) {
      if (!target.chatId || !target.messageId) {
        alertError(language.chatDataLoadFailed)
        return
      }
      try {
        await awaitChatWrite(target.sessionGeneration, hydrateChatMessages(target.chatId, { strict: true }))
      } catch {
        if (isChatWriteCurrent(target.sessionGeneration)) alertError(language.chatDataLoadFailed)
        return
      }
      resolved = resolveActiveMessageTarget(target)
      if (!resolved) return
    }

    const { chat, messageIndex } = resolved
    const previous = currentChatScopedSnapshot()
    if (canUseServerCommands()) {
      const afterMessageId = messageIndex > 0 ? chat.message[messageIndex - 1]?.chatId : null
      if (!chat.id || (messageIndex > 0 && !afterMessageId)) {
        alertError(language.chatDataLoadFailed)
        return
      }
      observeMessageMutation(dispatchTruncateMessagesScoped(chat.id, afterMessageId, previous))
      return
    }

    const afterMessageId = messageIndex > 0 ? ensureMessageId(chat.message[messageIndex - 1]) : null
    chat.message = chat.message.slice(0, messageIndex)
    if (chat.id) {
      observeMessageMutation(dispatchTruncateMessagesScoped(chat.id, afterMessageId, previous))
    }
  }

  function deleteMessageAtTarget(target: MessageEditorTarget): void {
    const resolved = resolveActiveMessageTarget(target)
    if (!resolved) return

    const { chat, messageIndex } = resolved
    const previous = currentChatScopedSnapshot()
    if (canUseServerCommands()) {
      const messageId = chat.message[messageIndex]?.chatId
      if (messageId) {
        observeMessageMutation(dispatchDeleteMessageScoped(messageId, previous))
      } else {
        const nextMessages = cloneMessagesWithIds(chat)
        nextMessages.splice(messageIndex, 1)
        dispatchReplaceMessagesForChat(chat, nextMessages, previous)
      }
      return
    }

    const messages = chat.message
    const messageId = ensureMessageId(messages[messageIndex])
    messages.splice(messageIndex, 1)
    chat.message = messages
    observeMessageMutation(dispatchDeleteMessageScoped(messageId, previous))
  }

  function applyOptimisticBookmarkMetadata(
    previous: ReturnType<typeof currentChatScopedSnapshot>,
    messageId: string,
    bookmarks: string[],
    bookmarkNames: Record<string, string>,
  ): boolean {
    if (!canChatWrite() || !previous.chat) return false
    if (!previous.characterId || !previous.chatId || charactersResourceState.status !== 'ready') return false
    const character = getCharacterResourceOwner(previous.characterId)
    const chatMatches = character?.chats?.filter((candidate) => candidate.id === previous.chatId) ?? []
    if (chatMatches.length !== 1) return false
    const messageMatches =
      getChatMessageOwnerState(previous.chatId)?.messages.filter((candidate) => candidate.chatId === messageId) ?? []
    if (messageMatches.length !== 1) return false
    const ownerSnapshot = getChatMetadataOwnerSnapshot(previous.characterId, previous.chatId)
    if (!ownerSnapshot) return false
    if (JSON.stringify(ownerSnapshot.metadata.bookmarks ?? []) !== JSON.stringify(previous.chat.bookmarks ?? [])) {
      return false
    }
    if (
      JSON.stringify(ownerSnapshot.metadata.bookmarkNames ?? {}) !== JSON.stringify(previous.chat.bookmarkNames ?? {})
    ) {
      return false
    }
    return applyChatMetadataOwnerPatch(previous.characterId, previous.chatId, {
      bookmarks: [...bookmarks],
      bookmarkNames: { ...bookmarkNames },
    })
  }

  function hasServerRawTranslationTarget() {
    return (
      languageSettings.translator !== '' &&
      (languageSettings.translatorType === 'google' ||
        languageSettings.translatorType === 'deepl' ||
        languageSettings.translatorType === 'deeplX' ||
        languageSettings.translatorType === 'llm') &&
      captureRawTranslationTarget() !== null
    )
  }

  function canTranslateRawTarget() {
    return writeActionsAllowed && canUseServerCommands() && hasServerRawTranslationTarget()
  }

  function canEditPersistedTranslation(): boolean {
    return writeActionsAllowed && captureRawTranslationTarget()?.kind === 'message' && activeRawTranslation() !== null
  }

  function currentLiveMessage(): Message | null {
    return renderOwners.message(idx) ?? null
  }

  function currentLiveChat(): Chat | null {
    return renderOwners.chat() ?? null
  }

  function automaticTranslationDisplayEnabled(): boolean {
    return currentLiveChat()?.autoTranslate === true
  }

  function chatMessagesForRead(chat: Chat): Message[] | undefined {
    if (!chat.id) return undefined
    return getChatMessageOwnerState(chat.id)?.messages
  }

  function automaticTranslationRequestEnabled(): boolean {
    const chat = currentLiveChat()
    return chat?.autoTranslate === true && !(chat.autoTranslateBotOnly === true && role === 'user')
  }

  function consumeAutomaticTranslationEligibility(): void {
    if (automaticTranslationEligibilityConsumed) return
    automaticTranslationEligibilityConsumed = true
    onAutoTranslationEligibilityConsumed()
  }

  function captureTranslationMessageTarget(): TranslationMessageTarget | null {
    const liveMessage = currentLiveMessage()
    const messageId = liveMessage?.chatId || messageRowId
    if (!messageId) return null
    return {
      messageId,
      sessionGeneration: captureClientSessionGeneration(),
      chatId: currentChatId || undefined,
    }
  }

  function captureRawTranslationTarget(): RawTranslationTarget | null {
    if (idx < 0) {
      if (!greetingTarget || greetingTarget.source !== message || greetingTarget.greetingIndex < -1) return null
      return { kind: 'greeting', ...greetingTarget, sessionGeneration: captureClientSessionGeneration() }
    }
    const target = captureTranslationMessageTarget()
    if (!target?.chatId) return null
    return { kind: 'message', ...target, chatId: target.chatId }
  }

  function sameRawTranslationTarget(left: RawTranslationTarget, right: RawTranslationTarget): boolean {
    if (left.sessionGeneration !== right.sessionGeneration || left.kind !== right.kind) return false
    if (left.kind === 'message' && right.kind === 'message') {
      return left.chatId === right.chatId && left.messageId === right.messageId
    }
    if (left.kind === 'greeting' && right.kind === 'greeting') {
      return (
        left.characterId === right.characterId &&
        left.chatId === right.chatId &&
        left.greetingIndex === right.greetingIndex &&
        left.source === right.source &&
        left.clientSettingsSignature === right.clientSettingsSignature
      )
    }
    return false
  }

  function isRenderingRawTranslationTarget(target: RawTranslationTarget): boolean {
    const current = captureRawTranslationTarget()
    return current !== null && sameRawTranslationTarget(current, target)
  }

  function isRenderingTranslationMessageTarget(target: TranslationMessageTarget): boolean {
    return messageRowId === target.messageId && (!target.chatId || currentChatId === target.chatId)
  }

  function resultTranslationMessageTarget(
    capturedTarget: TranslationMessageTarget,
    result: { chatId?: string; messageId?: string },
  ): TranslationMessageTarget | null {
    const resultMessageId = result.messageId || capturedTarget.messageId
    if (resultMessageId !== capturedTarget.messageId) return null
    return {
      sessionGeneration: capturedTarget.sessionGeneration,
      messageId: resultMessageId,
      chatId: result.chatId || capturedTarget.chatId,
    }
  }

  function findLiveMessageByTarget(target: TranslationMessageTarget): Message | null {
    if (target.chatId) {
      const owner = uniqueChatReadOwner(target.chatId)
      if (!owner) return null
      const matches =
        chatMessagesForRead(owner.chat)?.filter((candidate) => candidate.chatId === target.messageId) ?? []
      return matches.length === 1 ? matches[0] : null
    }
    return null
  }

  function translationScopedSnapshot(target: TranslationMessageTarget): ReturnType<typeof currentChatScopedSnapshot> {
    const emptySnapshot = {
      selectedCharID: $selectedCharID,
      characterId: undefined,
      chatId: undefined,
      chat: undefined,
    }
    const owner = target.chatId ? uniqueChatReadOwner(target.chatId) : undefined
    if (!owner?.character.chaId || !owner.chat.id) return emptySnapshot
    const messages = chatMessagesForRead(owner.chat)
    if (!messages || messages.filter((candidate) => candidate.chatId === target.messageId).length !== 1) {
      return emptySnapshot
    }
    const characterIndex = characterRowsForRead().indexOf(owner.character)
    if (characterIndex < 0) return emptySnapshot
    return {
      selectedCharID: characterIndex,
      characterId: owner.character.chaId,
      chatId: owner.chat.id,
      chat: cloneJsonValue({ ...owner.chat, message: messages }),
    }
  }

  function isSameTranslation(left: MessageTranslation | null | undefined, right: MessageTranslation | null): boolean {
    if (!left || !right) return left == null && right === null
    return (
      left.source === right.source &&
      left.text === right.text &&
      left.sourceHash === right.sourceHash &&
      left.targetLanguage === right.targetLanguage &&
      left.inputLanguage === right.inputLanguage &&
      left.translatorType === right.translatorType &&
      left.settingsHash === right.settingsHash &&
      left.updatedAt === right.updatedAt
    )
  }

  function applyLocalTranslation(
    target: TranslationMessageTarget,
    nextTranslation: MessageTranslation | null,
    options: { expectedCurrentTranslation?: MessageTranslation | null } = {},
  ): boolean {
    if (!target.chatId) return false
    const liveMessage = findLiveMessageByTarget(target)
    if (!liveMessage) return false
    if (
      'expectedCurrentTranslation' in options &&
      !isSameTranslation(liveMessage.translation, options.expectedCurrentTranslation ?? null)
    ) {
      return false
    }
    return applyMessageTranslationLocalEffect(target.chatId, target.messageId, nextTranslation)
  }

  function activeRawTranslation(): MessageTranslation | null {
    if (!hasServerRawTranslationTarget()) return null
    const target = captureRawTranslationTarget()
    if (!target) return null
    const currentTranslation =
      target.kind === 'greeting' ? findGreetingTranslation(target) : (translation ?? currentLiveMessage()?.translation)
    return currentTranslation?.source === 'raw' && typeof currentTranslation.text === 'string'
      ? currentTranslation
      : null
  }

  function sourceEditPatch(liveMessage: Message, nextData: string): Pick<Message, 'data' | 'translation'> {
    if (liveMessage.data !== nextData && liveMessage.translation?.source === 'raw') {
      return { data: nextData, translation: null }
    }
    return { data: nextData }
  }

  function invalidateTranslationUiForSourceEdit(patch: Pick<Message, 'data' | 'translation'>): void {
    if (!Object.prototype.hasOwnProperty.call(patch, 'translation')) return
    translationEditOperation += 1
    translated = false
    editTranslationMode = false
    editTranslationTarget = null
  }

  function liveRawTranslationForTarget(target: TranslationMessageTarget): MessageTranslation | null {
    const currentTranslation = findLiveMessageByTarget(target)?.translation
    return currentTranslation?.source === 'raw' && typeof currentTranslation.text === 'string'
      ? currentTranslation
      : null
  }

  async function requestServerRawTranslation(
    target: RawTranslationTarget | null = captureRawTranslationTarget(),
    reserved?: () => void,
  ) {
    if (!target || !isChatWriteCurrent(target.sessionGeneration)) {
      reserved?.()
      return
    }
    const release = reserved ?? interactions.acquire()
    if (!release) return
    try {
      if (translationInProgress) return
      if (!target) {
        setStatusMessage('Translation target is not ready yet.', 2500)
        return
      }
      const jobId = uuidv4()
      let greetingSettingsHash: string | null = null
      if (target.kind === 'message') {
        if (
          !beginActiveMessageTranslation({
            chatId: target.chatId,
            messageId: target.messageId,
            jobId,
            status: 'running',
          })
        ) {
          return
        }
      } else {
        const projection = getGreetingTranslationProjection(target.characterId, target.chatId)
        greetingSettingsHash =
          projection?.clientSettingsSignature === target.clientSettingsSignature ? projection.settingsHash : null
        if (!greetingSettingsHash) {
          setStatusMessage('Greeting translation settings are not ready yet.', 2500)
          return
        }
        if (
          !beginActiveGreetingTranslation({
            characterId: target.characterId,
            chatId: target.chatId,
            greetingIndex: target.greetingIndex,
            settingsHash: greetingSettingsHash,
            jobId,
            status: 'running',
          })
        ) {
          return
        }
      }
      translationEditOperation += 1
      activeRawTranslationRequestTarget = target
      translating = true
      editTranslationMode = false
      editTranslationTarget = null
      try {
        // Raw translation may wait on an external provider. Its server endpoint
        // uses the captured message text as the commit precondition, so keep it
        // outside the global revisioned-mutation queue and let unrelated edits
        // continue while the provider is running.
        const baseRevision = await awaitChatWrite(target.sessionGeneration, getServerCommandBaseRevision())
        if (baseRevision === null) {
          if (isRenderingRawTranslationTarget(target)) translated = false
          setStatusMessage('Unable to read server command revision.', 3000)
          return
        }
        if (target.kind === 'message') {
          const result = await awaitChatWrite(
            target.sessionGeneration,
            translateMessageCommand({ baseRevision, messageId: target.messageId, jobId }),
          )
          if (!isCurrentMessageTranslationJob(target.messageId, jobId)) return
          if (result.status === 'ok') {
            if (result.jobId !== jobId) return
            const resultTarget = resultTranslationMessageTarget(target, result)
            if (resultTarget) applyLocalTranslation(resultTarget, result.translation)
            if (isRenderingRawTranslationTarget(target)) {
              translated = true
              editTranslationMode = false
            }
            return
          }
          if (isRenderingRawTranslationTarget(target)) translated = false
          if (result.status === 'conflict') {
            setStatusMessage(`Translation conflict (${result.currentRevision}).`, 3000)
          } else if (result.status === 'unavailable') {
            setStatusMessage('Server commands are unavailable.', 3000)
          } else {
            setStatusMessage(result.error, 3000)
          }
          return
        }

        const result = await awaitChatWrite(
          target.sessionGeneration,
          translateGreetingCommand({
            baseRevision,
            characterId: target.characterId,
            chatId: target.chatId,
            greetingIndex: target.greetingIndex,
            jobId,
          }),
        )
        if (
          !isCurrentGreetingTranslationJob(
            target.characterId,
            target.chatId,
            target.greetingIndex,
            greetingSettingsHash!,
            jobId,
          )
        ) {
          return
        }
        if (result.status === 'ok') {
          if (
            result.jobId !== jobId ||
            result.characterId !== target.characterId ||
            result.chatId !== target.chatId ||
            result.greetingIndex !== target.greetingIndex ||
            result.settingsHash !== greetingSettingsHash
          ) {
            return
          }
          applyGreetingTranslationCommandReceipt({
            revision: result.revision,
            characterId: target.characterId,
            chatId: target.chatId,
            greetingIndex: target.greetingIndex,
            settingsHash: result.settingsHash,
            clientSettingsSignature: target.clientSettingsSignature,
            translation: result.translation,
          })
          if (isRenderingRawTranslationTarget(target)) {
            translated = true
            editTranslationMode = false
          }
          return
        }
        if (isRenderingRawTranslationTarget(target)) translated = false
        if (result.status === 'conflict') {
          setStatusMessage(`Translation conflict (${result.currentRevision}).`, 3000)
        } else if (result.status === 'unavailable') {
          setStatusMessage('Server commands are unavailable.', 3000)
        } else {
          setStatusMessage(result.error, 3000)
        }
      } catch (error) {
        if (!isChatWriteCurrent(target.sessionGeneration)) return
        if (isRenderingRawTranslationTarget(target)) translated = false
        const detail = error instanceof Error ? error.message : String(error)
        setStatusMessage(language.playground.translationRunFailed(detail), 5000)
      } finally {
        if (target.kind === 'message') clearMessageTranslationJob(jobId)
        else clearGreetingTranslationJob(jobId)
        if (activeRawTranslationRequestTarget && sameRawTranslationTarget(activeRawTranslationRequestTarget, target)) {
          activeRawTranslationRequestTarget = null
          translating = false
        }
      }
    } finally {
      release()
    }
  }

  async function confirmServerRawRetranslation() {
    return runChatWriteAction(async (generation) => {
      const target = captureRawTranslationTarget()
      if (!target || translationInProgress) return
      if (!(await awaitChatWrite(generation, alertConfirm(language.retranslateConfirm)))) return
      if (!isRenderingRawTranslationTarget(target) || translationInProgress || !canTranslateRawTarget()) return
      await requestServerRawTranslation(target)
    })
  }

  async function confirmClientRetranslation() {
    return runChatWriteAction(async (generation) => {
      const sourceMessage = message
      const sourceIndex = idx
      if (!(await awaitChatWrite(generation, alertConfirm(language.retranslateConfirm)))) return
      if (
        translationInProgress ||
        !translated ||
        message !== sourceMessage ||
        idx !== sourceIndex ||
        hasServerRawTranslationTarget() ||
        languageSettings.translatorType !== 'llm'
      ) {
        return
      }
      retranslate = true
    })
  }

  // Returns null only when no scoped snapshot exists for the target; a null
  // *dispatched* value still reports failure through the mutation observer.
  function dispatchTranslationUpdate(
    target: TranslationMessageTarget,
    nextTranslation: MessageTranslation | null,
  ): { dispatched: ReturnType<typeof dispatchUpdateMessageScoped> } | null {
    if (!isChatWriteCurrent(target.sessionGeneration)) return null
    const previous = translationScopedSnapshot(target)
    if (!previous.chat) return null
    applyLocalTranslation(target, nextTranslation)
    const save = dispatchUpdateMessageScoped(target.messageId, { translation: nextTranslation }, previous, {
      optimisticPatchAlreadyApplied: true,
    })
    observeMessageMutation(save)
    return { dispatched: save }
  }

  async function saveServerTranslationEdit() {
    if (!canChatWrite()) return
    const target = editTranslationTarget ?? captureTranslationMessageTarget()
    const existing = target
      ? (liveRawTranslationForTarget(target) ??
        (isRenderingTranslationMessageTarget(target) ? activeRawTranslation() : null))
      : null
    if (!existing || !target) return
    const saveOperation = ++translationEditOperation
    if (editTranslationText === existing.text) {
      editTranslationMode = false
      editTranslationTarget = null
      return
    }
    const nextTranslation: MessageTranslation = {
      ...existing,
      text: editTranslationText,
      updatedAt: Date.now(),
    }
    const outcome = dispatchTranslationUpdate(target, nextTranslation)
    if (!outcome) return
    editTranslationMode = false
    editTranslationTarget = null
    const result = await outcome.dispatched
    if (!isChatWriteCurrent(target.sessionGeneration)) return
    if (saveOperation !== translationEditOperation) return
    if (result && !isSameTranslation(findLiveMessageByTarget(target)?.translation, nextTranslation)) {
      if (isRenderingTranslationMessageTarget(target)) {
        editTranslationMode = true
        editTranslationTarget = target
      }
    }
  }

  // Partial-edit save path for the translation layer. Mirrors the manual
  // translation editor's persistence; a result that trims to nothing removes
  // the translation instead of storing empty text.
  function persistTranslationTextEdit(target: TranslationMessageTarget, nextText: string): void {
    if (!isChatWriteCurrent(target.sessionGeneration)) return
    const existing = liveRawTranslationForTarget(target)
    if (!existing) return
    translationEditOperation += 1
    if (nextText === existing.text) return
    const nextTranslation: MessageTranslation | null =
      nextText.trim().length === 0
        ? null
        : {
            ...existing,
            text: nextText,
            updatedAt: Date.now(),
          }
    // `translated` stays as-is: with the translation removed the display falls
    // back to the original by itself, and a failed save that rolls the
    // translation back then reappears without the user re-toggling.
    dispatchTranslationUpdate(target, nextTranslation)
  }

  async function rm(e: MouseEvent, rec?: boolean) {
    return runChatWriteAction(async (generation) => {
      if (translationInProgress) return
      const messageTarget = captureMessageEditorTarget()
      if (!messageTarget) return
      if (e.shiftKey) {
        await truncateAtMessageTarget(messageTarget)
        return
      }

      const rm = sidebarSettings.askRemoval ? await awaitChatWrite(generation, alertConfirm(language.removeChat)) : true
      if (rm) {
        if (sidebarSettings.instantRemove || rec) {
          const r = await awaitChatWrite(generation, alertConfirm(language.instantRemoveConfirm))
          if (!r) {
            await truncateAtMessageTarget(messageTarget)
          } else {
            deleteMessageAtTarget(messageTarget)
          }
        } else {
          deleteMessageAtTarget(messageTarget)
        }
      }
    })
  }

  async function edit(target: MessageEditorTarget, nextData: string) {
    if (!isChatWriteCurrent(target.sessionGeneration)) return
    const originalText = messageEditOriginalText
    messageEditOriginalText = null
    messageEditTarget = null
    if (originalText !== null && nextData === originalText) return
    if (!isCurrentMessageEditorTarget(target)) return

    const previous = currentChatScopedSnapshot()
    const chat = mutableActiveChatOwner()?.chat
    if (!chat) return
    const liveMessage = chat.message[idx]
    if (!liveMessage || liveMessage.data === nextData) return

    message = nextData
    const messageId = liveMessage.chatId
    const patch = sourceEditPatch(liveMessage, nextData)
    invalidateTranslationUiForSourceEdit(patch)
    if (canUseServerCommands()) {
      if (messageId) {
        observeMessageMutation(dispatchUpdateMessageScoped(messageId, patch, previous))
      } else {
        const nextMessages = cloneMessagesWithIds(chat)
        if (nextMessages[idx]) {
          Object.assign(nextMessages[idx], patch)
          dispatchReplaceMessagesForChat(chat, nextMessages, previous)
        }
      }
      return
    }

    const localMessageId = ensureMessageId(chat.message[idx])
    Object.assign(chat.message[idx], patch)
    observeMessageMutation(dispatchUpdateMessageScoped(localMessageId, patch, previous))
  }

  function handlePartialEditSave(e: CustomEvent<PartialEditSaveDetail>) {
    if (!canChatWrite()) return
    if (idx >= 0) {
      const chat = mutableActiveChatOwner()?.chat
      const liveMessage = chat?.message?.[idx]
      const readMessage = currentLiveMessage()
      if (!liveMessage?.chatId || readMessage?.chatId !== liveMessage.chatId) return
      const liveTranslation = liveMessage?.translation
      const freshness = resolveFreshPartialEditSave(
        e.detail,
        liveMessage && chat
          ? {
              chatIndex: idx,
              chatId: chat.id,
              messageId: liveMessage.chatId,
              data: liveMessage.data,
              translationText:
                liveTranslation?.source === 'raw' && typeof liveTranslation.text === 'string'
                  ? liveTranslation.text
                  : null,
            }
          : null,
      )

      if (!freshness.ok || !chat || !liveMessage) return

      if (freshness.detail.layer === 'translation') {
        const target = captureTranslationMessageTarget()
        if (!target) return
        persistTranslationTextEdit(target, freshness.detail.newData)
        return
      }

      const previous = currentChatScopedSnapshot()
      const nextData = freshness.detail.newData
      message = nextData
      const messageId = liveMessage.chatId
      // A raw translation is tied to the original source text. Keep partial
      // edits consistent with the full-message editor and never display a
      // translation whose source hash belongs to the pre-edit message.
      const patch = sourceEditPatch(liveMessage, nextData)
      invalidateTranslationUiForSourceEdit(patch)
      if (canUseServerCommands()) {
        if (messageId) {
          observeMessageMutation(dispatchUpdateMessageScoped(messageId, patch, previous))
        } else {
          const nextMessages = cloneMessagesWithIds(chat)
          if (nextMessages[idx]) {
            Object.assign(nextMessages[idx], patch)
            dispatchReplaceMessagesForChat(chat, nextMessages, previous)
          }
        }
      } else {
        const localMessageId = ensureMessageId(liveMessage)
        Object.assign(liveMessage, patch)
        observeMessageMutation(dispatchUpdateMessageScoped(localMessageId, patch, previous))
      }
    }
  }

  function getCbsCondition() {
    try {
      const cbsConditions: CbsConditions = {
        firstmsg: firstMessage ?? false,
        chatRole: role ?? null,
      }
      return cbsConditions
    } catch (e) {
      return {
        firstmsg: firstMessage ?? false,
        chatRole: null,
      }
    }
  }

  async function loadTranslationForEdit() {
    if (!canChatWrite()) return
    if (editTranslationMode) return
    const target = captureTranslationMessageTarget()
    if (!target) return
    if (!translationEditorReservation) {
      translationEditorReservation = interactions.acquire()
      if (!translationEditorReservation) return
    }
    translationEditOperation += 1
    suppressAutoPopupTranslationEditor = false
    editTranslationTarget = target
    editTranslationText = liveRawTranslationForTarget(target)?.text ?? activeRawTranslation()?.text ?? ''
    editTranslationMode = true
  }

  async function saveTranslationEdit() {
    if (!canChatWrite()) return
    pendingTranslationEdits += 1
    try {
      await saveServerTranslationEdit()
    } finally {
      pendingTranslationEdits -= 1
    }
  }

  function displaya(message: string) {
    if (!canChatWrite()) {
      msgDisplay = message
      return
    }
    const cbsConditions = getCbsCondition()
    const chara = name
    const chatID = idx
    msgDisplay = untrack(() => {
      return risuChatParser(message, {
        chara,
        chatID,
        rmVar: true,
        visualize: true,
        cbsConditions,
      })
    })
  }

  function chatScriptstateSignature(chat: Chat | undefined): string {
    return JSON.stringify(chat?.scriptstate ?? null)
  }

  const setStatusMessage = (message: string, timeout: number = 0) => {
    statusMessage = message
    if (timeout === 0) return
    setTimeout(() => {
      statusMessage = ''
    }, timeout)
  }

  interface ObservableMessageMutationOutcome {
    status: string
    settlement?: Promise<{ status: string }>
  }

  let messageMutationStatusRun = 0

  function reportMessageMutationFailure(run: number): void {
    if (run === messageMutationStatusRun) setStatusMessage(language.messageMutationFailed)
    alertError(language.messageMutationFailed)
  }

  function settleObservedMessageMutation(run: number, outcome: ObservableMessageMutationOutcome): void {
    if (outcome.status === 'accepted' || outcome.status === 'ok') {
      if (run === messageMutationStatusRun) setStatusMessage('')
      return
    }
    if (outcome.status === 'queued' && outcome.settlement) {
      if (run === messageMutationStatusRun) setStatusMessage(language.messageMutationQueued)
      alertNormal(language.messageMutationQueued)
      void outcome.settlement.then(
        (settlement) => {
          if (settlement.status === 'accepted') {
            if (run === messageMutationStatusRun) setStatusMessage('')
            return
          }
          reportMessageMutationFailure(run)
        },
        () => reportMessageMutationFailure(run),
      )
      return
    }
    reportMessageMutationFailure(run)
  }

  function observeMessageMutation(outcome: Promise<ObservableMessageMutationOutcome> | null | undefined): void {
    const run = ++messageMutationStatusRun
    if (!outcome) {
      reportMessageMutationFailure(run)
      return
    }
    setStatusMessage(language.messageMutationPending)
    void outcome.then(
      (settled) => settleObservedMessageMutation(run, settled),
      () => reportMessageMutationFailure(run),
    )
  }

  function reportStaleMessageMutation(): void {
    messageMutationStatusRun += 1
    setStatusMessage(language.messageMutationStale)
    alertError(language.messageMutationStale)
  }

  let blankMessage = $derived(
    ((message === '{{none}}' || message === '{{blank}}' || message === '') && idx === -1) || isComment,
  )
  let showSenderIdentity = $derived(!isComment)
  const hideSenderIdentity = $derived(
    renderOwners.settings
      ? renderCharacter?.hideChatIcon === true ||
          resolveActiveModuleStates(renderOwners.settings() as Database, renderCharacter, renderOwners.chat()).some(
            ({ module }) => module.hideIcon,
          )
      : $HideIconStore,
  )
  let currentChatId = $derived(currentLiveChat()?.id ?? '')
  let currentDisplayChatId = $derived(displayChatId ?? (idx < 0 ? currentChatId : ''))
  let ownerMessage = $derived(currentLiveMessage() ?? undefined)
  let messageRowId = $derived(ownerMessage?.chatId ?? '')
  let renderChatId = $derived(currentChatId)
  let hasActiveAgentPresetProgress = $derived(
    $agentPresetProgress.some((progress) => progress.chatId === (renderChatId || currentChatId)),
  )
  let serverTranslationJob = $derived.by(() => {
    const target = captureRawTranslationTarget()
    if (!target) return undefined
    if (target.kind === 'message') {
      return $activeMessageTranslations.find(
        (job) => job.messageId === target.messageId && job.chatId === target.chatId,
      )
    }
    const projection = getGreetingTranslationProjection(target.characterId, target.chatId)
    if (!projection?.settingsHash || projection.clientSettingsSignature !== target.clientSettingsSignature) {
      return undefined
    }
    return $activeGreetingTranslations.find(
      (job) =>
        job.characterId === target.characterId &&
        job.chatId === target.chatId &&
        job.greetingIndex === target.greetingIndex &&
        job.settingsHash === projection.settingsHash,
    )
  })
  let serverTranslationInProgress = $derived(serverTranslationJob?.status === 'running')
  let translationInProgress = $derived(
    serverTranslationInProgress ||
      (translating &&
        (!activeRawTranslationRequestTarget || isRenderingRawTranslationTarget(activeRawTranslationRequestTarget))),
  )
  let sawServerTranslationInProgress = $state(false)
  let displayMessage = $derived.by(() => {
    const rawTranslation = activeRawTranslation()
    if (!translated || !rawTranslation) return message
    const liveChat = currentLiveChat()
    if (liveChat?.bilingualDisplay !== true) return rawTranslation.text

    const paragraphBreakBySentences = displaySettings.paragraphBreakBySentences ?? false
    const paragraphBreakSentenceCount = displaySettings.paragraphBreakSentenceCount ?? 3
    return bilingualInterleave(message, rawTranslation.text, {
      emphasize: liveChat.bilingualEmphasis ?? 'original',
      sentenceBreaks: paragraphBreakBySentences ? { sentencesPerParagraph: paragraphBreakSentenceCount } : undefined,
    })
  })
  let displaySourceLayer = $derived(
    !translated
      ? ('original' as const)
      : currentLiveChat()?.bilingualDisplay === true
        ? ('bilingual' as const)
        : ('translation' as const),
  )
  // Partial edit routes each edited block to the text layer it renders from;
  // these mirror the displayMessage branches above.
  let partialEditTranslationText = $derived.by(() => {
    if (!translated) return null
    return activeRawTranslation()?.text ?? null
  })
  let partialEditBilingualActive = $derived(
    partialEditTranslationText !== null && currentLiveChat()?.bilingualDisplay === true,
  )
  let normalizedGenerationPhase = $derived(
    normalizeChatGenerationLoadingPhase(generationPhase ?? chatGenerationLoadingPhaseFromStage(generationStage)),
  )
  let generationLoadingText = $derived(language[getChatGenerationLoadingLanguageKey(normalizedGenerationPhase)])
  let generationClock = $state(Date.now())
  $effect(() => {
    if (!isGenerationLoading || generationStartedAt === undefined) return
    generationClock = Date.now()
    const timer = setInterval(() => {
      generationClock = Date.now()
    }, 1_000)
    return () => clearInterval(timer)
  })
  let generationElapsedSeconds = $derived(
    generationStartedAt === undefined ? 0 : Math.max(0, Math.floor((generationClock - generationStartedAt) / 1_000)),
  )
  let halfStreamingLoadingText = $derived(
    halfStreamingTokensPerSecond === undefined
      ? undefined
      : [
          language.halfStreamingTokensPerSecond(halfStreamingTokensPerSecond),
          ...(halfStreamingGeneratedTokens === undefined
            ? []
            : [language.halfStreamingGeneratedTokens(halfStreamingGeneratedTokens)]),
        ].join(' · '),
  )
  let generationPersistenceStatusText = $derived.by(() => {
    switch (generationPersistenceState) {
      case 'queued':
        return language.generationPersistenceQueued
      case 'stalled':
        return language.generationPersistenceStalled
      case 'terminal':
        return language.generationPersistenceTerminal
      case 'stalled_legacy':
        return language.generationPersistenceStalledLegacy
      default:
        return ''
    }
  })

  function ownsSucceededServerTranslation(
    jobId: string,
    target: TranslationMessageTarget,
    isCancelled: () => boolean,
  ): boolean {
    const job = serverTranslationJob
    return (
      isChatWriteCurrent(target.sessionGeneration) &&
      !isCancelled() &&
      !!job &&
      'messageId' in job &&
      job?.jobId === jobId &&
      job.status === 'succeeded' &&
      job.chatId === target.chatId &&
      job.messageId === target.messageId &&
      isRenderingTranslationMessageTarget(target)
    )
  }

  function ownsSucceededGreetingTranslation(
    jobId: string,
    target: Extract<RawTranslationTarget, { kind: 'greeting' }>,
    settingsHash: string,
    isCancelled: () => boolean,
  ): boolean {
    const job = serverTranslationJob
    return (
      isChatWriteCurrent(target.sessionGeneration) &&
      !isCancelled() &&
      !!job &&
      'characterId' in job &&
      job.jobId === jobId &&
      job.status === 'succeeded' &&
      job.characterId === target.characterId &&
      job.chatId === target.chatId &&
      job.greetingIndex === target.greetingIndex &&
      job.settingsHash === settingsHash &&
      isRenderingRawTranslationTarget(target)
    )
  }

  async function restoreSucceededServerTranslation(
    jobId: string,
    target: TranslationMessageTarget,
    isCancelled: () => boolean,
  ): Promise<void> {
    if (!target.chatId || !ownsSucceededServerTranslation(jobId, target, isCancelled)) return

    const displayAppliedTranslation = (): boolean => {
      if (!ownsSucceededServerTranslation(jobId, target, isCancelled)) return false
      if (!liveRawTranslationForTarget(target)) return false
      translated = true
      clearMessageTranslationJob(jobId)
      return true
    }

    if (displayAppliedTranslation()) return

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await hydrateChatMessages(target.chatId, { force: true, strict: true })
      } catch {
        if (!ownsSucceededServerTranslation(jobId, target, isCancelled)) return
        continue
      }
      if (displayAppliedTranslation()) return
      if (!ownsSucceededServerTranslation(jobId, target, isCancelled)) return
    }
  }

  async function restoreSucceededGreetingTranslation(
    jobId: string,
    target: Extract<RawTranslationTarget, { kind: 'greeting' }>,
    settingsHash: string,
    isCancelled: () => boolean,
  ): Promise<void> {
    if (!ownsSucceededGreetingTranslation(jobId, target, settingsHash, isCancelled)) return
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refreshed = await refreshGreetingTranslationProjection(target.characterId, target.chatId, {
        clientSettingsSignature: target.clientSettingsSignature,
      })
      if (!ownsSucceededGreetingTranslation(jobId, target, settingsHash, isCancelled)) return
      if (refreshed.status !== 'ok' || !activeRawTranslation()) continue
      translated = true
      clearGreetingTranslationJob(jobId)
      return
    }
  }

  let lastRawTranslationTargetKey = ''
  $effect(() => {
    const target = captureRawTranslationTarget()
    const nextKey = target ? JSON.stringify(target) : ''
    if (lastRawTranslationTargetKey && nextKey !== lastRawTranslationTargetKey) {
      translationEditOperation += 1
      translated = false
      suppressAutomaticTranslationDisplay = false
      editTranslationMode = false
      editTranslationTarget = null
      sawServerTranslationInProgress = false
    }
    lastRawTranslationTargetKey = nextKey
  })

  $effect(() => {
    if (automaticTranslationDisplayEnabled() && activeRawTranslation() && !suppressAutomaticTranslationDisplay) {
      translated = true
    }
  })

  $effect(() => {
    void interactionAvailability
    if (!writeActionsAllowed) return
    if (!autoTranslateOnReady || automaticTranslationEligibilityConsumed) return
    if (!automaticTranslationRequestEnabled()) {
      consumeAutomaticTranslationEligibility()
      return
    }
    if (idx < 0 || isComment) {
      consumeAutomaticTranslationEligibility()
      return
    }
    if (activeRawTranslation()) {
      consumeAutomaticTranslationEligibility()
      return
    }
    const liveChat = currentLiveChat()
    if (liveChat?.isStreaming || isChatGenerating || isGenerationLoading || translationInProgress) return
    if (message.trim().length === 0) {
      consumeAutomaticTranslationEligibility()
      return
    }
    if (!canTranslateRawTarget()) {
      consumeAutomaticTranslationEligibility()
      return
    }
    if (languageSettings.autoTranslateCachedOnly && languageSettings.translatorType === 'llm') {
      consumeAutomaticTranslationEligibility()
      return
    }

    const release = untrack(() => interactions.acquire(false))
    if (!release) return
    consumeAutomaticTranslationEligibility()
    void requestServerRawTranslation(undefined, release)
  })

  $effect(() => {
    const job = serverTranslationJob
    if (!writeActionsAllowed) return
    if (serverTranslationInProgress) {
      sawServerTranslationInProgress = true
      return
    }
    if (job?.status === 'failed') {
      translated = false
      setStatusMessage(language.playground.translationRunFailed(job.error ?? 'Translation failed'), 5000)
      if ('messageId' in job) clearMessageTranslationJob(job.jobId)
      else clearGreetingTranslationJob(job.jobId)
      sawServerTranslationInProgress = false
      return
    }
    if (job?.status === 'succeeded') {
      let cancelled = false
      if ('messageId' in job) {
        const target = {
          chatId: job.chatId,
          messageId: job.messageId,
          sessionGeneration: captureClientSessionGeneration(),
        }
        void restoreSucceededServerTranslation(job.jobId, target, () => cancelled)
      } else {
        const target = captureRawTranslationTarget()
        if (target?.kind === 'greeting') {
          void restoreSucceededGreetingTranslation(job.jobId, target, job.settingsHash, () => cancelled)
        }
      }
      sawServerTranslationInProgress = false
      return () => {
        cancelled = true
      }
    }
    if (sawServerTranslationInProgress && activeRawTranslation()) {
      translated = true
    }
    sawServerTranslationInProgress = false
  })

  $effect.pre(() => {
    const reloadEpoch = $ReloadGUIPointer
    const moduleRevision = $moduleRenderRevision
    const chatReloadEpoch = $ReloadChatPointer[idx] ?? 0
    const variableReloadEpoch = idx < 0 ? $VariableReloadGUIPointer : 0
    const displayParseKey = JSON.stringify([
      displayMessage,
      writeActionsAllowed,
      name,
      idx,
      role,
      firstMessage,
      currentDisplayChatId,
      reloadEpoch,
      moduleRevision,
      chatReloadEpoch,
      variableReloadEpoch,
    ])
    if (displayParseKey !== lastDisplayParseKey) {
      lastDisplayParseKey = displayParseKey
      displaya(displayMessage)
    }
  })

  function RenderGUIHtml(html: string, cacheScopeKey: string) {
    if (!writeActionsAllowed) return new DOMParser().parseFromString(html, 'text/html').body
    return renderCustomHtmlTemplate(html, getCbsCondition(), cacheScopeKey)
  }

  function hasCustomHtmlTemplate(html: unknown): html is string {
    return typeof html === 'string' && html.trim().length > 0
  }

  function readerMarkupAttributes(dom: HTMLElement) {
    if (writeActionsAllowed || !hasExecutableMarkupAction(dom)) return {}
    return {
      'data-reader-script-control': '',
      'aria-disabled': 'true' as const,
      title: language.connectedReaders.writeAccessRequired,
      'aria-description': language.connectedReaders.writeAccessRequired,
      tabindex: -1,
    }
  }

  function getRisuButtonAttributes(dom: HTMLElement) {
    const attributes: Record<string, string> = {}

    for (const attr of ['risu-trigger', 'risu-btn', 'risu-id']) {
      const value = dom.getAttribute(attr)
      if (value !== null) {
        attributes[attr] = value
      }
    }

    return attributes
  }

  function readChatButtonTriggerLiveTarget(identity: ChatButtonTriggerIdentity): ChatButtonTriggerTarget | null {
    const owner = mutableActiveChatOwner()
    if (!owner) return null
    const { character, chat } = owner
    const selectedCharacterIndex = mutableChatOwnerRows().indexOf(character)
    const chatPage = character.chats.indexOf(chat)
    if (selectedCharacterIndex < 0 || chatPage < 0) return null

    const messages = chat.message ?? []
    const sourceMessage = idx >= 0 ? messages[idx] : undefined
    if (idx >= 0 && !sourceMessage) {
      return null
    }
    const readMessage = idx >= 0 ? currentLiveMessage() : null
    if (idx >= 0 && (!readMessage?.chatId || sourceMessage?.chatId !== readMessage.chatId)) return null
    const tailMessage = messages.at(-1)

    return {
      selectedCharacterIndex,
      characterId: character.chaId,
      chatPage,
      chatId: chat.id,
      messageIndex: idx,
      messageId: sourceMessage?.chatId,
      messageData: sourceMessage?.data ?? null,
      messageRole: sourceMessage?.role ?? null,
      transcriptLength: messages.length,
      tailMessageId: tailMessage?.chatId,
      tailMessageData: tailMessage?.data ?? null,
      tailMessageRole: tailMessage?.role ?? null,
      chatStateSignature: chatButtonTriggerChatSignature(chat),
      triggerName: identity.triggerName,
      triggerId: identity.triggerId,
      btnEvent: identity.btnEvent,
    }
  }

  function captureChatButtonTriggerTarget(identity: ChatButtonTriggerIdentity): CapturedChatButtonTriggerTarget | null {
    const liveTarget = readChatButtonTriggerLiveTarget(identity)
    if (!liveTarget) {
      return null
    }

    if (!liveTarget.characterId || !liveTarget.chatId) return null
    const owner = mutableChatOwnerById(liveTarget.characterId, liveTarget.chatId)
    if (!owner) return null
    const { chat } = owner

    return {
      sessionGeneration: captureClientSessionGeneration(),
      snapshot: captureChatButtonTriggerFreshness(liveTarget, renderedChatButtonTriggerOperationTracker),
      previous: {
        selectedCharID: liveTarget.selectedCharacterIndex,
        characterId: liveTarget.characterId ?? undefined,
        chatId: liveTarget.chatId ?? undefined,
        chat: cloneJsonValue(chat) as Chat,
      },
    }
  }

  function isChatButtonTriggerTargetFresh(target: CapturedChatButtonTriggerTarget): boolean {
    if (!isChatWriteCurrent(target.sessionGeneration)) return false
    const liveTarget = readChatButtonTriggerLiveTarget(target.snapshot)
    if (!liveTarget) {
      return false
    }

    return resolveChatButtonTriggerFreshness(target.snapshot, liveTarget, renderedChatButtonTriggerOperationTracker).ok
  }

  function isChatButtonTriggerTargetCurrentAfterHydration(target: CapturedChatButtonTriggerTarget): boolean {
    if (!isChatWriteCurrent(target.sessionGeneration)) return false
    const liveTarget = readChatButtonTriggerLiveTarget(target.snapshot)
    if (!liveTarget) {
      return false
    }

    return resolveChatButtonTriggerTargetAfterHydration(
      target.snapshot,
      liveTarget,
      renderedChatButtonTriggerOperationTracker,
    ).ok
  }

  function applyFreshChatButtonTriggerResult(target: CapturedChatButtonTriggerTarget, nextChat: Chat): boolean {
    if (!isChatButtonTriggerTargetFresh(target)) {
      return false
    }

    const nextChatSnapshot = cloneJsonValue(nextChat) as Chat
    if (!target.snapshot.characterId || !target.snapshot.chatId) return false
    const owner = mutableChatOwnerById(target.snapshot.characterId, target.snapshot.chatId)
    const character = owner?.character
    const chatIndex = owner && character ? character.chats.indexOf(owner.chat) : -1
    if (!character || chatIndex < 0) return false

    character.chats[chatIndex] = nextChatSnapshot
    dispatchCompatibleChatUpdateScoped(target.previous.chat, nextChatSnapshot, target.previous)
    return true
  }

  async function handleButtonTriggerWithin(event: UIEvent) {
    if (denyReaderScriptActivation(event, canChatWrite())) return
    const target = event.target instanceof Element ? event.target : null
    const origin = target?.closest('[risu-trigger], [risu-btn]')
    if (!origin) return
    return runChatWriteAction(async (generation) => {
      const triggerName = origin.getAttribute('risu-trigger')
      const triggerId = origin.getAttribute('risu-id')
      const btnEvent = origin.getAttribute('risu-btn')
      const identity = {
        triggerName,
        triggerId,
        btnEvent,
      }
      const hydrationTarget = captureChatButtonTriggerTarget(identity)
      if (!hydrationTarget) {
        return
      }
      const triggerDisplayGeneration = triggerName ? ++manualTriggerDisplayGeneration : null

      try {
        if (canUseServerCommands()) {
          if (!hydrationTarget.snapshot.chatId) {
            alertError(language.chatDataLoadFailed)
            return
          }
          try {
            await awaitChatWrite(generation, hydrateChatMessages(hydrationTarget.snapshot.chatId, { strict: true }))
          } catch {
            if (isChatButtonTriggerTargetCurrentAfterHydration(hydrationTarget)) {
              alertError(language.chatDataLoadFailed)
            }
            return
          }
        }

        if (!isChatButtonTriggerTargetCurrentAfterHydration(hydrationTarget)) {
          return
        }
        const triggerTarget = captureChatButtonTriggerTarget(identity)
        if (!triggerTarget?.snapshot.characterId || !triggerTarget.snapshot.chatId) {
          return
        }
        const triggerOwner = mutableChatOwnerById(triggerTarget.snapshot.characterId, triggerTarget.snapshot.chatId)
        if (!triggerOwner) return
        const currentChar = triggerOwner.character

        let triggerResult = null
        if (triggerName) {
          const triggerController = createManualTriggerAbortController()
          try {
            triggerResult = await runTrigger(currentChar, 'manual', {
              chat: triggerTarget.previous.chat ?? triggerOwner.chat,
              manualName: triggerName,
              triggerId: triggerId || undefined,
              signal: triggerController.signal,
              isFresh: () => isChatButtonTriggerTargetFresh(triggerTarget),
              deferLiveChatSideEffects: true,
            })
          } finally {
            clearManualTriggerAbortController(triggerController)
          }
        } else if (btnEvent) {
          triggerResult = await runLuaButtonTrigger(currentChar, btnEvent, {
            chat: triggerTarget.previous.chat,
            isFresh: () => isChatButtonTriggerTargetFresh(triggerTarget),
            deferLiveChatSideEffects: true,
          })
        }

        if (triggerResult?.chat && applyFreshChatButtonTriggerResult(triggerTarget, triggerResult.chat)) {
          if (chatScriptstateSignature(triggerTarget.previous.chat) !== chatScriptstateSignature(triggerResult.chat)) {
            refreshVariableOnlyGui()
          }
          ReloadChatPointer.update((v) => {
            v[idx] = (v[idx] ?? 0) + 1
            return v
          })
        }
      } finally {
        if (triggerName && triggerId) {
          setTimeout(() => {
            if (!isChatWriteCurrent(generation) || manualTriggerDisplayGeneration !== triggerDisplayGeneration) return
            CurrentTriggerIdStore.update((currentTriggerId) =>
              currentTriggerId === triggerId ? null : currentTriggerId,
            )
          }, 100) // Small delay to allow display mode to complete
        }
      }
    })
  }

  let isBookmarked = $derived(
    currentLiveChat()?.bookmarks?.includes(ownerMessage?.chatId ?? currentLiveMessage()?.chatId ?? '') ?? false,
  )

  async function toggleBookmark() {
    return runChatWriteAction(async (generation) => {
      const previous = currentChatScopedSnapshot()
      const chat = mutableActiveChatOwner()?.chat

      const readMessage = currentLiveMessage()
      if (!chat?.message[idx]?.chatId || readMessage?.chatId !== chat.message[idx].chatId) return
      if (reportWriterAccessLostMutation()) return

      const useServerCommands = canUseServerCommands()
      const nextMessages = useServerCommands ? cloneMessagesWithIds(chat) : null
      let messageId = useServerCommands ? nextMessages?.[idx]?.chatId : chat.message[idx]?.chatId
      const messageContent = chat.message[idx]?.data ?? ''
      const hadMessageId = Boolean(chat.message[idx]?.chatId)

      if (!messageId) {
        messageId = uuidv4()
        if (!useServerCommands) {
          chat.message[idx].chatId = messageId
        }
      }

      const bookmarks = [...(chat.bookmarks ?? [])]
      const bookmarkNames = { ...(chat.bookmarkNames ?? {}) }

      const bookmarkIndex = bookmarks.indexOf(messageId)

      if (bookmarkIndex > -1) {
        bookmarks.splice(bookmarkIndex, 1)
        delete bookmarkNames[messageId]
      } else {
        bookmarks.push(messageId)

        const msgSender = chat.message[idx]?.role === 'user' ? name || getUserDisplayName() : name
        const newName = await awaitChatWrite(
          generation,
          alertInput(language.bookmarkAskNameOrDefault, [], bookmarkNames[messageId] || ''),
        )

        if (newName && newName.trim() !== '') {
          bookmarkNames[messageId] = newName
        } else {
          let defaultName

          const blacklist = [
            '!',
            '@',
            '#',
            '$',
            '%',
            '^',
            '&',
            '*',
            '(',
            ')',
            '_',
            '+',
            '-',
            '=',
            '[',
            ']',
            '{',
            '}',
            '|',
            ';',
            ':',
            '"',
            "'",
            ',',
            '.',
            '<',
            '>',
            '/',
            '?',
          ]
          let lines = messageContent.split('\n')
          lines = lines.splice(Math.floor(lines.length * 0.5))
          for (const line of lines) {
            if (line && !blacklist.some((char) => line.startsWith(char))) {
              defaultName = line.trim().slice(0, 50) + '...'
              break
            }
          }
          if (!defaultName) {
            defaultName = messageContent.slice(0, 50) + '...'
          }
          bookmarkNames[messageId] = msgSender + '| ' + defaultName
        }
      }

      if (!useServerCommands) {
        if (!hadMessageId) {
          chat.message[idx].chatId = messageId
        }
        chat.bookmarks = [...bookmarks]
        chat.bookmarkNames = bookmarkNames
      }
      if (!hadMessageId && chat.id) {
        dispatchReplaceMessagesForChat(chat, useServerCommands && nextMessages ? nextMessages : chat.message, previous)
      }
      if (useServerCommands && !applyOptimisticBookmarkMetadata(previous, messageId, bookmarks, bookmarkNames)) {
        reportStaleMessageMutation()
        return
      }
      if (chat.id) {
        observeMessageMutation(
          dispatchUpdateChatScopedWithOutcome(
            chat.id,
            {
              bookmarks,
              bookmarkNames,
            },
            previous,
            restoreChatRowMetadata,
          ),
        )
      }
    })
  }
</script>

{#snippet genInfo()}
  {#if !isGenerationLoading}
    <div class="flex flex-wrap justify-end items-center">
      {#if messageGenerationInfo && (sidebarSettings.requestInfoInsideChat || aiLawApplies())}
        <button
          class="text-sm p-1 text-textcolor2 border-darkborderc float-end mr-2 my-1
                    hover:ring-darkbutton hover:ring-3 rounded-md hover:text-textcolor transition-all flex justify-center items-center"
          onclick={() => {
            const currentGenerationInfo = idx >= 0 ? ownerMessage?.generationInfo : messageGenerationInfo

            alertRequestData({
              genInfo: currentGenerationInfo,
              idx: idx,
              characterId: renderOwners.character()?.chaId,
              chatId: currentLiveChat()?.id,
              messageId: ownerMessage?.chatId,
            })
          }}>
          <BotIcon size={20} />
          <span class="ml-1">
            {capitalize(getModelInfo(messageGenerationInfo.model).shortName)}
          </span>
        </button>
      {/if}
      {#if canTranslateRawTarget() && translated && !translationInProgress}
        <button
          class="text-sm p-1 text-textcolor2 border-darkborderc float-end mr-2 my-1
                            hover:ring-darkbutton hover:ring-3 rounded-md hover:text-textcolor transition-all flex justify-center items-center"
          onclick={confirmServerRawRetranslation}>
          <RefreshCcwIcon size={20} />
          <span class="ml-1">
            {language.retranslate}
          </span>
        </button>
        {#if canEditPersistedTranslation()}
          <button
            class={'text-sm p-1 border-darkborderc float-end mr-2 my-1 hover:ring-darkbutton hover:ring-3 rounded-md hover:text-textcolor transition-all flex justify-center items-center ' +
              (editTranslationMode ? 'text-blue-400' : 'text-textcolor2')}
            onclick={() => {
              if (editTranslationMode) {
                saveTranslationEdit()
              } else {
                loadTranslationForEdit()
              }
            }}>
            <PencilIcon size={20} />
            <span class="ml-1">
              {editTranslationMode ? language.editTranslationSave : language.editTranslation}
            </span>
          </button>
        {/if}
      {:else if writeActionsAllowed && !hasServerRawTranslationTarget() && languageSettings.translatorType === 'llm' && translated && !translationInProgress}
        <button
          class="text-sm p-1 text-textcolor2 border-darkborderc float-end mr-2 my-1
                            hover:ring-darkbutton hover:ring-3 rounded-md hover:text-textcolor transition-all flex justify-center items-center"
          onclick={confirmClientRetranslation}>
          <RefreshCcwIcon size={20} />
          <span class="ml-1">
            {language.retranslate}
          </span>
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet generationLoading(projection: boolean, compact = false)}
  <div
    class="chat-generation-loading w-full"
    class:chat-generation-loading-compact={compact}
    role="status"
    aria-live="polite"
    aria-busy="true"
    data-generation-projection-loading={projection ? '' : undefined}>
    <div class="chat-generation-loading-header">
      <LoaderCircleIcon size={16} class="risu-ongoing-pulse animate-spin shrink-0" aria-hidden="true" />
      <span>{halfStreamingLoadingText ?? generationLoadingText}</span>
      {#if generationElapsedSeconds >= 3}
        <span class="chat-generation-loading-elapsed" aria-hidden="true">
          · {language.chatGenerationElapsed(generationElapsedSeconds)}
        </span>
      {/if}
    </div>
    {#if halfStreamingLoadingText === undefined && !compact}
      <div class="chat-generation-loading-track" aria-hidden="true">
        <div
          class={`risu-ongoing-pulse chat-generation-loading-fill chat-generation-loading-phase-${normalizedGenerationPhase}`}>
        </div>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet textBox()}
  {#if writeActionsAllowed && editTranslationMode && !isGenerationLoading}
    <AutoresizeArea
      bind:value={editTranslationText}
      ariaLabel={language.editTranslation}
      popupEditor
      stableHeight={useStableTranslationEditor}
      handleLongPress={() => {
        saveTranslationEdit()
      }} />
  {:else if writeActionsAllowed && editMode && !isGenerationLoading}
    <AutoresizeArea
      bind:value={messageEditText}
      ariaLabel={language.messageInput}
      popupEditor
      stableHeight={useStableMessageEditor}
      handleLongPress={() => {
        void saveMessageEdit()
      }} />
  {:else if isComment}
    <div class="w-full flex justify-center text-textcolor2 italic mb-12">
      {#if msgDisplay.startsWith('{{specialcomment')}
        {@const branchReference = parseBranchComment(msgDisplay)}

        {#if branchReference}
          <button
            class="text-blue-500 hover:underline"
            onclick={() => {
              void openBranchSource(branchReference)
            }}>
            <GitBranch size={20} class="inline-block mr-1" />
            {language.branchedText.replace('{}', branchReference.sourceChatName)}
          </button>
        {/if}
      {:else}
        {msgDisplay}
      {/if}
    </div>
  {:else if isGenerationLoading && (!isGenerationProjection || message.length === 0)}
    {#if !hasActiveAgentPresetProgress || generationPresentationMode === 'regenerate'}
      {@render generationLoading(isGenerationProjection)}
    {/if}
  {:else if blankMessage}
    <div class="w-full flex justify-center text-textcolor2 italic mb-12">
      {language.noMessage}
    </div>
  {:else}
    {@const variableReloadPointer = idx < 0 ? $VariableReloadGUIPointer : 0}
    {@const chatReloadPointer = `${$ReloadGUIPointer}|${$moduleRenderRevision}|${$ReloadChatPointer[idx] ?? 0}|${variableReloadPointer}`}
    {@const chatScopePointer = currentDisplayChatId}
    {@const totalLengthPointer = idx > totalLength - 6 ? totalLength : 0}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <span
      class="text chat-width chat-message-body chattext prose minw-0"
      class:prose-invert={$ColorSchemeTypeStore}
      bind:this={bodyRoot}
      onclick={handleMessageBodyClick}
      style:font-size="{0.875 * ((displaySettings.zoomsize ?? 100) / 100)}rem"
      style:line-height="{(displaySettings.lineHeight ?? 1.25) * ((displaySettings.zoomsize ?? 100) / 100)}rem">
      {#key `${chatScopePointer}|${displayMessageId ?? messageRowId ?? idx}`}
        {#if hasServerRawTranslationTarget()}
          <ChatBody
            {character}
            readOnly={!writeActionsAllowed}
            {firstMessage}
            {idx}
            chatId={currentDisplayChatId || undefined}
            {msgDisplay}
            {name}
            messageId={(displayMessageId ?? messageRowId) || undefined}
            displayLayer={displaySourceLayer}
            streaming={isChatGenerating && idx === totalLength - 1 && role === 'char'}
            {displayPriority}
            parseRevision={`${totalLengthPointer}|${chatReloadPointer}`}
            {bodyRoot}
            modelShortName={messageGenerationInfo ? getModelInfo(messageGenerationInfo?.model).shortName : ''}
            role={role ?? null}
            translated={false}
            bind:translating
            retranslate={false}
            allowClientTranslation={false}
            {onInitialDisplayParseStart}
            {onInitialDisplayParseSettled} />
        {:else}
          <ChatBody
            {character}
            readOnly={!writeActionsAllowed}
            {firstMessage}
            {idx}
            chatId={currentDisplayChatId || undefined}
            {msgDisplay}
            {name}
            messageId={(displayMessageId ?? messageRowId) || undefined}
            displayLayer={displaySourceLayer}
            streaming={isChatGenerating && idx === totalLength - 1 && role === 'char'}
            {displayPriority}
            parseRevision={`${totalLengthPointer}|${chatReloadPointer}`}
            {bodyRoot}
            modelShortName={messageGenerationInfo ? getModelInfo(messageGenerationInfo?.model).shortName : ''}
            role={role ?? null}
            bind:translated
            bind:translating
            bind:retranslate
            allowClientTranslation={writeActionsAllowed &&
              idx < 0 &&
              languageSettings.translator !== '' &&
              languageSettings.translatorType !== 'none'}
            {onInitialDisplayParseStart}
            {onInitialDisplayParseSettled} />
        {/if}
      {/key}
      {#if writeActionsAllowed && idx >= 0 && !editMode && !translationInProgress && !isGenerationProjection && partialEditEnabled && (sidebarSettings.enableBlockPartialEdit || sidebarSettings.enableDragPartialEdit)}
        <PartialEditController
          messageData={message}
          chatIndex={idx}
          chatId={currentChatId || undefined}
          messageId={messageRowId || undefined}
          {bodyRoot}
          blockEditEnabled={sidebarSettings.enableBlockPartialEdit}
          dragEditEnabled={sidebarSettings.enableDragPartialEdit}
          translationText={partialEditTranslationText}
          bilingualActive={partialEditBilingualActive}
          on:save={handlePartialEditSave} />
      {/if}
    </span>
    {#if isGenerationLoading && isGenerationProjection && (!hasActiveAgentPresetProgress || generationPresentationMode === 'regenerate')}
      {@render generationLoading(true, true)}
    {:else if halfStreamingLoadingText !== undefined && isChatGenerating}
      <div class="chat-generation-loading w-full" role="status" aria-live="polite" aria-busy="true">
        <div class="chat-generation-loading-header">
          <LoaderCircleIcon size={16} class="risu-ongoing-pulse animate-spin shrink-0" />
          <span>{halfStreamingLoadingText}</span>
        </div>
      </div>
    {/if}
  {/if}
{/snippet}

{#snippet iconButtons(options: { applyTextColors?: boolean } = {})}
  <div class="grow flex items-center justify-end" class:text-textcolor2={options?.applyTextColors !== false}>
    {#if isComment && writeActionsAllowed}
      <button
        data-risu-message-action="remove"
        aria-label={language.remove}
        class={'flex items-center hover:text-blue-500 transition-colors button-icon-remove ' +
          (translationInProgress ? ' cursor-not-allowed opacity-50' : '')}
        disabled={translationInProgress}
        onclick={async (e) => {
          if (translationInProgress) return
          await rm(e, true)
        }}>
        <TrashIcon size={20} />
      </button>
    {:else if !isGenerationLoading || (readOnly && isGenerationProjection && message.length > 0)}
      <span class="text-xs" aria-live="polite">{statusMessage}</span>
      <div class="flex items-center ml-2 gap-2">
        {@render translationButton()}
        {#if $SizeStore.w >= 640 || !writeActionsAllowed}
          {@render majorIconButtonsBody(false)}
          {#if writeActionsAllowed && renderCharacter && idx > -1}
            <PopupButton>
              {@render minorIconButtonsBody(true)}
            </PopupButton>
          {/if}
        {:else if renderCharacter}
          <PopupButton>
            {@render majorIconButtonsBody(true)}
            {#if writeActionsAllowed && idx > -1}
              {@render minorIconButtonsBody(true)}
            {/if}
          </PopupButton>
        {:else}
          {@render majorIconButtonsBody(false)}
        {/if}
        {@render rerolls()}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet majorIconButtonsBody(showNames: boolean)}
  {#if displaySettings.useChatCopy && !blankMessage}
    <button
      data-risu-message-action="copy"
      aria-label={language.copy}
      class="flex items-center hover:text-blue-500 transition-colors button-icon-copy"
      onclick={async () => {
        if (!canChatWrite()) {
          try {
            await window.navigator.clipboard.writeText(msgDisplay)
            setStatusMessage(language.copied)
          } catch {}
          return
        }
        return runChatWriteAction(async (generation) => {
          if (window.navigator.clipboard.write) {
            try {
              alertWait(language.loading)
              const root = document.querySelector(':root') as HTMLElement

              const parser = new DOMParser()
              const doc = parser.parseFromString(
                await awaitChatWrite(
                  generation,
                  ParseMarkdown(msgDisplay, renderCharacter, 'normal', idx, getCbsCondition(), {
                    chatId: currentDisplayChatId || undefined,
                    messageId: (displayMessageId ?? messageRowId) || undefined,
                  }),
                ),
                'text/html',
              )

              doc.querySelectorAll('mark').forEach((el) => {
                const d = el.getAttribute('risu-mark')
                if (d === 'quote1' || d === 'quote2') {
                  const newEle = document.createElement('div')
                  newEle.textContent = el.textContent
                  newEle.setAttribute(
                    'style',
                    `background: transparent; color: ${root.style.getPropertyValue('--FontColorQuote' + d.slice(-1))};`,
                  )
                  el.replaceWith(newEle)
                  return
                }
              })
              doc.querySelectorAll('p').forEach((el) => {
                el.setAttribute('style', `color: ${root.style.getPropertyValue('--FontColorStandard')};`)
              })
              doc.querySelectorAll('em').forEach((el) => {
                el.setAttribute(
                  'style',
                  `font-style: italic; color: ${root.style.getPropertyValue('--FontColorItalic')};`,
                )
              })
              doc.querySelectorAll('strong').forEach((el) => {
                el.setAttribute('style', `font-weight: bold; color: ${root.style.getPropertyValue('--FontColorBold')};`)
              })
              doc.querySelectorAll('em strong').forEach((el) => {
                el.setAttribute(
                  'style',
                  `font-weight: bold; font-style: italic; color: ${root.style.getPropertyValue('--FontColorItalicBold')};`,
                )
              })
              doc.querySelectorAll('strong em').forEach((el) => {
                el.setAttribute(
                  'style',
                  `font-weight: bold; font-style: italic; color: ${root.style.getPropertyValue('--FontColorItalicBold')};`,
                )
              })

              const imgs = doc.querySelectorAll('img')
              for (const img of imgs) {
                img.setAttribute('alt', 'from Risuai')
                const url = img.getAttribute('src')

                img.setAttribute(
                  'style',
                  `
                        max-width: 100%;
                        margin: 10px 0;
                        border-radius: 8px;
                        box-shadow: rgba(0,0,0,0.1) 0px 2px 8px;
                        display: block;
                        margin-left: auto;
                        margin-right: auto;
                    `,
                )

                if (
                  url &&
                  (url.startsWith('http://asset.localhost') ||
                    url.startsWith('https://asset.localhost') ||
                    url.startsWith('https://sv.risuai') ||
                    url.startsWith('data:') ||
                    url.startsWith('http') ||
                    url.startsWith('/'))
                ) {
                  try {
                    if (!isChatWriteCurrent(generation)) return
                    let fetchUrl = url
                    if (url.startsWith('/')) {
                      fetchUrl = window.location.origin + url
                    }

                    const data = await awaitChatWrite(generation, fetch(fetchUrl))
                    if (data.ok) {
                      const canvas = document.createElement('canvas')
                      const ctx = canvas.getContext('2d')
                      const imgElement = new Image()
                      imgElement.crossOrigin = 'anonymous'
                      const imageDataUrl = await data.blob().then(
                        (b) =>
                          new Promise<string>((resolve, reject) => {
                            const reader = new FileReader()
                            reader.onload = () => resolve(reader.result as string)
                            reader.onerror = reject
                            reader.readAsDataURL(b)
                          }),
                      )
                      const decoded = await new Promise<boolean>((resolve) => {
                        imgElement.onload = () => resolve(true)
                        imgElement.onerror = () => resolve(false)
                        imgElement.src = imageDataUrl
                      })
                      if (!decoded) continue
                      canvas.width = imgElement.width
                      canvas.height = imgElement.height
                      ctx.drawImage(imgElement, 0, 0)
                      const dataURL = canvas.toDataURL('image/jpeg', 0.6)
                      img.setAttribute('src', dataURL)
                    }
                  } catch (error) {
                    if (!isChatWriteCurrent(generation)) return
                    console.error('Image error:', error)
                  }
                }
              }

              let iconDataUrl = ''
              let hasValidImage = false

              try {
                if (!isChatWriteCurrent(generation)) return
                const iconImage = (await awaitChatWrite(generation, getFileSrc(renderCharacter?.image ?? ''))) ?? ''

                if (
                  iconImage &&
                  (iconImage.startsWith('http://asset.localhost') ||
                    iconImage.startsWith('https://asset.localhost') ||
                    iconImage.startsWith('https://sv.risuai') ||
                    iconImage.startsWith('data:') ||
                    iconImage.startsWith('http') ||
                    iconImage.startsWith('/'))
                ) {
                  if (iconImage.startsWith('data:')) {
                    iconDataUrl = iconImage
                    hasValidImage = true
                  } else {
                    const data = await awaitChatWrite(generation, fetch(iconImage))
                    if (data.ok) {
                      const canvas = document.createElement('canvas')
                      const ctx = canvas.getContext('2d')
                      const img = new Image()
                      img.crossOrigin = 'anonymous'
                      const imageDataUrl = await data.blob().then(
                        (b) =>
                          new Promise<string>((resolve, reject) => {
                            const reader = new FileReader()
                            reader.onload = () => resolve(reader.result as string)
                            reader.onerror = reject
                            reader.readAsDataURL(b)
                          }),
                      )
                      await new Promise<boolean>((resolve) => {
                        img.onload = () => {
                          try {
                            if (!ctx) {
                              hasValidImage = false
                              resolve(false)
                              return
                            }
                            canvas.width = img.width
                            canvas.height = img.height
                            ctx.drawImage(img, 0, 0)
                            iconDataUrl = canvas.toDataURL('image/jpeg', 0.9)
                            hasValidImage = true
                            resolve(true)
                          } catch {
                            hasValidImage = false
                            resolve(false)
                          }
                        }
                        img.onerror = () => {
                          hasValidImage = false
                          resolve(false)
                        }
                        img.src = imageDataUrl
                      })
                    }
                  }
                }
              } catch (error) {
                if (!isChatWriteCurrent(generation)) return
                console.error('Icon error:', error)
                hasValidImage = false
              }

              const isUserMessage = role === 'user'
              const displayName = isUserMessage ? name || getUserDisplayName() : name
              const modelInfo = messageGenerationInfo
                ? capitalize(getModelInfo(messageGenerationInfo.model).shortName)
                : isUserMessage
                  ? 'User'
                  : 'AI'

              let finalIconDataUrl = iconDataUrl
              let finalHasValidImage = hasValidImage

              if (isUserMessage) {
                finalHasValidImage = false
                const userIcon = getUserIcon()
                if (userIcon) {
                  try {
                    if (!isChatWriteCurrent(generation)) return
                    const userIconSrc = await awaitChatWrite(generation, getFileSrc(userIcon))
                    if (
                      userIconSrc &&
                      (userIconSrc.startsWith('http://asset.localhost') ||
                        userIconSrc.startsWith('https://asset.localhost') ||
                        userIconSrc.startsWith('https://sv.risuai') ||
                        userIconSrc.startsWith('data:') ||
                        userIconSrc.startsWith('http') ||
                        userIconSrc.startsWith('/'))
                    ) {
                      if (userIconSrc.startsWith('data:')) {
                        finalIconDataUrl = userIconSrc
                        finalHasValidImage = true
                      } else {
                        const data = await awaitChatWrite(generation, fetch(userIconSrc))
                        if (data.ok) {
                          const canvas = document.createElement('canvas')
                          const ctx = canvas.getContext('2d')
                          const img = new Image()
                          img.crossOrigin = 'anonymous'
                          const imageDataUrl = await data.blob().then(
                            (b) =>
                              new Promise<string>((resolve, reject) => {
                                const reader = new FileReader()
                                reader.onload = () => resolve(reader.result as string)
                                reader.onerror = reject
                                reader.readAsDataURL(b)
                              }),
                          )
                          await new Promise<boolean>((resolve) => {
                            img.onload = () => {
                              try {
                                if (!ctx) {
                                  finalHasValidImage = false
                                  resolve(false)
                                  return
                                }
                                canvas.width = img.width
                                canvas.height = img.height
                                ctx.drawImage(img, 0, 0)
                                finalIconDataUrl = canvas.toDataURL('image/jpeg', 0.9)
                                finalHasValidImage = true
                                resolve(true)
                              } catch {
                                finalHasValidImage = false
                                resolve(false)
                              }
                            }
                            img.onerror = () => {
                              finalHasValidImage = false
                              resolve(false)
                            }
                            img.src = imageDataUrl
                          })
                        }
                      }
                    }
                  } catch (error) {
                    if (!isChatWriteCurrent(generation)) return
                    console.error('User icon error:', error)
                    finalHasValidImage = false
                  }
                }
              }

              const html = `<div style="font-family: 'Segoe UI', Roboto, Arial, sans-serif; color: ${root.style.getPropertyValue('--risu-theme-textcolor')}; line-height: 1.6; max-width: 600px; margin: 1rem auto; background: ${root.style.getPropertyValue('--risu-theme-bgcolor')}; border-radius: 12px; box-shadow: 0px 4px 12px rgba(0,0,0,0.15); overflow: hidden;">
<div style="padding: 20px;">
<div style="display: flex; flex-direction: column; align-items: center; margin-bottom: 1rem; text-align: center;">
    ${finalHasValidImage ? `<img style="width: 80px; height: 80px; border-radius: 50%; border: 3px solid ${root.style.getPropertyValue('--risu-theme-darkborderc')}; margin-bottom: 0.75rem; object-fit: cover;" src="${finalIconDataUrl}" alt="profile">` : ''}
    <h3 style="color: ${root.style.getPropertyValue('--risu-theme-textcolor')}; font-weight: 600; font-size: 1.5rem; margin: 0 0 0.5rem 0;">${displayName}</h3>
    ${!isUserMessage ? `<span style="display: inline-block; border-radius: 16px; font-size: 0.8rem; padding: 0.25rem 0.75rem; background: ${root.style.getPropertyValue('--risu-theme-darkbg')}; color: ${root.style.getPropertyValue('--risu-theme-textcolor')}; border: 1px solid ${root.style.getPropertyValue('--risu-theme-darkborderc')};">${modelInfo}</span>` : ''}
</div>
<div style="border-top: 1px solid ${root.style.getPropertyValue('--risu-theme-darkborderc')}; padding-top: 1rem;">
    ${doc.body.innerHTML}
</div>
<div style="text-align: center; margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid ${root.style.getPropertyValue('--risu-theme-darkborderc')};">
    <span style="font-size: 0.75rem; color: ${root.style.getPropertyValue('--risu-theme-textcolor2')}; opacity: 0.7;">From Risuai</span>
</div>
</div>
</div>`

              if (!isChatWriteCurrent(generation)) return
              await window.navigator.clipboard.write([
                new ClipboardItem({
                  'text/plain': new Blob([msgDisplay], { type: 'text/plain' }),
                  'text/html': new Blob([html], { type: 'text/html' }),
                }),
              ])
              alertNormal(language.copied)
              return
            } catch {
              if (!isChatWriteCurrent(generation)) return
              alertClear()
            }
          }
          try {
            await window.navigator.clipboard.writeText(msgDisplay)
            setStatusMessage(language.copied)
          } catch {}
        })
      }}>
      <CopyIcon size={20} />
      {#if showNames}
        <span class="ml-1">{language.copy}</span>
      {/if}
    </button>
  {/if}
  {#if writeActionsAllowed && idx > -1}
    {#if renderCharacter?.ttsMode !== 'none' && renderCharacter?.ttsMode}
      <button
        data-risu-message-action="tts"
        aria-label={language.readMessageAloud}
        class="flex items-center hover:text-blue-500 transition-colors button-icon-tts"
        onclick={() => {
          if (!canChatWrite()) return
          return sayTTS(null, message)
        }}>
        <Volume2Icon size={20} />
        {#if showNames}
          <span class="ml-1">TTS</span>
        {/if}
      </button>
    {/if}
    <button
      data-risu-message-action="remove"
      aria-label={language.remove}
      class={'flex items-center hover:text-blue-500 transition-colors button-icon-remove ' +
        (translationInProgress ? ' cursor-not-allowed opacity-50' : '')}
      disabled={translationInProgress}
      onclick={(e) => {
        if (translationInProgress) return
        rm(e, false)
      }}
      use:longpress={(e) => {
        if (translationInProgress) return
        rm(e, true)
      }}>
      <TrashIcon size={20} />

      {#if showNames}
        <span class="ml-1">{language.remove}</span>
      {/if}
    </button>
  {/if}
{/snippet}

{#snippet translationButton(showNames = false)}
  {#if (writeActionsAllowed || activeRawTranslation()) && languageSettings.translator !== '' && languageSettings.translatorType !== 'none' && !blankMessage}
    <button
      data-risu-message-action="translate"
      class={'flex items-center cursor-pointer hover:text-blue-500 transition-colors button-icon-translate ' +
        (translated && !translationInProgress ? 'text-blue-400' : '') +
        (translationInProgress ? ' cursor-wait opacity-70' : '')}
      class:translating={translationInProgress}
      disabled={translationInProgress}
      aria-busy={translationInProgress}
      aria-label={translationInProgress ? language.translating : language.translate}
      onclick={async () => {
        if (translationInProgress) return
        if (!canChatWrite()) {
          if (!activeRawTranslation()) return
          translated = !translated
          suppressAutomaticTranslationDisplay = !translated
          return
        }
        if (!canTranslateRawTarget()) {
          if (hasServerRawTranslationTarget()) return
          translated = !translated
          return
        }
        if (translated) {
          translated = false
          suppressAutomaticTranslationDisplay = true
          editTranslationMode = false
          return
        }
        if (activeRawTranslation()) {
          suppressAutomaticTranslationDisplay = false
          translated = true
          return
        }
        await requestServerRawTranslation()
      }}>
      {#if translationInProgress}
        <LoaderCircleIcon class="animate-spin" />
      {:else}
        <LanguagesIcon />
      {/if}
      {#if showNames}
        <span class="ml-1">{translationInProgress ? language.translating : language.translate}</span>
      {/if}
    </button>
  {/if}
  {#if writeActionsAllowed && idx > -1}
    <button
      data-risu-message-action="edit"
      aria-label={editMode ? language.save : language.edit}
      class={'flex items-center hover:text-blue-500 transition-colors button-icon-edit ' +
        (editMode ? 'text-blue-400' : '') +
        (translationInProgress ? ' cursor-not-allowed opacity-50' : '')}
      disabled={translationInProgress}
      onclick={async () => {
        if (translationInProgress) return
        if (!editMode) {
          beginMessageEdit()
        } else {
          await saveMessageEdit()
        }
      }}>
      <PencilIcon size={20} />

      {#if showNames}
        <span class="ml-1">{language.edit}</span>
      {/if}
    </button>
  {/if}
{/snippet}

{#snippet rerolls()}
  {#if writeActionsAllowed && (rerollIcon || altGreeting)}
    {#if altGreeting}
      <button
        data-risu-message-action="unreroll"
        aria-label={language.hotkeyDesc.unreroll}
        class={'flex items-center hover:text-blue-500 transition-colors button-icon-unreroll ' +
          (translationInProgress ? ' cursor-not-allowed opacity-50' : '')}
        class:dyna-icon={rerollIcon === 'dynamic'}
        disabled={translationInProgress}
        onclick={() => {
          if (!canChatWrite() || translationInProgress) return
          unReroll()
        }}>
        <ArrowLeft size={22} />
      </button>
      {#if firstMessage && sidebarSettings.swipe && displaySettings.showFirstMessagePages}
        <span class="flex items-center text-xs text-textcolor2">{currentPage}/{totalPages}</span>
      {/if}
      <button
        data-risu-message-action="reroll"
        aria-label={language.reroll}
        class={'flex items-center hover:text-blue-500 transition-colors button-icon-reroll ' +
          (translationInProgress ? ' cursor-not-allowed opacity-50' : '')}
        class:dyna-icon={rerollIcon === 'dynamic'}
        disabled={translationInProgress}
        onclick={() => {
          if (!canChatWrite() || translationInProgress) return
          onReroll()
        }}>
        <ArrowRight size={22} />
      </button>
    {:else if sidebarSettings.swipe}
      <button
        data-risu-message-action="reroll"
        aria-label={language.reroll}
        aria-haspopup="menu"
        aria-controls="risu-popup-menu"
        aria-expanded={popupStore.openId === rerollMenuButtonId && Boolean(popupStore.children)}
        class={'flex items-center hover:text-blue-500 transition-colors button-icon-reroll ' +
          (translationInProgress ? ' cursor-not-allowed opacity-50' : '')}
        class:dyna-icon={rerollIcon === 'dynamic'}
        disabled={translationInProgress}
        onclick={(e) => {
          if (translationInProgress) return
          openRerollMenu(e, rerollMenu)
        }}>
        <RefreshCcwIcon size={20} />
      </button>
    {:else}
      <button
        data-risu-message-action="reroll"
        aria-label={language.reroll}
        class={'flex items-center hover:text-blue-500 transition-colors button-icon-reroll ' +
          (translationInProgress ? ' cursor-not-allowed opacity-50' : '')}
        class:dyna-icon={rerollIcon === 'dynamic'}
        disabled={translationInProgress}
        onclick={() => {
          if (!canChatWrite() || translationInProgress) return
          onReroll()
        }}>
        <RefreshCcwIcon size={20} />
      </button>
    {/if}
  {/if}
{/snippet}

{#snippet rerollMenu()}
  {#if writeActionsAllowed}
    <RerollList
      currentMessage={message}
      target={rerollTarget}
      disabled={translationInProgress}
      onNewReroll={() => {
        if (canChatWrite()) onNewReroll()
      }}
      onSelectRerollCandidate={(index) => {
        if (canChatWrite()) onSelectRerollCandidate(index)
      }} />
  {/if}
{/snippet}

{#snippet minorIconButtonsBody(showNames: boolean)}
  {#if writeActionsAllowed}
    {#if advancedSettings.enableBookmark}
      <button
        data-risu-message-action="bookmark"
        aria-label={language.bookmark}
        class="flex items-center hover:text-blue-500 transition-colors button-icon-bookmark {isBookmarked
          ? 'text-yellow-400'
          : ''}"
        onclick={() => {
          void toggleBookmark()
        }}>
        <BookmarkIcon size={20} />
        {#if showNames}
          <span class="ml-1">{language.bookmark}</span>
        {/if}
      </button>
    {/if}

    <button
      data-risu-message-action="branch"
      aria-label={language.branch}
      class="flex items-center hover:text-blue-500 transition-colors"
      onclick={async () => {
        return runChatWriteAction(async (generation) => {
          const target = captureMessageEditorTarget()
          if (!target) return
          if (!(await awaitChatWrite(generation, alertConfirm(language.branchConfirm)))) return
          await branchFromCurrentMessage(target)
        })
      }}>
      <SplitIcon size={20} />
      {#if showNames}
        <span class="ml-1">{language.branch}</span>
      {/if}
    </button>

    <button
      data-risu-message-action="toggle-disabled"
      aria-label={language.disableMessage}
      class="flex items-center hover:text-blue-500 transition-colors"
      onclick={() => {
        const chat = mutableActiveChatOwner()?.chat
        const currentMessage = chat?.message[idx]
        const readMessage = currentLiveMessage()
        if (!currentMessage?.chatId || readMessage?.chatId !== currentMessage.chatId) return
        const previous = currentChatScopedSnapshot()
        const disabled = !currentMessage.disabled
        const messageId = currentMessage.chatId
        if (canUseServerCommands()) {
          if (messageId) {
            observeMessageMutation(dispatchUpdateMessageScoped(messageId, { disabled }, previous))
          } else {
            const nextMessages = cloneMessagesWithIds(chat)
            if (nextMessages[idx]) {
              nextMessages[idx].disabled = disabled
              dispatchReplaceMessagesForChat(chat, nextMessages, previous)
            }
          }
        } else {
          const localMessageId = ensureMessageId(currentMessage)
          currentMessage.disabled = disabled
          observeMessageMutation(dispatchUpdateMessageScoped(localMessageId, { disabled }, previous))
        }
      }}>
      <PowerOff size={20} />
      {#if showNames}
        <span class="ml-1">{language.disableMessage}</span>
      {/if}
    </button>

    <button
      data-risu-message-action="disable-above"
      aria-label={language.disableAbove}
      class="flex items-center hover:text-blue-500 transition-colors"
      onclick={() => {
        const chat = mutableActiveChatOwner()?.chat
        const currentMessage = chat?.message[idx]
        const readMessage = currentLiveMessage()
        if (!currentMessage?.chatId || readMessage?.chatId !== currentMessage.chatId) return
        const previous = currentChatScopedSnapshot()
        const disabled = currentMessage.disabled === 'allBefore' ? false : 'allBefore'
        const messageId = currentMessage.chatId
        if (canUseServerCommands()) {
          if (messageId) {
            observeMessageMutation(dispatchUpdateMessageScoped(messageId, { disabled }, previous))
          } else {
            const nextMessages = cloneMessagesWithIds(chat)
            if (nextMessages[idx]) {
              nextMessages[idx].disabled = disabled
              dispatchReplaceMessagesForChat(chat, nextMessages, previous)
            }
          }
        } else {
          const localMessageId = ensureMessageId(currentMessage)
          currentMessage.disabled = disabled
          observeMessageMutation(dispatchUpdateMessageScoped(localMessageId, { disabled }, previous))
        }
      }}>
      <Scissors size={20} />
      {#if showNames}
        <span class="ml-1">{language.disableAbove}</span>
      {/if}
    </button>
  {/if}
{/snippet}

{#snippet senderIcon(options: { rounded?: boolean; styleFix?: string } = {})}
  {#if showSenderIdentity && !hideSenderIdentity}
    {#if writeActionsAllowed && renderCharacter?.chaId === '§playground'}
      <div
        class="shadow-lg border-textcolor2 border flex justify-center items-center text-textcolor2"
        style={options?.styleFix ??
          `height:${((displaySettings.iconsize ?? 100) * 3.5) / 100}rem;width:${((displaySettings.iconsize ?? 100) * 3.5) / 100}rem;min-width:${((displaySettings.iconsize ?? 100) * 3.5) / 100}rem`}
        class:rounded-md={options?.rounded}
        class:rounded-full={options?.rounded}>
        {#if name === 'assistant'}
          <BotIcon />
        {:else}
          <UserIcon />
        {/if}
      </div>
    {:else}
      {#await img}
        <div
          class="shadow-lg bg-textcolor2"
          style={options?.styleFix ??
            `height:${((displaySettings.iconsize ?? 100) * 3.5) / 100}rem;width:${((displaySettings.iconsize ?? 100) * 3.5) / 100}rem;min-width:${((displaySettings.iconsize ?? 100) * 3.5) / 100}rem`}
          class:rounded-md={!options?.rounded}
          class:rounded-full={options?.rounded}>
        </div>
      {:then m}
        {#if largePortrait && !options?.rounded}
          <div
            class="shadow-lg bg-textcolor2"
            style={m +
              (options?.styleFix ??
                `height:${((displaySettings.iconsize ?? 100) * 3.5) / 100 / 0.75}rem;width:${((displaySettings.iconsize ?? 100) * 3.5) / 100}rem;min-width:${((displaySettings.iconsize ?? 100) * 3.5) / 100}rem`)}
            class:rounded-md={!options?.rounded}
            class:rounded-full={options?.rounded}>
          </div>
        {:else}
          <div
            class="shadow-lg bg-textcolor2"
            style={m +
              (options?.styleFix ??
                `height:${((displaySettings.iconsize ?? 100) * 3.5) / 100}rem;width:${((displaySettings.iconsize ?? 100) * 3.5) / 100}rem;min-width:${((displaySettings.iconsize ?? 100) * 3.5) / 100}rem`)}
            class:rounded-md={!options?.rounded}
            class:rounded-full={options?.rounded}>
          </div>
        {/if}
      {/await}
    {/if}
  {/if}
{/snippet}

{#snippet renderGuiHtmlPart(dom: HTMLElement)}
  {#if ['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED'].includes(dom.tagName)}
    <!-- Executable template nodes have no presentation surface. -->
  {:else if dom.tagName === 'DETAILS'}
    <details
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}
      open={dom.hasAttribute('open')}>
      {@render renderChilds(dom)}
    </details>
  {:else if dom.tagName === 'SUMMARY'}
    <summary
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </summary>
  {:else if dom.tagName === 'IMG'}
    <img
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      src={dom.getAttribute('src') ?? ''}
      alt={dom.getAttribute('alt') ?? ''}
      style={dom.getAttribute('style') ?? ''} />
  {:else if dom.tagName === 'A'}
    <a
      {...readerMarkupAttributes(dom)}
      target="_blank"
      rel="noreferrer"
      href={dom.getAttribute('href') && /^https?:\/\//i.test(dom.getAttribute('href')) ? dom.getAttribute('href') : ''}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </a>
  {:else if dom.tagName === 'SPAN'}
    <span
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </span>
  {:else if dom.tagName === 'DIV'}
    <div
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </div>
  {:else if dom.tagName === 'P'}
    <p {...readerMarkupAttributes(dom)} class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </p>
  {:else if dom.tagName === 'H1'}
    <h1
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </h1>
  {:else if dom.tagName === 'H2'}
    <h2
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </h2>
  {:else if dom.tagName === 'H3'}
    <h3
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </h3>
  {:else if dom.tagName === 'H4'}
    <h4
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </h4>
  {:else if dom.tagName === 'H5'}
    <h5
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </h5>
  {:else if dom.tagName === 'H6'}
    <h6
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </h6>
  {:else if dom.tagName === 'UL'}
    <ul
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </ul>
  {:else if dom.tagName === 'OL'}
    <ol
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </ol>
  {:else if dom.tagName === 'LI'}
    <li
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </li>
  {:else if dom.tagName === 'TABLE'}
    <table
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </table>
  {:else if dom.tagName === 'TR'}
    <tr
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </tr>
  {:else if dom.tagName === 'TD'}
    <td
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </td>
  {:else if dom.tagName === 'TH'}
    <th
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </th>
  {:else if dom.tagName === 'HR'}
    <hr
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''} />
  {:else if dom.tagName === 'BR'}
    <br
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''} />
  {:else if dom.tagName === 'CODE'}
    <code
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </code>
  {:else if dom.tagName === 'PRE'}
    <pre
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </pre>
  {:else if dom.tagName === 'BLOCKQUOTE'}
    <blockquote
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </blockquote>
  {:else if dom.tagName === 'EM'}
    <em
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </em>
  {:else if dom.tagName === 'STRONG'}
    <strong
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </strong>
  {:else if dom.tagName === 'U'}
    <u {...readerMarkupAttributes(dom)} class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </u>
  {:else if dom.tagName === 'DEL'}
    <del
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </del>
  {:else if dom.tagName === 'BUTTON'}
    <button
      {...writeActionsAllowed ? getRisuButtonAttributes(dom) : {}}
      disabled={!writeActionsAllowed && hasExecutableMarkupAction(dom)}
      aria-disabled={!writeActionsAllowed && hasExecutableMarkupAction(dom) ? 'true' : undefined}
      title={!writeActionsAllowed && hasExecutableMarkupAction(dom)
        ? language.connectedReaders.writeAccessRequired
        : undefined}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </button>
  {:else if dom.tagName === 'RISUTEXTBOX'}
    {@render textBox()}
  {:else if dom.tagName === 'RISUICON'}
    {@render senderIcon()}
  {:else if dom.tagName === 'RISUBUTTONS'}
    {@render iconButtons()}
  {:else if dom.tagName === 'RISUGENINFO'}
    {@render genInfo()}
  {:else if dom.tagName === 'STYLE'}
    <svelte:element this={'style'}>
      {dom.innerHTML}
    </svelte:element>
  {:else}
    <div
      {...readerMarkupAttributes(dom)}
      class={dom.getAttribute('class') ?? ''}
      style={dom.getAttribute('style') ?? ''}>
      {@render renderChilds(dom)}
    </div>
  {/if}
{/snippet}

{#snippet renderChilds(dom: HTMLElement)}
  {#each dom.childNodes as node}
    {#if node.nodeType === Node.TEXT_NODE}
      {node.textContent}
    {:else if node.nodeType === Node.ELEMENT_NODE}
      {@render renderGuiHtmlPart(node as HTMLElement)}
    {/if}
  {/each}
{/snippet}

{#if disabled === true}
  <div class="w-full border-t-2 border-dashed border-blue-500"></div>
{/if}
<div
  class="flex max-w-full justify-center risu-chat"
  data-chat-index={idx}
  data-chat-id={messageRowId}
  data-risu-message-index={idx}
  data-risu-message-id={messageRowId}
  data-generation-display-projection={isGenerationProjection ? generationPresentationMode : undefined}
  style={isLastMemory ? `border-top:${displaySettings.memoryLimitThickness ?? 1}px solid rgba(98, 114, 164, 0.7);` : ''}
  onclickcapture={handleButtonTriggerWithin}
  onkeydowncapture={(event) => {
    if (event.key === 'Enter' || event.key === ' ') denyReaderScriptActivation(event, canChatWrite())
  }}>
  <div
    class="text-textcolor mt-1 ml-4 mr-4 mb-1 p-2 bg-transparent grow border-t-gray-900 border-opacity/30 border-transparent flexium items-start max-w-full">
    {#if displaySettings.theme === 'mobilechat' && !blankMessage}
      <div class={role === 'user' ? 'flex items-start w-full justify-end' : 'flex items-start'}>
        {#if role !== 'user'}
          {@render senderIcon({ rounded: true })}
        {/if}
        <div
          class="bg-gray-100 rounded-lg p-3 max-w-[70%] mx-2"
          class:rounded-tl-none={role !== 'user'}
          class:rounded-tr-none={role === 'user'}>
          <p class="text-gray-800">{@render textBox()}</p>
          {#if ownerMessage?.time}
            <span class="text-xs text-textcolor2 mt-1 block">
              {new Intl.DateTimeFormat(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                month: '2-digit',
                day: '2-digit',
                hour12: false,
              }).format(ownerMessage.time)}
            </span>
          {/if}
          {#if !writeActionsAllowed}
            <div class="mt-2 text-gray-600">
              {@render iconButtons({ applyTextColors: false })}
            </div>
          {/if}
        </div>
        {#if role === 'user'}
          {@render senderIcon({ rounded: true })}
        {/if}
      </div>
    {:else if displaySettings.theme === 'cardboard' && !blankMessage}
      <div class="w-full flex flex-col px-0 sm:px-4 py-4 relative">
        <div
          class="bg-linear-to-b from-gray-100 to-gray-200 rounded-lg shadow-lg border-gray-400 border p-4 flex flex-col">
          <div class="flex gap-4 mt-2 flex-col sm:flex-row">
            <div class="flex flex-col items-center">
              <div class="sm:h-96 sm:w-72 sm:min-w-72 w-48 h-64">
                {@render senderIcon({ rounded: false, styleFix: 'height:100%;width:100%;' })}
              </div>
              <h2 class="text-base font-bold text-gray-500 text-center mt-2 max-w-full text-ellipsis">
                {name}
              </h2>
            </div>
            {#if writeActionsAllowed && editMode && !isGenerationLoading}
              <textarea
                aria-label={language.messageInput}
                class="grow h-138 sm:h-96 overflow-y-auto bg-transparent text-black p-2 mb-2 resize-none message-edit-area"
                bind:value={messageEditText}></textarea>
            {:else}
              <div class="grow h-138 sm:h-96 overflow-y-auto p-2 mb-2 sm:mb-0">
                {@render textBox()}
              </div>
            {/if}
          </div>
        </div>
        <div
          class="absolute bottom-0 right-0 bg-linear-to-b from-gray-200 to-gray-300 p-2 rounded-md border border-gray-400 text-gray-400">
          {@render iconButtons({ applyTextColors: false })}
        </div>
      </div>
    {:else if displaySettings.theme === 'customHTML' && !blankMessage && hasCustomHtmlTemplate(displaySettings.guiHTML)}
      {@const customHtmlCacheScopeKey = `${currentChatId}|${$VariableReloadGUIPointer}`}
      {@render renderGuiHtmlPart(RenderGUIHtml(displaySettings.guiHTML, customHtmlCacheScopeKey))}
    {:else}
      {@render senderIcon({ rounded: displaySettings.roundIcons })}
      <span class="flex flex-col ml-4 w-full max-w-full min-w-0 text-black">
        <div class="flexium items-center chat-width">
          {#if writeActionsAllowed && renderCharacter?.chaId === '§playground' && !blankMessage && ownerMessage}
            <span class="chat-width text-xl border-darkborderc flex items-center text-textcolor">
              <span>{ownerMessage.role === 'char' ? 'Assistant' : 'User'}</span>
              <button
                data-risu-message-action="switch-role"
                aria-label={language.switchMessageRole}
                class="ml-2 text-textcolor2 hover:text-textcolor"
                onclick={() => {
                  const previous = currentChatScopedSnapshot()
                  const chat = mutableActiveChatOwner()?.chat
                  if (!chat?.message[idx]?.chatId || chat.message[idx].chatId !== ownerMessage?.chatId) return
                  const role = chat.message[idx].role === 'char' ? 'user' : 'char'
                  const messageId = chat.message[idx].chatId
                  if (canUseServerCommands()) {
                    if (messageId) {
                      observeMessageMutation(dispatchUpdateMessageScoped(messageId, { role }, previous))
                    } else {
                      const nextMessages = cloneMessagesWithIds(chat)
                      if (nextMessages[idx]) {
                        nextMessages[idx].role = role
                        dispatchReplaceMessagesForChat(chat, nextMessages, previous)
                      }
                    }
                  } else {
                    const localMessageId = ensureMessageId(chat.message[idx])
                    chat.message[idx].role = role
                    observeMessageMutation(dispatchUpdateMessageScoped(localMessageId, { role }, previous))
                  }
                  ReloadChatPointer.update((v) => {
                    v[idx] = (v[idx] ?? 0) + 1
                    return v
                  })
                }}><ArrowLeftRightIcon size="18" /></button>
            </span>
          {:else if showSenderIdentity && !hideSenderIdentity}
            <div class="chat-width text-xl unmargin text-textcolor flex items-center">
              <span>{name}</span>
            </div>
          {/if}
          {@render iconButtons()}
        </div>
        {@render genInfo()}
        {@render textBox()}
      </span>
    {/if}
    {#if generationPersistenceState && generationPersistenceStatusText}
      <div
        class="generation-persistence-indicator"
        class:generation-persistence-indicator-stalled={generationPersistenceState !== 'queued'}
        data-generation-persistence-state={generationPersistenceState}
        role="status"
        aria-live="polite">
        {generationPersistenceStatusText}
      </div>
    {/if}
  </div>
</div>

{#if disabled}
  <div
    class={{
      'w-full border-t-2 border-dashed': true,
      'border-blue-500': disabled === true,
      'border-amber-500': disabled === 'allBefore',
    }}>
  </div>
{/if}

<style>
  .generation-persistence-indicator {
    align-self: center;
    max-width: min(42rem, 100%);
    margin: 0.5rem 1rem;
    padding: 0.35rem 0.6rem;
    border: 1px solid color-mix(in srgb, var(--risu-theme-borderc) 65%, transparent);
    border-radius: 0.5rem;
    color: var(--risu-theme-textcolor2);
    background: color-mix(in srgb, var(--risu-theme-darkbg) 82%, transparent);
    font-size: 0.75rem;
    line-height: 1rem;
  }

  .generation-persistence-indicator-stalled {
    border-color: color-mix(in srgb, #f59e0b 70%, transparent);
    color: color-mix(in srgb, #f59e0b 78%, var(--risu-theme-textcolor));
  }

  .chat-generation-loading {
    color: var(--risu-theme-textcolor2);
  }

  .chat-generation-loading-compact {
    margin-top: 0.5rem;
    font-size: 0.8125rem;
  }

  .chat-generation-loading-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 1.5rem;
    font-size: 0.875rem;
    line-height: 1.25rem;
  }

  .chat-generation-loading-elapsed {
    opacity: 0.75;
    font-variant-numeric: tabular-nums;
  }

  .chat-generation-loading-track {
    position: relative;
    height: 0.5rem;
    margin-top: 0.5rem;
    overflow: hidden;
    border: 1px solid var(--risu-theme-darkborderc);
    border-radius: 9999px;
    background: color-mix(in srgb, var(--risu-theme-darkbg) 82%, transparent);
  }

  .chat-generation-loading-fill {
    position: relative;
    height: 100%;
    width: 36%;
    border-radius: inherit;
    background: var(--risu-theme-borderc);
    animation: chat-generation-loading-travel 1.3s ease-in-out infinite;
    transition: background-color 0.35s ease;
  }

  .chat-generation-loading-fill::after {
    position: absolute;
    inset: 0;
    content: '';
    /* Travel with the fill; a separate transform makes the highlight drift out of sync. */
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.55), transparent);
  }

  .chat-generation-loading-phase-preparing {
    background: #60a5fa;
  }

  .chat-generation-loading-phase-checking-memory {
    background: #db2777;
  }

  .chat-generation-loading-phase-waiting-for-model,
  .chat-generation-loading-phase-generating {
    background: #34d399;
  }

  .chat-generation-loading-phase-finalizing {
    background: #8b5cf6;
  }

  .chat-generation-loading-phase-input-hook {
    background: #f59e0b;
  }

  @keyframes chat-generation-loading-travel {
    0% {
      transform: translateX(-120%);
    }

    50% {
      transform: translateX(90%);
    }

    100% {
      transform: translateX(280%);
    }
  }

  :global(html.risu-reduced-motion) .chat-generation-loading-fill {
    transition: none;
    animation: none;
    width: 100%;
    opacity: 0.65;
  }

  :global(.chat-message-body .x-risu-bilingual-pair) {
    display: flex;
    flex-direction: column;
    gap: 0.2em;
    margin: 0;
  }

  :global(.chat-message-body .x-risu-bilingual-pair + .x-risu-bilingual-pair) {
    margin-top: 1.3em;
  }

  :global(.chat-message-body .x-risu-bilingual-pair > *) {
    margin-block: 0;
  }

  :global(.chat-message-body .x-risu-bilingual-pair > div > :first-child) {
    margin-top: 0;
  }

  :global(.chat-message-body .x-risu-bilingual-pair > div > :last-child) {
    margin-bottom: 0;
  }

  :global(.chat-message-body .x-risu-bilingual-muted) {
    padding-left: 0.6rem;
    border-left: 2px solid var(--risu-theme-darkborderc);
    border-radius: 0;
    font-size: 0.875em;
    filter: saturate(0.4) opacity(0.7);
  }

  :global(.chat-message-body .x-risu-bilingual-muted pre) {
    font-size: 1.142857em;
  }
</style>
