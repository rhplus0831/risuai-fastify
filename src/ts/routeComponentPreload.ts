import { canUseClientWriteAccess } from './clientSession'
import type { Component } from 'svelte'
import type { AppRoute } from './routerRoute'

export type RouteComponentModule = { default: Component<any> }
export type RouteComponentLoader = () => Promise<RouteComponentModule>

function cachedRouteComponentLoader(load: RouteComponentLoader): RouteComponentLoader {
  let pending: Promise<RouteComponentModule> | undefined
  return () => {
    if (pending) return pending
    pending = load().catch((error) => {
      pending = undefined
      throw error
    })
    return pending
  }
}

export const loadGrid = cachedRouteComponentLoader(() => import('../lib/Others/GridCatalog.svelte'))
export const loadSettings = cachedRouteComponentLoader(() => import('../lib/Setting/Settings.svelte'))
export const loadPlaygroundMenu = cachedRouteComponentLoader(() => import('../lib/Playground/PlaygroundMenu.svelte'))

export const loadUserSettings = cachedRouteComponentLoader(() => import('../lib/Setting/Pages/UserSettings.svelte'))
export const loadBotSettings = cachedRouteComponentLoader(() => import('../lib/Setting/Pages/BotSettings.svelte'))
export const loadMemorySettings = cachedRouteComponentLoader(
  () => import('../lib/Setting/Pages/OtherBotSettings.svelte'),
)
export const loadBardWikiSettings = cachedRouteComponentLoader(
  () => import('../lib/Setting/Pages/BardWikiSettings.svelte'),
)
export const loadDisplaySettings = cachedRouteComponentLoader(
  () => import('../lib/Setting/Pages/DisplaySettings.svelte'),
)
export const loadPluginSettings = cachedRouteComponentLoader(() => import('../lib/Setting/Pages/PluginSettings.svelte'))
export const loadAdvancedSettings = cachedRouteComponentLoader(
  () => import('../lib/Setting/Pages/AdvancedSettings.svelte'),
)
export const loadCommunities = cachedRouteComponentLoader(() => import('../lib/Setting/Pages/Communities.svelte'))
export const loadGlobalLoreBookSettings = cachedRouteComponentLoader(
  () => import('../lib/Setting/Pages/LazyGlobalLoreBookSettings.svelte'),
)
export const loadGlobalRegex = cachedRouteComponentLoader(() => import('../lib/Setting/Pages/GlobalRegex.svelte'))
export const loadLanguageSettings = cachedRouteComponentLoader(
  () => import('../lib/Setting/Pages/LanguageSettings.svelte'),
)
export const loadAccessibilitySettings = cachedRouteComponentLoader(
  () => import('../lib/Setting/Pages/AccessibilitySettings.svelte'),
)
export const loadPersonaSettings = cachedRouteComponentLoader(
  () => import('../lib/Setting/Pages/PersonaSettings.svelte'),
)
export const loadModuleSettings = cachedRouteComponentLoader(
  () => import('../lib/Setting/Pages/Module/ModuleSettings.svelte'),
)
export const loadPromptSettings = cachedRouteComponentLoader(() => import('../lib/Setting/Pages/PromptSettings.svelte'))
export const loadHotkeySettings = cachedRouteComponentLoader(() => import('../lib/Setting/Pages/HotkeySettings.svelte'))
export const loadAgentPresetSettings = cachedRouteComponentLoader(
  () => import('../lib/Setting/Pages/AgentPresetSettings.svelte'),
)
export const loadInputHookSettings = cachedRouteComponentLoader(
  () => import('../lib/Setting/Pages/InputHookSettings.svelte'),
)
export const loadRequestHistorySettings = cachedRouteComponentLoader(
  () => import('../lib/Setting/Pages/RequestHistorySettings.svelte'),
)
export const loadSourceCode = cachedRouteComponentLoader(() => import('../lib/Setting/Pages/SourceCode.svelte'))
export const loadThanksPage = cachedRouteComponentLoader(() => import('../lib/Setting/Pages/ThanksPage.svelte'))

export const loadPlaygroundEmbedding = cachedRouteComponentLoader(
  () => import('../lib/Playground/PlaygroundEmbedding.svelte'),
)
export const loadPlaygroundTokenizer = cachedRouteComponentLoader(
  () => import('../lib/Playground/PlaygroundTokenizer.svelte'),
)
export const loadPlaygroundSyntax = cachedRouteComponentLoader(
  () => import('../lib/Playground/PlaygroundSyntax.svelte'),
)
export const loadPlaygroundJinja = cachedRouteComponentLoader(() => import('../lib/Playground/PlaygroundJinja.svelte'))
export const loadPlaygroundImageGen = cachedRouteComponentLoader(
  () => import('../lib/Playground/PlaygroundImageGen.svelte'),
)
export const loadPlaygroundParser = cachedRouteComponentLoader(
  () => import('../lib/Playground/PlaygroundParser.svelte'),
)
export const loadPlaygroundSubtitle = cachedRouteComponentLoader(
  () => import('../lib/Playground/PlaygroundSubtitle.svelte'),
)
export const loadPlaygroundImageTrans = cachedRouteComponentLoader(
  () => import('../lib/Playground/PlaygroundImageTrans.svelte'),
)
export const loadPlaygroundTranslation = cachedRouteComponentLoader(
  () => import('../lib/Playground/PlaygroundTranslation.svelte'),
)
export const loadPlaygroundMcp = cachedRouteComponentLoader(() => import('../lib/Playground/PlaygroundMCP.svelte'))
export const loadPlaygroundDocs = cachedRouteComponentLoader(() => import('../lib/Playground/PlaygroundDocs.svelte'))
export const loadPlaygroundInlayExplorer = cachedRouteComponentLoader(
  () => import('../lib/Playground/PlaygroundInlayExplorer.svelte'),
)
export const loadToolConversion = cachedRouteComponentLoader(() => import('../lib/Playground/ToolConversion.svelte'))

const settingsPageLoaders = new Map<number, RouteComponentLoader>([
  [-1, loadBotSettings],
  [0, loadUserSettings],
  [1, loadBotSettings],
  [2, loadMemorySettings],
  [3, loadDisplaySettings],
  [4, loadPluginSettings],
  [6, loadAdvancedSettings],
  [7, loadCommunities],
  [8, loadGlobalLoreBookSettings],
  [9, loadGlobalRegex],
  [10, loadLanguageSettings],
  [11, loadAccessibilitySettings],
  [12, loadPersonaSettings],
  [13, loadPromptSettings],
  [14, loadModuleSettings],
  [15, loadHotkeySettings],
  [17, loadBotSettings],
  [18, loadBotSettings],
  [19, loadAgentPresetSettings],
  [20, loadInputHookSettings],
  [21, loadRequestHistorySettings],
  [22, loadSourceCode],
  [23, loadBardWikiSettings],
  [77, loadThanksPage],
])

const playgroundPageLoaders = new Map<number, RouteComponentLoader>([
  [3, loadPlaygroundEmbedding],
  [4, loadPlaygroundTokenizer],
  [5, loadPlaygroundSyntax],
  [6, loadPlaygroundJinja],
  [7, loadPlaygroundImageGen],
  [8, loadPlaygroundParser],
  [9, loadPlaygroundSubtitle],
  [10, loadPlaygroundImageTrans],
  [11, loadPlaygroundTranslation],
  [12, loadPlaygroundMcp],
  [13, loadPlaygroundDocs],
  [14, loadPlaygroundInlayExplorer],
  [101, loadToolConversion],
])

export function routeComponentLoaders(route: AppRoute): readonly RouteComponentLoader[] {
  if (!canUseClientWriteAccess()) return []
  switch (route.kind) {
    case 'settings': {
      const pageLoader = settingsPageLoaders.get(route.index)
      return pageLoader ? [loadSettings, pageLoader] : [loadSettings]
    }
    case 'grid':
      return [loadGrid]
    case 'inlay':
      return [loadPlaygroundMenu, loadPlaygroundInlayExplorer]
    case 'playground': {
      const pageLoader = playgroundPageLoaders.get(route.index)
      return pageLoader ? [loadPlaygroundMenu, pageLoader] : [loadPlaygroundMenu]
    }
    case 'home':
    case 'character':
    case 'not-found':
      return []
  }
}

/** Resolve every lazy component needed for a route before its visible store state is committed. */
export async function preloadRouteComponents(route: AppRoute): Promise<void> {
  await Promise.all(routeComponentLoaders(route).map((loader) => loader()))
}
