import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
} from './fastBootstrapHarness.js'
import { observeFirstComposerLabel, selectedLocaleAssets } from './selectedLocaleFixture.js'

const chatPath = '/character/fast-bootstrap-small-character/fast-bootstrap-small-chat'

async function openLanguageSettings(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}${chatPath}`)
  await expect(page.getByTestId('default-chat-composer')).toHaveAttribute('aria-label', 'Message input')
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000))
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.navigateTo('/settings/language'))
  const select = page.locator('select:has(option[value="zh-Hant"])')
  await expect(select).toHaveAttribute('aria-label', 'UI Language')
  return select
}

test('a delayed locale cannot overwrite a newer selection and is reused on the next switch', async ({ browser }) => {
  const harness = await startFastBootstrapHarness(smallFastBootstrapFixture())
  const context = await browser.newContext()
  const page = await context.newPage()
  const koreanAsset = selectedLocaleAssets().get('ko')!
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  await page.route(
    (url) => url.pathname === `/${koreanAsset}`,
    async (route) => {
      requests += 1
      await held
      await route.continue()
    },
  )
  try {
    const select = await openLanguageSettings(page, harness.baseUrl)
    await select.selectOption('ko')
    await expect.poll(() => requests).toBe(1)
    await select.selectOption('en')
    await expect
      .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().language))
      .toBe('en')
    const koreanResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/${koreanAsset}`)
    release()
    await koreanResponse
    await expect(select).toHaveValue('en')
    await expect(select).toHaveAttribute('aria-label', 'UI Language')
    await select.selectOption('ko')
    await expect(select).toHaveAttribute('aria-label', 'UI 언어')
    await expect
      .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().language))
      .toBe('ko')
    expect(requests).toBe(1)
    await page.evaluate((route) => window.__RISU_FASTIFY_BROWSER_SMOKE__!.navigateTo(route), chatPath)
    await expect(page.getByTestId('default-chat-composer')).toHaveAttribute('aria-label', '메시지 입력')
    expect(errors).toEqual([])
  } finally {
    release()
    await page.unrouteAll({ behavior: 'wait' })
    await context.close()
    await closeFastBootstrapHarness(harness)
  }
})

test('a failed locale chunk leaves the current UI usable and a later selection retries it', async ({ browser }) => {
  const harness = await startFastBootstrapHarness(smallFastBootstrapFixture())
  const context = await browser.newContext()
  const page = await context.newPage()
  const koreanAsset = selectedLocaleAssets().get('ko')!
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  let requests = 0
  await page.route(
    (url) => url.pathname === `/${koreanAsset}`,
    async (route) => {
      if (++requests === 1) await route.fulfill({ status: 503, body: 'Temporary locale fixture failure' })
      else await route.continue()
    },
  )
  try {
    const select = await openLanguageSettings(page, harness.baseUrl)
    await select.selectOption('ko')
    const error = page.getByRole('alertdialog')
    await expect(error).toBeVisible()
    await expect(select).toHaveAttribute('aria-label', 'UI Language')
    await error.getByRole('button', { name: 'OK', exact: true }).click()
    await select.selectOption('en')
    await select.selectOption('ko')
    await expect(select).toHaveAttribute('aria-label', 'UI 언어')
    expect(requests).toBe(2)
    await page.evaluate((route) => window.__RISU_FASTIFY_BROWSER_SMOKE__!.navigateTo(route), chatPath)
    await expect(page.getByTestId('default-chat-composer')).toHaveAttribute('aria-label', '메시지 입력')
    expect(errors).toEqual([])
  } finally {
    await context.close()
    await closeFastBootstrapHarness(harness)
  }
})

test('cold selected-locale failure retries before exposing its first composer', async ({ browser }) => {
  const database = smallFastBootstrapFixture()
  database.language = 'ko'
  const harness = await startFastBootstrapHarness(database)
  const context = await browser.newContext()
  const page = await context.newPage()
  await observeFirstComposerLabel(page)
  const koreanAsset = selectedLocaleAssets().get('ko')!
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  let requests = 0
  await page.route(
    (url) => url.pathname === `/${koreanAsset}`,
    async (route) => {
      if (++requests === 1) await route.fulfill({ status: 503, body: 'Temporary startup locale failure' })
      else await route.continue()
    },
  )
  try {
    await page.goto(`${harness.baseUrl}${chatPath}`)
    const error = page.getByRole('alertdialog')
    await expect(error).toBeVisible()
    await expect(page.getByTestId('default-chat-composer')).toHaveCount(0)
    await error.getByRole('button', { name: 'OK', exact: true }).click()
    await expect(page.getByTestId('default-chat-composer')).toHaveAttribute('aria-label', '메시지 입력')
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __localeStartupObservation: { firstComposerLabel: string | null } })
            .__localeStartupObservation.firstComposerLabel,
      ),
    ).toBe('메시지 입력')
    await page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    expect(requests).toBe(2)
    expect(errors).toEqual([])
  } finally {
    await context.close()
    await closeFastBootstrapHarness(harness)
  }
})

test('new writer navigation reaches Settings while the initial character route handler is delayed', async ({
  browser,
}, testInfo) => {
  const handlerSource = 'src/ts/routeHandlers/character.ts'
  const manifest = JSON.parse(readFileSync(resolve('dist/vite-assets-manifest.json'), 'utf8')) as Record<
    string,
    { file: string; isDynamicEntry?: boolean }
  >
  const handlerAsset = manifest[handlerSource]
  expect(handlerAsset).toMatchObject({ file: expect.any(String), isDynamicEntry: true })
  const harness = await startFastBootstrapHarness(smallFastBootstrapFixture())
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []
  const apiRequests: { method: string; path: string }[] = []
  const handlerResponses: { url: string; status: number }[] = []
  let handlerRequests = 0
  let handlerReleased = false
  let releaseHandler!: () => void
  const heldHandler = new Promise<void>((resolveHandler) => {
    releaseHandler = () => {
      handlerReleased = true
      resolveHandler()
    }
  })
  const matchesHandler = (url: URL) => url.pathname === '/' + handlerAsset.file
  const evidence: Record<string, unknown> = {
    handlerSource,
    handlerAsset,
    apiRequests,
    handlerResponses,
    errors,
    observation:
      'Real emitted character-handler request held through newer production router navigation; no route or UI state is assigned by the fixture.',
  }
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/v1/')) apiRequests.push({ method: request.method(), path: url.pathname })
  })
  page.on('response', (response) => {
    if (matchesHandler(new URL(response.url())))
      handlerResponses.push({ url: response.url(), status: response.status() })
  })
  await page.route(matchesHandler, async (route) => {
    handlerRequests += 1
    await heldHandler
    await route.continue()
  })
  const snapshot = () =>
    page.evaluate(() => ({
      url: location.href,
      timeOrigin: performance.timeOrigin,
      role: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot(),
      capabilities: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities,
      route: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getRouteResourceLoadState(),
    }))
  try {
    await page.goto(harness.baseUrl + chatPath)
    await expect(page.getByTestId('default-chat-composer')).toHaveAttribute('aria-label', 'Message input')
    await page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await expect.poll(() => handlerRequests, { message: 'initial character handler request is held' }).toBe(1)
    expect(handlerReleased).toBe(false)
    expect(handlerResponses).toEqual([])
    const beforeNavigation = await snapshot()
    expect(beforeNavigation.role).toMatchObject({ managed: true, lifecycle: 'writing' })
    expect(beforeNavigation.capabilities).toMatchObject({ canMutate: true, canGenerate: true })
    expect(beforeNavigation.url).toBe(harness.baseUrl + chatPath)
    expect(beforeNavigation.route).toMatchObject({
      routeKey: 'character:fast-bootstrap-small-character:fast-bootstrap-small-chat',
      status: 'loading',
    })
    evidence.beforeNavigation = beforeNavigation

    await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.navigateTo('/settings/language'))
    evidence.afterNavigation = await snapshot()
    const select = page.locator('select:has(option[value="zh-Hant"])')
    await expect(page).toHaveURL(harness.baseUrl + '/settings/language')
    await expect(select, 'new Settings view must not wait for the older character handler').toBeVisible()
    await expect(select).toHaveAttribute('aria-label', 'UI Language')
    expect(handlerReleased).toBe(false)
    expect(handlerResponses).toEqual([])
    const settingsWhileHeld = await snapshot()
    expect(settingsWhileHeld.route).toMatchObject({ routeKey: 'settings:10:', status: 'ready' })
    evidence.settingsWhileHandlerHeld = settingsWhileHeld

    const handlerResponse = page.waitForResponse((response) => matchesHandler(new URL(response.url())))
    releaseHandler()
    const delivered = await handlerResponse
    expect(delivered.status()).toBe(200)
    await delivered.finished()
    // Observe two paint frames after real delivery; exact stale-completion
    // ordering also has a separately held-promise mounted App regression.
    await page.evaluate(
      () =>
        new Promise<void>((resolveFrame) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))
        }),
    )
    await expect(page).toHaveURL(harness.baseUrl + '/settings/language')
    await expect(select).toBeVisible()
    await expect(select).toHaveAttribute('aria-label', 'UI Language')
    const final = await snapshot()
    expect(final.timeOrigin).toBe(beforeNavigation.timeOrigin)
    expect(final.capabilities).toMatchObject({ canMutate: true, canGenerate: true })
    expect(handlerRequests).toBe(1)
    expect(handlerResponses).toEqual([{ url: harness.baseUrl + '/' + handlerAsset.file, status: 200 }])
    expect(errors).toEqual([])
    evidence.final = final
  } finally {
    releaseHandler()
    try {
      await page.unrouteAll({ behavior: 'wait' })
      evidence.handlerRequests = handlerRequests
      evidence.handlerReleased = handlerReleased
      evidence.lastSnapshot = await snapshot().catch(() => null)
      await testInfo.attach('startup-writer-route-navigation.json', {
        body: JSON.stringify(evidence, null, 2),
        contentType: 'application/json',
      })
    } finally {
      await context.close()
      await closeFastBootstrapHarness(harness)
    }
  }
})
