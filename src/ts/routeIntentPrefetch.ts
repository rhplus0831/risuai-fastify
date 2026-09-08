import { canUseClientWriteAccess } from './clientSession'
import { prefetchRoutePathResources } from './server/routeResourceLoader'
import { preloadRouteComponents } from './routeComponentPreload'
import { parseRoute } from './routerRoute'

export type RouteModuleLoader = () => Promise<unknown>

/** Warm exact route data during idle time and start its code chunks on strong navigation intent. */
export function prefetchRouteIntent(path: string, moduleLoaders: readonly RouteModuleLoader[] = []): void {
  // Reader navigation loads committed projections through its own controller.
  // Even the grid loader below is a writer adapter.
  if (!canUseClientWriteAccess()) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  prefetchRoutePathResources(path)
  void preloadRouteComponents(parseRoute(path)).catch(() => undefined)
  for (const loader of moduleLoaders) {
    void loader().catch(() => undefined)
  }
}
