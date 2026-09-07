<script lang="ts">
  import { onDestroy, setContext, tick, untrack } from 'svelte'
  import { CHAT_DISPLAY_SCHEDULER, createChatDisplayScheduler } from './chatDisplayScheduler'
  import { backgroundReady, startupCoordinatorStore } from 'src/ts/startupReadiness'
  import type { character, Database, Message } from 'src/ts/storage/database.svelte'
  import Chat from './Chat.svelte'
  import { getCharImage } from 'src/ts/characterImage'
  import { ReloadChatPointer, popupStore } from 'src/ts/stores.svelte'
  import { language } from 'src/lang'
  import {
    advanceTranscriptResidents,
    buildTranscriptResidency,
    growTranscriptWorkingRows,
    TranscriptResidencyEntryOwner,
    TranscriptHeightCache,
    transcriptRowAtOffset,
    transcriptRowOffsets,
    TRANSCRIPT_WORKING_ROWS,
    TRANSCRIPT_MAX_RESIDENT_ROWS,
    type TranscriptResidencyEntry,
  } from './transcriptResidency'
  import { TRANSCRIPT_INTERACTION_CONTEXT } from './transcriptInteraction'
  import { createTranscriptReservations } from './transcriptReservations'
  import { TRANSCRIPT_MESSAGE_VIEW_CONTEXT, createTranscriptMessageViewOwner } from './transcriptMessageView'
  import { createSimpleCharacter, createSimpleCharacterMemo } from 'src/ts/simpleCharacter'
  import {
    RegexDisplayReloadPointer,
    RegexDisplayReloadScope,
    regexDisplayReloadTokenForContext,
  } from 'src/ts/process/regexDisplayReload'
  import { chatFoldedStateMessageIndex } from 'src/ts/globalApi.svelte'
  import { get } from 'svelte/store'
  import { getTranscriptWindowRange } from './DefaultChatScreen.loadPages'
  import { getCharacterDisplayName } from 'src/ts/characterDisplayName'
  import { didChatOwnerChange } from './ChatsUnread'
  import { isMemoryLimitMessage } from './memoryLimitMarker'
  import {
    buildGenerationPersistenceStateLookup,
    generationPersistenceStateFromLookup,
    getGenerationFinalizationPersistencesForChat,
    type GenerationPersistenceIndicatorState,
  } from 'src/ts/process/generationPersistenceState'
  import { halfStreamingProgress } from 'src/ts/process/halfStreamingProgress'
  import {
    automaticTranslationMessageIds,
    consumeAutomaticTranslationEligibility,
    replaceAutomaticTranslationMessageIds,
    serverOwnedGeneratedMessageIds,
  } from 'src/ts/process/generatedMessageTranslationEligibility'
  import { newlyAppendedMessageIds } from './newMessageTranslationEligibility'
  import type { ActiveChatTarget } from 'src/ts/chatCommands'
  import { clearVisibleChat, markChatRead, markChatUnread, setVisibleChat } from 'src/ts/process/chatUnread.svelte'
  import { recordChatRowsBuild } from './chatRowsBuildInstrumentation'
  import { createInitialDisplayReadiness, shouldAwaitInitialDisplayParse } from './initialDisplayReadiness'
  import {
    finishGenerationDisplayProjection,
    generationDisplayProjections,
    type GenerationDisplayProjection,
  } from 'src/ts/process/generationDisplayProjection.svelte'
  import { activateDisplaySourceChat, releaseDisplaySourceChat } from 'src/ts/server/displaySources'
  import {
    charactersResourceState,
    getCharacterResourceOwner,
    getChatMetadataOwnerState,
    settingsResourceState,
  } from 'src/ts/server/resourceState.svelte'
  import { projectChatMetadata } from 'src/ts/server/chatMetadataOwner'
  import type { ChatGenerationActivity } from 'src/ts/process/generationActivity.svelte'
  import type { ChatGenerationLoadingPhase } from './chatGenerationLoading'
  import { scrollElementToContainerStart } from './chatScroll'
  import type { ActiveGenerationJob } from 'src/ts/server/bootstrap'
  import { canUseClientWriteAccess, clientSessionStore } from 'src/ts/clientSession'

  const getCurrentChatRoomId = () => chatId ?? null

  let {
    messages,
    chatId,
    currentCharacter,
    onReroll,
    unReroll,
    onNewReroll,
    onSelectRerollCandidate,
    rerollTarget,
    currentUsername,
    userIcon,
    loadPages,
    userIconPortrait,
    scrollContainer = null,
    isGenerationActive = false,
    regenerateTargetMessageId = null,
    generationActivity = undefined,
    generationJob = undefined,
    generationPhase = undefined,
    generationStage = 0,
    hasNewUnreadMessage = $bindable(false),
    initialDisplayPending = $bindable(false),
    initialRowsPending = false,
    readOnly = false,
  }: {
    messages: Message[]
    chatId?: string | null
    currentCharacter: character
    onReroll: () => void
    unReroll: () => void
    onNewReroll: () => void
    onSelectRerollCandidate: (index: number) => void
    rerollTarget: ActiveChatTarget | null
    currentUsername: string
    userIcon: string
    loadPages: number
    userIconPortrait?: boolean
    scrollContainer?: HTMLDivElement | null
    isGenerationActive?: boolean
    regenerateTargetMessageId?: string | null
    generationActivity?: ChatGenerationActivity
    generationJob?: ActiveGenerationJob
    generationPhase?: ChatGenerationLoadingPhase
    generationStage?: number
    hasNewUnreadMessage?: boolean
    initialDisplayPending?: boolean
    initialRowsPending?: boolean
    readOnly?: boolean
  } = $props()
  const writeActionsAllowed = $derived.by(() => {
    void $clientSessionStore
    return !readOnly && canUseClientWriteAccess()
  })

  function legacyChatMetadataFallback(): ReturnType<typeof projectChatMetadata> | undefined {
    if (!chatId) return undefined
    const characterId = currentCharacter.chaId
    if (typeof characterId !== 'string' || characterId.trim().length === 0) return undefined

    const rows = charactersResourceState.characters
    if (rows.length > 0) {
      if (charactersResourceState.rowStatuses[characterId] === 'error') return undefined
      const characterMatches = rows.filter((candidate) => candidate?.chaId === characterId)
      if (characterMatches.length !== 1) return undefined
      const chatMatches = characterMatches[0].chats?.filter((candidate) => candidate?.id === chatId) ?? []
      const globalChatMatches = rows.reduce(
        (count, character) => count + (character.chats ?? []).filter((candidate) => candidate?.id === chatId).length,
        0,
      )
      return chatMatches.length === 1 && globalChatMatches === 1
        ? projectChatMetadata(chatId, chatMatches[0])
        : undefined
    }

    const compatibilityChats = currentCharacter.chats?.filter((candidate) => candidate?.id === chatId) ?? []
    return compatibilityChats.length === 1 ? projectChatMetadata(chatId, compatibilityChats[0]) : undefined
  }

  let currentChatMetadata = $derived.by(() => {
    if (!chatId) return undefined
    if (charactersResourceState.status === 'ready') {
      const characterId = currentCharacter.chaId
      if (typeof characterId !== 'string' || characterId.trim().length === 0) return undefined
      const characterOwner = getCharacterResourceOwner(characterId)
      if (!characterOwner || charactersResourceState.rowStatuses[characterId] === 'error') return undefined
      const chatMatches = characterOwner.chats?.filter((candidate) => candidate?.id === chatId) ?? []
      return chatMatches.length === 1 ? getChatMetadataOwnerState(chatId) : undefined
    }
    if (charactersResourceState.status !== 'idle' && charactersResourceState.status !== 'loading') return undefined
    return legacyChatMetadataFallback()
  })

  function readSettingsGroup(group: 'display' | 'sidebar'): Partial<Database> {
    const status = settingsResourceState.groupStatuses[group] ?? 'idle'
    if (status === 'ready') return settingsResourceState.value as Partial<Database>
    if (status === 'idle' || status === 'loading') return settingsResourceState.value as Partial<Database>
    return {}
  }

  let showMemoryLimit = $derived(readSettingsGroup('display').showMemoryLimit === true)
  let autoScrollToNewMessage = $derived(
    settingsResourceState.groupStatuses.sidebar === 'error'
      ? false
      : readSettingsGroup('sidebar').autoScrollToNewMessage !== false,
  )
  let alwaysScrollToNewMessage = $derived(readSettingsGroup('sidebar').alwaysScrollToNewMessage === true)

  let chatBody: HTMLDivElement
  let latestMessageScrollSpacerHeight = $state(0)
  let latestMessageResizeObserver: ResizeObserver | null = null
  let latestMessageResizeTarget: HTMLElement | null = null
  let scrollContainerResizeObserver: ResizeObserver | null = null
  let scrollContainerResizeTarget: HTMLElement | null = null
  let latestMessageAlignmentReassertQueued = false
  let latestMessageAlignmentVersion = 0
  let latestMessageAlignmentRun = 0
  let isAligningLatestMessage = false
  type TranscriptAnchor = 'start' | 'end' | 'free'
  let transcriptAnchor: TranscriptAnchor = 'free'
  let transcriptAnchorKey: string | null = null
  let pendingGeneratedMessageEndKey: string | null = null
  let chatsComponentDestroyed = false
  const displayScheduler = createChatDisplayScheduler()
  setContext(CHAT_DISPLAY_SCHEDULER, displayScheduler)
  const initialDisplayReadiness = createInitialDisplayReadiness((pending) => {
    initialDisplayPending = pending
    if (pending || chatsComponentDestroyed) return

    const chatRoomId = getCurrentChatRoomId()
    const latestMessageKey = getLatestMessageAlignmentKey()
    // The loading cover uses display:none for the transcript rows. Wait for
    // its removal, then measure and align in this microtask turn; waiting for
    // ResizeObserver's next animation frame exposes the natural end first.
    void tick().then(() => {
      if (
        !chatsComponentDestroyed &&
        !initialDisplayPending &&
        chatRoomId &&
        getCurrentChatRoomId() === chatRoomId &&
        getLatestMessageAlignmentKey() === latestMessageKey &&
        currentTranscriptAnchor() === 'start'
      ) {
        void alignLatestMessageToStart(chatRoomId, latestMessageKey)
      }
    })
  }, tick)
  let activeHalfStreamingProgress = $derived.by(() => {
    const currentChatId = getCurrentChatRoomId()
    return $halfStreamingProgress.find(
      (entry) => entry.characterId === currentCharacter.chaId && entry.chatId === currentChatId,
    )
  })
  let activeRegenerateProjection = $derived.by(() => {
    const currentChatId = getCurrentChatRoomId()
    if (!currentChatId) return undefined
    return $generationDisplayProjections
      .filter((projection) => projection.chatId === currentChatId && projection.mode === 'regenerate')
      .sort(
        (left, right) =>
          left.projectionEpoch - right.projectionEpoch ||
          left.attemptNo - right.attemptNo ||
          left.operationId.localeCompare(right.operationId),
      )
      .at(-1)
  })
  let activeAppendActivity = $derived.by(() => {
    if (
      !isGenerationActive ||
      generationActivity?.kind !== 'message' ||
      generationActivity.mode !== 'send' ||
      generationActivity.chatId !== getCurrentChatRoomId()
    ) {
      return undefined
    }
    return generationActivity
  })
  let activeAppendJob = $derived.by(() => {
    if (
      !isGenerationActive ||
      generationJob?.chatId !== getCurrentChatRoomId() ||
      (generationJob.mode !== undefined && generationJob.mode !== 'send')
    ) {
      return undefined
    }
    return generationJob
  })
  let activeAppendPresentationKey = $derived.by(() => {
    const operationId = activeAppendActivity?.operationId ?? activeAppendJob?.operationId
    const attemptNo = activeAppendActivity?.attemptNo ?? activeAppendJob?.attemptNo
    if (operationId) {
      return `generation-operation:${operationId}${attemptNo === undefined ? '' : `:attempt:${attemptNo}`}`
    }
    if (activeAppendJob?.jobId) return `generation-job:${activeAppendJob.jobId}`
    return activeAppendActivity ? `generation-activity:${activeAppendActivity.id}` : null
  })
  const generationPhaseOrder: Record<ChatGenerationLoadingPhase, number> = {
    starting: 0,
    preparing: 1,
    'checking-memory': 2,
    'waiting-for-model': 3,
    generating: 4,
    finalizing: 5,
    'input-hook': 6,
  }
  interface AppendGenerationPresentationSnapshot {
    startedAt: number
    phase: ChatGenerationLoadingPhase
    stage: number
    generationId?: string
  }
  let appendGenerationPresentationSnapshots: Record<string, AppendGenerationPresentationSnapshot> = $state({})
  $effect(() => {
    const key = activeAppendPresentationKey
    if (!key) return
    const previous = appendGenerationPresentationSnapshots[key]
    const observedPhase = generationPhase ?? 'starting'
    const nextPhase =
      activeAppendActivity && (!previous || generationPhaseOrder[observedPhase] >= generationPhaseOrder[previous.phase])
        ? observedPhase
        : (previous?.phase ?? observedPhase)
    const next: AppendGenerationPresentationSnapshot = {
      startedAt: previous?.startedAt ?? activeAppendActivity?.startedAt ?? Date.now(),
      phase: nextPhase,
      stage: activeAppendActivity
        ? Math.max(previous?.stage ?? 0, generationStage)
        : (previous?.stage ?? generationStage),
      ...(activeAppendActivity?.generationId || previous?.generationId
        ? { generationId: activeAppendActivity?.generationId ?? previous?.generationId }
        : {}),
    }
    if (
      !previous ||
      previous.startedAt !== next.startedAt ||
      previous.phase !== next.phase ||
      previous.stage !== next.stage ||
      previous.generationId !== next.generationId
    ) {
      appendGenerationPresentationSnapshots = { [key]: next }
    }
  })
  let activeAppendPresentation = $derived(
    activeAppendPresentationKey ? appendGenerationPresentationSnapshots[activeAppendPresentationKey] : undefined,
  )
  let activeAppendMessageIndex = $derived.by(() => {
    const generationId = activeAppendActivity?.generationId ?? activeAppendPresentation?.generationId
    if (!generationId) return -1
    return messages.findIndex(
      (message) =>
        message.role === 'char' &&
        (message.chatId === generationId || message.generationInfo?.generationId === generationId),
    )
  })
  let presentationKeyAliases: Record<string, string> = $state({})
  let appendPresentationKeyAliases: Record<string, string> = $state({})
  let regexDisplayReloadToken = $derived(
    regexDisplayReloadTokenForContext($RegexDisplayReloadPointer, $RegexDisplayReloadScope, {
      characterId: currentCharacter?.chaId,
      chatId: chatId ?? undefined,
    }),
  )

  // Row-list changes (including unrelated hydration) must not create a new
  // parser character for every unchanged message.
  const memoizedDisplayCharacter = createSimpleCharacterMemo()
  const displayCharacter = $derived(
    memoizedDisplayCharacter(
      currentCharacter,
      untrack(() => currentCharacter.customscript),
      regexDisplayReloadToken,
    ),
  )

  const chatRows = $derived.by(() => {
    void regexDisplayReloadToken
    void activeRegenerateProjection
    void activeAppendActivity
    void activeAppendJob
    void activeAppendMessageIndex
    const charImage = getCharImage(currentCharacter.image, 'css')
    const userImage = getCharImage(userIcon, 'css')
    const simpleChar = displayCharacter
    const currentChatId = chatId ?? null
    recordChatRowsBuild(currentChatId)
    const generationPersistenceLookup = buildGenerationPersistenceStateLookup(
      getGenerationFinalizationPersistencesForChat(currentChatId),
    )
    const lastMemoryId = currentChatMetadata?.lastMemory
    const { loadStart, loadEnd: configuredLoadEnd } = getTranscriptWindowRange({
      messageCount: messages.length,
      loadPages,
      foldedMessageIndex: readOnly ? -1 : chatFoldedStateMessageIndex.index,
    })
    // Send/streaming can reduce the ordinary page count while an older editor
    // or selection is still owned. Retain its already-hydrated logical range;
    // DOM residency below remains bounded independently of that range.
    void reservationRevision
    const windowPins = new Set([...reservations.ids(), ...singletonPins])
    if (jumpMessageId) windowPins.add(jumpMessageId)
    for (const id of [
      regenerateTargetMessageId,
      activeRegenerateProjection?.targetMessageId,
      activeRegenerateProjection?.generationId,
      activeAppendMessageIndex >= 0 ? messages[activeAppendMessageIndex]?.chatId : undefined,
    ]) {
      if (id) windowPins.add(id)
    }
    let loadEnd = configuredLoadEnd
    if (windowPins.size > 0) {
      for (let index = 0; index < configuredLoadEnd; index++) {
        const id = messages[index]?.chatId
        if (id && windowPins.has(id)) {
          loadEnd = index
          break
        }
      }
    }
    if (pressedLogicalEnd !== null) loadEnd = Math.min(loadEnd, pressedLogicalEnd)

    const reloadPointerMap = get(ReloadChatPointer)
    const rows: {
      key: string
      message: Message
      idx: number
      img: string | Promise<string>
      largePortrait: boolean
      name: string
      character: ReturnType<typeof createSimpleCharacter>
      isLastMemory: boolean
      generationPersistenceState: GenerationPersistenceIndicatorState | null
      scopeId: string | null
      awaitInitialDisplayParse: boolean
      isRegenerationTarget: boolean
      isAppendGenerationPresentation: boolean
      generationPresentationMode?: 'send' | 'regenerate'
      generationDisplayProjection?: GenerationDisplayProjection
    }[] = []

    for (let i = loadStart; i >= loadEnd; i--) {
      if (i < 0) break // Prevent out of bounds
      const message = messages[i]
      const messageLargePortrait =
        message.role === 'user' ? (userIconPortrait ?? false) : ((currentCharacter as character).largePortrait ?? false)
      const reloadPointer = reloadPointerMap[i] ?? 0
      const generationDisplayProjection =
        activeRegenerateProjection &&
        (activeRegenerateProjection.targetMessageId === message.chatId ||
          activeRegenerateProjection.generationId === message.chatId)
          ? activeRegenerateProjection
          : undefined
      const presentationKey =
        (generationDisplayProjection?.targetMessageId
          ? (presentationKeyAliases[generationDisplayProjection.targetMessageId] ??
            generationDisplayProjection.targetMessageId)
          : message.chatId
            ? presentationKeyAliases[message.chatId]
            : undefined) ??
        message.chatId ??
        `message-${i}`
      const isAppendGenerationPresentation = activeAppendMessageIndex === i && activeAppendPresentationKey !== null
      const presentationRowKey =
        (message.chatId ? appendPresentationKeyAliases[message.chatId] : undefined) ??
        (isAppendGenerationPresentation ? activeAppendPresentationKey : `${presentationKey}:${reloadPointer}`)
      rows.push({
        key: `${currentChatId ?? 'unscoped'}:${presentationRowKey}`,
        message,
        idx: i,
        img: message.role === 'user' ? userImage : charImage,
        largePortrait: messageLargePortrait,
        name: message.role === 'user' ? currentUsername : getCharacterDisplayName(currentCharacter),
        character: simpleChar,
        generationPersistenceState: generationPersistenceStateFromLookup(generationPersistenceLookup, message),
        isLastMemory: isMemoryLimitMessage(showMemoryLimit, lastMemoryId, message.chatId),
        scopeId: currentChatId ?? null,
        awaitInitialDisplayParse: shouldAwaitInitialDisplayParse(i, messages.length),
        isRegenerationTarget:
          isGenerationActive && regenerateTargetMessageId !== null && regenerateTargetMessageId === message.chatId,
        isAppendGenerationPresentation,
        ...(isAppendGenerationPresentation ? { generationPresentationMode: 'send' as const } : {}),
        ...(generationDisplayProjection ? { generationPresentationMode: 'regenerate' as const } : {}),
        ...(generationDisplayProjection ? { generationDisplayProjection } : {}),
      })
    }

    if ((activeAppendActivity || activeAppendJob) && activeAppendMessageIndex < 0 && activeAppendPresentationKey) {
      rows.unshift({
        key: `${currentChatId ?? 'unscoped'}:${activeAppendPresentationKey}`,
        message: {
          role: 'char',
          data: '',
          saying: currentCharacter.chaId,
          time: activeAppendPresentation?.startedAt ?? activeAppendActivity?.startedAt ?? Date.now(),
          ...(activeAppendPresentation?.generationId || activeAppendActivity?.generationId
            ? {
                chatId: activeAppendPresentation?.generationId ?? activeAppendActivity?.generationId,
                generationInfo: {
                  generationId: activeAppendPresentation?.generationId ?? activeAppendActivity?.generationId,
                },
              }
            : {}),
        },
        idx: messages.length,
        img: charImage,
        largePortrait: (currentCharacter as character).largePortrait ?? false,
        name: getCharacterDisplayName(currentCharacter),
        character: simpleChar,
        generationPersistenceState: null,
        isLastMemory: false,
        scopeId: currentChatId,
        awaitInitialDisplayParse: false,
        isRegenerationTarget: false,
        isAppendGenerationPresentation: true,
        generationPresentationMode: 'send',
      })
    }

    return rows
  })

  // Hydration owns chatRows. Only this layer decides which of those rows mount.
  const heights = new TranscriptHeightCache()
  const rowElements = new Map<string, HTMLElement>()
  const pendingRowParses = new Map<string, Set<symbol>>()
  const returningRowHeights = new Map<
    string,
    { element: HTMLElement; height: string; overflow: string; ready: boolean }
  >()
  let residencyScope = untrack(() => chatId)
  let heightRevision = $state(0)
  let reservationRevision = $state(0)
  let residentStart = $state(0)
  let workingRowLimit = $state(TRANSCRIPT_WORKING_ROWS)
  let admittedResidents = $state<string[] | null>(null)
  let residencyPending = $state(false)
  let singletonPins = $state<string[]>([])
  let jumpMessageId = $state<string | null>(null)
  let residencyFrame: number | null = null
  let residencyUpdating = false
  let residencyAgain = false
  let measuredWidth = 0
  let residencyScrollTop = 0
  let residencyAnchor: { id: string; top: number } | null = null
  let residencyNavigationEpoch = 0
  let residencyJumpRun = 0
  let pressedLogicalEnd = $state<number | null>(null)
  let pressedPointerId: number | null = null
  let pressReleaseTimer: ReturnType<typeof setTimeout> | null = null
  let pressedRowSizes: Array<{ element: HTMLElement; height: string }> = []
  let pressedResidentEntries = $state.raw<TranscriptResidencyEntry<(typeof chatRows)[number]>[] | null>(null)
  const legacyPaging = (() => {
    try {
      return localStorage.getItem('risu-transcript-legacy-paging') === '1'
    } catch {
      return false
    }
  })()
  const fullResidency = $derived(loadPages === Infinity || legacyPaging)
  const residencyMode = $derived(loadPages === Infinity ? 'capture' : legacyPaging ? 'legacy' : 'bounded')
  const reservations = createTranscriptReservations(() => {
    untrack(() => reservationRevision++)
    scheduleResidency()
  })
  const messageViews = createTranscriptMessageViewOwner()
  setContext(TRANSCRIPT_INTERACTION_CONTEXT, reservations)
  setContext(TRANSCRIPT_MESSAGE_VIEW_CONTEXT, messageViews)
  const residencyIds = $derived(chatRows.map((row) => row.message.chatId ?? row.key))
  const residencyEntries = new TranscriptResidencyEntryOwner<(typeof chatRows)[number]>()
  const rowOffsets = $derived.by(() => {
    void heightRevision
    return legacyPaging ? [] : transcriptRowOffsets(residencyIds, heights)
  })
  const pinnedIds = $derived.by(() => {
    void reservationRevision
    const ids = new Set(reservations.ids())
    // These are singleton owners: latest, jump, generation targets
    // (including transient old/new IDs), focus, popup trigger, and two
    // selection endpoints. Transitional overlap consumes the working budget.
    if (residencyIds[0]) ids.add(residencyIds[0])
    if (jumpMessageId) ids.add(jumpMessageId)
    for (const row of chatRows) {
      if (row.isRegenerationTarget || row.isAppendGenerationPresentation || row.generationDisplayProjection) {
        ids.add(row.message.chatId ?? row.key)
      }
    }
    for (const id of singletonPins) ids.add(id)
    return ids
  })
  const residentEntries = $derived(
    pressedResidentEntries ??
      residencyEntries.reuse(
        buildTranscriptResidency(
          chatRows,
          residencyIds,
          rowOffsets,
          residentStart,
          pinnedIds,
          fullResidency,
          admittedResidents === null || chatRows.length <= TRANSCRIPT_WORKING_ROWS
            ? undefined
            : new Set(
                admittedResidents
                  .filter((id) => !pinnedIds.has(id))
                  .slice(0, Math.max(0, Math.min(workingRowLimit, TRANSCRIPT_MAX_RESIDENT_ROWS - pinnedIds.size))),
              ),
          workingRowLimit,
        ),
        fullResidency,
      ),
  )
  const residentRowCount = $derived(residentEntries.filter((entry) => entry.kind === 'row').length)

  function rowIdForNode(node: Node | null): string | null {
    const element = node instanceof Element ? node : node?.parentElement
    const row = element?.closest<HTMLElement>('[data-transcript-row-id]')
    return row && chatBody?.contains(row) ? (row.dataset.transcriptRowId ?? null) : null
  }

  function collectSingletonPins(): void {
    const selection = document.getSelection()
    const next = [
      rowIdForNode(document.activeElement),
      popupStore.children ? rowIdForNode(popupStore.trigger) : null,
      selection && !selection.isCollapsed ? rowIdForNode(selection.anchorNode) : null,
      selection && !selection.isCollapsed ? rowIdForNode(selection.focusNode) : null,
    ].filter((id): id is string => id !== null)
    if (next.length !== singletonPins.length || next.some((id, index) => id !== singletonPins[index])) {
      singletonPins = next
    }
  }

  function captureResidencyAnchor(): { id: string; top: number } | null {
    if (!scrollContainer) return null
    const viewport = scrollContainer.getBoundingClientRect()
    let anchor: { id: string; top: number } | null = null
    for (const [id, element] of rowElements) {
      const rect = element.getBoundingClientRect()
      if (rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom) {
        const top = rect.top - viewport.top
        // Insertion order changes during progressive admission. Anchor the
        // first visible row, not a lower neighbor that may finish parsing.
        if (!anchor || top < anchor.top) anchor = { id, top }
      }
    }
    return anchor
  }

  function handleResidencyFocusChange(): void {
    collectSingletonPins()
    scheduleResidency()
  }

  function beginResidencyPress(event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0 || !rowIdForNode(event.target as Node | null)) return
    if (pressReleaseTimer !== null) clearTimeout(pressReleaseTimer)
    pressReleaseTimer = null
    // Focus and reservation changes can recompute the resident set without a
    // reconciliation frame. Retain its rows and gaps through the click so an
    // evicted, not-yet-measured neighbor cannot move the pressed control.
    pressedResidentEntries = fullResidency ? null : residentEntries
    pressedPointerId = event.pointerId
    pressedLogicalEnd = chatRows.at(-1)?.idx ?? null
    residencyNavigationEpoch++
    restorePressedRowSizes()
    if (!fullResidency) {
      // A background body can finish parsing between pointerdown and click.
      // Keep every resident wrapper's size until that gesture is delivered,
      // so a neighboring body cannot move the pressed button under the pointer.
      const sizes = [...rowElements.values()].map((element) => ({
        element,
        height: element.style.height,
        measured: element.getBoundingClientRect().height,
      }))
      pressedRowSizes = sizes
      for (const { element, measured } of sizes) element.style.height = `${measured}px`
    }
  }

  function restorePressedRowSizes(): void {
    for (const { element, height } of pressedRowSizes) element.style.height = height
    pressedRowSizes = []
  }

  function endResidencyPress(event: PointerEvent): void {
    if (pressedPointerId !== event.pointerId) return
    if (pressReleaseTimer !== null) clearTimeout(pressReleaseTimer)
    // A focus change during pointerdown can release the previous oldest pin.
    // Keep geometry until the pointerup/click sequence has reached its handler.
    pressReleaseTimer = setTimeout(releaseResidencyPress, 0)
  }

  function releaseResidencyPress(): void {
    if (pressReleaseTimer !== null) clearTimeout(pressReleaseTimer)
    pressReleaseTimer = null
    pressedPointerId = null
    pressedLogicalEnd = null
    pressedResidentEntries = null
    restorePressedRowSizes()
    scheduleResidency()
  }

  function scheduleResidency(): void {
    if (chatsComponentDestroyed || legacyPaging) return
    if (residencyUpdating) {
      residencyAgain = true
      return
    }
    if (residencyFrame !== null || typeof requestAnimationFrame !== 'function') return
    residencyFrame = requestAnimationFrame(() => {
      residencyFrame = null
      void reconcileResidency()
    })
  }

  function beginRowParse(key: string, registration: symbol): void {
    let pending = pendingRowParses.get(key)
    if (!pending) pendingRowParses.set(key, (pending = new Set()))
    pending.add(registration)
    const held = returningRowHeights.get(key)
    if (held) held.ready = false
  }

  function settleRowParse(key: string, registration: symbol): void {
    const pending = pendingRowParses.get(key)
    if (!pending?.delete(registration) || pending.size > 0) return
    pendingRowParses.delete(key)
    const held = returningRowHeights.get(key)
    if (held) held.ready = true
    // The parser's promise commits its HTML before this animation frame. Release
    // the held height in the same pass that measures and corrects the viewport.
    scheduleResidency()
  }

  function restoreReturningRowHeight(key: string): void {
    const held = returningRowHeights.get(key)
    if (!held) return
    held.element.style.height = held.height
    held.element.style.overflow = held.overflow
    returningRowHeights.delete(key)
  }

  async function reconcileResidency(): Promise<void> {
    if (!chatBody || !scrollContainer || chatsComponentDestroyed || pressedLogicalEnd !== null) return
    residencyUpdating = true
    const scope = chatId
    const container = scrollContainer
    const navigationEpoch = residencyNavigationEpoch
    const canAnchor = currentTranscriptAnchor() === 'free' && !jumpMessageId && !fullResidency
    const anchor = canAnchor
      ? Math.abs(container.scrollTop - residencyScrollTop) < 0.5
        ? (residencyAnchor ?? captureResidencyAnchor())
        : captureResidencyAnchor()
      : null
    try {
      collectSingletonPins()
      for (const [key, held] of returningRowHeights) {
        if (held.ready || fullResidency) restoreReturningRowHeight(key)
      }
      let changed = false
      const width = chatBody.clientWidth
      if (measuredWidth && Math.abs(width - measuredWidth) >= 1) {
        heights.clear()
        changed = true
      }
      measuredWidth = width
      const viewport = container.getBoundingClientRect()
      let visibleRows = 0
      for (const [id, element] of rowElements) {
        const rect = element.getBoundingClientRect()
        changed = heights.set(id, rect.height) || changed
        if (rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom) visibleRows++
      }
      if (changed) heightRevision++
      if (!fullResidency) workingRowLimit = growTranscriptWorkingRows(workingRowLimit, visibleRows)
      const focusedSpacer = document.activeElement?.closest('[data-transcript-spacer]')
      let center = jumpMessageId ? residencyIds.indexOf(jumpMessageId) : residentStart + workingRowLimit / 2
      if (!fullResidency && !jumpMessageId && !(focusedSpacer && chatBody.contains(focusedSpacer))) {
        const origin = chatBody.getBoundingClientRect().bottom - appliedLatestMessageSpacerHeight()
        center = transcriptRowAtOffset(rowOffsets, origin - (viewport.top + viewport.bottom) / 2)
        residentStart = Math.max(0, center - Math.floor(workingRowLimit / 2))
      }
      if (!fullResidency && !(focusedSpacer && chatBody.contains(focusedSpacer))) {
        const previous = [...rowElements.keys()]
        const next = advanceTranscriptResidents(
          residencyIds,
          previous,
          residentStart,
          center,
          pinnedIds,
          workingRowLimit,
        )
        // A released pin transfers to ordinary residency without destroying its
        // component between frames (including a just-highlighted jump target).
        const nextResidents = [...pinnedIds, ...next.ids]
        if (
          admittedResidents === null ||
          nextResidents.length !== admittedResidents.length ||
          nextResidents.some((id, index) => id !== admittedResidents![index])
        ) {
          admittedResidents = nextResidents
        }
        residencyPending = next.pending
        if (next.pending) residencyAgain = true
      }
      await tick()
      if (chatsComponentDestroyed || scope !== chatId || container !== scrollContainer) return
      let preservedAnchor = false
      if (
        anchor &&
        navigationEpoch === residencyNavigationEpoch &&
        currentTranscriptAnchor() === 'free' &&
        !jumpMessageId &&
        !fullResidency
      ) {
        const element = rowElements.get(anchor.id)
        if (element) {
          const delta = element.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.top
          if (Math.abs(delta) > 0.01) {
            container.scrollTop += delta
          }
          preservedAnchor = true
        }
      }
      // Preserve the intended offset across consecutive parser/image resizes.
      // Recapturing the browser's rounded scroll position after each correction
      // would accumulate fractional-pixel error across the newly mounted rows.
      residencyAnchor = preservedAnchor ? anchor : captureResidencyAnchor()
      residencyScrollTop = container.scrollTop
    } finally {
      residencyUpdating = false
      if (residencyAgain) {
        residencyAgain = false
        scheduleResidency()
      }
    }
  }

  function measureTranscriptRow(element: HTMLElement, entry: { id: string; key: string }) {
    let { id, key } = entry
    rowElements.set(id, element)
    const measuredHeight = heights.measured(id)
    if (!fullResidency && measuredHeight !== undefined) {
      // A remounted ChatBody starts empty. Substituting that shell for a tall
      // spacer would discard its known height and can repeatedly move the
      // working window before the asynchronous body gets a chance to render.
      returningRowHeights.set(key, {
        element,
        height: element.style.height,
        overflow: element.style.overflow,
        ready: false,
      })
      element.style.height = `${measuredHeight}px`
      element.style.overflow = 'clip'
      void tick().then(() => {
        const held = returningRowHeights.get(key)
        // Custom layouts without a ChatBody have no parse registration to await.
        if (held?.element === element && !pendingRowParses.has(key)) {
          held.ready = true
          scheduleResidency()
        }
      })
    }
    const observer =
      legacyPaging || typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleResidency)
    observer?.observe(element)
    scheduleResidency()
    return {
      update(next: { id: string; key: string }) {
        if (next.id === id && next.key === key) return
        if (rowElements.get(id) === element) rowElements.delete(id)
        id = next.id
        key = next.key
        rowElements.set(id, element)
        scheduleResidency()
      },
      destroy() {
        observer?.disconnect()
        if (rowElements.get(id) === element) rowElements.delete(id)
        if (returningRowHeights.get(key)?.element === element) restoreReturningRowHeight(key)
        pendingRowParses.delete(key)
      },
    }
  }

  export async function prepareMessageJump(
    index: number,
    expectedChatId = chatId,
  ): Promise<((preservedTop?: number) => void) | null> {
    if (
      chatsComponentDestroyed ||
      expectedChatId !== chatId ||
      !chatBody?.isConnected ||
      !scrollContainer?.contains(chatBody)
    )
      return null
    const position = chatRows.findIndex((row) => row.idx === index)

    if (position < 0) return null
    releaseTranscriptToUser()
    residencyNavigationEpoch++
    const run = ++residencyJumpRun
    const id = residencyIds[position]
    jumpMessageId = id
    if (admittedResidents !== null) {
      admittedResidents = [id, ...admittedResidents.filter((resident) => resident !== id)].slice(
        0,
        TRANSCRIPT_MAX_RESIDENT_ROWS,
      )
    }
    residentStart = Math.max(0, position - Math.floor(workingRowLimit / 2))
    await tick()
    return (preservedTop?: number) => {
      if (jumpMessageId !== id || run !== residencyJumpRun) return
      residencyNavigationEpoch++
      jumpMessageId = null
      residencyAnchor = preservedTop !== undefined ? { id, top: preservedTop } : captureResidencyAnchor()
      residencyScrollTop = scrollContainer?.scrollTop ?? 0
      scheduleResidency()
    }
  }

  async function showResidencyGap(start: number, end: number): Promise<void> {
    const position = end <= residentStart ? end - 1 : start
    const row = chatRows[position]
    if (!row) return
    const release = await prepareMessageJump(row.idx)
    if (!release) return
    try {
      const element = rowElements.get(residencyIds[position])
      if (element) {
        scrollElementToContainerStart(element, scrollContainer)
        element.focus({ preventScroll: true })
      }
    } finally {
      release()
    }
  }

  $effect.pre(() => {
    const scope = chatId
    untrack(() => {
      if (residencyScope === scope) return
      residencyScope = scope
      residencyEntries.clear()
      workingRowLimit = TRANSCRIPT_WORKING_ROWS
      reservations.reset()
      messageViews.reset()
      heights.clear()
      restorePressedRowSizes()
      for (const key of returningRowHeights.keys()) restoreReturningRowHeight(key)
      pendingRowParses.clear()
      heightRevision++
      residentStart = 0
      admittedResidents = null
      residencyPending = false
      singletonPins = []
      jumpMessageId = null
      residencyAnchor = null
      measuredWidth = 0
      pressedLogicalEnd = null
      pressedResidentEntries = null
      pressedPointerId = null
      if (pressReleaseTimer !== null) clearTimeout(pressReleaseTimer)
      pressReleaseTimer = null
    })
  })
  $effect(() => {
    void chatRows
    if (fullResidency) untrack(releaseResidencyPress)
    void popupStore.trigger
    void popupStore.children
    scheduleResidency()
  })

  // The row that reveals the dynamic (swipe) icons. Comment rows — e.g. the
  // branch-provenance marker appended by branching — can occupy the newest
  // slot but render no reroll controls, so anchoring on the newest row
  // unconditionally would leave the chat with no visible swipe controls.
  const dynaIconRowKey = $derived(chatRows.find((row) => !row.message.isComment)?.key ?? null)

  function getLatestMessageElement(): HTMLElement | null {
    return chatBody?.querySelector<HTMLElement>(':scope > .chat-message-container') ?? null
  }

  function getLatestMessageAlignmentKey(): string | null {
    const chatRoomId = getCurrentChatRoomId()
    const latestRow = chatRows[0]
    if (!chatRoomId || !latestRow) return null
    return `${chatRoomId}:row:${latestRow.key}`
  }

  function currentTranscriptAnchor(): TranscriptAnchor {
    const latestMessageKey = getLatestMessageAlignmentKey()
    if (!latestMessageKey || transcriptAnchorKey !== latestMessageKey) return 'free'
    return transcriptAnchor
  }

  function setTranscriptAnchor(nextAnchor: TranscriptAnchor, latestMessageKey = getLatestMessageAlignmentKey()): void {
    if (nextAnchor === 'free' || !latestMessageKey) {
      transcriptAnchor = 'free'
      transcriptAnchorKey = null
      return
    }

    transcriptAnchor = nextAnchor
    transcriptAnchorKey = latestMessageKey
  }

  function checkIfAtBottom() {
    if (!scrollContainer) return true
    const lastEl = getLatestMessageElement()
    if (!lastEl) return true
    const rect = lastEl.getBoundingClientRect()
    const scRect = scrollContainer.getBoundingClientRect()
    return rect.top <= scRect.bottom + 100
  }

  function transcriptIsAtLatestPosition(): boolean {
    return !scrollContainer || Math.max(0, -scrollContainer.scrollTop) <= 1
  }

  function transcriptIsFollowingLatest(): boolean {
    return currentTranscriptAnchor() !== 'free' || transcriptIsAtLatestPosition()
  }

  function appliedLatestMessageSpacerHeight(): number {
    const spacer = chatBody?.querySelector<HTMLElement>(':scope > [data-latest-message-scroll-spacer]')
    if (!spacer) return 0

    const rectHeight = spacer.getBoundingClientRect().height
    const inlineHeight = Number.parseFloat(spacer.style.height)
    if (Number.isFinite(rectHeight) && rectHeight > 0) return rectHeight
    return Number.isFinite(inlineHeight) ? Math.max(0, inlineHeight) : 0
  }

  function requiredLatestMessageSpacerHeight(): number {
    const latestMessage = getLatestMessageElement()
    if (!scrollContainer || !latestMessage) return 0

    const latestMessageTop = latestMessage.getBoundingClientRect().top
    const scrollportTop = scrollContainer.getBoundingClientRect().top + scrollContainer.clientTop
    const currentSpacerHeight = appliedLatestMessageSpacerHeight()
    // Removing the current spacer and scroll translation yields the newest
    // row's natural top. The difference to the scrollport start is exactly the
    // extra reverse-scroll range needed for a short row.
    const naturalTopWithoutSpacer = latestMessageTop + scrollContainer.scrollTop + currentSpacerHeight
    const requiredHeight = naturalTopWithoutSpacer - scrollportTop
    return Number.isFinite(requiredHeight) ? Math.max(0, requiredHeight) : 0
  }

  function clearLatestMessageAlignmentAfterFrame(run: number): void {
    const clear = () => {
      if (run === latestMessageAlignmentRun) isAligningLatestMessage = false
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(clear)
    else setTimeout(clear, 0)
  }

  function releaseTranscriptToUser(): void {
    latestMessageAlignmentRun += 1
    isAligningLatestMessage = false
    setTranscriptAnchor('free')
  }

  async function alignLatestMessageToStart(
    chatRoomId: string,
    latestMessageKey = getLatestMessageAlignmentKey(),
  ): Promise<void> {
    if (!latestMessageKey || !scrollContainer || !getLatestMessageElement()) return

    const run = ++latestMessageAlignmentRun
    const expectedContainer = scrollContainer
    const expectedMessage = getLatestMessageElement()
    isAligningLatestMessage = true
    setTranscriptAnchor('start', latestMessageKey)

    // Measure from the reverse scroller's natural end. The spacer update and
    // final top correction complete in the same microtask/frame, so an
    // observer-driven realignment cannot expose this intermediate position.
    expectedContainer.scrollTop = 0
    const nextSpacerHeight = requiredLatestMessageSpacerHeight()
    const appliedSpacerHeight = appliedLatestMessageSpacerHeight()
    const spacerChanged = Math.abs(nextSpacerHeight - latestMessageScrollSpacerHeight) >= 0.5
    if (spacerChanged) {
      latestMessageScrollSpacerHeight = nextSpacerHeight
    }
    // A second alignment can supersede the run after state changed but before
    // Svelte flushed the spacer style. It must still wait for that pending DOM
    // write before using row geometry.
    if (spacerChanged || Math.abs(nextSpacerHeight - appliedSpacerHeight) >= 0.5) {
      await tick()
    }

    if (
      chatsComponentDestroyed ||
      run !== latestMessageAlignmentRun ||
      getCurrentChatRoomId() !== chatRoomId ||
      getLatestMessageAlignmentKey() !== latestMessageKey ||
      currentTranscriptAnchor() !== 'start' ||
      scrollContainer !== expectedContainer ||
      getLatestMessageElement() !== expectedMessage
    ) {
      if (run === latestMessageAlignmentRun) isAligningLatestMessage = false
      return
    }

    scrollElementToContainerStart(expectedMessage, expectedContainer)
    clearLatestMessageAlignmentAfterFrame(run)
  }

  function reassertTranscriptEnd(latestMessageKey: string): void {
    if (
      currentTranscriptAnchor() === 'end' &&
      transcriptAnchorKey === latestMessageKey &&
      getLatestMessageAlignmentKey() === latestMessageKey &&
      scrollContainer
    ) {
      scrollContainer.scrollTop = 0
    }
    void tick().then(() => {
      if (
        currentTranscriptAnchor() === 'end' &&
        transcriptAnchorKey === latestMessageKey &&
        getLatestMessageAlignmentKey() === latestMessageKey &&
        scrollContainer
      ) {
        scrollContainer.scrollTop = 0
      }
    })
  }

  function followLatestAtNaturalEnd(latestMessageKey = getLatestMessageAlignmentKey()): void {
    latestMessageAlignmentRun += 1
    isAligningLatestMessage = false
    latestMessageScrollSpacerHeight = 0
    if (!latestMessageKey) {
      if (scrollContainer) scrollContainer.scrollTop = 0
      return
    }
    setTranscriptAnchor('end', latestMessageKey)
    reassertTranscriptEnd(latestMessageKey)
  }

  function scheduleLatestMessageAlignmentReassert(): void {
    if (latestMessageAlignmentReassertQueued || chatsComponentDestroyed) return

    latestMessageAlignmentReassertQueued = true
    const version = latestMessageAlignmentVersion
    const reassert = () => {
      latestMessageAlignmentReassertQueued = false
      if (
        chatsComponentDestroyed ||
        version !== latestMessageAlignmentVersion ||
        latestMessageResizeTarget !== getLatestMessageElement() ||
        scrollContainerResizeTarget !== scrollContainer
      ) {
        return
      }

      const latestMessageKey = getLatestMessageAlignmentKey()
      const chatRoomId = getCurrentChatRoomId()
      const anchor = currentTranscriptAnchor()
      if (latestMessageKey && anchor === 'end') reassertTranscriptEnd(latestMessageKey)
      else if (latestMessageKey && chatRoomId && anchor === 'start') {
        void alignLatestMessageToStart(chatRoomId, latestMessageKey)
      }
    }

    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reassert)
    else setTimeout(reassert, 0)
  }

  function observeLatestMessageSize(target: HTMLElement | null): boolean {
    if (target === latestMessageResizeTarget) return false

    latestMessageResizeObserver?.disconnect()
    latestMessageResizeObserver = null
    latestMessageResizeTarget = target
    latestMessageAlignmentVersion += 1
    latestMessageAlignmentReassertQueued = false

    if (!target || typeof ResizeObserver === 'undefined') return true

    latestMessageResizeObserver = new ResizeObserver(() => {
      if (target !== latestMessageResizeTarget) return
      scheduleResidency()
      scheduleLatestMessageAlignmentReassert()
    })
    latestMessageResizeObserver.observe(target)
    return true
  }

  function observeScrollContainerSize(target: HTMLElement | null): boolean {
    if (target === scrollContainerResizeTarget) return false

    scrollContainerResizeObserver?.disconnect()
    scrollContainerResizeObserver = null
    scrollContainerResizeTarget = target
    latestMessageAlignmentVersion += 1
    latestMessageAlignmentReassertQueued = false

    if (!target || typeof ResizeObserver === 'undefined') return true

    scrollContainerResizeObserver = new ResizeObserver(() => {
      if (target !== scrollContainerResizeTarget) return
      scheduleResidency()
      scheduleLatestMessageAlignmentReassert()
    })
    scrollContainerResizeObserver.observe(target)
    return true
  }

  export const scrollToLatestMessage = () => {
    residentStart = 0
    hasNewUnreadMessage = false
    const chatRoomId = getCurrentChatRoomId()
    markChatRead(chatRoomId)
    pendingEntryChatRoomId = null
    if (chatRoomId) void alignLatestMessageToStart(chatRoomId)
  }

  export const scrollToNaturalEnd = () => {
    residentStart = 0
    hasNewUnreadMessage = false
    const chatRoomId = getCurrentChatRoomId()
    markChatRead(chatRoomId)
    pendingEntryChatRoomId = null
    followLatestAtNaturalEnd()
  }

  export const prepareForInFlowComposerFocus = () => {
    if (transcriptIsAtLatestPosition()) followLatestAtNaturalEnd()
  }

  interface GenerationFollowState {
    projectionKey: string
    follow: boolean
    userCancelled: boolean
  }

  let generationFollowState: GenerationFollowState | null = null
  let previousGenerationPresentationKey: string | null = null
  let pendingGenerationWasAtLatest = true
  let transcriptUserIntentPending = false

  function regenerateProjectionKey(projection: GenerationDisplayProjection | undefined): string | null {
    return projection ? `${projection.operationId}:${projection.attemptNo}` : null
  }

  function currentGenerationPresentationKey(): string | null {
    return regenerateProjectionKey(activeRegenerateProjection) ?? activeAppendPresentationKey
  }

  function reassertGenerationNaturalEnd(projectionKey: string): void {
    void tick().then(() => {
      if (
        generationFollowState?.projectionKey === projectionKey &&
        generationFollowState.follow &&
        currentGenerationPresentationKey() === projectionKey &&
        scrollContainer
      ) {
        scrollContainer.scrollTop = 0
      }
    })
  }

  export const handleTranscriptUserInteraction = () => {
    residencyNavigationEpoch++
    transcriptUserIntentPending = true
    if (currentTranscriptAnchor() === 'start') releaseTranscriptToUser()
  }

  export const handleTranscriptScroll = () => {
    if (
      scrollContainer &&
      Math.abs(scrollContainer.scrollTop - residencyScrollTop) >= 0.5 &&
      currentTranscriptAnchor() === 'free' &&
      !jumpMessageId &&
      !fullResidency
    ) {
      // Capture the user's new position before an awaited body/older-page
      // update can change geometry ahead of the next reconciliation frame.
      residencyAnchor = captureResidencyAnchor()
      residencyScrollTop = scrollContainer.scrollTop
    }
    scheduleResidency()
    if (isAligningLatestMessage) return

    const isAtLatestPosition = transcriptIsAtLatestPosition()
    if (generationFollowState?.follow) {
      if (transcriptUserIntentPending && !isAtLatestPosition) {
        generationFollowState = { ...generationFollowState, follow: false, userCancelled: true }
        transcriptUserIntentPending = false
        releaseTranscriptToUser()
        return
      }
      transcriptUserIntentPending = false
      reassertGenerationNaturalEnd(generationFollowState.projectionKey)
      return
    }

    const anchor = currentTranscriptAnchor()
    if (anchor === 'end') {
      if (transcriptUserIntentPending && !isAtLatestPosition) releaseTranscriptToUser()
      else if (!isAtLatestPosition) {
        const latestMessageKey = getLatestMessageAlignmentKey()
        if (latestMessageKey) reassertTranscriptEnd(latestMessageKey)
      }
      transcriptUserIntentPending = false
      return
    }

    // `free` deliberately remains free even at scrollTop=0. Geometry and
    // scroll events never gain permission to expand or shrink the spacer.
    transcriptUserIntentPending = false
  }

  let previousLength = 0
  let previousChatRoomId: string | null = null
  let previousMessageIds: (string | null)[] = []
  let wasAtBottomBeforeUpdate = true
  let pendingEntryChatRoomId: string | null = null
  let visibleChatRoomId: string | null = null
  let activatedDisplaySourceChatId: string | null = null
  let previousIsGenerationActive = false

  $effect.pre(() => {
    const projectionKey = currentGenerationPresentationKey()
    if (projectionKey && projectionKey !== previousGenerationPresentationKey) {
      pendingGenerationWasAtLatest = transcriptIsFollowingLatest()
    }
  })

  $effect(() => {
    chatRows
    const projection = activeRegenerateProjection
    const projectionKey = currentGenerationPresentationKey()
    const currentChatRoomId = getCurrentChatRoomId()

    const activeAppendMessageId =
      activeAppendMessageIndex >= 0
        ? messages[activeAppendMessageIndex]?.chatId
        : (activeAppendActivity?.generationId ?? activeAppendPresentation?.generationId)
    if (activeAppendMessageId && activeAppendPresentationKey) {
      if (appendPresentationKeyAliases[activeAppendMessageId] !== activeAppendPresentationKey) {
        appendPresentationKeyAliases = {
          ...appendPresentationKeyAliases,
          [activeAppendMessageId]: activeAppendPresentationKey,
        }
      }
    }

    if (projection?.targetMessageId) {
      const inheritedKey = presentationKeyAliases[projection.targetMessageId] ?? projection.targetMessageId
      const nextAliases = {
        ...presentationKeyAliases,
        [projection.targetMessageId]: inheritedKey,
        ...(projection.generationId ? { [projection.generationId]: inheritedKey } : {}),
      }
      if (
        presentationKeyAliases[projection.targetMessageId] !== inheritedKey ||
        (projection.generationId && presentationKeyAliases[projection.generationId] !== inheritedKey)
      ) {
        presentationKeyAliases = nextAliases
      }
    }

    if (
      projection?.status === 'finalizing' &&
      projection.generationId &&
      messages.some(
        (message) =>
          message.role === 'char' &&
          (message.chatId === projection.generationId ||
            message.generationInfo?.generationId === projection.generationId),
      )
    ) {
      if (writeActionsAllowed) finishGenerationDisplayProjection(projection)
      return
    }

    if (projectionKey && projectionKey !== previousGenerationPresentationKey) {
      const follow = autoScrollToNewMessage && (pendingGenerationWasAtLatest || alwaysScrollToNewMessage)
      generationFollowState = { projectionKey, follow, userCancelled: false }
      transcriptUserIntentPending = false
      if (follow) {
        followLatestAtNaturalEnd()
        reassertGenerationNaturalEnd(projectionKey)
      }
      previousGenerationPresentationKey = projectionKey
      return
    }

    if (projectionKey && generationFollowState?.projectionKey === projectionKey && generationFollowState.follow) {
      followLatestAtNaturalEnd()
      reassertGenerationNaturalEnd(projectionKey)
      return
    }

    if (!projectionKey && previousGenerationPresentationKey) {
      const settledFollow = generationFollowState
      previousGenerationPresentationKey = null
      generationFollowState = null
      transcriptUserIntentPending = false
      if (settledFollow?.follow && !settledFollow.userCancelled && currentChatRoomId) {
        void alignLatestMessageToStart(currentChatRoomId)
      }
    }
  })

  onDestroy(() => {
    residencyEntries.clear()
    chatsComponentDestroyed = true
    if (residencyFrame !== null) cancelAnimationFrame(residencyFrame)
    if (pressReleaseTimer !== null) clearTimeout(pressReleaseTimer)
    restorePressedRowSizes()
    for (const key of returningRowHeights.keys()) restoreReturningRowHeight(key)
    pendingRowParses.clear()
    displayScheduler.destroy()
    // Reading live chat props during teardown can reconnect parent deriveds
    // to the previous selection. Release the scope captured while mounted.
    releaseDisplaySourceChat(activatedDisplaySourceChatId)
    initialDisplayReadiness.destroy()
    latestMessageAlignmentVersion += 1
    latestMessageAlignmentRun += 1
    latestMessageResizeObserver?.disconnect()
    scrollContainerResizeObserver?.disconnect()
    clearVisibleChat(visibleChatRoomId)
  })

  $effect.pre(() => {
    activatedDisplaySourceChatId = getCurrentChatRoomId()
    activateDisplaySourceChat(activatedDisplaySourceChatId)
    chatRows
    wasAtBottomBeforeUpdate = checkIfAtBottom()
  })

  $effect.pre(() => {
    displayScheduler.setScope(getCurrentChatRoomId())
    initialDisplayReadiness.updateScope(getCurrentChatRoomId(), chatRows.length > 0, initialRowsPending)
  })

  $effect(() => {
    // Subscribe to the semantic startup signal, including localized failures.
    // Older rows never participate in the newest-row readiness registrations.
    void $startupCoordinatorStore
    displayScheduler.setPaused(initialDisplayPending || initialRowsPending || (!readOnly && !backgroundReady()))
  })

  $effect(() => {
    chatRows
    const latestMessage = getLatestMessageElement()
    const latestMessageTargetChanged = observeLatestMessageSize(latestMessage)
    const scrollContainerTargetChanged = observeScrollContainerSize(scrollContainer)
    const currentChatRoomId = getCurrentChatRoomId()
    const isSameChat = currentChatRoomId === previousChatRoomId
    if (didChatOwnerChange(previousChatRoomId, currentChatRoomId)) {
      presentationKeyAliases = {}
      appendPresentationKeyAliases = {}
      clearVisibleChat(visibleChatRoomId)
      setVisibleChat(currentChatRoomId)
      visibleChatRoomId = currentChatRoomId
      releaseTranscriptToUser()
      transcriptUserIntentPending = false
      pendingGeneratedMessageEndKey = null
      pendingEntryChatRoomId = currentChatRoomId
      hasNewUnreadMessage = false
      markChatRead(currentChatRoomId)
      if (writeActionsAllowed) replaceAutomaticTranslationMessageIds([])
      previousIsGenerationActive = isGenerationActive
    } else if (writeActionsAllowed) {
      const residentMessageIds = new Set(messages.map((message) => message.chatId).filter((id): id is string => !!id))
      const retainedIds = untrack(() => $automaticTranslationMessageIds).filter(
        (id) => residentMessageIds.has(id) && !$serverOwnedGeneratedMessageIds.has(id),
      )
      const appendedIds = newlyAppendedMessageIds({
        previousChatId: previousChatRoomId,
        currentChatId: currentChatRoomId,
        previousMessageIds,
        messages,
        autoTranslate: currentChatMetadata?.autoTranslate === true,
      })
      replaceAutomaticTranslationMessageIds([
        ...retainedIds,
        ...appendedIds.filter((id) => !$serverOwnedGeneratedMessageIds.has(id)),
      ])
    }

    // A chat can first render as a message-less hydration shell. Keep entry
    // alignment pending until its newest persisted row reaches the DOM.
    if (currentChatRoomId && pendingEntryChatRoomId === currentChatRoomId && chatRows.length > 0 && scrollContainer) {
      pendingEntryChatRoomId = null
      void alignLatestMessageToStart(currentChatRoomId)
    }

    // Only auto-scroll if it's the same chat and new messages were added
    if (isSameChat && messages.length > previousLength) {
      const lastMsg = messages[messages.length - 1]
      if (lastMsg && lastMsg.role === 'char') {
        const latestMessageKey = getLatestMessageAlignmentKey()
        const isAssistantPlaceholder = lastMsg.data === '' && latestMessageKey !== null
        const shouldFollowLatest = autoScrollToNewMessage && (wasAtBottomBeforeUpdate || alwaysScrollToNewMessage)

        if (isAssistantPlaceholder) pendingGeneratedMessageEndKey = latestMessageKey

        if (shouldFollowLatest) {
          if (isAssistantPlaceholder) followLatestAtNaturalEnd(latestMessageKey)
          else if (currentChatRoomId && latestMessageKey) {
            void alignLatestMessageToStart(currentChatRoomId, latestMessageKey)
          }
        } else if (!wasAtBottomBeforeUpdate) {
          hasNewUnreadMessage = true
          markChatUnread(currentChatRoomId)
        }
      }
    }

    // DefaultChatScreen scopes this prop to its displayed chat id, so its
    // same-chat falling edge cannot be caused by a background generation.
    if (
      isSameChat &&
      previousIsGenerationActive &&
      !isGenerationActive &&
      pendingGeneratedMessageEndKey !== null &&
      pendingGeneratedMessageEndKey === getLatestMessageAlignmentKey()
    ) {
      const completedLatestMessageKey = pendingGeneratedMessageEndKey
      pendingGeneratedMessageEndKey = null
      const wasAtLatestPosition = transcriptIsAtLatestPosition()

      const shouldFollowLatest = autoScrollToNewMessage && (wasAtLatestPosition || alwaysScrollToNewMessage)
      if (
        shouldFollowLatest &&
        currentChatRoomId &&
        getCurrentChatRoomId() === currentChatRoomId &&
        getLatestMessageAlignmentKey() === completedLatestMessageKey
      ) {
        void alignLatestMessageToStart(currentChatRoomId, completedLatestMessageKey)
      } else if (!wasAtLatestPosition) {
        hasNewUnreadMessage = true
        markChatUnread(currentChatRoomId)
      }
    }

    if (latestMessageTargetChanged || scrollContainerTargetChanged) {
      scheduleLatestMessageAlignmentReassert()
    }

    previousIsGenerationActive = isGenerationActive
    previousLength = messages.length
    previousMessageIds = messages.map((message) => message.chatId ?? null)
    previousChatRoomId = currentChatRoomId
  })
</script>

<svelte:document
  onpointerdown={beginResidencyPress}
  onpointerup={endResidencyPress}
  onpointercancel={endResidencyPress}
  onselectionchange={handleResidencyFocusChange}
  onfocusin={handleResidencyFocusChange}
  onfocusout={scheduleResidency} />
<svelte:window onblur={releaseResidencyPress} />

<div
  class="chat-screen-content-width flex flex-col-reverse"
  bind:this={chatBody}
  data-transcript-window-rows={chatRows.length}
  data-transcript-resident-rows={residentRowCount}
  data-transcript-residency-mode={residencyMode}
  aria-busy={!fullResidency && residencyPending}
  style:overflow-anchor={legacyPaging ? 'auto' : 'none'}>
  {#if chatRows.length > 0}
    <div
      class="shrink-0"
      data-latest-message-scroll-spacer
      aria-hidden="true"
      style={`height: ${latestMessageScrollSpacerHeight}px`}>
    </div>
  {/if}
  {#each residentEntries as entry (entry.key)}
    {#if entry.kind === 'spacer'}
      <div class="relative shrink-0" data-transcript-spacer style:height={`${entry.height}px`}>
        <button
          type="button"
          class="sr-only focus:not-sr-only"
          onclick={() => showResidencyGap(entry.start, entry.end)}>
          {language.transcriptShowMessages(chatRows[entry.end - 1].idx + 1, chatRows[entry.start].idx + 1)}
        </button>
      </div>
    {:else}
      {@const row = entry.row}
      <div
        class="chat-message-container shrink-0"
        data-transcript-row-id={entry.id}
        tabindex="-1"
        use:measureTranscriptRow={entry}
        data-risu-dyna-icons={row.key === dynaIconRowKey ? 'true' : undefined}
        data-generation-display-projection={row.generationPresentationMode}>
        <Chat
          {readOnly}
          message={row.generationDisplayProjection ? (row.generationDisplayProjection.text ?? '') : row.message.data}
          translation={row.generationDisplayProjection ? null : (row.message.translation ?? null)}
          isLastMemory={row.isLastMemory}
          idx={row.idx}
          totalLength={messages.length}
          img={row.img}
          {onReroll}
          {unReroll}
          {onNewReroll}
          {onSelectRerollCandidate}
          {rerollTarget}
          rerollIcon="dynamic"
          displayChatId={row.scopeId}
          displayMessageId={row.message.chatId ?? null}
          character={row.character}
          largePortrait={row.largePortrait}
          messageGenerationInfo={row.message.generationInfo}
          role={row.message.role}
          name={row.name}
          isComment={row.message.isComment ?? false}
          isGenerationLoading={row.isRegenerationTarget ||
            row.isAppendGenerationPresentation ||
            row.generationDisplayProjection !== undefined ||
            (isGenerationActive &&
              row.idx === messages.length - 1 &&
              row.message.role === 'char' &&
              row.message.data === '')}
          isGenerationProjection={row.isAppendGenerationPresentation || row.generationDisplayProjection !== undefined}
          generationPresentationMode={row.generationPresentationMode}
          isChatGenerating={isGenerationActive}
          halfStreamingTokensPerSecond={row.isAppendGenerationPresentation ||
          (row.idx === messages.length - 1 && row.message.role === 'char')
            ? activeHalfStreamingProgress?.tokensPerSecond
            : undefined}
          halfStreamingGeneratedTokens={row.isAppendGenerationPresentation ||
          (row.idx === messages.length - 1 && row.message.role === 'char')
            ? activeHalfStreamingProgress?.generatedTokens
            : undefined}
          autoTranslateOnReady={!readOnly &&
            typeof row.message.chatId === 'string' &&
            $automaticTranslationMessageIds.includes(row.message.chatId) &&
            !$serverOwnedGeneratedMessageIds.has(row.message.chatId)}
          onAutoTranslationEligibilityConsumed={() => {
            if (!readOnly && canUseClientWriteAccess()) consumeAutomaticTranslationEligibility(row.message.chatId ?? '')
          }}
          onInitialDisplayParseStart={(registration) => {
            beginRowParse(entry.key, registration)
            if (row.awaitInitialDisplayParse) initialDisplayReadiness.start(row.scopeId, registration)
          }}
          onInitialDisplayParseSettled={(registration) => {
            settleRowParse(entry.key, registration)
            if (row.awaitInitialDisplayParse) initialDisplayReadiness.settle(row.scopeId, registration)
          }}
          displayPriority={row.awaitInitialDisplayParse ? 'critical' : 'background'}
          generationPersistenceState={row.generationPersistenceState}
          generationPhase={row.isAppendGenerationPresentation
            ? (activeAppendPresentation?.phase ?? generationPhase)
            : generationPhase}
          generationStartedAt={row.isAppendGenerationPresentation
            ? (activeAppendPresentation?.startedAt ?? generationActivity?.startedAt)
            : undefined}
          generationStage={row.isAppendGenerationPresentation
            ? (activeAppendPresentation?.stage ?? generationStage)
            : generationStage}
          disabled={row.message.disabled ?? false} />
      </div>
    {/if}
  {/each}
</div>
