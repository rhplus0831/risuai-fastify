import { expect, test, type Page, type Route } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { phase1LazyBoundarySources } from '../../../util/fast-bootstrap-boundaries.js'
import { buildApp } from '../src/app.js'
import { setupBrowserSmokeAuth } from './auth.js'
import { browserSmokeEnglish } from './englishFixture.js'
import { importFastBootstrapDatabase } from './fastBootstrapHarness.js'

interface Harness {
  app: FastifyInstance
  baseUrl: string
  dataDir: string
}

interface ViteManifestChunk {
  css?: string[]
  dynamicImports?: string[]
  file: string
  isDynamicEntry?: boolean
  src?: string
}

type ViteManifest = Record<string, ViteManifestChunk>

interface LazyRouteCase {
  path: string
  source: string
  surface: string
}

interface TransitionRequestOracle {
  paths: string[]
  openedAssetPaths: Set<string>
}

const manifestPath = path.resolve('dist/vite-assets-manifest.json')
const manifest = readManifest()

const settingsCases: LazyRouteCase[] = [
  {
    path: '/settings/backup',
    source: 'src/lib/Setting/Pages/UserSettings.svelte',
    surface: 'settings-user',
  },
  {
    path: '/settings/bot-preset',
    source: 'src/lib/Setting/Pages/BotSettings.svelte',
    surface: 'settings-legacy-bot',
  },
  {
    path: '/settings/model',
    source: 'src/lib/Setting/Pages/BotSettings.svelte',
    surface: 'settings-model',
  },
  {
    path: '/settings/prompt-settings',
    source: 'src/lib/Setting/Pages/BotSettings.svelte',
    surface: 'settings-prompt-presets',
  },
  {
    path: '/settings/memory',
    source: 'src/lib/Setting/Pages/OtherBotSettings.svelte',
    surface: 'settings-memory',
  },
  {
    path: '/settings/bardwiki',
    source: 'src/lib/Setting/Pages/BardWikiSettings.svelte',
    surface: 'settings-bardwiki',
  },
  {
    path: '/settings/display',
    source: 'src/lib/Setting/Pages/DisplaySettings.svelte',
    surface: 'settings-display',
  },
  {
    path: '/settings/plugins',
    source: 'src/lib/Setting/Pages/PluginSettings.svelte',
    surface: 'settings-plugins',
  },
  {
    path: '/settings/advanced',
    source: 'src/lib/Setting/Pages/AdvancedSettings.svelte',
    surface: 'settings-advanced',
  },
  {
    path: '/settings/communities',
    source: 'src/lib/Setting/Pages/Communities.svelte',
    surface: 'settings-communities',
  },
  {
    path: '/settings/global-lorebook',
    source: 'src/lib/Setting/Pages/LazyGlobalLoreBookSettings.svelte',
    surface: 'settings-global-lorebook',
  },
  {
    path: '/settings/global-regex',
    source: 'src/lib/Setting/Pages/GlobalRegex.svelte',
    surface: 'settings-global-regex',
  },
  {
    path: '/settings/language',
    source: 'src/lib/Setting/Pages/LanguageSettings.svelte',
    surface: 'settings-language',
  },
  {
    path: '/settings/accessibility',
    source: 'src/lib/Setting/Pages/AccessibilitySettings.svelte',
    surface: 'settings-accessibility',
  },
  {
    path: '/settings/persona',
    source: 'src/lib/Setting/Pages/PersonaSettings.svelte',
    surface: 'settings-persona',
  },
  {
    path: '/settings/modules',
    source: 'src/lib/Setting/Pages/Module/ModuleSettings.svelte',
    surface: 'settings-modules',
  },
  {
    path: '/settings/prompt',
    source: 'src/lib/Setting/Pages/PromptSettings.svelte',
    surface: 'settings-prompt',
  },
  {
    path: '/settings/hotkeys',
    source: 'src/lib/Setting/Pages/HotkeySettings.svelte',
    surface: 'settings-hotkeys',
  },
  {
    path: '/settings/agent-presets',
    source: 'src/lib/Setting/Pages/AgentPresetSettings.svelte',
    surface: 'settings-agent-presets',
  },
  {
    path: '/settings/input-hooks',
    source: 'src/lib/Setting/Pages/InputHookSettings.svelte',
    surface: 'settings-input-hooks',
  },
  {
    path: '/settings/request-history',
    source: 'src/lib/Setting/Pages/RequestHistorySettings.svelte',
    surface: 'settings-request-history',
  },
  {
    path: '/settings/source-code',
    source: 'src/lib/Setting/Pages/SourceCode.svelte',
    surface: 'settings-source-code',
  },
  {
    path: '/settings/supporter',
    source: 'src/lib/Setting/Pages/ThanksPage.svelte',
    surface: 'settings-thanks',
  },
]

const playgroundCases: LazyRouteCase[] = [
  {
    path: '/playground/embedding',
    source: 'src/lib/Playground/PlaygroundEmbedding.svelte',
    surface: 'playground-embedding',
  },
  {
    path: '/playground/tokenizer',
    source: 'src/lib/Playground/PlaygroundTokenizer.svelte',
    surface: 'playground-tokenizer',
  },
  {
    path: '/playground/syntax',
    source: 'src/lib/Playground/PlaygroundSyntax.svelte',
    surface: 'playground-syntax',
  },
  {
    path: '/playground/jinja',
    source: 'src/lib/Playground/PlaygroundJinja.svelte',
    surface: 'playground-jinja',
  },
  {
    path: '/playground/image-gen',
    source: 'src/lib/Playground/PlaygroundImageGen.svelte',
    surface: 'playground-image-gen',
  },
  {
    path: '/playground/parser',
    source: 'src/lib/Playground/PlaygroundParser.svelte',
    surface: 'playground-parser',
  },
  {
    path: '/playground/subtitles',
    source: 'src/lib/Playground/PlaygroundSubtitle.svelte',
    surface: 'playground-subtitles',
  },
  {
    path: '/playground/image-trans',
    source: 'src/lib/Playground/PlaygroundImageTrans.svelte',
    surface: 'playground-image-translation',
  },
  {
    path: '/playground/translation',
    source: 'src/lib/Playground/PlaygroundTranslation.svelte',
    surface: 'playground-translation',
  },
  {
    path: '/playground/mcp',
    source: 'src/lib/Playground/PlaygroundMCP.svelte',
    surface: 'playground-mcp',
  },
  {
    path: '/playground/cbs',
    source: 'src/lib/Playground/PlaygroundDocs.svelte',
    surface: 'playground-docs',
  },
  {
    path: '/inlay',
    source: 'src/lib/Playground/PlaygroundInlayExplorer.svelte',
    surface: 'playground-inlays',
  },
  {
    path: '/playground/tools',
    source: 'src/lib/Playground/ToolConversion.svelte',
    surface: 'playground-tools',
  },
]

const appOwnedSources = [
  'src/lib/Others/AlertComp.svelte',
  'src/lib/UI/Realm/LazyRealmPopUp.svelte',
  'src/lib/Others/GridCatalog.svelte',
  'src/lib/Others/BookmarkList.svelte',
  'src/lib/Setting/Settings.svelte',
  'src/lib/Setting/botpreset.svelte',
  'src/lib/Setting/listedPersona.svelte',
  'src/lib/SideBars/ChatGenerationTogglePresetDialog.svelte',
  'src/lib/Setting/Pages/CustomGUISettingMenu.svelte',
  'src/lib/Others/HypaV3Modal.svelte',
  'src/lib/Others/HypaV3Progress.svelte',
  'src/lib/UI/PopupList.svelte',
  'src/lib/Others/ProTools/EasyPanel.svelte',
  'src/lib/Others/PopupEditor.svelte',
  'src/lib/Others/LoadoutModal.svelte',
  'src/lib/Others/IrisModal.svelte',
  'src/lib/Others/CustomSidebarConfig.svelte',
] as const

const sidebarSources = [
  'src/lib/SideBars/CharConfig.svelte',
  'src/lib/SideBars/DevTool.svelte',
  'src/lib/Others/QuickSettingsGUI.svelte',
] as const

const chatDialogSources = [
  'src/lib/Others/ChatList.svelte',
  'src/lib/Setting/Pages/Module/ModuleChatMenu.svelte',
] as const

const routeHandlerSources = [
  'src/ts/routeHandlers/settings.ts',
  'src/ts/routeHandlers/playground.ts',
  'src/ts/routeHandlers/character.ts',
] as const

let harness: Harness

test.setTimeout(120_000)

test.beforeEach(async () => {
  harness = await startHarness()
  const assertion = await setupBrowserSmokeAuth(harness.app)
  await importDatabase(harness.app, assertion, lazyBoundaryDatabase())
})

test.afterEach(async ({ page }) => {
  await page.context().close()
  await harness.app.close()
  fs.rmSync(harness.dataDir, { recursive: true, force: true })
})

test('smoke manifest accounts for the 60 registered lazy boundaries', async () => {
  const expectedSources = new Set<string>([
    ...appOwnedSources,
    ...sidebarSources,
    ...chatDialogSources,
    'src/lib/Playground/PlaygroundMenu.svelte',
    ...settingsCases.map((entry) => entry.source),
    ...playgroundCases.map((entry) => entry.source),
    ...routeHandlerSources,
  ])

  expect(expectedSources.size).toBe(60)
  expect(expectedSources).toEqual(new Set(phase1LazyBoundarySources))
  for (const source of expectedSources) {
    const chunk = manifest[source]
    expect(chunk, `missing Vite manifest entry for ${source}`).toBeDefined()
    expect(chunk.isDynamicEntry, `${source} must remain a first-use entry`).toBe(true)
  }

  const dynamicImportSources = new Set(Object.values(manifest).flatMap((chunk) => chunk.dynamicImports ?? []))
  for (const source of playgroundCases.map((entry) => entry.source)) {
    expect(dynamicImportSources, `${source} must remain reachable from the shared route loader`).toContain(source)
  }
})

test('every Settings and Playground route opens its real first-use chunk', async ({ page }) => {
  const requestOracle = observeTransitionRequests(page)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await openLoadedHome(page)

  for (const routeCase of settingsCases) {
    await expectLazyAssetOnTransition(requestOracle, routeCase.source, routeCase.path, async () => {
      await navigateTo(page, routeCase.path)
      await expect(lazySurface(page, routeCase.surface)).toHaveAttribute('data-risu-lazy-state', 'ready')
    })
  }

  await expectLazyAssetOnTransition(
    requestOracle,
    'src/lib/Playground/PlaygroundMenu.svelte',
    '/playground',
    async () => {
      await navigateTo(page, '/playground')
      await expect(lazySurface(page, 'playground-menu')).toHaveAttribute('data-risu-lazy-state', 'ready')
    },
  )

  for (const routeCase of playgroundCases) {
    await expectLazyAssetOnTransition(requestOracle, routeCase.source, routeCase.path, async () => {
      await navigateTo(page, routeCase.path)
      await expect(lazySurface(page, routeCase.surface)).toHaveAttribute('data-risu-lazy-state', 'ready')
    })
  }

  expect(pageErrors).toEqual([])
})

test('grid, route handlers, Sidebar panels, and chat dialogs open only on first use', async ({ page }) => {
  const requestOracle = observeTransitionRequests(page)
  await openLoadedHome(page)

  await expectLazyAssetOnTransition(requestOracle, 'src/lib/Others/GridCatalog.svelte', '/grid', async () => {
    await navigateTo(page, '/grid')
    await expect(lazySurface(page, 'character-grid')).toHaveAttribute('data-risu-lazy-state', 'ready')
  })

  await expectLazyAssetOnTransition(
    requestOracle,
    'src/ts/routeHandlers/character.ts',
    '/character/char-smoke/chat-smoke-two',
    async () => {
      await navigateTo(page, '/character/char-smoke/chat-smoke-two')
      await expect(page.getByTestId('default-chat-composer')).toBeVisible()
    },
  )

  await expectLazyAssetOnTransition(
    requestOracle,
    'src/lib/SideBars/CharConfig.svelte',
    'character sidebar tab',
    async () => {
      await page.locator('button[data-risu-sidebar-tab="character"]').click()
      await expect(lazySurface(page, 'character-editor')).toHaveAttribute('data-risu-lazy-state', 'ready')
    },
  )

  await expectLazyAssetOnTransition(
    requestOracle,
    'src/lib/SideBars/DevTool.svelte',
    'developer tools sidebar tab',
    async () => {
      await page.getByTestId('sidebar-developer-tools-button').click()
      await expect(lazySurface(page, 'developer-tools')).toHaveAttribute('data-risu-lazy-state', 'ready')
    },
  )

  await expectLazyAssetOnTransition(
    requestOracle,
    'src/lib/Others/QuickSettingsGUI.svelte',
    'quick settings open',
    async () => {
      await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.setQuickSettingsOpen(true))
      await expect(lazySurface(page, 'quick-settings')).toHaveAttribute('data-risu-lazy-state', 'ready')
    },
  )
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.setQuickSettingsOpen(false))

  await expectLazyAssetOnTransition(
    requestOracle,
    'src/lib/Others/ChatList.svelte',
    'chat list dialog open',
    async () => {
      await page.locator('button[data-risu-sidebar-tab="chat"]').click()
      await page.getByTestId('default-chat-menu-button').click()
      await page.getByTestId('default-chat-open-chat-list').click()
      await expect(lazySurface(page, 'chat-list')).toHaveAttribute('data-risu-lazy-state', 'ready')
    },
  )
  await page.keyboard.press('Escape')
  await expect(lazySurface(page, 'chat-list')).toHaveCount(0)

  await expectLazyAssetOnTransition(
    requestOracle,
    'src/lib/Setting/Pages/Module/ModuleChatMenu.svelte',
    'module chat dialog open',
    async () => {
      await page.getByTestId('default-chat-menu-button').click()
      await page.getByTestId('default-chat-open-modules').click()
      await expect(lazySurface(page, 'module-chat-menu')).toHaveAttribute('data-risu-lazy-state', 'ready')
    },
  )
})

test('a delayed emitted stylesheet keeps the previous route mounted until the new route is ready', async ({ page }) => {
  await openLoadedHome(page)
  const previousRoute = page.locator('[data-risu-route-content]')
  await previousRoute.evaluate((node) => node.setAttribute('data-previous-route-sentinel', 'true'))
  const settingsChunk = manifest['src/lib/Setting/Settings.svelte']
  const cssFile = settingsChunk.css?.[0]
  expect(cssFile).toBeDefined()
  const delayed = await deferredRoute(page, `/${cssFile!}`)

  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.navigateTo('/settings/display'))
  await delayed.requested

  await expect(page.locator('[data-previous-route-sentinel="true"]')).toBeVisible()
  await expect(lazySurface(page, 'settings')).toHaveCount(0)
  await expect(page.locator('[data-risu-visual-viewport-shell]')).toBeVisible()
  await expect(page.locator('body')).not.toHaveText('')

  delayed.release()
  await delayed.finished
  await page.unroute(`**/${cssFile!}`)
  await expect(lazySurface(page, 'settings-display')).toHaveAttribute('data-risu-lazy-state', 'ready')
  await expect(page.locator('[data-previous-route-sentinel="true"]')).toHaveCount(0)
  await expect.poll(() => stylesheetIsLoaded(page, `/${cssFile!}`)).toBe(true)
  await expect
    .poll(() => page.locator('.setting-bg').evaluate((node) => getComputedStyle(node).backgroundImage))
    .toContain('linear-gradient')
})

test('a delayed modal chunk preserves focus through loading, CSS, and close', async ({ page }) => {
  const requestedPaths = new Set<string>()
  page.on('request', (request) => requestedPaths.add(new URL(request.url()).pathname))
  await openLoadedHome(page)

  await page.evaluate(() => {
    const opener = document.createElement('button')
    opener.id = 'phase1b-modal-opener'
    opener.textContent = 'Open lazy modal'
    document.body.appendChild(opener)
  })
  const opener = page.locator('#phase1b-modal-opener')
  await opener.focus()
  const delayed = await deferredRoute(page, assetPath('src/lib/Others/AlertComp.svelte'))

  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.showAlert('Lazy first-open alert'))
  await delayed.requested

  const pending = lazySurface(page, 'alert')
  await expect(pending).toHaveAttribute('data-risu-lazy-state', 'pending')
  await expect(pending.getByRole('dialog')).toHaveAttribute('aria-busy', 'true')
  await expect.poll(() => pending.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  await expect(opener).toHaveJSProperty('inert', true)

  delayed.release()
  await delayed.finished
  await page.unroute(`**${assetPath('src/lib/Others/AlertComp.svelte')}`)
  await expect(pending).toHaveAttribute('data-risu-lazy-state', 'ready')
  const dialog = pending.getByRole('dialog')
  await expect(dialog).toContainText('Lazy first-open alert')
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)

  const alertCss = manifest['src/lib/Others/AlertComp.svelte'].css?.[0]
  expect(alertCss).toBeDefined()
  expect(requestedPaths.has(`/${alertCss!}`)).toBe(true)
  await expect.poll(() => stylesheetIsLoaded(page, `/${alertCss!}`)).toBe(true)

  await dialog.getByRole('button', { name: 'OK' }).click()
  await expect(pending).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test('preset and persona lazy dialogs stay within the viewport after first-open loading', async ({ page }) => {
  await openLoadedHome(page)
  await navigateTo(page, '/character/char-smoke/chat-smoke-two')
  await expect(page.getByTestId('default-chat-composer')).toBeVisible()

  const delayedPreset = await deferredRoute(page, assetPath('src/lib/Setting/botpreset.svelte'))
  await page.locator('[data-risu-generation-picker-control][data-risu-picker-kind="model"] button').first().click()
  await delayedPreset.requested

  const presetSurface = lazySurface(page, 'preset-list')
  await expect(presetSurface).toHaveAttribute('data-risu-lazy-state', 'pending')
  await expect(presetSurface.getByRole('dialog')).toBeInViewport()

  delayedPreset.release()
  await delayedPreset.finished
  await page.unroute(`**${assetPath('src/lib/Setting/botpreset.svelte')}`)
  await expect(presetSurface).toHaveAttribute('data-risu-lazy-state', 'ready')

  const presetDialog = presetSurface.locator(
    '[data-risu-generation-picker][data-risu-picker-kind="model"][data-risu-picker-mode="active-chat-generation-settings"]',
  )
  await expect(presetDialog).toBeInViewport()
  await presetDialog.getByRole('button', { name: browserSmokeEnglish.close }).click()
  await expect(presetSurface).toHaveCount(0)

  await page.locator('[data-risu-generation-picker-control][data-risu-picker-kind="persona"] button').first().click()
  const personaSurface = lazySurface(page, 'persona-list')
  await expect(personaSurface).toHaveAttribute('data-risu-lazy-state', 'ready')

  const personaDialog = personaSurface.locator(
    '[data-risu-generation-picker][data-risu-picker-kind="persona"][data-risu-picker-mode="active-chat-generation-settings"]',
  )
  await expect(personaDialog).toBeInViewport()
  await personaDialog.getByRole('button', { name: browserSmokeEnglish.close }).click()
  await expect(personaSurface).toHaveCount(0)
})

test('conservative writer offline first open shows local Retry and succeeds when connectivity returns', async ({
  page,
  context,
}) => {
  // This retains the writer route-loader fallback contract. Managed clients
  // instead show interrupted reading; connectedReaderBrowsing covers that path.
  const failedPaths: string[] = []
  page.on('requestfailed', (request) => failedPaths.push(new URL(request.url()).pathname))
  await openLoadedHome(page)
  const previousRoute = page.locator('[data-risu-route-content]')
  await previousRoute.evaluate((node) => node.setAttribute('data-previous-route-sentinel', 'true'))

  await context.setOffline(true)
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.navigateTo('/grid'))

  const routeError = page.getByTestId('route-resource-error')
  await expect(routeError).toContainText(browserSmokeEnglish.preloadOfflineError)
  await expect(page.locator('[data-previous-route-sentinel="true"]')).toBeVisible()
  await expect(lazySurface(page, 'character-grid')).toHaveCount(0)
  const retry = routeError.getByRole('button', { name: browserSmokeEnglish.retry })
  await expect(retry).toBeFocused()
  expect(failedPaths.includes(assetPath('src/lib/Others/GridCatalog.svelte'))).toBe(true)

  await context.setOffline(false)
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true)
  const reloaded = page.waitForNavigation({ waitUntil: 'domcontentloaded' })
  await retry.click()
  await reloaded
  await waitForLoaded(page)
  await expect(lazySurface(page, 'character-grid')).toHaveAttribute('data-risu-lazy-state', 'ready')
})

test('a stale emitted stylesheet shows local recovery and reloads the current route', async ({ page }) => {
  await openLoadedHome(page)
  const previousRoute = page.locator('[data-risu-route-content]')
  await previousRoute.evaluate((node) => node.setAttribute('data-previous-route-sentinel', 'true'))
  const settingsChunk = manifest['src/lib/Setting/Settings.svelte']
  const cssFile = settingsChunk.css?.[0]
  expect(cssFile).toBeDefined()
  let attempts = 0

  await page.route(`**/${cssFile!}`, async (route) => {
    attempts += 1
    if (attempts === 1) {
      await route.fulfill({
        status: 404,
        contentType: 'text/css',
        headers: { 'cache-control': 'no-store' },
        body: '/* stale chunk */',
      })
      return
    }
    await route.continue()
  })

  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.navigateTo('/settings/display'))
  const routeError = page.getByTestId('route-resource-error')
  await expect(routeError).toContainText(browserSmokeEnglish.preloadStaleError)
  await expect(routeError.getByRole('button', { name: browserSmokeEnglish.retry })).toBeFocused()
  await expect(page.locator('[data-previous-route-sentinel="true"]')).toBeVisible()
  await expect(lazySurface(page, 'settings')).toHaveCount(0)

  const reloaded = page.waitForNavigation({ waitUntil: 'domcontentloaded' })
  await routeError.getByRole('button', { name: browserSmokeEnglish.preloadReload }).click()
  await reloaded
  await waitForLoaded(page)
  await expect(lazySurface(page, 'settings-display')).toHaveAttribute('data-risu-lazy-state', 'ready')
  expect(attempts).toBeGreaterThanOrEqual(2)
  await expect.poll(() => stylesheetIsLoaded(page, `/${cssFile!}`)).toBe(true)
})

function readManifest(): ViteManifest {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing smoke asset manifest at ${manifestPath}; run pnpm build:smoke first`)
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ViteManifest
}

function assetPath(source: string): string {
  const chunk = manifest[source]
  if (!chunk) throw new Error(`Missing Vite manifest entry for ${source}`)
  return `/${chunk.file}`
}

function observeTransitionRequests(page: Page): TransitionRequestOracle {
  const oracle: TransitionRequestOracle = { paths: [], openedAssetPaths: new Set() }
  page.on('request', (request) => oracle.paths.push(new URL(request.url()).pathname))
  return oracle
}

async function expectLazyAssetOnTransition(
  oracle: TransitionRequestOracle,
  source: string,
  transitionLabel: string,
  transition: () => Promise<void>,
): Promise<void> {
  const pathname = assetPath(source)
  const alreadyOpened = oracle.openedAssetPaths.has(pathname)
  const requestsBeforeTransition = oracle.paths.filter((requestedPath) => requestedPath === pathname).length
  expect(
    requestsBeforeTransition,
    alreadyOpened
      ? `${source} was requested again before ${transitionLabel}`
      : `${source} was requested before its first-open transition ${transitionLabel}`,
  ).toBe(alreadyOpened ? 1 : 0)

  const transitionStart = oracle.paths.length
  await transition()
  const transitionRequests = oracle.paths
    .slice(transitionStart)
    .filter((requestedPath) => requestedPath === pathname).length

  expect(
    transitionRequests,
    alreadyOpened
      ? `${source} was fetched again during cached transition ${transitionLabel}`
      : `${source} was not requested by first-open transition ${transitionLabel}`,
  ).toBe(alreadyOpened ? 0 : 1)
  oracle.openedAssetPaths.add(pathname)
}

function lazySurface(page: Page, surface: string) {
  return page.locator(`[data-risu-lazy-surface="${surface}"]`)
}

async function navigateTo(page: Page, targetPath: string): Promise<void> {
  await page.evaluate((path) => window.__RISU_FASTIFY_BROWSER_SMOKE__!.navigateTo(path), targetPath)
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(targetPath)}$`))
}

async function openLoadedHome(page: Page): Promise<void> {
  await page.goto(harness.baseUrl, { waitUntil: 'domcontentloaded' })
  await waitForLoaded(page)
}

async function waitForLoaded(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))).toBe(true)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForLoaded(20_000))
}

async function deferredRoute(
  page: Page,
  pathname: string,
): Promise<{
  requested: Promise<void>
  finished: Promise<void>
  release: () => void
}> {
  let markRequested!: () => void
  let releaseRequest!: () => void
  let markFinished!: () => void
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve
  })
  const released = new Promise<void>((resolve) => {
    releaseRequest = resolve
  })
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve
  })

  await page.route(`**${pathname}`, async (route: Route) => {
    markRequested()
    await released
    await route.continue()
    markFinished()
  })

  return { requested, finished, release: releaseRequest }
}

async function stylesheetIsLoaded(page: Page, pathname: string): Promise<boolean> {
  return page.evaluate((expectedPath) => {
    return [...document.styleSheets].some((sheet) => {
      if (!sheet.href) return false
      return new URL(sheet.href).pathname === expectedPath
    })
  }, pathname)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-phase1b-first-open-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 2 * 1024 * 1024,
      importMaxBytes: Number.POSITIVE_INFINITY,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      staticRoot: path.resolve('dist'),
    },
    assetGc: false,
    memoryWorker: false,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Phase 1B smoke harness did not bind to a TCP port')
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, dataDir }
}

async function importDatabase(app: FastifyInstance, assertion: string, database: Record<string, unknown>) {
  await importFastBootstrapDatabase(app, assertion, database, { dataDir: harness.dataDir })
}

function lazyBoundaryDatabase(): Record<string, unknown> {
  return {
    version: 1,
    didFirstSetup: true,
    formatversion: 5,
    selectedCharID: 0,
    selectedPersona: 0,
    characterOrder: [],
    characters: [
      {
        chaId: 'char-smoke',
        type: 'character',
        name: 'Lazy Boundary Character',
        chats: [
          {
            id: 'chat-smoke',
            name: 'First Chat',
            note: '',
            localLore: [],
            message: [],
          },
          {
            id: 'chat-smoke-two',
            name: 'Second Chat',
            note: '',
            localLore: [],
            message: [],
          },
        ],
        chatPage: 0,
        customscript: [],
        firstMessage: '',
        globalLore: [],
        viewScreen: 'none',
        emotionImages: [],
      },
    ],
    botPresets: [{ id: 'legacy-preset', name: 'Legacy preset' }],
    botPresetsId: 0,
    promptPresets: [],
    modelProfiles: [],
    modelProfileOrder: [],
    modelRoleProfiles: {},
    modelRuntimeDefaults: {},
    providerCredentials: [],
    loadouts: [],
    modules: [],
    personas: [
      { id: 'persona-smoke', name: 'Smoke Persona', icon: '', largePortrait: false, personaPrompt: '' },
      { id: 'persona-two', name: 'Second Persona', icon: '', largePortrait: false, personaPrompt: '' },
    ],
    plugins: [],
    pluginCustomStorage: {},
    language: 'en',
    loreBookToken: 8000,
    mainPrompt: '',
    streamGeminiThoughts: false,
    doNotWarnExternalServers: true,
    enableDevTools: true,
    enableRisuaiProTools: true,
    showGlobalLorebookAndRegex: true,
    showMenuChatList: true,
  }
}
