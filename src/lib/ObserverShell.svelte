<script lang="ts">
  import { tick } from 'svelte'
  import { language } from '../lang'
  import { observerShellLifecycleStore, type ObserverShellLifecycleMode } from '../ts/observerShellLifecycle.svelte'
  import { hydrateCharacterShell, characterShellHydrationState } from '../ts/server/characterShellHydration.svelte'
  import { getReaderTranscriptCharacters } from '../ts/server/readerTranscriptProjection.svelte'
  import { charactersResourceState } from '../ts/server/resourceState.svelte'
  import { isServerCharacterShell } from '../ts/storage/database.svelte'
  import { characterRoutePath, currentRoute, navigate } from '../ts/router'
  import { recordObserverRouteIntent } from '../ts/observerRouteIntent'
  import { canUseClientReadServices, clientSessionStore } from '../ts/clientSession'
  import { resolveReaderRoute, uniqueReaderCharacters, uniqueReaderChatIds } from '../ts/readerRouteScope'
  import type { ConnectedWriterPromotionResult } from '../ts/bootstrap'

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
  let readerNotice = $state('')
  let readerNoticePath = $state('')
  let readerTranscriptModule: Promise<typeof import('./ReaderTranscript.svelte')> | undefined
  const loadReaderTranscript = () => (readerTranscriptModule ??= import('./ReaderTranscript.svelte'))

  $effect(() => {
    if (!$clientSessionStore.managed || !$clientSessionStore.projectionReady) return
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
    const target = readerCharacter
    void $clientSessionStore.generation
    if (
      !$clientSessionStore.managed ||
      !$clientSessionStore.projectionReady ||
      !canUseClientReadServices() ||
      !target ||
      !isServerCharacterShell(target)
    )
      return
    const controller = new AbortController()
    void hydrateCharacterShell(target.chaId, { signal: controller.signal })
    return () => controller.abort()
  })

  let retryWriterButton: HTMLButtonElement | undefined = $state()
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
  let writerRetryAvailable = $derived(
    !$clientSessionStore.managed &&
      ['takeover-denied', 'unavailable', 'writer-lost', 'offline'].includes($observerShellLifecycleStore.mode),
  )
  let authoringRouteBlocked = $derived(
    $clientSessionStore.managed && !['home', 'grid', 'character'].includes($currentRoute.kind),
  )

  $effect(() => {
    recordObserverRouteIntent($currentRoute)
  })

  function showRoute(path: string): void {
    readerNotice = ''
    readerNoticePath = ''
    navigate(path)
  }

  function showCharacter(characterId: string): void {
    readerNavigationOpen = true
    showRoute(characterRoutePath(characterId))
  }

  function showChat(characterId: string, chatId: string): void {
    readerNavigationOpen = false
    showRoute(characterRoutePath(characterId, chatId))
  }

  function loadDetails(characterId: string): void {
    void hydrateCharacterShell(characterId, { supersede: true })
  }

  function lifecycleStatus(mode: ObserverShellLifecycleMode): string {
    if ($clientSessionStore.managed) {
      if ($clientSessionStore.connection === 'interrupted') return language.connectedReaders.interrupted
      if ($clientSessionStore.connection === 'connecting') return language.connectedReaders.connecting
      if (writerSwitchInProgress) return language.connectedReaders.switching
      return language.connectedReaders.connected
    }
    switch (mode) {
      case 'retrying':
        return language.observerShell.statusRetrying
      case 'takeover-denied':
        return language.observerShell.statusTakeoverDenied
      case 'unavailable':
        return language.observerShell.statusUnavailable
      case 'writer-lost':
        return language.observerShell.statusWriterLost
      case 'offline':
        return language.observerShell.statusOffline
      case 'auth-lost':
        return language.observerShell.statusAuthLost
      case 'promoted':
        return language.observerShell.statusPromoted
      default:
        return language.observerShell.status
    }
  }

  async function retryWriterPromotion(): Promise<void> {
    const { retryObserverWriterPromotion } = await import('../ts/bootstrap')
    const promoted = await retryObserverWriterPromotion()
    if (!promoted) {
      await tick()
      retryWriterButton?.focus()
    }
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
    writerSwitchPending = true
    writerSwitchResult = null
    try {
      const { promoteConnectedReader } = await import('../ts/bootstrap')
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

<div class="flex h-full w-full flex-col overflow-hidden bg-bg text-textcolor" data-observer-shell>
  <header class="border-b border-textcolor/15 px-4 py-3 sm:px-6">
    <div
      class="mx-auto flex w-full max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
      role="status"
      aria-live="polite"
      data-observer-read-only-status>
      <div>
        <h1 class="text-lg font-semibold">
          {$clientSessionStore.managed ? language.connectedReaders.title : language.observerShell.title}
        </h1>
        <p class="text-sm text-textcolor2" data-observer-lifecycle-status>
          {lifecycleStatus($observerShellLifecycleStore.mode)}
        </p>
        {#if $clientSessionStore.managed}
          <p id="reader-writer-switch-help" class="mt-2 max-w-2xl text-sm text-textcolor2">
            {language.connectedReaders.useThisDeviceHelp}
          </p>
          <button
            bind:this={useThisDeviceButton}
            type="button"
            class="mt-2 rounded-md border border-textcolor/30 px-3 py-2 text-sm hover:bg-textcolor/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            aria-describedby="reader-writer-switch-help"
            aria-busy={writerSwitchInProgress}
            data-reader-use-this-device
            disabled={writerSwitchDisabled}
            onclick={() => void useThisDevice()}>
            {writerSwitchInProgress
              ? language.connectedReaders.switchingDevice
              : language.connectedReaders.useThisDevice}
          </button>
          {#if writerSwitchStatus(writerSwitchResult)}
            <p class="mt-2 max-w-2xl text-sm text-textcolor2" data-reader-writer-switch-result>
              {writerSwitchStatus(writerSwitchResult)}
            </p>
          {/if}
        {:else if writerRetryAvailable}
          <button
            bind:this={retryWriterButton}
            type="button"
            class="mt-2 rounded-md border border-textcolor/30 px-3 py-2 text-sm hover:bg-textcolor/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            data-observer-writer-retry
            onclick={() => void retryWriterPromotion()}>
            {language.observerShell.retryWriter}
          </button>
        {:else if $observerShellLifecycleStore.mode === 'retrying'}
          <button
            type="button"
            class="mt-2 cursor-wait rounded-md border border-textcolor/30 px-3 py-2 text-sm opacity-60"
            data-observer-writer-retry
            disabled>
            {language.observerShell.retryingWriter}
          </button>
        {/if}
      </div>
      <span class="w-fit rounded-full border border-yellow-600/60 bg-yellow-600/10 px-3 py-1 text-sm">
        {language.observerShell.readOnlyBadge}
      </span>
    </div>
  </header>

  {#if $clientSessionStore.managed}
    <div
      class="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[minmax(13rem,18rem)_minmax(0,1fr)]"
      data-reader-layout>
      <button
        type="button"
        class="shrink-0 border-b border-textcolor/15 px-4 py-2 text-left text-sm md:hidden"
        aria-controls="reader-navigation"
        aria-expanded={readerNavigationOpen || !routeChatId}
        onclick={() => {
          readerNavigationOpen = !readerNavigationOpen
        }}
        data-reader-navigation-toggle>
        {language.connectedReaders.browseConversations}
      </button>
      <nav
        id="reader-navigation"
        class="max-h-64 shrink-0 overflow-y-auto border-b border-textcolor/15 p-3 md:max-h-none md:min-h-0 md:border-b-0 md:border-r {readerNavigationOpen ||
        !routeChatId
          ? ''
          : 'hidden md:block'}"
        aria-label={language.observerShell.navigationLabel}>
        <button
          type="button"
          class="mb-3 w-full rounded border border-textcolor/20 px-3 py-2 text-left"
          aria-current={$currentRoute.kind === 'home' ? 'page' : undefined}
          onclick={() => showRoute('/')}>{language.home}</button>
        <h2 class="mb-2 text-sm font-semibold text-textcolor2">{language.observerShell.charactersLabel}</h2>
        {#if readerCharacters.length === 0}<p class="text-sm text-textcolor2">
            {language.observerShell.noCharacters}
          </p>{/if}
        <ul class="flex flex-col gap-1">
          {#each readerCharacters as character (character.chaId)}
            <li>
              <button
                type="button"
                class="w-full rounded px-3 py-2 text-left hover:bg-textcolor/5 {routeCharacterId === character.chaId
                  ? 'bg-textcolor/10'
                  : ''}"
                aria-current={routeCharacterId === character.chaId ? 'page' : undefined}
                aria-label={language.observerShell.openCharacter(character.displayName || character.name)}
                onclick={() => showCharacter(character.chaId)}>{character.displayName || character.name}</button>
            </li>
          {/each}
        </ul>
        {#if readerCharacter}
          <h2 class="mb-2 mt-5 text-sm font-semibold text-textcolor2">{language.observerShell.chatsLabel}</h2>
          {#if readerChats.length > 0}
            <ul class="flex flex-col gap-1">
              {#each readerChats as chat (chat.id)}
                <li>
                  <button
                    type="button"
                    class="w-full rounded px-3 py-2 text-left hover:bg-textcolor/5 {routeChatId === chat.id
                      ? 'bg-textcolor/10'
                      : ''}"
                    aria-current={routeChatId === chat.id ? 'page' : undefined}
                    aria-label={language.observerShell.openChat(chat.name)}
                    onclick={() => showChat(readerCharacter.chaId, chat.id)}>{chat.name}</button>
                </li>
              {/each}
            </ul>
          {:else if isServerCharacterShell(readerCharacter)}<p class="text-sm text-textcolor2">
              {language.loadingChatData}
            </p>
          {:else}<p class="text-sm text-textcolor2">{language.connectedReaders.noConversations}</p>{/if}
        {/if}
      </nav>
      <section class="flex min-h-0 min-w-0 flex-1 flex-col" data-reader-route>
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
        {#if readerScope.status === 'blocked'}
          <p class="p-6" role="status" data-reader-authoring-gate>{language.connectedReaders.writeAccessRequired}</p>
        {:else if readerScope.status === 'ambiguous'}
          <p class="p-6" role="alert" data-reader-ambiguous-target>{language.connectedReaders.ambiguousConversation}</p>
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
            {:else if isServerCharacterShell(readerCharacter)}<p class="mt-4 text-sm text-textcolor2" role="status">
                {language.loadingChatData}
              </p>{/if}
          </div>
        {:else if readerScope.status === 'loading'}
          <p class="p-6 text-textcolor2" role="status">{language.loadingChatData}</p>
        {:else}
          <div class="m-auto max-w-md p-6 text-center">
            <h2 class="text-xl font-semibold">{language.observerShell.chooseCharacter}</h2>
            <p class="mt-3 text-sm text-textcolor2">{language.connectedReaders.chooseCharacterHelp}</p>
          </div>
        {/if}
      </section>
    </div>
  {:else}
    <div class="mx-auto grid min-h-0 w-full max-w-6xl flex-1 grid-cols-1 md:grid-cols-[minmax(15rem,20rem)_1fr]">
      <nav
        class="min-h-0 overflow-y-auto border-b border-textcolor/15 p-4 md:border-b-0 md:border-r"
        aria-label={language.observerShell.navigationLabel}>
        <button
          type="button"
          class="mb-4 w-full rounded-md border border-textcolor/20 px-3 py-2 text-left hover:bg-textcolor/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          aria-current={$currentRoute.kind === 'home' ? 'page' : undefined}
          onclick={() => showRoute('/')}>
          {language.home}
        </button>

        <h2 class="mb-2 text-sm font-semibold uppercase tracking-wide text-textcolor2">
          {language.observerShell.charactersLabel}
        </h2>
        {#if characters.length === 0}
          <p class="text-sm text-textcolor2">{language.observerShell.noCharacters}</p>
        {:else}
          <ul class="flex flex-col gap-2">
            {#each characters as character (character.chaId)}
              <li>
                <button
                  type="button"
                  class="w-full rounded-md border border-textcolor/15 px-3 py-2 text-left hover:bg-textcolor/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 {routeCharacterId ===
                  character.chaId
                    ? 'bg-textcolor/10'
                    : ''}"
                  aria-current={routeCharacterId === character.chaId ? 'page' : undefined}
                  aria-label={language.observerShell.openCharacter(character.displayName || character.name)}
                  onclick={() => showCharacter(character.chaId)}>
                  <span class="block truncate font-medium">{character.displayName || character.name}</span>
                  <span class="block text-xs text-textcolor2">
                    {isServerCharacterShell(character)
                      ? language.observerShell.summaryLabel
                      : language.observerShell.detailsLabel}
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </nav>

      <section class="min-h-0 overflow-y-auto p-5 sm:p-8" aria-labelledby="observer-detail-heading">
        {#if authoringRouteBlocked}
          <p id="observer-detail-heading" role="status" data-reader-authoring-gate>
            {language.connectedReaders.writeAccessRequired}
          </p>
        {:else if selectedCharacter}
          <div class="mx-auto flex max-w-2xl flex-col gap-5">
            <div>
              <p class="mb-1 text-sm text-textcolor2">
                {selectedIsShell ? language.observerShell.summaryLabel : language.observerShell.detailsLabel}
              </p>
              <h2 id="observer-detail-heading" class="text-2xl font-semibold">
                {selectedCharacter.displayName || selectedCharacter.name}
              </h2>
              {#if selectedCharacter.creatorNotes}
                <p class="mt-3 whitespace-pre-wrap text-sm text-textcolor2">{selectedCharacter.creatorNotes}</p>
              {/if}
            </div>

            <p class="text-sm text-textcolor2">{language.observerShell.chatCount(shellChatCount)}</p>

            {#if selectedIsShell}
              <div class="rounded-md border border-textcolor/15 p-4" data-observer-character-summary>
                <p class="text-sm text-textcolor2">{language.observerShell.summaryHelp}</p>
                <button
                  type="button"
                  class="mt-3 rounded-md border border-textcolor/30 px-3 py-2 text-sm hover:bg-textcolor/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-60"
                  disabled={selectedHydration?.status === 'loading'}
                  aria-label={language.observerShell.loadDetailsFor(
                    selectedCharacter.displayName || selectedCharacter.name,
                  )}
                  onclick={() => loadDetails(selectedCharacter.chaId)}>
                  {selectedHydration?.status === 'loading'
                    ? language.observerShell.loadingDetails
                    : selectedHydration?.status === 'error'
                      ? language.observerShell.retryDetails
                      : language.observerShell.loadDetails}
                </button>
                {#if selectedHydration?.status === 'error'}
                  <p class="mt-2 text-sm text-red-500" role="alert">{language.observerShell.detailsError}</p>
                {/if}
              </div>
            {/if}

            <div>
              <h3 class="mb-2 font-semibold">{language.observerShell.chatsLabel}</h3>
              {#if selectedChats.length > 0}
                <ul class="flex flex-col gap-2">
                  {#each selectedChats as chat (chat.id)}
                    <li>
                      <button
                        type="button"
                        class="w-full rounded-md border border-textcolor/15 px-3 py-2 text-left hover:bg-textcolor/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 {routeChatId ===
                        chat.id
                          ? 'bg-textcolor/10'
                          : ''}"
                        aria-current={routeChatId === chat.id ? 'page' : undefined}
                        aria-label={language.observerShell.openChat(chat.name)}
                        onclick={() => showChat(selectedCharacter.chaId, chat.id)}>
                        {chat.name}
                      </button>
                    </li>
                  {/each}
                </ul>
              {:else if shellPinnedChats.length > 0}
                <p class="mb-2 text-sm text-textcolor2">{language.observerShell.pinnedChatsHelp}</p>
                <ul class="flex flex-col gap-2">
                  {#each shellPinnedChats as chat (chat.id)}
                    <li>
                      <button
                        type="button"
                        class="w-full rounded-md border border-textcolor/15 px-3 py-2 text-left hover:bg-textcolor/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 {routeChatId ===
                        chat.id
                          ? 'bg-textcolor/10'
                          : ''}"
                        aria-current={routeChatId === chat.id ? 'page' : undefined}
                        aria-label={language.observerShell.openChat(chat.name)}
                        onclick={() => showChat(selectedCharacter.chaId, chat.id)}>
                        {chat.name}
                      </button>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="text-sm text-textcolor2">{language.observerShell.noChats}</p>
              {/if}
            </div>
          </div>
        {:else}
          <div class="flex h-full min-h-48 items-center justify-center text-center">
            <div class="max-w-md">
              <h2 id="observer-detail-heading" class="text-xl font-semibold">
                {language.observerShell.chooseCharacter}
              </h2>
              <p class="mt-2 text-sm text-textcolor2">{language.observerShell.chooseCharacterHelp}</p>
            </div>
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>
