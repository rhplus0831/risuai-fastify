<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import {
    DynamicGUI,
    botMakerMode,
    OpenRealmStore,
    settingsOpen,
    sideBarClosing,
    sideBarStore,
    sideBarTransitionCause,
    openPresetList,
    openPersonaList,
    openChatGenerationTogglePresetList,
    closePresetListModal,
    closePersonaListModal,
    closeChatGenerationTogglePresetListModal,
    presetListModalStore,
    personaListModalStore,
    chatGenerationTogglePresetListModalStore,
    CustomGUISettingMenuStore,
    bookmarkListOpen,
    popupStore,
    easyPanelStore,
    popUpEditorStore,
    loadoutModalStore,
    irisStore,
    customSideBarConfigDialogStore,
    PlaygroundStore,
    SettingsMenuIndex,
    QuickSettings,
    closePopupEditorSession,
  } from './ts/stores.svelte'
  import { alertStore, LoadingStatusState, selectedCharID } from './ts/stores/coreStores.svelte'
  import { startupCoordinatorStore } from './ts/startupReadiness'
  import { pluginRuntimeStateStore } from './ts/plugins/plugins.svelte'
  import Sidebar from './lib/SideBars/Sidebar.svelte'
  import ChatScreen from './lib/ChatScreens/ChatScreen.svelte'
  import Workspace from './lib/Workspace.svelte'
  import WriterDraftRecovery from './lib/WriterDraftRecovery.svelte'
  import { showRealmInfoStore } from './ts/realmInfoStore'
  import {
    charactersResourceState,
    getCharacterResourceOwner,
    getPersonaOwnerStateSnapshot,
    settingsResourceState,
  } from './ts/server/resourceState.svelte'
  import { language } from './lang'
  import LazyComponent from './lib/UI/LazyComponent.svelte'
  import SavePopupIconComp from './lib/Others/SavePopupIcon.svelte'
  import { ArrowUpIcon, GlobeIcon, PlusIcon } from '@lucide/svelte'
  import { hypaV3ModalOpen } from './ts/stores.svelte'
  import { activeMemoryJobsStore } from './ts/server/memoryJobProjection.svelte'
  import sendSound from './etc/send.mp3'
  import {
    applyRouteToStores,
    closeGridRoute,
    consumeStateDrivenRouteUpdate,
    currentRoute,
    hasPendingRouteApplication,
    isApplyingRouteToStores,
    navigate,
    openGridRoute,
    retryCurrentRouteApplication,
    syncRouteFromState,
    restoreCharacterSidebarViewFromHistory,
  } from './ts/router'
  import { routeKey, type AppRoute } from './ts/routerRoute'
  import {
    ensureResourceSurfaces,
    prefetchCharacterRouteResource,
    routeResourceLoadState,
  } from './ts/server/routeResourceLoader'
  import { prefetchRouteIntent } from './ts/routeIntentPrefetch'
  import { alertError } from './ts/alert'
  import { canShowReaderAlert } from './ts/readerAlertPolicy'
  import { hasDragType, RISU_APP_INTERNAL_DRAG_TYPE, RISU_SIDEBAR_DRAG_TYPE } from './ts/dragTypes'
  import { consumeReaderRouteIntent, peekReaderRouteIntent } from './ts/readerRouteIntent'
  import {
    clientSessionStore,
    captureClientSessionGeneration,
    isClientSessionGenerationCurrent,
    registerClientWriterLossHandler,
  } from './ts/clientSession'
  import { canUseClientWriteAccess } from './ts/clientSession'
  import { isClientWriteOperationCurrent } from './ts/clientWriteOperation'
  import { loadGrid, loadSettings } from './ts/routeComponentPreload'
  import { pushNotificationCoordinatorState } from './ts/server/pushNotificationState'
  import { pushNotificationWarningDismissed } from './ts/gui/pushNotificationWarningPreference'
  import { workspaceAccessStore } from './ts/workspaceAccess'

  const loadAlert = () => import('./lib/Others/AlertComp.svelte')
  const loadPushNotificationWarning = () => import('./lib/Others/PushNotificationWarning.svelte')
  const loadRealmPopup = () => import('./lib/UI/Realm/LazyRealmPopUp.svelte')
  const loadBookmarkList = () => import('./lib/Others/BookmarkList.svelte')
  const loadBotPreset = () => import('./lib/Setting/botpreset.svelte')
  const loadPersonaList = () => import('./lib/Setting/listedPersona.svelte')
  const loadChatGenerationTogglePresetDialog = () => import('./lib/SideBars/ChatGenerationTogglePresetDialog.svelte')
  const loadCustomGUISettingMenu = () => import('./lib/Setting/Pages/CustomGUISettingMenu.svelte')
  const loadHypaV3Modal = async () => {
    const [component] = await Promise.all([
      import('./lib/Others/HypaV3Modal.svelte'),
      ensureResourceSurfaces(['overlay:hypa-memory']),
    ])
    return component
  }
  const loadHypaV3Progress = () => import('./lib/Others/HypaV3Progress.svelte')
  const loadPopupList = () => import('./lib/UI/PopupList.svelte')
  const loadEasyPanel = () => import('./lib/Others/ProTools/EasyPanel.svelte')
  const loadPopupEditor = () => import('./lib/Others/PopupEditor.svelte')
  const loadLoadoutModal = () => import('./lib/Others/LoadoutModal.svelte')
  const loadIrisModal = () => import('./lib/Others/IrisModal.svelte')
  const loadCustomSidebarConfig = () => import('./lib/Others/CustomSidebarConfig.svelte')

  const preloadSettingsRoute = () => prefetchRouteIntent('/settings', [() => import('./ts/routeHandlers/settings')])
  const preloadGridRoute = () => prefetchRouteIntent('/grid')
  const preloadPlaygroundRoute = () =>
    prefetchRouteIntent('/playground', [() => import('./ts/routeHandlers/playground')])

  let aprilFools = $state(new Date().getMonth() === 3 && new Date().getDate() === 1)
  let aprilFoolsPage = $state(0)
  let keepingSessionAlive = $state(false)
  let signingInReader = $state(false)
  let retryingPluginRuntime = $state(false)
  let generationRecoveryAction = $state<'idle' | 'retrying' | 'discarding'>('idle')
  let connectedReaderView = $derived(
    $workspaceAccessStore.mode === 'read-only' || $workspaceAccessStore.mode === 'promoting',
  )
  let recoveringWriterView = $derived($workspaceAccessStore.mode === 'recovering-writer')
  async function signInReader(): Promise<void> {
    if (signingInReader || $clientSessionStore.lifecycle !== 'auth-required') return
    signingInReader = true
    try {
      const { retryConnectedAuthentication } = await import('./ts/bootstrap')
      await retryConnectedAuthentication()
    } catch (error) {
      alertError(error)
    } finally {
      signingInReader = false
    }
  }
  let canApplyWriterRoutes = $derived($workspaceAccessStore.canApplyWriterRoute)
  let workspaceIsBooting = $derived(
    $clientSessionStore.managed
      ? $workspaceAccessStore.mode === 'booting'
      : !$startupCoordinatorStore.capabilities.canRenderShell,
  )
  let pluginStartupFailed = $derived($startupCoordinatorStore.failures.pluginsReady !== undefined)
  let pluginRuntimeFailed = $derived($pluginRuntimeStateStore.phase === 'error')
  let generationRecoveryStartupFailed = $derived(
    $startupCoordinatorStore.failures.canGenerate?.failureCode === 'generation-recovery-failed',
  )
  let readOnlyWorkspaceMode = $derived(connectedReaderView)
  let renderedRoute = $state($currentRoute)
  let writerNavigationVisible = $derived(!$CustomGUISettingMenuStore && renderedRoute.kind !== 'settings')
  let routeLoadingVisible = $state(false)
  let routeRetryButton = $state<HTMLButtonElement | null>(null)
  let routeContentBlocked = $derived(
    $routeResourceLoadState.status === 'loading' || $routeResourceLoadState.status === 'error',
  )
  let routeComponentLoadFailed = $derived(
    $routeResourceLoadState.status === 'error' && $routeResourceLoadState.errorKind === 'component',
  )
  let routeLoadErrorMessage = $derived(
    routeComponentLoadFailed
      ? $routeResourceLoadState.offline
        ? language.preloadOfflineError
        : language.preloadStaleError
      : ($routeResourceLoadState.error ?? 'This route could not be loaded.'),
  )

  // Subscribe to each overlay value while access is denied so a restored state
  // or late async callback cannot reopen it during a later promotion.
  function closeRestrictedOverlays(): void {
    if ($settingsOpen) settingsOpen.set(false)
    if ($botMakerMode) botMakerMode.set(false)
    if ($OpenRealmStore) OpenRealmStore.set(false)
    if ($CustomGUISettingMenuStore) CustomGUISettingMenuStore.set(false)
    if ($PlaygroundStore) PlaygroundStore.set(0)
    if (QuickSettings.open) QuickSettings.open = false
    if ($openPresetList) closePresetListModal()
    if ($openPersonaList) closePersonaListModal()
    if ($openChatGenerationTogglePresetList) closeChatGenerationTogglePresetListModal()
    if ($bookmarkListOpen) bookmarkListOpen.set(false)
    if ($hypaV3ModalOpen) hypaV3ModalOpen.set(false)
    if ($showRealmInfoStore) showRealmInfoStore.set(null)
    if (popupStore.children) popupStore.children = null
    if (easyPanelStore.open) easyPanelStore.open = false
    if (popUpEditorStore.open) closePopupEditorSession(popUpEditorStore.sessionId)
    if (loadoutModalStore.open) loadoutModalStore.open = false
    if (irisStore.open) irisStore.open = false
    if (customSideBarConfigDialogStore.open) customSideBarConfigDialogStore.open = false
    if (!canShowReaderAlert($alertStore)) alertStore.set({ type: 'none', msg: '' })
  }

  onMount(() => registerClientWriterLossHandler(() => untrack(closeRestrictedOverlays)))

  $effect(() => {
    if (connectedReaderView) closeRestrictedOverlays()
  })

  $effect(() => {
    if ($routeResourceLoadState.status !== 'loading') {
      routeLoadingVisible = false
      return
    }
    const timer = window.setTimeout(() => {
      routeLoadingVisible = true
    }, 1_000)
    return () => window.clearTimeout(timer)
  })

  $effect(() => {
    if ($routeResourceLoadState.status !== 'error' || !routeRetryButton) return
    queueMicrotask(() => {
      if ($routeResourceLoadState.status === 'error' && routeRetryButton?.isConnected) routeRetryButton.focus()
    })
  })

  function retryRouteLoad(): void {
    if (routeComponentLoadFailed && $routeResourceLoadState.offline && navigator.onLine !== false) {
      window.location.reload()
      return
    }
    void retryCurrentRouteApplication()
  }

  async function retryPlugins(): Promise<void> {
    if (!canUseClientWriteAccess()) return
    const clientGeneration = captureClientSessionGeneration()
    if (retryingPluginRuntime) return
    retryingPluginRuntime = true
    try {
      if (pluginStartupFailed) {
        const { retryPluginStartup } = await import('./ts/bootstrap')
        if (!isClientWriteOperationCurrent(clientGeneration)) return
        await retryPluginStartup()
      } else {
        const { retryPluginRuntime } = await import('./ts/plugins/plugins.svelte')
        if (!isClientWriteOperationCurrent(clientGeneration)) return
        await retryPluginRuntime()
      }
    } finally {
      retryingPluginRuntime = false
    }
  }

  async function retryGenerationRecovery(): Promise<void> {
    if (!canUseClientWriteAccess()) return
    const clientGeneration = captureClientSessionGeneration()
    if (generationRecoveryAction !== 'idle') return
    generationRecoveryAction = 'retrying'
    try {
      const { retryGenerationRecoveryStartup } = await import('./ts/bootstrap')
      if (!isClientWriteOperationCurrent(clientGeneration)) return
      await retryGenerationRecoveryStartup()
    } finally {
      generationRecoveryAction = 'idle'
    }
  }

  async function discardGenerationRecovery(): Promise<void> {
    if (!canUseClientWriteAccess()) return
    const clientGeneration = captureClientSessionGeneration()
    if (generationRecoveryAction !== 'idle') return
    generationRecoveryAction = 'discarding'
    try {
      const { discardGenerationRecoveryStartup } = await import('./ts/bootstrap')
      if (!isClientWriteOperationCurrent(clientGeneration)) return
      await discardGenerationRecoveryStartup()
    } finally {
      generationRecoveryAction = 'idle'
    }
  }

  function getMainDropEffect(event: DragEvent): DataTransfer['dropEffect'] {
    const types = event.dataTransfer?.types
    if (hasDragType(types, RISU_SIDEBAR_DRAG_TYPE) || hasDragType(types, RISU_APP_INTERNAL_DRAG_TYPE)) {
      return 'none'
    }
    return hasDragType(types, 'Files') ? 'copy' : 'none'
  }

  function isAppInternalDrag(event: DragEvent): boolean {
    const types = event.dataTransfer?.types
    return hasDragType(types, RISU_APP_INTERNAL_DRAG_TYPE) || hasDragType(types, RISU_SIDEBAR_DRAG_TYPE)
  }

  function markAppInternalDrag(event: DragEvent): void {
    event.dataTransfer?.setData(RISU_APP_INTERNAL_DRAG_TYPE, 'true')
  }

  function selectedRouteCharacter(index: number) {
    if (charactersResourceState.status === 'error') return undefined
    const candidate = charactersResourceState.characters[index]
    if (!candidate?.chaId) return undefined
    return getCharacterResourceOwner(candidate.chaId) === candidate ? candidate : undefined
  }

  function selectedRouteChatId(character: ReturnType<typeof selectedRouteCharacter>): string | undefined {
    const candidate = character?.chats?.[character.chatPage]
    if (!character?.chaId || typeof candidate?.id !== 'string' || candidate.id.trim().length === 0) return undefined

    let owner: typeof candidate | undefined
    for (const characterOwner of charactersResourceState.characters) {
      for (const chatOwner of characterOwner.chats ?? []) {
        if (chatOwner.id !== candidate.id) continue
        if (owner) return undefined
        owner = chatOwner
      }
    }
    return owner === candidate ? candidate.id : undefined
  }

  function reconcileWriterRouteFromPersistedState(currentRouteKind: AppRoute['kind']): void {
    const selectedCharacterIndex = $selectedCharID
    const character = selectedRouteCharacter(selectedCharacterIndex)
    syncRouteFromState({
      currentRouteKind,
      settingsOpen: $settingsOpen,
      settingsMenuIndex: $SettingsMenuIndex,
      selectedCharID: selectedCharacterIndex,
      playgroundStore: $PlaygroundStore,
      personaId: getPersonaOwnerStateSnapshot()?.selectedPersonaId ?? undefined,
      characterId: character?.chaId,
      chatId: routeChatIsOpen ? selectedRouteChatId(character) : undefined,
    })
  }

  function closeResponsiveSidebar(): void {
    if ($sideBarClosing) return
    sideBarTransitionCause.set('explicit-close')
    sideBarClosing.set(true)
  }

  let previousReadOnlyMode = $state<boolean | undefined>()
  $effect(() => {
    const readOnlyMode = readOnlyWorkspaceMode
    if (previousReadOnlyMode === undefined) {
      previousReadOnlyMode = readOnlyMode
      return
    }
    if (readOnlyMode === previousReadOnlyMode) return
    previousReadOnlyMode = readOnlyMode
    untrack(() => {
      sideBarTransitionCause.set('none')
      sideBarClosing.set(false)
    })
  })

  let routeChatIsOpen = $derived($currentRoute.kind === 'character' && typeof $currentRoute.chatId === 'string')

  $effect(() => {
    if (!canApplyWriterRoutes) return
    // Keep the live URL subscription while consuming the reader-only display
    // target. Promotion never replays that target through writer selection
    // handlers; the writer state-to-route effect reconciles the URL to the
    // already-persisted selection without creating a command.
    const currentWriterRoute = $currentRoute
    let observerIntent = peekReaderRouteIntent()
    // New navigation supersedes the retained route; equivalent aliases keep
    // their pending promotion/retry intent until application succeeds.
    if (observerIntent && routeKey(observerIntent.route) !== routeKey(currentWriterRoute)) {
      consumeReaderRouteIntent(observerIntent.sequence)
      observerIntent = null
    }
    if (observerIntent) {
      consumeReaderRouteIntent(observerIntent.sequence)
      // Reader browsing is only a presentation target. Move the URL back to
      // the already-persisted writer state without routing the reader choice
      // through selection handlers or durable commands.
      untrack(() => {
        reconcileWriterRouteFromPersistedState(currentWriterRoute.kind)
        restoreCharacterSidebarViewFromHistory()
      })
      return
    }
    if (consumeStateDrivenRouteUpdate()) {
      renderedRoute = currentWriterRoute
      return
    }
    let current = true
    const sessionGeneration = captureClientSessionGeneration()
    untrack(() => {
      void applyRouteToStores(currentWriterRoute).then((applied) => {
        if (!current || !applied || !canApplyWriterRoutes || !isClientSessionGenerationCurrent(sessionGeneration))
          return
        renderedRoute = currentWriterRoute
      })
    })
    return () => {
      current = false
    }
  })

  $effect(() => {
    if (!canApplyWriterRoutes) return

    // Read every state value that can drive the URL before checking the route
    // application guard. Route application writes these stores while the guard
    // is active; retaining their subscriptions lets the next user-owned write
    // re-run this effect after the route settles.
    const currentRouteKind = $currentRoute.kind
    const routeResourceStatus = $routeResourceLoadState.status
    const settingsAreOpen = $settingsOpen
    const settingsMenuIndex = $SettingsMenuIndex
    const selectedCharacterIndex = $selectedCharID
    const playgroundIndex = $PlaygroundStore
    const chatIsOpen = routeChatIsOpen
    const character = selectedRouteCharacter(selectedCharacterIndex)
    const personaId = getPersonaOwnerStateSnapshot()?.selectedPersonaId ?? undefined

    if (
      isApplyingRouteToStores() ||
      hasPendingRouteApplication() ||
      (currentRouteKind !== 'home' && routeResourceStatus !== 'ready')
    )
      return
    syncRouteFromState({
      currentRouteKind,
      settingsOpen: settingsAreOpen,
      settingsMenuIndex,
      selectedCharID: selectedCharacterIndex,
      playgroundStore: playgroundIndex,
      personaId,
      characterId: character?.chaId,
      chatId: chatIsOpen ? selectedRouteChatId(character) : undefined,
    })
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<main
  data-risu-visual-viewport-shell
  class="relative flex bg-bg w-full h-full max-w-100vw text-textcolor"
  ondragover={(e) => {
    if (isAppInternalDrag(e)) return
    if (!$startupCoordinatorStore.capabilities.canMutate) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'none'
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = getMainDropEffect(e)
  }}
  ondragstart={markAppInternalDrag}
  ondrop={async (e) => {
    if (!$startupCoordinatorStore.capabilities.canMutate) {
      e.preventDefault()
      return
    }
    if (isAppInternalDrag(e)) {
      e.preventDefault()
      return
    }
    const clientGeneration = captureClientSessionGeneration()
    const file = e.dataTransfer.files[0]
    if (!file) {
      e.preventDefault()
      return
    }
    e.preventDefault()
    try {
      const name = file.name.toLowerCase()

      if (name.endsWith('.risup')) {
        const data = new Uint8Array(await file.arrayBuffer())
        if (!isClientWriteOperationCurrent(clientGeneration)) return
        const { importPreset } = await import('./ts/storage/database.svelte')
        if (!isClientWriteOperationCurrent(clientGeneration)) return
        await importPreset({ name: file.name, data })
      } else if (name.endsWith('.risum')) {
        const { importModuleFile } = await import('./ts/process/modules')
        if (!isClientWriteOperationCurrent(clientGeneration)) return
        await importModuleFile(file, file.name)
        return
      } else {
        const [{ importCharacterFile }, { checkCharOrder }] = await Promise.all([
          import('./ts/characterCards'),
          import('./ts/globalApi.svelte'),
        ])
        if (!isClientWriteOperationCurrent(clientGeneration)) return
        await importCharacterFile(file, file.name)
        if (!isClientWriteOperationCurrent(clientGeneration)) return
        checkCharOrder()
      }
    } catch (error) {
      if (isClientWriteOperationCurrent(clientGeneration)) alertError(error as Error)
    }
  }}
  onclick={() => {
    if (keepingSessionAlive) {
      return
    }

    const advancedStatus = settingsResourceState.groupStatuses.advanced ?? settingsResourceState.status
    const aliveMode = advancedStatus === 'error' ? undefined : settingsResourceState.value.keepSessionAlive
    switch (aliveMode) {
      case 'sound': {
        console.log('Starting silent audio to keep session alive')
        const silentAudio = new Audio(sendSound)
        silentAudio.loop = true
        silentAudio.volume = 0.000001
        silentAudio.play()
        keepingSessionAlive = true
        break
      }
    }
  }}>
  <div
    class="pointer-events-none fixed top-3 left-1/2 z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-3">
    {#if !connectedReaderView && $startupCoordinatorStore.capabilities.canRenderShell && (pluginStartupFailed || pluginRuntimeFailed)}
      <div
        class="pointer-events-auto flex items-center gap-3 rounded-md border border-yellow-600 bg-bg px-4 py-3 text-sm shadow-lg"
        role="status"
        aria-live="polite"
        data-plugin-runtime-status>
        <span>{language.pluginRuntime.failed}</span>
        <button
          type="button"
          class="shrink-0 rounded bg-yellow-700 px-3 py-1.5 text-white disabled:cursor-wait disabled:opacity-60"
          disabled={retryingPluginRuntime}
          onclick={(event) => {
            event.stopPropagation()
            void retryPlugins()
          }}>
          {retryingPluginRuntime ? language.pluginRuntime.retrying : language.pluginRuntime.retry}
        </button>
      </div>
    {:else if !connectedReaderView && $startupCoordinatorStore.capabilities.canRenderShell && generationRecoveryStartupFailed}
      <div
        class="pointer-events-auto flex flex-wrap items-center gap-3 rounded-md border border-yellow-600 bg-bg px-4 py-3 text-sm shadow-lg"
        role="status"
        aria-live="polite"
        data-generation-recovery-status>
        <span class="min-w-0 flex-1">{language.generationRecovery.failed}</span>
        <div class="flex max-w-full flex-wrap items-center gap-2">
          <button
            type="button"
            class="shrink-0 rounded bg-yellow-700 px-3 py-1.5 text-white disabled:cursor-wait disabled:opacity-60"
            data-generation-recovery-retry
            disabled={generationRecoveryAction !== 'idle'}
            onclick={(event) => {
              event.stopPropagation()
              void retryGenerationRecovery()
            }}>
            {generationRecoveryAction === 'retrying'
              ? language.generationRecovery.retrying
              : language.generationRecovery.retry}
          </button>
          <button
            type="button"
            class="shrink-0 rounded border border-yellow-700 px-3 py-1.5 disabled:cursor-wait disabled:opacity-60"
            data-generation-recovery-discard
            disabled={generationRecoveryAction !== 'idle'}
            onclick={(event) => {
              event.stopPropagation()
              void discardGenerationRecovery()
            }}>
            {generationRecoveryAction === 'discarding'
              ? language.generationRecovery.discarding
              : language.generationRecovery.discard}
          </button>
        </div>
      </div>
    {/if}
    {#if !connectedReaderView && $startupCoordinatorStore.capabilities.canRenderShell && !$pushNotificationWarningDismissed && $pushNotificationCoordinatorState.desiredEnabled && ($pushNotificationCoordinatorState.setupFailure || $pushNotificationCoordinatorState.operationError)}
      <div class="pointer-events-auto">
        <LazyComponent loader={loadPushNotificationWarning} componentProps={{ banner: true }} />
      </div>
    {/if}
  </div>
  {#if aprilFools && canApplyWriterRoutes}
    <div class="bg-[#212121] w-full h-screen min-h-screen text-black flex relative">
      <div class="w-full max-w-3xl mx-auto py-8 px-4 flex justify-center items-center">
        <div class="flex flex-col w-full items-center text-[#bbbbbb]">
          {#if aprilFoolsPage === 0}
            <h1 class="text-3xl text-white font-bold mb-6">What can I help you?</h1>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="resize-none relative w-full bg-[#303030] rounded-3xl h-[110px] mb-6 text-[#bbbbbb]"
              placeholder="Ask me"
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  aprilFoolsPage = 1
                }
              }}>
              <textarea
                class="absolute top-0 left-0 w-full placeholder-[#bbbbbb] rounded-3xl h-full p-4 bg-transparent resize-none"
                placeholder="Ask me"></textarea>
              <div class="absolute bottom-2 left-4 flex gap-1.5">
                <button class="p-2 rounded-full border border-[#bbbbbb30]">
                  <PlusIcon size={18} color="#bbbbbb" />
                </button>
                <button class="p-2 rounded-full border border-[#bbbbbb30]">
                  <GlobeIcon size={18} color="#bbbbbb" />
                </button>
              </div>
              <div class="absolute bottom-2 right-4 flex">
                <button class="p-2 rounded-full bg-[#bbbbbb]">
                  <ArrowUpIcon size={18} color="#00000080" />
                </button>
              </div>
            </div>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="flex gap-1.5"
              onclick={() => {
                aprilFoolsPage = 1
              }}>
              <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                <span class="text-[#bbbbbb]">🔍</span>
                Search
              </button>
              <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                <span class="text-[#bbbbbb]">🎮</span>
                Games
              </button>
              <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                <span class="text-[#bbbbbb]">🎨</span>
                Roleplay
              </button>
              <button class="rounded-full border border-[#bbbbbb15] px-4 py-2"> More </button>
            </div>
          {:else}
            <h1 class="text-3xl text-white font-bold mb-6">We do not have search results.</h1>
            <p class="text-[#bbbbbb] mb-6">
              <!-- svelte-ignore a11y_missing_attribute -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <a
                class="text-blue-500 cursor-pointer"
                onclick={() => {
                  aprilFoolsPage = 0
                  aprilFools = false
                }}>
                Go to Risuai
              </a>
            </p>
          {/if}
        </div>
      </div>
      <span class="absolute top-4 left-4 font-bold text-[#bbbbbb] text-md md:text-lg">RisyGTP 9+ Mytho Ultra Free</span>
    </div>
  {:else if $clientSessionStore.managed && $clientSessionStore.lifecycle === 'auth-required'}
    <div
      class="flex h-full w-full flex-col items-center justify-center gap-4 bg-bgcolor p-6 text-textcolor"
      data-reader-auth-required>
      <p role="status">{language.connectedReaders.authenticationRequired}</p>
      <button
        type="button"
        class="rounded-md border border-textcolor/30 px-4 py-2 disabled:opacity-60"
        disabled={signingInReader}
        onclick={() => void signInReader()}>
        {language.connectedReaders.signIn}
      </button>
    </div>
  {:else if workspaceIsBooting}
    <div
      class="w-full h-full flex justify-center items-center text-textcolor text-xl bg-bgcolor flex-col"
      role="status"
      aria-live="polite"
      aria-busy="true">
      <div class="flex flex-row items-center">
        <svg
          class="animate-spin -ml-1 mr-3 h-5 w-5 text-textcolor"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        <span>Loading...</span>
      </div>

      <span class="text-sm mt-2 text-textcolor2">{LoadingStatusState.text}</span>
    </div>
  {:else}
    <Workspace
      readerMode={readOnlyWorkspaceMode}
      writerNavigationOpen={writerNavigationVisible && $sideBarStore}
      writerNavigationLabel={language.menu}
      writerContentInert={routeContentBlocked || recoveringWriterView}
      writerContentBusy={$routeResourceLoadState.status === 'loading' || recoveringWriterView}
      onWriterCloseNavigation={closeResponsiveSidebar}>
      {#snippet writerNavigation()}
        {#if writerNavigationVisible}
          <Sidebar
            openGrid={openGridRoute}
            hidden={!$sideBarStore}
            prefetchCharacter={prefetchCharacterRouteResource}
            {preloadSettingsRoute}
            {preloadGridRoute}
            {preloadPlaygroundRoute} />
        {/if}
      {/snippet}
      {#snippet writerContent()}
        {#if $CustomGUISettingMenuStore}
          <div
            class="flex h-full min-w-0 grow"
            data-risu-route-content
            inert={routeContentBlocked}
            aria-busy={$routeResourceLoadState.status === 'loading'}>
            <LazyComponent loader={loadCustomGUISettingMenu} fill testId="custom-gui-settings" />
          </div>
        {:else if renderedRoute.kind === 'settings'}
          <div
            class="flex h-full min-w-0 grow"
            data-risu-route-content
            inert={routeContentBlocked}
            aria-busy={$routeResourceLoadState.status === 'loading'}>
            <LazyComponent loader={loadSettings} fill label={language.settings} testId="settings" />
          </div>
        {:else if renderedRoute.kind === 'grid'}
          <div
            class="flex h-full min-w-0 grow"
            data-risu-route-content
            inert={routeContentBlocked}
            aria-busy={$routeResourceLoadState.status === 'loading'}>
            <LazyComponent
              loader={loadGrid}
              componentProps={{ endGrid: closeGridRoute }}
              fill
              label={language.grid}
              testId="character-grid" />
          </div>
        {:else}
          <ChatScreen route={renderedRoute} />
        {/if}
      {/snippet}
    </Workspace>
  {/if}
  {#if recoveringWriterView}
    <div
      class="pointer-events-none fixed top-3 left-1/2 z-40 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-md border border-darkborderc bg-bgcolor/95 px-4 py-2 text-center text-sm text-textcolor shadow-lg"
      data-writer-connection-recovery
      role="status"
      aria-live="polite"
      aria-busy="true">
      {$clientSessionStore.connection === 'interrupted'
        ? language.connectedReaders.interrupted
        : language.connectedReaders.connecting}
    </div>
  {/if}
  {#if routeLoadingVisible}
    <div
      class="pointer-events-none fixed top-3 left-1/2 z-40 -translate-x-1/2 rounded-md border border-darkborderc bg-bgcolor/95 px-4 py-2 text-sm text-textcolor shadow-lg"
      data-testid="route-resource-loading"
      role="status"
      aria-live="polite"
      aria-busy="true">
      <span>{language.loading}</span>
    </div>
  {:else if $routeResourceLoadState.status === 'error'}
    <div
      class="fixed top-3 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-md border border-darkborderc bg-bgcolor px-4 py-3 text-sm text-textcolor shadow-lg"
      data-testid="route-resource-error"
      role="alert">
      <span>{routeLoadErrorMessage}</span>
      <button
        bind:this={routeRetryButton}
        class="shrink-0 rounded border border-textcolor2 px-3 py-1.5"
        onclick={retryRouteLoad}>
        {language.retry}
      </button>
      {#if routeComponentLoadFailed}
        <button class="shrink-0 rounded border border-textcolor2 px-3 py-1.5" onclick={() => window.location.reload()}>
          {language.preloadReload}
        </button>
      {/if}
    </div>
  {/if}
  {#if $alertStore.type !== 'none' && (!connectedReaderView || canShowReaderAlert($alertStore))}
    <LazyComponent loader={loadAlert} modal testId="alert" />
  {/if}
  {#if canApplyWriterRoutes}
    {#if $showRealmInfoStore}
      <LazyComponent
        loader={loadRealmPopup}
        modal
        onDismiss={() => showRealmInfoStore.set(null)}
        testId="realm-popup" />
    {/if}
    {#if $openPresetList}
      <LazyComponent
        loader={loadBotPreset}
        componentProps={{
          mode: presetListModalStore.mode,
          kind: presetListModalStore.kind,
          target: presetListModalStore.target,
          close: closePresetListModal,
        }}
        modal
        onDismiss={closePresetListModal}
        testId="preset-list" />
    {/if}
    {#if $openPersonaList}
      <LazyComponent
        loader={loadPersonaList}
        componentProps={{
          mode: personaListModalStore.mode,
          target: personaListModalStore.target,
          close: closePersonaListModal,
        }}
        modal
        onDismiss={closePersonaListModal}
        testId="persona-list" />
    {/if}
    {#if $openChatGenerationTogglePresetList}
      <LazyComponent
        loader={loadChatGenerationTogglePresetDialog}
        componentProps={{
          target: chatGenerationTogglePresetListModalStore.target,
          close: closeChatGenerationTogglePresetListModal,
        }}
        modal
        onDismiss={closeChatGenerationTogglePresetListModal}
        testId="chat-generation-toggle-presets" />
    {/if}
    {#if $bookmarkListOpen}
      <LazyComponent
        loader={loadBookmarkList}
        modal
        onDismiss={() => bookmarkListOpen.set(false)}
        testId="bookmark-list" />
    {/if}
    {#if $hypaV3ModalOpen}
      <LazyComponent loader={loadHypaV3Modal} modal onDismiss={() => hypaV3ModalOpen.set(false)} testId="hypa-v3" />
    {/if}
    <SavePopupIconComp />
    {#if $activeMemoryJobsStore.length > 0}
      <LazyComponent loader={loadHypaV3Progress} testId="hypa-v3-progress" />
    {/if}
    {#if popupStore.children}
      <div class="contents" data-modal-focus-extension>
        <LazyComponent loader={loadPopupList} testId="popup-list" />
      </div>
    {/if}
    {#if easyPanelStore.open}
      <LazyComponent loader={loadEasyPanel} modal onDismiss={() => (easyPanelStore.open = false)} testId="easy-panel" />
    {/if}
    {#if popUpEditorStore.open}
      {#key popUpEditorStore.sessionId}
        <LazyComponent
          loader={loadPopupEditor}
          modal
          onDismiss={() => closePopupEditorSession(popUpEditorStore.sessionId)}
          testId="popup-editor" />
      {/key}
    {/if}
    {#if loadoutModalStore.open}
      <LazyComponent
        loader={loadLoadoutModal}
        modal
        onDismiss={() => (loadoutModalStore.open = false)}
        testId="loadout-modal" />
    {/if}
    {#if irisStore.open}
      <LazyComponent loader={loadIrisModal} modal onDismiss={() => (irisStore.open = false)} testId="iris-modal" />
    {/if}
    {#if customSideBarConfigDialogStore.open}
      <LazyComponent
        loader={loadCustomSidebarConfig}
        modal
        onDismiss={() => (customSideBarConfigDialogStore.open = false)}
        testId="custom-sidebar-config" />
    {/if}
  {/if}
  {#if $startupCoordinatorStore.capabilities.canRenderShell}
    <WriterDraftRecovery />
  {/if}
</main>
