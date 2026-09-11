import { get, writable } from 'svelte/store'
import {
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import { characterRoutePath, parseRoute, type AppRoute } from '../routerRoute'
import { routeKey } from '../routerRoute'
import { hydrateActiveChat, hydrateChatMessageWindow } from './chatMessageHydration.svelte'
import { getInitialChatLoadPages } from '@risuai/shared-core/chat-load-pages'
import { peekAppliedServerResourceRevision } from './commands'
import { getServerInlayCatalogResource } from './inlayCatalog'
import { SERVER_CHARACTER_SHELL_MARKER } from '@risuai/protocol/character-summary-resource'
import {
  RESOURCE_SURFACE_MANIFEST,
  resolveResourceRequirements,
  resourceRequirementIdentity,
  resourceSurfacesForRoute,
  type ResourceRequirement,
  type ResourceSurfaceId,
} from './resourceManifest'
import { refreshServerResourceTargets, type ServerResourceRefreshResult } from './resourceInvalidation'
import { fetchServerStandaloneSetting } from './resourceReads'
import { hydrateCharacterShell } from './characterShellHydration.svelte'
import { lorebookPageOwner } from './lorebookPageOwner.svelte'
import {
  applyStandaloneSettingResource,
  beginCollectionsResourceLoad,
  beginSettingsGroupResourceLoad,
  beginStandaloneSettingResourceLoad,
  charactersResourceState,
  collectionsResourceState,
  failCollectionsResourceLoad,
  failSettingsGroupResourceLoad,
  failStandaloneSettingResourceLoad,
  settingsResourceState,
} from './resourceState.svelte'
import { currentPromptTemplateOwnerId, ensurePromptTemplateHydrated } from './promptTemplateHydration'

export type RouteResourceLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface RouteResourceLoadState {
  error: string | null
  errorKind?: 'component'
  offline?: boolean
  routeKey: string | null
  status: RouteResourceLoadStatus
}

interface ActiveRouteLoad {
  generation: number
  controller: AbortController
  key: string
}

interface RequirementLoadResult {
  error?: string
  identity: string
  ok: boolean
}

interface InFlightRequirementLoad {
  minimumRevision: number | undefined
  owner?: object
  promise: Promise<RequirementLoadResult>
  signal: AbortSignal | null
}

interface DeferredSurfaceRequest {
  owner?: object
  promise: Promise<void>
  signal: AbortSignal | null
}

interface PendingRoutePrefetch {
  generation: number
  controller: AbortController
  idleHandle: number | null
  key: string
  promise: Promise<void> | null
  requirements: ResourceRequirement[]
  route: AppRoute
  source: 'background' | 'intent'
}

const initialState: RouteResourceLoadState = { error: null, routeKey: null, status: 'idle' }

export const routeResourceLoadState = writable<RouteResourceLoadState>(initialState)

let activeRouteLoad: ActiveRouteLoad | null = null
let pendingRoutePrefetch: PendingRoutePrefetch | null = null
let backgroundCharacterWarmupStarted = false
let backgroundCharacterWarmupQueue: string[] = []
const deferredSurfaceRequests = new Map<string, DeferredSurfaceRequest>()
const requirementRequests = new Map<string, InFlightRequirementLoad>()

export const BACKGROUND_CHARACTER_WARMUP_LIMIT = 3

/** Load the non-shell resources needed before route stores can be applied safely. */
export async function prepareRouteResources(route: AppRoute): Promise<boolean> {
  if (!canUseClientWriteAccess()) return false
  promoteMatchingRoutePrefetch(route)
  const key = routeKey(route)
  activeRouteLoad?.controller.abort()
  const controller = new AbortController()
  const load: ActiveRouteLoad = { controller, key, generation: captureClientSessionGeneration() }
  activeRouteLoad = load
  routeResourceLoadState.set({ error: null, routeKey: key, status: 'loading' })

  const surfaces = resourceSurfacesForRoute(route).filter((surface) => surface !== 'shared:app-shell')
  const requirements = resolveResourceRequirements(surfaces).filter(
    (requirement) => !isPostRouteRequirement(requirement),
  )
  const minimumRevision = peekAppliedServerResourceRevision() ?? undefined
  const results = await Promise.all(
    requirements.map((requirement) => safeLoadRequirement(requirement, route, controller.signal, minimumRevision)),
  )

  if (!isCurrentRouteLoad(load)) return false
  const failure = results.find((result) => !result.ok)
  if (failure) {
    routeResourceLoadState.set({
      error: failure.error ?? `Failed to load ${failure.identity}`,
      routeKey: key,
      status: 'error',
    })
    return false
  }
  if (!(await prepareRouteTargetResources(route, load, minimumRevision))) return false
  return true
}

/** Revalidate the selected target and apply compatibility projections after route stores commit. */
export async function finishRouteResources(route: AppRoute): Promise<boolean> {
  const load = activeRouteLoad
  if (!load || load.key !== routeKey(route) || !isCurrentRouteLoad(load)) return false

  try {
    if (route.kind === 'character' && route.chatId) {
      if (!(await hydrateActiveChat())) throw new Error('Selected chat hydration failed')
      if (!isCurrentRouteLoad(load)) return false

      const ownerId = activePromptTemplateOwnerId(route.chatId)
      const hydrated = await ensurePromptTemplateHydrated({
        ...(ownerId !== currentPromptTemplateOwnerId() ? { applyProjection: false } : {}),
        minimumRevision: peekAppliedServerResourceRevision() ?? undefined,
        promptPresetId: ownerId,
      })
      if (!hydrated) throw new Error('Selected prompt-template hydration failed')
    }
  } catch (error) {
    if (!isCurrentRouteLoad(load)) return false
    routeResourceLoadState.set({
      error: error instanceof Error ? error.message : String(error),
      routeKey: load.key,
      status: 'error',
    })
    return false
  }

  if (!isCurrentRouteLoad(load)) return false
  routeResourceLoadState.set({ error: null, routeKey: load.key, status: 'ready' })
  scheduleNextBackgroundCharacterWarmup()
  return true
}

/** Publish a non-resource preparation failure only when this route still owns the active transition. */
export function failActiveRouteLoad(route: AppRoute, error: unknown): boolean {
  const load = activeRouteLoad
  if (!load || load.key !== routeKey(route) || !isCurrentRouteLoad(load)) return false
  routeResourceLoadState.set({
    error: error instanceof Error ? error.message : String(error),
    errorKind: 'component',
    offline: typeof navigator !== 'undefined' && navigator.onLine === false,
    routeKey: load.key,
    status: 'error',
  })
  return true
}

/** Load a deferred runtime/overlay surface once, sharing concurrent callers. */
export function ensureResourceSurfaces(
  surfaceIds: readonly ResourceSurfaceId[],
  options: { owner?: object; signal?: AbortSignal | null } = {},
): Promise<void> {
  const ids = [...new Set(surfaceIds)].sort()
  const requestKey = ids.join('\u0000')
  const existing = deferredSurfaceRequests.get(requestKey)
  const signal = options.signal ?? null
  if (existing && !existing.signal?.aborted && existing.owner === options.owner) return existing.promise

  const entry = {} as DeferredSurfaceRequest
  entry.owner = options.owner
  entry.signal = signal
  entry.promise = (async () => {
    const requirements = resolveResourceRequirements(ids).filter((requirement) => !isPostRouteRequirement(requirement))
    const minimumRevision = peekAppliedServerResourceRevision() ?? undefined
    const results = await Promise.all(
      requirements.map((requirement) => safeLoadRequirement(requirement, null, signal, minimumRevision, options.owner)),
    )
    const failure = results.find((result) => !result.ok)
    if (failure) throw new Error(failure.error ?? `Failed to load ${failure.identity}`)
  })().finally(() => {
    if (deferredSurfaceRequests.get(requestKey) === entry) deferredSurfaceRequests.delete(requestKey)
  })
  deferredSurfaceRequests.set(requestKey, entry)
  return entry.promise
}

export function stopRouteResourceLoader(): void {
  activeRouteLoad?.controller.abort()
  activeRouteLoad = null
  cancelRoutePrefetch()
  backgroundCharacterWarmupStarted = false
  backgroundCharacterWarmupQueue = []
  routeResourceLoadState.set(initialState)
}

/** Prefetch a likely character route without hydrating its chat or prompt body. */
export function prefetchCharacterRouteResource(characterId: string): void {
  if (!canUseClientWriteAccess() || !characterId.trim()) return
  const resident = charactersResourceState.characters.find((candidate) => candidate?.chaId === characterId)
  if (!resident || (resident as unknown as Record<string, unknown>)[SERVER_CHARACTER_SHELL_MARKER] !== true) return
  scheduleRoutePrefetch(parseRoute(characterRoutePath(characterId)), 'intent', [selectedCharacterRequirement()])
}

/** Prefetch the pre-route data for an exact settings, Playground, grid, or inlay target. */
export function prefetchRoutePathResources(path: string): void {
  scheduleRoutePrefetch(parseRoute(path), 'intent')
}

/** Warm a small, likely-next set after optional startup work has settled. */
export function startLikelyCharacterRouteWarmup(limit = BACKGROUND_CHARACTER_WARMUP_LIMIT): void {
  if (backgroundCharacterWarmupStarted || !canRunBackgroundWarmup()) return
  backgroundCharacterWarmupStarted = true
  backgroundCharacterWarmupQueue = likelyCharacterWarmupIds(
    Math.max(0, Math.min(limit, BACKGROUND_CHARACTER_WARMUP_LIMIT)),
  )
  scheduleNextBackgroundCharacterWarmup()
}

function scheduleRoutePrefetch(
  route: AppRoute,
  source: PendingRoutePrefetch['source'],
  requirements = preRouteRequirements(route),
): boolean {
  if (
    !canUseClientWriteAccess() ||
    typeof window === 'undefined' ||
    typeof window.requestIdleCallback !== 'function' ||
    get(routeResourceLoadState).status !== 'ready' ||
    !requirements.some((requirement) => !requirementIsReady(requirement, route))
  ) {
    return false
  }

  const key = routeKey(route)
  if (pendingRoutePrefetch?.key === key) return true
  if (source === 'background' && pendingRoutePrefetch?.source === 'intent') return false

  cancelRoutePrefetch()
  const prefetch: PendingRoutePrefetch = {
    controller: new AbortController(),
    generation: captureClientSessionGeneration(),
    idleHandle: null,
    key,
    promise: null,
    requirements,
    route,
    source,
  }
  pendingRoutePrefetch = prefetch
  prefetch.idleHandle = window.requestIdleCallback(() => startRoutePrefetch(prefetch), { timeout: 750 })
  return true
}

function startRoutePrefetch(prefetch: PendingRoutePrefetch): void {
  if (pendingRoutePrefetch !== prefetch || prefetch.controller.signal.aborted || prefetch.promise) return
  if (!canUseClientWriteAccess() || !isClientSessionGenerationCurrent(prefetch.generation)) {
    cancelRoutePrefetch()
    return
  }
  prefetch.idleHandle = null
  const minimumRevision = peekAppliedServerResourceRevision() ?? undefined
  prefetch.promise = Promise.all(
    prefetch.requirements.map((requirement) =>
      safeLoadRequirement(requirement, prefetch.route, prefetch.controller.signal, minimumRevision),
    ),
  )
    .then(() => undefined)
    .finally(() => {
      if (pendingRoutePrefetch === prefetch) pendingRoutePrefetch = null
      scheduleNextBackgroundCharacterWarmup()
    })
}

function promoteMatchingRoutePrefetch(route: AppRoute): void {
  const prefetch = pendingRoutePrefetch
  if (!prefetch) return
  if (!routePrefetchMatches(prefetch.route, route)) {
    cancelRoutePrefetch()
    return
  }
  if (prefetch.idleHandle === null) return
  window.cancelIdleCallback(prefetch.idleHandle)
  prefetch.idleHandle = null
  startRoutePrefetch(prefetch)
}

function cancelRoutePrefetch(): void {
  const prefetch = pendingRoutePrefetch
  if (!prefetch) return
  pendingRoutePrefetch = null
  prefetch.controller.abort()
  if (prefetch.idleHandle !== null && typeof window !== 'undefined') {
    window.cancelIdleCallback(prefetch.idleHandle)
  }
}

function routePrefetchMatches(prefetchedRoute: AppRoute, route: AppRoute): boolean {
  if (prefetchedRoute.kind === 'character' && route.kind === 'character') {
    return prefetchedRoute.chaId === route.chaId
  }
  return routeKey(prefetchedRoute) === routeKey(route)
}

function preRouteRequirements(route: AppRoute): ResourceRequirement[] {
  const surfaces = resourceSurfacesForRoute(route).filter((surface) => surface !== 'shared:app-shell')
  return resolveResourceRequirements(surfaces).filter((requirement) => !isPostRouteRequirement(requirement))
}

function scheduleNextBackgroundCharacterWarmup(): void {
  if (
    !backgroundCharacterWarmupStarted ||
    pendingRoutePrefetch ||
    get(routeResourceLoadState).status !== 'ready' ||
    !canRunBackgroundWarmup()
  ) {
    return
  }

  while (backgroundCharacterWarmupQueue.length > 0) {
    const characterId = backgroundCharacterWarmupQueue.shift()
    if (!characterId) continue
    const resident = charactersResourceState.characters.find((candidate) => candidate?.chaId === characterId)
    if (!resident || (resident as unknown as Record<string, unknown>)[SERVER_CHARACTER_SHELL_MARKER] !== true) continue
    if (
      scheduleRoutePrefetch(parseRoute(characterRoutePath(characterId)), 'background', [selectedCharacterRequirement()])
    )
      return
  }
}

function selectedCharacterRequirement(): ResourceRequirement {
  return { kind: 'projection', projection: 'selected-character', purposes: ['render', 'interact'] }
}

function likelyCharacterWarmupIds(limit: number): string[] {
  const selectedIndex = charactersResourceState.currentChar
  return charactersResourceState.characters
    .map((character, index) => ({ character, index }))
    .filter(({ character }) => {
      const row = character as unknown as Record<string, unknown> | undefined
      return (
        typeof character?.chaId === 'string' &&
        character.chaId.trim() !== '' &&
        row?.[SERVER_CHARACTER_SHELL_MARKER] === true &&
        !(typeof row.trashTime === 'number' && Number.isFinite(row.trashTime))
      )
    })
    .sort((left, right) => {
      const leftRow = left.character as unknown as Record<string, unknown>
      const rightRow = right.character as unknown as Record<string, unknown>
      const leftPinned = Array.isArray(leftRow.pinnedChats) && leftRow.pinnedChats.length > 0 ? 1 : 0
      const rightPinned = Array.isArray(rightRow.pinnedChats) && rightRow.pinnedChats.length > 0 ? 1 : 0
      if (leftPinned !== rightPinned) return rightPinned - leftPinned
      const leftInteraction = typeof leftRow.lastInteraction === 'number' ? leftRow.lastInteraction : -1
      const rightInteraction = typeof rightRow.lastInteraction === 'number' ? rightRow.lastInteraction : -1
      if (leftInteraction !== rightInteraction) return rightInteraction - leftInteraction
      const leftDistance = selectedIndex >= 0 ? Math.abs(left.index - selectedIndex) : left.index
      const rightDistance = selectedIndex >= 0 ? Math.abs(right.index - selectedIndex) : right.index
      return leftDistance - rightDistance
    })
    .slice(0, limit)
    .map(({ character }) => character!.chaId)
}

function canRunBackgroundWarmup(): boolean {
  if (
    !canUseClientWriteAccess() ||
    typeof window === 'undefined' ||
    typeof navigator === 'undefined' ||
    typeof window.requestIdleCallback !== 'function'
  )
    return false
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
  const connection = (
    navigator as Navigator & {
      connection?: { effectiveType?: string; saveData?: boolean }
    }
  ).connection
  return connection?.saveData !== true && !['slow-2g', '2g'].includes(connection?.effectiveType ?? '')
}

function isCurrentRouteLoad(load: ActiveRouteLoad): boolean {
  return (
    canUseClientWriteAccess() &&
    isClientSessionGenerationCurrent(load.generation) &&
    activeRouteLoad === load &&
    !load.controller.signal.aborted
  )
}

function isPostRouteRequirement(requirement: ResourceRequirement): boolean {
  return (
    requirement.kind === 'projection' && ['selected-chat', 'selected-prompt-template'].includes(requirement.projection)
  )
}

async function loadRequirement(
  requirement: ResourceRequirement,
  route: AppRoute | null,
  signal: AbortSignal | null,
  minimumRevision: number | undefined,
  owner?: object,
): Promise<RequirementLoadResult> {
  const identity = resourceRequirementIdentity(requirement)
  const requestKey = requirementRequestKey(requirement, route)
  const existing = requirementRequests.get(requestKey)
  if (
    existing &&
    !existing.signal?.aborted &&
    existing.owner === owner &&
    (minimumRevision === undefined ||
      (existing.minimumRevision !== undefined && existing.minimumRevision >= minimumRevision))
  ) {
    const result = await existing.promise
    if (signal?.aborted) return { identity, ok: false, error: 'Route resource load was cancelled' }
    if (signal === null && existing.signal?.aborted) {
      return loadRequirement(requirement, route, signal, minimumRevision)
    }
    return result
  }

  const request = {} as InFlightRequirementLoad
  request.minimumRevision = minimumRevision
  request.owner = owner
  request.signal = signal
  request.promise = loadRequirementOnce(requirement, route, signal, minimumRevision).finally(() => {
    if (requirementRequests.get(requestKey) === request) requirementRequests.delete(requestKey)
  })
  requirementRequests.set(requestKey, request)
  const result = await request.promise
  return signal?.aborted ? { identity, ok: false, error: 'Route resource load was cancelled' } : result
}

async function safeLoadRequirement(
  requirement: ResourceRequirement,
  route: AppRoute | null,
  signal: AbortSignal | null,
  minimumRevision: number | undefined,
  owner?: object,
): Promise<RequirementLoadResult> {
  try {
    return await loadRequirement(requirement, route, signal, minimumRevision, owner)
  } catch (error) {
    return {
      identity: resourceRequirementIdentity(requirement),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function loadRequirementOnce(
  requirement: ResourceRequirement,
  route: AppRoute | null,
  signal: AbortSignal | null,
  minimumRevision: number | undefined,
): Promise<RequirementLoadResult> {
  const identity = resourceRequirementIdentity(requirement)
  if (signal?.aborted) return { identity, ok: false, error: 'Route resource load was cancelled' }
  if (requirementIsReady(requirement, route)) return { identity, ok: true }

  switch (requirement.kind) {
    case 'settings-group': {
      beginSettingsGroupResourceLoad(requirement.group)
      const result = await refreshServerResourceTargets(
        { settingsGroups: [requirement.group], minimumRevision },
        { signal },
      )
      return completeSettingsGroupLoad(requirement.group, identity, result, signal)
    }
    case 'collection': {
      beginCollectionsResourceLoad(requirement.collection)
      const result = await refreshServerResourceTargets(
        { collections: [requirement.collection], minimumRevision },
        { signal },
      )
      return completeCollectionLoad(requirement.collection, identity, result, signal)
    }
    case 'standalone-setting':
      return loadStandaloneSetting(requirement.setting, identity, signal, minimumRevision)
    case 'projection':
      return loadProjection(requirement, route, identity, signal, minimumRevision)
  }
}

async function loadProjection(
  requirement: Extract<ResourceRequirement, { kind: 'projection' }>,
  route: AppRoute | null,
  identity: string,
  signal: AbortSignal | null,
  minimumRevision: number | undefined,
): Promise<RequirementLoadResult> {
  switch (requirement.projection) {
    case 'character-summaries':
    case 'character-selection':
      return charactersResourceState.status === 'ready'
        ? { identity, ok: true }
        : { identity, ok: false, error: 'Character shell is unavailable' }
    case 'selected-character': {
      if (route?.kind !== 'character') return { identity, ok: true }
      return { identity, ok: await hydrateCharacterShell(route.chaId, { signal, minimumRevision }) }
    }
    case 'inlay-catalog': {
      const result = await refreshServerResourceTargets({ inlayCatalog: true, minimumRevision }, { signal })
      return refreshResult(identity, result)
    }
    case 'selected-chat':
    case 'selected-prompt-template':
      return { identity, ok: true }
  }
}

async function loadStandaloneSetting(
  setting: Extract<ResourceRequirement, { kind: 'standalone-setting' }>['setting'],
  identity: string,
  signal: AbortSignal | null,
  minimumRevision: number | undefined,
): Promise<RequirementLoadResult> {
  beginStandaloneSettingResourceLoad(setting)
  const startingRevision = settingsResourceState.revision
  const result = await fetchServerStandaloneSetting(setting, signal)
  if (signal?.aborted) return { identity, ok: false, error: 'Route resource load was cancelled' }
  if (result.status !== 'ok') {
    const error = result.status === 'error' ? result.error : 'Server resource APIs are unavailable'
    failStandaloneSettingResourceLoad(setting, error)
    return { identity, ok: false, error }
  }
  if (minimumRevision !== undefined && result.revision < minimumRevision) {
    const error = `Standalone setting response revision ${result.revision} is older than ${minimumRevision}`
    failStandaloneSettingResourceLoad(setting, error)
    return { identity, ok: false, error }
  }
  if (settingsResourceState.revision !== startingRevision) {
    const existingRevision = settingsResourceState.standaloneRevisions[setting]
    if (existingRevision !== undefined && existingRevision >= result.revision) return { identity, ok: true }
  }
  const applied = applyStandaloneSettingResource(result)
  if (!applied) {
    const error = `Standalone setting ${setting} was superseded before apply`
    failStandaloneSettingResourceLoad(setting, error)
    return { identity, ok: false, error }
  }
  if (setting === 'loreBookPage') lorebookPageOwner.hydrate(result)
  return { identity, ok: true }
}

function requirementIsReady(requirement: ResourceRequirement, route: AppRoute | null): boolean {
  switch (requirement.kind) {
    case 'settings-group':
      return settingsResourceState.groupStatuses[requirement.group] === 'ready'
    case 'collection':
      return collectionsResourceState.statuses[requirement.collection] === 'ready'
    case 'standalone-setting': {
      if (settingsResourceState.standaloneStatuses[requirement.setting] !== 'ready') return false
      if (requirement.setting !== 'loreBookPage') return true
      const owner = lorebookPageOwner.snapshot()
      return (
        owner.status === 'ready' &&
        owner.revision !== null &&
        owner.revision >= (settingsResourceState.standaloneRevisions.loreBookPage ?? -1)
      )
    }
    case 'projection':
      switch (requirement.projection) {
        case 'character-summaries':
        case 'character-selection':
          return charactersResourceState.status === 'ready'
        case 'selected-character': {
          if (route?.kind !== 'character') return true
          const resident = charactersResourceState.characters.find((candidate) => candidate?.chaId === route.chaId)
          return !!resident && (resident as unknown as Record<string, unknown>)[SERVER_CHARACTER_SHELL_MARKER] !== true
        }
        case 'inlay-catalog':
          return getServerInlayCatalogResource() !== null
        case 'selected-chat':
        case 'selected-prompt-template':
          return false
      }
  }
}

function completeSettingsGroupLoad(
  group: Extract<ResourceRequirement, { kind: 'settings-group' }>['group'],
  identity: string,
  result: ServerResourceRefreshResult,
  signal: AbortSignal | null,
): RequirementLoadResult {
  const completed = refreshResult(identity, result)
  if (!completed.ok && !signal?.aborted) failSettingsGroupResourceLoad(group, completed.error ?? 'Resource read failed')
  return completed
}

function completeCollectionLoad(
  collection: Extract<ResourceRequirement, { kind: 'collection' }>['collection'],
  identity: string,
  result: ServerResourceRefreshResult,
  signal: AbortSignal | null,
): RequirementLoadResult {
  const completed = refreshResult(identity, result)
  if (!completed.ok && !signal?.aborted) {
    failCollectionsResourceLoad(completed.error ?? 'Resource read failed', collection)
  }
  return completed
}

function refreshResult(identity: string, result: ServerResourceRefreshResult): RequirementLoadResult {
  if (result.status === 'ok') return { identity, ok: true }
  return {
    identity,
    ok: false,
    error: result.status === 'error' ? result.error : 'Server resource APIs are unavailable',
  }
}

function activePromptTemplateOwnerId(chatId: string): string | null {
  for (const character of readyRouteCharacters()) {
    const chat = character.chats?.find((candidate) => candidate.id === chatId)
    const ownerId = chat?.generationSettings?.promptPresetId
    if (typeof ownerId === 'string' && ownerId.trim() !== '') return ownerId.trim()
  }
  return currentPromptTemplateOwnerId()
}

async function prepareRouteTargetResources(
  route: AppRoute,
  load: ActiveRouteLoad,
  minimumRevision: number | undefined,
): Promise<boolean> {
  if (route.kind !== 'character' || !route.chatId) return true
  const routeCharacter = readyRouteCharacters().find((character) => character?.chaId === route.chaId)
  if (!routeCharacter?.chats?.some((chat) => chat.id === route.chatId)) return true

  try {
    const displaySettings =
      settingsResourceState.status !== 'error' && settingsResourceState.groupStatuses.display === 'ready'
        ? settingsResourceState.value
        : {}
    const ownerId = activePromptTemplateOwnerId(route.chatId)
    // Character detail already identifies both owners. Fetch their independent
    // bodies together so navigation does not pay for two serial round trips.
    const [chatHydrated, promptHydrated] = await Promise.all([
      hydrateChatMessageWindow(route.chatId, getInitialChatLoadPages(displaySettings)),
      ensurePromptTemplateHydrated({
        applyProjection: false,
        minimumRevision,
        promptPresetId: ownerId,
      }),
    ])
    if (!isCurrentRouteLoad(load)) return false
    if (!chatHydrated) throw new Error('Selected chat hydration failed')
    if (!promptHydrated) throw new Error('Selected prompt-template hydration failed')
  } catch (error) {
    if (!isCurrentRouteLoad(load)) return false
    routeResourceLoadState.set({
      error: error instanceof Error ? error.message : String(error),
      routeKey: load.key,
      status: 'error',
    })
    return false
  }

  return isCurrentRouteLoad(load)
}

function readyRouteCharacters() {
  return charactersResourceState.status === 'ready' ? charactersResourceState.characters : []
}

function requirementRequestKey(requirement: ResourceRequirement, route: AppRoute | null): string {
  const identity = resourceRequirementIdentity(requirement)
  if (requirement.kind === 'projection' && requirement.projection === 'selected-character') {
    return `${identity}:${route?.kind === 'character' ? route.chaId : ''}`
  }
  return identity
}

export function resourceSurfaceIsDeclared(surfaceId: string): surfaceId is ResourceSurfaceId {
  return Object.prototype.hasOwnProperty.call(RESOURCE_SURFACE_MANIFEST, surfaceId)
}

export function currentRouteResourceLoadState(): RouteResourceLoadState {
  return get(routeResourceLoadState)
}
