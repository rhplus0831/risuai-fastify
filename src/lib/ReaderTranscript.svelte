<script lang="ts">
  import { onDestroy, setContext, tick, untrack } from 'svelte'
  import { getAdditionalChatLoadPages, getInitialChatLoadPages } from '@risuai/shared-core/chat-load-pages'
  import { language } from '../lang'
  import Chat from './ChatScreens/Chat.svelte'
  import Chats from './ChatScreens/Chats.svelte'
  import { createChatReadOwners } from './ChatScreens/chatReadOwners.svelte'
  import { CHAT_READ_OWNERS_CONTEXT } from './ChatScreens/chatReadOwnersContext'
  import { getCharImage } from '../ts/characterImage'
  import { getCharacterDisplayName } from '../ts/characterDisplayName'
  import { createSimpleCharacter } from '../ts/simpleCharacter'
  import { resolveUserPersonaPresentation } from '../ts/utilState'
  import {
    canUseClientReadServices,
    captureClientSessionGeneration,
    clientSessionStore,
    isClientSessionGenerationCurrent,
  } from '../ts/clientSession'
  import { charactersResourceState, settingsResourceState } from '../ts/server/resourceState.svelte'
  import {
    getReaderChatMessageOwnerState,
    hydrateReaderChatMessageWindow,
  } from '../ts/server/chatMessageHydration.svelte'
  import {
    getReaderTranscriptDisplayCharacters,
    getReaderTranscriptPersona,
  } from '../ts/server/readerTranscriptProjection.svelte'
  import {
    currentGreetingTranslatorSettingsSignature,
    findGreetingTranslation,
    greetingTranslationProjectionVersion,
    refreshGreetingTranslationProjection,
  } from '../ts/server/greetingTranslations.svelte'
  import { readerDisplayLimitedStore } from '../ts/server/displaySources'
  import { ensureReaderDisplayResources, readerDisplayResourcesReady } from '../ts/server/readerDisplayResources'
  import { resolveReaderRoute } from '../ts/readerRouteScope'
  import {
    isServerChatMessagePlaceholder,
    type character,
    type Chat as ChatRecord,
    type Database,
    type Message,
  } from '../ts/storage/database.svelte'

  let { characterId, chatId }: { characterId: string; chatId: string } = $props()
  let loadPages = $state(getInitialChatLoadPages(settingsResourceState.value))
  let scrollContainer: HTMLDivElement | null = $state(null)
  let chatsInstance: ReturnType<typeof Chats> | undefined = $state()
  let loading = $state(false)
  let readFailed = $state(false)
  let displayResourcesLoading = $state(false)
  let displayResourcesFailed = $state(false)
  let initialWindowConfigured = $state(settingsResourceState.groupStatuses.display === 'ready')
  let historyExpanded = false
  let displayResourcesRun = 0
  let displayResourceController: AbortController | null = null
  const displayResourcesReady = $derived(readerDisplayResourcesReady())
  let initialDisplayPending = $state(false)
  let hasNewUnreadMessage = $state(false)
  let readRun = 0
  let destroyed = false
  let retained = $state.raw<{
    characterId: string
    chatId: string
    lineage: string | null
    character: character
    chat: ChatRecord
    messages: Message[]
  } | null>(null)

  const liveScope = $derived(
    resolveReaderRoute(
      { kind: 'character', path: '', chaId: characterId, chatId },
      { ...charactersResourceState, characters: getReaderTranscriptDisplayCharacters() },
      $clientSessionStore.projectionReady,
    ),
  )
  const liveChat = $derived(liveScope.status === 'chat' ? liveScope.chat : undefined)
  const liveCharacter = $derived('character' in liveScope ? liveScope.character : undefined)
  const liveBody = $derived.by(() => {
    void $clientSessionStore.generation
    return liveChat ? getReaderChatMessageOwnerState(chatId) : undefined
  })
  const liveBodyUsable = $derived(
    Boolean(
      liveChat &&
      liveBody &&
      (liveBody.resourceLoaded || liveBody.messages.length > 0) &&
      !liveBody.messages.slice(-loadPages).some(isServerChatMessagePlaceholder),
    ),
  )
  const retainedAllowed = $derived(
    Boolean(
      retained &&
      retained.characterId === characterId &&
      retained.chatId === chatId &&
      retained.lineage === $clientSessionStore.databaseLineage &&
      $clientSessionStore.authenticated &&
      !['missing-character', 'missing-chat', 'ambiguous', 'blocked'].includes(liveScope.status),
    ),
  )
  const usingRetained = $derived(!liveBodyUsable && retainedAllowed)
  const readOwners = createChatReadOwners(
    {
      get status() {
        return !$clientSessionStore.authenticated
          ? 'idle'
          : usingRetained
            ? 'ready'
            : $clientSessionStore.projectionReady
              ? charactersResourceState.status
              : 'loading'
      },
      get characters() {
        return usingRetained ? [retained!.character] : getReaderTranscriptDisplayCharacters()
      },
      get currentChar() {
        return -1
      },
    },
    (id) => (usingRetained && id === chatId ? retained!.messages : getReaderChatMessageOwnerState(id)?.messages),
    () => ({ characterId, chatId }),
  )
  setContext(CHAT_READ_OWNERS_CONTEXT, readOwners)
  const displayCharacter = $derived(readOwners.character())
  const displayChat = $derived(readOwners.chat())
  const messages = $derived((readOwners.messages() ?? []) as Message[])
  const presentation = $derived(resolveUserPersonaPresentation(getReaderTranscriptPersona() as Database, displayChat))
  const simpleCharacter = $derived(displayCharacter ? createSimpleCharacter(displayCharacter) : null)
  const greetingIndex = $derived(displayChat?.fmIndex ?? -1)
  const greeting = $derived(
    displayCharacter
      ? ((greetingIndex < 0 ? displayCharacter.firstMessage : displayCharacter.alternateGreetings?.[greetingIndex]) ??
          '')
      : '',
  )
  const greetingSignature = $derived(currentGreetingTranslatorSettingsSignature())
  const greetingTranslation = $derived.by(() => {
    void $greetingTranslationProjectionVersion
    return findGreetingTranslation({
      characterId,
      chatId,
      greetingIndex,
      source: greeting,
      clientSettingsSignature: greetingSignature,
    })
  })

  // This is a disposable same-route read snapshot. It never changes canonical
  // owners and is unavailable immediately after auth or lineage changes.
  $effect(() => {
    if (!liveBodyUsable || !liveCharacter || !liveChat || !liveBody) return
    const snapshotMessages = $state.snapshot(liveBody.messages)
    const snapshotChat = $state.snapshot({ ...liveChat, message: snapshotMessages })
    retained = {
      characterId,
      chatId,
      lineage: $clientSessionStore.databaseLineage,
      character: $state.snapshot({ ...liveCharacter, chats: [snapshotChat] }),
      chat: snapshotChat,
      messages: snapshotMessages,
    }
  })
  $effect(() => {
    if (!$clientSessionStore.authenticated || (retained && retained.lineage !== $clientSessionStore.databaseLineage)) {
      retained = null
    }
  })

  $effect(() => {
    if (initialWindowConfigured || settingsResourceState.groupStatuses.display !== 'ready') return
    initialWindowConfigured = true
    if (!historyExpanded) loadPages = getInitialChatLoadPages(settingsResourceState.value)
  })
  $effect(() => {
    void $clientSessionStore.generation
    void characterId
    void chatId
    const connection = $clientSessionStore.connection
    if (
      displayResourcesReady ||
      !$clientSessionStore.projectionReady ||
      !canUseClientReadServices() ||
      connection === 'interrupted'
    )
      return
    const controller = new AbortController()
    untrack(() => {
      void loadDisplayResources(controller)
    })
    return () => controller.abort()
  })

  async function loadDisplayResources(controller: AbortController): Promise<void> {
    const generation = captureClientSessionGeneration()
    const run = ++displayResourcesRun
    displayResourceController = controller
    displayResourcesLoading = true
    displayResourcesFailed = false
    try {
      const result = await ensureReaderDisplayResources({ signal: controller.signal })
      if (
        destroyed ||
        controller.signal.aborted ||
        run !== displayResourcesRun ||
        !isClientSessionGenerationCurrent(generation)
      )
        return
      displayResourcesFailed = result.status === 'error'
    } finally {
      if (!destroyed && run === displayResourcesRun) displayResourcesLoading = false
      if (displayResourceController === controller) displayResourceController = null
    }
  }

  async function refreshTranscript(): Promise<void> {
    if (loading || displayResourcesLoading) return
    await Promise.all([loadDisplayResources(new AbortController()), loadWindow(loadPages, true)])
  }

  let lastAttempt: {
    character: character
    chat: ChatRecord
    epoch: number
    messages: Message[]
    generation: number
    connection: string
  } | null = null
  $effect(() => {
    const generation = $clientSessionStore.generation
    const connection = $clientSessionStore.connection
    if (!canUseClientReadServices() || !liveCharacter || !liveChat || !liveBody || connection === 'interrupted') return
    if (liveBody.resourceLoaded && liveBodyUsable) return
    const next = {
      character: liveCharacter,
      chat: liveChat,
      epoch: liveBody.projectionEpoch,
      messages: liveBody.messages,
      generation,
      connection,
    }
    untrack(() => {
      if (
        lastAttempt &&
        lastAttempt.character === next.character &&
        lastAttempt.chat === next.chat &&
        lastAttempt.epoch === next.epoch &&
        lastAttempt.messages === next.messages &&
        lastAttempt.generation === next.generation &&
        lastAttempt.connection === next.connection
      )
        return
      lastAttempt = next
      void loadWindow(loadPages)
    })
  })
  $effect(() => {
    const generation = $clientSessionStore.generation
    const signature = greetingSignature
    const currentCharacter = liveCharacter
    const currentChat = liveChat
    if (!currentCharacter || !currentChat || !greeting || !canUseClientReadServices()) return
    if (!isClientSessionGenerationCurrent(generation)) return
    void refreshGreetingTranslationProjection(characterId, chatId, { clientSettingsSignature: signature })
  })

  async function loadWindow(nextPages: number, force = false, expand = false): Promise<void> {
    if (!canUseClientReadServices() || !liveCharacter || !liveChat) return
    const targetCharacter = liveCharacter
    const targetChat = liveChat
    const targetId = chatId
    const generation = captureClientSessionGeneration()
    const run = ++readRun
    loading = true
    readFailed = false
    const current = () =>
      !destroyed &&
      run === readRun &&
      chatId === targetId &&
      isClientSessionGenerationCurrent(generation) &&
      liveCharacter === targetCharacter &&
      liveChat === targetChat
    try {
      const hydrated = await hydrateReaderChatMessageWindow(targetId, nextPages, { force })
      if (!current()) return
      if (!hydrated) {
        readFailed = true
        return
      }
      if (expand) loadPages = Math.max(loadPages, nextPages)
      await tick()
      if (current()) chatsInstance?.handleTranscriptScroll()
    } catch {
      if (current()) readFailed = true
    } finally {
      if (!destroyed && run === readRun) loading = false
    }
  }

  function loadMore(): void {
    if (loading) return
    historyExpanded = true
    void loadWindow(loadPages + getAdditionalChatLoadPages(settingsResourceState.value), false, true)
  }
  function handleScroll(): void {
    chatsInstance?.handleTranscriptScroll()
    if (!scrollContainer || loading || readFailed || messages.length <= loadPages) return
    if (scrollContainer.scrollHeight - scrollContainer.clientHeight + scrollContainer.scrollTop < 100) loadMore()
  }
  const noWrite = () => {}
  onDestroy(() => {
    destroyed = true
    readRun += 1
    displayResourcesRun += 1
    displayResourceController?.abort()
    retained = null
  })
</script>

<div
  class="flex h-full min-h-0 flex-col"
  data-reader-transcript
  data-reader-character-id={characterId}
  data-reader-chat-id={chatId}>
  <div class="flex shrink-0 items-center justify-between gap-3 border-b border-textcolor/15 px-4 py-3">
    <div class="min-w-0">
      <h2 id="reader-chat-heading" class="truncate text-lg font-semibold">
        {displayChat?.name ?? language.connectedReaders.conversation}
      </h2>
      {#if displayCharacter}<p class="truncate text-sm text-textcolor2">
          {getCharacterDisplayName(displayCharacter)}
        </p>{/if}
    </div>
    <button
      class="shrink-0 rounded border border-textcolor/20 px-3 py-2 text-sm disabled:opacity-50"
      disabled={loading || displayResourcesLoading}
      onclick={() => void refreshTranscript()}
      data-reader-refresh>{language.connectedReaders.refreshConversation}</button>
  </div>
  {#if readFailed || displayResourcesFailed || liveBody?.hydrationFailed}
    <p class="shrink-0 px-4 py-2 text-sm text-textcolor2" role="alert" data-reader-read-failed>
      {language.connectedReaders.readFailed}
    </p>
  {:else if usingRetained}
    <p class="shrink-0 px-4 py-2 text-sm text-textcolor2" role="status">
      {language.connectedReaders.refreshingConversation}
    </p>
  {/if}
  {#if $readerDisplayLimitedStore}<p
      class="shrink-0 px-4 py-2 text-sm text-textcolor2"
      role="status"
      data-reader-limited-display>
      {language.connectedReaders.limitedDisplay}
    </p>{/if}
  {#if loading && messages.length === 0}<p class="px-4 py-3 text-sm text-textcolor2" role="status">
      {language.loadingChatData}
    </p>{/if}
  <!-- This focusable scroll region retains native keyboard scrolling and records user scroll intent. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={scrollContainer}
    class="reader-transcript-scroll relative flex min-h-0 flex-1 flex-col-reverse overflow-y-auto"
    aria-labelledby="reader-chat-heading"
    role="region"
    tabindex="0"
    data-reader-scroll
    onwheel={() => chatsInstance?.handleTranscriptUserInteraction()}
    ontouchstart={() => chatsInstance?.handleTranscriptUserInteraction()}
    onpointerdown={(event) => {
      if (event.target === event.currentTarget) chatsInstance?.handleTranscriptUserInteraction()
    }}
    onkeydown={(event) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key))
        chatsInstance?.handleTranscriptUserInteraction()
    }}
    onscroll={handleScroll}>
    {#if displayCharacter && displayChat}
      <Chats
        bind:this={chatsInstance}
        {messages}
        {chatId}
        currentCharacter={displayCharacter}
        {loadPages}
        {scrollContainer}
        readOnly={true}
        rerollTarget={null}
        onReroll={noWrite}
        unReroll={noWrite}
        onNewReroll={noWrite}
        onSelectRerollCandidate={noWrite}
        currentUsername={presentation.currentUsername}
        userIcon={presentation.userIcon}
        userIconPortrait={presentation.userIconPortrait}
        initialRowsPending={loading && messages.length === 0}
        bind:initialDisplayPending
        bind:hasNewUnreadMessage />
      {#if messages.length <= loadPages && greeting}
        <Chat
          character={simpleCharacter}
          displayChatId={chatId}
          readOnly={true}
          idx={-1}
          firstMessage={true}
          isLastMemory={false}
          name={getCharacterDisplayName(displayCharacter)}
          message={greeting}
          role="char"
          img={getCharImage(displayCharacter.image, 'css')}
          largePortrait={displayCharacter.largePortrait}
          translation={greetingTranslation}
          greetingTarget={{
            characterId,
            chatId,
            greetingIndex,
            source: greeting,
            clientSettingsSignature: greetingSignature,
          }} />
      {/if}
      {#if messages.length > loadPages}
        <button
          class="mx-auto my-3 shrink-0 rounded border border-textcolor/20 px-4 py-2 disabled:opacity-50"
          data-reader-load-more
          disabled={loading}
          onclick={loadMore}>{loading ? language.loadingChatData : language.loadMore}</button>
      {:else if messages.length === 0 && !greeting && !loading}
        <p class="m-auto px-4 py-8 text-center text-sm text-textcolor2">
          {language.connectedReaders.emptyConversation}
        </p>
      {/if}
    {/if}
  </div>
  {#if hasNewUnreadMessage}<button
      class="mx-auto my-2 rounded border border-textcolor/20 px-4 py-2 text-sm"
      data-reader-new-messages
      onclick={() => chatsInstance?.scrollToLatestMessage()}>{language.connectedReaders.newMessages}</button
    >{/if}
  <div class="shrink-0 border-t border-textcolor/15 p-3" data-reader-composer>
    <textarea
      rows="1"
      disabled
      readonly
      aria-label={language.messageInput}
      placeholder={language.connectedReaders.composerReadOnly}
      class="block w-full resize-none rounded-md border border-textcolor/15 bg-textcolor/5 px-3 py-3 text-sm text-textcolor2"
    ></textarea>
  </div>
</div>
