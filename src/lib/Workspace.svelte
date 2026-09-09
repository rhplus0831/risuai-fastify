<script lang="ts">
  import { tick, type Snippet } from 'svelte'
  import { language } from '../lang'
  import { hydrateCharacterShell, characterShellHydrationState } from '../ts/server/characterShellHydration.svelte'
  import {
    getReaderTranscriptCharacters,
    getReaderNavigationSettings,
    getReaderCharacterOrder,
  } from '../ts/server/readerTranscriptProjection.svelte'
  import ReaderNavigation from './SideBars/ReaderNavigation.svelte'
  import CharacterCatalogView from './SideBars/CharacterCatalogView.svelte'
  import { readerCharacterOrder, readerPinnedChats } from './SideBars/readerNavigation'
  import { getFileSrc } from '../ts/fileSource'
  import { getCharacterDisplayName, getCharacterDisplaySearchText } from '../ts/characterDisplayName'
  import { DynamicGUI } from '../ts/stores.svelte'
  import { unreadChatIds, markChatRead } from '../ts/process/chatUnread.svelte'
  import { type AppRoute } from '../ts/routerRoute'
  import { charactersResourceState } from '../ts/server/resourceState.svelte'
  import { isServerCharacterShell, type Chat } from '../ts/storage/database.svelte'
  import { characterRoutePath, currentRoute, navigate } from '../ts/router'
  import { recordReaderRouteIntent } from '../ts/readerRouteIntent'
  import { canUseClientReaderContent, clientSessionStore } from '../ts/clientSession'
  import { resolveReaderRoute, uniqueReaderCharacters, uniqueReaderChatIds } from '../ts/readerRouteScope'
  import type { ConnectedWriterPromotionResult } from '../ts/bootstrap'
  import ConversationShell from './ConversationShell.svelte'
  import DeviceAccessAction from './DeviceAccessAction.svelte'

  let {
    readerMode,
    writerNavigation,
    writerContent,
    writerNavigationOpen = false,
    writerNavigationLabel = '',
    writerContentInert = false,
    writerContentBusy = false,
    onWriterCloseNavigation = () => {},
  }: {
    readerMode: boolean
    writerNavigation?: Snippet
    writerContent?: Snippet
    writerNavigationOpen?: boolean
    writerNavigationLabel?: string
    writerContentInert?: boolean
    writerContentBusy?: boolean
    onWriterCloseNavigation?: () => void
  } = $props()

  let characters = $derived(charactersResourceState.status === 'ready' ? charactersResourceState.characters : [])
  let routeCharacterId = $derived($currentRoute.kind === 'character' ? $currentRoute.chaId : null)
  let routeChatId = $derived($currentRoute.kind === 'character' ? ($currentRoute.chatId ?? null) : null)
  let selectedCharacter = $derived(
    routeCharacterId ? characters.find((candidate) => candidate?.chaId === routeCharacterId) : undefined,
  )
  let selectedIsShell = $derived(isServerCharacterShell(selectedCharacter))
  let selectedHydration = $derived(routeCharacterId ? characterShellHydrationState.rows[routeCharacterId] : undefined)
  let selectedChats = $derived(
    selectedCharacter && !selectedIsShell && Array.isArray(selectedCharacter.chats) ? selectedCharacter.chats : [],
  )
  let shellPinnedChats = $derived(
    selectedIsShell
      ? ((selectedCharacter as unknown as { pinnedChats?: Array<{ id: string; name: string }> }).pinnedChats ?? [])
      : [],
  )
  let shellChatCount = $derived(
    selectedIsShell ? ((selectedCharacter as unknown as { chatCount?: number }).chatCount ?? 0) : selectedChats.length,
  )
  const readerContentAvailable = $derived.by(() => {
    void $clientSessionStore
    return canUseClientReaderContent()
  })
  const readerScope = $derived(
    resolveReaderRoute(
      $currentRoute,
      { ...charactersResourceState, characters: getReaderTranscriptCharacters() },
      $clientSessionStore.projectionReady,
    ),
  )
  const readerCharacter = $derived('character' in readerScope ? readerScope.character : undefined)
  const readerCharacters = $derived(uniqueReaderCharacters(getReaderTranscriptCharacters()))
  const readerChatIds = $derived(
    readerCharacter ? uniqueReaderChatIds(getReaderTranscriptCharacters(), readerCharacter) : [],
  )
  const readerChats = $derived(
    readerCharacter && !isServerCharacterShell(readerCharacter)
      ? (readerCharacter.chats ?? []).filter((chat) => chat.id && readerChatIds.includes(chat.id))
      : [],
  )
  let readerNavigationOpen = $state(false)
  let catalogSearch = $state('')
  let catalogMode = $state<'list' | 'grid'>('list')
  let latestReadingRoute = $state<AppRoute | null>(null)
  const readerSettings = $derived(getReaderNavigationSettings())
  const readerOrder = $derived(getReaderCharacterOrder())
  const navigationCharacters = $derived(
    $clientSessionStore.managed ? readerCharacters : uniqueReaderCharacters(characters),
  )
  const navigationCharacter = $derived($clientSessionStore.managed ? readerCharacter : selectedCharacter)
  const navigationChats = $derived(
    $clientSessionStore.managed ? readerChats : selectedIsShell ? (shellPinnedChats as Chat[]) : selectedChats,
  )
  const navigationOrder = $derived($clientSessionStore.managed ? readerOrder : charactersResourceState.characterOrder)
  const navigationPins = $derived(
    readerPinnedChats($clientSessionStore.managed ? getReaderTranscriptCharacters() : characters, navigationOrder),
  )
  const readerIdentity = $derived(`${$clientSessionStore.authenticated}:${$clientSessionStore.databaseLineage}`)
  const catalogRows = $derived.by(() => {
    const order = readerCharacterOrder(navigationCharacters, navigationOrder).flatMap((entry) =>
      typeof entry === 'string' ? [entry] : entry.data,
    )
    return order
      .map((id) => navigationCharacters.find((row) => row.chaId === id)!)
      .filter((row) =>
        getCharacterDisplaySearchText(row).toLocaleLowerCase().includes(catalogSearch.toLocaleLowerCase()),
      )
      .map((row, index) => ({
        key: row.chaId,
        id: row.chaId,
        index,
        name: getCharacterDisplayName(row),
        description: row.creatorNotes ?? '',
        selected: routeCharacterId === row.chaId,
        hasImage: !!row.image && !readerSettings.hideAllImages,
        imageStyle:
          row.image && !readerSettings.hideAllImages
            ? getFileSrc(row.image).then((url) =>
                url ? `background-image: url(${JSON.stringify(url)}); background-size: cover;` : '',
              )
            : '',
      }))
  })
  const returnReadingPath = $derived.by(() => {
    if (!latestReadingRoute || !readerContentAvailable) return null
    const resolved = resolveReaderRoute(
      latestReadingRoute,
      { ...charactersResourceState, characters: getReaderTranscriptCharacters() },
      $clientSessionStore.projectionReady,
    )
    return ['character', 'chat'].includes(resolved.status) ? latestReadingRoute.path : null
  })
  $effect(() => {
    void readerIdentity
    latestReadingRoute = null
    unreadChatIds.set(new Set())
    catalogSearch = ''
    readerNavigationOpen = false
  })
  let readerNotice = $state('')
  let readerNoticePath = $state('')
  let readerTranscriptModule: Promise<typeof import('./ReaderTranscript.svelte')> | undefined
  const loadReaderTranscript = () => (readerTranscriptModule ??= import('./ReaderTranscript.svelte'))

  $effect(() => {
    if (!readerMode) return
    if (!$clientSessionStore.managed || !$clientSessionStore.projectionReady || !readerContentAvailable) return
    if (readerScope.status === 'missing-character') {
      readerNotice = language.connectedReaders.characterUnavailable
      readerNoticePath = '/'
      navigate('/', { replace: true })
    } else if (readerScope.status === 'missing-chat') {
      readerNotice = language.connectedReaders.chatUnavailable
      readerNoticePath = characterRoutePath(readerScope.character.chaId, readerScope.fallbackChatId ?? undefined)
      navigate(readerNoticePath, { replace: true })
    }
  })
  $effect(() => {
    if (!readerMode) return
    const target = readerCharacter
    void $clientSessionStore.generation
    if (
      !$clientSessionStore.managed ||
      !$clientSessionStore.projectionReady ||
      !readerContentAvailable ||
      !target ||
      !isServerCharacterShell(target)
    )
      return
    const controller = new AbortController()
    void hydrateCharacterShell(target.chaId, { signal: controller.signal })
    return () => controller.abort()
  })

  let useThisDeviceButton: HTMLButtonElement | undefined = $state()
  let writerSwitchPending = $state(false)
  let writerSwitchResult = $state<ConnectedWriterPromotionResult | null>(null)
  const writerSwitchInProgress = $derived(
    writerSwitchPending ||
      ($clientSessionStore.connection !== 'interrupted' &&
        ['promoting', 'recovering-writer'].includes($clientSessionStore.lifecycle)),
  )
  const writerSwitchDisabled = $derived(
    writerSwitchInProgress || $clientSessionStore.connection !== 'live' || $clientSessionStore.lifecycle !== 'reading',
  )
  let authoringRouteBlocked = $derived(
    $clientSessionStore.managed && !['home', 'grid', 'character'].includes($currentRoute.kind),
  )
  $effect(() => {
    if (!readerMode) return
    const route = $currentRoute
    if (!$clientSessionStore.managed) {
      recordReaderRouteIntent(route)
      return
    }
    if (!readerContentAvailable || !$clientSessionStore.projectionReady) return
    if (readerScope.status === 'character' || readerScope.status === 'chat') {
      latestReadingRoute = { ...route }
      recordReaderRouteIntent(route)
    } else if (readerScope.status === 'home') recordReaderRouteIntent(route)
  })

  function showRoute(path: string): void {
    if ($clientSessionStore.managed && !canUseClientReaderContent()) return
    readerNotice = ''
    readerNoticePath = ''
    navigate(path)
    if (path === '/' || path === '/grid') readerNavigationOpen = false
  }

  function showCharacter(characterId: string): void {
    if (
      $clientSessionStore.managed &&
      (!canUseClientReaderContent() || !readerCharacters.some((row) => row.chaId === characterId))
    )
      return
    readerNavigationOpen = true
    showRoute(characterRoutePath(characterId))
  }

  function showChat(characterId: string, chatId: string): void {
    if ($clientSessionStore.managed) {
      const owner = readerCharacters.find((row) => row.chaId === characterId)
      if (
        !canUseClientReaderContent() ||
        !owner ||
        !uniqueReaderChatIds(getReaderTranscriptCharacters(), owner).includes(chatId)
      )
        return
    }
    markChatRead(chatId)
    readerNavigationOpen = false
    showRoute(characterRoutePath(characterId, chatId))
  }

  function loadDetails(characterId: string): void {
    if (!readerContentAvailable) return
    void hydrateCharacterShell(characterId, { supersede: true })
  }

  function lifecycleStatus(): string {
    if ($clientSessionStore.connection === 'interrupted') return language.connectedReaders.interrupted
    if ($clientSessionStore.connection === 'connecting') return language.connectedReaders.connecting
    if (writerSwitchInProgress) return language.connectedReaders.switching
    return language.connectedReaders.connected
  }

  function writerSwitchStatus(result: ConnectedWriterPromotionResult | null): string {
    if (!result || result.status === 'promoted') return ''
    if (result.status === 'cancelled') return language.connectedReaders.switchCancelled
    if (result.status === 'superseded') return language.connectedReaders.switchSuperseded
    if (result.status === 'failed') {
      if (result.reason === 'interrupted') return language.connectedReaders.switchInterrupted
      if (result.reason === 'retained-work') return language.connectedReaders.switchRetainedWork
      return language.connectedReaders.switchUnavailable
    }
    return ''
  }

  async function useThisDevice(): Promise<void> {
    if (writerSwitchDisabled || !$clientSessionStore.managed) return
    const sessionGeneration = $clientSessionStore.generation
    writerSwitchPending = true
    writerSwitchResult = null
    try {
      const { promoteConnectedReader } = await import('../ts/bootstrap')
      if (
        sessionGeneration !== $clientSessionStore.generation ||
        !canUseClientReaderContent() ||
        $clientSessionStore.lifecycle !== 'reading' ||
        $clientSessionStore.connection !== 'live'
      ) {
        writerSwitchResult = { status: 'superseded' }
        return
      }
      writerSwitchResult = await promoteConnectedReader()
    } catch {
      writerSwitchResult = {
        status: 'failed',
        reason: $clientSessionStore.connection === 'interrupted' ? 'interrupted' : 'unavailable',
      }
    } finally {
      writerSwitchPending = false
      await tick()
      if (
        writerSwitchResult?.status !== 'promoted' &&
        useThisDeviceButton?.isConnected &&
        !writerSwitchDisabled &&
        (document.activeElement === document.body || document.activeElement === useThisDeviceButton)
      ) {
        useThisDeviceButton.focus()
      }
    }
  }
</script>

<div class="contents" data-risu-workspace data-reader-layout={readerMode ? '' : undefined}>
  <div class="h-full min-h-0 w-full">
    <ConversationShell
      responsive={$DynamicGUI}
      navigationOpen={readerMode ? !$DynamicGUI || readerNavigationOpen : writerNavigationOpen}
      navigationLabel={readerMode ? language.readOnlyWorkspace.navigationLabel : writerNavigationLabel}
      navigationId={readerMode ? 'reader-navigation' : 'conversation-shell-navigation'}
      showNavigationToggle={readerMode}
      navigationToggleLabel={language.connectedReaders.browseConversations}
      preserveResponsiveNavigation={readerMode}
      contentInert={readerMode ? false : writerContentInert}
      contentBusy={readerMode ? false : writerContentBusy}
      onOpenNavigation={() => {
        if (readerMode) readerNavigationOpen = true
      }}
      onCloseNavigation={() => {
        if (readerMode) readerNavigationOpen = false
        else onWriterCloseNavigation()
      }}>
      {#snippet navigation()}
        {#if readerMode}
          {#key readerIdentity}
            <ReaderNavigation
              characters={navigationCharacters}
              characterOrder={navigationOrder}
              settings={readerSettings}
              character={navigationCharacter}
              chats={navigationChats}
              selectedCharacterId={routeCharacterId}
              selectedChatId={routeChatId}
              homeSelected={$currentRoute.kind === 'home'}
              gridSelected={$currentRoute.kind === 'grid'}
              loadingChats={$clientSessionStore.managed && !!readerCharacter && isServerCharacterShell(readerCharacter)}
              unreadChatIds={$unreadChatIds}
              pins={navigationPins}
              responsive={$DynamicGUI}
              backOnly={$clientSessionStore.managed && readerScope.status === 'chat'}
              onBack={() => {
                if (routeCharacterId) showCharacter(routeCharacterId)
              }}
              onHome={() => showRoute('/')}
              onGrid={() => showRoute('/grid')}
              onCharacter={showCharacter}
              onChat={showChat}
              onClose={() => {
                readerNavigationOpen = false
              }} />
          {/key}
        {:else}
          {@render writerNavigation?.()}
        {/if}
      {/snippet}
      {#if readerMode}
        <section class="flex h-full min-h-0 min-w-0 flex-1 flex-col" data-reader-route>
          <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
            {#if $clientSessionStore.managed}
              {#if charactersResourceState.status === 'error' || (routeCharacterId && charactersResourceState.rowStatuses[routeCharacterId] === 'error')}
                <p
                  class="shrink-0 border-b border-textcolor/15 px-4 py-3 text-sm text-textcolor2"
                  role="alert"
                  data-reader-resource-read-failed>
                  {language.connectedReaders.readFailed}
                </p>
              {/if}
              {#if readerNotice && readerNoticePath === $currentRoute.path}<p
                  class="shrink-0 border-b border-textcolor/15 px-4 py-3 text-sm"
                  role="status"
                  data-reader-route-notice>
                  {readerNotice}
                </p>{/if}
              {#if !readerContentAvailable}
                <p class="p-6 text-textcolor2" role="status">{language.loadingChatData}</p>
              {:else if readerScope.status === 'blocked'}
                <div class="p-6">
                  <p role="status" data-reader-authoring-gate>{language.connectedReaders.writeAccessRequired}</p>
                  <div class="mt-4 flex gap-3">
                    <button
                      type="button"
                      class="rounded-md border border-selected px-3 py-2"
                      onclick={() => showRoute('/')}>{language.home}</button>
                    {#if returnReadingPath}<button
                        type="button"
                        class="rounded-md border border-selected px-3 py-2"
                        data-reader-return-to-reading
                        onclick={() => {
                          if (returnReadingPath) showRoute(returnReadingPath)
                        }}>{language.connectedReaders.returnToReading}</button
                      >{/if}
                  </div>
                </div>
              {:else if readerScope.status === 'ambiguous'}
                <p class="p-6" role="alert" data-reader-ambiguous-target>
                  {language.connectedReaders.ambiguousConversation}
                </p>
              {:else if routeCharacterId && routeChatId}
                {#if selectedHydration?.status === 'error'}
                  <div class="shrink-0 px-4 py-3 text-sm" role="alert">
                    <p>{language.connectedReaders.readFailed}</p>
                    <button
                      type="button"
                      class="mt-2 rounded border border-textcolor/20 px-3 py-2"
                      onclick={() => loadDetails(routeCharacterId)}>{language.retry}</button>
                  </div>
                {/if}
                {#key `${routeCharacterId}:${routeChatId}`}
                  {#await loadReaderTranscript()}
                    <p class="p-6 text-textcolor2" role="status">{language.loadingChatData}</p>
                  {:then module}
                    <module.default characterId={routeCharacterId} chatId={routeChatId} />
                  {:catch}
                    <p class="p-6 text-textcolor2" role="alert">{language.connectedReaders.readFailed}</p>
                  {/await}
                {/key}
              {:else if readerCharacter}
                <div class="overflow-y-auto p-5 sm:p-8">
                  <h2 class="text-xl font-semibold">{readerCharacter.displayName || readerCharacter.name}</h2>
                  <p class="mt-3 text-sm text-textcolor2">{language.connectedReaders.chooseConversation}</p>
                  {#if selectedHydration?.status === 'error'}
                    <p class="mt-4 text-sm" role="alert">{language.connectedReaders.readFailed}</p>
                    <button
                      class="mt-2 rounded border border-textcolor/20 px-3 py-2"
                      type="button"
                      onclick={() => loadDetails(readerCharacter.chaId)}>{language.retry}</button>
                  {:else if isServerCharacterShell(readerCharacter)}<p
                      class="mt-4 text-sm text-textcolor2"
                      role="status">
                      {language.loadingChatData}
                    </p>{/if}
                </div>
              {:else if readerScope.status === 'loading'}
                <p class="p-6 text-textcolor2" role="status">{language.loadingChatData}</p>
              {:else}
                {@render catalog()}
              {/if}
            {:else}
              <div class="min-h-0 overflow-y-auto p-5 sm:p-8" aria-labelledby="observer-detail-heading">
                {#if authoringRouteBlocked}
                  <p id="observer-detail-heading" role="status" data-reader-authoring-gate>
                    {language.connectedReaders.writeAccessRequired}
                  </p>
                {:else if selectedCharacter}
                  <div class="mx-auto flex max-w-2xl flex-col gap-5">
                    <div>
                      <p class="mb-1 text-sm text-textcolor2">
                        {selectedIsShell
                          ? language.readOnlyWorkspace.summaryLabel
                          : language.readOnlyWorkspace.detailsLabel}
                      </p>
                      <h2 id="observer-detail-heading" class="text-2xl font-semibold">
                        {selectedCharacter.displayName || selectedCharacter.name}
                      </h2>
                      {#if selectedCharacter.creatorNotes}
                        <p class="mt-3 whitespace-pre-wrap text-sm text-textcolor2">{selectedCharacter.creatorNotes}</p>
                      {/if}
                    </div>

                    <p class="text-sm text-textcolor2">{language.readOnlyWorkspace.chatCount(shellChatCount)}</p>

                    {#if selectedIsShell}
                      <div class="rounded-md border border-textcolor/15 p-4" data-reader-character-summary>
                        <p class="text-sm text-textcolor2">{language.readOnlyWorkspace.summaryHelp}</p>
                        <button
                          type="button"
                          class="mt-3 rounded-md border border-textcolor/30 px-3 py-2 text-sm hover:bg-textcolor/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-60"
                          disabled={selectedHydration?.status === 'loading'}
                          aria-label={language.readOnlyWorkspace.loadDetailsFor(
                            selectedCharacter.displayName || selectedCharacter.name,
                          )}
                          onclick={() => loadDetails(selectedCharacter.chaId)}>
                          {selectedHydration?.status === 'loading'
                            ? language.readOnlyWorkspace.loadingDetails
                            : selectedHydration?.status === 'error'
                              ? language.readOnlyWorkspace.retryDetails
                              : language.readOnlyWorkspace.loadDetails}
                        </button>
                        {#if selectedHydration?.status === 'error'}
                          <p class="mt-2 text-sm text-red-500" role="alert">
                            {language.readOnlyWorkspace.detailsError}
                          </p>
                        {/if}
                      </div>
                    {/if}
                  </div>
                {:else}
                  {@render catalog()}
                {/if}
              </div>
            {/if}
          </div>
          <DeviceAccessAction
            title={language.connectedReaders.title}
            status={lifecycleStatus()}
            result={writerSwitchStatus(writerSwitchResult)}
            switchInProgress={writerSwitchInProgress}
            switchDisabled={writerSwitchDisabled}
            bind:useButton={useThisDeviceButton}
            onUseThisDevice={() => void useThisDevice()} />
        </section>
      {:else}
        {@render writerContent?.()}
      {/if}
    </ConversationShell>
  </div>
</div>

{#snippet catalog()}
  <div
    class="h-full w-full flex justify-center overflow-y-auto"
    data-risu-grid-catalog
    data-risu-list-kind={catalogMode}>
    <div class="h-full p-6 bg-darkbg max-w-full w-2xl flex flex-col">
      <h2 class="text-xl font-semibold mb-3">{language.readOnlyWorkspace.chooseCharacter}</h2>
      <input
        type="search"
        class="mb-3 rounded-md border border-darkborderc bg-bgcolor px-3 py-2"
        aria-label={language.search}
        placeholder={language.search}
        bind:value={catalogSearch} />
      <div class="mb-4 flex gap-2">
        <button
          type="button"
          class="rounded-md border border-selected px-3 py-1"
          aria-pressed={catalogMode === 'grid'}
          onclick={() => {
            catalogMode = 'grid'
          }}>{language.grid}</button>
        <button
          type="button"
          class="rounded-md border border-selected px-3 py-1"
          aria-pressed={catalogMode === 'list'}
          onclick={() => {
            catalogMode = 'list'
          }}>{language.list}</button>
      </div>
      <CharacterCatalogView
        rows={catalogRows}
        mode={catalogMode}
        onOpen={(row) => showCharacter(row.id)}
        onPrefetch={() => {}} />
    </div>
  </div>
{/snippet}
