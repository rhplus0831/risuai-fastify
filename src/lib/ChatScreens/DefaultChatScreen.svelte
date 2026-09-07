<script lang="ts" module>
  import type { ChatMessageOwnerState } from 'src/ts/server/chatMessageHydration.svelte'

  export function resolveTranscriptRenderMessages(
    ownerState: ChatMessageOwnerState | undefined,
    aggregateMessages: ChatMessageOwnerState['messages'],
  ): ChatMessageOwnerState['messages'] {
    return ownerState?.messages ?? aggregateMessages
  }

  export function resolveReadyOwnerValue<T>(status: string, ownerValue: T, preReadyFallback: T): T {
    return status === 'ready' ? ownerValue : preReadyFallback
  }

  export function routeOwnsSelectedChat(
    route: { kind: string; chaId?: string; chatId?: string },
    characterId: string | undefined,
    chatId: string | undefined,
  ): boolean {
    return (
      route.kind === 'character' &&
      route.chaId === characterId &&
      typeof route.chatId === 'string' &&
      route.chatId === chatId
    )
  }

  export function resolveUniqueChatOwner<
    TChat extends { id?: string },
    TCharacter extends { chaId?: string; chats?: TChat[] },
  >(
    characters: readonly TCharacter[],
    characterId: string,
    chatId: string,
  ): { character: TCharacter; chat: TChat } | undefined {
    let characterOwner: TCharacter | undefined
    for (const character of characters) {
      if (character.chaId !== characterId) continue
      if (characterOwner) return undefined
      characterOwner = character
    }
    if (!characterOwner) return undefined

    let chatOwner: { character: TCharacter; chat: TChat } | undefined
    for (const character of characters) {
      for (const chat of character.chats ?? []) {
        if (chat.id !== chatId) continue
        if (chatOwner) return undefined
        chatOwner = { character, chat }
      }
    }
    return chatOwner?.character === characterOwner ? chatOwner : undefined
  }
</script>

<script lang="ts">
  import Suggestion from './Suggestion.svelte'
  import {
    CameraIcon,
    DatabaseIcon,
    DicesIcon,
    GlobeIcon,
    ImagePlusIcon,
    LanguagesIcon,
    Laugh,
    LoaderCircleIcon,
    MenuIcon,
    MicOffIcon,
    PackageIcon,
    Plus,
    RefreshCcwIcon,
    ReplyIcon,
    Send,
    StepForwardIcon,
    XIcon,
    BrainIcon,
    ArrowDown,
    PinIcon,
    SparkleIcon,
    TriangleAlertIcon,
    EyeOffIcon,
    PencilLineIcon,
    BookOpenIcon,
  } from '@lucide/svelte'
  import {
    selectedCharID,
    PlaygroundStore,
    hypaV3ModalOpen,
    ScrollToMessageStore,
    additionalChatMenu,
    additionalFloatingActionButtons,
    chatPanelStore,
    easyPanelStore,
  } from '../../ts/stores.svelte'
  import { createSimpleCharacter } from '../../ts/simpleCharacter'
  import { pluginRuntimeStateStore, retryPluginRuntime } from '../../ts/plugins/plugins.svelte'
  import { startupCoordinatorStore } from 'src/ts/startupReadiness'
  import {
    RegexDisplayReloadPointer,
    RegexDisplayReloadScope,
    regexDisplayReloadTokenForContext,
  } from '../../ts/process/regexDisplayReload'
  import { onDestroy, tick, untrack } from 'svelte'
  import { canUseClientWriteAccess, captureClientSessionGeneration } from 'src/ts/clientSession'
  import { isClientWriteOperationCurrent } from 'src/ts/clientWriteOperation'
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'
  import Chat from './Chat.svelte'
  import {
    getCharacterByIndex,
    isServerCharacterShell,
    isServerChatMessagePlaceholder,
    setCharacterByIndex,
    type Chat as ChatRecord,
    type Database,
    type InputHook,
    type Message,
    type character,
  } from '../../ts/storage/database.svelte'
  import { getCharImage } from '../../ts/characterImage'
  import { getSelectedCharacterOwner, selectCharacterOwner } from '../../ts/characterState'
  import {
    charactersResourceState,
    getCharacterResourceOwner,
    getChatMetadataOwnerSnapshot,
    getPersonaOwnerStateSnapshot,
    settingsResourceState,
  } from '../../ts/server/resourceState.svelte'
  import {
    abortActiveGeneration,
    clearActiveGenerationAbortController,
    createActiveGenerationAbortController,
    sendChat,
  } from '../../ts/process/index.svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { sleep } from '../../ts/util'
  import { resolveUserPersonaPresentation } from '../../ts/utilState'
  import { language } from '../../lang'
  import { isExpTranslator, translate } from '../../ts/translator/translator'
  import {
    alertError,
    alertNormal,
    beginAlertWait,
    clearAlertWait,
    updateAlertWait,
    type AlertWaitHandle,
  } from '../../ts/alert'
  import CreatorQuote from './CreatorQuote.svelte'
  import { stopTTS } from 'src/ts/process/tts'
  import { resetBgmObserverForChatSwitch } from 'src/ts/observer.svelte'
  import MainMenu from '../UI/MainMenu.svelte'
  import AssetInput from './AssetInput.svelte'
  import { aiLawApplies, chatFoldedState, chatFoldedStateMessageIndex, downloadFile } from 'src/ts/globalApi.svelte'
  import { getCharacterDisplayName } from 'src/ts/characterDisplayName'
  import { v4 } from 'uuid'
  import {
    reroll as rerollNav,
    unReroll as unRerollNav,
    newReroll as newRerollNav,
    selectRerollCandidate as selectRerollCandidateNav,
    recordGeneratedReroll,
    resetRerollOnCharChange,
    clearRerollBuffer,
    markRerollChar,
  } from 'src/ts/process/rerollNavigation.svelte'
  import { processMultiCommand } from 'src/ts/process/command'
  import { postChatFile } from 'src/ts/process/files/multisend'
  import { getInlayAsset } from 'src/ts/process/files/inlays'
  import { applySuccessfulSendChatEffects } from 'src/ts/process/sendChatCompletion'
  import { coldStorageHeader, preLoadChat } from 'src/ts/process/coldstorage.svelte'
  import Chats from './Chats.svelte'
  import Button from '../UI/GUI/Button.svelte'
  import PluginDefinedIcon from '../Others/PluginDefinedIcon.svelte'
  import {
    appendCurrentChatEmptyCharMessage,
    appendCurrentChatUserMessageForSend,
    captureActiveChatTarget,
    isActiveChatTargetFresh,
    setCurrentChatPinnedWithOutcome,
    setCurrentChatGreetingIndex,
    type ActiveChatTarget,
  } from 'src/ts/chatCommands'
  import { applyServerBackedSetting } from 'src/ts/server/settingsOwner.svelte'
  import {
    hasChatMessageHydrationFailed,
    getChatMessageOwnerState,
    hydrateActiveChat,
    hydrateActiveChatFully,
    hydrateActiveChatWindow,
    isChatMessageHydrationPending,
  } from 'src/ts/server/chatMessageHydration.svelte'
  import { buildTranscriptWindowIdentity, getLoadPagesForMessageJump } from './DefaultChatScreen.loadPages'
  import { getAdditionalChatLoadPages, getInitialChatLoadPages } from '@risuai/shared-core/chat-load-pages'
  import { guardActiveChatGenerationSettingsForSend } from 'src/ts/activeChatGenerationSettings'
  import { characterRoutePath, currentRoute, navigate, type AppRoute } from 'src/ts/router'
  import { createLatestOperationGuard } from 'src/ts/server/staleStateGuards'
  import { preflightChatSendBeforeMutation } from 'src/ts/process/sendChatPreflight'
  import PostGenerationScriptProgress from './PostGenerationScriptProgress.svelte'
  import AgentPresetProgress from './AgentPresetProgress.svelte'
  import { CHAT_GENERATION_INPUT_HOOK_STAGE, chatGenerationLoadingPhaseFromStage } from './chatGenerationLoading'
  import { activeChatGenerations, chatGenerationTargetKey } from 'src/ts/process/generationActivity.svelte'
  import {
    activeInputHookActivities,
    beginInputHookActivity,
    finishInputHookActivity,
  } from 'src/ts/process/inputHookActivity.svelte'
  import {
    acceptedSendRecoveries,
    coordinateAcceptedChatSend,
    findAcceptedSendRecoveries,
    retryAcceptedChatSend,
  } from 'src/ts/process/acceptedSendCoordinator.svelte'
  import {
    canUseGenerationOperationProtocol,
    findGenerationOperationIdForTarget,
    generationOperationCancellations,
    generationOperationProjections,
    refreshGenerationOperationCancellation,
    stopGenerationOperation,
  } from 'src/ts/server/generationOperations'
  import { registerAcceptedSendDraftGenerationListener } from 'src/ts/process/acceptedSendRecoveryState'
  import {
    activeGenerationJobs,
    generationJobLifecycles,
    refreshGenerationJobFromBootstrap,
    retryGenerationJobReattach,
    stopGenerationJob,
  } from 'src/ts/process/reattach'
  import {
    deleteDefaultChatComposerDraft,
    isDefaultChatComposerDraftGenerationCurrent,
    readDefaultChatComposerDraft,
    registerDefaultChatComposerDraftStorageFailureListener,
    writeDefaultChatComposerDraft,
    type DefaultChatComposerDraft,
    type DefaultChatComposerDraftGeneration,
  } from './DefaultChatScreen.composerDrafts'
  import { runInputHook, type InputHookHistoryContext } from 'src/ts/process/inputHooks'
  import { createDraftHookTranslation } from 'src/ts/process/draftHookTranslation'
  import { maximumHistorySlotCount } from '@risuai/shared-core/history-slots'
  import InputHookPickerDialog from './InputHookPickerDialog.svelte'
  import LazyComponent from '../UI/LazyComponent.svelte'
  import {
    currentGreetingTranslatorSettingsSignature,
    findGreetingTranslation,
    greetingTranslationProjectionVersion,
    refreshGreetingTranslationProjection,
  } from 'src/ts/server/greetingTranslations.svelte'

  import { loadPlaygroundMenu } from 'src/ts/routeComponentPreload'
  import { cleanAutoSuggestionInput } from 'src/ts/model/autoSuggestionCleanup'
  import type { SettingsGroup } from '@risuai/shared-core/settings-groups'
  import { displaySettingForPaint } from 'src/ts/gui/displaySettings'
  import { chatDisplayDependencyStatus } from './chatDisplayReadiness'
  const composerFileOperationGuard = createLatestOperationGuard<string>()
  const composerOperationGuard = createLatestOperationGuard<string>()

  function groupedSetting<K extends keyof Database>(group: SettingsGroup, key: K): Database[K] | undefined {
    if (group === 'display') return displaySettingForPaint(key)
    const ownerValue = (settingsResourceState.value as unknown as Partial<Database>)[key] as Database[K] | undefined
    return resolveReadyOwnerValue(settingsResourceState.groupStatuses[group] ?? 'idle', ownerValue, undefined)
  }

  function fullSettingsOwner<K extends keyof Database>(key: K): Database[K] | undefined {
    if (settingsResourceState.fullRevision === null) return undefined
    return (settingsResourceState.value as unknown as Partial<Database>)[key] as Database[K] | undefined
  }

  function selectedCharacterForScreen(): character | undefined {
    if ($selectedCharID < 0) return undefined
    const owner = getSelectedCharacterOwner()
    if (owner || charactersResourceState.status === 'ready') return owner
    return selectCharacterOwner(charactersResourceState.characters, $selectedCharID)
  }

  function targetCharacterOwner(target: ActiveChatTarget): character | undefined {
    if (target.characterId) return getCharacterResourceOwner(target.characterId)
    return selectCharacterOwner(charactersResourceState.characters, target.selectedCharID)
  }

  function targetChatOwner(target: ActiveChatTarget): { character: character; chat: ChatRecord } | undefined {
    const character = targetCharacterOwner(target)
    if (!character?.chaId) return undefined
    const chatId = target.chatId ?? character.chats?.[target.chatPage]?.id
    return chatId
      ? resolveUniqueChatOwner<ChatRecord, character>(charactersResourceState.characters, character.chaId, chatId)
      : undefined
  }

  function targetChatWithTranscript(target: ActiveChatTarget): { character: character; chat: ChatRecord } | undefined {
    const owner = targetChatOwner(target)
    if (!owner?.chat.id) return undefined
    const transcript = getChatMessageOwnerState(owner.chat.id)
    if (!transcript) return undefined
    return { character: owner.character, chat: { ...owner.chat, message: transcript.messages } }
  }

  function chatLoadPageSettings(): { chatLoadInitialPages?: number; chatLoadAdditionalPages?: number } {
    return {
      chatLoadInitialPages: groupedSetting('display', 'chatLoadInitialPages'),
      chatLoadAdditionalPages: groupedSetting('display', 'chatLoadAdditionalPages'),
    }
  }

  type PostChatFileResults = NonNullable<Awaited<ReturnType<typeof postChatFile>>>
  type ComposerFileOperation = {
    clientGeneration: number
    token: ReturnType<typeof composerFileOperationGuard.issue>
    targetIdentity: string
    invalidationVersion: number
  }
  type ComposerOperationKind = 'send' | 'continue' | 'draft-send' | 'btw'
  type ComposerDraftField = 'message' | 'translation' | 'files' | 'draft' | 'btw'
  type ComposerTextField = 'message' | 'translation'
  type ComposerOperation = {
    clientGeneration: number
    token: ReturnType<typeof composerOperationGuard.issue>
    kind: ComposerOperationKind
    targetIdentity: string
    composerVersion: number
    messageInput: string
    messageInputTranslate: string
    fileInput: string[]
    draftText: string
    btwText: string
    draftGeneration: DefaultChatComposerDraftGeneration | null
  }
  type AutoTranslateOperation = {
    clientGeneration: number
    sourceField: ComposerTextField
    targetField: ComposerTextField
    sourceText: string
    targetVersion: number
    targetIdentity: string | null
  }
  type ScreenshotOperation = {
    target: ActiveChatTarget
    transcriptIdentity: string
    previousLoadPages: number
  }

  interface Props {
    route?: AppRoute
    openModuleList?: boolean
    openChatList?: boolean
    openBardWiki?: boolean
    customStyle?: string
  }

  let inputHooks = $derived(groupedSetting('advanced', 'inputHooks') ?? [])
  let floatingChatInput = $derived(groupedSetting('sidebar', 'floatingChatInput') !== false)
  let fixedChatTextarea = $derived(groupedSetting('sidebar', 'fixedChatTextarea') === true)
  let sendWithEnter = $derived(groupedSetting('sidebar', 'sendWithEnter') === true)
  let newMessageButtonStyle = $derived(groupedSetting('sidebar', 'newMessageButtonStyle'))
  let chatScreenWidth = $derived(groupedSetting('display', 'chatScreenWidth') ?? 900)
  let useChatSticker = $derived(groupedSetting('display', 'useChatSticker') === true)
  let useAutoTranslateInput = $derived(groupedSetting('language', 'useAutoTranslateInput') === true)
  let useAutoSuggestions = $derived(groupedSetting('runtime', 'useAutoSuggestions') === true)
  let showMenuChatList = $derived(groupedSetting('sidebar', 'showMenuChatList') === true)
  let enableRisuaiProTools = $derived(groupedSetting('sidebar', 'enableRisuaiProTools') === true)
  let showMenuHypaMemoryModal = $derived(groupedSetting('memory', 'showMenuHypaMemoryModal') === true)
  let hypaV3 = $derived(groupedSetting('memory', 'hypaV3') === true)
  let translator = $derived(groupedSetting('language', 'translator') ?? '')
  let sideMenuRerollButton = $derived(groupedSetting('sidebar', 'sideMenuRerollButton') === true)
  let chatTheme = $derived(groupedSetting('display', 'theme'))
  let useSayNothing = $derived(groupedSetting('advanced', 'useSayNothing') === true)
  let translatorHistoryMaxTokens = $derived(groupedSetting('language', 'translatorHistoryMaxTokens') ?? 2048)
  let autoSuggestionCleanupDatabase = $derived({
    autoSuggestClean: fullSettingsOwner('autoSuggestClean') ?? true,
    modelProfiles: groupedSetting('providers', 'modelProfiles'),
    modelRoleProfiles: groupedSetting('providers', 'modelRoleProfiles'),
    modelRuntimeDefaults: groupedSetting('providers', 'modelRuntimeDefaults'),
    providerCredentials: groupedSetting('providers', 'providerCredentials'),
    modelRoles: groupedSetting('providers', 'modelRoles'),
    subModel: groupedSetting('providers', 'subModel'),
    seperateModelsForAxModels: groupedSetting('runtime', 'seperateModelsForAxModels'),
    seperateModels: groupedSetting('runtime', 'seperateModels'),
  } as Database)

  let messageInput: string = $state('')
  let messageInputTranslate: string = $state('')
  let draftText: string = $state('')
  let btwText: string = $state('')
  let openMenu = $state(false)
  let chatMenuButton: HTMLButtonElement | null = $state(null)
  let chatMenuElement: HTMLDivElement | null = $state(null)
  let loadPages = $state(getInitialChatLoadPages(chatLoadPageSettings()))
  let showBtwHookDialog = $state(false)
  let toggleStickers: boolean = $state(false)
  let fileInput: string[] = $state([])
  let showNewMessageButton = $state(false)
  let showFloatingInputButton = $state(false)
  let floatingInputOpen = $state(false)
  let floatingInputFlowHeight = $state(0)
  let floatingDraftShowsOriginal = $state(false)
  let floatingInputButton: HTMLButtonElement | null = $state(null)
  let chatScreenRoot: HTMLDivElement | null = $state(null)
  let chatScrollContainer: HTMLDivElement | null = $state(null)
  let composerRow: HTMLDivElement | null = $state(null)
  let chatContentRenderedWidth: number | null = $state(null)
  let chatContentInlineEnd: number | null = $state(null)
  let chatContentFixedInlineEnd: number | null = $state(null)
  let refreshChatContentGeometry = () => {}
  let chatsInstance: ReturnType<typeof Chats> | undefined = $state()
  let isScrollingToMessage = $state(false)
  type ChatPreparationKind = 'send' | 'hook' | 'reroll'
  const preparingSendTargetKeys = new SvelteMap<string, ChatPreparationKind>()
  let pinMutationPending = $state(false)
  let composerDraftPersistenceError = $state('')
  const composerDraftPersistenceAlerts = new Set<string>()
  let composerComponentDestroyed = false
  let scrollToMessageRunId = 0
  let composerMutationVersion = 0
  let composerFileInvalidationVersion = 0
  let reattachRecoveryAction: { jobId: string; action: 'retry' | 'refresh' | 'stop' } | null = $state(null)
  let messageInputMutationVersion = 0
  let messageInputTranslateMutationVersion = 0
  let activeTranscriptWindowIdentity: string | null = $state(null)
  let activeTranscriptWindowConfiguredPages: number | null = $state(null)
  let transcriptWindowConfigurationRun = 0
  let activeBgmObserverIdentity: string | null = $state(null)
  let activeScreenshotOperation: ScreenshotOperation | null = null
  let {
    route,
    openModuleList = $bindable(false),
    openChatList = $bindable(false),
    openBardWiki = $bindable(false),
    customStyle = '',
  }: Props = $props()
  let visibleRoute = $derived(route ?? $currentRoute)

  const unregisterComposerDraftStorageFailure = registerDefaultChatComposerDraftStorageFailureListener(() => {
    reportComposerDraftPersistenceError(language.composerDraftRecovery.storageFailed)
  })
  const unregisterAcceptedDraftGeneration = registerAcceptedSendDraftGenerationListener((generation) => {
    const acceptedGeneration = generation as DefaultChatComposerDraftGeneration & {
      acceptedComposerClear?: 'message' | 'all'
    }
    if (
      !canUseClientWriteAccess() ||
      composerComponentDestroyed ||
      getActiveTranscriptWindowIdentity() !== generation.transcriptIdentity ||
      !isDefaultChatComposerDraftGenerationCurrent(generation)
    ) {
      return
    }
    messageInput = ''
    messageInputTranslate = ''
    fileInput = []
    if (acceptedGeneration.acceptedComposerClear === 'all') {
      draftText = ''
      btwText = ''
    }
    composerFileInvalidationVersion += 1
    composerMutationVersion += 1
    updateInputSizeAll()
  })

  onDestroy(
    registerWriterDraftCapture(() => {
      const identity = activeTranscriptWindowIdentity
      if (!identity || (!messageInput && !messageInputTranslate && !draftText && !btwText && fileInput.length === 0))
        return null
      storeComposerDraft(identity)
      const fields = [
        { label: language.connectedReaders.messageDraft, value: messageInput },
        { label: language.editTranslation, value: messageInputTranslate },
        { label: language.connectedReaders.draftInput, value: draftText },
        { label: language.connectedReaders.btwInput, value: btwText },
        { label: language.connectedReaders.attachments, value: fileInput.join('\n') },
      ].filter((field) => field.value.length > 0)
      return {
        key: `composer:${identity}`,
        label: language.connectedReaders.composerDraft,
        route: globalThis.location?.pathname,
        fields,
        data: { messageInput, messageInputTranslate, draftText, btwText, fileInput: [...fileInput] },
      }
    }),
  )

  onDestroy(() => {
    scrollToMessageRunId += 1
    if (activeScreenshotOperation) restoreScreenshotWindow(activeScreenshotOperation)
    if (activeTranscriptWindowIdentity !== null) {
      storeComposerDraft(activeTranscriptWindowIdentity)
    }
    composerComponentDestroyed = true
    unregisterComposerDraftStorageFailure()
    unregisterAcceptedDraftGeneration()
  })

  // Ready character rows are authoritative. The selected index is consulted
  // only while the bootstrap collection is still settling, and stable ids
  // remain duplicate-safe in either phase.
  let currentCharacter = $derived(selectedCharacterForScreen())
  let selectedCharacterOwner = $derived(currentCharacter)
  let currentChatCandidateId = $derived(currentCharacter?.chats?.[currentCharacter.chatPage]?.id)
  let currentChatStructureOwner = $derived(
    currentCharacter?.chaId && currentChatCandidateId
      ? resolveUniqueChatOwner<ChatRecord, character>(
          charactersResourceState.characters,
          currentCharacter.chaId,
          currentChatCandidateId,
        )
      : undefined,
  )
  let currentChatId = $derived(currentChatStructureOwner?.chat.id)
  let currentChatMetadataOwner = $derived(
    currentCharacter?.chaId && currentChatId
      ? getChatMetadataOwnerSnapshot(currentCharacter.chaId, currentChatId)
      : undefined,
  )
  let currentChatMetadata = $derived((currentChatMetadataOwner?.metadata ?? {}) as Partial<ChatRecord>)
  let currentChatOwnerState = $derived(currentChatId ? getChatMessageOwnerState(currentChatId) : undefined)
  let currentChat = $derived(
    resolveTranscriptRenderMessages(currentChatOwnerState, currentChatStructureOwner?.chat.message ?? []),
  )
  let renderChat = $derived(currentChat)
  let regexDisplayReloadToken = $derived(
    regexDisplayReloadTokenForContext($RegexDisplayReloadPointer, $RegexDisplayReloadScope, {
      characterId: currentCharacter?.chaId,
      chatId: currentChatId,
    }),
  )
  let currentAcceptedSendRecoveries = $derived.by(() => {
    void $selectedCharID
    return findAcceptedSendRecoveries($acceptedSendRecoveries, captureActiveChatTarget())
  })
  let currentDisplayCharacter = $derived.by(() => {
    void regexDisplayReloadToken
    if (!currentCharacter) return null
    return createSimpleCharacter(
      currentCharacter,
      untrack(() => currentCharacter.customscript),
    )
  })
  let activeChatOpen = $derived.by(() => {
    if ($selectedCharID < 0) return false
    const character = currentCharacter
    if (character?.chaId === '§playground') {
      return $PlaygroundStore === 2 && Boolean(currentChatId) && Array.isArray(currentChat)
    }
    return routeOwnsSelectedChat(visibleRoute, character?.chaId, currentChatId)
  })
  let currentRerollTarget = $derived(
    currentCharacter && currentChatId
      ? {
          selectedCharID: $selectedCharID,
          chatPage: currentCharacter.chatPage,
          characterId: currentCharacter.chaId,
          chatId: currentChatId,
        }
      : null,
  )
  let greetingTranslatorSettingsSignature = $derived(currentGreetingTranslatorSettingsSignature())
  let greetingTranslationTarget = $derived.by(() => {
    if (!currentCharacter || isServerCharacterShell(currentCharacter) || !currentChatId) return null
    const candidateIndex = currentChatMetadata.fmIndex
    const greetingIndex = Number.isInteger(candidateIndex) && (candidateIndex as number) >= -1 ? candidateIndex : -1
    const source =
      greetingIndex === -1 ? currentCharacter.firstMessage : currentCharacter.alternateGreetings?.[greetingIndex]
    if (
      typeof currentCharacter.chaId !== 'string' ||
      currentCharacter.chaId.length === 0 ||
      typeof source !== 'string'
    ) {
      return null
    }
    return {
      characterId: currentCharacter.chaId,
      chatId: currentChatId,
      greetingIndex,
      source,
      clientSettingsSignature: greetingTranslatorSettingsSignature,
    }
  })
  let greetingTranslation = $derived.by(() => {
    void $greetingTranslationProjectionVersion
    const target = greetingTranslationTarget
    return target ? findGreetingTranslation(target) : null
  })
  let draftHooks = $derived(inputHooks.filter((hook) => hook.type === 'draft'))
  let btwHooks = $derived(inputHooks.filter((hook) => hook.type === 'btw'))
  let selectedDraftHook = $derived.by(() => {
    const selectedId = currentChatMetadata.selectedDraftHookId
    if (!selectedId) return undefined
    return draftHooks.find((hook) => hook.id === selectedId)
  })
  let floatingDraftConversionActive = $derived(
    floatingInputOpen && Boolean(selectedDraftHook) && draftText.trim().length > 0,
  )
  let floatingDraftPreviewVisible = $derived(floatingDraftConversionActive && !floatingDraftShowsOriginal)
  let floatingComposerValue = $derived(floatingDraftPreviewVisible ? draftText : messageInput)
  let floatingDraftConversionWasActive = false

  $effect(() => {
    const active = floatingDraftConversionActive
    if (!active || !floatingDraftConversionWasActive) {
      floatingDraftShowsOriginal = false
    }
    floatingDraftConversionWasActive = active
  })

  let showDraftArea = $derived(Boolean(selectedDraftHook || draftText.length > 0 || btwText.length > 0))
  let canContinueFromMenu = $derived(renderChat.length >= 2 && renderChat[renderChat.length - 1]?.role === 'char')
  let currentChatGenerationActivity = $derived(
    currentChatId
      ? $activeChatGenerations.find((activity) => activity.kind === 'message' && activity.chatId === currentChatId)
      : undefined,
  )
  let currentChatGenerationJob = $derived(
    currentChatId ? $activeGenerationJobs.find((job) => job.chatId === currentChatId) : undefined,
  )
  let currentChatRegenerateTargetMessageId = $derived.by(() => {
    if (currentChatGenerationActivity?.mode === 'regenerate') {
      return currentChatGenerationActivity.targetMessageId ?? null
    }
    if (currentChatGenerationJob?.mode === 'regenerate') {
      return currentChatGenerationJob.targetMessageId ?? currentChatGenerationJob.regenerateMessageId ?? null
    }
    return null
  })
  let currentChatGenerationCancellation = $derived.by(() => {
    if (!currentChatId) return undefined
    const controls = $generationOperationCancellations.filter((control) => control.target?.chatId === currentChatId)
    const liveOperationId = currentChatGenerationActivity?.operationId ?? currentChatGenerationJob?.operationId
    if (liveOperationId) {
      return controls.filter((control) => control.operationId === liveOperationId).at(-1)
    }
    if (currentChatGenerationJob) {
      return controls.filter((control) => control.jobId === currentChatGenerationJob.jobId).at(-1)
    }
    if (currentChatGenerationActivity) {
      return controls
        .filter(
          (control) =>
            control.state !== 'stopped_finalizing' &&
            control.state !== 'settled_cancelled' &&
            control.state !== 'settled_completed' &&
            control.state !== 'settled_nonrunning',
        )
        .at(-1)
    }
    return controls.at(-1)
  })
  let currentChatGenerationOperationId = $derived.by(() => {
    void $generationOperationProjections
    return (
      currentChatGenerationActivity?.operationId ??
      currentChatGenerationJob?.operationId ??
      currentChatGenerationCancellation?.operationId ??
      findGenerationOperationIdForTarget(captureActiveChatTarget())
    )
  })
  let currentChatStopPending = $derived(
    currentChatGenerationCancellation?.disposition !== 'completion_finalizing' &&
      (currentChatGenerationCancellation?.state === 'stop_staging' ||
        currentChatGenerationCancellation?.state === 'stop_sending' ||
        currentChatGenerationCancellation?.state === 'stop_waiting'),
  )
  let currentChatStopFailed = $derived(currentChatGenerationCancellation?.state === 'stop_failed')
  let currentChatStoppedFinalizing = $derived(currentChatGenerationCancellation?.state === 'stopped_finalizing')
  let currentChatCancellationReleasesGenerationClaim = $derived(
    currentChatStoppedFinalizing ||
      currentChatGenerationCancellation?.disposition === 'completion_finalizing' ||
      currentChatGenerationCancellation?.state === 'settled_cancelled' ||
      currentChatGenerationCancellation?.state === 'settled_completed' ||
      currentChatGenerationCancellation?.state === 'settled_nonrunning',
  )
  let currentChatOwnsGeneration = $derived(
    Boolean(
      !currentChatCancellationReleasesGenerationClaim &&
      (currentChatGenerationActivity ||
        currentChatGenerationJob ||
        currentChatGenerationCancellation?.state === 'none' ||
        currentChatStopPending ||
        currentChatStopFailed),
    ),
  )
  let currentChatDeadGeneration = $derived.by(() => {
    if (!currentChatId) return undefined
    return Object.values($generationJobLifecycles).find(
      (lifecycle) => lifecycle.chatId === currentChatId && lifecycle.status === 'exhausted-dead',
    )
  })
  let currentChatGenerationStage = $derived(currentChatGenerationActivity?.stage ?? 0)
  let currentChatGenerationPhase = $derived(
    currentChatGenerationActivity?.phase ?? chatGenerationLoadingPhaseFromStage(currentChatGenerationStage),
  )
  $effect(() => {
    const targetKey = currentChatGenerationActivity?.targetKey
    if (targetKey && preparingSendTargetKeys.get(targetKey) === 'send') {
      preparingSendTargetKeys.delete(targetKey)
    }
  })
  let currentChatPreparationTargetKey = $derived(
    currentCharacter && currentChatId
      ? chatGenerationTargetKey({
          selectedCharID: $selectedCharID,
          chatPage: currentCharacter.chatPage,
          characterId: currentCharacter.chaId,
          chatId: currentChatId,
        })
      : null,
  )
  let currentChatInputHookActivity = $derived(
    currentChatPreparationTargetKey
      ? $activeInputHookActivities.find((activity) => activity.targetKey === currentChatPreparationTargetKey)
      : undefined,
  )
  let doingDraftHook = $derived(currentChatInputHookActivity?.kind === 'draft')
  let doingBtwHook = $derived(currentChatInputHookActivity?.kind === 'btw')
  let hookRunActive = $derived(currentChatInputHookActivity !== undefined)
  let currentChatPreparingSend = $derived(
    currentChatPreparationTargetKey !== null && preparingSendTargetKeys.has(currentChatPreparationTargetKey),
  )
  let currentChatPreparationKind = $derived(
    currentChatPreparationTargetKey === null ? undefined : preparingSendTargetKeys.get(currentChatPreparationTargetKey),
  )
  let visibleChatProcessStage = $derived(currentChatInputHookActivity?.stage ?? currentChatGenerationStage)
  let visibleChatProcessPhase = $derived(
    currentChatInputHookActivity ? ('input-hook' as const) : currentChatGenerationPhase,
  )
  type ComposerPrimaryControlMode = 'preparing' | 'cancel' | 'convert' | 'send'
  let composerPrimaryControlMode: ComposerPrimaryControlMode = $derived(
    currentChatPreparationKind === 'send' && !currentChatOwnsGeneration && !hookRunActive
      ? 'preparing'
      : currentChatOwnsGeneration || hookRunActive
        ? 'cancel'
        : floatingDraftConversionActive
          ? 'convert'
          : 'send',
  )
  let composerPrimaryControlPreparing = $derived(composerPrimaryControlMode === 'preparing')
  let composerPrimaryControlCancelling = $derived(composerPrimaryControlMode === 'cancel')
  let composerPrimaryControlConverting = $derived(composerPrimaryControlMode === 'convert')
  let composerPrimaryControlLabel = $derived(
    composerPrimaryControlMode === 'cancel'
      ? currentChatStopPending
        ? language.generationStop.stopping
        : currentChatStopFailed
          ? language.generationStop.retry
          : language.cancelGeneration
      : composerPrimaryControlMode === 'convert'
        ? language.inputHookConvert
        : language.hotkeyDesc.send,
  )
  let composerPrimaryControlExpanded = $derived(
    composerPrimaryControlMode === 'cancel' && (currentChatStopPending || currentChatStopFailed),
  )

  function handleComposerPrimaryControl(): void {
    if (composerPrimaryControlMode === 'preparing') return
    if (composerPrimaryControlMode === 'cancel') {
      abortChat()
      return
    }
    if (composerPrimaryControlMode === 'convert') {
      toggleFloatingDraftConversion()
      return
    }
    void send()
  }
  let configuredChatLoadPages = $derived(getInitialChatLoadPages(chatLoadPageSettings()))
  // The open chat ships as a message-less shell until the chat-messages resource
  // resolves; show a loading state over the message area until then so the
  // history does not flash in over the greeting-only stub.
  let activeChatMessagesLoading = $derived(
    activeChatOpen && isChatMessageHydrationPending(currentChatId, renderChat.length),
  )
  let activeChatMessagesFailed = $derived(
    activeChatOpen && hasChatMessageHydrationFailed(currentChatId, renderChat.length),
  )
  let activeChatDisplayLoading = $state(false)
  let displayDependencyScope = $state<string | null>(null)
  let displayDependenciesReleased = $state(false)
  let retryingDisplayDependencies = $state(false)
  let displayDependencyStatus = $derived(
    chatDisplayDependencyStatus(
      $pluginRuntimeStateStore.phase,
      $startupCoordinatorStore.failures.pluginsReady !== undefined,
    ),
  )
  let activeChatDisplayDependenciesPending = $derived(
    activeChatOpen && (displayDependencyScope !== currentChatId || !displayDependenciesReleased),
  )

  $effect.pre(() => {
    const scope = activeChatOpen ? currentChatId : null
    if (scope !== displayDependencyScope || activeChatMessagesLoading) {
      displayDependencyScope = scope
      displayDependenciesReleased = false
    }
    // Later dependency reloads reparse mounted bodies and retain their HTML.
    // Only chat entry or an authoritative transcript re-stub starts a new gate.
    if (scope && !activeChatMessagesLoading && displayDependencyStatus === 'ready') {
      displayDependenciesReleased = true
    }
  })

  async function retryChatDisplayDependencies(): Promise<void> {
    if (!canUseClientWriteAccess() || retryingDisplayDependencies) return
    const clientGeneration = captureClientSessionGeneration()
    retryingDisplayDependencies = true
    try {
      const { ensureResourceSurfaces } = await import('src/ts/server/routeResourceLoader')
      if (!isClientWriteOperationCurrent(clientGeneration)) return
      await Promise.all([
        ensureResourceSurfaces(['runtime:chat-display']),
        $pluginRuntimeStateStore.phase === 'error' || $startupCoordinatorStore.failures.pluginsReady
          ? $startupCoordinatorStore.failures.pluginsReady
            ? import('src/ts/bootstrap').then(({ retryPluginStartup }) => {
                if (isClientWriteOperationCurrent(clientGeneration)) return retryPluginStartup()
              })
            : retryPluginRuntime()
          : Promise.resolve(),
      ])
    } catch (error) {
      // Resource/plugin owners retain the failure and keep Retry available.
      console.warn('Chat display dependencies could not be loaded:', error)
    } finally {
      retryingDisplayDependencies = false
    }
  }

  $effect(() => {
    if (!currentCharacter || isServerCharacterShell(currentCharacter)) return
    const characterId = currentCharacter.chaId
    const chatId = currentChatId
    const clientSettingsSignature = greetingTranslatorSettingsSignature
    if (typeof characterId !== 'string' || characterId.length === 0 || !chatId) return
    void refreshGreetingTranslationProjection(characterId, chatId, { clientSettingsSignature })
  })

  async function retryActiveChatHydration() {
    await hydrateActiveChat({ force: true })
  }

  async function runReattachRecoveryAction(jobId: string, action: 'retry' | 'refresh' | 'stop'): Promise<void> {
    if (!canUseClientWriteAccess()) return
    if (reattachRecoveryAction) return
    reattachRecoveryAction = { jobId, action }
    try {
      if (action === 'retry') await retryGenerationJobReattach(jobId)
      else if (action === 'refresh') await refreshGenerationJobFromBootstrap(jobId)
      else await stopGenerationJob(jobId)
    } finally {
      if (reattachRecoveryAction?.jobId === jobId && reattachRecoveryAction.action === action) {
        reattachRecoveryAction = null
      }
    }
  }

  function getChatMenuItems(): HTMLButtonElement[] {
    return Array.from(
      chatMenuElement?.querySelectorAll<HTMLButtonElement>('[data-default-chat-menu-item]:not(:disabled)') ?? [],
    )
  }

  function closeChatMenu(options: { restoreFocus?: boolean } = {}): void {
    if (!openMenu) return

    const focusWasInMenu = chatMenuElement?.contains(document.activeElement) ?? false
    openMenu = false

    void tick().then(() => {
      if (!chatMenuButton?.isConnected) return

      const activeElement = document.activeElement
      const focusIsUnclaimed = !activeElement || activeElement === document.body
      if (options.restoreFocus || (focusWasInMenu && focusIsUnclaimed)) {
        chatMenuButton.focus()
      }
    })
  }

  function toggleChatMenu(event: MouseEvent): void {
    event.stopPropagation()

    if (openMenu) {
      closeChatMenu({ restoreFocus: true })
      return
    }

    refreshChatContentGeometry()
    openMenu = true
    void tick().then(() => {
      refreshChatContentGeometry()
      getChatMenuItems()[0]?.focus()
    })
  }

  function handleChatMenuKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeChatMenu({ restoreFocus: true })
      return
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return

    const items = getChatMenuItems()
    if (items.length === 0) return

    event.preventDefault()
    event.stopPropagation()

    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Home') {
      items[0].focus()
      return
    }
    if (event.key === 'End') {
      items[items.length - 1].focus()
      return
    }

    const nextIndex =
      event.key === 'ArrowDown'
        ? currentIndex < 0
          ? 0
          : (currentIndex + 1) % items.length
        : currentIndex <= 0
          ? items.length - 1
          : currentIndex - 1
    items[nextIndex].focus()
  }

  function scrollToBottom() {
    chatsInstance?.scrollToLatestMessage()
  }

  function floatingInputEnabled(): boolean {
    return floatingChatInput && !fixedChatTextarea
  }

  function toggleFloatingDraftConversion(): void {
    if (!floatingDraftConversionActive) return

    floatingDraftShowsOriginal = !floatingDraftShowsOriginal
    void tick().then(updateInputSize)
  }

  function trackChatContentGeometry(node: HTMLElement, configuredWidth: number) {
    let currentConfiguredWidth = configuredWidth

    const measure = () => {
      const rect = node.getBoundingClientRect()
      const availableWidth = node.clientWidth || rect.width
      if (availableWidth <= 0) return

      const renderedWidth = Math.min(Math.max(currentConfiguredWidth, 0), availableWidth)
      const inlineEnd = Math.max(0, (availableWidth - renderedWidth) / 2)
      const contentRight = rect.left + node.clientLeft + availableWidth - inlineEnd
      const fixedContainingRight = customStyle.includes('backdrop-filter')
        ? (chatScreenRoot?.getBoundingClientRect().right ?? window.innerWidth)
        : window.innerWidth
      const fixedInlineEnd = Math.max(0, fixedContainingRight - contentRight)

      if (chatContentRenderedWidth !== renderedWidth) chatContentRenderedWidth = renderedWidth
      if (chatContentInlineEnd !== inlineEnd) chatContentInlineEnd = inlineEnd
      if (chatContentFixedInlineEnd !== fixedInlineEnd) chatContentFixedInlineEnd = fixedInlineEnd
    }

    refreshChatContentGeometry = measure
    window.addEventListener('resize', measure)

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    let observedElement: HTMLElement | null = node
    while (resizeObserver && observedElement) {
      resizeObserver.observe(observedElement)
      observedElement = observedElement.parentElement
    }

    measure()

    return {
      update(nextConfiguredWidth: number) {
        currentConfiguredWidth = nextConfiguredWidth
        measure()
      },
      destroy() {
        window.removeEventListener('resize', measure)
        resizeObserver?.disconnect()
        if (refreshChatContentGeometry === measure) refreshChatContentGeometry = () => {}
      },
    }
  }

  function updateFloatingInputForScroll(chatTarget: HTMLElement): void {
    if (!floatingInputEnabled()) {
      showFloatingInputButton = false
      floatingInputOpen = false
      return
    }

    const distanceFromBottom = Math.max(0, -chatTarget.scrollTop)
    if (distanceFromBottom <= 1) {
      const wasFloating = floatingInputOpen
      showFloatingInputButton = false
      floatingInputOpen = false
      if (wasFloating) openMenu = false
      return
    }

    if (floatingInputOpen) return

    const composerHeight = composerRow?.getBoundingClientRect().height ?? 0
    const revealThreshold = Math.max(24, composerHeight / 2)
    showFloatingInputButton = distanceFromBottom >= revealThreshold
  }

  async function openFloatingInput(): Promise<void> {
    if (!floatingInputEnabled()) return

    const scrollContainer = chatScrollContainer
    const preservedScrollTop = scrollContainer?.scrollTop
    // Keep the composer's space in reverse flow while its surface is fixed;
    // otherwise transcript anchoring shifts history when the card opens/closes.
    floatingInputFlowHeight =
      scrollContainer?.querySelector('[data-default-chat-composer-flow]')?.getBoundingClientRect().height ?? 0
    refreshChatContentGeometry()
    floatingInputOpen = true
    showFloatingInputButton = false
    await tick()
    if (!floatingInputOpen || scrollContainer !== chatScrollContainer) return

    updateInputSize()
    refreshChatContentGeometry()

    if (preservedScrollTop !== undefined && scrollContainer) {
      scrollContainer.scrollTop = preservedScrollTop
    }
    inputEle?.focus({ preventScroll: true })
  }

  async function hideFloatingInput(): Promise<void> {
    const preservedScrollTop = chatScrollContainer?.scrollTop
    openMenu = false
    floatingInputOpen = false
    showFloatingInputButton = true
    await tick()

    floatingInputButton?.focus({ preventScroll: true })
    if (preservedScrollTop !== undefined && chatScrollContainer) {
      chatScrollContainer.scrollTop = preservedScrollTop
    }
  }

  async function goToBottomFromFloatingInput(): Promise<void> {
    openMenu = false
    floatingInputOpen = false
    showFloatingInputButton = false
    await tick()
    chatsInstance?.scrollToNaturalEnd()
    inputEle?.focus({ preventScroll: true })
  }

  function getActiveTranscriptWindowIdentity(): string | null {
    const selectedCharacterIndex = $selectedCharID
    const character = currentCharacter
    const chatPage = character?.chatPage ?? null

    return buildTranscriptWindowIdentity({
      selectedCharacterIndex,
      characterId: character?.chaId,
      chatPage,
      chatId: currentChatId,
    })
  }

  function claimPreparingSendTarget(target: ActiveChatTarget, kind: ChatPreparationKind): string | null {
    const targetKey = chatGenerationTargetKey(target)
    if (!targetKey || preparingSendTargetKeys.has(targetKey)) return null
    preparingSendTargetKeys.set(targetKey, kind)
    return targetKey
  }

  function releasePreparingSendTarget(targetKey: string): void {
    preparingSendTargetKeys.delete(targetKey)
  }

  function beginScreenshotOperation(): ScreenshotOperation | null {
    const target = captureActiveChatTarget()
    const transcriptIdentity = getActiveTranscriptWindowIdentity()
    if (!activeChatOpen || !target || !transcriptIdentity || !isActiveChatTargetFresh(target)) return null

    const operation = {
      target,
      transcriptIdentity,
      previousLoadPages:
        activeScreenshotOperation?.transcriptIdentity === transcriptIdentity
          ? activeScreenshotOperation.previousLoadPages
          : loadPages,
    }
    activeScreenshotOperation = operation
    return operation
  }

  function isCurrentScreenshotOperation(operation: ScreenshotOperation): boolean {
    return (
      activeScreenshotOperation === operation &&
      !composerComponentDestroyed &&
      activeChatOpen &&
      getActiveTranscriptWindowIdentity() === operation.transcriptIdentity &&
      isActiveChatTargetFresh(operation.target)
    )
  }

  function restoreScreenshotWindow(operation: ScreenshotOperation): void {
    if (activeScreenshotOperation !== operation) return

    if (getActiveTranscriptWindowIdentity() === operation.transcriptIdentity) {
      loadPages = operation.previousLoadPages
    } else if (loadPages === Infinity) {
      loadPages = configuredChatLoadPages
    }
    activeScreenshotOperation = null
  }

  let transcriptRouteWasVisible = false
  $effect.pre(() => {
    // The chat-list route can keep this screen owner alive with the same
    // selected chat. Cancel on visibility loss before a quick return can make
    // an old capture appear current again.
    const visible = activeChatOpen
    untrack(() => {
      if (transcriptRouteWasVisible && !visible) {
        scrollToMessageRunId += 1
        isScrollingToMessage = false
      }
      transcriptRouteWasVisible = visible
      if (visible) return
      if (activeScreenshotOperation) restoreScreenshotWindow(activeScreenshotOperation)
    })
  })

  function markComposerDraftChanged(
    fields: ComposerDraftField | ComposerDraftField[] = ['message', 'translation', 'files', 'draft', 'btw'],
  ) {
    const changedFields = Array.isArray(fields) ? fields : [fields]
    composerMutationVersion += 1
    if (changedFields.includes('message')) {
      messageInputMutationVersion += 1
    }
    if (changedFields.includes('translation')) {
      messageInputTranslateMutationVersion += 1
    }

    const identity = getActiveTranscriptWindowIdentity()
    if (identity) {
      storeComposerDraft(identity)
    }
  }

  function reportComposerDraftPersistenceError(message: string): void {
    composerDraftPersistenceError = message
    if (composerDraftPersistenceAlerts.has(message)) return
    composerDraftPersistenceAlerts.add(message)
    alertError(message)
  }

  function storeComposerDraft(identity: string): DefaultChatComposerDraftGeneration | null {
    if (
      messageInput === '' &&
      messageInputTranslate === '' &&
      fileInput.length === 0 &&
      draftText === '' &&
      btwText === ''
    ) {
      deleteDefaultChatComposerDraft(identity)
      return null
    }

    return writeDefaultChatComposerDraft(identity, {
      messageInput,
      messageInputTranslate,
      fileInput: [...fileInput],
      draftText,
      btwText,
    } satisfies DefaultChatComposerDraft)
  }

  function restoreComposerDraft(identity: string | null): void {
    const draft = identity ? readDefaultChatComposerDraft(identity) : undefined
    messageInput = draft?.messageInput ?? ''
    messageInputTranslate = draft?.messageInputTranslate ?? ''
    fileInput = [...(draft?.fileInput ?? [])]
    draftText = draft?.draftText ?? ''
    btwText = draft?.btwText ?? ''
    markComposerDraftChanged()
    void tick().then(updateInputSizeAll)
  }

  function beginComposerFileOperation(): ComposerFileOperation | null {
    if (!canUseClientWriteAccess()) return null
    const targetIdentity = getActiveTranscriptWindowIdentity()
    if (!targetIdentity) return null

    return {
      clientGeneration: captureClientSessionGeneration(),
      token: composerFileOperationGuard.issue(targetIdentity),
      targetIdentity,
      invalidationVersion: composerFileInvalidationVersion,
    }
  }

  function isCurrentComposerFileOperation(operation: ComposerFileOperation): boolean {
    return (
      isClientWriteOperationCurrent(operation.clientGeneration) &&
      composerFileOperationGuard.isLatest(operation.token) &&
      getActiveTranscriptWindowIdentity() === operation.targetIdentity &&
      composerFileInvalidationVersion === operation.invalidationVersion
    )
  }

  function beginComposerOperation(kind: ComposerOperationKind): ComposerOperation | null {
    if (!canUseClientWriteAccess()) return null
    const targetIdentity = getActiveTranscriptWindowIdentity()
    if (!targetIdentity) return null

    const draftGeneration = storeComposerDraft(targetIdentity)
    return {
      clientGeneration: captureClientSessionGeneration(),
      token: composerOperationGuard.issue(targetIdentity),
      kind,
      targetIdentity,
      composerVersion: composerMutationVersion,
      messageInput,
      messageInputTranslate,
      fileInput: [...fileInput],
      draftText,
      btwText,
      draftGeneration,
    }
  }

  function isCurrentComposerOperation(operation: ComposerOperation): boolean {
    return (
      isClientWriteOperationCurrent(operation.clientGeneration) &&
      !composerComponentDestroyed &&
      composerOperationGuard.isLatest(operation.token) &&
      getActiveTranscriptWindowIdentity() === operation.targetIdentity &&
      composerMutationVersion === operation.composerVersion
    )
  }

  function isCapturedComposerSurfaceCurrent(operation: ComposerOperation): boolean {
    return (
      isClientWriteOperationCurrent(operation.clientGeneration) &&
      !composerComponentDestroyed &&
      getActiveTranscriptWindowIdentity() === operation.targetIdentity &&
      composerMutationVersion === operation.composerVersion
    )
  }

  function consumeAcceptedComposerDraftGeneration(operation: ComposerOperation): boolean {
    if (!operation.draftGeneration) return true
    if (!isDefaultChatComposerDraftGenerationCurrent(operation.draftGeneration)) return false
    deleteDefaultChatComposerDraft(operation.targetIdentity, operation.draftGeneration)
    return true
  }

  function restoreComposerForCurrentOperation(operation: ComposerOperation): boolean {
    if (!isCurrentComposerOperation(operation)) return false

    messageInput = operation.messageInput
    messageInputTranslate = operation.messageInputTranslate
    fileInput = [...operation.fileInput]
    draftText = operation.draftText
    btwText = operation.btwText
    markComposerDraftChanged()
    updateInputSizeAll()
    return true
  }

  function clearComposerForCurrentOperation(operation: ComposerOperation): boolean {
    const clearVisibleComposer = isCurrentComposerOperation(operation)
    if (!consumeAcceptedComposerDraftGeneration(operation) || !clearVisibleComposer) return false

    messageInput = ''
    messageInputTranslate = ''
    fileInput = []
    composerFileInvalidationVersion += 1
    markComposerDraftChanged()
    updateInputSizeAll()
    return true
  }

  function clearComposerAndDraftForCurrentOperation(operation: ComposerOperation): boolean {
    const clearVisibleComposer = isCurrentComposerOperation(operation)
    if (!consumeAcceptedComposerDraftGeneration(operation) || !clearVisibleComposer) return false

    messageInput = ''
    messageInputTranslate = ''
    fileInput = []
    draftText = ''
    btwText = ''
    composerFileInvalidationVersion += 1
    markComposerDraftChanged()
    updateInputSizeAll()
    return true
  }

  function clearMessageInputForCurrentOperation(operation?: ComposerOperation): boolean {
    if (operation && !isCurrentComposerOperation(operation)) return false

    messageInput = ''
    composerFileInvalidationVersion += 1
    markComposerDraftChanged('message')
    return true
  }

  function settleQueuedComposerOperation(operation: ComposerOperation, clearDraftFields: boolean): void {
    const clearVisibleComposer = !composerComponentDestroyed && isCapturedComposerSurfaceCurrent(operation)
    if (!consumeAcceptedComposerDraftGeneration(operation) || !clearVisibleComposer) return
    if (clearDraftFields) {
      messageInput = ''
      messageInputTranslate = ''
      fileInput = []
      draftText = ''
      btwText = ''
    } else {
      messageInput = ''
      messageInputTranslate = ''
      fileInput = []
    }
    composerFileInvalidationVersion += 1
    markComposerDraftChanged()
    updateInputSizeAll()
  }

  function chatForTarget(target: ActiveChatTarget) {
    return targetChatWithTranscript(target)?.chat
  }

  function handoffAcceptedSend(input: {
    target: ActiveChatTarget
    preparingTargetKey: string
    append?: Exclude<Awaited<ReturnType<typeof appendCurrentChatUserMessageForSend>>, { status: 'error' }>
    message?: Message
    composerOperation: ComposerOperation
    clearDraftFields: boolean
    confirmBoundary: boolean
    syntheticSayNothing?: boolean
  }): void {
    const previousLength = chatForTarget(input.target)?.message.length ?? 0
    const generation = coordinateAcceptedChatSend({
      clientGeneration: input.composerOperation.clientGeneration,
      target: input.target,
      ...(input.append ? { append: input.append } : {}),
      ...(input.message ? { message: input.message } : {}),
      ...(input.composerOperation.draftGeneration
        ? {
            draftGeneration: {
              ...input.composerOperation.draftGeneration,
              acceptedComposerClear: input.clearDraftFields ? ('all' as const) : ('message' as const),
            },
          }
        : {}),
      syntheticSayNothing: input.syntheticSayNothing,
      onAppendAccepted: () => {
        if (input.append?.status === 'queued') {
          settleQueuedComposerOperation(input.composerOperation, input.clearDraftFields)
        } else if (input.clearDraftFields) {
          clearComposerAndDraftForCurrentOperation(input.composerOperation)
        } else {
          clearComposerForCurrentOperation(input.composerOperation)
        }
      },
      onAppendFailed: (failure) => {
        if (!isClientWriteOperationCurrent(input.composerOperation.clientGeneration)) return
        const detail =
          failure.kind === 'known' ? language.composerDraftRecovery.sendFailureDetails[failure.reason] : failure.message
        reportComposerDraftPersistenceError(language.composerDraftRecovery.sendFailed(detail))
      },
    })

    void generation.then((result) => {
      if (result.status !== 'generated' || !isClientWriteOperationCurrent(input.composerOperation.clientGeneration))
        return
      applySuccessfulSendChatEffects(
        { sendSucceeded: true, previousLength, confirmBoundary: input.confirmBoundary },
        {
          clearRerollBuffer: () => clearRerollBuffer(input.target),
          recordGeneratedReroll: (length) => recordGeneratedReroll(length, input.target),
          markRerollChar: () => markRerollChar(input.target),
        },
      )
    })
    void generation.then(
      () => releasePreparingSendTarget(input.preparingTargetKey),
      () => releasePreparingSendTarget(input.preparingTargetKey),
    )
  }

  function applyChatFileResultsForCurrentComposer(
    results: PostChatFileResults | null,
    operation: ComposerFileOperation,
  ): boolean {
    if (!results) return false
    if (!isCurrentComposerFileOperation(operation)) {
      alertError(language.composerFileResultDiscarded)
      return false
    }

    let nextMessageInput = messageInput
    const nextFileInput = [...fileInput]
    let changed = false

    for (const res of results) {
      if (res?.type === 'asset') {
        nextFileInput.push(res.data)
        changed = true
      }
      if (res?.type === 'text') {
        nextMessageInput += `{{file::${res.name}::${res.data}}}`
        changed = true
      }
    }

    if (!changed) return false

    messageInput = nextMessageInput
    fileInput = nextFileInput
    markComposerDraftChanged(['message', 'files'])
    updateInputSizeAll()
    return true
  }

  function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (event) => {
        const result = event.target?.result
        if (result instanceof ArrayBuffer) {
          resolve(result)
          return
        }
        reject(new Error('FileReader did not return an ArrayBuffer.'))
      }
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'))
      reader.readAsArrayBuffer(file)
    })
  }

  async function handleComposerPaste(event: ClipboardEvent) {
    const items = event.clipboardData?.items
    if (!items) return

    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image')) {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }

    if (files.length === 0) return

    event.preventDefault()
    const operation = beginComposerFileOperation()
    if (!operation) return

    try {
      const collectedResults: PostChatFileResults = []
      for (const file of files) {
        const buffer = await readFileAsArrayBuffer(file)
        if (!isCurrentComposerFileOperation(operation)) {
          alertError(language.composerFileResultDiscarded)
          return
        }

        const results = await postChatFile({
          name: file.name,
          data: new Uint8Array(buffer),
        })
        if (!isCurrentComposerFileOperation(operation)) {
          alertError(language.composerFileResultDiscarded)
          return
        }
        if (results) collectedResults.push(...results)
      }

      applyChatFileResultsForCurrentComposer(collectedResults, operation)
    } catch (error) {
      if (isCurrentComposerFileOperation(operation)) {
        alertError(error)
      }
    } finally {
      composerFileOperationGuard.clear(operation.token)
    }
  }

  async function postFileFromMenu() {
    const operation = beginComposerFileOperation()
    if (!operation) return

    try {
      const results = await postChatFile(messageInput)
      applyChatFileResultsForCurrentComposer(results, operation)
    } catch (error) {
      if (isCurrentComposerFileOperation(operation)) {
        alertError(error)
      }
    } finally {
      composerFileOperationGuard.clear(operation.token)
    }
  }

  async function toggleCurrentChatPin(): Promise<void> {
    if (!canUseClientWriteAccess()) return
    if (pinMutationPending || !currentChatId) return
    pinMutationPending = true
    const outcomePromise = setCurrentChatPinnedWithOutcome(currentChatMetadata.pinned !== true)
    closeChatMenu()
    try {
      const outcome = await outcomePromise
      if (outcome?.status === 'queued') alertNormal(language.pinChatQueued)
      else if (outcome?.status === 'failed') alertError(language.pinChatFailed)
    } catch {
      alertError(language.pinChatFailed)
    } finally {
      pinMutationPending = false
    }
  }

  function resetTranscriptWindowForChatSwitch() {
    loadPages = configuredChatLoadPages
    isScrollingToMessage = false
    scrollToMessageRunId += 1
    const activeTarget = captureActiveChatTarget()
    const foldTargetsActiveChat =
      chatFoldedState.data?.targetChatId === activeTarget?.chatId &&
      chatFoldedState.data?.targetCharacterId === activeTarget?.characterId
    if (!foldTargetsActiveChat) {
      chatFoldedState.data = null
      chatFoldedStateMessageIndex.index = -1
    }
  }

  let mostRecentChat = $derived.by(() => {
    const character = currentCharacter
    if (!character?.chaId) return null
    const candidate = character.chats?.[character.chatPage] ?? character.chats?.[0]
    if (!candidate?.id) return null
    return (
      resolveUniqueChatOwner<ChatRecord, character>(charactersResourceState.characters, character.chaId, candidate.id)
        ?.chat ?? null
    )
  })

  function openMostRecentChat() {
    const character = currentCharacter
    const chat = mostRecentChat
    if (!character?.chaId || !chat?.id) return

    navigate(characterRoutePath(character.chaId, chat.id))
  }

  async function expandTranscriptWindow(nextLoadPages: number, applyWindow = true): Promise<boolean> {
    const targetIdentity = getActiveTranscriptWindowIdentity()
    if (!targetIdentity) return false
    if (nextLoadPages <= loadPages) return true
    const hydrated = await hydrateActiveChatWindow(nextLoadPages)
    if (getActiveTranscriptWindowIdentity() !== targetIdentity) return false
    if (!hydrated) return false
    if (applyWindow) loadPages = Math.max(loadPages, nextLoadPages)
    return true
  }

  $effect(() => {
    const nextIdentity = getActiveTranscriptWindowIdentity()
    if (activeTranscriptWindowIdentity === nextIdentity) {
      return
    }

    const previousIdentity = activeTranscriptWindowIdentity
    if (previousIdentity !== null) {
      untrack(() => storeComposerDraft(previousIdentity))
    }
    activeTranscriptWindowIdentity = nextIdentity
    activeTranscriptWindowConfiguredPages = configuredChatLoadPages
    transcriptWindowConfigurationRun += 1
    loadPages = configuredChatLoadPages
    showFloatingInputButton = false
    floatingInputOpen = false
    openMenu = false
    untrack(() => restoreComposerDraft(nextIdentity))

    if (previousIdentity !== null) {
      resetTranscriptWindowForChatSwitch()
    }
  })

  $effect(() => {
    if (floatingInputEnabled()) return

    showFloatingInputButton = false
    floatingInputOpen = false
  })

  $effect(() => {
    const targetIdentity = getActiveTranscriptWindowIdentity()
    const nextLoadPages = configuredChatLoadPages
    if (!targetIdentity || activeTranscriptWindowIdentity !== targetIdentity) return
    if (activeTranscriptWindowConfiguredPages === nextLoadPages) return

    activeTranscriptWindowConfiguredPages = nextLoadPages
    const run = ++transcriptWindowConfigurationRun
    scrollToMessageRunId += 1
    isScrollingToMessage = false

    if (activeScreenshotOperation?.transcriptIdentity === targetIdentity) {
      activeScreenshotOperation.previousLoadPages = nextLoadPages
      return
    }
    if (nextLoadPages <= loadPages) {
      loadPages = nextLoadPages
      return
    }

    void hydrateActiveChatWindow(nextLoadPages).then((hydrated) => {
      if (
        !hydrated ||
        run !== transcriptWindowConfigurationRun ||
        activeTranscriptWindowIdentity !== targetIdentity ||
        getActiveTranscriptWindowIdentity() !== targetIdentity ||
        configuredChatLoadPages !== nextLoadPages
      ) {
        return
      }
      loadPages = nextLoadPages
    })
  })

  $effect.pre(() => {
    const nextIdentity = getActiveTranscriptWindowIdentity()
    if (activeBgmObserverIdentity === nextIdentity) {
      return
    }

    const previousIdentity = activeBgmObserverIdentity
    activeBgmObserverIdentity = nextIdentity
    if (previousIdentity !== null) {
      resetBgmObserverForChatSwitch()
    }
  })

  $effect(() => {
    if (ScrollToMessageStore.value !== -1) {
      const index = ScrollToMessageStore.value
      ScrollToMessageStore.value = -1
      scrollToMessage(index)
    }
  })

  async function scrollToMessage(index: number) {
    const targetIdentity = getActiveTranscriptWindowIdentity()
    if (!targetIdentity || !Number.isInteger(index) || index < 0) {
      return
    }

    const runId = ++scrollToMessageRunId
    const isCurrentJump = () =>
      !composerComponentDestroyed &&
      scrollToMessageRunId === runId &&
      getActiveTranscriptWindowIdentity() === targetIdentity

    // Hydration and DOM residency are separate; pin only this jump's target.
    let releaseResidentTarget: (() => void) | undefined
    isScrollingToMessage = true
    try {
      const totalMessages = renderChat.length
      const neededLoadPages = getLoadPagesForMessageJump(loadPages, totalMessages, index)

      if (loadPages < neededLoadPages) {
        const hydrated = await hydrateActiveChatWindow(neededLoadPages)
        if (!isCurrentJump()) {
          return
        }
        if (!hydrated) {
          return
        }
        loadPages = neededLoadPages
        await tick()
        if (!isCurrentJump()) {
          return
        }
      }

      // A bookmark can enter an already-hydrated chat without expanding its
      // window. Wait for its Chats binding/entry alignment in that case too.
      await tick()
      if (!isCurrentJump()) return

      // Client navigation can publish its queued jump before the chat route
      // becomes visible. Wait for the live transcript, not a stale binding or
      // a single Svelte flush; keep the same identity fence while waiting.
      for (let attempt = 0; attempt < 50; attempt++) {
        if (!isCurrentJump()) return
        if (activeChatOpen && chatsInstance) {
          releaseResidentTarget = (await chatsInstance.prepareMessageJump(index, currentChatId)) ?? undefined
          if (releaseResidentTarget) break
        }
        await sleep(100)
      }
      if (!releaseResidentTarget) return
      if (!isCurrentJump()) return

      let element: Element | null = null
      // Poll for element existence (max 5 seconds)
      for (let i = 0; i < 50; i++) {
        if (!isCurrentJump()) {
          return
        }
        element = document.querySelector(`[data-chat-index="${index}"]`)
        if (element) break
        await sleep(100)
      }

      if (!isCurrentJump()) {
        return
      }

      const preIndex = Math.max(0, index - 3)
      const preElement = document.querySelector(`[data-chat-index="${preIndex}"]`)
      if (preElement) {
        preElement.scrollIntoView({ behavior: 'instant', block: 'start' })
      } else {
        element?.scrollIntoView({ behavior: 'instant', block: 'start' })
      }
      await sleep(50)

      if (!isCurrentJump()) {
        return
      }

      if (element) {
        // Wait for images to load to prevent layout shift
        const chatContainer = document.querySelector('.default-chat-screen')
        if (chatContainer) {
          const images = Array.from(chatContainer.querySelectorAll('img'))
          const promises = images.map((img) => {
            if (img.complete) return Promise.resolve()
            return new Promise((resolve) => {
              img.onload = () => resolve(null)
              img.onerror = () => resolve(null)
            })
          })
          // Wait for all images or timeout after 4 seconds
          await Promise.race([Promise.all(promises), sleep(4000)])
        }

        element.scrollIntoView({ behavior: 'instant', block: 'start' })

        if (!isCurrentJump()) {
          return
        }

        // Small delay and scroll again to ensure position is correct after any final layout adjustments
        await sleep(50)
        if (!isCurrentJump()) {
          return
        }
        element.scrollIntoView({ behavior: 'instant', block: 'start' })

        element.classList.add('ring-2', 'ring-blue-500')
        setTimeout(() => {
          element.classList.remove('ring-2', 'ring-blue-500')
        }, 2000)
      }
    } finally {
      releaseResidentTarget?.()
      if (scrollToMessageRunId === runId) {
        isScrollingToMessage = false
      }
    }
  }

  async function send() {
    return sendMain(false)
  }
  async function sendContinue() {
    return sendMain(true)
  }

  function shouldSendFromComposerKeydown(event: KeyboardEvent): boolean {
    if (event.key.toLocaleLowerCase() !== 'enter' || event.isComposing) return false
    return sendWithEnter ? !event.shiftKey : event.shiftKey
  }

  function appendInlayMarkers(files: string[]): string {
    return files.map((file) => `{{inlayed::${file}}}`).join('')
  }

  function inputHookHistoryWindowIsResident(messages: readonly Message[], count: number): boolean {
    let visibleRows = 0
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.disabled === 'allBefore') return true
      if (isServerChatMessagePlaceholder(message)) return false
      if (message.disabled === true || message.isComment === true) continue
      visibleRows += 1
      if (visibleRows >= count) return true
    }
    return true
  }

  function snapshotInputHookHistoryContext(target: ActiveChatTarget): InputHookHistoryContext | null {
    if (!isActiveChatTargetFresh(target)) return null
    const owner = targetChatWithTranscript(target)
    const character = owner?.character
    const chat = owner?.chat
    if (!character || !chat || character.chaId !== target.characterId || chat.id !== target.chatId) return null

    const targetGreeting = greetingTranslationTarget
    const persistedGreetingTranslation = greetingTranslation
    const greetingMatchesTarget =
      targetGreeting?.characterId === target.characterId && targetGreeting.chatId === target.chatId

    return {
      messages: chat.message.map((message) => ({
        role: message.role,
        data: message.data,
        ...(message.translation ? { translation: { text: message.translation.text } } : {}),
        ...(message.disabled === undefined ? {} : { disabled: message.disabled }),
        ...(message.isComment === undefined ? {} : { isComment: message.isComment }),
      })),
      messageIndex: chat.message.length,
      greeting: greetingMatchesTarget
        ? {
            source: targetGreeting.source,
            ...(persistedGreetingTranslation ? { translated: persistedGreetingTranslation.text } : {}),
          }
        : { source: '' },
      maxTokens: translatorHistoryMaxTokens,
    }
  }

  async function prepareInputHookHistoryContext(
    hook: InputHook,
    target: ActiveChatTarget,
  ): Promise<InputHookHistoryContext | undefined | null> {
    if (!canUseClientWriteAccess()) return null
    const clientGeneration = captureClientSessionGeneration()
    const requiredRows = maximumHistorySlotCount(hook.prompt)
    if (requiredRows === 0) return undefined

    let requestedTail = Math.max(loadPages, requiredRows)
    while (true) {
      if (!isClientWriteOperationCurrent(clientGeneration) || !isActiveChatTargetFresh(target)) return null
      const chat = targetChatWithTranscript(target)?.chat
      if (!chat || chat.id !== target.chatId) return null

      const hydrationPending = isChatMessageHydrationPending(chat.id, chat.message.length)
      if (!hydrationPending && inputHookHistoryWindowIsResident(chat.message, requiredRows)) {
        return snapshotInputHookHistoryContext(target)
      }

      const hydrated = await hydrateActiveChatWindow(requestedTail)
      if (!isClientWriteOperationCurrent(clientGeneration) || !isActiveChatTargetFresh(target)) return null
      if (!hydrated) throw new Error(language.chatDataLoadFailed)

      const hydratedChat = targetChatWithTranscript(target)?.chat
      if (!hydratedChat || hydratedChat.id !== target.chatId) return null
      if (inputHookHistoryWindowIsResident(hydratedChat.message, requiredRows)) {
        return snapshotInputHookHistoryContext(target)
      }

      const nextTail = Math.min(hydratedChat.message.length, Math.max(requestedTail + requiredRows, requestedTail * 2))
      if (nextTail <= requestedTail) throw new Error(language.chatDataLoadFailed)
      requestedTail = nextTail
    }
  }

  async function runDraftHookForSend(input: {
    hook: InputHook
    composerOperation: ComposerOperation
    activeTarget: ActiveChatTarget
  }): Promise<void> {
    if (!isClientWriteOperationCurrent(input.composerOperation.clientGeneration)) return
    const hookActivity = beginInputHookActivity({
      target: input.activeTarget,
      stage: CHAT_GENERATION_INPUT_HOOK_STAGE,
      kind: 'draft',
      composerOperation: {
        token: input.composerOperation.token,
        composerVersion: input.composerOperation.composerVersion,
      },
    })
    if (!hookActivity) return
    try {
      const historyContext = await prepareInputHookHistoryContext(input.hook, input.activeTarget)
      if (historyContext === null || !isClientWriteOperationCurrent(input.composerOperation.clientGeneration)) return
      const result = await runInputHook(
        input.hook,
        { content: input.composerOperation.messageInput, draft: input.composerOperation.draftText },
        hookActivity.controller.signal,
        historyContext,
      )
      if (!isActiveChatTargetFresh(input.activeTarget) || !isCurrentComposerOperation(input.composerOperation)) {
        return
      }
      const nextDraft = result.trim()
      if (nextDraft.length === 0) {
        alertError(language.errors.emptyText)
        return
      }
      draftText = nextDraft
      markComposerDraftChanged('draft')
      updateInputSizeAll()
    } catch (error) {
      if (!hookActivity.controller.signal.aborted) {
        alertError(error)
      }
    } finally {
      finishInputHookActivity(hookActivity.id)
    }
  }

  async function selectBtwHook(hook: InputHook | null): Promise<void> {
    showBtwHookDialog = false
    if (hook) await runBtwHook(hook)
  }

  function dismissBtwResult(): void {
    btwText = ''
    markComposerDraftChanged('btw')
  }

  async function runBtwHook(hook: InputHook): Promise<void> {
    if (currentChatOwnsGeneration || currentChatPreparingSend || hookRunActive) return
    const activeTarget = captureActiveChatTarget()
    if (!activeTarget || !isActiveChatTargetFresh(activeTarget)) return
    const composerOperation = beginComposerOperation('btw')
    if (!composerOperation) return
    const preparingTargetKey = claimPreparingSendTarget(activeTarget, 'hook')
    if (!preparingTargetKey) {
      composerOperationGuard.clear(composerOperation.token)
      return
    }

    const hookActivity = beginInputHookActivity({
      target: activeTarget,
      stage: CHAT_GENERATION_INPUT_HOOK_STAGE,
      kind: 'btw',
      composerOperation: {
        token: composerOperation.token,
        composerVersion: composerOperation.composerVersion,
      },
    })
    if (!hookActivity) {
      releasePreparingSendTarget(preparingTargetKey)
      composerOperationGuard.clear(composerOperation.token)
      return
    }
    try {
      const historyContext = await prepareInputHookHistoryContext(hook, activeTarget)
      if (historyContext === null || !isClientWriteOperationCurrent(composerOperation.clientGeneration)) return
      const result = await runInputHook(
        hook,
        { content: composerOperation.messageInput, draft: composerOperation.draftText },
        hookActivity.controller.signal,
        historyContext,
      )
      if (!isActiveChatTargetFresh(activeTarget) || !isCurrentComposerOperation(composerOperation)) return
      const nextBtw = result.trim()
      if (nextBtw.length === 0) {
        alertError(language.errors.emptyText)
        return
      }
      btwText = nextBtw
      markComposerDraftChanged('btw')
    } catch (error) {
      if (!hookActivity.controller.signal.aborted) alertError(error)
    } finally {
      releasePreparingSendTarget(preparingTargetKey)
      composerOperationGuard.clear(composerOperation.token)
      finishInputHookActivity(hookActivity.id)
    }
  }

  async function sendMain(continueResponse: boolean) {
    if (currentChatOwnsGeneration || currentChatPreparingSend) {
      return
    }
    const activeTarget = captureActiveChatTarget()
    if (!activeTarget || !isActiveChatTargetFresh(activeTarget)) {
      return
    }
    const composerOperation = beginComposerOperation(continueResponse ? 'continue' : 'send')
    if (!composerOperation) return
    const preparingTargetKey = claimPreparingSendTarget(activeTarget, 'send')
    if (!preparingTargetKey) {
      composerOperationGuard.clear(composerOperation.token)
      return
    }
    let preparationHandedOff = false
    try {
      const generationSettingsGuard = guardActiveChatGenerationSettingsForSend()
      if (generationSettingsGuard.status === 'error') {
        alertError(generationSettingsGuard.error)
        await sleep(10)
        updateInputSizeAll()
        return
      }

      resetRerollOnCharChange(activeTarget)
      await hydrateActiveChatFully()
      if (
        !isClientWriteOperationCurrent(composerOperation.clientGeneration) ||
        composerOperation.targetIdentity !== getActiveTranscriptWindowIdentity() ||
        !isActiveChatTargetFresh(activeTarget)
      ) {
        return
      }

      const activeOwner = targetChatWithTranscript(activeTarget)
      if (!activeOwner) return
      const currentChatRecord = activeOwner.chat
      const currentChatMetadata = getChatMetadataOwnerSnapshot(activeOwner.character.chaId, currentChatRecord.id ?? '')
      let userMessage: Message | null = null
      let syntheticSayNothing = false
      const composerBeforeSend = composerOperation.messageInput
      const translatedComposerBeforeSend = composerOperation.messageInputTranslate
      const filesBeforeSend = [...composerOperation.fileInput]

      if (composerBeforeSend.startsWith('/')) {
        const commandProcessed = await processMultiCommand(composerBeforeSend)
        if (!isClientWriteOperationCurrent(composerOperation.clientGeneration)) return
        if (commandProcessed !== false) {
          if (clearMessageInputForCurrentOperation(composerOperation)) {
            updateInputSizeAll()
          }
          return
        }
      }

      const selectedHookId = currentChatMetadata?.metadata.selectedDraftHookId
      const liveDraftHook = inputHooks.find((hook) => hook.id === selectedHookId && hook.type === 'draft')
      if (!continueResponse && composerBeforeSend.trim().length > 0 && liveDraftHook) {
        await runDraftHookForSend({
          hook: liveDraftHook,
          composerOperation,
          activeTarget,
        })
        return
      }

      const fileSuffix = appendInlayMarkers(filesBeforeSend)
      let messageForSend = composerBeforeSend + fileSuffix

      if (messageForSend === '') {
        if (!continueResponse) {
          const messages = currentChatRecord.message ?? []
          if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
            if (useSayNothing) {
              syntheticSayNothing = true
              userMessage = {
                role: 'user',
                data: '*says nothing*',
                name: null,
              }
            }
          }
        }
      } else {
        // A typed Continue is consumed as a normal user turn before generation;
        // server prompt assembly owns its input trigger and editinput transforms.
        userMessage = {
          role: 'user',
          data: messageForSend,
          time: Date.now(),
          name: null,
        }
      }

      const preflight = preflightChatSendBeforeMutation({
        database: generationSettingsGuard.state.db,
        currentChar: activeOwner.character,
        currentChat: currentChatRecord,
        continue: continueResponse,
        pendingUserMessage: userMessage,
      })
      if (preflight.type === 'unsupported') {
        alertError(preflight.reason)
        await sleep(10)
        updateInputSizeAll()
        return
      }

      if (userMessage) {
        if (canUseGenerationOperationProtocol()) {
          preparationHandedOff = true
          handoffAcceptedSend({
            target: activeTarget,
            preparingTargetKey,
            message: userMessage,
            composerOperation,
            clearDraftFields: false,
            confirmBoundary: true,
            syntheticSayNothing,
          })
          return
        }
        const appended = await appendCurrentChatUserMessageForSend(userMessage, { expectedTarget: activeTarget })
        if (appended.status === 'error') {
          if (composerComponentDestroyed || !isActiveChatTargetFresh(activeTarget)) return
          restoreComposerForCurrentOperation({
            ...composerOperation,
            messageInput: composerBeforeSend,
            messageInputTranslate: translatedComposerBeforeSend,
            fileInput: filesBeforeSend,
          })
          alertError(appended.error)
          await sleep(10)
          return
        }
        preparationHandedOff = true
        handoffAcceptedSend({
          target: activeTarget,
          preparingTargetKey,
          append: appended,
          composerOperation,
          clearDraftFields: false,
          confirmBoundary: true,
          syntheticSayNothing,
        })
        return
      }
      if (!isActiveChatTargetFresh(activeTarget)) {
        return
      }
      if (!continueResponse) {
        clearComposerForCurrentOperation(composerOperation)
      }
      await sleep(10)
      if (!isActiveChatTargetFresh(activeTarget)) {
        return
      }
      // Clear the reroll buffer only after send/continue succeeds.
      await sendChatMain(continueResponse, undefined, true, composerOperation, activeTarget, syntheticSayNothing)
    } finally {
      composerOperationGuard.clear(composerOperation.token)
      if (!preparationHandedOff) releasePreparingSendTarget(preparingTargetKey)
    }
  }

  async function sendDraft(): Promise<void> {
    if (currentChatOwnsGeneration || currentChatPreparingSend || hookRunActive || draftText.trim().length === 0) return
    const activeTarget = captureActiveChatTarget()
    if (!activeTarget || !isActiveChatTargetFresh(activeTarget)) return
    const composerOperation = beginComposerOperation('draft-send')
    if (!composerOperation) return
    const preparingTargetKey = claimPreparingSendTarget(activeTarget, 'send')
    if (!preparingTargetKey) {
      composerOperationGuard.clear(composerOperation.token)
      return
    }

    let preparationHandedOff = false
    try {
      const generationSettingsGuard = guardActiveChatGenerationSettingsForSend()
      if (generationSettingsGuard.status === 'error') {
        alertError(generationSettingsGuard.error)
        return
      }

      resetRerollOnCharChange(activeTarget)
      await hydrateActiveChatFully()
      if (!isActiveChatTargetFresh(activeTarget) || !isCurrentComposerOperation(composerOperation)) return

      const activeOwner = targetChatWithTranscript(activeTarget)
      const selectedCharacter = activeOwner?.character
      const liveChat = activeOwner?.chat
      if (!selectedCharacter || !liveChat) return
      const messageData = `${composerOperation.draftText}${appendInlayMarkers(composerOperation.fileInput)}`
      const liveMetadata = getChatMetadataOwnerSnapshot(selectedCharacter.chaId, liveChat.id ?? '')
      const liveDraftHook = inputHooks.find(
        (hook) => hook.id === liveMetadata?.metadata.selectedDraftHookId && hook.type === 'draft',
      )
      const translation =
        liveDraftHook?.translation === true
          ? await createDraftHookTranslation({
              hook: liveDraftHook,
              messageData,
              originalText: composerOperation.messageInput,
            })
          : undefined
      if (!isActiveChatTargetFresh(activeTarget) || !isCurrentComposerOperation(composerOperation)) return

      const userMessage: Message = {
        role: 'user',
        data: messageData,
        time: Date.now(),
        name: null,
        ...(translation ? { translation } : {}),
      }
      const preflight = preflightChatSendBeforeMutation({
        database: generationSettingsGuard.state.db,
        currentChar: selectedCharacter,
        currentChat: liveChat,
        continue: false,
        pendingUserMessage: userMessage,
      })
      if (preflight.type === 'unsupported') {
        alertError(preflight.reason)
        return
      }

      if (canUseGenerationOperationProtocol()) {
        preparationHandedOff = true
        handoffAcceptedSend({
          target: activeTarget,
          preparingTargetKey,
          message: userMessage,
          composerOperation,
          clearDraftFields: true,
          confirmBoundary: true,
        })
        return
      }
      const appended = await appendCurrentChatUserMessageForSend(userMessage, { expectedTarget: activeTarget })
      if (appended.status === 'error') {
        if (!isActiveChatTargetFresh(activeTarget) || !isCurrentComposerOperation(composerOperation)) return
        alertError(appended.error)
        return
      }

      preparationHandedOff = true
      handoffAcceptedSend({
        target: activeTarget,
        preparingTargetKey,
        append: appended,
        composerOperation,
        clearDraftFields: true,
        confirmBoundary: true,
      })
    } finally {
      composerOperationGuard.clear(composerOperation.token)
      if (!preparationHandedOff) releasePreparingSendTarget(preparingTargetKey)
    }
  }

  async function runRerollPreflight(action: (target: ActiveChatTarget) => Promise<void>) {
    if (!canUseClientWriteAccess()) return
    const clientGeneration = captureClientSessionGeneration()
    if (currentChatOwnsGeneration || currentChatPreparingSend) return
    const targetIdentity = getActiveTranscriptWindowIdentity()
    const target = captureActiveChatTarget()
    if (!target || !isActiveChatTargetFresh(target)) return
    const preparingTargetKey = claimPreparingSendTarget(target, 'reroll')
    if (!preparingTargetKey) return
    try {
      await hydrateActiveChatFully()
      if (
        currentChatOwnsGeneration ||
        !isClientWriteOperationCurrent(clientGeneration) ||
        !preparingSendTargetKeys.has(preparingTargetKey) ||
        getActiveTranscriptWindowIdentity() !== targetIdentity ||
        !isActiveChatTargetFresh(target)
      ) {
        return
      }
      await action(target)
    } finally {
      releasePreparingSendTarget(preparingTargetKey)
    }
  }

  async function reroll() {
    await runRerollPreflight((target) =>
      rerollNav({
        sendChatMain: (continued, regenerateMessageId) =>
          sendChatMain(continued, regenerateMessageId, false, undefined, target),
        closeMenu: closeChatMenu,
      }),
    )
  }

  async function unReroll() {
    await runRerollPreflight(() => unRerollNav())
  }

  async function newReroll() {
    await runRerollPreflight((target) =>
      newRerollNav({
        sendChatMain: (continued, regenerateMessageId) =>
          sendChatMain(continued, regenerateMessageId, false, undefined, target),
        closeMenu: closeChatMenu,
      }),
    )
  }

  async function selectRerollCandidate(index: number) {
    await runRerollPreflight(() => selectRerollCandidateNav(index))
  }

  async function sendChatMain(
    continued: boolean = false,
    regenerateMessageId?: string,
    confirmBoundary: boolean = false,
    composerOperation?: ComposerOperation,
    expectedTarget?: ActiveChatTarget | null,
    syntheticSayNothing: boolean = false,
  ): Promise<boolean> {
    if (!canUseClientWriteAccess()) return false
    const clientGeneration = composerOperation?.clientGeneration ?? captureClientSessionGeneration()
    if (!isClientWriteOperationCurrent(clientGeneration)) return false
    const generationTarget = expectedTarget === undefined ? captureActiveChatTarget() : expectedTarget
    if (!generationTarget || !isActiveChatTargetFresh(generationTarget)) {
      return false
    }
    const generationOwner = targetChatWithTranscript(generationTarget)
    if (!generationOwner) {
      return false
    }
    let previousLength = generationOwner.chat.message.length
    if (!continued && composerOperation?.kind !== 'draft-send') {
      clearMessageInputForCurrentOperation(composerOperation)
    }
    const abortController = createActiveGenerationAbortController()
    try {
      const ok = await sendChat(-1, {
        signal: abortController.signal,
        continue: continued,
        regenerateMessageId,
        expectedTarget: generationTarget,
        syntheticSayNothing,
      })
      if (!ok || !isClientWriteOperationCurrent(clientGeneration)) return false
      if (
        !applySuccessfulSendChatEffects(
          { sendSucceeded: true, previousLength, confirmBoundary },
          {
            clearRerollBuffer: () => clearRerollBuffer(generationTarget),
            recordGeneratedReroll: (length) => recordGeneratedReroll(length, generationTarget),
            markRerollChar: () => markRerollChar(generationTarget),
          },
        )
      ) {
        return false
      }
      return true
    } catch (error) {
      console.error(error)
      alertError(error)
      return false
    } finally {
      clearActiveGenerationAbortController(abortController)
    }
  }

  function abortChat() {
    if (!canUseClientWriteAccess()) return
    abortActiveGeneration()
  }

  function retryGenerationStop() {
    if (!canUseClientWriteAccess()) return
    if (currentChatGenerationOperationId) void stopGenerationOperation(currentChatGenerationOperationId)
  }

  function refreshGenerationStop() {
    if (currentChatGenerationOperationId) {
      void refreshGenerationOperationCancellation(currentChatGenerationOperationId)
    }
  }

  let { userIconPortrait, currentUsername, userIcon } = $derived.by(() => {
    const personaOwner = getPersonaOwnerStateSnapshot()
    const personaDatabase = {
      personas: personaOwner?.personas ?? [],
      selectedPersonaId: personaOwner?.selectedPersonaId ?? null,
      username: personaOwner?.username ?? 'User',
      userIcon: personaOwner?.userIcon ?? '',
    } as unknown as Database
    const chat = currentChatId
      ? ({
          id: currentChatId,
          ...currentChatMetadata,
          generationSettings: currentChatStructureOwner?.chat.generationSettings,
        } as ChatRecord)
      : undefined
    return resolveUserPersonaPresentation(personaDatabase, chat)
  })

  // Empty textareas can transiently report no scroll height during mobile layout changes.
  const composerMinimumHeight = 44
  let inputHeight = $state(`${composerMinimumHeight}px`)
  let inputEle: HTMLTextAreaElement = $state()
  let inputTranslateHeight = $state(`${composerMinimumHeight}px`)
  let inputTranslateEle: HTMLTextAreaElement = $state()
  let draftInputHeight = $state('72px')
  let draftInputEle: HTMLTextAreaElement = $state()

  function updateInputSizeAll() {
    updateInputSize()
    updateInputTranslateSize()
    updateDraftInputSize()
  }

  function updateDraftInputSize() {
    if (draftInputEle) {
      draftInputEle.style.height = '0'
      draftInputHeight = Math.max(72, draftInputEle.scrollHeight) + 'px'
      draftInputEle.style.height = draftInputHeight
    }
  }

  function updateInputTranslateSize() {
    if (inputTranslateEle) {
      inputTranslateEle.style.height = '0'
      inputTranslateHeight = Math.max(composerMinimumHeight, inputTranslateEle.scrollHeight) + 'px'
      inputTranslateEle.style.height = inputTranslateHeight
    }
  }
  function updateInputSize() {
    if (inputEle) {
      inputEle.style.height = '0'
      inputHeight = Math.max(composerMinimumHeight, inputEle.scrollHeight) + 'px'
      inputEle.style.height = inputHeight
    }
  }

  $effect(() => {
    const hasMessageInput = messageInput.length > 0
    const hasMessageInputTranslate = messageInputTranslate.length > 0
    const hasDraftInput = draftText.length > 0
    const hasInputEle = Boolean(inputEle)
    const hasInputTranslateEle = Boolean(inputTranslateEle)
    const hasDraftInputEle = Boolean(draftInputEle)

    if (
      hasMessageInput ||
      hasMessageInputTranslate ||
      hasDraftInput ||
      hasInputEle ||
      hasInputTranslateEle ||
      hasDraftInputEle
    ) {
      updateInputSizeAll()
    }
  })

  function getComposerTextFieldValue(field: ComposerTextField): string {
    return field === 'message' ? messageInput : messageInputTranslate
  }

  function getComposerTextFieldVersion(field: ComposerTextField): number {
    return field === 'message' ? messageInputMutationVersion : messageInputTranslateMutationVersion
  }

  function isCurrentAutoTranslateOperation(operation: AutoTranslateOperation): boolean {
    return (
      isClientWriteOperationCurrent(operation.clientGeneration) &&
      getActiveTranscriptWindowIdentity() === operation.targetIdentity &&
      getComposerTextFieldValue(operation.sourceField) === operation.sourceText &&
      getComposerTextFieldVersion(operation.targetField) === operation.targetVersion
    )
  }

  function applyAutoTranslateResult(operation: AutoTranslateOperation, translatedMessage: string): boolean {
    if (!translatedMessage || !isCurrentAutoTranslateOperation(operation)) return false

    if (operation.targetField === 'message') {
      messageInput = translatedMessage
      markComposerDraftChanged('message')
    } else {
      messageInputTranslate = translatedMessage
      markComposerDraftChanged('translation')
    }
    return true
  }

  async function translateComposerInputForCurrentFields(reverse: boolean, delayMs = 0) {
    const sourceField: ComposerTextField = reverse ? 'translation' : 'message'
    const targetField: ComposerTextField = reverse ? 'message' : 'translation'
    if (!canUseClientWriteAccess()) return
    const operation: AutoTranslateOperation = {
      clientGeneration: captureClientSessionGeneration(),
      sourceField,
      targetField,
      sourceText: getComposerTextFieldValue(sourceField),
      targetVersion: getComposerTextFieldVersion(targetField),
      targetIdentity: getActiveTranscriptWindowIdentity(),
    }

    if (delayMs > 0) {
      await sleep(delayMs)
      if (!isCurrentAutoTranslateOperation(operation)) return
    }

    if (!isCurrentAutoTranslateOperation(operation)) return
    const translatedMessage = await translate(operation.sourceText, reverse)
    applyAutoTranslateResult(operation, translatedMessage)
  }

  async function updateInputTransateMessage(reverse: boolean) {
    if (!useAutoTranslateInput) {
      return
    }
    if (isExpTranslator()) {
      if (!reverse) {
        if (messageInputTranslate !== '') {
          messageInputTranslate = ''
          markComposerDraftChanged('translation')
        }
        return
      }
      if (messageInputTranslate === '') {
        if (messageInput !== '') {
          messageInput = ''
          markComposerDraftChanged('message')
        }
        return
      }
      await translateComposerInputForCurrentFields(reverse, 1500)
      return
    }
    if (reverse && messageInputTranslate === '') {
      if (messageInput !== '') {
        messageInput = ''
        markComposerDraftChanged('message')
      }
      return
    }
    if (!reverse && messageInput === '') {
      if (messageInputTranslate !== '') {
        messageInputTranslate = ''
        markComposerDraftChanged('translation')
      }
      return
    }
    await translateComposerInputForCurrentFields(reverse)
  }

  async function screenShot() {
    const operation = beginScreenshotOperation()
    if (!operation) return

    let canvases: Array<HTMLCanvasElement | null> = []
    let mergedCanvas: HTMLCanvasElement | null = null
    let waitHandle: AlertWaitHandle | null = null
    try {
      await hydrateActiveChatFully()
      if (!isCurrentScreenshotOperation(operation)) return

      loadPages = Infinity
      await tick()
      if (!isCurrentScreenshotOperation(operation)) return

      const html2canvas = await import('html-to-image')
      if (!isCurrentScreenshotOperation(operation)) return

      const chats = document.querySelectorAll('.default-chat-screen .risu-chat')
      waitHandle = beginAlertWait('Taking screenShot...')

      for (const chat of chats) {
        const cnv = await html2canvas.toCanvas(chat as HTMLElement)
        canvases.push(cnv)
        if (!isCurrentScreenshotOperation(operation)) return

        updateAlertWait(waitHandle, 'Taking screenShot... ' + canvases.length + '/' + chats.length)
      }

      canvases.reverse()

      updateAlertWait(waitHandle, 'Merging images...')

      mergedCanvas = document.createElement('canvas')
      mergedCanvas.width = 0
      mergedCanvas.height = 0
      let mergedCtx = mergedCanvas.getContext('2d')

      let totalHeight = 0
      let maxWidth = 0
      for (let i = 0; i < canvases.length; i++) {
        let canvas = canvases[i]
        if (!canvas) continue
        totalHeight += canvas.height
        maxWidth = Math.max(maxWidth, canvas.width)

        mergedCanvas.width = maxWidth
        mergedCanvas.height = totalHeight
      }

      const themeBackground = getComputedStyle(document.documentElement).getPropertyValue('--risu-theme-bgcolor').trim()
      mergedCtx.fillStyle = themeBackground || '#282a36'
      mergedCtx.fillRect(0, 0, maxWidth, totalHeight)
      let indh = 0
      for (let i = 0; i < canvases.length; i++) {
        let canvas = canvases[i]
        if (!canvas) continue
        indh += canvas.height
        mergedCtx.drawImage(canvas, 0, indh - canvas.height)
        canvas.remove()
        canvases[i] = null
      }

      if (mergedCanvas) {
        if (!isCurrentScreenshotOperation(operation)) return

        await downloadFile(`chat-${v4()}.png`, Buffer.from(mergedCanvas.toDataURL('png').split(',').at(-1), 'base64'))
        if (!isCurrentScreenshotOperation(operation)) return

        mergedCanvas.remove()
        mergedCanvas = null
      }
      alertNormal(language.screenshotSaved)
    } catch (error) {
      if (!isCurrentScreenshotOperation(operation)) return

      console.error(error)
      alertError('Error while taking screenshot')
    } finally {
      for (const canvas of canvases) {
        canvas?.remove()
      }
      mergedCanvas?.remove()
      if (waitHandle) clearAlertWait(waitHandle)
      restoreScreenshotWindow(operation)
    }
  }

  function updateGreetingIndex(fmIndex: number) {
    setCurrentChatGreetingIndex(fmIndex, { selectedChar: $selectedCharID })
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={chatScreenRoot}
  class="w-full h-full relative"
  style={customStyle}
  data-default-chat-fixed-containing-block={customStyle.includes('backdrop-filter') ? 'chat-root' : 'viewport'}
  onclick={() => {
    closeChatMenu()
  }}>
  {#if showNewMessageButton}
    {#if newMessageButtonStyle === 'bottom-center' || !newMessageButtonStyle}
      <button
        class="absolute bottom-16 left-1/2 -translate-x-1/2 bg-blue-500 text-white px-4 py-2 rounded-full shadow-lg z-50 flex items-center gap-2 hover:bg-blue-600 transition-colors"
        onclick={scrollToBottom}>
        <ArrowDown size={16} />
        <span>{language.newMessage}</span>
      </button>
    {/if}

    {#if newMessageButtonStyle === 'bottom-right'}
      <button
        class="absolute bottom-20 right-4 bg-blue-500 text-white px-4 py-2 rounded-full shadow-lg z-50 flex items-center gap-2 hover:bg-blue-600 transition-colors"
        onclick={scrollToBottom}>
        <ArrowDown size={16} />
        <span>{language.newMessage}</span>
      </button>
    {/if}

    {#if newMessageButtonStyle === 'bottom-left'}
      <button
        class="absolute bottom-20 left-4 bg-blue-500 text-white px-4 py-2 rounded-full shadow-lg z-50 flex items-center gap-2 hover:bg-blue-600 transition-colors"
        onclick={scrollToBottom}>
        <ArrowDown size={16} />
        <span>{language.newMessage}</span>
      </button>
    {/if}

    {#if newMessageButtonStyle === 'floating-circle'}
      <button
        type="button"
        aria-label={language.newMessage}
        class="absolute bottom-36 right-4 bg-blue-500 text-white w-12 h-12 rounded-full shadow-lg z-50 flex items-center justify-center hover:bg-blue-600 transition-colors"
        onclick={scrollToBottom}
        title={language.newMessage}>
        <ArrowDown size={20} />
      </button>
    {/if}

    {#if newMessageButtonStyle === 'right-center'}
      <button
        class="absolute top-1/2 right-2 -translate-y-1/2 bg-blue-500 text-white px-2 py-3 rounded-l-lg shadow-lg z-50 flex flex-col items-center gap-1 hover:bg-blue-600 transition-colors"
        onclick={scrollToBottom}>
        <ArrowDown size={14} />
        <span class="text-xs writing-mode-vertical">{language.newMessage}</span>
      </button>
    {/if}

    {#if newMessageButtonStyle === 'top-bar'}
      <button
        class="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-500 text-white px-6 py-1.5 rounded-full shadow-lg z-50 flex items-center gap-2 hover:bg-blue-600 transition-colors text-sm"
        onclick={scrollToBottom}>
        <ArrowDown size={14} />
        <span>{language.newMessage}</span>
      </button>
    {/if}
  {/if}
  {#if showFloatingInputButton && floatingInputEnabled() && !floatingInputOpen}
    <button
      bind:this={floatingInputButton}
      type="button"
      data-testid="floating-chat-input-button"
      aria-label={language.openFloatingChatInput}
      title={language.openFloatingChatInput}
      class="floating-chat-input-button absolute bottom-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-blue-500 text-white shadow-lg transition-colors hover:bg-blue-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
      style={`--chat-content-inline-end: ${chatContentInlineEnd ? chatContentInlineEnd - 8 : 16}px`}
      onclick={() => void openFloatingInput()}>
      <span class="relative flex h-6 w-6 items-center justify-center" aria-hidden="true">
        <PencilLineIcon size={22} />
      </span>
    </button>
  {/if}
  {#if isScrollingToMessage}
    <div
      class="absolute inset-0 z-50 flex items-center justify-center bg-black/50 text-white text-xl font-bold backdrop-blur-sm">
      Loading...
    </div>
  {/if}
  {#if $selectedCharID >= 0 && activeChatMessagesFailed}
    <div
      class="absolute inset-0 z-40 flex items-center justify-center bg-bgcolor px-6"
      role="alert"
      data-testid="chat-hydration-error">
      <div class="flex flex-col items-center gap-3 text-center text-textcolor2">
        <span class="text-sm">{language.chatDataLoadFailed}</span>
        <button
          type="button"
          class="flex items-center gap-2 rounded-md border border-darkborderc px-3 py-2 text-sm text-textcolor transition-colors hover:border-textcolor hover:bg-selected focus:border-textcolor focus:bg-selected"
          onclick={retryActiveChatHydration}>
          <RefreshCcwIcon size={16} />
          <span>{language.retry}</span>
        </button>
      </div>
    </div>
  {/if}
  {#if $selectedCharID < 0}
    {#if $PlaygroundStore === 0}
      <MainMenu />
    {:else}
      <LazyComponent loader={loadPlaygroundMenu} fill label={language.playground.playground} testId="playground-menu" />
    {/if}
  {:else if !activeChatOpen}
    <div class="h-full w-full flex flex-col items-center justify-center text-center px-6" data-risu-chat-empty-state>
      <h2 class="text-2xl font-bold mb-2">{getCharacterDisplayName(selectedCharacterOwner)}</h2>
      <p class="text-textcolor2">{language.selectChatToOpen}</p>
      {#if mostRecentChat}
        <Button className="mt-4 flex flex-col gap-2" onclick={openMostRecentChat}>
          <div class="flex flex-row gap-2 items-center">
            <StepForwardIcon size={18} />
            <span>{language.openMostRecentChat}</span>
          </div>
          <hr class="border-darkborderc w-full" />
          <span class="max-w-full truncate text-sm text-textcolor2">{mostRecentChat.name}</span>
        </Button>
      {/if}
    </div>
  {:else}
    <div
      use:trackChatContentGeometry={chatScreenWidth}
      class="relative flex h-full min-h-0 w-full flex-col-reverse"
      style={`--chat-screen-width: ${chatScreenWidth}px; --chat-content-rendered-width: ${chatContentRenderedWidth === null ? 'min(var(--chat-screen-width), 100%)' : `${chatContentRenderedWidth}px`}; --chat-content-inline-end: ${chatContentInlineEnd ?? 8}px; --chat-content-fixed-inline-end: ${chatContentFixedInlineEnd ?? 16}px`}
      data-default-chat-screen-width>
      {#snippet chatMessageSkeleton(mode: 'display' | 'hydration')}
        <div
          class="chat-screen-content-width flex w-full shrink-0 flex-col gap-5 bg-bgcolor px-4 py-8"
          role="status"
          aria-live="polite"
          aria-busy="true"
          data-chat-loading-cover
          data-chat-message-skeleton
          data-chat-loading-mode={mode}>
          <span class="sr-only">{language.loadingChat}</span>
          <div class="flex w-full justify-start" data-chat-skeleton-row>
            <div class="w-3/4 max-w-xl animate-pulse rounded-2xl rounded-bl-sm bg-darkbg p-4">
              <div class="mb-3 h-3 w-1/4 rounded-full bg-selected"></div>
              <div class="mb-2 h-3 w-full rounded-full bg-selected"></div>
              <div class="h-3 w-2/3 rounded-full bg-selected"></div>
            </div>
          </div>
          <div class="flex w-full justify-end" data-chat-skeleton-row>
            <div class="w-2/3 max-w-lg animate-pulse rounded-2xl rounded-br-sm bg-selected p-4">
              <div class="mb-2 h-3 w-full rounded-full bg-darkbg"></div>
              <div class="h-3 w-1/2 rounded-full bg-darkbg"></div>
            </div>
          </div>
          <div class="flex w-full justify-start" data-chat-skeleton-row>
            <div class="w-4/5 max-w-2xl animate-pulse rounded-2xl rounded-bl-sm bg-darkbg p-4">
              <div class="mb-3 h-3 w-1/5 rounded-full bg-selected"></div>
              <div class="mb-2 h-3 w-5/6 rounded-full bg-selected"></div>
              <div class="h-3 w-3/5 rounded-full bg-selected"></div>
            </div>
          </div>
        </div>
      {/snippet}

      {#snippet composerSurface(docked: boolean)}
        <section
          class="flex w-full shrink-0 flex-col-reverse items-center"
          class:composer-dock={docked}
          class:composer-flow={!docked}
          class:floating-chat-composer={!docked && floatingInputOpen}
          class:overflow-y-auto={docked || floatingInputOpen}
          class:overscroll-contain={docked || floatingInputOpen}
          data-floating-chat-input={!docked && floatingInputOpen ? 'true' : undefined}
          data-default-chat-composer-dock={docked ? '' : undefined}
          data-default-chat-composer-flow={docked ? undefined : ''}>
          {#if composerDraftPersistenceError}
            <div
              class="chat-screen-content-width mb-2 rounded-md border border-draculared p-3 text-sm text-draculared"
              role="alert"
              data-testid="composer-draft-persistence-error">
              {composerDraftPersistenceError}
            </div>
          {/if}
          {#if currentChatStopFailed && currentChatGenerationCancellation}
            <div
              class="chat-screen-content-width mb-2 flex flex-col gap-2 rounded-md border border-draculared p-3 text-sm text-draculared"
              role="alert"
              data-testid="generation-stop-failed"
              data-generation-operation-id={currentChatGenerationCancellation.operationId}>
              <p>{language.generationStop.failed}</p>
              {#if currentChatGenerationCancellation.error}
                <p class="break-words text-textcolor2">{currentChatGenerationCancellation.error}</p>
              {/if}
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="rounded-md border border-draculared px-3 py-1.5 transition-colors hover:bg-draculared hover:text-white"
                  data-testid="generation-stop-retry"
                  onclick={retryGenerationStop}>
                  {language.generationStop.retry}
                </button>
                <button
                  type="button"
                  class="rounded-md border border-darkborderc px-3 py-1.5 text-textcolor transition-colors hover:border-textcolor hover:bg-selected"
                  data-testid="generation-stop-refresh"
                  onclick={refreshGenerationStop}>
                  {language.generationReattachFailure.refresh}
                </button>
              </div>
            </div>
          {:else if currentChatStoppedFinalizing}
            <div
              class="chat-screen-content-width mb-2 rounded-md border border-yellow-500 bg-yellow-500/10 p-3 text-sm text-textcolor"
              role="status"
              data-testid="generation-stop-saving-partial">
              {language.generationStop.savingStoppedPartial}
            </div>
          {:else if currentChatGenerationCancellation?.disposition === 'completion_finalizing'}
            <div
              class="chat-screen-content-width mb-2 rounded-md border border-yellow-500 bg-yellow-500/10 p-3 text-sm text-textcolor"
              role="status"
              data-testid="generation-stop-completion-saving">
              {language.generationPersistenceQueued}
            </div>
          {/if}
          {#if currentChatDeadGeneration}
            <div
              class="chat-screen-content-width mb-2 flex flex-col gap-2 rounded-md border border-yellow-500 bg-yellow-500/10 p-3 text-sm text-textcolor"
              role="alert"
              data-testid="generation-reattach-failure"
              data-generation-job-id={currentChatDeadGeneration.jobId}>
              <div class="flex items-start gap-2">
                <TriangleAlertIcon class="mt-0.5 shrink-0 text-yellow-500" size={18} aria-hidden="true" />
                <div class="min-w-0">
                  <p>{language.generationReattachFailure.message}</p>
                  {#if currentChatDeadGeneration.lastError}
                    <p class="mt-1 break-words text-textcolor2" data-testid="generation-reattach-last-error">
                      {language.generationReattachFailure.lastError(currentChatDeadGeneration.lastError)}
                    </p>
                  {/if}
                </div>
              </div>
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="rounded-md border border-yellow-500 px-3 py-1.5 transition-colors hover:bg-yellow-500 hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={reattachRecoveryAction !== null}
                  aria-busy={reattachRecoveryAction?.jobId === currentChatDeadGeneration.jobId &&
                    reattachRecoveryAction.action === 'retry'}
                  data-testid="generation-reattach-retry"
                  onclick={() => void runReattachRecoveryAction(currentChatDeadGeneration!.jobId, 'retry')}>
                  {language.generationReattachFailure.retry}
                </button>
                <button
                  type="button"
                  class="rounded-md border border-yellow-500 px-3 py-1.5 transition-colors hover:bg-yellow-500 hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={reattachRecoveryAction !== null}
                  aria-busy={reattachRecoveryAction?.jobId === currentChatDeadGeneration.jobId &&
                    reattachRecoveryAction.action === 'refresh'}
                  data-testid="generation-reattach-refresh"
                  onclick={() => void runReattachRecoveryAction(currentChatDeadGeneration!.jobId, 'refresh')}>
                  {language.generationReattachFailure.refresh}
                </button>
                <button
                  type="button"
                  class="rounded-md border border-draculared px-3 py-1.5 text-draculared transition-colors hover:bg-draculared hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={reattachRecoveryAction !== null}
                  aria-busy={reattachRecoveryAction?.jobId === currentChatDeadGeneration.jobId &&
                    reattachRecoveryAction.action === 'stop'}
                  data-testid="generation-reattach-stop"
                  onclick={() => void runReattachRecoveryAction(currentChatDeadGeneration!.jobId, 'stop')}>
                  {language.generationReattachFailure.stop}
                </button>
              </div>
            </div>
          {/if}
          {#each currentAcceptedSendRecoveries as recovery (recovery.id)}
            <div
              class="chat-screen-content-width mb-2 flex items-center gap-3 rounded-md border border-draculared p-3 text-sm text-draculared"
              role="alert"
              data-testid="accepted-send-recovery"
              data-generation-operation-id={recovery.operationId}>
              <div>
                <p>
                  {recovery.operationState === 'abandoned'
                    ? language.acceptedSendRecovery.abandoned
                    : recovery.cause === 'generation_in_progress'
                      ? language.acceptedSendRecovery.generationInProgress
                      : language.acceptedSendRecovery.generationFailed}
                </p>
                {#if recovery.providerMayHaveRun}
                  <p class="mt-1 text-textcolor2">{language.acceptedSendRecovery.providerMayHaveRun}</p>
                {/if}
              </div>
              <button
                type="button"
                class="ml-auto shrink-0 rounded-md border border-draculared px-3 py-1.5 text-sm transition-colors hover:bg-draculared hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={recovery.retrying}
                aria-busy={recovery.retrying}
                data-testid="accepted-send-retry"
                onclick={() => void retryAcceptedChatSend(recovery.id)}>
                {recovery.retrying ? language.acceptedSendRecovery.retrying : language.acceptedSendRecovery.retry}
              </button>
            </div>
          {/each}
          <div
            bind:this={composerRow}
            class="chat-composer-row chat-screen-content-width mt-2 mb-2 flex w-full items-stretch"
            style:z-index={floatingInputOpen ? 29 : undefined}
            data-default-chat-composer-row>
            {#if useChatSticker}
              <button
                type="button"
                aria-label={language.stickers}
                aria-pressed={toggleStickers}
                onclick={() => {
                  toggleStickers = !toggleStickers
                }}
                class={'ml-4 bg-textcolor2 flex justify-center items-center  w-12 h-12 rounded-md hover:bg-blue-500 transition-colors ' +
                  (toggleStickers ? 'text-green-500' : 'text-textcolor')}>
                <Laugh />
              </button>
            {/if}

            <textarea
              data-testid="default-chat-composer"
              aria-label={language.messageInput}
              class="peer text-input-area focus:border-textcolor transition-colors outline-hidden text-textcolor p-2 min-w-0 border border-r-0 bg-transparent rounded-md rounded-r-none input-text text-xl grow border-darkborderc resize-none overflow-y-hidden overflow-x-hidden max-w-full placeholder:text-sm"
              class:ml-4={useChatSticker}
              value={floatingComposerValue}
              readonly={floatingDraftPreviewVisible}
              bind:this={inputEle}
              onfocus={() => {
                if (!docked) chatsInstance?.prepareForInFlowComposerFocus()
              }}
              onkeydown={(e) => {
                if (!floatingDraftPreviewVisible && shouldSendFromComposerKeydown(e)) {
                  send()
                  e.preventDefault()
                }
                if (!floatingDraftPreviewVisible && e.key.toLocaleLowerCase() === 'm' && e.ctrlKey) {
                  reroll()
                  e.preventDefault()
                }
              }}
              onpaste={(e) => {
                if (floatingDraftPreviewVisible) {
                  e.preventDefault()
                  return
                }
                void handleComposerPaste(e)
              }}
              oninput={(e) => {
                if (floatingDraftPreviewVisible) {
                  e.currentTarget.value = draftText
                  return
                }
                messageInput = e.currentTarget.value
                markComposerDraftChanged('message')
                updateInputSizeAll()
                updateInputTransateMessage(false)
              }}
              style:height={inputHeight}></textarea>

            {#if currentChatDeadGeneration}
              <button
                type="button"
                data-testid="default-chat-cancel-button"
                aria-label={language.generationReattachFailure.stop}
                class="chat-composer-attached-control peer-focus:border-textcolor flex justify-center border-y border-yellow-500 items-center p-3 text-yellow-500 hover:bg-yellow-500 hover:text-black transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                disabled={reattachRecoveryAction !== null}
                onclick={() => void runReattachRecoveryAction(currentChatDeadGeneration!.jobId, 'stop')}
                style:height={inputHeight}>
                <TriangleAlertIcon aria-hidden="true" />
              </button>
            {:else}
              <button
                type="button"
                data-testid={composerPrimaryControlConverting
                  ? 'default-chat-convert-button'
                  : composerPrimaryControlCancelling
                    ? 'default-chat-cancel-button'
                    : composerPrimaryControlPreparing
                      ? 'default-chat-preparing-button'
                      : 'default-chat-send-button'}
                aria-label={composerPrimaryControlLabel}
                aria-busy={composerPrimaryControlMode === 'preparing'
                  ? 'true'
                  : composerPrimaryControlMode === 'cancel' && currentChatStopPending
                    ? 'true'
                    : undefined}
                aria-disabled={composerPrimaryControlMode === 'preparing' ? 'true' : undefined}
                aria-pressed={composerPrimaryControlMode === 'convert' ? floatingDraftShowsOriginal : undefined}
                title={composerPrimaryControlMode === 'convert' ? language.inputHookConvert : undefined}
                disabled={composerPrimaryControlMode === 'cancel' &&
                  (currentChatStopPending || currentChatStoppedFinalizing)}
                class="chat-composer-primary-control chat-composer-attached-control peer-focus:border-textcolor flex justify-center gap-2 border-y border-darkborderc items-center text-textcolor p-3 transition-colors disabled:cursor-not-allowed disabled:opacity-70"
                class:w-12={!composerPrimaryControlExpanded}
                class:shrink-0={!composerPrimaryControlExpanded}
                class:cursor-wait={composerPrimaryControlMode === 'preparing'}
                class:hover:bg-blue-500={composerPrimaryControlMode !== 'preparing'}
                class:hover:text-white={composerPrimaryControlMode !== 'preparing'}
                class:button-icon-send={composerPrimaryControlMode === 'send'}
                onclick={handleComposerPrimaryControl}
                style:height={inputHeight}>
                {#if composerPrimaryControlMode === 'preparing'}
                  <LoaderCircleIcon size={24} class="risu-ongoing-pulse animate-spin opacity-70" aria-hidden="true" />
                {:else if composerPrimaryControlMode === 'cancel'}
                  {#if currentChatStopFailed}
                    <TriangleAlertIcon size={18} aria-hidden="true" />
                  {:else}
                    <div
                      class="risu-ongoing-pulse loadmove chat-process-stage-{visibleChatProcessStage} chat-process-phase-{visibleChatProcessPhase}">
                    </div>
                  {/if}
                  {#if currentChatStopPending}
                    <span class="whitespace-nowrap text-sm">{language.generationStop.stopping}</span>
                  {:else if currentChatStopFailed}
                    <span class="whitespace-nowrap text-sm">{language.generationStop.retry}</span>
                  {/if}
                {:else if composerPrimaryControlMode === 'convert'}
                  <RefreshCcwIcon />
                {:else}
                  <Send />
                {/if}
              </button>
            {/if}
            {#if currentCharacter?.chaId !== '§playground'}
              <button
                bind:this={chatMenuButton}
                type="button"
                data-testid="default-chat-menu-button"
                aria-label={language.menu}
                aria-expanded={openMenu}
                aria-haspopup="menu"
                aria-controls="default-chat-overflow-menu"
                onclick={toggleChatMenu}
                class="chat-composer-attached-control peer-focus:border-textcolor flex border-y border-r border-darkborderc justify-center items-center text-textcolor p-3 rounded-r-md hover:bg-blue-500 hover:text-white transition-colors"
                style:height={inputHeight}>
                <MenuIcon />
              </button>
            {:else}
              <button
                type="button"
                aria-label={language.addEmptyMessage}
                onclick={() => appendCurrentChatEmptyCharMessage()}
                class="chat-composer-attached-control peer-focus:border-textcolor flex border-y border-r border-darkborderc justify-center items-center text-textcolor p-3 rounded-r-md hover:bg-blue-500 hover:text-white transition-colors"
                style:height={inputHeight}>
                <Plus />
              </button>
            {/if}
          </div>

          {#if showDraftArea && currentCharacter?.chaId !== '§playground'}
            <div
              class="chat-screen-content-width flex flex-col gap-2 rounded-md border border-darkborderc bg-darkbg/50 px-2 py-1.5 text-textcolor"
              data-testid="default-chat-draft-area"
              data-risu-draft-hook-pending={doingDraftHook}
              data-risu-btw-hook-pending={doingBtwHook}>
              {#if btwText.length > 0}
                <div class="flex flex-col gap-1 rounded-md border border-darkborderc bg-darkbg/50 px-2 py-1.5">
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-medium text-textcolor2">{language.inputHookBtwResult}</span>
                    <button
                      type="button"
                      data-testid="default-chat-btw-dismiss"
                      class="ml-auto text-textcolor2 transition-colors hover:text-draculared"
                      aria-label={language.inputHookBtwDismiss}
                      title={language.inputHookBtwDismiss}
                      onclick={dismissBtwResult}>
                      <XIcon size={16} />
                    </button>
                  </div>
                  <div class="whitespace-pre-wrap break-words text-sm" data-testid="default-chat-btw-result">
                    {btwText}
                  </div>
                </div>
              {/if}

              <label for="default-chat-draft-input" class="text-xs font-medium text-textcolor2">
                {language.inputHookDraftLabel}
              </label>
              <textarea
                id="default-chat-draft-input"
                data-testid="default-chat-draft-input"
                class="w-full min-w-0 resize-none overflow-y-hidden rounded-md border border-darkborderc bg-transparent p-2 text-base text-textcolor outline-hidden transition-colors placeholder:text-sm focus:border-textcolor"
                bind:value={draftText}
                bind:this={draftInputEle}
                oninput={() => {
                  markComposerDraftChanged('draft')
                  updateDraftInputSize()
                }}
                placeholder={language.inputHookDraftPlaceholder}
                style:height={draftInputHeight}></textarea>

              <div class="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="default-chat-btw-button"
                  aria-busy={doingBtwHook}
                  disabled={currentChatOwnsGeneration || currentChatPreparingSend || hookRunActive}
                  class="rounded-md border border-darkborderc px-3 py-2 text-sm transition-colors hover:border-textcolor hover:bg-selected disabled:cursor-not-allowed disabled:opacity-50"
                  onclick={() => (showBtwHookDialog = true)}>
                  {#if doingBtwHook}<LoaderCircleIcon size={16} class="risu-ongoing-pulse inline animate-spin" />{/if}
                  {language.inputHookBtw}
                </button>
                <button
                  type="button"
                  data-testid="default-chat-draft-send"
                  disabled={draftText.trim().length === 0 ||
                    currentChatOwnsGeneration ||
                    currentChatPreparingSend ||
                    hookRunActive}
                  class="ml-auto flex items-center gap-2 rounded-md border border-darkborderc px-3 py-2 text-sm transition-colors hover:border-textcolor hover:bg-blue-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  onclick={sendDraft}>
                  <Send size={18} />
                  <span>{language.inputHookSendDraft}</span>
                </button>
              </div>
            </div>
          {/if}
          {#if useAutoTranslateInput && currentCharacter?.chaId !== '§playground'}
            <div class="chat-screen-content-width flex items-center mt-2 mb-2">
              <label for="messageInputTranslate" class="text-textcolor ml-4">
                <LanguagesIcon />
              </label>
              <textarea
                aria-label={language.messageInput}
                id="messageInputTranslate"
                class="text-textcolor rounded-md p-2 min-w-0 bg-transparent input-text text-xl grow ml-4 mr-2 border-darkbutton resize-none focus:bg-selected overflow-y-hidden overflow-x-hidden max-w-full"
                bind:value={messageInputTranslate}
                bind:this={inputTranslateEle}
                onkeydown={(e) => {
                  if (shouldSendFromComposerKeydown(e)) {
                    send()
                    e.preventDefault()
                  }
                  if (e.key.toLocaleLowerCase() === 'm' && e.ctrlKey) {
                    reroll()
                    e.preventDefault()
                  }
                }}
                oninput={() => {
                  markComposerDraftChanged('translation')
                  updateInputSizeAll()
                  updateInputTransateMessage(true)
                }}
                placeholder={language.enterMessageForTranslateToEnglish}
                style:height={inputTranslateHeight}></textarea>
            </div>
          {/if}

          {#if fileInput.length > 0}
            <div
              class="chat-screen-content-width flex items-center ml-4 flex-wrap p-2 m-2 border-darkborderc border rounded-md">
              {#each fileInput as file, i}
                {#await getInlayAsset(file) then inlayAsset}
                  <div class="relative">
                    {#if !inlayAsset}
                      <div
                        class="w-48 h-24 border border-darkborderc rounded-md flex items-center justify-center text-textcolor2">
                        Missing file
                      </div>
                    {:else if inlayAsset.type === 'image'}
                      <img src={inlayAsset.data} alt="Inlay" class="max-w-48 max-h-48 border border-darkborderc" />
                    {:else if inlayAsset.type === 'video'}
                      <video controls class="max-w-48 max-h-48 border border-darkborderc">
                        <source src={inlayAsset.data} type="video/mp4" />
                        <track kind="captions" />
                        Your browser does not support the video tag.
                      </video>
                    {:else if inlayAsset.type === 'audio'}
                      <audio controls class="max-w-48 max-h-24 border border-darkborderc">
                        <source src={inlayAsset.data} type="audio/mpeg" />
                        Your browser does not support the audio tag.
                      </audio>
                    {:else}
                      <div class="max-w-24 max-h-24">{file}</div>
                    {/if}
                    <button
                      type="button"
                      aria-label={`${language.remove}: ${file}`}
                      class="absolute -right-1 -top-1 p-1 bg-darkbg text-textcolor rounded-md transition-colors hover:text-draculared focus:text-draculared"
                      onclick={() => {
                        fileInput.splice(i, 1)
                        markComposerDraftChanged('files')
                        updateInputSizeAll()
                      }}>
                      <XIcon size={18} />
                    </button>
                  </div>
                {/await}
              {/each}
            </div>
          {/if}

          {#if toggleStickers}
            <div class="chat-screen-content-width ml-4 flex flex-wrap">
              <AssetInput
                {currentCharacter}
                onSelect={(additionalAsset) => {
                  let fileType = 'img'
                  if (additionalAsset.length > 2 && additionalAsset[2]) {
                    const fileExtension = additionalAsset[2]
                    if (fileExtension === 'mp4' || fileExtension === 'webm') fileType = 'video'
                    else if (fileExtension === 'mp3' || fileExtension === 'wav') fileType = 'audio'
                  }
                  messageInput += `<span class='notranslate' translate='no'>{{${fileType}::${additionalAsset[0]}}}</span> *${additionalAsset[0]} added*`
                  markComposerDraftChanged('message')
                  updateInputSizeAll()
                }} />
            </div>
          {/if}

          {#if useAutoSuggestions}
            <Suggestion
              messageInput={(msg) => {
                messageInput = cleanAutoSuggestionInput(msg, autoSuggestionCleanupDatabase)
                markComposerDraftChanged('message')
              }}
              {send}
              isGenerationActive={currentChatOwnsGeneration} />
          {/if}
        </section>
      {/snippet}

      {#if fixedChatTextarea}
        {@render composerSurface(true)}
      {/if}

      <div
        bind:this={chatScrollContainer}
        class="default-chat-screen relative flex min-h-0 w-full flex-1 flex-col-reverse overflow-y-auto"
        class:fastify-chat-theme={chatTheme === 'fastify'}
        data-default-chat-transcript
        data-chat-initial-display-pending={activeChatDisplayLoading || activeChatDisplayDependenciesPending
          ? ''
          : undefined}
        onwheel={() => chatsInstance?.handleTranscriptUserInteraction()}
        ontouchstart={() => chatsInstance?.handleTranscriptUserInteraction()}
        onpointerdown={(event) => {
          if (event.target === event.currentTarget) chatsInstance?.handleTranscriptUserInteraction()
        }}
        onkeydown={(event) => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
            chatsInstance?.handleTranscriptUserInteraction()
          }
        }}
        onscroll={(e) => {
          chatsInstance?.handleTranscriptScroll()
          //@ts-expect-error scrollHeight/clientHeight/scrollTop don't exist on EventTarget, but target is HTMLElement here
          const scrolled = e.target.scrollHeight - e.target.clientHeight + e.target.scrollTop
          if (scrolled < 100 && currentChat.length > loadPages) {
            void expandTranscriptWindow(loadPages + getAdditionalChatLoadPages(chatLoadPageSettings()))
          }
          const chatTarget = e.target as HTMLElement
          const chatsContainer = chatTarget.querySelector<HTMLElement>('[data-default-chat-chats-container]')
          const lastEl = chatsContainer?.firstElementChild
          const isAtBottom = lastEl
            ? lastEl.getBoundingClientRect().top <= chatTarget.getBoundingClientRect().bottom + 100
            : true
          if (isAtBottom) {
            showNewMessageButton = false
          }
          updateFloatingInputForScroll(chatTarget)
        }}>
        {#if !fixedChatTextarea}
          {@render composerSurface(false)}
          {#if floatingInputOpen}
            <div aria-hidden="true" class="shrink-0" style:height={`${floatingInputFlowHeight}px`}></div>
          {/if}
        {/if}

        {#if $pluginRuntimeStateStore.phase === 'ready' && chatPanelStore.length > 0}
          <div class="chat-screen-content-width my-2 flex flex-col gap-2">
            {#each chatPanelStore as panel (`${panel.pluginName}:${panel.id}`)}
              <section
                class={`rounded-md border border-darkborderc bg-darkbg/80 p-3 text-textcolor ${panel.className ?? ''}`}
                data-plugin-chat-panel={panel.id}>
                {@html panel.html}
              </section>
            {/each}
          </div>
        {/if}

        {#if activeChatDisplayLoading && !activeChatMessagesLoading && !activeChatDisplayDependenciesPending}
          {@render chatMessageSkeleton('display')}
        {/if}
        {#if activeChatMessagesLoading}
          {@render chatMessageSkeleton('hydration')}
        {:else if activeChatDisplayDependenciesPending}
          {#if displayDependencyStatus === 'error'}
            <div
              class="chat-screen-content-width flex flex-col items-center gap-3 p-6 text-textcolor2"
              role="alert"
              data-testid="chat-display-dependency-error">
              <span>{language.chatDataLoadFailed}</span>
              <button
                type="button"
                class="rounded-md border border-darkborderc px-3 py-2 text-textcolor"
                disabled={retryingDisplayDependencies}
                onclick={retryChatDisplayDependencies}>{language.retry}</button>
            </div>
          {:else}
            {@render chatMessageSkeleton('display')}
          {/if}
        {:else if currentChat[0]?.data?.startsWith(coldStorageHeader)}
          {#await preLoadChat($selectedCharID, currentCharacter?.chatPage ?? 0)}
            <div class="chat-screen-content-width w-full flex justify-center text-textcolor2 italic mb-12">
              {language.loadingChatData}
            </div>
          {:then recovered}
            {#if !recovered}
              <div class="chat-screen-content-width w-full flex justify-center text-red-400 italic mb-12" role="alert">
                {language.errors.coldStorageRecoveryFailed}
                ({currentChat[0]?.data?.slice(coldStorageHeader.length)})
              </div>
            {/if}
          {/await}
        {:else}
          {#if chatFoldedStateMessageIndex.index !== -1}
            <div class="chat-screen-content-width w-full flex justify-center max-w-full p-4">
              <Button
                className="max-w-xl w-full"
                onclick={async () => {
                  const foldedTarget = chatFoldedState.data
                  const foldedMessageIndex = chatFoldedStateMessageIndex.index
                  if (!foldedTarget || foldedMessageIndex < 0) return
                  const nextLoadPages = getLoadPagesForMessageJump(loadPages, renderChat.length, foldedMessageIndex)
                  const expanded = await expandTranscriptWindow(nextLoadPages, false)
                  const liveFoldedTarget = chatFoldedState.data
                  if (
                    !expanded ||
                    chatFoldedStateMessageIndex.index !== foldedMessageIndex ||
                    !liveFoldedTarget ||
                    liveFoldedTarget.targetCharacterId !== foldedTarget.targetCharacterId ||
                    liveFoldedTarget.targetChatId !== foldedTarget.targetChatId ||
                    liveFoldedTarget.targetMessageId !== foldedTarget.targetMessageId
                  ) {
                    return
                  }
                  const identity = getActiveTranscriptWindowIdentity()
                  const anchor = chatScrollContainer
                    ?.querySelector<HTMLElement>(`[data-chat-index="${foldedMessageIndex}"]`)
                    ?.closest<HTMLElement>('[data-transcript-row-id]')
                  const top =
                    anchor && chatScrollContainer
                      ? anchor.getBoundingClientRect().top - chatScrollContainer.getBoundingClientRect().top
                      : 0
                  const releaseBefore = await chatsInstance?.prepareMessageJump(foldedMessageIndex, currentChatId)
                  if (!releaseBefore) return
                  let releaseAfter: ((preservedTop?: number) => void) | null | undefined
                  try {
                    if (
                      !activeChatOpen ||
                      getActiveTranscriptWindowIdentity() !== identity ||
                      chatFoldedState.data !== liveFoldedTarget
                    )
                      return
                    chatFoldedState.data = null
                    chatFoldedStateMessageIndex.index = -1
                    loadPages = Math.max(loadPages, nextLoadPages)
                    await tick()
                    if (!activeChatOpen || getActiveTranscriptWindowIdentity() !== identity) return
                    // Unfolding moves this stable row within the logical array.
                    // Keep it mounted and preserve its offset while selecting
                    // the new working window around that same message.
                    releaseAfter = await chatsInstance?.prepareMessageJump(foldedMessageIndex, currentChatId)
                    if (anchor?.isConnected && chatScrollContainer && releaseAfter) {
                      chatScrollContainer.scrollTop +=
                        anchor.getBoundingClientRect().top - chatScrollContainer.getBoundingClientRect().top - top
                    }
                  } finally {
                    releaseAfter?.(anchor ? top : undefined)
                    releaseBefore()
                  }
                }}>
                {language.loadMore}
              </Button>
            </div>
          {/if}

          <div class="chat-screen-content-width" data-default-chat-agent-progress-column>
            <AgentPresetProgress />
          </div>
          <div class="chat-screen-content-width" data-default-chat-post-generation-progress-column>
            <PostGenerationScriptProgress characterId={currentCharacter.chaId} chatId={currentChatId} />
          </div>

          <div class="contents" data-default-chat-chats-container>
            <Chats
              bind:this={chatsInstance}
              messages={renderChat}
              {loadPages}
              scrollContainer={chatScrollContainer}
              onReroll={reroll}
              {unReroll}
              onNewReroll={newReroll}
              onSelectRerollCandidate={selectRerollCandidate}
              rerollTarget={currentRerollTarget}
              chatId={currentChatId}
              {currentCharacter}
              {currentUsername}
              {userIcon}
              {userIconPortrait}
              isGenerationActive={currentChatOwnsGeneration}
              regenerateTargetMessageId={currentChatRegenerateTargetMessageId}
              generationActivity={currentChatGenerationActivity}
              generationJob={currentChatGenerationJob}
              generationPhase={currentChatGenerationPhase}
              generationStage={currentChatGenerationStage}
              initialRowsPending={activeChatMessagesLoading}
              bind:initialDisplayPending={activeChatDisplayLoading}
              bind:hasNewUnreadMessage={showNewMessageButton} />
          </div>

          <!-- A bootstrap shell strips firstMessage/alternateGreetings (not in
             BOOTSTRAP_CHARACTER_SHELL_FIELDS); skip the greeting render until the
             row hydrates so the unguarded `alternateGreetings.length` reads below
             cannot throw on the correct lazy-shell state. -->
          {#if !isServerCharacterShell(currentCharacter) && renderChat.length <= loadPages}
            <Chat
              character={currentDisplayCharacter}
              displayChatId={currentChatId}
              greetingTarget={greetingTranslationTarget}
              translation={greetingTranslation}
              name={getCharacterDisplayName(currentCharacter)}
              message={currentChatMetadata.fmIndex === -1
                ? currentCharacter.firstMessage
                : currentCharacter.alternateGreetings[currentChatMetadata.fmIndex ?? 0]}
              role="char"
              img={getCharImage(currentCharacter.image, 'css')}
              idx={-1}
              altGreeting={currentCharacter.alternateGreetings.length > 0}
              largePortrait={currentCharacter.largePortrait}
              firstMessage={true}
              onReroll={() => {
                const cha = currentCharacter
                const fmIndex = currentChatMetadata.fmIndex ?? -1
                if (!cha || !currentChatId) return
                if (fmIndex >= cha.alternateGreetings.length - 1) {
                  updateGreetingIndex(-1)
                } else {
                  updateGreetingIndex(fmIndex + 1)
                }
              }}
              unReroll={() => {
                const cha = currentCharacter
                const fmIndex = currentChatMetadata.fmIndex ?? -1
                if (!cha || !currentChatId) return
                if (fmIndex === -1) {
                  updateGreetingIndex(cha.alternateGreetings.length - 1)
                } else {
                  updateGreetingIndex(fmIndex - 1)
                }
              }}
              isLastMemory={false}
              currentPage={(currentChatMetadata.fmIndex ?? -1) + 2}
              totalPages={currentCharacter.alternateGreetings.length + 1} />
            {#if aiLawApplies() && renderChat.length === 0}
              <div
                class="chat-screen-content-width ml-auto mr-auto mt-4 text-textcolor2 italic max-w-2/3 wrap-break-word text-center">
                {language.aiGenerationWarning}
              </div>
            {/if}
            {#if !currentCharacter.removedQuotes && currentCharacter.creatorNotes.length >= 2}
              <CreatorQuote
                quote={currentCharacter.creatorNotes}
                onRemove={() => {
                  const cha = getCharacterByIndex($selectedCharID, { snapshot: true })
                  cha.removedQuotes = true
                  setCharacterByIndex($selectedCharID, cha)
                }} />
            {/if}
          {/if}
        {/if}

        {#if openMenu && !fixedChatTextarea}
          {@render chatOverflowMenu()}
        {/if}
      </div>

      {#snippet chatOverflowMenu()}
        <div
          bind:this={chatMenuElement}
          id="default-chat-overflow-menu"
          data-testid="default-chat-overflow-menu"
          role="menu"
          tabindex="-1"
          aria-label={language.menu}
          class="chat-overflow-menu {floatingInputOpen
            ? 'chat-overflow-menu-fixed fixed'
            : 'absolute bottom-16'} max-h-[calc(100dvh-5rem)] max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain p-5 bg-darkbg flex flex-col gap-3 text-textcolor rounded-md"
          style:bottom={floatingInputOpen
            ? `calc(var(--chat-visual-viewport-fixed-bottom-offset, 0px) + min(${inputHeight}, 40dvh, 18rem) + 2rem)`
            : undefined}
          onkeydown={handleChatMenuKeydown}
          onclick={(e) => {
            e.stopPropagation()
          }}>
          {#if floatingInputOpen}
            <button
              type="button"
              role="menuitem"
              data-default-chat-menu-item
              data-testid="floating-chat-input-go-to-bottom"
              class="flex w-full items-center cursor-pointer text-left hover:text-green-500 transition-colors"
              onclick={() => void goToBottomFromFloatingInput()}>
              <ArrowDown />
              <span class="ml-2">{language.goToBottom}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-default-chat-menu-item
              data-testid="floating-chat-input-hide"
              class="flex w-full items-center cursor-pointer text-left hover:text-green-500 transition-colors"
              onclick={() => void hideFloatingInput()}>
              <EyeOffIcon />
              <span class="ml-2">{language.hideInput}</span>
            </button>
          {/if}
          <!-- svelte-ignore block_empty -->
          {#if currentCharacter?.ttsMode && currentCharacter.ttsMode !== 'none'}
            <button
              type="button"
              role="menuitem"
              data-default-chat-menu-item
              class="flex w-full items-center cursor-pointer text-left hover:text-green-500 transition-colors"
              onclick={() => {
                stopTTS()
              }}>
              <MicOffIcon />
              <span class="ml-2">{language.ttsStop}</span>
            </button>
          {/if}

          <button
            type="button"
            role="menuitem"
            data-default-chat-menu-item
            disabled={!canContinueFromMenu}
            class="flex w-full items-center cursor-pointer text-left hover:text-green-500 transition-colors disabled:cursor-not-allowed disabled:text-textcolor2"
            onclick={sendContinue}>
            <StepForwardIcon />
            <span class="ml-2">{language.continueResponse}</span>
          </button>

          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={currentChatMetadata.pinned === true}
            data-default-chat-menu-item
            data-testid={floatingInputOpen ? 'floating-chat-pin-button' : 'default-chat-pin-button'}
            disabled={pinMutationPending}
            class="flex w-full items-center cursor-pointer text-left hover:text-green-500 transition-colors disabled:cursor-not-allowed disabled:text-textcolor2"
            onclick={() => void toggleCurrentChatPin()}>
            <PinIcon />
            <span class="ml-2">{currentChatMetadata.pinned ? language.unpinChat : language.pinChat}</span>
          </button>

          {#if showMenuChatList}
            <button
              type="button"
              role="menuitem"
              data-testid="default-chat-open-chat-list"
              data-default-chat-menu-item
              class="flex w-full items-center cursor-pointer text-left hover:text-green-500 transition-colors"
              onclick={() => {
                openChatList = true
                closeChatMenu()
              }}>
              <DatabaseIcon />
              <span class="ml-2">{language.chatList}</span>
            </button>
          {/if}

          <button
            type="button"
            role="menuitem"
            data-testid="default-chat-open-bardwiki"
            data-default-chat-menu-item
            disabled={!currentChatId}
            class="flex w-full items-center cursor-pointer text-left hover:text-green-500 transition-colors disabled:cursor-not-allowed disabled:text-textcolor2"
            onclick={() => {
              openBardWiki = true
              closeChatMenu()
            }}>
            <BookOpenIcon />
            <span class="ml-2">{language.bardWiki.workspaceTitle}</span>
          </button>

          {#if enableRisuaiProTools}
            <button
              type="button"
              role="menuitem"
              data-default-chat-menu-item
              class="flex w-full items-center cursor-pointer text-left hover:text-green-500 transition-colors"
              onclick={() => {
                easyPanelStore.open = !easyPanelStore.open
              }}>
              <SparkleIcon />
              <span class="ml-2">{language.easyPanel}</span>
            </button>
          {/if}

          {#if $pluginRuntimeStateStore.phase === 'ready'}
            {#each additionalChatMenu as menu}
              <button
                type="button"
                role="menuitem"
                data-default-chat-menu-item
                class="flex w-full items-center cursor-pointer text-left hover:text-green-500 transition-colors"
                onclick={() => {
                  menu.callback()
                  closeChatMenu()
                }}>
                <PluginDefinedIcon ico={menu} />
                <span class="ml-2">{menu.name}</span>
              </button>
            {/each}
          {/if}

          {#if showMenuHypaMemoryModal && hypaV3}
            <button
              type="button"
              role="menuitem"
              data-default-chat-menu-item
              class="flex w-full items-center cursor-pointer text-left hover:text-green-500 transition-colors"
              onclick={() => {
                $hypaV3ModalOpen = true
                closeChatMenu()
              }}>
              <BrainIcon />
              <span class="ml-2">{language.hypaMemoryV3Modal}</span>
            </button>
          {/if}

          {#if translator !== ''}
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={useAutoTranslateInput}
              data-default-chat-menu-item
              class={'flex w-full items-center cursor-pointer text-left ' +
                (useAutoTranslateInput ? 'text-green-500' : 'lg:hover:text-green-500')}
              onclick={() => {
                applyServerBackedSetting('useAutoTranslateInput', !useAutoTranslateInput)
              }}>
              <GlobeIcon />
              <span class="ml-2">{language.autoTranslateInput}</span>
            </button>
          {/if}

          <button
            type="button"
            role="menuitem"
            data-default-chat-menu-item
            data-testid="default-chat-screenshot-button"
            class="flex w-full items-center cursor-pointer text-left hover:text-green-500 transition-colors"
            onclick={() => {
              screenShot()
            }}>
            <CameraIcon />
            <span class="ml-2">{language.screenshot}</span>
          </button>

          <button
            type="button"
            role="menuitem"
            data-default-chat-menu-item
            class="flex w-full items-center cursor-pointer text-left hover:text-green-500 transition-colors"
            onclick={postFileFromMenu}>
            <ImagePlusIcon />
            <span class="ml-2">{language.postFile}</span>
          </button>

          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={useAutoSuggestions}
            data-default-chat-menu-item
            class={'flex w-full items-center cursor-pointer text-left ' +
              (useAutoSuggestions ? 'text-green-500' : 'lg:hover:text-green-500')}
            onclick={async () => {
              applyServerBackedSetting('useAutoSuggestions', !useAutoSuggestions)
            }}>
            <ReplyIcon />
            <span class="ml-2">{language.autoSuggest}</span>
          </button>

          <button
            type="button"
            role="menuitem"
            data-testid="default-chat-open-modules"
            data-default-chat-menu-item
            class="flex w-full items-center cursor-pointer text-left hover:text-green-500 transition-colors"
            onclick={() => {
              openModuleList = true
              closeChatMenu()
            }}>
            <PackageIcon />
            <span class="ml-2">{language.modules}</span>
          </button>

          {#if sideMenuRerollButton}
            <button
              type="button"
              role="menuitem"
              data-default-chat-menu-item
              class="flex w-full items-center cursor-pointer text-left hover:text-green-500 transition-colors"
              onclick={reroll}>
              <RefreshCcwIcon />
              <span class="ml-2">{language.reroll}</span>
            </button>
          {/if}
        </div>
      {/snippet}

      {#if openMenu && fixedChatTextarea}
        {@render chatOverflowMenu()}
      {/if}
    </div>
  {/if}
</div>

{#if showBtwHookDialog}
  <InputHookPickerDialog kind="btw" hooks={btwHooks} close={() => (showBtwHookDialog = false)} select={selectBtwHook} />
{/if}

{#if $pluginRuntimeStateStore.phase === 'ready' && additionalFloatingActionButtons.length > 0}
  <div class="fixed top-4 right-4 flex flex-col gap-3 z-50">
    {#each additionalFloatingActionButtons as button}
      <button
        type="button"
        aria-label={button.name}
        class="bg-blue-500 text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 hover:bg-blue-600 transition-colors"
        onclick={() => {
          button.callback()
        }}>
        <PluginDefinedIcon ico={button} />
      </button>
    {/each}
  </div>
{/if}

<style>
  [data-default-chat-fixed-containing-block] {
    --chat-visual-viewport-fixed-bottom-offset: 0px;
  }

  /* iOS leaves the layout viewport tall while the app shell is clamped to the
     visual viewport. Window-fixed descendants need the difference as a bottom
     offset; custom backdrop-filter makes this chat root the fixed containing
     block already, so that variant deliberately keeps a zero offset. */
  :global(html[data-risu-visual-viewport-active='true']) [data-default-chat-fixed-containing-block='viewport'] {
    --chat-visual-viewport-fixed-bottom-offset: max(0px, calc(100vh - var(--risu-visual-viewport-height)));
  }

  .composer-dock {
    max-height: min(60%, 32rem);
    padding-bottom: env(safe-area-inset-bottom);
  }

  .floating-chat-input-button {
    right: max(var(--chat-content-inline-end, 1rem), env(safe-area-inset-right));
    bottom: max(1rem, env(safe-area-inset-bottom));
  }

  .floating-chat-composer {
    position: fixed;
    right: max(var(--chat-content-fixed-inline-end, 1rem), env(safe-area-inset-right));
    bottom: calc(var(--chat-visual-viewport-fixed-bottom-offset, 0px) + max(1rem, env(safe-area-inset-bottom)));
    width: min(var(--chat-content-rendered-width, var(--chat-screen-width, 900px)), calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    margin: 0;
    padding: 0.5rem;
    border: 1px solid var(--risu-theme-darkborderc);
    border-radius: 0.75rem;
    background: var(--risu-theme-bgcolor);
    box-shadow: 0 1rem 2.5rem rgb(0 0 0 / 35%);
    z-index: 50 !important;
  }

  .chat-overflow-menu {
    right: max(var(--chat-content-inline-end, 0.5rem), env(safe-area-inset-right));
    z-index: 51;
  }

  .chat-overflow-menu-fixed {
    right: max(var(--chat-content-fixed-inline-end, 1rem), env(safe-area-inset-right));
  }

  :global(html[data-risu-visual-viewport-active='true']) .floating-chat-composer,
  :global(html[data-risu-visual-viewport-active='true']) .chat-overflow-menu-fixed {
    max-height: calc(var(--risu-visual-viewport-height) - 2rem);
  }

  .floating-chat-composer textarea[data-testid='default-chat-composer'] {
    max-height: min(40dvh, 18rem);
    overflow-y: auto;
  }

  .chat-composer-row:focus-within .text-input-area,
  .chat-composer-row:focus-within .chat-composer-attached-control {
    border-color: var(--risu-theme-textcolor);
  }

  .chat-composer-primary-control:focus-visible {
    z-index: 1;
    outline: 2px solid var(--risu-theme-borderc);
    outline-offset: 2px;
  }

  .chat-process-stage-1,
  .chat-process-phase-preparing {
    border-top: 0.4rem solid #60a5fa;
    border-left: 0.4rem solid #60a5fa;
  }

  .chat-process-stage-2,
  .chat-process-phase-checking-memory {
    border-top: 0.4rem solid #db2777;
    border-left: 0.4rem solid #db2777;
  }

  .chat-process-stage-3,
  .chat-process-phase-waiting-for-model,
  .chat-process-phase-generating {
    border-top: 0.4rem solid #34d399;
    border-left: 0.4rem solid #34d399;
  }

  .chat-process-stage-4,
  .chat-process-phase-finalizing {
    border-top: 0.4rem solid #8b5cf6;
    border-left: 0.4rem solid #8b5cf6;
  }

  .chat-process-stage-5,
  .chat-process-phase-input-hook {
    border-top: 0.4rem solid #f59e0b;
    border-left: 0.4rem solid #f59e0b;
  }

  .autoload {
    border-top: 0.4rem solid #10b981;
    border-left: 0.4rem solid #10b981;
  }
</style>
