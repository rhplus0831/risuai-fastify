<script lang="ts">
  import ChatSelectionButton from './ChatSelectionButton.svelte'
  import {
    canUseClientWriteAccess,
    captureClientSessionGeneration,
    clientSessionStore,
    isClientSessionGenerationCurrent,
  } from 'src/ts/clientSession'
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import { onDestroy, tick, untrack } from 'svelte'
  import { get } from 'svelte/store'
  import { v4 } from 'uuid'
  import Sortable from 'sortablejs/modular/sortable.core.esm.js'
  import {
    DownloadIcon,
    PencilIcon,
    HardDriveUploadIcon,
    MenuIcon,
    TrashIcon,
    SplitIcon,
    FolderPlusIcon,
    BookmarkCheckIcon,
    ArrowLeftIcon,
    ChevronDownIcon,
    ChevronRightIcon,
  } from '@lucide/svelte'

  import type { Chat, ChatFolder, character } from 'src/ts/storage/database.svelte'
  import {
    applyChatFolderMetadataOwnerPatch,
    applyChatMetadataOwnerPatch,
    charactersResourceState,
    getCharacterResourceOwner,
    restoreChatFolderMetadataOwnerSnapshot,
    restoreChatMetadataOwnerSnapshot,
  } from 'src/ts/server/resourceState.svelte'
  import { reloadGuiDisplay } from 'src/ts/stores.svelte'
  import { selectedCharID } from 'src/ts/stores.svelte'

  import CheckInput from '../UI/GUI/CheckInput.svelte'
  import Button from '../UI/GUI/Button.svelte'
  import PopupButton from '../UI/PopupButton.svelte'
  import TextInput from '../UI/GUI/TextInput.svelte'

  import { alertChatOptions, alertConfirm, alertError, alertNormal, alertSelect, alertStore } from 'src/ts/alert'
  import { sleep, sortableOptions } from 'src/ts/util'
  import { bookmarkListOpen } from 'src/ts/stores.svelte'
  import { language } from 'src/lang'
  import LazyComponent from '../UI/LazyComponent.svelte'
  import AuthorNoteEditor from './AuthorNoteEditor.svelte'
  import { changeChatTo, createChatCopyName } from 'src/ts/globalApi.svelte'
  import { ensureAllChatsHydrated, hydrateChatMessages } from 'src/ts/server/chatMessageHydration.svelte'
  import {
    applyOptimisticCreatedChat,
    applyOptimisticCreatedChatFolder,
    applyOptimisticDeletedChat,
    applyOptimisticResetChats,
    captureChatCreateSnapshot,
    captureChatDeleteSnapshot,
    captureChatFolderCreateSnapshot,
    captureChatFolderDeleteSnapshot,
    captureChatForkSnapshot,
    captureChatOrderSnapshot,
    captureChatResetSnapshot,
    captureChatMetadataPatch,
    captureChatFolderMetadataPatch,
    currentChatSelectionSnapshot,
    dispatchCreateChatFolderWithOutcome,
    dispatchCreateChatWithOutcome,
    dispatchDeleteChatFolderWithOutcome,
    dispatchDeleteChatWithOutcome,
    dispatchForkChatWithOutcome,
    dispatchReorderChatFoldersAndChatsByIdsWithOutcome,
    dispatchReorderChatsByIdsWithOutcome,
    dispatchResetChatsWithOutcome,
    dispatchSaveChatGenerationSettingsWithOutcome,
    dispatchSelectChat,
    dispatchChatFolderMetadataPatchWithOutcome,
    dispatchChatMetadataPatchWithOutcome,
    restoreChatFolderRowMetadata,
    restoreChatRowMetadata,
    type ChatFolderRowMetadataSnapshot,
    type ChatMutationOutcome,
    type ChatRowMetadataSnapshot,
  } from 'src/ts/chatCommands'
  import { reportWriterAccessLostMutation } from 'src/ts/server/activeWriterSession'
  import { canUseServerCommands } from 'src/ts/server/commands'
  import { groupChatsByFolderId } from './chatFolderGrouping'
  import { characterRoutePath, currentRoute, navigate } from 'src/ts/router'
  import { rekeyClonedChat } from 'src/ts/chatFork'
  import { generationJobLifecycles } from 'src/ts/process/reattach'
  import { collectExhaustedGenerationChatIds } from './sidebarMultitasking'
  import GenerationIndicator from './GenerationIndicator.svelte'
  import UnreadIndicator from './UnreadIndicator.svelte'
  import { markChatRead, unreadChatIds } from 'src/ts/process/chatUnread.svelte'
  import {
    createActiveChatPersonaSelectionPatch,
    resolveActiveChatGenerationSettings,
  } from 'src/ts/activeChatGenerationSettings'
  import { resolveChatBoundPersonaId } from 'src/ts/personaModuleLinks'
  import { selectedPersonaId } from 'src/ts/persona'
  import { exportAllChats, exportChat, importChat, matchesAllChatsExportFence } from 'src/ts/characters'

  interface Props {
    chara: character
  }

  const unavailableCharacter = {
    chatFolders: [],
    chatPage: 0,
    chats: [],
  } as unknown as character

  let { chara: aggregateCharacter }: Props = $props()
  let sidebarCharacter = $derived.by(() => {
    if (charactersResourceState.status === 'error') return undefined
    const owner = aggregateCharacter.chaId ? getCharacterResourceOwner(aggregateCharacter.chaId) : undefined
    if (owner || charactersResourceState.status === 'ready') return owner
    return aggregateCharacter
  })
  let chara = $derived(sidebarCharacter ?? unavailableCharacter)
  const writeActionsAllowed = $derived.by(() => {
    void $clientSessionStore
    return canUseClientWriteAccess()
  })
  const loadToggles = async () => {
    const generation = captureClientSessionGeneration()
    if (!canUseClientWriteAccess()) throw new Error(language.connectedReaders.writeAccessRequired)
    const module = await import('./Toggles.svelte')
    if (!canUseClientWriteAccess() || !isClientSessionGenerationCurrent(generation)) {
      throw new Error(language.connectedReaders.writeAccessRequired)
    }
    return module
  }

  function identityCharacterRows(): readonly character[] {
    if (charactersResourceState.status === 'error') return []
    if (charactersResourceState.characters.length > 0) return charactersResourceState.characters
    return charactersResourceState.status === 'idle' || charactersResourceState.status === 'loading'
      ? [aggregateCharacter]
      : []
  }

  function uniqueSidebarChat(chatId: string | undefined): Chat | undefined {
    if (!canUseClientWriteAccess() || !chatId) return undefined
    const ownerCount = identityCharacterRows().reduce(
      (count, character) => count + (character.chats ?? []).filter((candidate) => candidate.id === chatId).length,
      0,
    )
    if (ownerCount !== 1) return undefined
    const matches = (sidebarCharacter?.chats ?? []).filter((candidate) => candidate.id === chatId)
    return matches.length === 1 ? matches[0] : undefined
  }

  function uniqueSidebarFolder(folderId: string | undefined): ChatFolder | undefined {
    if (!canUseClientWriteAccess() || !folderId) return undefined
    const ownerCount = identityCharacterRows().reduce(
      (count, character) =>
        count + (character.chatFolders ?? []).filter((candidate) => candidate.id === folderId).length,
      0,
    )
    if (ownerCount !== 1) return undefined
    const matches = (sidebarCharacter?.chatFolders ?? []).filter((candidate) => candidate.id === folderId)
    return matches.length === 1 ? matches[0] : undefined
  }

  function renderedChatName(chat: Chat): string {
    if (!chat.id) return charactersResourceState.status === 'ready' ? '' : (chat.name ?? '')
    return uniqueSidebarChat(chat.id)?.name ?? ''
  }
  let editMode = $state(false)
  let pendingPersonaBindings = $state<Record<string, boolean>>({})
  type ChatStructureMutationStatus = 'pending' | 'queued' | 'failed'
  type ChatStructureTargetKind = 'chat' | 'folder' | 'order'
  interface ChatStructureMutationState {
    targetKind: ChatStructureTargetKind
    targetId: string
    action: string
    conflictKeys: string[]
    run: number
    status: ChatStructureMutationStatus
  }
  let chatStructureMutations = $state<Record<string, ChatStructureMutationState>>({})
  let nextStructureMutationRun = 0
  let chatNameDrafts = $state<Record<string, string>>({})
  let chatNameBaselines = $state<Record<string, string>>({})
  let folderNameDrafts = $state<Record<string, string>>({})
  let folderNameBaselines = $state<Record<string, string>>({})
  let nameDraftOwner = $state<string | undefined>(undefined)

  let chatsStb: Sortable[] = []
  let folderStb: Sortable = null

  let folderEles: HTMLDivElement = $state()
  let listEle: HTMLDivElement = $state()
  let sorted = $state(0)
  let opened = 0
  let sortableStructureSignature = ''
  let sortableReconcileGeneration = 0
  let branchGraphHydrationRun = 0

  // Preserve source order and each chat's original array index within folder buckets.
  let validChatFolderIds = $derived(new Set((chara.chatFolders ?? []).map((folder) => folder.id)))
  let chatsByFolderId = $derived(groupChatsByFolderId(chara.chats, validChatFolderIds))
  let organizerIdsStable = $derived(hasStableOrganizationIds())
  let reattachWarningChatIds = $derived(collectExhaustedGenerationChatIds($generationJobLifecycles))

  let chatRouteOpen = $derived(
    $currentRoute.kind === 'character' &&
      $currentRoute.chaId === chara?.chaId &&
      typeof $currentRoute.chatId === 'string',
  )

  $effect(() => {
    const previousChatDrafts = untrack(() => chatNameDrafts)
    const previousChatBaselines = untrack(() => chatNameBaselines)
    const previousFolderDrafts = untrack(() => folderNameDrafts)
    const previousFolderBaselines = untrack(() => folderNameBaselines)
    const previousOwner = untrack(() => nameDraftOwner)
    const owner = chara.chaId
    const nextChatDrafts: Record<string, string> = {}
    const nextChatBaselines: Record<string, string> = {}
    const nextFolderDrafts: Record<string, string> = {}
    const nextFolderBaselines: Record<string, string> = {}

    for (const chat of chara.chats ?? []) {
      if (!chat.id) continue
      const baseline = chat.name ?? ''
      const hasPreviousBaseline =
        previousOwner === owner && Object.prototype.hasOwnProperty.call(previousChatBaselines, chat.id)
      const draftIsDirty = hasPreviousBaseline && previousChatDrafts[chat.id] !== previousChatBaselines[chat.id]
      nextChatDrafts[chat.id] = draftIsDirty ? previousChatDrafts[chat.id] : baseline
      nextChatBaselines[chat.id] = baseline
    }
    for (const folder of chara.chatFolders ?? []) {
      if (!folder.id) continue
      const baseline = folder.name ?? ''
      const hasPreviousBaseline =
        previousOwner === owner && Object.prototype.hasOwnProperty.call(previousFolderBaselines, folder.id)
      const draftIsDirty = hasPreviousBaseline && previousFolderDrafts[folder.id] !== previousFolderBaselines[folder.id]
      nextFolderDrafts[folder.id] = draftIsDirty ? previousFolderDrafts[folder.id] : baseline
      nextFolderBaselines[folder.id] = baseline
    }

    chatNameDrafts = nextChatDrafts
    chatNameBaselines = nextChatBaselines
    folderNameDrafts = nextFolderDrafts
    folderNameBaselines = nextFolderBaselines
    nameDraftOwner = owner
  })

  function structureMutationKey(operation: string, targetId: string): string {
    return `${operation}:${targetId}`
  }

  function chatConflictKey(chatId: string): string {
    return `chat:${chatId}`
  }

  function folderConflictKey(folderId: string): string {
    return `folder:${folderId}`
  }

  function chatOrderConflictKey(characterId = chara.chaId): string {
    return `chat-order:${characterId ?? 'missing-owner'}`
  }

  function folderOrderConflictKey(characterId = chara.chaId): string {
    return `folder-order:${characterId ?? 'missing-owner'}`
  }

  function hasConflictingStructureMutation(conflictKeys: readonly string[], ignoredMutationKey?: string): boolean {
    return Object.entries(chatStructureMutations).some(
      ([key, mutation]) =>
        (!ignoredMutationKey || (key !== ignoredMutationKey && !key.startsWith(`${ignoredMutationKey}:`))) &&
        mutation.status === 'pending' &&
        mutation.conflictKeys.some((conflictKey) => conflictKeys.includes(conflictKey)),
    )
  }

  function mutationKeyBelongsToGroup(key: string, groupKey: string): boolean {
    return key === groupKey || key.startsWith(`${groupKey}:`)
  }

  function clearFailedStructureMutations(groupKey: string): void {
    for (const [key, mutation] of Object.entries(chatStructureMutations)) {
      if (mutationKeyBelongsToGroup(key, groupKey) && mutation.status === 'failed') {
        delete chatStructureMutations[key]
      }
    }
  }

  function clearAcceptedStructureMutation(key: string, run: number, groupKey?: string): void {
    if (!groupKey) {
      if (chatStructureMutations[key]?.run === run) delete chatStructureMutations[key]
      return
    }
    for (const [candidateKey, mutation] of Object.entries(chatStructureMutations)) {
      if (mutationKeyBelongsToGroup(candidateKey, groupKey) && mutation.run <= run) {
        delete chatStructureMutations[candidateKey]
      }
    }
  }

  function structureMutationForTarget(
    targetKind: ChatStructureTargetKind,
    targetId: string | undefined,
  ): ChatStructureMutationState | undefined {
    if (!targetId) return undefined
    const matches = Object.values(chatStructureMutations).filter(
      (mutation) => mutation.targetKind === targetKind && mutation.targetId === targetId,
    )
    return (
      matches.find((mutation) => mutation.status === 'pending') ??
      matches.find((mutation) => mutation.status === 'queued') ??
      matches.find((mutation) => mutation.status === 'failed')
    )
  }

  function isChatStructurePending(chatId: string | undefined): boolean {
    return Boolean(chatId && hasConflictingStructureMutation([chatConflictKey(chatId)]))
  }

  function isFolderStructurePending(folderId: string | undefined): boolean {
    return Boolean(folderId && hasConflictingStructureMutation([folderConflictKey(folderId)]))
  }

  function isChatStructuralActionPending(chatId: string | undefined): boolean {
    return Boolean(chatId && hasConflictingStructureMutation([chatOrderConflictKey(), chatConflictKey(chatId)]))
  }

  function isFolderStructuralActionPending(folderId: string | undefined): boolean {
    return Boolean(
      folderId &&
      hasConflictingStructureMutation([chatOrderConflictKey(), folderOrderConflictKey(), folderConflictKey(folderId)]),
    )
  }

  function structureMutationMessage(mutation: ChatStructureMutationState): string {
    if (mutation.status === 'pending') return language.chatStructurePending(mutation.action)
    if (mutation.status === 'queued') return language.chatStructureQueued(mutation.action)
    return language.chatStructureFailed(mutation.action)
  }

  async function settleStructureMutation(
    key: string,
    targetKind: ChatStructureTargetKind,
    targetId: string,
    action: string,
    conflictKeys: string[],
    dispatch: () => Promise<ChatMutationOutcome> | undefined,
    queuedMessage?: string,
    onFinal?: (outcome: Awaited<Extract<ChatMutationOutcome, { status: 'queued' }>['settlement']>) => void,
    mutationGroupKey?: string,
  ): Promise<ChatMutationOutcome['status']> {
    const run = ++nextStructureMutationRun
    chatStructureMutations[key] = { targetKind, targetId, action, conflictKeys, run, status: 'pending' }
    try {
      const outcome = await dispatch()
      if (chatStructureMutations[key]?.run !== run) return 'failed'
      if (!outcome || outcome.status === 'failed') {
        chatStructureMutations[key] = { targetKind, targetId, action, conflictKeys, run, status: 'failed' }
        alertError(language.chatStructureFailed(action))
        return 'failed'
      }
      if (outcome.status === 'queued') {
        chatStructureMutations[key] = { targetKind, targetId, action, conflictKeys, run, status: 'queued' }
        alertNormal(queuedMessage ?? language.chatStructureQueued(action))
        void outcome.settlement.then(
          (finalOutcome) => {
            if (chatStructureMutations[key]?.run !== run) return
            if (finalOutcome.status === 'accepted') {
              clearAcceptedStructureMutation(key, run, mutationGroupKey)
              onFinal?.(finalOutcome)
              return
            }
            chatStructureMutations[key] = { targetKind, targetId, action, conflictKeys, run, status: 'failed' }
            alertError(language.chatStructureFailed(action))
            onFinal?.(finalOutcome)
          },
          () => {
            if (chatStructureMutations[key]?.run !== run) return
            chatStructureMutations[key] = { targetKind, targetId, action, conflictKeys, run, status: 'failed' }
            alertError(language.chatStructureFailed(action))
            onFinal?.({ status: 'failed', result: { status: 'unavailable' } })
          },
        )
        return 'queued'
      }
      clearAcceptedStructureMutation(key, run, mutationGroupKey)
      return 'accepted'
    } catch {
      if (chatStructureMutations[key]?.run === run) {
        chatStructureMutations[key] = { targetKind, targetId, action, conflictKeys, run, status: 'failed' }
        alertError(language.chatStructureFailed(action))
      }
      return 'failed'
    }
  }

  function selectChat(index: number): void {
    const chatId = chara.chats[index]?.id
    if (!uniqueSidebarChat(chatId)) return
    if (chara.chaId && chatId) {
      navigate(characterRoutePath(chara.chaId, chatId))
      return
    }
    if (canUseServerCommands() && chatId) {
      // Scalar rollback: select only flips `chatPage`; the whole-array
      // snapshot deep-cloned every hydrated transcript per sidebar click.
      dispatchSelectChat(chatId, currentChatSelectionSnapshot())
      return
    }
    changeChatTo(index)
  }

  function activateChatRow(index: number): void {
    if (!canUseClientWriteAccess() || editMode) return
    const chat = uniqueSidebarChat(chara.chats[index]?.id)
    if (!chat?.id) return
    markChatRead(chat.id)
    selectChat(index)
    reloadGuiDisplay()
  }

  async function toggleChatFolder(folder: ChatFolder): Promise<void> {
    if (editMode || hasConflictingStructureMutation([folderConflictKey(folder.id)])) return
    const ownerFolder = uniqueSidebarFolder(folder.id)
    if (!ownerFolder) return
    const folded = !ownerFolder.folded
    const previous = captureChatFolderMetadataPatch(folder.id, { folded }, chara.chaId)
    if (!previous || !applyDirectOptimisticFolderMetadata(folder.id, { folded })) return
    await settleStructureMutation(
      structureMutationKey('fold-folder', folder.id),
      'folder',
      folder.id,
      `${language.edit}: ${folder.name}`,
      [folderConflictKey(folder.id)],
      () => dispatchChatFolderMetadataPatchWithOutcome(previous, rollbackOwnedChatFolderMetadata),
    )
    reloadGuiDisplay()
  }

  function backToChatList(): void {
    if (chara.chaId) {
      navigate(characterRoutePath(chara.chaId))
    }
  }

  function currentRouteIdentity(): string {
    const route = get(currentRoute)
    return `${route.kind}:${route.path}`
  }

  function recoverRejectedProvisionalChatRoute(characterId: string, provisionalChatId: string): void {
    if (!canUseClientWriteAccess()) return
    const route = get(currentRoute)
    if (route.kind !== 'character' || route.chaId !== characterId || route.chatId !== provisionalChatId) return
    const character = sidebarCharacter?.chaId === characterId ? sidebarCharacter : undefined
    if (!character || character.chats?.some((chat) => chat.id === provisionalChatId)) return
    const replacementChatId = character.chats?.[character.chatPage]?.id
    navigate(characterRoutePath(characterId, replacementChatId), { replace: true })
  }

  function isExpectedSidebarChatSelected(characterId: string, chatId: string): boolean {
    if (!canUseClientWriteAccess()) return false
    const selectedCharacter = sidebarCharacter
    return Boolean(
      selectedCharacter?.chaId === characterId &&
      chara.chaId === characterId &&
      selectedCharacter.chats?.[selectedCharacter.chatPage]?.id === chatId,
    )
  }

  type ChatOrganizerAction =
    | { kind: 'move'; direction: 'up' | 'down'; label: string }
    | { kind: 'moveToFolder'; label: string }
    | { kind: 'moveOut'; label: string }

  type ChatFolderOrganizerAction =
    | { kind: 'move'; direction: 'up' | 'down'; label: string }
    | { kind: 'color'; label: string }

  function parseAlertSelection(value: unknown, optionCount: number): number | null {
    if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null
    const selection = Number(value.trim())
    return Number.isSafeInteger(selection) && selection >= 0 && selection < optionCount ? selection : null
  }

  function hasUniqueNonemptyIds(ids: Array<string | undefined>): ids is string[] {
    return ids.every((id): id is string => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length
  }

  function hasStableOrganizationIds(): boolean {
    return (
      hasUniqueNonemptyIds(chara.chats.map((chat) => chat.id)) &&
      hasUniqueNonemptyIds((chara.chatFolders ?? []).map((folder) => folder.id))
    )
  }

  function isCurrentOrganizerOwner(characterId: string): boolean {
    return canUseClientWriteAccess() && sidebarCharacter?.chaId === characterId
  }

  function isCurrentBranchGraphOwner(
    characterId: string | undefined,
    selectedCharacterIndex: number,
    characterReference: character,
  ): boolean {
    if (!canUseClientWriteAccess()) return false
    const selectedCharacter = sidebarCharacter
    if (characterId) return selectedCharacter?.chaId === characterId
    const selectedIndex =
      charactersResourceState.status === 'ready' ? charactersResourceState.currentChar : $selectedCharID
    return selectedIndex === selectedCharacterIndex && selectedCharacter === characterReference
  }

  function organizerButtonForChat(chatId: string): HTMLButtonElement | undefined {
    return Array.from(listEle?.querySelectorAll<HTMLButtonElement>('[data-risu-chat-organizer-action]') ?? []).find(
      (button) => button.dataset.risuChatOrganizerAction === chatId,
    )
  }

  function organizerButtonForFolder(folderId: string): HTMLButtonElement | undefined {
    return Array.from(
      folderEles?.querySelectorAll<HTMLButtonElement>('[data-risu-chat-folder-organizer-action]') ?? [],
    ).find((button) => button.dataset.risuChatFolderOrganizerAction === folderId)
  }

  function restoreChatOrganizerFocus(chatId: string, targetFolderId: string | null): void {
    const chatButton = organizerButtonForChat(chatId)
    if (chatButton && !chatButton.closest('[hidden]')) {
      chatButton.focus()
      return
    }
    if (targetFolderId) {
      organizerButtonForFolder(targetFolderId)?.focus()
      return
    }
    listEle
      ?.closest('[data-risu-chat-list]')
      ?.querySelector<HTMLButtonElement>('[data-risu-chat-action="edit-list"]')
      ?.focus()
  }

  function chatFolderAssignments(): Record<string, string | null> {
    const assignments: Record<string, string | null> = {}
    const validFolderIds = new Set((chara.chatFolders ?? []).map((folder) => folder.id))
    for (const chat of chara.chats) {
      if (chat.id) assignments[chat.id] = chat.folderId && validFolderIds.has(chat.folderId) ? chat.folderId : null
    }
    return assignments
  }

  function groupedChatIds(assignments: Record<string, string | null>): Map<string | null, string[]> {
    const groups = new Map<string | null, string[]>()
    for (const folder of chara.chatFolders ?? []) groups.set(folder.id, [])
    groups.set(null, [])
    for (const chat of chara.chats) {
      if (!chat.id) continue
      const folderId = assignments[chat.id] ?? null
      const group = groups.get(folderId) ?? groups.get(null)!
      group.push(chat.id)
    }
    return groups
  }

  function flattenChatGroups(
    groups: Map<string | null, string[]>,
    folderIds = (chara.chatFolders ?? []).map((folder) => folder.id),
  ): string[] {
    return [...folderIds.flatMap((folderId) => groups.get(folderId) ?? []), ...(groups.get(null) ?? [])]
  }

  async function applyChatOrganization(
    targetChatId: string,
    chatIds: string[],
    assignments: Record<string, string | null>,
  ): Promise<void> {
    if (!chara.chaId) return
    const selectedChatId = chara.chats[chara.chatPage]?.id
    if (canUseServerCommands()) {
      const previous = captureChatOrderSnapshot(chara.chaId)
      if (!previous) return
      const conflictKeys = [chatOrderConflictKey(), chatConflictKey(targetChatId)]
      if (hasConflictingStructureMutation(conflictKeys)) return
      await settleStructureMutation(
        structureMutationKey('organize-chat', targetChatId),
        'chat',
        targetChatId,
        language.chatListEdit,
        conflictKeys,
        () => dispatchReorderChatsByIdsWithOutcome(chara.chaId, chatIds, assignments, previous, selectedChatId),
      )
      return
    }

    const chatsById = new Map(chara.chats.filter((chat) => chat.id).map((chat) => [chat.id!, chat]))
    for (const [chatId, folderId] of Object.entries(assignments)) {
      const chat = chatsById.get(chatId)
      if (chat) chat.folderId = folderId
    }
    chara.chats = chatIds.map((chatId) => chatsById.get(chatId)).filter((chat): chat is Chat => Boolean(chat))
    const selectedIndex = selectedChatId ? chatIds.indexOf(selectedChatId) : -1
    if (selectedIndex >= 0) changeChatTo(selectedIndex)
    reloadGuiDisplay()
  }

  async function openChatOrganizerActions(chat: Chat, focusOrigin?: HTMLButtonElement): Promise<void> {
    const ownerCharacterId = chara.chaId
    const ownerChat = uniqueSidebarChat(chat.id)
    if (
      !ownerCharacterId ||
      !isCurrentOrganizerOwner(ownerCharacterId) ||
      !ownerChat?.id ||
      !hasStableOrganizationIds() ||
      isChatStructuralActionPending(chat.id)
    )
      return
    const shouldRestoreFocus = focusOrigin === document.activeElement
    const chatId = ownerChat.id
    const initialAssignments = chatFolderAssignments()
    const initialSourceFolderId = initialAssignments[chatId] ?? null
    const initialGroups = groupedChatIds(initialAssignments)
    const initialSourceGroup = initialGroups.get(initialSourceFolderId) ?? []
    const sourceIndex = initialSourceGroup.indexOf(chatId)
    if (sourceIndex < 0) return

    const actions: ChatOrganizerAction[] = []
    if (sourceIndex > 0) actions.push({ kind: 'move', direction: 'up', label: language.moveUp })
    if (sourceIndex < initialSourceGroup.length - 1) {
      actions.push({ kind: 'move', direction: 'down', label: language.moveDown })
    }
    const initialDestinationFolders = (chara.chatFolders ?? []).filter((folder) => folder.id !== initialSourceFolderId)
    if (initialDestinationFolders.length > 0) actions.push({ kind: 'moveToFolder', label: language.moveToFolder })
    if (initialSourceFolderId !== null) actions.push({ kind: 'moveOut', label: language.moveOutOfFolder })
    if (actions.length === 0) return

    const actionSelection = await alertSelect(
      actions.map((action) => action.label),
      `${language.options}: ${chat.name}`,
    )
    if (!isCurrentOrganizerOwner(ownerCharacterId)) return
    const selectedAction = parseAlertSelection(actionSelection, actions.length)
    if (selectedAction === null) return
    const action = actions[selectedAction]
    if (!action) return

    let requestedTargetFolderId: string | null | undefined
    if (action.kind === 'moveToFolder') {
      const currentSourceFolderId = chatFolderAssignments()[chatId] ?? null
      const destinationFolders = (chara.chatFolders ?? []).filter((folder) => folder.id !== currentSourceFolderId)
      const folderSelection = await alertSelect(
        destinationFolders.map((folder) => folder.name),
        language.chooseDestinationFolder,
      )
      if (!isCurrentOrganizerOwner(ownerCharacterId)) return
      const selectedFolder = parseAlertSelection(folderSelection, destinationFolders.length)
      if (selectedFolder === null) return
      requestedTargetFolderId = destinationFolders[selectedFolder]?.id
      if (!requestedTargetFolderId) return
    }

    const currentChat = uniqueSidebarChat(chatId)
    if (!currentChat || !hasStableOrganizationIds()) return
    const assignments = chatFolderAssignments()
    const sourceFolderId = assignments[chatId] ?? null
    const groups = groupedChatIds(assignments)
    const sourceGroup = groups.get(sourceFolderId) ?? []
    const currentSourceIndex = sourceGroup.indexOf(chatId)
    if (currentSourceIndex < 0) return

    if (action.kind === 'move') {
      const targetIndex = currentSourceIndex + (action.direction === 'up' ? -1 : 1)
      if (targetIndex < 0 || targetIndex >= sourceGroup.length) return
      ;[sourceGroup[currentSourceIndex], sourceGroup[targetIndex]] = [
        sourceGroup[targetIndex],
        sourceGroup[currentSourceIndex],
      ]
    } else {
      const targetFolderId = action.kind === 'moveOut' ? null : requestedTargetFolderId
      if (targetFolderId === undefined || targetFolderId === sourceFolderId) return
      sourceGroup.splice(currentSourceIndex, 1)
      const targetGroup = groups.get(targetFolderId)
      if (!targetGroup) return
      targetGroup.push(chatId)
      assignments[chatId] = targetFolderId
    }

    await applyChatOrganization(chatId, flattenChatGroups(groups), assignments)
    await tick()
    if (!isCurrentOrganizerOwner(ownerCharacterId)) return
    if (shouldRestoreFocus) restoreChatOrganizerFocus(chatId, assignments[chatId] ?? null)
  }

  async function openChatFolderOrganizerActions(folder: ChatFolder, focusOrigin?: HTMLButtonElement): Promise<void> {
    const ownerCharacterId = chara.chaId
    const ownerFolder = uniqueSidebarFolder(folder.id)
    if (
      !ownerCharacterId ||
      !ownerFolder ||
      !isCurrentOrganizerOwner(ownerCharacterId) ||
      hasConflictingStructureMutation([folderConflictKey(folder.id)])
    )
      return
    const shouldRestoreFocus = focusOrigin === document.activeElement
    const initialFolders = chara.chatFolders ?? []
    if (!hasUniqueNonemptyIds(initialFolders.map((candidate) => candidate.id))) return
    const folderIndex = initialFolders.findIndex((candidate) => candidate.id === folder.id)
    if (folderIndex < 0) return
    const actions: ChatFolderOrganizerAction[] = []
    if (editMode && organizerIdsStable && folderIndex > 0) {
      actions.push({ kind: 'move', direction: 'up', label: language.moveUp })
    }
    if (editMode && organizerIdsStable && folderIndex < initialFolders.length - 1) {
      actions.push({ kind: 'move', direction: 'down', label: language.moveDown })
    }
    actions.push({ kind: 'color', label: language.changeFolderColor })

    const actionSelection = await alertSelect(
      actions.map((action) => action.label),
      `${language.options}: ${folder.name}`,
    )
    if (!isCurrentOrganizerOwner(ownerCharacterId)) return
    const selectedAction = parseAlertSelection(actionSelection, actions.length)
    if (selectedAction === null) return
    const action = actions[selectedAction]
    if (!action) return

    if (action.kind === 'color') {
      const colors = ['red', 'green', 'blue', 'yellow', 'indigo', 'purple', 'pink', 'default']
      const colorSelectionValue = await alertSelect(colors)
      if (!isCurrentOrganizerOwner(ownerCharacterId)) return
      const colorSelection = parseAlertSelection(colorSelectionValue, colors.length)
      if (colorSelection === null) return
      if (hasConflictingStructureMutation([folderConflictKey(folder.id)])) return
      const color = colors[colorSelection]
      if (!color) return
      const previous = captureChatFolderMetadataPatch(folder.id, { color }, chara.chaId)
      if (!previous || !applyDirectOptimisticFolderMetadata(folder.id, { color })) return
      await settleStructureMutation(
        structureMutationKey('color-folder', folder.id),
        'folder',
        folder.id,
        `${language.changeFolderColor}: ${folder.name}`,
        [folderConflictKey(folder.id)],
        () => dispatchChatFolderMetadataPatchWithOutcome(previous, rollbackOwnedChatFolderMetadata),
      )
      return
    }

    if (!hasStableOrganizationIds()) return
    const folders = chara.chatFolders ?? []
    const currentFolderIndex = folders.findIndex((candidate) => candidate.id === folder.id)
    if (currentFolderIndex < 0) return
    const targetIndex = currentFolderIndex + (action.direction === 'up' ? -1 : 1)
    if (targetIndex < 0 || targetIndex >= folders.length) return
    const folderIds = folders.map((candidate) => candidate.id)
    ;[folderIds[currentFolderIndex], folderIds[targetIndex]] = [folderIds[targetIndex], folderIds[currentFolderIndex]]
    const assignments = chatFolderAssignments()
    const chatIds = flattenChatGroups(groupedChatIds(assignments), folderIds)
    const selectedChatId = chara.chats[chara.chatPage]?.id
    const usingServerCommands = canUseServerCommands()
    if (usingServerCommands && !chara.chaId) return
    if (usingServerCommands) {
      const previous = captureChatOrderSnapshot(chara.chaId)
      if (!previous) return
      const conflictKeys = [
        chatOrderConflictKey(chara.chaId),
        folderOrderConflictKey(chara.chaId),
        folderConflictKey(folder.id),
      ]
      if (hasConflictingStructureMutation(conflictKeys)) return
      await settleStructureMutation(
        structureMutationKey('organize-folders', chara.chaId),
        'order',
        chara.chaId,
        language.chatListEdit,
        conflictKeys,
        () =>
          dispatchReorderChatFoldersAndChatsByIdsWithOutcome(
            chara.chaId,
            folderIds,
            chatIds,
            assignments,
            previous,
            selectedChatId,
          ),
      )
    } else {
      const foldersById = new Map(folders.map((candidate) => [candidate.id, candidate]))
      const chatsById = new Map(chara.chats.map((candidate) => [candidate.id, candidate]))
      chara.chatFolders = folderIds.map((folderId) => foldersById.get(folderId)).filter(Boolean) as ChatFolder[]
      chara.chats = chatIds.map((chatId) => chatsById.get(chatId)).filter(Boolean) as Chat[]
      const selectedIndex = selectedChatId ? chatIds.indexOf(selectedChatId) : -1
      if (selectedIndex >= 0) changeChatTo(selectedIndex)
      reloadGuiDisplay()
    }
    await tick()
    if (!isCurrentOrganizerOwner(ownerCharacterId)) return
    if (shouldRestoreFocus) organizerButtonForFolder(folder.id)?.focus()
  }

  async function createChat(): Promise<void> {
    if (!canUseClientWriteAccess()) return
    if (!sidebarCharacter) return
    if (hasConflictingStructureMutation([chatOrderConflictKey()])) return
    const len = chara.chats.length
    const chat = {
      message: [],
      note: '',
      name: `New Chat ${len + 1}`,
      localLore: [],
      fmIndex: -1,
      id: v4(),
    }
    if (canUseServerCommands()) {
      const characterId = chara.chaId
      const previous = captureChatCreateSnapshot(characterId, chat)
      if (!previous) return
      const originRoute = currentRouteIdentity()
      const applied = applyOptimisticCreatedChat(characterId, chat, previous)
      if (!applied || !characterId || !chat.id) return
      const outcome = await settleStructureMutation(
        structureMutationKey('create-chat', chat.id),
        'chat',
        chat.id,
        `${language.newChat}: ${chat.name}`,
        [chatOrderConflictKey(characterId), chatConflictKey(chat.id)],
        () => dispatchCreateChatWithOutcome(characterId, chat, previous),
        language.chatCreateProvisional(chat.name),
        (finalOutcome) => {
          if (finalOutcome.status === 'failed') recoverRejectedProvisionalChatRoute(characterId, chat.id)
        },
      )
      if (
        outcome !== 'failed' &&
        currentRouteIdentity() === originRoute &&
        isExpectedSidebarChatSelected(characterId, chat.id)
      ) {
        navigate(characterRoutePath(characterId, chat.id))
      }
      return
    }
    chara.chats.unshift(chat)
    changeChatTo(0)
    reloadGuiDisplay()
  }

  async function forkChat(sourceChat: Chat): Promise<void> {
    const sourceChatId = sourceChat.id
    const characterId = chara.chaId
    let liveSourceChat = uniqueSidebarChat(sourceChatId)
    if (!liveSourceChat) return
    if (canUseServerCommands() && sourceChatId) {
      if (isChatStructuralActionPending(sourceChatId)) return
      try {
        await hydrateChatMessages(sourceChatId, { strict: true })
      } catch {
        alertError(language.chatDataLoadFailed)
        return
      }

      const hydratedSourceChat = uniqueSidebarChat(sourceChatId)
      if (!hydratedSourceChat) {
        alertError(language.chatDataLoadFailed)
        return
      }
      liveSourceChat = hydratedSourceChat
    }

    const newChat = $state.snapshot(liveSourceChat)
    newChat.name = createChatCopyName(newChat.name, 'Copy')
    rekeyClonedChat(newChat)
    if (canUseServerCommands()) {
      if (!sourceChatId || !newChat.id) return
      const previous = captureChatForkSnapshot(sourceChatId, { chat: newChat })
      if (!previous) return
      const conflictKeys = [
        chatOrderConflictKey(characterId),
        chatConflictKey(sourceChatId),
        chatConflictKey(newChat.id),
      ]
      if (hasConflictingStructureMutation(conflictKeys)) return
      await settleStructureMutation(
        structureMutationKey('fork-chat', newChat.id),
        'chat',
        newChat.id,
        `${language.createCopy}: ${newChat.name}`,
        conflictKeys,
        () => dispatchForkChatWithOutcome(sourceChatId, previous, { chat: newChat }),
      )
      return
    }
    chara.chats.unshift(newChat)
    changeChatTo(0)
    chara.chats = chara.chats
  }

  function applyDirectOptimisticChatMetadata(chatId: string, patch: Partial<Chat>): boolean {
    if (!canUseClientWriteAccess()) return false
    const characterId = sidebarCharacter?.chaId
    if (!characterId || !uniqueSidebarChat(chatId)) return false
    return applyChatMetadataOwnerPatch(characterId, chatId, patch)
  }

  function applyDirectOptimisticFolderMetadata(folderId: string, patch: Partial<ChatFolder>): boolean {
    if (!canUseClientWriteAccess()) return false
    const characterId = sidebarCharacter?.chaId
    if (!characterId || !uniqueSidebarFolder(folderId)) return false
    return applyChatFolderMetadataOwnerPatch(characterId, folderId, patch)
  }

  function rollbackOwnedChatMetadata(snapshot: ChatRowMetadataSnapshot): void {
    if (charactersResourceState.status === 'ready') {
      if (!snapshot.characterId) return
      restoreChatMetadataOwnerSnapshot({
        characterId: snapshot.characterId,
        chatId: snapshot.chatId,
        metadata: snapshot.metadata,
        attempted: snapshot.attempted,
      })
      return
    }
    restoreChatRowMetadata(snapshot)
  }

  function rollbackOwnedChatFolderMetadata(snapshot: ChatFolderRowMetadataSnapshot): void {
    if (charactersResourceState.status === 'ready') {
      if (!snapshot.characterId) return
      restoreChatFolderMetadataOwnerSnapshot({
        characterId: snapshot.characterId,
        folderId: snapshot.folderId,
        metadata: snapshot.metadata,
        attempted: snapshot.attempted,
      })
      return
    }
    restoreChatFolderRowMetadata(snapshot)
  }

  async function updateChatName(chat: Chat, name: string): Promise<void> {
    const ownerChat = uniqueSidebarChat(chat.id)
    if (!ownerChat || ownerChat.name === name || reportWriterAccessLostMutation()) return
    if (canUseServerCommands()) {
      const chatId = chat.id
      const liveChat = uniqueSidebarChat(chatId)
      if (!chatId || !liveChat || liveChat.name === name) return
      const key = structureMutationKey('rename-chat', chatId)
      if (hasConflictingStructureMutation([chatConflictKey(chatId)], key)) return
      const previous = captureChatMetadataPatch(chatId, { name }, chara.chaId)
      if (!previous || !applyDirectOptimisticChatMetadata(chatId, { name })) return
      clearFailedStructureMutations(key)
      await settleStructureMutation(
        `${key}:${v4()}`,
        'chat',
        chatId,
        `${language.edit}: ${name}`,
        [chatConflictKey(chatId)],
        () => dispatchChatMetadataPatchWithOutcome(previous, rollbackOwnedChatMetadata),
        undefined,
        undefined,
        key,
      )
      return
    }
    chat.name = name
  }

  async function updateFolderName(folder: ChatFolder, name: string): Promise<void> {
    const ownerFolder = uniqueSidebarFolder(folder.id)
    if (!ownerFolder || ownerFolder.name === name || reportWriterAccessLostMutation()) return
    if (canUseServerCommands()) {
      const folderId = folder.id
      const liveFolder = uniqueSidebarFolder(folderId)
      if (!folderId || !liveFolder || liveFolder.name === name) return
      const key = structureMutationKey('rename-folder', folderId)
      if (hasConflictingStructureMutation([folderConflictKey(folderId)], key)) return
      const previous = captureChatFolderMetadataPatch(folderId, { name }, chara.chaId)
      if (!previous || !applyDirectOptimisticFolderMetadata(folderId, { name })) return
      clearFailedStructureMutations(key)
      await settleStructureMutation(
        `${key}:${v4()}`,
        'folder',
        folderId,
        `${language.edit}: ${name}`,
        [folderConflictKey(folderId)],
        () => dispatchChatFolderMetadataPatchWithOutcome(previous, rollbackOwnedChatFolderMetadata),
        undefined,
        undefined,
        key,
      )
      return
    }
    folder.name = name
  }

  async function togglePersonaBinding(chatId: string | undefined): Promise<void> {
    if (!chatId || pendingPersonaBindings[chatId]) return
    pendingPersonaBindings[chatId] = true
    try {
      const chat = uniqueSidebarChat(chatId)
      if (!chat) return

      const previousBinding = resolveChatBoundPersonaId(chat) ?? ''
      const confirmed = await alertConfirm(
        previousBinding ? language.doYouWantToUnbindCurrentPersona : language.doYouWantToBindCurrentPersona,
      )
      if (!confirmed) return

      const liveChat = uniqueSidebarChat(chatId)
      if (!liveChat || (resolveChatBoundPersonaId(liveChat) ?? '') !== previousBinding) return

      let personaId: string | null = null
      if (!previousBinding) {
        personaId = selectedPersonaId()
        if (!personaId) return
      }

      const state = resolveActiveChatGenerationSettings({
        target: {
          selectedCharID: -1,
          chatPage: -1,
          characterId: chara.chaId,
          chatId,
        },
      })
      if (state.chat?.id !== chatId) return
      const operation = dispatchSaveChatGenerationSettingsWithOutcome(
        chatId,
        createActiveChatPersonaSelectionPatch(personaId, state),
      )
      if (!operation) {
        alertError(language.personaBindingFailed)
        return
      }
      const result = await operation.settlement
      if (result.status === 'queued') {
        alertNormal(language.personaBindingQueued)
        return
      }
      if (result.status === 'failed') {
        alertError(language.personaBindingFailed)
        return
      }
      alertNormal(previousBinding ? language.personaUnbindedSuccess : language.personaBindedSuccess)
    } finally {
      delete pendingPersonaBindings[chatId]
    }
  }

  async function deleteChat(chat: Chat, index: number): Promise<void> {
    const ownerChat = uniqueSidebarChat(chat.id)
    if (!ownerChat) return
    if (chara.chats.length === 1) {
      alertError(language.errors.onlyOneChat)
      return
    }
    if (!chat.id || isChatStructuralActionPending(chat.id)) return
    const confirmed = await alertConfirm(`${language.removeConfirm}${ownerChat.name}`)
    if (!confirmed || isChatStructuralActionPending(chat.id) || !uniqueSidebarChat(chat.id)) return

    const deletedSelectedChat = chara.chats[chara.chatPage]?.id === chat.id
    if (canUseServerCommands()) {
      const characterId = chara.chaId
      const previous = captureChatDeleteSnapshot(chat.id, characterId)
      if (!previous) return
      const originRoute = currentRouteIdentity()
      const result = applyOptimisticDeletedChat(characterId, chat.id, previous)
      if (!result.applied) return
      const outcome = await settleStructureMutation(
        structureMutationKey('delete-chat', chat.id),
        'chat',
        chat.id,
        `${language.remove}: ${chat.name}`,
        [chatOrderConflictKey(characterId), chatConflictKey(chat.id)],
        () => dispatchDeleteChatWithOutcome(chat.id, previous),
      )
      if (
        outcome !== 'failed' &&
        deletedSelectedChat &&
        characterId &&
        result.selectedChatId &&
        currentRouteIdentity() === originRoute &&
        isExpectedSidebarChatSelected(characterId, result.selectedChatId)
      ) {
        navigate(characterRoutePath(characterId, result.selectedChatId), { replace: true })
      }
      return
    } else {
      changeChatTo(0)
      const chats = chara.chats
      chats.splice(index, 1)
      chara.chats = chats
      reloadGuiDisplay()
    }
  }

  async function exportAllAndMaybeResetChats(): Promise<void> {
    if (!canUseClientWriteAccess()) return
    const characterId = chara.chaId
    if (!characterId) return
    const exportResult = await exportAllChats(characterId)
    if (!canUseClientWriteAccess() || !exportResult.success) return

    const firstConfirmed = await alertConfirm(language.chatListDeleteAllAfterExportConfirm)
    if (!canUseClientWriteAccess() || !firstConfirmed) return
    const secondConfirmed = await alertConfirm(language.chatListDeleteAllSecondConfirm)
    if (
      !canUseClientWriteAccess() ||
      !secondConfirmed ||
      hasConflictingStructureMutation([chatOrderConflictKey(characterId)])
    )
      return

    const liveCharacter = sidebarCharacter?.chaId === characterId ? sidebarCharacter : undefined
    if (!liveCharacter) return
    if (!matchesAllChatsExportFence(liveCharacter.chats, exportResult.fence)) {
      alertError(language.chatListDeleteAllExportChanged)
      return
    }
    const previousChatIds = liveCharacter.chats.map((candidate) => candidate.id)
    const chat: Chat = {
      message: [],
      note: '',
      name: 'Chat 1',
      localLore: [],
      fmIndex: -1,
      id: v4(),
    }
    const previous = captureChatResetSnapshot(characterId)
    if (!previous) return
    const originRoute = currentRouteIdentity()
    if (!applyOptimisticResetChats(characterId, chat, previous)) return

    const outcome = await settleStructureMutation(
      structureMutationKey('reset-chats', characterId),
      'order',
      characterId,
      language.chatListDeleteAllAction,
      [chatOrderConflictKey(characterId), ...previousChatIds.map((chatId) => chatConflictKey(chatId))],
      () => dispatchResetChatsWithOutcome(characterId, chat, previous),
      undefined,
      (finalOutcome) => {
        if (finalOutcome.status === 'failed') recoverRejectedProvisionalChatRoute(characterId, chat.id)
      },
    )
    if (
      outcome !== 'failed' &&
      currentRouteIdentity() === originRoute &&
      isExpectedSidebarChatSelected(characterId, chat.id)
    ) {
      navigate(characterRoutePath(characterId, chat.id), { replace: true })
    }
  }

  async function exportChatOnDemand(chatId: string): Promise<void> {
    if (!canUseClientWriteAccess()) return
    if (!chara.chaId || !uniqueSidebarChat(chatId)) return
    try {
      await exportChat({ characterId: chara.chaId, chatId })
    } catch (error) {
      alertError(error as Error)
    }
  }

  async function importChatOnDemand(): Promise<void> {
    if (!canUseClientWriteAccess()) return
    if (!sidebarCharacter) return
    try {
      await importChat()
    } catch (error) {
      alertError(error as Error)
    }
  }

  async function deleteChatFolder(folder: ChatFolder, index: number): Promise<void> {
    const ownerFolder = uniqueSidebarFolder(folder.id)
    if (!ownerFolder) return
    if (isFolderStructuralActionPending(folder.id)) return
    const confirmed = await alertConfirm(`${language.removeConfirm}${ownerFolder.name}`)
    if (!confirmed || isFolderStructuralActionPending(folder.id) || !uniqueSidebarFolder(folder.id)) return
    if (canUseServerCommands()) {
      const previous = captureChatFolderDeleteSnapshot(folder.id, chara.chaId)
      if (!previous) return
      await settleStructureMutation(
        structureMutationKey('delete-folder', folder.id),
        'folder',
        folder.id,
        `${language.remove}: ${folder.name}`,
        [chatOrderConflictKey(), folderOrderConflictKey(), folderConflictKey(folder.id)],
        () => dispatchDeleteChatFolderWithOutcome(folder.id, previous),
      )
      return
    }

    const folders = chara.chatFolders
    folders.splice(index, 1)
    chara.chats.forEach((chat) => {
      if (chat.folderId === folder.id) chat.folderId = null
    })
    chara.chatFolders = folders
    reloadGuiDisplay()
  }

  async function createChatFolder(): Promise<void> {
    if (!canUseClientWriteAccess()) return
    if (!sidebarCharacter) return
    if (hasConflictingStructureMutation([folderOrderConflictKey()])) return
    const length = chara.chatFolders?.length ?? 0
    const folder = {
      id: v4(),
      name: `New Folder ${length + 1}`,
      folded: false,
    }
    if (canUseServerCommands()) {
      const previous = captureChatFolderCreateSnapshot(chara.chaId, folder)
      if (!previous) return
      if (!applyOptimisticCreatedChatFolder(chara.chaId, folder, previous)) return
      await settleStructureMutation(
        structureMutationKey('create-folder', folder.id),
        'folder',
        folder.id,
        `${language.chatListCreateFolder}: ${folder.name}`,
        [folderOrderConflictKey(), folderConflictKey(folder.id)],
        () => dispatchCreateChatFolderWithOutcome(chara.chaId, folder, previous),
      )
      return
    }

    chara.chatFolders ??= []
    chara.chatFolders.unshift(folder)
    chara.chatFolders = chara.chatFolders
    reloadGuiDisplay()
  }

  type ChatDomOrder = {
    chatIds: string[]
    chatsById: Map<string, Chat>
    folderByChatId: Record<string, string | null>
  }

  type FolderDomOrder = ChatDomOrder & {
    folderIds: string[]
    foldersById: Map<string, ChatFolder>
  }

  function rejectStaleReorder(reason: string): null {
    console.warn(`Ignoring stale sidebar chat reorder: ${reason}`)
    return null
  }

  function buildCurrentChatIdMap(): Map<string, Chat> | null {
    const chatsById = new Map<string, Chat>()
    for (const chat of chara.chats) {
      if (!chat.id) return rejectStaleReorder('current chat is missing an id')
      if (chatsById.has(chat.id)) return rejectStaleReorder(`duplicate current chat id "${chat.id}"`)
      chatsById.set(chat.id, chat)
    }
    return chatsById
  }

  function buildCurrentFolderIdMap(): Map<string, ChatFolder> | null {
    const foldersById = new Map<string, ChatFolder>()
    for (const folder of chara.chatFolders) {
      if (!folder.id) return rejectStaleReorder('current folder is missing an id')
      if (foldersById.has(folder.id)) return rejectStaleReorder(`duplicate current folder id "${folder.id}"`)
      foldersById.set(folder.id, folder)
    }
    return foldersById
  }

  function folderIdForChatElement(chatEle: HTMLElement, foldersById: Map<string, ChatFolder>): string | null {
    const folderPanel = chatEle.closest<HTMLElement>('[data-risu-chat-folder-panel-id]')
    if (!folderPanel) return null

    const folderId = folderPanel.dataset.risuChatFolderPanelId
    if (!folderId) {
      throw new Error('folder panel is missing an id')
    }
    if (!foldersById.has(folderId)) {
      throw new Error(`unknown folder id "${folderId}"`)
    }
    return folderId
  }

  function buildChatDomOrder(): ChatDomOrder | null {
    if (!listEle) return rejectStaleReorder('chat list is not mounted')

    const chatsById = buildCurrentChatIdMap()
    const foldersById = buildCurrentFolderIdMap()
    if (!chatsById || !foldersById) return null

    const chatIds: string[] = []
    const seenChatIds = new Set<string>()
    const folderByChatId: Record<string, string | null> = {}

    try {
      listEle.querySelectorAll<HTMLElement>('[data-risu-chat-id]').forEach((chatEle) => {
        const chatId = chatEle.dataset.risuChatId
        if (!chatId) {
          throw new Error('DOM chat row is missing an id')
        }
        if (seenChatIds.has(chatId)) {
          throw new Error(`duplicate DOM chat id "${chatId}"`)
        }
        if (!chatsById.has(chatId)) {
          throw new Error(`unknown DOM chat id "${chatId}"`)
        }
        seenChatIds.add(chatId)
        chatIds.push(chatId)
        folderByChatId[chatId] = folderIdForChatElement(chatEle, foldersById)
      })
    } catch (error) {
      return rejectStaleReorder(error instanceof Error ? error.message : String(error))
    }

    for (const chatId of chatsById.keys()) {
      if (!seenChatIds.has(chatId)) {
        return rejectStaleReorder(`current chat id "${chatId}" is missing from the DOM`)
      }
    }

    return { chatIds, chatsById, folderByChatId }
  }

  function buildFolderDomOrder(folderContainer: HTMLElement): FolderDomOrder | null {
    const chatOrder = buildChatDomOrder()
    const foldersById = buildCurrentFolderIdMap()
    if (!chatOrder || !foldersById) return null

    const folderIds: string[] = []
    const seenFolderIds = new Set<string>()

    for (const folderEle of Array.from(folderContainer.children)) {
      if (!(folderEle instanceof HTMLElement)) return rejectStaleReorder('DOM folder row is not an element')
      const folderId = folderEle.dataset.risuChatFolderId
      if (!folderId) return rejectStaleReorder('DOM folder row is missing an id')
      if (seenFolderIds.has(folderId)) return rejectStaleReorder(`duplicate DOM folder id "${folderId}"`)
      if (!foldersById.has(folderId)) return rejectStaleReorder(`unknown DOM folder id "${folderId}"`)
      seenFolderIds.add(folderId)
      folderIds.push(folderId)
    }

    for (const folderId of foldersById.keys()) {
      if (!seenFolderIds.has(folderId)) {
        return rejectStaleReorder(`current folder id "${folderId}" is missing from the DOM`)
      }
    }

    return { ...chatOrder, folderIds, foldersById }
  }

  function selectedChatIdFromDom(chatsById: Map<string, Chat>, fallbackChatId?: string): string | undefined {
    const selectedRow = listEle?.querySelector<HTMLElement>('[data-risu-chat-selected="true"][data-risu-chat-id]')
    const selectedChatId = selectedRow?.dataset.risuChatId
    if (selectedChatId && chatsById.has(selectedChatId)) return selectedChatId
    return fallbackChatId
  }

  async function resetSortableProjection(): Promise<void> {
    destroyStb()
    sorted += 1
    await sleep(1)
    createStb()
  }

  function destroyStb(): void {
    if (folderStb) {
      try {
        folderStb.destroy()
      } catch (error) {}
      folderStb = null
    }
    chatsStb.map((stb) => {
      try {
        stb.destroy()
      } catch (error) {}
    })
    chatsStb = []
  }

  const createStb = () => {
    if (!canUseClientWriteAccess()) return
    if (!listEle || !folderEles) return
    for (const chat of listEle.querySelectorAll('[data-risu-sidebar-chat-sortable-list]')) {
      chatsStb.push(
        new Sortable(chat, {
          group: 'chats',
          onEnd: async () => {
            if (!canUseClientWriteAccess()) return
            if (hasConflictingStructureMutation([chatOrderConflictKey()])) {
              await resetSortableProjection()
              return
            }
            const currentChatPage = chara.chatPage
            const usingServerCommands = canUseServerCommands()
            const chatOrder = buildChatDomOrder()

            if (!chatOrder || (usingServerCommands && !chara.chaId)) {
              if (!chara.chaId && usingServerCommands) rejectStaleReorder('character is missing an id')
              await resetSortableProjection()
              return
            }

            const selectedChatId = selectedChatIdFromDom(chatOrder.chatsById, chara.chats[currentChatPage]?.id)
            if (usingServerCommands) {
              const characterId = chara.chaId
              const previous = captureChatOrderSnapshot(characterId)
              if (!previous) {
                await resetSortableProjection()
                return
              }
              await settleStructureMutation(
                structureMutationKey('drag-chats', characterId),
                'order',
                characterId,
                language.chatListEdit,
                [chatOrderConflictKey(characterId)],
                () =>
                  dispatchReorderChatsByIdsWithOutcome(
                    characterId,
                    chatOrder.chatIds,
                    chatOrder.folderByChatId,
                    previous,
                    selectedChatId,
                  ),
              )
            } else {
              const newChats = chatOrder.chatIds.map((chatId) => chatOrder.chatsById.get(chatId) as Chat)
              for (const chat of newChats) {
                chat.folderId = chatOrder.folderByChatId[chat.id] ?? null
              }
              changeChatTo(newChats.indexOf(chara.chats[currentChatPage]))
              chara.chats = newChats
            }

            await resetSortableProjection()
          },
          ...sortableOptions,
        }),
      )
    }
    folderStb = Sortable.create(folderEles, {
      group: 'folders',
      onEnd: async (event) => {
        if (!canUseClientWriteAccess()) return
        if (hasConflictingStructureMutation([chatOrderConflictKey(), folderOrderConflictKey()])) {
          await resetSortableProjection()
          return
        }
        const currentChatPage = chara.chatPage
        const usingServerCommands = canUseServerCommands()
        const folderOrder = buildFolderDomOrder(event.to)

        if (!folderOrder || (usingServerCommands && !chara.chaId)) {
          if (!chara.chaId && usingServerCommands) rejectStaleReorder('character is missing an id')
          await resetSortableProjection()
          return
        }

        const selectedChatId = selectedChatIdFromDom(folderOrder.chatsById, chara.chats[currentChatPage]?.id)
        if (usingServerCommands) {
          const characterId = chara.chaId
          const previous = captureChatOrderSnapshot(characterId)
          if (!previous) {
            await resetSortableProjection()
            return
          }
          await settleStructureMutation(
            structureMutationKey('drag-folders', characterId),
            'order',
            characterId,
            language.chatListEdit,
            [chatOrderConflictKey(characterId), folderOrderConflictKey(characterId)],
            () =>
              dispatchReorderChatFoldersAndChatsByIdsWithOutcome(
                characterId,
                folderOrder.folderIds,
                folderOrder.chatIds,
                folderOrder.folderByChatId,
                previous,
                selectedChatId,
              ),
          )
        } else {
          const newFolders = folderOrder.folderIds.map(
            (folderId) => folderOrder.foldersById.get(folderId) as ChatFolder,
          )
          const newChats = folderOrder.chatIds.map((chatId) => folderOrder.chatsById.get(chatId) as Chat)
          for (const chat of newChats) {
            chat.folderId = folderOrder.folderByChatId[chat.id] ?? null
          }
          chara.chatFolders = newFolders
          changeChatTo(newChats.indexOf(chara.chats[currentChatPage]))
          chara.chats = newChats
        }
        await resetSortableProjection()
      },
      ...sortableOptions,
    })
  }

  $effect(() => {
    void $clientSessionStore
    if (!canUseClientWriteAccess()) {
      sortableStructureSignature = ''
      sortableReconcileGeneration += 1
      destroyStb()
      return
    }
    const signature = chatRouteOpen
      ? 'chat-open'
      : `chat-list:${(chara.chatFolders ?? []).map((folder) => folder.id).join('\u0000')}`
    if (signature === sortableStructureSignature) return
    sortableStructureSignature = signature
    const generation = ++sortableReconcileGeneration

    if (!canUseClientWriteAccess() || chatRouteOpen) {
      destroyStb()
      return
    }

    void tick().then(() => {
      if (!canUseClientWriteAccess() || generation !== sortableReconcileGeneration || chatRouteOpen) return
      destroyStb()
      createStb()
    })
  })

  onDestroy(() => {
    branchGraphHydrationRun += 1
    sortableReconcileGeneration += 1
    destroyStb()
  })

  onDestroy(
    registerWriterDraftCapture(() => {
      const chats = Object.fromEntries(
        Object.entries(chatNameDrafts).filter(([id, value]) => value !== chatNameBaselines[id]),
      )
      const folders = Object.fromEntries(
        Object.entries(folderNameDrafts).filter(([id, value]) => value !== folderNameBaselines[id]),
      )
      if (Object.keys(chats).length === 0 && Object.keys(folders).length === 0) return null
      return $state.snapshot({
        key: `chat-names:${nameDraftOwner ?? chara.chaId}`,
        label: chara.name,
        fields: [...Object.entries(chats), ...Object.entries(folders)].map(([id, value]) => ({ label: id, value })),
        data: { characterId: nameDraftOwner ?? chara.chaId, chats, folders },
        baseline: { chats: chatNameBaselines, folders: folderNameBaselines },
      })
    }),
  )
</script>

{#snippet chatActionsMenu(chat: Chat, index: number)}
  <div
    class="flex min-w-56 flex-col gap-1"
    role="group"
    aria-label={`${language.moreActions}: ${renderedChatName(chat)}`}>
    <button
      type="button"
      data-risu-chat-menu-action="copy"
      aria-label={`${language.createCopy}: ${renderedChatName(chat)}`}
      class="min-h-11 w-full rounded-md px-3 py-2 text-left hover:bg-selected"
      onclick={() => void forkChat(chat)}>{language.createCopy}</button>
    <button
      type="button"
      data-risu-chat-menu-action="persona"
      aria-label={`${language.bindPersona}: ${renderedChatName(chat)}`}
      class="min-h-11 w-full rounded-md px-3 py-2 text-left hover:bg-selected"
      onclick={() => void togglePersonaBinding(chat.id)}>
      {resolveChatBoundPersonaId(chat) ? language.unbindPersona : language.bindPersona}
    </button>
    <button
      type="button"
      data-risu-chat-menu-action="rename"
      aria-label={`${language.edit}: ${renderedChatName(chat)}`}
      class="min-h-11 w-full rounded-md px-3 py-2 text-left hover:bg-selected"
      onclick={() => (editMode = true)}>{language.renameChat}</button>
    <button
      type="button"
      data-risu-chat-menu-action="export"
      aria-label={`${language.export}: ${renderedChatName(chat)}`}
      class="min-h-11 w-full rounded-md px-3 py-2 text-left hover:bg-selected"
      onclick={() => {
        if (chara.chaId && chat.id) void exportChatOnDemand(chat.id)
      }}>{language.export}</button>
    {#if chat.id && organizerIdsStable}
      <button
        type="button"
        data-risu-chat-menu-action="organize"
        aria-label={`${language.organize}: ${renderedChatName(chat)}`}
        class="min-h-11 w-full rounded-md px-3 py-2 text-left hover:bg-selected"
        onclick={() => void openChatOrganizerActions(chat)}>{language.organize}</button>
    {/if}
    <div class="mt-1 border-t border-darkborderc pt-1" data-risu-danger-menu-section>
      <button
        type="button"
        data-risu-chat-menu-action="delete"
        aria-label={`${language.remove}: ${renderedChatName(chat)}`}
        disabled={isChatStructuralActionPending(chat.id)}
        class="min-h-11 w-full rounded-md px-3 py-2 text-left font-medium text-draculared hover:bg-red-950/40 disabled:opacity-50"
        onclick={() => void deleteChat(chat, index)}>{language.remove}</button>
    </div>
  </div>
{/snippet}

{#snippet folderActionsMenu(folder: ChatFolder, index: number)}
  <div class="flex min-w-56 flex-col gap-1" role="group" aria-label={`${language.moreActions}: ${folder.name}`}>
    <button
      type="button"
      data-risu-chat-menu-action="rename-folder"
      aria-label={`${language.edit}: ${folder.name}`}
      class="min-h-11 w-full rounded-md px-3 py-2 text-left hover:bg-selected"
      onclick={() => (editMode = true)}>{language.renameFolder}</button>
    <button
      type="button"
      data-risu-chat-menu-action="organize-folder"
      aria-label={`${language.organize}: ${folder.name}`}
      disabled={isFolderStructurePending(folder.id)}
      class="min-h-11 w-full rounded-md px-3 py-2 text-left hover:bg-selected disabled:opacity-50"
      onclick={() => void openChatFolderOrganizerActions(folder)}>{language.organize}</button>
    <div class="mt-1 border-t border-darkborderc pt-1" data-risu-danger-menu-section>
      <button
        type="button"
        data-risu-chat-menu-action="delete-folder"
        aria-label={`${language.remove}: ${folder.name}`}
        disabled={isFolderStructuralActionPending(folder.id)}
        class="min-h-11 w-full rounded-md px-3 py-2 text-left font-medium text-draculared hover:bg-red-950/40 disabled:opacity-50"
        onclick={() => void deleteChatFolder(folder, index)}>{language.remove}</button>
    </div>
  </div>
{/snippet}

<div
  data-risu-chat-list="sidebar"
  class="flex flex-col w-full h-[calc(100%-2rem)] max-h-[calc(100%-2rem)]"
  data-risu-chat-open={chatRouteOpen ? 'true' : 'false'}
  aria-hidden={!sidebarCharacter}
  hidden={!sidebarCharacter}>
  {#if chatRouteOpen}
    <div class="flex flex-col gap-3">
      <button
        data-risu-chat-action="back-to-chat-list"
        class="mb-1 flex min-h-11 items-center gap-2 rounded-md px-2 text-textcolor2 hover:bg-selected hover:text-textcolor cursor-pointer"
        onclick={backToChatList}>
        <ArrowLeftIcon size={18} />
        <span>{language.goback}</span>
      </button>

      {#if chara.chaId !== '§playground'}
        <AuthorNoteEditor {chara} />
        {#if writeActionsAllowed}
          <LazyComponent loader={loadToggles} componentProps={{ chara }} testId="chat-generation-toggles" />
        {/if}
      {/if}
    </div>
  {:else}
    <div
      class="w-full"
      data-risu-chat-action="create"
      data-risu-chat-mutation-status={hasConflictingStructureMutation([chatOrderConflictKey()]) ? 'pending' : ''}>
      <Button
        className="relative bottom-2 min-h-11 w-full"
        disabled={hasConflictingStructureMutation([chatOrderConflictKey()])}
        onclick={() => void createChat()}>{language.newChat}</Button>
    </div>

    <div aria-live="polite">
      {#each Object.entries(chatStructureMutations).filter(([, mutation]) => mutation.status === 'failed') as [key, mutation] (key)}
        <div
          data-risu-chat-mutation={key}
          data-risu-chat-mutation-status={mutation.status}
          role={mutation.status === 'failed' ? 'alert' : 'status'}
          class="mb-2 rounded-md border border-darkborderc px-2 py-1 text-sm text-textcolor2">
          {structureMutationMessage(mutation)}
        </div>
      {/each}
    </div>

    {#key sorted}
      <div class="flex flex-col mt-2 overflow-y-auto grow" bind:this={listEle}>
        <div class="flex flex-col" bind:this={folderEles} role="list" aria-label={language.chatFolders}>
          {#each chara.chatFolders as folder, i}
            <div
              data-risu-chat-folder-idx={i}
              data-risu-chat-folder-id={folder.id}
              data-risu-chat-folder-folded={folder.folded ? 'true' : 'false'}
              data-risu-chat-mutation-status={structureMutationForTarget('folder', folder.id)?.status ?? ''}
              aria-busy={isFolderStructurePending(folder.id)}
              role="listitem"
              class="flex flex-col mb-2 border-solid border-1 border-darkborderc cursor-pointer rounded-md">
              <!-- The nested native button retains keyboard semantics; the row handler restores the larger pointer target. -->
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                data-risu-chat-folder-header
                class="flex min-h-11 items-center text-textcolor border-solid border-0 border-darkborderc p-1 cursor-pointer rounded-md"
                class:bg-red-900={folder.color === 'red'}
                class:bg-yellow-900={folder.color === 'yellow'}
                class:bg-green-900={folder.color === 'green'}
                class:bg-blue-900={folder.color === 'blue'}
                class:bg-indigo-900={folder.color === 'indigo'}
                class:bg-purple-900={folder.color === 'purple'}
                class:bg-pink-900={folder.color === 'pink'}
                onclick={() => void toggleChatFolder(folder)}>
                {#if editMode}
                  <TextInput
                    bind:value={folderNameDrafts[folder.id]}
                    className="grow min-w-0"
                    ariaLabel={`${language.edit}: ${folder.name}`}
                    onchange={() => void updateFolderName(folder, folderNameDrafts[folder.id])}
                    padding={false} />
                {:else}
                  <button
                    type="button"
                    data-risu-chat-action="toggle-folder"
                    aria-expanded={!folder.folded}
                    aria-controls={`risu-chat-folder-panel-${folder.id}`}
                    disabled={isFolderStructurePending(folder.id)}
                    class="flex min-h-11 min-w-0 grow cursor-pointer items-center gap-2 px-2 text-left"
                    class:opacity-50={isFolderStructurePending(folder.id)}
                    onclick={(event) => {
                      event.stopPropagation()
                      void toggleChatFolder(folder)
                    }}>
                    {#if folder.folded}<ChevronRightIcon size={18} aria-hidden="true" />{:else}<ChevronDownIcon
                        size={18}
                        aria-hidden="true" />{/if}
                    <span class="truncate" title={folder.name}>{folder.name}</span>
                  </button>
                {/if}
                <div class="ml-auto flex shrink-0 justify-end">
                  <PopupButton
                    dataAction="folder-more-actions"
                    ariaLabel={`${language.moreActions}: ${folder.name}`}
                    disabled={isFolderStructurePending(folder.id)}>
                    {@render folderActionsMenu(folder, i)}
                  </PopupButton>
                  <button
                    type="button"
                    data-risu-chat-action="folder-options"
                    data-risu-chat-folder-organizer-action={folder.id}
                    aria-label={`${language.options}: ${folder.name}`}
                    disabled={isFolderStructurePending(folder.id)}
                    class="hidden text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                    class:opacity-50={isFolderStructurePending(folder.id)}
                    onclick={(e) => {
                      e.stopPropagation()
                      void openChatFolderOrganizerActions(folder, e.currentTarget)
                    }}>
                    <MenuIcon size={18} />
                  </button>
                  <button
                    type="button"
                    data-risu-chat-action="folder-edit"
                    aria-label={`${language.edit}: ${folder.name}`}
                    disabled={isFolderStructurePending(folder.id)}
                    class="hidden text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                    class:opacity-50={isFolderStructurePending(folder.id)}
                    onclick={(e) => {
                      e.stopPropagation()
                      editMode = !editMode
                    }}>
                    <PencilIcon size={18} />
                  </button>
                  <button
                    type="button"
                    data-risu-chat-action="folder-delete"
                    aria-label={`${language.remove}: ${folder.name}`}
                    disabled={isFolderStructuralActionPending(folder.id)}
                    class="hidden text-textcolor2 hover:text-green-500 cursor-pointer"
                    class:opacity-50={isFolderStructuralActionPending(folder.id)}
                    onclick={async (e) => {
                      e.stopPropagation()
                      await deleteChatFolder(folder, i)
                    }}>
                    <TrashIcon size={18} />
                  </button>
                </div>
              </div>
              <div
                id={`risu-chat-folder-panel-${folder.id}`}
                data-risu-chat-folder-panel-id={folder.id}
                data-risu-sidebar-chat-sortable-list
                hidden={folder.folded}
                role="group"
                aria-label={language.chatFolderContents(folder.name)}
                class="ml-3 flex w-[calc(100%-0.75rem)] flex-col border-l border-darkborderc py-2 pl-2 pr-1 text-textcolor {folder.folded
                  ? 'hidden'
                  : ''}">
                {#if (chatsByFolderId.get(folder.id) ?? []).length == 0}
                  <span class="no-sort flex min-h-11 items-center px-2 text-sm text-textcolor2" role="status">
                    {language.emptyChatFolder(folder.name)}
                  </span>
                  <div></div>
                {:else}
                  {#each chatsByFolderId.get(folder.id) ?? [] as { chat, index }}
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                    <div
                      data-risu-chat-idx={index}
                      data-risu-chat-id={chat.id ?? ''}
                      data-risu-chat-folder-id={chat.folderId ?? ''}
                      data-risu-chat-selected={index === chara.chatPage ? 'true' : 'false'}
                      data-risu-chat-mutation-status={structureMutationForTarget('chat', chat.id)?.status ?? ''}
                      data-risu-chat-reattach-warning={chat.id && reattachWarningChatIds.has(chat.id)
                        ? 'true'
                        : undefined}
                      data-risu-chat-unread={chat.id && $unreadChatIds.has(chat.id) ? 'true' : undefined}
                      aria-busy={isChatStructurePending(chat.id)}
                      aria-current={index === chara.chatPage ? 'page' : undefined}
                      role="listitem"
                      class="risu-chats relative flex min-h-11 items-center text-textcolor border-solid border-0 border-darkborderc cursor-pointer rounded-md"
                      class:bg-selected={index === chara.chatPage}
                      class:ring-1={chat.id && reattachWarningChatIds.has(chat.id)}
                      class:ring-yellow-500={chat.id && reattachWarningChatIds.has(chat.id)}
                      onclick={() => activateChatRow(index)}>
                      {#if editMode}
                        <TextInput
                          bind:value={chatNameDrafts[chat.id ?? '']}
                          className="grow min-w-0"
                          ariaLabel={`${language.edit}: ${chat.name}`}
                          onchange={() => void updateChatName(chat, chatNameDrafts[chat.id ?? ''])}
                          padding={false} />
                      {:else}
                        <ChatSelectionButton
                          name={renderedChatName(chat)}
                          selected={index === chara.chatPage}
                          pinned={chat.pinned === true}
                          onActivate={() => activateChatRow(index)} />
                      {/if}
                      {#if chat.id && reattachWarningChatIds.has(chat.id)}
                        <GenerationIndicator
                          state="warning"
                          label={language.generationReattachFailure.sidebarWarning(renderedChatName(chat))}
                          onActivate={() => activateChatRow(index)} />
                      {:else if chat.id && $unreadChatIds.has(chat.id)}
                        <UnreadIndicator
                          label={`${language.newMessage}: ${renderedChatName(chat)}`}
                          onActivate={() => activateChatRow(index)} />
                      {/if}
                      <div class="ml-auto flex shrink-0 justify-end">
                        <PopupButton
                          dataAction="more-actions"
                          ariaLabel={`${language.moreActions}: ${renderedChatName(chat)}`}
                          disabled={(pendingPersonaBindings[chat.id ?? ''] ?? false) || isChatStructurePending(chat.id)}
                          ariaBusy={(pendingPersonaBindings[chat.id ?? ''] ?? false) ||
                            isChatStructurePending(chat.id)}>
                          {@render chatActionsMenu(chat, index)}
                        </PopupButton>
                        {#if editMode && chat.id && organizerIdsStable}
                          <button
                            type="button"
                            data-risu-chat-action="organize"
                            data-risu-chat-organizer-action={chat.id}
                            aria-label={`${language.options}: ${renderedChatName(chat)}`}
                            disabled={isChatStructuralActionPending(chat.id)}
                            class="sr-only"
                            onclick={(event) => {
                              event.stopPropagation()
                              void openChatOrganizerActions(chat, event.currentTarget)
                            }}>
                            {language.options}
                          </button>
                        {/if}
                        <button
                          type="button"
                          data-risu-chat-action="options"
                          aria-label={`${language.chatOptions}: ${renderedChatName(chat)}`}
                          aria-busy={(pendingPersonaBindings[chat.id ?? ''] ?? false) ||
                            isChatStructurePending(chat.id)}
                          aria-disabled={(pendingPersonaBindings[chat.id ?? ''] ?? false) ||
                            isChatStructurePending(chat.id)}
                          disabled={(pendingPersonaBindings[chat.id ?? ''] ?? false) || isChatStructurePending(chat.id)}
                          class="hidden text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                          class:opacity-50={(pendingPersonaBindings[chat.id ?? ''] ?? false) ||
                            isChatStructurePending(chat.id)}
                          onclick={async (e) => {
                            e.stopPropagation()
                            if (pendingPersonaBindings[chat.id ?? '']) return
                            const option = await alertChatOptions()
                            switch (option) {
                              case 0: {
                                await forkChat(chat)
                                break
                              }
                              case 1: {
                                await togglePersonaBinding(chat.id)
                                break
                              }
                            }
                          }}>
                          <MenuIcon size={18} />
                        </button>
                        <button
                          type="button"
                          data-risu-chat-action="edit"
                          aria-label={`${language.edit}: ${renderedChatName(chat)}`}
                          class="hidden text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                          onclick={(e) => {
                            e.stopPropagation()
                            editMode = !editMode
                          }}>
                          <PencilIcon size={18} />
                        </button>
                        <button
                          type="button"
                          data-risu-chat-action="export"
                          aria-label={`${language.export}: ${renderedChatName(chat)}`}
                          class="hidden text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                          onclick={async (e) => {
                            e.stopPropagation()
                            if (chara.chaId && chat.id) {
                              void exportChatOnDemand(chat.id)
                            }
                          }}>
                          <DownloadIcon size={18} />
                        </button>
                        <button
                          type="button"
                          data-risu-chat-action="delete"
                          aria-label={`${language.remove}: ${renderedChatName(chat)}`}
                          disabled={isChatStructuralActionPending(chat.id)}
                          class="hidden text-textcolor2 hover:text-green-500 cursor-pointer"
                          class:opacity-50={isChatStructuralActionPending(chat.id)}
                          onclick={async (e) => {
                            e.stopPropagation()
                            await deleteChat(chat, chara.chats.indexOf(chat))
                          }}>
                          <TrashIcon size={18} />
                        </button>
                      </div>
                    </div>
                  {/each}
                {/if}
              </div>
            </div>
          {/each}
        </div>
        <div data-risu-sidebar-chat-sortable-list class="flex flex-col" role="list" aria-label={language.chats}>
          {#each chatsByFolderId.get('') ?? [] as { chat, index }}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div
              data-risu-chat-idx={index}
              data-risu-chat-id={chat.id ?? ''}
              data-risu-chat-folder-id={chat.folderId ?? ''}
              data-risu-chat-selected={index === chara.chatPage ? 'true' : 'false'}
              data-risu-chat-mutation-status={structureMutationForTarget('chat', chat.id)?.status ?? ''}
              data-risu-chat-reattach-warning={chat.id && reattachWarningChatIds.has(chat.id) ? 'true' : undefined}
              data-risu-chat-unread={chat.id && $unreadChatIds.has(chat.id) ? 'true' : undefined}
              aria-busy={isChatStructurePending(chat.id)}
              aria-current={index === chara.chatPage ? 'page' : undefined}
              role="listitem"
              class="relative flex min-h-11 items-center text-textcolor border-solid border-0 border-darkborderc cursor-pointer rounded-md"
              class:bg-selected={index === chara.chatPage}
              class:ring-1={chat.id && reattachWarningChatIds.has(chat.id)}
              class:ring-yellow-500={chat.id && reattachWarningChatIds.has(chat.id)}
              onclick={() => activateChatRow(index)}>
              {#if editMode}
                <TextInput
                  bind:value={chatNameDrafts[chat.id ?? '']}
                  className="grow min-w-0"
                  ariaLabel={`${language.edit}: ${chat.name}`}
                  onchange={() => void updateChatName(chat, chatNameDrafts[chat.id ?? ''])}
                  padding={false} />
              {:else}
                <ChatSelectionButton
                  name={renderedChatName(chat)}
                  selected={index === chara.chatPage}
                  pinned={chat.pinned === true}
                  onActivate={() => activateChatRow(index)} />
              {/if}
              {#if chat.id && reattachWarningChatIds.has(chat.id)}
                <GenerationIndicator
                  state="warning"
                  label={language.generationReattachFailure.sidebarWarning(renderedChatName(chat))}
                  onActivate={() => activateChatRow(index)} />
              {:else if chat.id && $unreadChatIds.has(chat.id)}
                <UnreadIndicator
                  label={`${language.newMessage}: ${renderedChatName(chat)}`}
                  onActivate={() => activateChatRow(index)} />
              {/if}
              <div class="ml-auto flex shrink-0 justify-end">
                <PopupButton
                  dataAction="more-actions"
                  ariaLabel={`${language.moreActions}: ${renderedChatName(chat)}`}
                  disabled={(pendingPersonaBindings[chat.id ?? ''] ?? false) || isChatStructurePending(chat.id)}
                  ariaBusy={(pendingPersonaBindings[chat.id ?? ''] ?? false) || isChatStructurePending(chat.id)}>
                  {@render chatActionsMenu(chat, index)}
                </PopupButton>
                {#if editMode && chat.id && organizerIdsStable}
                  <button
                    type="button"
                    data-risu-chat-action="organize"
                    data-risu-chat-organizer-action={chat.id}
                    aria-label={`${language.options}: ${renderedChatName(chat)}`}
                    disabled={isChatStructuralActionPending(chat.id)}
                    class="sr-only"
                    onclick={(event) => {
                      event.stopPropagation()
                      void openChatOrganizerActions(chat, event.currentTarget)
                    }}>
                    {language.options}
                  </button>
                {/if}
                <button
                  type="button"
                  data-risu-chat-action="options"
                  aria-label={`${language.chatOptions}: ${renderedChatName(chat)}`}
                  aria-busy={(pendingPersonaBindings[chat.id ?? ''] ?? false) || isChatStructurePending(chat.id)}
                  aria-disabled={(pendingPersonaBindings[chat.id ?? ''] ?? false) || isChatStructurePending(chat.id)}
                  disabled={(pendingPersonaBindings[chat.id ?? ''] ?? false) || isChatStructurePending(chat.id)}
                  class="hidden text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                  class:opacity-50={(pendingPersonaBindings[chat.id ?? ''] ?? false) || isChatStructurePending(chat.id)}
                  onclick={async (e) => {
                    e.stopPropagation()
                    if (pendingPersonaBindings[chat.id ?? '']) return
                    const option = await alertChatOptions()
                    switch (option) {
                      case 0: {
                        await forkChat(chat)
                        break
                      }
                      case 1: {
                        await togglePersonaBinding(chat.id)
                        break
                      }
                    }
                  }}>
                  <MenuIcon size={18} />
                </button>
                <button
                  type="button"
                  data-risu-chat-action="edit"
                  aria-label={`${language.edit}: ${renderedChatName(chat)}`}
                  class="hidden text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                  onclick={(e) => {
                    e.stopPropagation()
                    editMode = !editMode
                  }}>
                  <PencilIcon size={18} />
                </button>
                <button
                  type="button"
                  data-risu-chat-action="export"
                  aria-label={`${language.export}: ${renderedChatName(chat)}`}
                  class="hidden text-textcolor2 hover:text-green-500 mr-1 cursor-pointer"
                  onclick={async (e) => {
                    e.stopPropagation()
                    if (chara.chaId && chat.id) {
                      void exportChatOnDemand(chat.id)
                    }
                  }}>
                  <DownloadIcon size={18} />
                </button>
                <button
                  type="button"
                  data-risu-chat-action="delete"
                  aria-label={`${language.remove}: ${renderedChatName(chat)}`}
                  disabled={isChatStructuralActionPending(chat.id)}
                  class="hidden text-textcolor2 hover:text-green-500 cursor-pointer"
                  class:opacity-50={isChatStructuralActionPending(chat.id)}
                  onclick={async (e) => {
                    e.stopPropagation()
                    await deleteChat(chat, index)
                  }}>
                  <TrashIcon size={18} />
                </button>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/key}

    <div class="border-t border-selected mt-2">
      <div class="flex mt-2 ml-2 items-center">
        <button
          data-risu-chat-action="export-all"
          aria-label={language.chatListExportAll}
          class="mr-1 flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md text-textcolor2 hover:bg-selected hover:text-textcolor"
          onclick={() => {
            void exportAllAndMaybeResetChats()
          }}>
          <DownloadIcon size={18} />
        </button>
        <button
          data-risu-chat-action="import"
          aria-label={language.chatListImport}
          class="mr-1 flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md text-textcolor2 hover:bg-selected hover:text-textcolor"
          onclick={() => {
            void importChatOnDemand()
          }}>
          <HardDriveUploadIcon size={18} />
        </button>
        <button
          data-risu-chat-action="edit-list"
          aria-label={language.chatListEdit}
          aria-pressed={editMode}
          class="mr-1 flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md text-textcolor2 hover:bg-selected hover:text-textcolor"
          onclick={() => {
            editMode = !editMode
          }}>
          <PencilIcon size={18} />
        </button>
        <button
          data-risu-chat-action="branches"
          aria-label={language.branch}
          class="mr-1 flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md text-textcolor2 hover:bg-selected hover:text-textcolor"
          onclick={async () => {
            if (!hasStableOrganizationIds()) return
            const ownerCharacterId = chara.chaId
            const ownerSelectedCharacterIndex =
              charactersResourceState.status === 'ready' ? charactersResourceState.currentChar : $selectedCharID
            const ownerCharacterReference = chara
            const run = ++branchGraphHydrationRun
            const isFresh = () =>
              run === branchGraphHydrationRun &&
              isCurrentBranchGraphOwner(ownerCharacterId, ownerSelectedCharacterIndex, ownerCharacterReference)
            if (!isFresh()) return

            // Branch tree hashes require all lazily-loaded chats first.
            try {
              await ensureAllChatsHydrated({ strict: true })
            } catch (error) {
              if (isFresh()) alertError(error)
              return
            }
            if (!isFresh()) return
            alertStore.set({
              type: 'branches',
              msg: '',
            })
          }}>
          <SplitIcon size={18} />
        </button>
        <button
          data-risu-chat-action="bookmarks"
          aria-label={language.bookmarks}
          class="mr-1 flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md text-textcolor2 hover:bg-selected hover:text-textcolor"
          onclick={() => {
            $bookmarkListOpen = true
          }}>
          <BookmarkCheckIcon size={18} />
        </button>
        <button
          data-risu-chat-action="create-folder"
          aria-label={language.chatListCreateFolder}
          aria-busy={hasConflictingStructureMutation([folderOrderConflictKey()])}
          disabled={hasConflictingStructureMutation([folderOrderConflictKey()])}
          class="ml-auto mr-1 flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md text-textcolor2 hover:bg-selected hover:text-textcolor"
          class:opacity-50={hasConflictingStructureMutation([folderOrderConflictKey()])}
          onclick={() => void createChatFolder()}>
          <FolderPlusIcon size={18} />
        </button>
      </div>
    </div>
  {/if}
</div>
