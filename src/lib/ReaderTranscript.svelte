<script lang="ts">
  import { onDestroy, setContext, tick, untrack } from 'svelte'
  import { getAdditionalChatLoadPages, getInitialChatLoadPages } from '@risuai/shared-core/chat-load-pages'
  import { language } from '../lang'
  import Chat from './ChatScreens/Chat.svelte'
  import ChatScreenLayout from './ChatScreens/ChatScreenLayout.svelte'
  import ReaderChatBackground from './ChatScreens/ReaderChatBackground.svelte'
  import { getCustomBackground } from '../ts/characterState'
  import Chats from './ChatScreens/Chats.svelte'
  import { createChatReadOwners } from './ChatScreens/chatReadOwners.svelte'
  import { getReaderPanelAppearance, hasReaderChatPanel } from './ChatScreens/readerPanelAppearance'
  import { CHAT_READ_OWNERS_CONTEXT } from './ChatScreens/chatReadOwnersContext'
  import { getCharImage } from '../ts/characterImage'
  import { getCharacterDisplayName } from '../ts/characterDisplayName'
  import { createSimpleCharacter } from '../ts/simpleCharacter'
  import { resolveUserPersonaPresentation } from '../ts/utilState'
  import {
    canUseClientReaderContent,
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
    getReaderChatIncarnation,
    getReaderNavigationSettings,
    getReaderModuleDisplayDatabase,
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
  import { startReaderGenerationObservation } from '../ts/server/readerGenerationObservation'
  import type { ReaderGenerationView } from '../ts/server/readerGenerationTypes'
  import { resolveReaderRoute } from '../ts/readerRouteScope'
  import {
    isServerChatMessagePlaceholder,
    type character,
    type Chat as ChatRecord,
    type Database,
    type Message,
  } from '../ts/storage/database.svelte'

  let {
    characterId,
    chatId,
    onUseThisDevice,
    takeoverDisabled,
  }: {
    characterId: string
    chatId: string
    onUseThisDevice: () => void
    takeoverDisabled: boolean
  } = $props()
  const displaySettings = $derived(getReaderNavigationSettings())
  let backgroundStyle = $state('')
  const panelAppearance = $derived(
    getReaderPanelAppearance(displaySettings, hasReaderChatPanel(displaySettings, backgroundStyle)),
  )
  $effect(() => {
    const source = displaySettings.hideAllImages ? '' : (displaySettings.customBackground ?? '')
    void $clientSessionStore.generation
    backgroundStyle = ''
    if (!canUseClientReaderContent()) return
    const generation = captureClientSessionGeneration()
    let cancelled = false
    untrack(() => {
      void getCustomBackground(source)
        .then((style) => {
          if (!cancelled && isClientSessionGenerationCurrent(generation) && canUseClientReaderContent())
            backgroundStyle = style
        })
        .catch(() => {})
    })
    return () => {
      cancelled = true
    }
  })
  let loadPages = $state(getInitialChatLoadPages(getReaderNavigationSettings()))
  let scrollContainer: HTMLDivElement | null = $state(null)
  let chatsInstance: ReturnType<typeof Chats> | undefined = $state()
  let loading = $state(false)
  let readFailed = $state(false)
  let displayResourcesLoading = $state(false)
  let displayResourcesFailed = $state(false)
  let initialWindowConfigured = $state(settingsResourceState.groupStatuses.display === 'ready')
  let historyExpanded = false
  const readerContentAvailable = $derived.by(() => {
    void $clientSessionStore
    return canUseClientReaderContent()
  })
  let displayResourcesRun = 0
  let displayResourceController: AbortController | null = null
  const displayResourcesReady = $derived(readerDisplayResourcesReady())
  let initialDisplayPending = $state(false)
  let hasNewUnreadMessage = $state(false)
  let readRun = 0
  let destroyed = false
  let generationView = $state.raw<ReaderGenerationView>({ status: 'idle', projection: null })
  let generationObserver: ReturnType<typeof startReaderGenerationObservation> | null = null
  const incarnation = $derived(getReaderChatIncarnation(characterId, chatId))
  // Scalar scope prevents connection/page updates from recreating an observer; it owns those lifecycles.
  const transcriptScope = $derived(JSON.stringify([characterId, chatId, incarnation, $clientSessionStore.generation]))
  const observationScope = $derived(
    $clientSessionStore.managed &&
      readerContentAvailable &&
      ['reading', 'promoting'].includes($clientSessionStore.lifecycle) &&
      incarnation !== null
      ? transcriptScope
      : null,
  )
  let retained = $state.raw<{
    characterId: string
    chatId: string
    lineage: string | null
    incarnation: number
    character: character
    chat: ChatRecord
    messages: Message[]
  } | null>(null)

  const liveScope = $derived(
    resolveReaderRoute(
      { kind: 'character', path: '', chaId: characterId, chatId },
      { ...charactersResourceState, characters: getReaderTranscriptDisplayCharacters() },
      $clientSessionStore.projectionReady && readerContentAvailable,
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
      readerContentAvailable &&
      retained.characterId === characterId &&
      retained.chatId === chatId &&
      retained.lineage === $clientSessionStore.databaseLineage &&
      retained.incarnation === getReaderChatIncarnation(characterId, chatId) &&
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
          : !readerContentAvailable
            ? 'loading'
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
    () => ({ ...getReaderNavigationSettings(), ...getReaderModuleDisplayDatabase(), ...getReaderTranscriptPersona() }),
    () => panelAppearance,
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

  $effect(() => {
    const scope = observationScope
    generationView = { status: 'idle', projection: null }
    if (!scope) return
    const [selectedCharacterId, selectedChatId, selectedIncarnation, generation] = JSON.parse(scope) as [
      string,
      string,
      number,
      number,
    ]
    let stopped = false
    const observer = untrack(() =>
      startReaderGenerationObservation({
        characterId: selectedCharacterId,
        chatId: selectedChatId,
        incarnation: selectedIncarnation,
        loadPages: () => loadPages,
        onChange(view) {
          if (
            stopped ||
            destroyed ||
            characterId !== selectedCharacterId ||
            chatId !== selectedChatId ||
            getReaderChatIncarnation(selectedCharacterId, selectedChatId) !== selectedIncarnation ||
            !isClientSessionGenerationCurrent(generation)
          )
            return
          generationView = view
        },
      }),
    )
    generationObserver = observer
    return () => {
      stopped = true
      observer.stop()
      if (generationObserver === observer) generationObserver = null
    }
  })

  // This is a disposable same-route read snapshot. It never changes canonical
  // owners and is unavailable immediately after auth or lineage changes.
  $effect(() => {
    if (!liveBodyUsable || !liveCharacter || !liveChat || !liveBody) return
    const incarnation = getReaderChatIncarnation(characterId, chatId)
    if (incarnation === null) return
    const snapshotMessages = $state.snapshot(liveBody.messages)
    const snapshotChat = $state.snapshot({ ...liveChat, message: snapshotMessages })
    retained = {
      characterId,
      chatId,
      lineage: $clientSessionStore.databaseLineage,
      incarnation,
      character: $state.snapshot({ ...liveCharacter, chats: [snapshotChat] }),
      chat: snapshotChat,
      messages: snapshotMessages,
    }
  })
  $effect(() => {
    if (
      !$clientSessionStore.authenticated ||
      (retained &&
        (retained.lineage !== $clientSessionStore.databaseLineage ||
          retained.incarnation !== getReaderChatIncarnation(characterId, chatId)))
    ) {
      retained = null
    }
  })

  $effect(() => {
    if (initialWindowConfigured || settingsResourceState.groupStatuses.display !== 'ready') return
    initialWindowConfigured = true
    if (!historyExpanded) loadPages = getInitialChatLoadPages(getReaderNavigationSettings())
  })
  $effect(() => {
    void $clientSessionStore.generation
    void characterId
    void chatId
    const connection = $clientSessionStore.connection
    if (
      displayResourcesReady ||
      !$clientSessionStore.projectionReady ||
      !readerContentAvailable ||
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
    if (!readerContentAvailable) return
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
    if (!readerContentAvailable || loading || displayResourcesLoading) return
    generationObserver?.refresh()
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
    if (!readerContentAvailable || !liveCharacter || !liveChat || !liveBody || connection === 'interrupted') return
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
    if (!currentCharacter || !currentChat || !greeting || !readerContentAvailable) return
    if (!isClientSessionGenerationCurrent(generation)) return
    void refreshGreetingTranslationProjection(characterId, chatId, { clientSettingsSignature: signature })
  })

  async function loadWindow(nextPages: number, force = false, expand = false): Promise<void> {
    if (!readerContentAvailable || !liveCharacter || !liveChat) return
    const targetCharacter = liveCharacter
    const targetChat = liveChat
    const targetId = chatId
    const incarnation = getReaderChatIncarnation(characterId, targetId)
    const generation = captureClientSessionGeneration()
    const run = ++readRun
    loading = true
    readFailed = false
    const current = () =>
      !destroyed &&
      readerContentAvailable &&
      run === readRun &&
      chatId === targetId &&
      getReaderChatIncarnation(characterId, targetId) === incarnation &&
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
    if (!readerContentAvailable || loading) return
    historyExpanded = true
    void loadWindow(loadPages + getAdditionalChatLoadPages(getReaderNavigationSettings()), false, true)
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

<ChatScreenLayout
  settings={displaySettings}
  {backgroundStyle}
  stackPortraitOnSmallScreens
  minimumContentHeight="min(100%, 22rem)"
  showPortrait={!!displayCharacter && displayCharacter.viewScreen !== 'none' && !displaySettings.hideAllImages}>
  {#snippet background()}
    <ReaderChatBackground character={displayCharacter} chat={displayChat} userIcon={presentation.userIcon} />
  {/snippet}
  {#snippet portrait()}
    {#if displayCharacter?.image && !displaySettings.hideAllImages}
      {#await getCharImage(displayCharacter.image, 'plain') then src}
        {#if src}<img {src} alt={getCharacterDisplayName(displayCharacter)} class="h-full w-full object-contain" />{/if}
      {/await}
    {/if}
  {/snippet}
  {#snippet classicPortrait()}
    {#if displayCharacter && displayCharacter.viewScreen !== 'none' && !displayCharacter.inlayViewScreen && displayCharacter.image && !displaySettings.hideAllImages}
      <div
        class="pointer-events-none absolute right-0 top-0 z-5 h-48 w-48 max-h-[35%] max-w-[35%] border-b border-l border-borderc bg-darkbg/70"
        data-reader-portrait>
        {@render portrait('waifu')}
      </div>
    {/if}
  {/snippet}
  {#snippet content(customStyle: string)}
    <div
      class="reader-chat-screen flex h-full min-h-0 min-w-0 flex-col relative"
      style={`${customStyle}${panelAppearance.style}`}
      style:--chat-screen-width="{displaySettings.chatScreenWidth ?? 900}px"
      data-reader-transcript
      data-reader-panel-tone={panelAppearance.tone}
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
          disabled={!readerContentAvailable || loading || displayResourcesLoading}
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
      {#if generationView.status === 'interrupted'}
        <p class="shrink-0 px-4 py-2 text-sm text-textcolor2" role="status" data-reader-generation-interrupted>
          {language.connectedReaders.generationInterrupted}
        </p>
      {/if}
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
          {#key transcriptScope}
            <Chats
              bind:this={chatsInstance}
              {messages}
              {chatId}
              currentCharacter={displayCharacter}
              {loadPages}
              {scrollContainer}
              readOnly={true}
              readerGeneration={generationView.projection}
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
          {/key}
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
      <div class="reader-composer shrink-0 border-t border-textcolor/15 p-3" data-reader-composer>
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p id="reader-composer-reason" class="text-sm text-textcolor2">
            {language.connectedReaders.composerReadOnly}
          </p>
          <button
            class="rounded-md border border-textcolor/20 px-3 py-2 text-sm disabled:opacity-50"
            disabled={takeoverDisabled}
            onclick={() => {
              if (!takeoverDisabled) onUseThisDevice()
            }}
            data-reader-composer-takeover>{language.connectedReaders.useThisDevice}</button>
        </div>
        <textarea
          rows="1"
          disabled
          readonly
          aria-label={language.messageInput}
          aria-describedby="reader-composer-reason"
          placeholder={language.connectedReaders.composerReadOnly}
          class="block w-full resize-none rounded-md border border-textcolor/15 bg-textcolor/5 px-3 py-3 text-sm text-textcolor2"
        ></textarea>
      </div>
    </div>
  {/snippet}
</ChatScreenLayout>

<style>
  .reader-chat-screen :global(.risu-chat),
  .reader-composer {
    width: min(var(--chat-screen-width, 900px), 100%);
    margin-inline: auto;
  }
</style>
