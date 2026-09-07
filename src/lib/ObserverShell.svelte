<script lang="ts">
  import { tick } from 'svelte'
  import { language } from '../lang'
  import { observerShellLifecycleStore, type ObserverShellLifecycleMode } from '../ts/observerShellLifecycle.svelte'
  import { hydrateCharacterShell, characterShellHydrationState } from '../ts/server/characterShellHydration.svelte'
  import { charactersResourceState } from '../ts/server/resourceState.svelte'
  import { isServerCharacterShell } from '../ts/storage/database.svelte'
  import { characterRoutePath, currentRoute, navigate } from '../ts/router'
  import { recordObserverRouteIntent } from '../ts/observerRouteIntent'
  import { clientSessionStore } from '../ts/clientSession'

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
  let retryWriterButton: HTMLButtonElement | undefined = $state()
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
    navigate(path)
  }

  function showCharacter(characterId: string): void {
    showRoute(characterRoutePath(characterId))
  }

  function showChat(characterId: string, chatId: string): void {
    showRoute(characterRoutePath(characterId, chatId))
  }

  function loadDetails(characterId: string): void {
    void hydrateCharacterShell(characterId, { supersede: true })
  }

  function lifecycleStatus(mode: ObserverShellLifecycleMode): string {
    if ($clientSessionStore.managed) {
      if ($clientSessionStore.connection === 'interrupted') return language.connectedReaders.interrupted
      if ($clientSessionStore.connection === 'connecting') return language.connectedReaders.connecting
      if (['promoting', 'recovering-writer'].includes($clientSessionStore.lifecycle))
        return language.connectedReaders.switching
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
        {#if writerRetryAvailable}
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
            <h2 id="observer-detail-heading" class="text-xl font-semibold">{language.observerShell.chooseCharacter}</h2>
            <p class="mt-2 text-sm text-textcolor2">{language.observerShell.chooseCharacterHelp}</p>
          </div>
        </div>
      {/if}
    </section>
  </div>
</div>
