import { beforeEach, describe, expect, it, vi } from 'vitest'
import { beginClientSession, resetClientSessionForTests } from './clientSession'
import { prefetchRouteIntent } from './routeIntentPrefetch'
import { preloadRouteComponents } from './routeComponentPreload'
import { prefetchRoutePathResources } from './server/routeResourceLoader'

vi.mock('./server/routeResourceLoader', () => ({ prefetchRoutePathResources: vi.fn() }))
vi.mock('./routeComponentPreload', () => ({ preloadRouteComponents: vi.fn(async () => {}) }))

beforeEach(() => {
  resetClientSessionForTests()
  vi.clearAllMocks()
})

describe('route intent authority', () => {
  it('denies reader warming before resource, component, and extra module loaders', () => {
    beginClientSession('reader-a')
    const additionalLoader = vi.fn(async () => {})
    for (const path of ['/settings', '/settings/plugins', '/playground', '/inlay', '/grid', '/character/a/b']) {
      prefetchRouteIntent(path, [additionalLoader])
    }
    expect(prefetchRoutePathResources).not.toHaveBeenCalled()
    expect(preloadRouteComponents).not.toHaveBeenCalled()
    expect(additionalLoader).not.toHaveBeenCalled()
  })

  it('preserves authorized writer warming', () => {
    const additionalLoader = vi.fn(async () => {})
    prefetchRouteIntent('/settings', [additionalLoader])
    expect(prefetchRoutePathResources).toHaveBeenCalledWith('/settings')
    expect(preloadRouteComponents).toHaveBeenCalledOnce()
    expect(additionalLoader).toHaveBeenCalledOnce()
  })
})
