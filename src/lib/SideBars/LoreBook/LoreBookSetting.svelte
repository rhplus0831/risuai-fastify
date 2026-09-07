<script lang="ts">
  import { onDestroy } from 'svelte'
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'
  import { writerDraftValueFields } from 'src/ts/server/writerDraftFields'

  import type { Chat, character, Database } from 'src/ts/storage/database.svelte'
  import { language } from '../../../lang'
  import {
    DownloadIcon,
    HardDriveUploadIcon,
    PlusIcon,
    SunIcon,
    LinkIcon,
    FolderPlusIcon,
    RefreshCcwIcon,
  } from '@lucide/svelte'
  import { addLorebook, addLorebookFolder, exportLoreBook, importLoreBook } from '../../../ts/process/lorebook.svelte'
  import Check from '../../UI/GUI/CheckInput.svelte'
  import NumberInput from '../../UI/GUI/NumberInput.svelte'
  import LoreBookList from './LoreBookList.svelte'
  import Help from 'src/lib/Others/Help.svelte'
  import { selectedCharID } from 'src/ts/stores.svelte'
  import {
    replaceCharacterLorebookCollectionWithOutcome,
    replaceChatLorebookCollectionWithOutcome,
    type ScopedLorebookMutationOperation,
  } from 'src/ts/server/lorebookOwner.svelte'
  import { alertError, alertNormal } from 'src/ts/alert'
  import {
    findScopedLorebookCollectionMutationUiState,
    scopedLorebookMutationUiStates,
    trackScopedLorebookMutationUiOperation,
  } from 'src/ts/server/scopedLorebookMutationUiState'
  import { createCharacterOwnerDraft } from 'src/ts/server/characterDraft.svelte'
  import {
    hasCharacterLorebookHydrationFailed,
    hydrateActiveCharacterLorebook,
    isCharacterLorebookHydrationPending,
  } from 'src/ts/server/chatMessageHydration.svelte'
  import { lorebookPageIndexFromSnapshot, lorebookPageOwnerState } from 'src/ts/server/lorebookPageOwner.svelte'
  import {
    charactersResourceState,
    collectionsResourceState,
    getCharacterResourceOwner,
    settingsResourceState,
  } from 'src/ts/server/resourceState.svelte'

  let submenu = $state(0)
  const characterLoreSettingsDraft = createCharacterOwnerDraft(['loreSettings', 'lorePlus'])
  onDestroy(
    registerWriterDraftCapture(() => {
      const recovery = characterLoreSettingsDraft.captureRecoveryDraft()
      if (!recovery || globalMode) return null
      return {
        key: `character-lore-settings:${recovery.characterId}`,
        label: language.loreBook,
        fields: writerDraftValueFields(recovery.value, recovery.baseline),
        data: recovery.value,
        baseline: recovery.baseline,
      }
    }),
  )
  interface Props {
    globalMode?: boolean
  }

  let { globalMode = $bindable(false) }: Props = $props()

  type GlobalLorebook = Database['loreBook'][number]
  type LorebookAdvancedSetting = 'bulkEnabling' | 'loreBookDepth' | 'loreBookToken' | 'useExperimental'

  function characterOwners(): readonly character[] {
    return charactersResourceState.status === 'ready' ? charactersResourceState.characters : []
  }

  function uniqueCharacterOwner(characterId: string | undefined): character | undefined {
    if (!characterId) return undefined
    if (charactersResourceState.status === 'ready') return getCharacterResourceOwner(characterId)
    const matches = characterOwners().filter((candidate) => candidate?.chaId === characterId)
    return matches.length === 1 ? matches[0] : undefined
  }

  function selectedCharacterIndex(): number {
    return charactersResourceState.selectionRevision !== null ? charactersResourceState.currentChar : $selectedCharID
  }

  function selectedCharacter(): character | undefined {
    const candidate = characterOwners()[selectedCharacterIndex()]
    return candidate?.chaId ? uniqueCharacterOwner(candidate.chaId) : undefined
  }

  function uniqueChatOwnerById(chatId: string | undefined): Chat | undefined {
    if (!chatId) return undefined
    let owner: Chat | undefined
    for (const character of characterOwners()) {
      for (const chat of character.chats ?? []) {
        if (chat?.id !== chatId) continue
        if (owner) return undefined
        owner = chat
      }
    }
    return owner
  }

  function uniqueChatOwner(character: character | undefined, chatId: string | undefined): Chat | undefined {
    if (!character || !chatId) return undefined
    const owner = uniqueChatOwnerById(chatId)
    if (!owner) return undefined
    const matches = (character.chats ?? []).filter((chat) => chat?.id === chatId)
    return matches.length === 1 && matches[0] === owner ? owner : undefined
  }

  function selectedChat(): Chat | undefined {
    const character = selectedCharacter()
    const candidate = character?.chats?.[character.chatPage ?? 0]
    return candidate?.id ? uniqueChatOwner(character, candidate.id) : undefined
  }

  function advancedSetting<K extends LorebookAdvancedSetting>(key: K): Database[K] | undefined {
    const status = settingsResourceState.groupStatuses.advanced
    if (status === 'ready') {
      const settings = settingsResourceState.value as Partial<Database>
      return Object.prototype.hasOwnProperty.call(settings, key)
        ? (settings[key] as Database[K] | undefined)
        : undefined
    }
    return undefined
  }

  function globalLorebookOwners(): readonly GlobalLorebook[] {
    const status = collectionsResourceState.statuses.loreBook
    if (status === 'ready') {
      return Array.isArray(collectionsResourceState.values.loreBook)
        ? (collectionsResourceState.values.loreBook as GlobalLorebook[])
        : []
    }
    return []
  }

  function uniqueGlobalLorebookOwner(lorebookId: string | undefined): GlobalLorebook | undefined {
    if (!lorebookId) return undefined
    const matches = globalLorebookOwners().filter((candidate) => candidate?.id === lorebookId)
    return matches.length === 1 ? matches[0] : undefined
  }

  function selectedGlobalLorebook(): GlobalLorebook | undefined {
    const snapshot = $lorebookPageOwnerState
    const ownerPage = lorebookPageIndexFromSnapshot(snapshot)
    const page = snapshot.status === 'ready' || snapshot.status === 'stale' ? ownerPage : null
    const candidate = page === null ? undefined : globalLorebookOwners()[page]
    return typeof candidate?.id === 'string' && candidate.id.trim()
      ? uniqueGlobalLorebookOwner(candidate.id)
      : undefined
  }

  let selectedCharacterId = $derived(globalMode ? undefined : selectedCharacter()?.chaId)
  let characterLorebookLoading = $derived(
    !globalMode && submenu === 0 && isCharacterLorebookHydrationPending(selectedCharacterId),
  )
  let characterLorebookFailed = $derived(
    !globalMode && submenu === 0 && hasCharacterLorebookHydrationFailed(selectedCharacterId),
  )

  function characterLorebookScopeKey(): string | null {
    const characterId = selectedCharacter()?.chaId
    return characterId ? `character:${characterId}` : null
  }

  function chatLorebookScopeKey(): string | null {
    const chatId = selectedChat()?.id
    return chatId ? `chat:${chatId}` : null
  }

  function globalLorebookScopeKey(): string | null {
    const lorebookId = selectedGlobalLorebook()?.id
    return lorebookId ? `global:${lorebookId}` : null
  }

  let activeToolbarScopeKey = $derived(
    globalMode ? globalLorebookScopeKey() : submenu === 0 ? characterLorebookScopeKey() : chatLorebookScopeKey(),
  )
  let visibleLorebookMutationScopeKeys = $derived.by(() => {
    const keys = globalMode ? [globalLorebookScopeKey()] : [characterLorebookScopeKey(), chatLorebookScopeKey()]
    return [...new Set(keys.filter((key): key is string => Boolean(key)))]
  })

  function lorebookMutationStatus(scopeKey: string | null): 'pending' | 'queued' | 'failed' | 'idle' {
    return findScopedLorebookCollectionMutationUiState($scopedLorebookMutationUiStates, scopeKey)?.status ?? 'idle'
  }

  function lorebookMutationPending(scopeKey: string | null): boolean {
    return lorebookMutationStatus(scopeKey) === 'pending'
  }

  function lorebookMutationBlocked(scopeKey: string | null): boolean {
    return !scopeKey || lorebookMutationPending(scopeKey)
  }

  function trackLorebookMutation(operation: ScopedLorebookMutationOperation | null): void {
    trackScopedLorebookMutationUiOperation({
      operation,
      kind: 'collection',
      onQueued: () => alertNormal(language.scopedLorebookMutation.queued),
      onFailed: (error) => alertError(language.scopedLorebookMutation.failed(error)),
    })
  }

  async function retryCharacterLorebookHydration() {
    await hydrateActiveCharacterLorebook({ force: true })
  }

  function isAllCharacterLoreAlwaysActive() {
    const globalLore = selectedCharacter()?.globalLore
    return globalLore && globalLore.every((book) => book.alwaysActive)
  }

  function isAllChatLoreAlwaysActive() {
    const localLore = selectedChat()?.localLore
    return localLore && localLore.every((book) => book.alwaysActive)
  }

  function toggleCharacterLoreAlwaysActive() {
    const character = selectedCharacter()
    const globalLore = character?.globalLore

    if (!character?.chaId || !globalLore) return

    const allActive = globalLore.every((book) => book.alwaysActive)
    const nextLore = globalLore.map((book) => ({ ...book, alwaysActive: !allActive }))
    trackLorebookMutation(replaceCharacterLorebookCollectionWithOutcome(character.chaId, nextLore))
  }

  function toggleChatLoreAlwaysActive() {
    const chat = selectedChat()
    const localLore = chat?.localLore

    if (!chat?.id || !localLore) return

    const allActive = localLore.every((book) => book.alwaysActive)
    const nextLore = localLore.map((book) => ({ ...book, alwaysActive: !allActive }))
    trackLorebookMutation(replaceChatLorebookCollectionWithOutcome(chat.id, nextLore))
  }
</script>

{#if !globalMode}
  <div class="flex w-full rounded-md border border-selected">
    <button
      aria-pressed={submenu === 0}
      onclick={() => {
        submenu = 0
      }}
      class="p-2 flex-1"
      class:bg-selected={submenu === 0}>
      <span>{language.character}</span>
    </button>
    <button
      aria-pressed={submenu === 1}
      onclick={() => {
        submenu = 1
      }}
      class="p-2 flex-1 border-r border-l border-selected"
      class:bg-selected={submenu === 1}>
      <span>{language.Chat}</span>
    </button>
    <button
      aria-pressed={submenu === 2}
      onclick={() => {
        submenu = 2
      }}
      class="p-2 flex-1"
      class:bg-selected={submenu === 2}>
      <span>{language.settings}</span>
    </button>
  </div>
{/if}
{#if submenu !== 2}
  {#if !globalMode}
    <span class="text-textcolor2 mt-2 mb-6 text-sm"
      >{submenu === 0 ? language.globalLoreInfo : language.localLoreInfo}</span>
  {/if}
  {#if characterLorebookLoading}
    <div
      class="flex min-h-28 items-center justify-center text-textcolor2"
      role="status"
      data-testid="character-lorebook-hydration-loading">
      <div class="flex flex-col items-center">
        <svg class="animate-spin h-6 w-6 mb-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        <span class="text-sm">{language.loadingLorebookData}</span>
      </div>
    </div>
  {:else if characterLorebookFailed}
    <div
      class="flex min-h-28 items-center justify-center px-6 text-textcolor2"
      role="alert"
      data-testid="character-lorebook-hydration-error">
      <div class="flex flex-col items-center gap-3 text-center">
        <span class="text-sm">{language.lorebookDataLoadFailed}</span>
        <button
          type="button"
          class="flex items-center gap-2 rounded-md border border-darkborderc px-3 py-2 text-sm text-textcolor transition-colors hover:border-textcolor hover:bg-selected focus:border-textcolor focus:bg-selected"
          onclick={retryCharacterLorebookHydration}>
          <RefreshCcwIcon size={16} />
          <span>{language.retry}</span>
        </button>
      </div>
    </div>
  {:else if !globalMode && submenu === 0}
    <LoreBookList {globalMode} {submenu} lorePlus={selectedCharacter()?.lorePlus} />
  {:else if !globalMode && submenu === 1}
    <LoreBookList {globalMode} {submenu} lorePlus={selectedCharacter()?.lorePlus} />
  {:else}
    <LoreBookList {globalMode} {submenu} lorePlus={!globalMode && selectedCharacter()?.lorePlus} />
  {/if}
{:else}
  {#if characterLoreSettingsDraft.value.loreSettings}
    <div class="flex items-center mt-4">
      <Check
        check={false}
        onChange={() => {
          characterLoreSettingsDraft.value.loreSettings = null
          characterLoreSettingsDraft.value = { ...characterLoreSettingsDraft.value }
        }}
        name={language.useGlobalSettings} />
    </div>
    <div class="flex items-center mt-4">
      <Check
        bind:check={characterLoreSettingsDraft.value.loreSettings.recursiveScanning}
        name={language.recursiveScanning} />
    </div>
    <div class="flex items-center mt-4">
      <Check
        bind:check={characterLoreSettingsDraft.value.loreSettings.fullWordMatching}
        name={language.fullWordMatching} />
    </div>
    <span class="text-textcolor mt-4 mb-2">{language.loreBookDepth}</span>
    <NumberInput size="sm" min={0} max={20} bind:value={characterLoreSettingsDraft.value.loreSettings.scanDepth} />
    <span class="text-textcolor">{language.loreBookToken}</span>
    <NumberInput size="sm" min={0} max={4096} bind:value={characterLoreSettingsDraft.value.loreSettings.tokenBudget} />
  {:else}
    <div class="flex items-center mt-4">
      <Check
        check={true}
        onChange={() => {
          characterLoreSettingsDraft.value.loreSettings = {
            tokenBudget: advancedSetting('loreBookToken') ?? 800,
            scanDepth: advancedSetting('loreBookDepth') ?? 5,
            recursiveScanning: false,
          }
          characterLoreSettingsDraft.value = { ...characterLoreSettingsDraft.value }
        }}
        name={language.useGlobalSettings} />
    </div>
  {/if}
  <div class="flex items-center mt-4">
    {#if advancedSetting('useExperimental')}
      <Check bind:check={characterLoreSettingsDraft.value.lorePlus} name={language.lorePlus}
        ><Help key="lorePlus"></Help><Help key="experimental"></Help></Check>
    {/if}
  </div>
{/if}
{#if submenu !== 2 && !characterLorebookLoading && !characterLorebookFailed}
  <div class="text-textcolor2 mt-2 flex">
    <button
      aria-label={`${language.add}: ${language.loreBook}`}
      disabled={lorebookMutationBlocked(activeToolbarScopeKey)}
      onclick={() => {
        if (lorebookMutationBlocked(activeToolbarScopeKey)) return
        trackLorebookMutation(addLorebook(globalMode ? -1 : submenu))
      }}
      class="hover:text-textcolor cursor-pointer disabled:cursor-not-allowed disabled:opacity-50">
      <PlusIcon />
    </button>
    <button
      aria-label={`${language.export}: ${language.loreBook}`}
      disabled={!activeToolbarScopeKey}
      onclick={() => {
        if (!activeToolbarScopeKey) return
        exportLoreBook(globalMode ? 'sglobal' : submenu === 0 ? 'global' : 'local')
      }}
      class="hover:text-textcolor ml-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50">
      <DownloadIcon />
    </button>
    <button
      aria-label={`${language.add}: ${language.folderName}`}
      disabled={lorebookMutationBlocked(activeToolbarScopeKey)}
      onclick={() => {
        if (lorebookMutationBlocked(activeToolbarScopeKey)) return
        trackLorebookMutation(addLorebookFolder(globalMode ? -1 : submenu))
      }}
      class="hover:text-textcolor ml-2 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50">
      <FolderPlusIcon />
    </button>
    <button
      aria-label={`${language.import}: ${language.loreBook}`}
      disabled={lorebookMutationBlocked(activeToolbarScopeKey)}
      onclick={async () => {
        if (lorebookMutationBlocked(activeToolbarScopeKey)) return
        trackLorebookMutation(await importLoreBook(globalMode ? 'sglobal' : submenu === 0 ? 'global' : 'local'))
      }}
      class="hover:text-textcolor ml-2 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50">
      <HardDriveUploadIcon />
    </button>
    {#if advancedSetting('bulkEnabling')}
      <button
        aria-label={`${isAllCharacterLoreAlwaysActive() ? language.disable : language.enable}: ${language.alwaysActive} (${language.character})`}
        aria-pressed={Boolean(isAllCharacterLoreAlwaysActive())}
        disabled={lorebookMutationBlocked(characterLorebookScopeKey())}
        data-risu-lorebook-persistence={lorebookMutationStatus(characterLorebookScopeKey())}
        onclick={() => {
          if (lorebookMutationBlocked(characterLorebookScopeKey())) return
          toggleCharacterLoreAlwaysActive()
        }}
        class="hover:text-textcolor ml-2 cursor-pointer flex items-center gap-1 disabled:cursor-not-allowed disabled:opacity-50">
        {#if isAllCharacterLoreAlwaysActive()}
          <SunIcon />
        {:else}
          <LinkIcon />
        {/if}
        <span class="text-xs">CHAR</span>
      </button>
      <button
        aria-label={`${isAllChatLoreAlwaysActive() ? language.disable : language.enable}: ${language.alwaysActive} (${language.Chat})`}
        aria-pressed={Boolean(isAllChatLoreAlwaysActive())}
        disabled={lorebookMutationBlocked(chatLorebookScopeKey())}
        data-risu-lorebook-persistence={lorebookMutationStatus(chatLorebookScopeKey())}
        onclick={() => {
          if (lorebookMutationBlocked(chatLorebookScopeKey())) return
          toggleChatLoreAlwaysActive()
        }}
        class="hover:text-textcolor ml-2 cursor-pointer flex items-center gap-1 disabled:cursor-not-allowed disabled:opacity-50">
        {#if isAllChatLoreAlwaysActive()}
          <SunIcon />
        {:else}
          <LinkIcon />
        {/if}
        <span class="text-xs">CHAT</span>
      </button>
    {/if}
  </div>
  {#each visibleLorebookMutationScopeKeys as scopeKey}
    {@const mutationState = findScopedLorebookCollectionMutationUiState($scopedLorebookMutationUiStates, scopeKey)}
    {@const status = mutationState?.status ?? 'idle'}
    {#if status === 'failed'}
      <p
        class="m-0 mt-1 text-xs text-red-400"
        data-risu-lorebook-persistence={status}
        data-risu-lorebook-scope={scopeKey}
        role="alert"
        aria-live="assertive">
        {language.scopedLorebookMutation.failed(mutationState?.error ?? '')}
      </p>
    {/if}
  {/each}
{/if}
