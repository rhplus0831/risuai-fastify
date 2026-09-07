import {
  PLAYGROUND_RESOURCE_SURFACE_BY_INDEX,
  SETTINGS_RESOURCE_SURFACE_BY_INDEX,
  resolveResourceRequirements,
  resourceSurfacesForRoute,
  type ResourceRequirement,
} from '@risuai/shared-core/resource-manifest'
import { parseRoute, routePathFromState, type AppRoute } from '@risuai/shared-core/router-route'

export const fastBootstrapDirectLinkBatchCount = 4

export interface DirectLinkDefinition {
  path: string
  route: AppRoute
  finalRoute?: AppRoute
}

export interface IndexedDirectLinkDefinition {
  caseIndex: number
  definition: DirectLinkDefinition
}

export interface DirectLinkBatch {
  batchIndex: number
  batchCount: number
  cases: IndexedDirectLinkDefinition[]
}

export function directLinkCases(): DirectLinkDefinition[] {
  const stateDefaults = {
    currentRouteKind: 'home' as const,
    settingsOpen: false,
    settingsMenuIndex: -1,
    selectedCharID: -1,
    playgroundStore: 0,
  }
  const settings = Object.keys(SETTINGS_RESOURCE_SURFACE_BY_INDEX).map(Number)
  const playground = Object.keys(PLAYGROUND_RESOURCE_SURFACE_BY_INDEX).map(Number)
  const paths = [
    '/',
    '/grid',
    '/inlay',
    '/fast-bootstrap-not-found',
    '/character/fast-bootstrap-small-character',
    '/character/fast-bootstrap-small-character/fast-bootstrap-small-chat',
    ...settings.map((settingsMenuIndex) =>
      routePathFromState({ ...stateDefaults, settingsOpen: true, settingsMenuIndex }),
    ),
    ...playground.map((playgroundStore) =>
      playgroundStore === 14 ? '/playground/inlays' : routePathFromState({ ...stateDefaults, playgroundStore }),
    ),
  ]
  return paths.map((path) => ({
    path,
    route: parseRoute(path),
    ...(path === '/fast-bootstrap-not-found' ? { finalRoute: parseRoute('/') } : {}),
    ...(path === '/playground/inlays' ? { finalRoute: parseRoute('/inlay') } : {}),
  }))
}

export function directLinkBatches(
  cases: readonly DirectLinkDefinition[] = directLinkCases(),
  batchCount = fastBootstrapDirectLinkBatchCount,
): DirectLinkBatch[] {
  if (!Number.isInteger(batchCount) || batchCount < 1) throw new Error('direct-link batch count must be positive')
  const batches = Array.from({ length: batchCount }, (_, batchIndex) => ({
    batchIndex,
    batchCount,
    cases: [] as IndexedDirectLinkDefinition[],
  }))
  cases.forEach((definition, caseIndex) => {
    batches[caseIndex % batchCount]!.cases.push({ caseIndex, definition })
  })
  return batches
}

export function expectedDirectLinkSurfaces(): string[] {
  return [
    'shared:app-shell',
    'shared:settings-shell',
    'shared:playground-shell',
    'route:home',
    'route:grid',
    'route:inlay',
    'route:not-found',
    'route:character',
    'route:character-chat',
    'runtime:chat-display',
    'runtime:chat-generation',
    ...Object.values(SETTINGS_RESOURCE_SURFACE_BY_INDEX),
    ...Object.values(PLAYGROUND_RESOURCE_SURFACE_BY_INDEX),
  ]
}

export function requiredResourcePaths(route: AppRoute): string[] {
  const requirements = resolveResourceRequirements(
    resourceSurfacesForRoute(route).filter((surface) => surface !== 'shared:app-shell'),
  )
  return [...new Set(requirements.flatMap((requirement) => requirementResourcePaths(requirement, route)))].sort()
}

export function startupRuntimeResourcePaths(route: AppRoute): string[] {
  const requirements = resolveResourceRequirements([
    'runtime:plugins',
    'runtime:background-effects',
    'runtime:chat-generation',
  ])
  return [...new Set(requirements.flatMap((requirement) => requirementResourcePaths(requirement, route)))].sort()
}

export { resourceSurfacesForRoute }

function requirementResourcePaths(requirement: ResourceRequirement, route: AppRoute): string[] {
  switch (requirement.kind) {
    case 'settings-group':
      return [`/api/v1/settings/${requirement.group}`]
    case 'collection':
      return [`/api/v1/collections/${requirement.collection}`]
    case 'standalone-setting':
      return [`/api/v1/resources/settings/${requirement.setting}`]
    case 'projection':
      switch (requirement.projection) {
        case 'character-summaries':
        case 'character-selection':
        case 'selected-prompt-template':
          return []
        case 'selected-character':
          return route.kind === 'character' ? [`/api/v1/characters/${encodeURIComponent(route.chaId)}`] : []
        case 'selected-chat':
          return route.kind === 'character' && route.chatId
            ? [`/api/v1/chats/${encodeURIComponent(route.chatId)}/messages`]
            : []
        case 'inlay-catalog':
          return ['/api/v1/inlay-assets']
      }
  }
}
