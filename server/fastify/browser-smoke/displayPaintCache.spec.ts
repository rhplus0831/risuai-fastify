import { expect, test, type Page } from '@playwright/test'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
} from './fastBootstrapHarness.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function appearance(page: Page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return Object.fromEntries(
      [
        '--risu-theme-bgcolor',
        '--risu-theme-textcolor',
        '--risu-theme-color-scheme',
        '--risu-font-family',
        '--sidebar-size',
        '--risu-animation-speed',
        '--paint-cache-test',
      ].map((key) => [key, style.getPropertyValue(key).trim()]),
    )
  })
}

test('warm reload keeps appearance stable before the bundle, shell, and Display response arrive', async ({
  browser,
}) => {
  test.setTimeout(90_000)
  const palette = {
    bgcolor: '#f5f7fc',
    darkbg: '#e2e7f0',
    borderc: '#334155',
    selected: '#cbd5e1',
    draculared: '#dc2626',
    textcolor: '#0f172a',
    textcolor2: '#475569',
    darkBorderc: '#94a3b8',
    darkbutton: '#cbd5e1',
    type: 'light',
  }
  const database = smallFastBootstrapFixture()
  Object.assign(database, {
    colorSchemeName: 'custom',
    colorScheme: palette,
    customColorScheme: palette,
    textTheme: 'standard',
    font: 'custom',
    customFont: 'Georgia, serif',
    theme: 'mobilechat',
    zoomsize: 140,
    lineHeight: 1.8,
    sideBarSize: 1,
    textAreaSize: 3,
    animationSpeed: 0.75,
    customCSS: ':root { --paint-cache-test: ready; }',
  })
  ;(database.characters as Array<Record<string, unknown>>)[0].firstMessage = 'Cached appearance greeting'
  const harness = await startFastBootstrapHarness(database)
  const context = await browser.newContext()
  const releaseEntry = deferred()
  const releaseShell = deferred()
  const releaseDisplay = deferred()
  try {
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${harness.baseUrl}/character/fast-bootstrap-small-character/fast-bootstrap-small-chat`)
    await expect.poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))).toBe(true)
    await page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await expect(page.locator('.chat-message-body').first()).toBeVisible()
    const expected = await appearance(page)
    expect(expected).toMatchObject({
      '--risu-theme-bgcolor': '#f5f7fc',
      '--risu-theme-color-scheme': 'light',
      '--risu-font-family': 'Georgia, serif',
      '--sidebar-size': '28rem',
      '--risu-animation-speed': '0.75s',
      '--paint-cache-test': 'ready',
    })
    const entryUrl = await page.locator('script[type="module"][src]').first().getAttribute('src')
    expect(entryUrl).toBeTruthy()
    const shellRequested = deferred()
    const displayRequested = deferred()
    await page.route(new URL(entryUrl!, harness.baseUrl).href, async (route) => {
      await releaseEntry.promise
      await route.continue()
    })
    await page.route('**/api/v1/resources/shell', async (route) => {
      shellRequested.resolve()
      await releaseShell.promise
      await route.continue()
    })
    await page.route('**/api/v1/settings/display', async (route) => {
      displayRequested.resolve()
      await releaseDisplay.promise
      await route.continue()
    })

    await page.addInitScript((expectedAppearance) => {
      const observations = { samples: 0, mismatches: [] as string[] }
      ;(window as unknown as { displayPaintObservations: typeof observations }).displayPaintObservations = observations
      const sample = () => {
        if (document.querySelector('#app, #preloading') && observations.mismatches.length < 10) {
          observations.samples++
          const root = getComputedStyle(document.documentElement)
          for (const [key, value] of Object.entries(expectedAppearance)) {
            const actual = root.getPropertyValue(key).trim()
            if (actual !== value) observations.mismatches.push(`${key}: ${actual}`)
          }
          const message = document.querySelector('.chat-message-body')
          if (message && getComputedStyle(message).fontSize !== '19.6px') {
            observations.mismatches.push(`chat font: ${getComputedStyle(message).fontSize}`)
          }
        }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }, expected)

    await page.reload({ waitUntil: 'commit' })
    await expect(page.locator('#preloading')).toBeVisible()
    expect(await page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__))).toBe(false)
    expect(await appearance(page)).toEqual(expected)
    await expect(page.locator('#preloading')).toHaveCSS('background-color', 'rgb(245, 247, 252)')
    await expectPaintFrame(page)

    releaseEntry.resolve()
    await shellRequested.promise
    await expect(page.locator('#preloading')).toHaveCount(0)
    expect(await appearance(page)).toEqual(expected)
    await expect(page.locator('main [role="status"]').first()).toHaveCSS('background-color', 'rgb(245, 247, 252)')
    await expectPaintFrame(page)

    releaseShell.resolve()
    await displayRequested.promise
    // Paint is available immediately, while transcript rendering waits for
    // authoritative Display settings and the other chat display dependencies.
    await expect(page.locator('[data-chat-message-skeleton]')).toBeVisible()
    await expect(page.locator('.chat-message-body')).toHaveCount(0)
    expect(await appearance(page)).toEqual(expected)
    // Cached paint values must not masquerade as hydrated Display settings.
    expect(
      await page.evaluate(() =>
        Object.hasOwn(window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot(), 'zoomsize'),
      ),
    ).toBe(false)
    await expectPaintFrame(page)

    releaseDisplay.resolve()
    await page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    expect(await appearance(page)).toEqual(expected)
    await expect(page.locator('.chat-message-body').first()).toHaveCSS('font-size', '19.6px')
    await expect(page.locator('.chat-message-body').first()).toHaveCSS('line-height', '40.32px')
    expect(await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot())).toMatchObject({
      zoomsize: 140,
    })
    await expectPaintFrame(page)
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { displayPaintObservations: { mismatches: string[] } }).displayPaintObservations
            .mismatches,
      ),
    ).toEqual([])
    expect(errors).toEqual([])
  } finally {
    releaseEntry.resolve()
    releaseShell.resolve()
    releaseDisplay.resolve()
    await context.close()
    await closeFastBootstrapHarness(harness)
  }
})

/** Each held startup phase must actually reach the paint sampler before release. */
async function expectPaintFrame(page: Page): Promise<void> {
  const readSamples = () =>
    page.evaluate(() => (Reflect.get(window, 'displayPaintObservations') as { samples: number }).samples)
  const before = await readSamples()
  await expect.poll(readSamples, { message: 'the held startup phase produces a paint sample' }).toBeGreaterThan(before)
  expect(
    await page.evaluate(() => (Reflect.get(window, 'displayPaintObservations') as { mismatches: string[] }).mismatches),
  ).toEqual([])
}
