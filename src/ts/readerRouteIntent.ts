import { routeKey, type AppRoute } from './routerRoute'

export interface ReaderRouteIntent {
  route: AppRoute
  sequence: number
}

let latestIntent: ReaderRouteIntent | null = null
let nextSequence = 0

/**
 * Retain only the latest presentation choice made before writer promotion.
 * Observer navigation is deliberately memory-only: this module never imports
 * the command transport or the durable mutation outbox.
 */
export function recordReaderRouteIntent(route: AppRoute): ReaderRouteIntent {
  if (latestIntent && routeKey(latestIntent.route) === routeKey(route)) return latestIntent

  latestIntent = {
    route: cloneRoute(route),
    sequence: ++nextSequence,
  }
  return latestIntent
}

export function peekReaderRouteIntent(): ReaderRouteIntent | null {
  return latestIntent ? { route: cloneRoute(latestIntent.route), sequence: latestIntent.sequence } : null
}

/** Consume an exact reader intent once after writer-safe reconciliation. */
export function consumeReaderRouteIntent(sequence: number): ReaderRouteIntent | null {
  if (!latestIntent || latestIntent.sequence !== sequence) return null
  const consumed = peekReaderRouteIntent()
  latestIntent = null
  return consumed
}

export function clearReaderRouteIntent(): void {
  latestIntent = null
}

export function resetReaderRouteIntentForTests(): void {
  latestIntent = null
  nextSequence = 0
}

function cloneRoute(route: AppRoute): AppRoute {
  return { ...route }
}
