import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRoute } from './routerRoute'
import { beginClientSession, resetClientSessionForTests } from './clientSession'
import {
  loadBardWikiSettings,
  loadBotSettings,
  loadDisplaySettings,
  loadGrid,
  loadMemorySettings,
  loadPlaygroundEmbedding,
  loadPlaygroundInlayExplorer,
  loadPlaygroundMenu,
  loadSettings,
  preloadRouteComponents,
  routeComponentLoaders,
} from './routeComponentPreload'

vi.mock('../lib/Others/GridCatalog.svelte', () => ({ default: {} }))

describe('route component preload', () => {
  beforeEach(resetClientSessionForTests)

  it('does not expose writer component loaders for reader routes, including the grid', async () => {
    beginClientSession('reader-a')
    for (const path of ['/settings/plugins', '/playground', '/inlay', '/grid']) {
      expect(routeComponentLoaders(parseRoute(path))).toEqual([])
      await expect(preloadRouteComponents(parseRoute(path))).resolves.toBeUndefined()
    }
  })

  it('maps route families to their shell and exact page chunks', () => {
    expect(routeComponentLoaders(parseRoute('/settings'))).toEqual([loadSettings, loadBotSettings])
    expect(routeComponentLoaders(parseRoute('/settings/memory'))).toEqual([loadSettings, loadMemorySettings])
    expect(routeComponentLoaders(parseRoute('/settings/bardwiki'))).toEqual([loadSettings, loadBardWikiSettings])
    expect(routeComponentLoaders(parseRoute('/settings/display'))).toEqual([loadSettings, loadDisplaySettings])
    expect(routeComponentLoaders(parseRoute('/playground/embedding'))).toEqual([
      loadPlaygroundMenu,
      loadPlaygroundEmbedding,
    ])
    expect(routeComponentLoaders(parseRoute('/inlay'))).toEqual([loadPlaygroundMenu, loadPlaygroundInlayExplorer])
    expect(routeComponentLoaders(parseRoute('/grid'))).toEqual([loadGrid])
    expect(routeComponentLoaders(parseRoute('/character/char-a/chat-a'))).toEqual([])
  })

  it('shares one cached component promise between intent, navigation, and rendering', async () => {
    const [loader] = routeComponentLoaders(parseRoute('/grid'))
    const intent = loader!()

    expect(loader!()).toBe(intent)
    await preloadRouteComponents(parseRoute('/grid'))
    expect(loader!()).toBe(intent)
  })
})
