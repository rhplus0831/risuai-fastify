<script lang="ts" module>
  import type { loreBook as LoreBookEntry } from '../../../ts/storage/database.svelte'

  export interface LorebookDeletionTarget {
    id?: string
    mode: LoreBookEntry['mode']
    folderKey?: string
    index: number
    snapshot: LoreBookEntry
    localActivationCleanup?: {
      chatId: string
      entryId: string
      displayScopeKey: string
    }
  }
</script>

<script lang="ts">
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'
  import { writerDraftValueFields } from 'src/ts/server/writerDraftFields'

  import { XIcon, LinkIcon, SunIcon, BookCopyIcon, FolderIcon, FolderOpen, PlusIcon } from '@lucide/svelte'
  import { language } from '../../../lang'
  import type { Chat, character, loreBook } from '../../../ts/storage/database.svelte'
  import { alertConfirm, alertError, alertMd, alertNormal } from '../../../ts/alert'
  import Check from '../../UI/GUI/CheckInput.svelte'
  import Help from '../../Others/Help.svelte'
  import TextInput from '../../UI/GUI/TextInput.svelte'
  import NumberInput from '../../UI/GUI/NumberInput.svelte'
  import TextAreaInput from '../../UI/GUI/TextAreaInput.svelte'
  import { tokenizeAccurate } from 'src/ts/tokenizer'
  import LoreBookList from './LoreBookList.svelte'
  import {
    applyLorebookEntryDraftRollback,
    changedLorebookEntryDraftFields,
    clearDirtyLorebookEntryFieldsMatchingProjection,
    mergeLorebookEntryProjectionDraft,
    setActiveChatLorebookLocalActivationWithOutcome,
    setChatLorebookLocalActivationWithOutcome,
    subscribeLorebookEntryDraftRollbacks,
    type LorebookEntryDirtyField,
    type ScopedLorebookMutationOperation,
  } from 'src/ts/server/lorebookOwner.svelte'
  import {
    findScopedLorebookLocalActivationMutationUiState,
    scopedLorebookMutationUiStates,
    trackScopedLorebookMutationUiOperation,
    type ScopedLorebookMutationUiContext,
  } from 'src/ts/server/scopedLorebookMutationUiState'
  import { onDestroy, onMount } from 'svelte'
  import { isAgentOnlyLorebookEntry } from '@risuai/shared-core/agent-only-lorebook'
  import { selectedCharID } from 'src/ts/stores.svelte'
  import {
    charactersResourceState,
    getCharacterResourceOwner,
    settingsResourceState,
  } from 'src/ts/server/resourceState.svelte'

  const tokenCountCache = new Map<string, number>()
  const MAX_TOKEN_COUNT_CACHE = 500

  interface Props {
    value: loreBook
    onRemove?: (target: LorebookDeletionTarget) => void
    onClose?: (isDetail?: boolean) => void
    onOpen?: (isDetail?: boolean) => void
    lorePlus?: boolean
    idx: number
    externalLoreBooks?: loreBook[]
    idgroup: string
    isOpen?: boolean
    openFolders?: number
    isLastInContainer?: boolean
    onCollectionChange?: (entries: loreBook[]) => void
    onEntryChange?: (index: number, entry: loreBook) => void
    onEntrySettled?: (index: number) => void
    onDraftChange?: ((entry: loreBook) => void) | null
    onDraftSettled?: () => void
    entryDraftScopeKey?: string
    mutationLocked?: boolean
  }

  let {
    value = $bindable(),
    onRemove = () => {},
    onClose = (isDetail = true) => {},
    onOpen = (isDetail = true) => {},
    lorePlus = false,
    idx,
    externalLoreBooks = $bindable(),
    idgroup,
    isOpen = false,
    openFolders = 0,
    isLastInContainer = false,
    onCollectionChange = (entries: loreBook[]) => {
      externalLoreBooks = entries
    },
    onEntryChange = (index: number, entry: loreBook) => {
      const entries = [...(externalLoreBooks ?? [])]
      entries[index] = entry
      updateCollection(entries)
    },
    onEntrySettled = () => {},
    onDraftChange = null,
    onDraftSettled = () => {},
    entryDraftScopeKey = undefined,
    mutationLocked = false,
  }: Props = $props()

  let open = $derived(isOpen)
  let draft = $state<loreBook>(cloneJsonValue(value))
  let suppressDraftDispatch = false
  let draftInitialized = false
  let draftTargetKey = lorebookEntryDraftTargetKey(value)
  const dirtyDraftFields = new Set<LorebookEntryDirtyField>()
  let recoveryBaseline = cloneJsonValue(value)
  let previousValueSnapshot = snapshotJson(value)
  let lastDraftDispatchSnapshot = snapshotJson(value)
  let draftNeedsSettlement = false
  let deletionCommitted = false
  let tokenPromise = $state<Promise<number> | null>(null)

  function characterOwners(): readonly character[] {
    return charactersResourceState.status === 'ready' ? charactersResourceState.characters : []
  }

  function selectedCharacterOwner(): character | undefined {
    const selectedIndex =
      charactersResourceState.selectionRevision !== null ? charactersResourceState.currentChar : $selectedCharID
    const candidate = characterOwners()[selectedIndex]
    if (typeof candidate?.chaId !== 'string' || !candidate.chaId.trim()) return undefined
    return getCharacterResourceOwner(candidate.chaId) === candidate ? candidate : undefined
  }

  function selectedChatOwner(): Chat | undefined {
    const character = selectedCharacterOwner()
    const candidate = character?.chats?.[character.chatPage ?? 0]
    if (!character || typeof candidate?.id !== 'string' || !candidate.id.trim()) return undefined

    let owner: { character: character; chat: Chat } | undefined
    for (const characterOwner of characterOwners()) {
      for (const chatOwner of characterOwner.chats ?? []) {
        if (chatOwner?.id !== candidate.id) continue
        if (owner) return undefined
        owner = { character: characterOwner, chat: chatOwner }
      }
    }
    return owner?.character === character ? owner.chat : undefined
  }

  function localActivationSettingEnabled(): boolean {
    if (settingsResourceState.groupStatuses.sidebar !== 'ready') return false
    return settingsResourceState.value.localActivationInGlobalLorebook === true
  }

  let localActivationScopeKey = $derived.by(() => {
    const chatId = selectedChatOwner()?.id
    return chatId ? `chat:${chatId}` : null
  })
  let localActivationState = $derived(
    findScopedLorebookLocalActivationMutationUiState(
      $scopedLorebookMutationUiStates,
      localActivationScopeKey,
      draft.id,
    ),
  )
  let localActivationStatus = $derived(localActivationState?.status ?? 'idle')
  let supportsAgentOnly = $derived(
    entryDraftScopeKey?.startsWith('character:') === true || entryDraftScopeKey?.startsWith('chat:') === true,
  )

  function trackLocalActivation(
    operation: ScopedLorebookMutationOperation | null,
    entryId: string | undefined,
    options: { displayScopeKey?: string | null; context?: ScopedLorebookMutationUiContext } = {},
  ): void {
    const cleanup = options.context === 'local-activation-cleanup'
    trackScopedLorebookMutationUiOperation({
      operation,
      kind: 'local-activation',
      entryId,
      displayScopeKey: options.displayScopeKey ?? entryDraftScopeKey,
      context: options.context,
      onQueued: () =>
        alertNormal(
          cleanup
            ? language.scopedLorebookMutation.localActivationCleanupQueued
            : language.scopedLorebookMutation.queued,
        ),
      onFailed: (error) =>
        alertError(
          cleanup
            ? language.scopedLorebookMutation.localActivationCleanupFailed(error)
            : language.scopedLorebookMutation.failed(error),
        ),
    })
  }

  $effect(() => {
    const valueSnapshot = snapshotJson(value)
    const nextTargetKey = lorebookEntryDraftTargetKey(value)
    const targetChanged = nextTargetKey !== draftTargetKey

    if (targetChanged) {
      dirtyDraftFields.clear()
      draftTargetKey = nextTargetKey
    }

    if (targetChanged || valueSnapshot !== previousValueSnapshot) {
      recoveryBaseline = cloneJsonValue(value)
    }
    if (valueSnapshot !== previousValueSnapshot) {
      const draftSnapshot = snapshotJson(draft)
      if (!targetChanged && dirtyDraftFields.size > 0) {
        clearDirtyLorebookEntryFieldsMatchingProjection(dirtyDraftFields, draft, value)
      }
      if (valueSnapshot !== draftSnapshot) {
        suppressDraftDispatch = true
        if (!targetChanged && dirtyDraftFields.size > 0) {
          draft = mergeLorebookEntryProjectionDraft(draft, value, dirtyDraftFields)
          lastDraftDispatchSnapshot = snapshotJson(draft)
        } else {
          draft = cloneJsonValue(value)
          lastDraftDispatchSnapshot = valueSnapshot
        }
        queueMicrotask(() => {
          suppressDraftDispatch = false
        })
      }
    }
    previousValueSnapshot = valueSnapshot
  })

  $effect(() => {
    if (!draftInitialized) {
      draftInitialized = true
      return
    }
    if (suppressDraftDispatch) return
    propagateDraft(false)
  })

  onMount(() =>
    subscribeLorebookEntryDraftRollbacks((event) => {
      const rollback = applyLorebookEntryDraftRollback(draft, event, entryDraftScopeKey)
      if (rollback.restoredFields.length === 0) return

      for (const field of rollback.restoredFields) dirtyDraftFields.delete(field)
      suppressDraftDispatch = true
      draft = rollback.draft
      lastDraftDispatchSnapshot = snapshotJson(draft)
      queueMicrotask(() => {
        suppressDraftDispatch = false
      })
    }),
  )

  $effect(() => {
    if (!open || draft.mode === 'folder') {
      tokenPromise = null
      return
    }
    tokenPromise = getTokens(draft.content ?? '', draft.id ?? `${idx}`)
  })

  function updateCollection(entries: loreBook[]): void {
    onCollectionChange(cloneJsonValue(entries ?? []))
  }

  function propagateDraft(settled: boolean): void {
    const draftSnapshot = snapshotJson(draft)
    if (draftSnapshot !== lastDraftDispatchSnapshot) {
      const previousDraft = parseLorebookEntrySnapshot(lastDraftDispatchSnapshot)
      for (const field of changedLorebookEntryDraftFields(previousDraft, draft)) {
        dirtyDraftFields.add(field)
      }
      const next = cloneJsonValue(draft)
      if (onDraftChange) {
        onDraftChange(next)
      } else {
        value = next
      }
      previousValueSnapshot = draftSnapshot
      lastDraftDispatchSnapshot = draftSnapshot
      draftNeedsSettlement = true
    }
    if (settled && draftNeedsSettlement) {
      draftNeedsSettlement = false
      onDraftSettled()
    }
  }

  function settleDraftSoon(): void {
    queueMicrotask(() => propagateDraft(true))
  }

  function settleWhenFocusLeaves(event: FocusEvent): void {
    const currentTarget = event.currentTarget
    if (!(currentTarget instanceof HTMLElement)) return
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && currentTarget.contains(nextTarget)) return
    settleDraftSoon()
  }

  function closeOpenRegistration(): void {
    if (!open) return
    open = false
    onClose(draft.mode !== 'folder')
  }

  onDestroy(
    registerWriterDraftCapture(() => {
      if (deletionCommitted) return null
      if (entryDraftScopeKey?.startsWith('module:') && snapshotJson(draft) === lastDraftDispatchSnapshot) return null
      const fields = writerDraftValueFields(
        draft as unknown as Record<string, unknown>,
        recoveryBaseline as unknown as Record<string, unknown>,
        {
          comment: language.name,
          content: language.prompt,
          key: language.key,
        },
      )
      if (fields.length === 0) return null
      return {
        key: `lorebook:${draftTargetKey}`,
        label: `${language.loreBook}: ${draft.comment || draft.key || draft.id || idx + 1}`,
        fields,
        data: $state.snapshot(draft),
        baseline: recoveryBaseline,
      }
    }),
  )

  onDestroy(() => {
    closeOpenRegistration()
    if (!deletionCommitted) propagateDraft(true)
    dirtyDraftFields.clear()
  })

  function lorebookEntryDraftTargetKey(entry: loreBook): string {
    const scopeKey = entryDraftScopeKey ?? ''
    if (typeof entry?.id === 'string' && entry.id.trim()) return `${scopeKey}:entry:${entry.id}`
    return `${scopeKey}:fallback:${idgroup}:${idx}`
  }

  function parseLorebookEntrySnapshot(snapshot: string): loreBook {
    if (!snapshot || snapshot === '__undefined__') return {} as loreBook
    return JSON.parse(snapshot) as loreBook
  }

  function snapshotJson(value: unknown): string {
    const snapshot = JSON.stringify(value)
    return snapshot === undefined ? '__undefined__' : snapshot
  }

  function cloneJsonValue<T>(value: T): T {
    if (value === undefined) return value
    return JSON.parse(JSON.stringify(value)) as T
  }

  function captureDeletionTarget(): LorebookDeletionTarget {
    const snapshot = cloneJsonValue(draft)
    const id = typeof snapshot.id === 'string' && snapshot.id.trim() ? snapshot.id : undefined
    const currentChat = selectedChatOwner()
    const localActivationCleanup =
      id &&
      entryDraftScopeKey?.startsWith('character:') &&
      currentChat?.id &&
      currentChat.localLore?.some((entry) => entry.id === id && entry.mode === 'child')
        ? { chatId: currentChat.id, entryId: id, displayScopeKey: entryDraftScopeKey }
        : undefined
    return {
      id,
      mode: snapshot.mode,
      folderKey: snapshot.mode === 'folder' ? (snapshot.key ?? '') : undefined,
      index: idx,
      snapshot,
      ...(localActivationCleanup ? { localActivationCleanup } : {}),
    }
  }

  function removeCapturedLocalActivation(target: LorebookDeletionTarget): void {
    const cleanup = target.localActivationCleanup
    if (!cleanup) return
    trackLocalActivation(
      setChatLorebookLocalActivationWithOutcome(cleanup.chatId, target.snapshot, false),
      cleanup.entryId,
      {
        displayScopeKey: cleanup.displayScopeKey,
        context: 'local-activation-cleanup',
      },
    )
  }

  async function getTokens(data: string, cacheId: string) {
    const cacheKey = `${cacheId}:${data}`
    const cached = tokenCountCache.get(cacheKey)
    if (cached !== undefined) return cached

    await delayExpensiveDetailWork()
    const counted = await tokenizeAccurate(data)
    tokenCountCache.set(cacheKey, counted)
    if (tokenCountCache.size > MAX_TOKEN_COUNT_CACHE) {
      const oldest = tokenCountCache.keys().next().value
      if (oldest !== undefined) tokenCountCache.delete(oldest)
    }
    return counted
  }

  function delayExpensiveDetailWork(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        setTimeout(resolve, 0)
      })
    })
  }

  function isLocallyActivated(book: loreBook) {
    return book.id ? selectedChatOwner()?.localLore.some((e) => e.id === book.id) : false
  }
  function toggleLocalActive(check: boolean, book: loreBook) {
    if (localActivationStatus === 'pending') return
    trackLocalActivation(setActiveChatLorebookLocalActivationWithOutcome(book, check), book.id)
  }

  function setAgentOnly(check: boolean): void {
    if (check && !supportsAgentOnly) return
    draft.agentOnly = check
    draft.extentions = {
      ...draft.extentions,
      risu_case_sensitive: draft.extentions?.risu_case_sensitive ?? false,
      risu_agent_only: check,
    }
    if (check) {
      draft.alwaysActive = false
      draft.key = ''
      draft.secondkey = ''
      draft.selective = false
      draft.useRegex = false
    }
    settleDraftSoon()
  }
  function getParentLoreName(book: loreBook) {
    if (book.mode === 'child') {
      const value = selectedCharacterOwner()?.globalLore.find((e) => e.id === book.id)
      if (value) {
        return value.comment.length === 0 ? (value.key.length === 0 ? 'Unnamed Lore' : value.key) : value.comment
      }
    }
  }

  function lorebookDisplayName(book: loreBook): string {
    if (book.mode === 'child') return getParentLoreName(book) || `#${idx + 1}`
    if (book.comment?.length) return book.comment
    if (book.mode !== 'folder' && book.key?.length) return book.key
    return `#${idx + 1}`
  }
</script>

<div
  class={'w-full flex flex-col ' +
    (isLastInContainer
      ? 'pb-0 mb-0 border-0' // Last item in container: no border
      : 'pb-2 mb-2 border-b border-b-selected last:pb-0 last:mb-0 last:border-0')}
  class:no-sort={draft.mode === 'folder' && openFolders > 0}
  data-risu-idx={idx}
  data-risu-lorebook-row="true"
  data-risu-lorebook-id={draft.id ?? ''}
  data-risu-lorebook-mode={draft.mode}
  data-risu-lorebook-folder={draft.folder ?? ''}
  data-risu-lorebook-key={draft.key ?? ''}
  data-risu-idgroup={idgroup}>
  <div class="flex items-center transition-colors w-full p-1">
    {#if draft.mode !== 'child'}
      <button
        class="endflex valuer border-darkborderc flex items-center"
        aria-expanded={open}
        onclick={() => {
          if (!open) {
            open = true
            onOpen(draft.mode !== 'folder')
          } else {
            settleDraftSoon()
            closeOpenRegistration()
          }
        }}>
        {#if draft.mode === 'folder'}
          {#if open}
            <FolderOpen size={20} class="mr-1" />
          {:else}
            <FolderIcon size={20} class="mr-1" />
          {/if}
        {/if}
        {#if draft.mode === 'folder'}
          <span>{draft.comment.length === 0 ? 'Unnamed Folder' : draft.comment}</span>
        {:else}
          <span
            >{draft.comment.length === 0 ? (draft.key.length === 0 ? 'Unnamed Lore' : draft.key) : draft.comment}</span>
        {/if}
      </button>
      <button
        class="mr-1"
        aria-label={`${draft.alwaysActive ? language.disable : language.enable}: ${language.alwaysActive} (${lorebookDisplayName(draft)})`}
        aria-pressed={draft.alwaysActive}
        disabled={mutationLocked || isAgentOnlyLorebookEntry(draft)}
        class:text-textcolor2={!draft.alwaysActive}
        class:text-textcolor={draft.alwaysActive}
        onclick={async () => {
          if (isAgentOnlyLorebookEntry(draft)) return
          if (draft.mode === 'folder') {
            updateCollection(
              (externalLoreBooks ?? []).map((entry) =>
                entry.folder === draft.key ? { ...entry, alwaysActive: !draft.alwaysActive } : entry,
              ),
            )
          }
          draft.alwaysActive = !draft.alwaysActive
          settleDraftSoon()
        }}>
        {#if draft.alwaysActive}
          <SunIcon size={20} />
        {:else}
          <LinkIcon size={20} />
        {/if}
      </button>
      <button
        class="valuer"
        aria-label={`${language.remove}: ${lorebookDisplayName(draft)}`}
        disabled={mutationLocked}
        onclick={async () => {
          const target = captureDeletionTarget()
          let shouldRemove = true
          if (target.mode === 'folder' && (externalLoreBooks ?? []).some((e) => e.folder === target.folderKey)) {
            const firstConfirm = await alertConfirm(language.folderRemoveConfirm)
            if (!firstConfirm) {
              shouldRemove = false
            }
          }

          if (shouldRemove) {
            const secondConfirm = await alertConfirm(
              language.removeConfirm + (target.snapshot.comment || 'Unnamed Folder'),
            )
            if (secondConfirm) {
              deletionCommitted = true
              closeOpenRegistration()
              removeCapturedLocalActivation(target)
              onRemove(target)
            }
          }
        }}
        data-risu-lorebook-action="delete">
        <XIcon size={20} />
      </button>
    {:else}
      <button class="endflex valuer border-darkborderc" onclick={() => alertMd(language.childLoreDesc)}>
        <BookCopyIcon size={20} class="mr-1" />
        <span>{getParentLoreName(draft)}</span>
      </button>
      <button
        class="valuer"
        aria-label={`${language.remove}: ${lorebookDisplayName(draft)}`}
        disabled={mutationLocked}
        onclick={async () => {
          const target = captureDeletionTarget()
          const d = await alertConfirm(language.removeConfirm + getParentLoreName(target.snapshot))
          if (d) {
            deletionCommitted = true
            closeOpenRegistration()
            onRemove(target)
          }
        }}
        data-risu-lorebook-action="delete">
        <XIcon size={20} />
      </button>
    {/if}
  </div>
  {#if open}
    {#if draft.mode === 'folder'}
      <div class="border-0 outline-hidden w-full mt-2 flex flex-col mb-2" onfocusout={settleWhenFocusLeaves}>
        <span class="text-textcolor mt-6 mb-2">{language.folderName}</span>
        <TextInput size="sm" bind:value={draft.comment} />

        <div class="mt-4">
          <LoreBookList
            {externalLoreBooks}
            {entryDraftScopeKey}
            {mutationLocked}
            showFolder={draft.key}
            {onCollectionChange}
            {onEntryChange}
            {onEntrySettled} />
        </div>

        <div class="mt-2 flex gap-1">
          <button
            class="text-textcolor2 hover:text-textcolor"
            aria-label={`${language.add}: ${language.loreBook} (${lorebookDisplayName(draft)})`}
            disabled={mutationLocked}
            onclick={() => {
              updateCollection([
                ...(externalLoreBooks ?? []),
                {
                  key: '',
                  comment: '',
                  content: '',
                  mode: 'normal',
                  insertorder: 100,
                  alwaysActive: true,
                  secondkey: '',
                  selective: false,
                  folder: draft.key,
                },
              ])
            }}>
            <PlusIcon size={20} />
          </button>
        </div>
      </div>
    {:else}
      <div class="border-0 outline-hidden w-full mt-2 flex flex-col mb-2" onfocusout={settleWhenFocusLeaves}>
        <span class="text-textcolor mt-6">{language.name} <Help key="loreName" /></span>
        <TextInput size="sm" bind:value={draft.comment} />
        {#if !lorePlus}
          {#if !draft.alwaysActive && !isAgentOnlyLorebookEntry(draft)}
            <span class="text-textcolor mt-6">{language.activationKeys} <Help key="loreActivationKey" /></span>
            <span class="text-xs text-textcolor2">{language.activationKeysInfo}</span>
            <TextInput size="sm" bind:value={draft.key} />

            {#if draft.selective}
              <span class="text-textcolor mt-6">{language.SecondaryKeys}</span>
              <span class="text-xs text-textcolor2">{language.activationKeysInfo}</span>
              <TextInput size="sm" bind:value={draft.secondkey} />
            {/if}
          {/if}
        {/if}
        {#if !lorePlus}
          {#if !(draft.activationPercent === undefined || draft.activationPercent === null)}
            <span class="text-textcolor mt-6">{language.activationProbability}</span>
            <NumberInput
              size="sm"
              bind:value={draft.activationPercent}
              onChange={() => {
                if (isNaN(draft.activationPercent) || !draft.activationPercent || draft.activationPercent < 0) {
                  draft.activationPercent = 0
                }
                if (draft.activationPercent > 100) {
                  draft.activationPercent = 100
                }
              }} />
          {/if}
        {/if}
        {#if !lorePlus}
          <span class="text-textcolor mt-4">{language.insertOrder} <Help key="loreorder" /></span>
          <NumberInput size="sm" bind:value={draft.insertorder} min={0} max={1000} />
        {/if}
        <span class="text-textcolor mt-4 mb-2">{language.prompt}</span>
        <TextAreaInput highlight autocomplete="off" bind:value={draft.content} />
        {#if tokenPromise}
          {#await tokenPromise}
            <span class="text-textcolor2 mt-2 mb-2 text-sm">... {language.tokens}</span>
          {:then e}
            <span class="text-textcolor2 mt-2 mb-2 text-sm">{e} {language.tokens}</span>
          {/await}
        {/if}
        {#if supportsAgentOnly || isAgentOnlyLorebookEntry(draft)}
          <div class="flex items-center mt-4">
            <Check
              check={isAgentOnlyLorebookEntry(draft)}
              disabled={mutationLocked}
              onChange={setAgentOnly}
              name={language.agentOnlyLorebook} />
            <Help key="agentOnlyLorebook" name={language.agentOnlyLorebook} />
          </div>
          <p class="m-0 mt-1 text-xs text-textcolor2">{language.agentOnlyLorebookDescription}</p>
        {/if}
        <div class="flex items-center mt-2">
          <Check
            bind:check={draft.alwaysActive}
            disabled={isAgentOnlyLorebookEntry(draft)}
            name={language.alwaysActive} />
        </div>
        {#if !isAgentOnlyLorebookEntry(draft) && !draft.alwaysActive && selectedCharacterOwner()?.globalLore?.some((entry) => entry.id && draft.id && entry.id === draft.id) && localActivationSettingEnabled()}
          <div class="flex items-center mt-2">
            <Check
              check={isLocallyActivated(draft)}
              onChange={(check: boolean) => toggleLocalActive(check, draft)}
              disabled={mutationLocked || localActivationStatus === 'pending'}
              name={language.alwaysActiveInChat} />
          </div>
          {#if localActivationStatus !== 'idle'}
            <p
              class="m-0 mt-1 text-xs"
              class:text-red-400={localActivationStatus === 'failed'}
              class:text-textcolor2={localActivationStatus !== 'failed'}
              data-risu-lorebook-local-activation={localActivationStatus}
              role={localActivationStatus === 'failed' ? 'alert' : 'status'}
              aria-live={localActivationStatus === 'failed' ? 'assertive' : 'polite'}>
              {localActivationStatus === 'pending'
                ? language.scopedLorebookMutation.pending
                : localActivationState?.context === 'local-activation-cleanup'
                  ? localActivationStatus === 'queued'
                    ? language.scopedLorebookMutation.localActivationCleanupQueued
                    : language.scopedLorebookMutation.localActivationCleanupFailed(localActivationState?.error ?? '')
                  : localActivationStatus === 'queued'
                    ? language.scopedLorebookMutation.queued
                    : language.scopedLorebookMutation.failed(localActivationState?.error ?? '')}
            </p>
          {/if}
        {/if}
        {#if !isAgentOnlyLorebookEntry(draft) && !lorePlus && !draft.useRegex}
          <div class="flex items-center mt-2">
            <Check bind:check={draft.selective} name={language.selective} />
            <Help key="loreSelective" name={language.selective} />
          </div>
        {/if}
        {#if !isAgentOnlyLorebookEntry(draft) && !lorePlus && !draft.alwaysActive}
          <div class="flex items-center mt-2">
            <Check bind:check={draft.useRegex} name={language.useRegexLorebook} />
            <Help key="useRegexLorebook" name={language.useRegexLorebook} />
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .valuer:hover {
    color: rgba(16, 185, 129, 1);
    cursor: pointer;
  }

  .endflex {
    display: flex;
    flex-grow: 1;
    cursor: pointer;
  }

  /* Styles for SortableJS drag-and-drop feedback */
  :global(.risu-chosen-item) {
    /* The item being dragged */
    padding-bottom: 0.5rem;
    margin-bottom: 0.5rem;
    border-bottom: 1px solid;
    border-bottom-color: var(--risu-theme-selected);
    opacity: 0.7;
  }

  :global(.risu-ghost-item) {
    /* The placeholder for the drop location */
    background-color: rgba(var(--risu-theme-selected-rgb), 0.2);
  }
</style>
