import { tick } from 'svelte'
import { get, writable } from 'svelte/store'
import {
  CharEmotion,
  CustomGUISettingMenuStore,
  OpenRealmStore,
  PlaygroundStore,
  ScrollToMessageStore,
  bardWikiWorkspaceOpenRequest,
  botMakerMode,
  selectedCharID,
  settingsOpen,
} from './stores.svelte'
import { hasActiveModuleEditorLeaveGuard, requestActiveModuleEditorLeave } from './moduleEditorLeaveGuard'
import { failActiveRouteLoad, finishRouteResources, prepareRouteResources } from './server/routeResourceLoader'
import { charactersResourceState } from './server/resourceState.svelte'
import { preloadRouteComponents } from './routeComponentPreload'
import {
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from './clientSession'
import {
  characterRoutePath,
  normalizePath,
  parseRoute,
  personaSettingsRoutePath,
  routeKey,
  routePathFromState,
  type AppRoute,
  type StateRouteInput,
} from './routerRoute'

export {
  characterRoutePath,
  parseRoute,
  personaSettingsRoutePath,
  type AppRoute,
  type StateRouteInput,
} from './routerRoute'

const GRID_HISTORY_STATE_KEY = '__risuGridNavigation'
const GRID_HISTORY_STATE_VERSION = 1
const SETTINGS_HISTORY_STATE_KEY = '__risuSettingsNavigation'
const SETTINGS_HISTORY_STATE_VERSION = 1
const CHARACTER_SIDEBAR_VIEW_STATE_KEY = '__risuCharacterSidebarView'
const CHARACTER_SIDEBAR_VIEW_STATE_VERSION = 1

interface GridHistoryState {
  [GRID_HISTORY_STATE_KEY]: {
    originPath: string
    version: typeof GRID_HISTORY_STATE_VERSION
  }
}

interface SettingsHistoryState {
  [SETTINGS_HISTORY_STATE_KEY]: {
    originPath: string
    version: typeof SETTINGS_HISTORY_STATE_VERSION
  }
}

interface CharacterSidebarViewState {
  [CHARACTER_SIDEBAR_VIEW_STATE_KEY]: {
    characterId: string
    routeKey: string
    version: typeof CHARACTER_SIDEBAR_VIEW_STATE_VERSION
  }
}

let routerInstalled = false
let applyingRoute = false
const initialRoute = parseRoute(typeof window === 'undefined' ? '/' : window.location.pathname)
let routeApplicationPending = initialRoute.kind !== 'home'
let skipNextRouteApplication = false
let routeApplicationEpoch = 0
let gridHistoryTraversalPending = false
let settingsHistoryTraversalPending = false
let approvedModuleEditorHistoryTraversal = false

interface PendingChatMessageJump {
  messageIndex: number
  routeKey: string
}

let pendingChatMessageJump: PendingChatMessageJump | null = null

export const currentRoute = writable<AppRoute>(initialRoute)

export function installRouter(): void {
  if (routerInstalled || typeof window === 'undefined') return
  routerInstalled = true
  window.addEventListener('popstate', () => {
    gridHistoryTraversalPending = false
    settingsHistoryTraversalPending = false
    if (approvedModuleEditorHistoryTraversal) {
      approvedModuleEditorHistoryTraversal = false
    } else if (!requestActiveModuleEditorLeave()) {
      approvedModuleEditorHistoryTraversal = true
      window.history.forward()
      return
    }
    routeApplicationPending = true
    currentRoute.set(parseRoute(window.location.pathname))
  })
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (typeof window === 'undefined') return

  const canonicalPath = path
  const nextRoute = parseRoute(canonicalPath)
  // Direct URLs and popstate remain visible to the reader shell's route gate.
  // In-app restricted entries never replace the reader's current selection.
  if (!canUseClientWriteAccess() && ['settings', 'playground', 'inlay'].includes(nextRoute.kind)) return
  if (routeKey(get(currentRoute)) !== routeKey(nextRoute) && !requestActiveModuleEditorLeave()) return

  if (nextRoute.kind === 'settings') {
    const currentPath = normalizePath(window.location.pathname)
    const currentRouteKind = parseRoute(currentPath).kind
    if (currentRouteKind === 'settings') {
      commitPath(canonicalPath, {
        replace: true,
        stateDriven: false,
        historyState: window.history.state,
      })
      return
    }

    commitPath(canonicalPath, {
      replace: options.replace ?? false,
      stateDriven: false,
      ...((options.replace ?? false) ? {} : { historyState: settingsHistoryState(currentPath) }),
    })
    return
  }

  commitPath(canonicalPath, {
    replace: options.replace ?? false,
    stateDriven: false,
  })
}

export function navigateToCharacterChatMessage(characterId: string, chatId: string, messageIndex: number): void {
  if (!characterId || !chatId || !Number.isInteger(messageIndex) || messageIndex < 0) return

  const path = characterRoutePath(characterId, chatId)
  const targetRoute = parseRoute(path)
  if (targetRoute.kind !== 'character') return

  const request: PendingChatMessageJump = {
    messageIndex,
    routeKey: routeKey(targetRoute),
  }
  pendingChatMessageJump = request
  navigate(path)

  if (routeKey(get(currentRoute)) !== request.routeKey) {
    if (pendingChatMessageJump === request) pendingChatMessageJump = null
    return
  }

  if (!routeApplicationPending && !applyingRoute) {
    void deliverPendingChatMessageJump(targetRoute, () => routeKey(get(currentRoute)) === request.routeKey)
  }
}

export function openSettingsRoute(path = '/settings'): void {
  if (parseRoute(path).kind !== 'settings') return
  settingsHistoryTraversalPending = false
  navigate(path)
}

export function closeSettingsRoute(): void {
  if (typeof window === 'undefined') return

  const isSettingsRoute = parseRoute(window.location.pathname).kind === 'settings'
  if (isSettingsRoute && settingsOriginPath(window.history.state)) {
    if (settingsHistoryTraversalPending) return
    const hasModuleEditorGuard = hasActiveModuleEditorLeaveGuard()
    if (hasModuleEditorGuard && !requestActiveModuleEditorLeave()) return
    approvedModuleEditorHistoryTraversal = hasModuleEditorGuard
    settingsHistoryTraversalPending = true
    window.history.back()
    return
  }

  settingsHistoryTraversalPending = false
  navigate('/', { replace: true })
}

export function canOpenBardWikiWorkspaceFromSettings(): boolean {
  return bardWikiWorkspaceOriginFromSettings() !== null
}

export function openBardWikiWorkspaceFromSettings(): void {
  const origin = bardWikiWorkspaceOriginFromSettings()
  if (!origin) return
  bardWikiWorkspaceOpenRequest.set({ characterId: origin.chaId, ...(origin.chatId ? { chatId: origin.chatId } : {}) })
  closeSettingsRoute()
}

function bardWikiWorkspaceOriginFromSettings(): Extract<AppRoute, { kind: 'character' }> | null {
  if (typeof window === 'undefined') return null
  const originPath = settingsOriginPath(window.history.state)
  if (!originPath) return null
  const origin = parseRoute(originPath)
  return origin.kind === 'character' ? origin : null
}

export function openGridRoute(): void {
  if (typeof window === 'undefined') return

  gridHistoryTraversalPending = false
  const originPath = normalizePath(window.location.pathname)
  if (parseRoute(originPath).kind === 'grid') return
  if (!requestActiveModuleEditorLeave()) return

  const historyState: GridHistoryState = {
    [GRID_HISTORY_STATE_KEY]: {
      originPath,
      version: GRID_HISTORY_STATE_VERSION,
    },
  }
  commitPath('/grid', {
    replace: false,
    stateDriven: false,
    historyState,
  })
}

export function closeGridRoute(): void {
  if (typeof window === 'undefined') return

  const isGridRoute = parseRoute(window.location.pathname).kind === 'grid'
  if (isGridRoute && gridOriginPath(window.history.state)) {
    if (gridHistoryTraversalPending) return
    gridHistoryTraversalPending = true
    window.history.back()
    return
  }

  gridHistoryTraversalPending = false
  navigate('/', { replace: true })
}

export function syncRouteFromState(input: StateRouteInput): void {
  if (applyingRoute || typeof window === 'undefined' || !canUseClientWriteAccess()) return
  const path = routePathFromState(input)

  const currentPath = normalizePath(window.location.pathname)
  const currentRouteKind = parseRoute(currentPath).kind
  if (parseRoute(path).kind === 'settings') {
    commitPath(path, {
      replace: currentRouteKind === 'settings',
      stateDriven: true,
      historyState: currentRouteKind === 'settings' ? window.history.state : settingsHistoryState(currentPath),
    })
    return
  }

  commitPath(path, { replace: true, stateDriven: true })
}

export function consumeStateDrivenRouteUpdate(): boolean {
  if (!skipNextRouteApplication) return false
  skipNextRouteApplication = false
  return true
}

export function isApplyingRouteToStores(): boolean {
  return applyingRoute
}

export function hasPendingRouteApplication(): boolean {
  return routeApplicationPending
}

/** Keep the character/chat sidebar choice on this exact history entry. */
export function setCharacterSidebarViewMode(view: 'chat' | 'character'): void {
  if (!canUseClientWriteAccess()) return
  const characterView = view === 'character'
  botMakerMode.set(characterView)
  if (typeof window === 'undefined') return

  const previousState = historyStateRecord(window.history.state)
  if (!characterView) {
    if (!Object.prototype.hasOwnProperty.call(previousState, CHARACTER_SIDEBAR_VIEW_STATE_KEY)) return
    delete previousState[CHARACTER_SIDEBAR_VIEW_STATE_KEY]
    replaceCurrentHistoryState(previousState)
    return
  }

  const route = parseRoute(window.location.pathname)
  if (route.kind !== 'character') return
  previousState[CHARACTER_SIDEBAR_VIEW_STATE_KEY] = {
    characterId: route.chaId,
    routeKey: routeKey(route),
    version: CHARACTER_SIDEBAR_VIEW_STATE_VERSION,
  }
  replaceCurrentHistoryState(previousState)
}

/** Restore same-entry presentation after recovery without applying a selection route. */
export function restoreCharacterSidebarViewFromHistory(): void {
  const route = get(currentRoute)
  if (route.kind !== 'character') return
  restoreCharacterSidebarViewMode(route, canUseClientWriteAccess)
}

export async function applyRouteToStores(route: AppRoute): Promise<boolean> {
  if (!canUseClientWriteAccess()) return false
  const sessionGeneration = captureClientSessionGeneration()
  const applicationEpoch = ++routeApplicationEpoch
  const isFreshRouteApplication = () =>
    applicationEpoch === routeApplicationEpoch &&
    isClientSessionGenerationCurrent(sessionGeneration) &&
    canUseClientWriteAccess()
  applyingRoute = true
  try {
    let componentLoadError: unknown
    const [resourcesReady, componentsReady] = await Promise.all([
      prepareRouteResources(route),
      preloadRouteComponents(route).then(
        () => true,
        (error: unknown) => {
          componentLoadError = error
          return false
        },
      ),
    ])
    if (!isFreshRouteApplication()) return false
    if (!resourcesReady) return false
    if (!componentsReady) {
      failActiveRouteLoad(route, componentLoadError ?? new Error('Route component preload failed'))
      return false
    }
    closeRouteBlockingViews()
    switch (route.kind) {
      case 'home': {
        selectedCharID.set(-1)
        settingsOpen.set(false)
        PlaygroundStore.set(0)
        OpenRealmStore.set(false)
        break
      }
      case 'settings': {
        const { applySettingsRoute } = await import('./routeHandlers/settings')
        if (!isFreshRouteApplication()) return false
        await applySettingsRoute(route, {
          isFresh: isFreshRouteApplication,
          replacePath: (path) =>
            commitPath(path, { replace: true, stateDriven: true, historyState: window.history.state }),
        })
        break
      }
      case 'grid': {
        selectedCharID.set(-1)
        settingsOpen.set(false)
        PlaygroundStore.set(0)
        OpenRealmStore.set(false)
        break
      }
      case 'inlay': {
        const { applyPlaygroundRoute } = await import('./routeHandlers/playground')
        if (!isFreshRouteApplication()) return false
        await applyPlaygroundRoute(route, isFreshRouteApplication)
        break
      }
      case 'playground': {
        const { applyPlaygroundRoute } = await import('./routeHandlers/playground')
        if (!isFreshRouteApplication()) return false
        await applyPlaygroundRoute(route, isFreshRouteApplication)
        break
      }
      case 'character': {
        const { applyCharacterRoute } = await import('./routeHandlers/character')
        if (!isFreshRouteApplication()) return false
        await applyCharacterRoute(route, {
          isFresh: isFreshRouteApplication,
          replacePath: (path) => commitPath(path, { replace: true, stateDriven: true }),
        })
        restoreCharacterSidebarViewMode(route, isFreshRouteApplication)
        await deliverPendingChatMessageJump(route, isFreshRouteApplication)
        break
      }
      case 'not-found': {
        selectedCharID.set(-1)
        settingsOpen.set(false)
        PlaygroundStore.set(0)
        OpenRealmStore.set(false)
        break
      }
    }
    if (!isFreshRouteApplication()) return false
    return finishRouteResources(route)
  } finally {
    queueMicrotask(() => {
      if (applicationEpoch !== routeApplicationEpoch) return
      if (pendingChatMessageJump && pendingChatMessageJump.routeKey !== routeKey(get(currentRoute))) {
        pendingChatMessageJump = null
      }
      applyingRoute = false
      routeApplicationPending = false
    })
  }
}

export function retryCurrentRouteApplication(): Promise<boolean> {
  return applyRouteToStores(get(currentRoute))
}

async function deliverPendingChatMessageJump(route: AppRoute, isFresh: () => boolean): Promise<void> {
  const request = pendingChatMessageJump
  if (!request || request.routeKey !== routeKey(route)) return

  await tick()
  if (pendingChatMessageJump !== request || !isFresh() || request.routeKey !== routeKey(get(currentRoute))) {
    return
  }

  pendingChatMessageJump = null
  ScrollToMessageStore.value = request.messageIndex
}

export function navigateToPersonaSettings(personaId: string): void {
  if (!personaId.trim()) return
  navigate(personaSettingsRoutePath(personaId), { replace: true })
}

function closeRouteBlockingViews(): void {
  CustomGUISettingMenuStore.set(false)
  botMakerMode.set(false)
  CharEmotion.set({})
}

function restoreCharacterSidebarViewMode(
  route: Extract<AppRoute, { kind: 'character' }>,
  isFresh: () => boolean,
): void {
  if (!isFresh() || !characterSidebarViewStateMatches(route)) return
  const selectedCharacter = selectedCharacterForSidebarRestore()
  if (selectedCharacter?.chaId === route.chaId) botMakerMode.set(true)
}

function selectedCharacterForSidebarRestore() {
  const status = charactersResourceState.status
  if (status === 'ready') {
    const selectedIndex =
      charactersResourceState.selectionRevision === null ? get(selectedCharID) : charactersResourceState.currentChar
    const candidate = charactersResourceState.characters[selectedIndex]
    if (!candidate?.chaId) return undefined
    return charactersResourceState.characters.filter((character) => character.chaId === candidate.chaId).length === 1
      ? candidate
      : undefined
  }
  return undefined
}

function characterSidebarViewStateMatches(route: Extract<AppRoute, { kind: 'character' }>): boolean {
  if (typeof window === 'undefined') return false
  const candidate = historyStateRecord(window.history.state)[CHARACTER_SIDEBAR_VIEW_STATE_KEY]
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
  const state = candidate as Partial<CharacterSidebarViewState[typeof CHARACTER_SIDEBAR_VIEW_STATE_KEY]>
  return (
    state.version === CHARACTER_SIDEBAR_VIEW_STATE_VERSION &&
    state.characterId === route.chaId &&
    state.routeKey === routeKey(route)
  )
}

function historyStateRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}
}

function replaceCurrentHistoryState(state: Record<string, unknown>): void {
  window.history.replaceState(Object.keys(state).length === 0 ? null : state, '', window.location.href)
}

function commitPath(
  path: string,
  options: {
    historyState?: unknown
    replace: boolean
    stateDriven: boolean
  },
): void {
  if (typeof window === 'undefined') return
  const normalizedPath = normalizePath(path)
  const currentPath = normalizePath(window.location.pathname)
  const nextRoute = parseRoute(normalizedPath)
  const routeChanged = routeKey(get(currentRoute)) !== routeKey(nextRoute)
  const pathChanged = currentPath !== normalizedPath

  if (!options.stateDriven) {
    skipNextRouteApplication = false
  }

  if (!pathChanged && !routeChanged) {
    return
  }

  if (pathChanged) {
    const method = options.replace ? 'replaceState' : 'pushState'
    window.history[method](options.historyState ?? null, '', normalizedPath)
  }
  if (options.stateDriven) {
    skipNextRouteApplication = true
    routeApplicationPending = false
  } else {
    routeApplicationPending = true
  }
  currentRoute.set(nextRoute)
}

function gridOriginPath(historyState: unknown): string | null {
  if (!historyState || typeof historyState !== 'object') return null

  const gridState = (historyState as Partial<GridHistoryState>)[GRID_HISTORY_STATE_KEY]
  if (!gridState || gridState.version !== GRID_HISTORY_STATE_VERSION || typeof gridState.originPath !== 'string') {
    return null
  }

  const originPath = normalizePath(gridState.originPath)
  return parseRoute(originPath).kind === 'grid' ? null : originPath
}

function settingsHistoryState(originPath: string): SettingsHistoryState {
  return {
    [SETTINGS_HISTORY_STATE_KEY]: {
      originPath: normalizePath(originPath),
      version: SETTINGS_HISTORY_STATE_VERSION,
    },
  }
}

function settingsOriginPath(historyState: unknown): string | null {
  if (!historyState || typeof historyState !== 'object') return null

  const settingsState = (historyState as Partial<SettingsHistoryState>)[SETTINGS_HISTORY_STATE_KEY]
  if (
    !settingsState ||
    settingsState.version !== SETTINGS_HISTORY_STATE_VERSION ||
    typeof settingsState.originPath !== 'string'
  ) {
    return null
  }

  const originPath = normalizePath(settingsState.originPath)
  return parseRoute(originPath).kind === 'settings' ? null : originPath
}
