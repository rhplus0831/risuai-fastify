<script lang="ts">
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import { onDestroy, tick, untrack } from 'svelte'
  import { ChevronUpIcon, ChevronDownIcon } from '@lucide/svelte'
  import {
    getCurrentHypaV3Preset,
    type SerializableHypaV3Data,
    type SerializableSummary,
    summarize,
  } from 'src/ts/process/memory/hypav3'
  import { alertConfirm, alertNormalWait } from 'src/ts/alert'
  import { selectedCharID, hypaV3ModalOpen } from 'src/ts/stores.svelte'
  import { getCharacterByIndex, type character, type Chat } from 'src/ts/storage/database.svelte'
  import { language } from 'src/lang'
  import { translateHTML } from 'src/ts/translator/translator'
  import { modalFocusTrap } from 'src/ts/gui/modalFocusTrap'
  import { alertConfirmTwice } from './HypaV3Modal/utils'
  import ModalHeader from './HypaV3Modal/modal-header.svelte'
  import ModalSummaryItem from './HypaV3Modal/modal-summary-item.svelte'
  import ModalFooter from './HypaV3Modal/modal-footer.svelte'
  import CategoryManagerModal from './HypaV3Modal/category-manager-modal.svelte'
  import TagManagerModal from './HypaV3Modal/tag-manager-modal.svelte'
  import BulkEditActions from './HypaV3Modal/bulk-edit-actions.svelte'
  import BulkResummaryResult from './HypaV3Modal/bulk-resummary-result.svelte'
  import ServerMemoryJobs from './HypaV3Modal/server-memory-jobs.svelte'
  import {
    canUseServerMemoryApi,
    deleteServerMemorySummary,
    listServerMemorySummaries,
    patchServerMemorySummary,
    type PatchServerMemorySummaryInput,
    type ServerMemorySummary,
  } from 'src/ts/process/request/serverMemory'
  import { subscribeServerMemoryJobEvents } from 'src/ts/server/memoryJobEvents'

  import type {
    SummaryItemState,
    ExpandedMessageState,
    SearchState,
    SearchResult,
    BulkResummaryState,
    CategoryManagerState,
    TagManagerState,
    BulkEditState,
    FilterState,
    UIState,
  } from './HypaV3Modal/types'

  import { shouldShowSummary, isGuidLike, parseSelectionInput } from './HypaV3Modal/utils'
  import { buildServerSummaryPatch, type ServerSummaryPatchField } from './HypaV3Modal/server-summary-patch'
  import type { OpenAIChat } from 'src/ts/process/index.svelte'

  const currentCharacter = $derived<character | undefined>(getCharacterByIndex($selectedCharID))
  const currentChat = $derived<Chat | undefined>(currentCharacter?.chats?.[currentCharacter.chatPage])
  const serverBackedMemoryMode = $derived(canUseServerMemoryApi())
  const currentChatId = $derived(currentChat?.id ?? '')
  const defaultHypaV3Data = $derived(createInitialHypaV3Data())
  const legacyHypaV3Data = $derived(currentChat?.hypaV3Data ?? defaultHypaV3Data)

  interface ServerSummaryView extends SerializableSummary {
    serverId: string
    chunkId: string
    model: string
  }

  interface ServerSummaryMutationOwner {
    chatId: string
    epoch: number
  }

  interface PendingServerSummarySave {
    owner: ServerSummaryMutationOwner
    promise: Promise<boolean>
  }

  interface BulkResummaryOwner {
    character: character
    characterId: string
    chat: Chat
    chatId: string | undefined
    data: SerializableHypaV3Data
  }

  interface BulkResummaryOperation {
    token: number
    owner: BulkResummaryOwner
  }

  let serverHypaV3Data = $state<SerializableHypaV3Data>(createInitialHypaV3Data())
  let serverMemoryLoading = $state(false)
  let serverMemoryMutationError = $state<string | null>(null)
  let serverMemoryRefreshError = $state<string | null>(null)
  const serverMemoryError = $derived(serverMemoryRefreshError ?? serverMemoryMutationError)
  let serverSummaryRefreshEpoch = 0
  let serverSummaryOwnerEpoch = 0
  let serverSummaryLoadedChatId: string | null = null
  const serverSummaryMutationQueues = new Map<string, Promise<void>>()
  const pendingServerSummarySaves = new Set<PendingServerSummarySave>()
  const pendingServerSummaryTextSaves = new Map<string, Promise<boolean>>()
  const dirtyServerSummaryIds = new Set<string>()
  const recoverySummaryBaselines = new Map<string, ServerSummaryView>()
  const dirtyServerSummaryTextVersions = new Map<string, number>()
  const deletedServerSummaryIds = new Map<string, number>()
  const serverSummaryEditVersions = new Map<string, number>()
  let pendingServerSummaryRefreshChatId: string | null = null
  let serverSummaryCloseRequest: Promise<boolean> | null = null
  let consecutiveServerSummaryCloseFailures = 0
  const hypaV3Data = $derived(serverBackedMemoryMode ? serverHypaV3Data : legacyHypaV3Data)
  const activeServerSummaryModel = $derived(resolveActiveServerSummaryModel())
  const activeServerSummaryIds = $derived.by(
    () =>
      new Set(
        filterServerSummaryViewsForModel(
          serverHypaV3Data.summaries as ServerSummaryView[],
          activeServerSummaryModel,
        ).map((summary) => summary.serverId),
      ),
  )
  const footerHypaV3Data = $derived.by<SerializableHypaV3Data>(() => {
    if (!serverBackedMemoryMode) return hypaV3Data
    return {
      ...serverHypaV3Data,
      summaries: serverHypaV3Data.summaries.filter((summary) =>
        activeServerSummaryIds.has((summary as ServerSummaryView).serverId),
      ),
    }
  })

  function createInitialHypaV3Data(): SerializableHypaV3Data {
    return {
      summaries: [],
      categories: [{ id: '', name: language.hypaV3Modal.unclassified }],
      lastSelectedSummaries: [],
    }
  }

  function resolveActiveServerSummaryModel(): string {
    try {
      const model = getCurrentHypaV3Preset().settings.summarizationModel
      return typeof model === 'string' && model.trim().length > 0 ? model : 'subModel'
    } catch {
      return 'subModel'
    }
  }

  function filterServerSummaryViewsForModel(
    summaries: readonly ServerSummaryView[],
    activeModel: string,
  ): ServerSummaryView[] {
    const legacyChunkIds = new Set(
      summaries.filter((summary) => summary.model === 'legacy-hypav3').map((summary) => summary.chunkId),
    )
    return summaries.filter(
      (summary) =>
        summary.model === 'legacy-hypav3' || (summary.model === activeModel && !legacyChunkIds.has(summary.chunkId)),
    )
  }

  function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  function serverSummaryView(summary: ServerMemorySummary): ServerSummaryView {
    const metadata = isObject(summary.metadata) ? summary.metadata : {}
    const chatMemos = Array.isArray(metadata.chatMemos)
      ? metadata.chatMemos.filter((memo): memo is string => typeof memo === 'string')
      : []
    const tags = Array.isArray(metadata.tags)
      ? metadata.tags.filter((tag): tag is string => typeof tag === 'string')
      : undefined

    return {
      serverId: summary.id,
      chunkId: summary.chunkId,
      model: summary.model,
      text: summary.text,
      chatMemos,
      isImportant: metadata.isImportant === true,
      ...(typeof metadata.categoryId === 'string' ? { categoryId: metadata.categoryId } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
    }
  }

  function sameStringArray(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
    const leftValues = left ?? []
    const rightValues = right ?? []
    return leftValues.length === rightValues.length && leftValues.every((value, index) => value === rightValues[index])
  }

  function sameServerSummaryView(left: ServerSummaryView, right: ServerSummaryView): boolean {
    return (
      left.serverId === right.serverId &&
      left.chunkId === right.chunkId &&
      left.model === right.model &&
      left.text === right.text &&
      left.isImportant === right.isImportant &&
      left.categoryId === right.categoryId &&
      sameStringArray(left.chatMemos, right.chatMemos) &&
      sameStringArray(left.tags, right.tags)
    )
  }

  function cloneLegacyCategories(): SerializableHypaV3Data['categories'] {
    return (legacyHypaV3Data.categories ?? []).map((category) => ({ ...category }))
  }

  function sameCategories(
    left: SerializableHypaV3Data['categories'],
    right: SerializableHypaV3Data['categories'],
  ): boolean {
    return (
      left.length === right.length &&
      left.every((category, index) => category.id === right[index]?.id && category.name === right[index]?.name)
    )
  }

  async function refreshServerSummaries(
    chatId: string,
    categoriesSnapshot: SerializableHypaV3Data['categories'] = cloneLegacyCategories(),
    signal?: AbortSignal,
  ): Promise<void> {
    const refreshEpoch = ++serverSummaryRefreshEpoch
    const editVersionsAtStart = new Map(serverSummaryEditVersions)
    serverMemoryLoading = true
    serverMemoryRefreshError = null
    const result = await listServerMemorySummaries(chatId, undefined, signal)
    if (refreshEpoch !== serverSummaryRefreshEpoch || currentChatId !== chatId) return

    serverMemoryLoading = false
    if (result.status === 'ok') {
      for (const summary of result.summaries) recoverySummaryBaselines.set(summary.id, serverSummaryView(summary))
      const localSummaries = new Map(
        serverHypaV3Data.summaries.map((summary) => {
          const view = summary as ServerSummaryView
          return [view.serverId, view] as const
        }),
      )
      const summaries = result.summaries.flatMap((summary) => {
        const deletedAtVersion = deletedServerSummaryIds.get(summary.id)
        if (deletedAtVersion !== undefined && (editVersionsAtStart.get(summary.id) ?? 0) < deletedAtVersion) {
          return []
        }
        const local = localSummaries.get(summary.id)
        const changedDuringRefresh =
          (serverSummaryEditVersions.get(summary.id) ?? 0) !== (editVersionsAtStart.get(summary.id) ?? 0)
        const incoming = serverSummaryView(summary)
        return [
          local &&
          (dirtyServerSummaryIds.has(summary.id) ||
            dirtyServerSummaryTextVersions.has(summary.id) ||
            changedDuringRefresh ||
            sameServerSummaryView(local, incoming))
            ? local
            : incoming,
        ]
      })
      // A successful list that began after a deletion is authoritative: retire
      // the stale-request guard so a later job may legitimately recreate the ID.
      for (const [summaryId, deletedAtVersion] of deletedServerSummaryIds) {
        if ((editVersionsAtStart.get(summaryId) ?? 0) >= deletedAtVersion) {
          deletedServerSummaryIds.delete(summaryId)
        }
      }
      serverHypaV3Data = {
        summaries,
        categories: categoriesSnapshot,
        lastSelectedSummaries: [],
      }
      applyDefaultFilters(`${currentCharacter?.chaId ?? ''}:${chatId}`, summaries)
      if (serverSummaryLoadedChatId !== chatId) {
        serverSummaryLoadedChatId = chatId
        uiState.collapsedSummaries = new Set(summaries.map((_, index) => index))
      }
      return
    }
    if (signal?.aborted) return
    serverMemoryRefreshError = result.status === 'error' ? result.error : language.errors.networkFetch
  }

  function markServerSummaryEdited(summaryId: string): number {
    dirtyServerSummaryIds.add(summaryId)
    const version = (serverSummaryEditVersions.get(summaryId) ?? 0) + 1
    serverSummaryEditVersions.set(summaryId, version)
    return version
  }

  function captureServerSummaryMutationOwner(): ServerSummaryMutationOwner | null {
    return currentChatId ? { chatId: currentChatId, epoch: serverSummaryOwnerEpoch } : null
  }

  function isCurrentServerSummaryMutationOwner(owner: ServerSummaryMutationOwner): boolean {
    return owner.epoch === serverSummaryOwnerEpoch && owner.chatId === currentChatId
  }

  function acknowledgeServerSummaryEdit(summaryId: string, editVersion: number): void {
    if ((serverSummaryEditVersions.get(summaryId) ?? 0) !== editVersion) return
    // The acknowledgement itself is a version boundary: any list request that
    // started before the PATCH completed must not overwrite this accepted row.
    serverSummaryEditVersions.set(summaryId, editVersion + 1)
    dirtyServerSummaryIds.delete(summaryId)
  }

  function queueServerSummaryMutation(summaryId: string, operation: () => Promise<void>): Promise<void> {
    const previous = serverSummaryMutationQueues.get(summaryId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(operation)
      .catch((error) => {
        serverMemoryMutationError = error instanceof Error ? error.message : String(error)
      })
    serverSummaryMutationQueues.set(summaryId, next)
    void next.then(() => {
      if (serverSummaryMutationQueues.get(summaryId) === next) serverSummaryMutationQueues.delete(summaryId)
      if (
        pendingServerSummaryRefreshChatId &&
        serverSummaryMutationQueues.size === 0 &&
        dirtyServerSummaryIds.size === 0
      ) {
        const chatId = pendingServerSummaryRefreshChatId
        pendingServerSummaryRefreshChatId = null
        if (currentChatId === chatId) {
          void refreshServerSummaries(chatId)
        }
      }
    })
    return next
  }

  function handleServerSummaryChanged(summaryIndex: number, field: ServerSummaryPatchField): Promise<boolean> {
    if (!serverBackedMemoryMode) return Promise.resolve(true)
    const summary = serverHypaV3Data.summaries[summaryIndex] as ServerSummaryView | undefined
    if (!summary) return Promise.resolve(false)
    const summaryId = summary.serverId
    const owner = captureServerSummaryMutationOwner()
    if (!owner) return Promise.resolve(false)
    const mutation = persistServerSummaryChange(summary, summaryId, field, owner)
    const pendingSave = { owner, promise: mutation }
    pendingServerSummarySaves.add(pendingSave)
    void mutation.finally(() => pendingServerSummarySaves.delete(pendingSave))
    if (field === 'text') {
      pendingServerSummaryTextSaves.set(summaryId, mutation)
      void mutation.finally(() => {
        if (pendingServerSummaryTextSaves.get(summaryId) === mutation) {
          pendingServerSummaryTextSaves.delete(summaryId)
        }
      })
    }
    return mutation
  }

  async function persistServerSummaryChange(
    summary: ServerSummaryView,
    summaryId: string,
    field: ServerSummaryPatchField,
    owner: ServerSummaryMutationOwner,
  ): Promise<boolean> {
    const editVersion = markServerSummaryEdited(summaryId)
    if (field === 'text') dirtyServerSummaryTextVersions.set(summaryId, editVersion)
    const patch: PatchServerMemorySummaryInput = buildServerSummaryPatch(summary, field)
    let persisted = false

    await queueServerSummaryMutation(summaryId, async () => {
      const result = await patchServerMemorySummary(summaryId, patch)
      if (!isCurrentServerSummaryMutationOwner(owner)) {
        persisted = result.status === 'ok'
        return
      }
      if (result.status === 'ok') {
        acknowledgeServerSummaryEdit(summaryId, editVersion)
        if (field === 'text' && dirtyServerSummaryTextVersions.get(summaryId) === editVersion) {
          dirtyServerSummaryTextVersions.delete(summaryId)
        }
        serverMemoryMutationError = null
        persisted = true
        return
      }
      if (field !== 'text') acknowledgeServerSummaryEdit(summaryId, editVersion)
      serverMemoryMutationError = result.status === 'error' ? result.error : language.errors.networkFetch
      // A later queued field patch no longer contains this field. Reconcile
      // after the queue drains so a failed earlier patch cannot leave the
      // client ahead of the server, and avoid an intermediate stale read.
      pendingServerSummaryRefreshChatId = currentChatId
    })
    return persisted
  }

  function handleServerSummaryInput(summaryIndex: number): void {
    if (!serverBackedMemoryMode) return
    const summary = serverHypaV3Data.summaries[summaryIndex] as ServerSummaryView | undefined
    if (!summary) return
    const editVersion = markServerSummaryEdited(summary.serverId)
    dirtyServerSummaryTextVersions.set(summary.serverId, editVersion)
  }

  async function deleteServerSummaryAt(summaryIndex: number): Promise<boolean> {
    const summary = serverHypaV3Data.summaries[summaryIndex] as ServerSummaryView | undefined
    if (!summary) return false
    const summaryId = summary.serverId
    let deleted = false
    await queueServerSummaryMutation(summaryId, async () => {
      const result = await deleteServerMemorySummary(summaryId)
      if (result.status !== 'ok') {
        serverMemoryMutationError = result.status === 'error' ? result.error : language.errors.networkFetch
        return
      }
      const liveIndex = serverHypaV3Data.summaries.findIndex(
        (candidate) => (candidate as ServerSummaryView).serverId === summaryId,
      )
      if (liveIndex !== -1) serverHypaV3Data.summaries.splice(liveIndex, 1)
      dirtyServerSummaryIds.delete(summaryId)
      dirtyServerSummaryTextVersions.delete(summaryId)
      pendingServerSummaryTextSaves.delete(summaryId)
      const deleteVersion = (serverSummaryEditVersions.get(summaryId) ?? 0) + 1
      serverSummaryEditVersions.set(summaryId, deleteVersion)
      deletedServerSummaryIds.set(summaryId, deleteVersion)
      serverMemoryMutationError = null
      deleted = true
    })
    if (!deleted) await refreshServerSummaries(currentChatId)
    return deleted
  }

  async function handleServerSummaryDelete(summaryIndex: number): Promise<void> {
    if (!serverBackedMemoryMode) return
    await deleteServerSummaryAt(summaryIndex)
  }

  async function handleServerSummaryDeleteAfter(summaryIndex: number): Promise<void> {
    if (!serverBackedMemoryMode) return
    const ids = serverHypaV3Data.summaries
      .slice(summaryIndex + 1)
      .map((summary) => (summary as ServerSummaryView).serverId)
      .reverse()
    for (const summaryId of ids) {
      const liveIndex = serverHypaV3Data.summaries.findIndex(
        (summary) => (summary as ServerSummaryView).serverId === summaryId,
      )
      if (liveIndex === -1) continue
      if (!(await deleteServerSummaryAt(liveIndex))) break
    }
  }

  async function refreshServerSummariesAfterMutations(chatId: string): Promise<void> {
    while (currentChatId === chatId && serverSummaryMutationQueues.size > 0) {
      await Promise.all([...serverSummaryMutationQueues.values()])
    }
    if (currentChatId !== chatId) return
    if (dirtyServerSummaryIds.size > 0) {
      pendingServerSummaryRefreshChatId = chatId
      return
    }
    await refreshServerSummaries(chatId)
  }

  $effect(() => {
    if (!serverBackedMemoryMode || currentChatId.length === 0) return
    const chatId = currentChatId
    serverSummaryOwnerEpoch += 1
    dirtyServerSummaryIds.clear()
    dirtyServerSummaryTextVersions.clear()
    pendingServerSummaryTextSaves.clear()
    deletedServerSummaryIds.clear()
    serverSummaryEditVersions.clear()
    pendingServerSummaryRefreshChatId = null
    serverSummaryCloseRequest = null
    consecutiveServerSummaryCloseFailures = 0
    serverSummaryLoadedChatId = null
    serverMemoryMutationError = null
    serverMemoryRefreshError = null
    const categoriesSnapshot = untrack(() => cloneLegacyCategories())
    tagManagerState.isOpen = false
    tagManagerState.currentSummaryIndex = -1
    tagManagerState.currentSummaryId = undefined
    tagManagerState.editingTag = ''
    tagManagerState.editingTagIndex = -1
    serverHypaV3Data = {
      summaries: [],
      categories: categoriesSnapshot,
      lastSelectedSummaries: [],
    }
    const controller = new AbortController()
    void refreshServerSummaries(chatId, categoriesSnapshot, controller.signal)
    return () => controller.abort()
  })

  $effect(() => {
    if (!serverBackedMemoryMode || currentChatId.length === 0) return
    const categories = cloneLegacyCategories()
    const current = untrack(() => serverHypaV3Data)
    if (sameCategories(current.categories ?? [], categories)) return
    serverHypaV3Data = { ...current, categories }
  })

  $effect(() => {
    if (!serverBackedMemoryMode) return
    return subscribeServerMemoryJobEvents((event) => {
      if (event.chatId !== currentChatId || event.job.kind !== 'summarize' || event.job.status !== 'completed') return
      void refreshServerSummariesAfterMutations(currentChatId)
    })
  })

  let categories = $derived(
    (() => {
      const savedCategories = hypaV3Data.categories || []
      const uncategorized = { id: '', name: language.hypaV3Modal.unclassified }

      const hasUncategorized = savedCategories.some((c) => c.id === '')

      if (hasUncategorized) {
        return [uncategorized, ...savedCategories.filter((c) => c.id !== '')]
      } else {
        return [uncategorized, ...savedCategories]
      }
    })(),
  )

  let summaryItemStateMap = new WeakMap<SerializableSummary, SummaryItemState>()
  let expandedMessageState = $state<ExpandedMessageState>(null)
  let searchState = $state<SearchState>(null)
  let pendingSearchFocusRestore: {
    timeoutId: number
    searchInput: HTMLInputElement
    textarea: HTMLTextAreaElement
  } | null = null
  let filterSelected = $state(false)
  let bulkResummaryState = $state<BulkResummaryState | null>(null)
  let bulkResummaryOperationToken = 0
  let bulkResummaryOwner: BulkResummaryOwner | null = null

  let categoryManagerState = $state<CategoryManagerState>({
    isOpen: false,
    editingCategory: null,
    selectedCategoryFilter: 'all',
  })

  let tagManagerState = $state<TagManagerState>({
    isOpen: false,
    currentSummaryIndex: -1,
    editingTag: '',
    editingTagIndex: -1,
  })

  let bulkEditState = $state<BulkEditState>({
    isEnabled: false,
    selectedSummaries: new Set(),
    selectedCategory: '',
    bulkSelectInput: '',
  })

  let filterState = $state<FilterState>({
    showImportantOnly: false,
    selectedCategoryFilter: 'all',
    isManualImportantToggle: false,
  })
  let filterStateOwnerKey: string | null = null
  let filterDefaultsApplied = false
  let filterStateManuallyChanged = false

  let uiState = $state<UIState>({
    collapsedSummaries: new Set(),
    dropdownOpen: false,
  })
  let summaryViewOwnerKey: string | null = null

  function prepareFilterStateOwner(ownerKey: string): void {
    if (filterStateOwnerKey === ownerKey) return
    filterStateOwnerKey = ownerKey
    filterDefaultsApplied = false
    filterStateManuallyChanged = false
    filterState.isManualImportantToggle = false
  }

  function markFilterStateManuallyChanged(): void {
    if (!currentCharacter || !currentChat) return
    prepareFilterStateOwner(`${currentCharacter.chaId}:${currentChat.id ?? currentCharacter.chatPage}`)
    filterStateManuallyChanged = true
    filterState.isManualImportantToggle = true
  }

  function applyDefaultFilters(ownerKey: string, summaries: readonly SerializableSummary[]): void {
    prepareFilterStateOwner(ownerKey)
    if (filterDefaultsApplied) return
    filterDefaultsApplied = true
    if (filterStateManuallyChanged) return

    const hasImportantSummary = summaries.some((summary) => summary.isImportant)
    const categoryFilter = hasImportantSummary ? 'all' : ''
    categoryManagerState.selectedCategoryFilter = categoryFilter
    filterState.selectedCategoryFilter = categoryFilter
    filterState.showImportantOnly = hasImportantSummary
    filterState.isManualImportantToggle = false
  }

  function cancelPendingSearchFocusRestore(): void {
    if (!pendingSearchFocusRestore) return
    window.clearTimeout(pendingSearchFocusRestore.timeoutId)
    pendingSearchFocusRestore.textarea.readOnly = false
    pendingSearchFocusRestore = null
  }

  onDestroy(cancelPendingSearchFocusRestore)

  function captureBulkResummaryOwner(): BulkResummaryOwner | null {
    if (!currentCharacter || !currentChat) return null
    return {
      character: currentCharacter,
      characterId: currentCharacter.chaId,
      chat: currentChat,
      chatId: currentChat.id,
      data: hypaV3Data,
    }
  }

  function matchesBulkResummaryOwner(
    owner: BulkResummaryOwner,
    character: character | undefined = currentCharacter,
    chat: Chat | undefined = currentChat,
    data: SerializableHypaV3Data = hypaV3Data,
  ): boolean {
    return (
      !!character &&
      !!chat &&
      character === owner.character &&
      character.chaId === owner.characterId &&
      chat === owner.chat &&
      chat.id === owner.chatId &&
      data === owner.data
    )
  }

  function beginBulkResummaryOperation(owner: BulkResummaryOwner): BulkResummaryOperation {
    bulkResummaryOperationToken += 1
    bulkResummaryOwner = owner
    return { token: bulkResummaryOperationToken, owner }
  }

  function beginExistingBulkResummaryOperation(): BulkResummaryOperation | null {
    const owner = bulkResummaryOwner
    if (!owner || !matchesBulkResummaryOwner(owner)) {
      clearBulkResummary(true)
      return null
    }
    return beginBulkResummaryOperation(owner)
  }

  function isCurrentBulkResummaryOperation(operation: BulkResummaryOperation): boolean {
    return (
      operation.token === bulkResummaryOperationToken &&
      operation.owner === bulkResummaryOwner &&
      matchesBulkResummaryOwner(operation.owner)
    )
  }

  function clearBulkResummary(clearSelection: boolean): void {
    bulkResummaryOperationToken += 1
    bulkResummaryOwner = null
    bulkResummaryState = null
    if (clearSelection) bulkEditState.selectedSummaries = new Set()
  }

  $effect(() => {
    const activeCharacter = currentCharacter
    const activeChat = currentChat
    const activeData = hypaV3Data
    if (bulkResummaryOwner && !matchesBulkResummaryOwner(bulkResummaryOwner, activeCharacter, activeChat, activeData)) {
      clearBulkResummary(true)
    }
  })

  $effect.pre(() => {
    const modalOpen = $hypaV3ModalOpen
    const character = currentCharacter
    const chat = currentChat
    const ownerKey =
      modalOpen && character && chat
        ? `${serverBackedMemoryMode ? 'server' : 'legacy'}:${character.chaId}:${chat.id ?? character.chatPage}`
        : null

    untrack(() => {
      if (!chat) {
        hypaV3ModalOpen.set(false)
        clearBulkResummary(true)
        return
      }
      if (!modalOpen) {
        summaryViewOwnerKey = null
        return
      }
      if (!serverBackedMemoryMode && !chat.hypaV3Data) {
        chat.hypaV3Data = createInitialHypaV3Data()
      }
      if (summaryViewOwnerKey === ownerKey) return
      summaryViewOwnerKey = ownerKey
      const filterOwnerKey = `${character.chaId}:${chat.id ?? character.chatPage}`
      prepareFilterStateOwner(filterOwnerKey)

      expandedMessageState = null
      searchState = null
      uiState.collapsedSummaries = new Set(hypaV3Data.summaries.map((_, index) => index))
      if (!serverBackedMemoryMode) applyDefaultFilters(filterOwnerKey, hypaV3Data.summaries)
    })
  })

  function handleToggleSummarySelection(summaryIndex: number) {
    const newSelection = new Set(bulkEditState.selectedSummaries)
    if (newSelection.has(summaryIndex)) {
      newSelection.delete(summaryIndex)
    } else {
      newSelection.add(summaryIndex)
    }
    bulkEditState.selectedSummaries = newSelection
  }

  function handleOpenTagManager(summaryIndex: number) {
    tagManagerState.currentSummaryIndex = summaryIndex
    tagManagerState.currentSummaryId = (hypaV3Data.summaries[summaryIndex] as ServerSummaryView | undefined)?.serverId
    tagManagerState.isOpen = true
  }

  async function flushDirtyServerSummaryText(owner: ServerSummaryMutationOwner): Promise<boolean> {
    while (isCurrentServerSummaryMutationOwner(owner) && dirtyServerSummaryTextVersions.size > 0) {
      const dirtySnapshot = [...dirtyServerSummaryTextVersions.entries()]
      for (const [summaryId, dirtyVersion] of dirtySnapshot) {
        if (!isCurrentServerSummaryMutationOwner(owner)) return false
        if (dirtyServerSummaryTextVersions.get(summaryId) !== dirtyVersion) continue
        const pendingSave = pendingServerSummaryTextSaves.get(summaryId)
        if (pendingSave) {
          if (!(await pendingSave)) return false
          if (!isCurrentServerSummaryMutationOwner(owner)) return false
          continue
        }
        const summaryIndex = serverHypaV3Data.summaries.findIndex(
          (summary) => (summary as ServerSummaryView).serverId === summaryId,
        )
        if (summaryIndex === -1) {
          dirtyServerSummaryTextVersions.delete(summaryId)
          continue
        }
        if (!(await handleServerSummaryChanged(summaryIndex, 'text'))) return false
        if (!isCurrentServerSummaryMutationOwner(owner)) return false
      }
    }
    return isCurrentServerSummaryMutationOwner(owner)
  }

  async function flushPendingServerSummaryChanges(owner: ServerSummaryMutationOwner): Promise<boolean> {
    if (!(await flushDirtyServerSummaryText(owner))) return false
    while ([...pendingServerSummarySaves].some((save) => isCurrentServerSummaryMutationOwner(save.owner))) {
      const results = await Promise.all(
        [...pendingServerSummarySaves]
          .filter((save) => save.owner.epoch === owner.epoch && save.owner.chatId === owner.chatId)
          .map((save) => save.promise),
      )
      if (results.some((persisted) => !persisted)) return false
      if (!isCurrentServerSummaryMutationOwner(owner)) return false
      if (!(await flushDirtyServerSummaryText(owner))) return false
    }
    return true
  }

  function discardDirtyServerSummaryText(
    owner: ServerSummaryMutationOwner,
    dirtySnapshot: ReadonlyMap<string, number>,
  ): boolean {
    if (!isCurrentServerSummaryMutationOwner(owner)) return false
    for (const [summaryId, dirtyVersion] of dirtySnapshot) {
      if (dirtyServerSummaryTextVersions.get(summaryId) !== dirtyVersion) continue
      dirtyServerSummaryTextVersions.delete(summaryId)
      if (serverSummaryEditVersions.get(summaryId) === dirtyVersion) dirtyServerSummaryIds.delete(summaryId)
    }
    return dirtyServerSummaryTextVersions.size === 0
  }

  function requestModalClose(): boolean | Promise<boolean> {
    if (!serverBackedMemoryMode) {
      $hypaV3ModalOpen = false
      return true
    }
    if (serverSummaryCloseRequest) return serverSummaryCloseRequest

    const owner = captureServerSummaryMutationOwner()
    if (!owner) return false
    const hasPendingSave = [...pendingServerSummarySaves].some((save) =>
      isCurrentServerSummaryMutationOwner(save.owner),
    )
    if (dirtyServerSummaryTextVersions.size === 0 && !hasPendingSave) {
      consecutiveServerSummaryCloseFailures = 0
      $hypaV3ModalOpen = false
      return true
    }

    let closeRequest: Promise<boolean>
    closeRequest = (async () => {
      const persisted = await flushPendingServerSummaryChanges(owner)
      if (!isCurrentServerSummaryMutationOwner(owner)) return false
      if (persisted) {
        consecutiveServerSummaryCloseFailures = 0
        $hypaV3ModalOpen = false
        return true
      }

      consecutiveServerSummaryCloseFailures += 1
      if (consecutiveServerSummaryCloseFailures < 2) return false

      const dirtySnapshot = new Map(dirtyServerSummaryTextVersions)
      if (dirtySnapshot.size === 0) return false
      const discardChanges = await alertConfirm(language.hypaV3Modal.discardFailedSummaryChangesConfirm)
      if (!discardChanges || !isCurrentServerSummaryMutationOwner(owner)) return false
      if (!discardDirtyServerSummaryText(owner, dirtySnapshot)) return false

      consecutiveServerSummaryCloseFailures = 0
      $hypaV3ModalOpen = false
      return true
    })().finally(() => {
      if (serverSummaryCloseRequest === closeRequest) serverSummaryCloseRequest = null
    })
    serverSummaryCloseRequest = closeRequest
    return closeRequest
  }

  function handleModalKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    void requestModalClose()
  }

  // Search functionality
  function onSearch(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      if (!searchState || !searchState.query.trim()) return

      // Perform search
      performSearch(searchState.query, e.shiftKey)
    }
  }

  function performSearch(query: string, backward: boolean = false) {
    if (!searchState) return

    // Reset results if query changed
    if (searchState.results.length === 0) {
      searchState.results = findAllMatches(query)
      searchState.currentResultIndex = -1
    }

    // Navigate to next/previous result
    const result = getNextSearchResult(backward)
    if (result) {
      void navigateToSearchResult(result)
    }
  }

  function findAllMatches(query: string): SearchResult[] {
    const results: SearchResult[] = []
    const lowerQuery = query.toLowerCase()

    hypaV3Data.summaries.forEach((summary, summaryIndex) => {
      // Search in summary text
      const summaryText = summary.text.toLowerCase()
      let index = 0
      while ((index = summaryText.indexOf(lowerQuery, index)) !== -1) {
        results.push({
          type: 'summary',
          summaryIndex,
          start: index,
          end: index + query.length,
        })
        index += query.length
      }

      // Search in chat memos (if they're GUIDs)
      if (isGuidLike(query)) {
        summary.chatMemos.forEach((chatMemo, memoIndex) => {
          if (chatMemo && chatMemo.toLowerCase().includes(lowerQuery)) {
            results.push({
              type: 'chatmemo',
              summaryIndex,
              memoIndex,
            })
          }
        })
      }
    })

    return results
  }

  async function resummarizeBulkSelected() {
    if (bulkEditState.selectedSummaries.size < 2) return

    const sortedIndices = Array.from(bulkEditState.selectedSummaries).sort((a, b) => a - b)
    const owner = captureBulkResummaryOwner()
    if (!owner) return
    const operation = beginBulkResummaryOperation(owner)

    try {
      bulkResummaryState = {
        isProcessing: true,
        result: null,
        selectedIndices: sortedIndices,
        mergedChatMemos: [],
        isTranslating: false,
        translation: null,
      }

      const selectedSummaries = sortedIndices.map((index) => owner.data.summaries[index])
      const selectedSummaryTexts = selectedSummaries.map((summary) => summary.text)

      const oaiMessages: OpenAIChat[] = selectedSummaryTexts.map((text) => ({
        role: 'user',
        content: text,
      }))

      const mergedChatMemos: string[] = []
      for (const summary of selectedSummaries) {
        mergedChatMemos.push(...summary.chatMemos)
      }

      const uniqueChatMemos = [...new Set(mergedChatMemos)]

      const resummary = await summarize(oaiMessages, true)
      if (!isCurrentBulkResummaryOperation(operation)) return

      bulkResummaryState = {
        isProcessing: false,
        result: resummary,
        selectedIndices: sortedIndices,
        mergedChatMemos: uniqueChatMemos,
        isTranslating: false,
        translation: null,
      }
    } catch (error) {
      if (!isCurrentBulkResummaryOperation(operation)) return
      console.error('Re-summarize Failed:', error)
      clearBulkResummary(false)
      await alertNormalWait(`Re-summarize Failed: ${error.message || error}`)
    }
  }

  async function applyBulkResummary() {
    if (serverBackedMemoryMode) return
    if (!bulkResummaryState || !bulkResummaryState.result) return

    const resultState = bulkResummaryState
    const owner = bulkResummaryOwner
    if (!owner || !matchesBulkResummaryOwner(owner)) {
      clearBulkResummary(true)
      return
    }

    const sortedIndices = resultState.selectedIndices
    const minIndex = sortedIndices[0]
    if (minIndex === undefined || sortedIndices.some((index) => !owner.data.summaries[index])) {
      clearBulkResummary(true)
      return
    }
    const firstSummary = owner.data.summaries[minIndex]

    owner.data.summaries[minIndex] = {
      text: resultState.result,
      chatMemos: resultState.mergedChatMemos,
      isImportant: firstSummary.isImportant,
      categoryId: firstSummary.categoryId,
      tags: firstSummary.tags,
    }

    for (let i = sortedIndices.length - 1; i > 0; i--) {
      owner.data.summaries.splice(sortedIndices[i], 1)
    }

    uiState.collapsedSummaries = new Set(owner.data.summaries.map((_, index) => index))

    clearBulkResummary(true)
  }

  async function rerollBulkResummary() {
    if (!bulkResummaryState) return

    const priorState = bulkResummaryState
    const operation = beginExistingBulkResummaryOperation()
    if (!operation) return
    const sortedIndices = priorState.selectedIndices

    try {
      bulkResummaryState = {
        ...priorState,
        isProcessing: true,
        result: null,
        isTranslating: false,
        translation: null,
      }

      const selectedSummaryTexts = sortedIndices.map((index) => operation.owner.data.summaries[index].text)

      const oaiMessages: OpenAIChat[] = selectedSummaryTexts.map((text) => ({
        role: 'user',
        content: text,
      }))

      const resummary = await summarize(oaiMessages, true)
      if (!isCurrentBulkResummaryOperation(operation)) return

      bulkResummaryState = {
        ...priorState,
        isProcessing: false,
        result: resummary,
        isTranslating: false,
        translation: null,
      }
    } catch (error) {
      if (!isCurrentBulkResummaryOperation(operation)) return
      console.error('Re-summarize Retry Failed:', error)
      clearBulkResummary(false)
      await alertNormalWait(`Re-summarize Retry Failed: ${error.message || error}`)
    }
  }

  function cancelBulkResummary() {
    clearBulkResummary(true)
  }

  async function toggleBulkResummaryTranslation(regenerate: boolean = false) {
    if (!bulkResummaryState || !bulkResummaryState.result) return
    const owner = bulkResummaryOwner
    if (!owner || !matchesBulkResummaryOwner(owner)) {
      clearBulkResummary(true)
      return
    }

    if (bulkResummaryState.isTranslating) return

    if (bulkResummaryState.translation) {
      bulkResummaryState.translation = null
      return
    }

    const operation = beginBulkResummaryOperation(owner)
    const translationState = bulkResummaryState
    if (!translationState || !translationState.result) return

    translationState.isTranslating = true
    translationState.translation = 'Loading...'

    try {
      const result = await translateHTML(translationState.result, false, '', -1, regenerate)
      if (!isCurrentBulkResummaryOperation(operation) || bulkResummaryState !== translationState) return

      translationState.translation = result
    } catch (error) {
      if (!isCurrentBulkResummaryOperation(operation) || bulkResummaryState !== translationState) return
      translationState.translation = `Translation failed: ${error}`
    } finally {
      if (isCurrentBulkResummaryOperation(operation) && bulkResummaryState === translationState) {
        translationState.isTranslating = false
      }
    }
  }

  async function handleResetData() {
    if (serverBackedMemoryMode) return
    if (!currentCharacter || !currentChat) {
      hypaV3ModalOpen.set(false)
      return
    }
    const resetOwner = {
      character: currentCharacter,
      characterId: currentCharacter.chaId,
      chat: currentChat,
      chatId: currentChat.id,
    }
    const confirmed = await alertConfirmTwice(
      language.hypaV3Modal.resetConfirmMessage,
      language.hypaV3Modal.resetConfirmSecondMessage,
    )
    if (!confirmed) return
    if (
      !currentCharacter ||
      !currentChat ||
      currentCharacter !== resetOwner.character ||
      currentCharacter.chaId !== resetOwner.characterId ||
      currentChat !== resetOwner.chat ||
      currentChat.id !== resetOwner.chatId
    ) {
      return
    }
    resetOwner.chat.hypaV3Data = { summaries: [] }
  }

  function handleToggleBulkEditMode() {
    bulkEditState.isEnabled = !bulkEditState.isEnabled
    if (!bulkEditState.isEnabled) {
      bulkEditState.selectedSummaries = new Set()
    }
  }

  function handleBulkEditClearSelection() {
    bulkEditState.selectedSummaries = new Set()
  }

  function handleBulkEditUpdateSelectedCategory(categoryId: string) {
    bulkEditState.selectedCategory = categoryId
  }

  function handleBulkEditUpdateBulkSelectInput(input: string) {
    bulkEditState.bulkSelectInput = input
  }

  function handleBulkEditApplyCategory() {
    if (serverBackedMemoryMode) return
    if (bulkEditState.selectedSummaries.size === 0) return

    for (const summaryIndex of bulkEditState.selectedSummaries) {
      hypaV3Data.summaries[summaryIndex].categoryId = bulkEditState.selectedCategory || undefined
    }

    handleBulkEditClearSelection()
  }

  function handleBulkEditToggleImportant() {
    if (serverBackedMemoryMode) return
    if (bulkEditState.selectedSummaries.size === 0) return
    const selectedIndices = Array.from(bulkEditState.selectedSummaries)
    const hasNonImportant = selectedIndices.some((index) => !hypaV3Data.summaries[index].isImportant)

    selectedIndices.forEach((index) => {
      const summary = hypaV3Data.summaries[index]
      hasNonImportant ? (summary.isImportant = true) : (summary.isImportant = false)
    })
    handleBulkEditClearSelection()
  }

  function handleBulkEditParseAndSelectSummaries() {
    if (!bulkEditState.bulkSelectInput.trim()) return

    const newSelection = parseSelectionInput(bulkEditState.bulkSelectInput, hypaV3Data.summaries.length)
    const filteredSelection = new Set<number>()

    for (const index of newSelection) {
      if (
        shouldShowSummary(
          hypaV3Data.summaries[index],
          index,
          filterState.showImportantOnly,
          filterState.selectedCategoryFilter,
        )
      ) {
        filteredSelection.add(index)
      }
    }

    bulkEditState.selectedSummaries = filteredSelection
    bulkEditState.bulkSelectInput = ''
  }

  function handleOpenCategoryManager() {
    categoryManagerState.isOpen = true
  }

  function handleCategoryFilter(categoryId: string) {
    markFilterStateManuallyChanged()
    filterState.selectedCategoryFilter = categoryId
  }

  function handleToggleCollapse(summaryIndex: number) {
    const newCollapsed = new Set(uiState.collapsedSummaries)
    if (newCollapsed.has(summaryIndex)) {
      newCollapsed.delete(summaryIndex)
    } else {
      newCollapsed.add(summaryIndex)
    }
    uiState.collapsedSummaries = newCollapsed
  }

  function getNextSearchResult(backward: boolean): SearchResult | null {
    if (!searchState || searchState.results.length === 0) return null

    let nextIndex: number

    if (searchState.requestedSearchFromIndex !== -1) {
      const fromSummaryIndex = searchState.requestedSearchFromIndex

      nextIndex = backward
        ? searchState.results.findLastIndex((r) => r.summaryIndex <= fromSummaryIndex)
        : searchState.results.findIndex((r) => r.summaryIndex >= fromSummaryIndex)

      if (nextIndex === -1) {
        nextIndex = backward ? searchState.results.length - 1 : 0
      }

      searchState.requestedSearchFromIndex = -1
    } else {
      const delta = backward ? -1 : 1

      nextIndex = (searchState.currentResultIndex + delta + searchState.results.length) % searchState.results.length
    }

    searchState.currentResultIndex = nextIndex
    return searchState.results[nextIndex]
  }

  async function navigateToSearchResult(result: SearchResult) {
    searchState.isNavigating = true

    if (result.type === 'summary') {
      const summary = hypaV3Data.summaries[result.summaryIndex]
      const summaryItemState = summaryItemStateMap.get(summary)
      const textarea = summaryItemState?.originalRef
      if (!textarea) {
        searchState.isNavigating = false
        return
      }

      // Scroll to element
      textarea.scrollIntoView({
        behavior: 'instant',
        block: 'center',
      })

      if (result.start === result.end) {
        searchState.isNavigating = false
        return
      }

      // Scroll to query
      textarea.setSelectionRange(result.start, result.end)
      scrollToSelection(textarea)

      // Mouse/keyboard users can focus the match without opening a touch keyboard.
      if (!('ontouchend' in window)) {
        cancelPendingSearchFocusRestore()
        const searchInput = searchState.ref

        // Make readonly temporarily
        textarea.readOnly = true
        textarea.focus()
        const focusRestore = {
          timeoutId: 0,
          searchInput,
          textarea,
        }
        focusRestore.timeoutId = window.setTimeout(() => {
          if (pendingSearchFocusRestore !== focusRestore) return
          pendingSearchFocusRestore = null
          textarea.readOnly = false // Remove readonly after focus moved
          if (searchState?.ref === searchInput && searchInput.isConnected) {
            searchInput.focus() // Restore focus to the active search bar
          }
        }, 300)
        pendingSearchFocusRestore = focusRestore
      }
    } else {
      const summary = hypaV3Data.summaries[result.summaryIndex]
      if (uiState.collapsedSummaries.has(result.summaryIndex)) {
        const expanded = new Set(uiState.collapsedSummaries)
        expanded.delete(result.summaryIndex)
        uiState.collapsedSummaries = expanded
        await tick()
      }
      const summaryItemState = summaryItemStateMap.get(summary)
      const button = summaryItemState?.chatMemoRefs[result.memoIndex]
      if (!button) {
        searchState.isNavigating = false
        return
      }

      // Scroll to element
      button.scrollIntoView({
        behavior: 'instant',
        block: 'center',
      })

      // Highlight chatMemo
      button.classList.add('ring-2', 'ring-zinc-500')

      // Remove highlight after a short delay
      window.setTimeout(() => {
        button.classList.remove('ring-2', 'ring-zinc-500')
      }, 1000)
    }

    searchState.isNavigating = false
  }

  function scrollToSelection(textarea: HTMLTextAreaElement) {
    const { selectionStart, selectionEnd } = textarea

    if (selectionStart === null || selectionEnd === null || selectionStart === selectionEnd) {
      return // Exit if there is no selected text
    }

    // Calculate the text before the selected position based on the textarea's text
    const textBeforeSelection = textarea.value.substring(0, selectionStart)

    // Use a temporary DOM element to calculate the exact position of the selected text
    const tempDiv = document.createElement('div')
    tempDiv.style.position = 'absolute'
    tempDiv.style.whiteSpace = 'pre-wrap'
    tempDiv.style.overflowWrap = 'break-word'
    tempDiv.style.font = window.getComputedStyle(textarea).font
    tempDiv.style.width = `${textarea.offsetWidth}px`
    tempDiv.style.visibility = 'hidden' // Set it to be invisible

    tempDiv.textContent = textBeforeSelection
    document.body.appendChild(tempDiv)

    // Calculate the position of the selected text within the textarea
    const selectionTop = tempDiv.offsetHeight
    document.body.removeChild(tempDiv)

    // Adjust the scroll so that the selected text is centered on the screen
    textarea.scrollTop = selectionTop - textarea.clientHeight / 2
  }

  function isSummaryVisible(index: number): boolean {
    const summary = hypaV3Data.summaries[index]

    return (
      shouldShowSummary(summary, index, filterState.showImportantOnly, filterState.selectedCategoryFilter) &&
      (!filterSelected ||
        !hypaV3Data.metrics ||
        hypaV3Data.metrics.lastImportantSummaries.includes(index) ||
        hypaV3Data.metrics.lastRecentSummaries.includes(index) ||
        hypaV3Data.metrics.lastSimilarSummaries.includes(index) ||
        hypaV3Data.metrics.lastRandomSummaries.includes(index))
    )
  }

  type DualActionParams = {
    onMainAction?: () => void
    onAlternativeAction?: () => void
  }

  onDestroy(
    registerWriterDraftCapture(() => {
      const summaries = (serverHypaV3Data.summaries as ServerSummaryView[]).filter(
        (summary) =>
          dirtyServerSummaryIds.has(summary.serverId) || dirtyServerSummaryTextVersions.has(summary.serverId),
      )
      const bulkResult = bulkResummaryState?.result && !bulkResummaryState.isProcessing ? bulkResummaryState : null
      const recoveryChatId = serverSummaryLoadedChatId ?? bulkResummaryOwner?.chatId ?? currentChatId
      if (!recoveryChatId || (summaries.length === 0 && !bulkResult)) return null
      return $state.snapshot({
        key: `memory-summaries:${recoveryChatId}`,
        label: language.formating.memory,
        fields: [
          ...summaries.map((summary) => ({ label: summary.serverId, value: JSON.stringify(summary, null, 2) })),
          ...(bulkResult?.result ? [{ label: language.hypaV3Modal.reSummarizeResult, value: bulkResult.result }] : []),
        ],
        data: { chatId: recoveryChatId, summaries, bulkResult },
        baseline: summaries.map((summary) => recoverySummaryBaselines.get(summary.serverId) ?? null),
      })
    }),
  )
</script>

<!-- Modal Backdrop -->
<div data-modal-root class="fixed inset-0 z-40 p-1 sm:p-2 bg-black/50">
  <!-- Modal Wrapper -->
  <div class="flex justify-center w-full h-full">
    <!-- Modal Window -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      use:modalFocusTrap
      role="dialog"
      aria-modal="true"
      aria-label={language.hypaV3Modal.titleLabel}
      tabindex="-1"
      class="flex flex-col w-full max-w-3xl p-3 rounded-lg sm:p-6 bg-zinc-900 {hypaV3Data.summaries.length === 0
        ? 'h-fit'
        : 'h-full'}"
      onkeydown={handleModalKeydown}
      onclick={(e) => {
        e.stopPropagation()
        uiState.dropdownOpen = false
      }}>
      <!-- Header -->
      <ModalHeader
        bind:searchState
        bind:filterImportant={filterState.showImportantOnly}
        bind:dropdownOpen={uiState.dropdownOpen}
        bind:filterSelected
        {bulkEditState}
        {categoryManagerState}
        {filterState}
        {uiState}
        {hypaV3Data}
        readOnly={serverBackedMemoryMode}
        onResetData={handleResetData}
        onImportantFilterChanged={markFilterStateManuallyChanged}
        onToggleBulkEditMode={handleToggleBulkEditMode}
        onOpenCategoryManager={handleOpenCategoryManager}
        onRequestClose={requestModalClose} />

      <!-- Scrollable Container -->
      <div class="flex flex-col gap-2 overflow-y-auto sm:gap-4" tabindex="-1">
        {#if serverBackedMemoryMode}
          <ServerMemoryJobs chatId={currentChatId} />
        {/if}

        {#if serverBackedMemoryMode && serverMemoryLoading && hypaV3Data.summaries.length === 0}
          <div class="p-4 text-center sm:p-3 md:p-4 text-zinc-400">
            {language.loading}
          </div>
        {:else if serverBackedMemoryMode && serverMemoryError}
          <div class="p-4 text-center sm:p-3 md:p-4 text-rose-300">
            {serverMemoryError}
          </div>
        {:else if hypaV3Data.summaries.length === 0}
          <div class="p-4 text-center sm:p-3 md:p-4 text-zinc-400">
            {language.hypaV3Modal.noSummariesLabel}
          </div>

          <!-- Search Bar -->
        {:else if searchState}
          <div class="sticky top-0 p-2 sm:p-3 bg-zinc-800">
            <div class="flex items-center gap-2">
              <div class="relative flex items-center flex-1">
                <form
                  class="w-full"
                  onsubmit={(e) => {
                    e.preventDefault()
                    onSearch({ key: 'Enter' } as KeyboardEvent)
                  }}>
                  <input
                    class="w-full px-2 py-2 border rounded-sm sm:px-4 sm:py-3 border-zinc-700 focus:outline-hidden focus:ring-2 focus:ring-zinc-500 text-zinc-200 bg-zinc-900"
                    aria-label={language.hypaV3Modal.searchAction}
                    placeholder={language.hypaV3Modal.searchPlaceholder}
                    bind:this={searchState.ref}
                    bind:value={searchState.query}
                    oninput={() => {
                      if (searchState) {
                        searchState.results = []
                        searchState.currentResultIndex = -1
                      }
                    }}
                    onkeydown={(e) => {
                      if (e.key === 'Enter') e.preventDefault()
                      onSearch(e)
                    }} />
                </form>

                {#if searchState.results.length > 0}
                  <span
                    class="absolute right-3 top-1/2 -translate-y-1/2 px-1.5 sm:px-3 py-1 sm:py-2 rounded-sm text-sm font-semibold text-zinc-100 bg-zinc-700/65">
                    {searchState.currentResultIndex + 1}/{searchState.results.length}
                  </span>
                {/if}
              </div>

              <!-- Previous Button -->
              <button
                class="p-2 transition-colors text-zinc-400 hover:text-zinc-200"
                aria-label={language.hypaV3Modal.previousSearchResultAction}
                title={language.hypaV3Modal.previousSearchResultAction}
                onclick={() => {
                  onSearch({ shiftKey: true, key: 'Enter' } as KeyboardEvent)
                }}>
                <ChevronUpIcon class="w-6 h-6" />
              </button>

              <!-- Next Button -->
              <button
                class="p-2 transition-colors text-zinc-400 hover:text-zinc-200"
                aria-label={language.hypaV3Modal.nextSearchResultAction}
                title={language.hypaV3Modal.nextSearchResultAction}
                onclick={() => {
                  onSearch({ key: 'Enter' } as KeyboardEvent)
                }}>
                <ChevronDownIcon class="w-6 h-6" />
              </button>
            </div>
          </div>
        {/if}

        <!-- Summaries List -->
        {#each hypaV3Data.summaries as summary, i (summary)}
          {#if isSummaryVisible(i)}
            <!-- Summary Item  -->
            <ModalSummaryItem
              summaryIndex={i}
              {hypaV3Data}
              {summaryItemStateMap}
              bind:expandedMessageState
              bind:searchState
              {filterSelected}
              {categories}
              {bulkEditState}
              {uiState}
              readOnly={false}
              tagsReadOnly={false}
              inactiveModel={serverBackedMemoryMode &&
              !activeServerSummaryIds.has((summary as ServerSummaryView).serverId)
                ? (summary as ServerSummaryView).model
                : undefined}
              onToggleSummarySelection={handleToggleSummarySelection}
              onOpenTagManager={handleOpenTagManager}
              onToggleCollapse={handleToggleCollapse}
              onSummaryInput={serverBackedMemoryMode ? handleServerSummaryInput : undefined}
              onSummaryChanged={serverBackedMemoryMode ? handleServerSummaryChanged : undefined}
              onDeleteSummary={serverBackedMemoryMode ? handleServerSummaryDelete : undefined}
              onDeleteAfter={serverBackedMemoryMode ? handleServerSummaryDeleteAfter : undefined} />
          {/if}
        {/each}

        <!-- Footer -->
        <ModalFooter hypaV3Data={footerHypaV3Data} />
      </div>

      <!-- Bulk Resummary Result -->
      {#if !serverBackedMemoryMode}
        <BulkResummaryResult
          {bulkResummaryState}
          onToggleTranslation={toggleBulkResummaryTranslation}
          onReroll={rerollBulkResummary}
          onApply={applyBulkResummary}
          onCancel={cancelBulkResummary} />
      {/if}

      <!-- Bulk Edit Actions -->
      {#if !serverBackedMemoryMode}
        <BulkEditActions
          {bulkEditState}
          {categories}
          showImportantOnly={filterState.showImportantOnly}
          selectedCategoryFilter={filterState.selectedCategoryFilter}
          onResummarize={resummarizeBulkSelected}
          onClearSelection={handleBulkEditClearSelection}
          onUpdateSelectedCategory={handleBulkEditUpdateSelectedCategory}
          onUpdateBulkSelectInput={handleBulkEditUpdateBulkSelectInput}
          onApplyCategory={handleBulkEditApplyCategory}
          onToggleImportant={handleBulkEditToggleImportant}
          onParseAndSelectSummaries={handleBulkEditParseAndSelectSummaries} />
      {/if}
    </div>
  </div>
</div>

<!-- Component Modals -->
{#if !serverBackedMemoryMode}
  <CategoryManagerModal
    bind:categoryManagerState
    bind:searchState
    {hypaV3Data}
    {filterState}
    onCategoryFilter={handleCategoryFilter} />
{/if}

<TagManagerModal
  bind:tagManagerState
  {hypaV3Data}
  onSummaryChanged={serverBackedMemoryMode ? handleServerSummaryChanged : undefined} />
