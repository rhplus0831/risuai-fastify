import { expect, test, type BrowserContext, type CDPSession } from '@playwright/test'
import { routeKey } from '@risuai/shared-core/router-route'
import {
  directLinkBatches,
  directLinkCases,
  expectedDirectLinkSurfaces,
  requiredResourcePaths,
  resourceSurfacesForRoute,
  startupRuntimeResourcePaths,
} from './fastBootstrapDirectLinks.js'
import {
  writeFastBootstrapDirectLinkBatchPartial,
  type FastBootstrapDirectLinkBatchArtifact,
} from './fastBootstrapIntegrationArtifact.js'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
} from './fastBootstrapHarness.js'

const allCases = directLinkCases()
const batches = directLinkBatches(allCases)

test.setTimeout(120_000)

test.describe('Fast-bootstrap direct-link matrix', () => {
  test.describe.configure({ mode: 'parallel' })

  for (const batch of batches) {
    test(`batch ${batch.batchIndex + 1}/${batch.batchCount} hydrates ${batch.cases.length} empty-cache routes`, async ({
      browser,
    }, testInfo) => {
      const partial: FastBootstrapDirectLinkBatchArtifact = {
        schemaVersion: 1,
        batchIndex: batch.batchIndex,
        batchCount: batch.batchCount,
        totalCaseCount: allCases.length,
        complete: false,
        directLinks: [],
      }
      const harness = await startFastBootstrapHarness(smallFastBootstrapFixture(), {
        temporaryDirectoryPrefix: `risu-fast-bootstrap-direct-links-${batch.batchIndex + 1}-`,
      })
      let context: BrowserContext | undefined
      let cdp: CDPSession | undefined
      try {
        expect(new Set(allCases.map((entry) => routeKey(entry.route))).size).toBe(allCases.length)
        expect(new Set(allCases.flatMap((entry) => resourceSurfacesForRoute(entry.route)))).toEqual(
          new Set(expectedDirectLinkSurfaces()),
        )

        const knownRouteResourcePaths = new Set(allCases.flatMap((entry) => requiredResourcePaths(entry.route)))
        context = await browser.newContext()
        const page = await context.newPage()
        cdp = await context.newCDPSession(page)
        await cdp.send('Network.enable')
        const pageErrors: string[] = []
        const requestedPaths = new Set<string>()
        page.on('pageerror', (error) => pageErrors.push(error.message))
        page.on('request', (request) => {
          const url = new URL(request.url())
          if (url.pathname.startsWith('/api/v1/')) requestedPaths.add(url.pathname)
        })

        for (const { caseIndex, definition } of batch.cases) {
          if (page.url().startsWith(harness.baseUrl)) {
            await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.clearResourceCache())
          }
          await cdp.send('Network.clearBrowserCache')
          pageErrors.length = 0
          requestedPaths.clear()

          await page.goto(`${harness.baseUrl}${definition.path}`, { waitUntil: 'domcontentloaded' })
          await waitForSmokeHook(page)
          const finalRoute = definition.finalRoute ?? definition.route
          await expect
            .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getRouteResourceLoadState()), {
              message: `${definition.path} did not finish its route resource load`,
            })
            .toMatchObject({ routeKey: routeKey(definition.route), status: 'ready', error: null })
          const foregroundRequestedPaths = new Set(requestedPaths)
          await page.evaluate(() =>
            window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
          )
          expect(await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getCurrentRoute())).toEqual(
            finalRoute,
          )
          expect(pageErrors).toEqual([])

          const requiredPaths = requiredResourcePaths(definition.route)
          expect(foregroundRequestedPaths).toContain('/api/v1/resources/shell')
          for (const requiredPath of requiredPaths) {
            expect(foregroundRequestedPaths, `${definition.path} did not request ${requiredPath}`).toContain(
              requiredPath,
            )
          }
          const allowedRouteResourcePaths = new Set([
            '/api/v1/resources/shell',
            '/api/v1/characters/fast-bootstrap-small-character',
            '/api/v1/chats/fast-bootstrap-small-chat/messages',
            ...requiredPaths,
            ...startupRuntimeResourcePaths(definition.route),
          ])
          const unexpectedRouteResourcePaths = [...foregroundRequestedPaths]
            .filter((requestedPath) => knownRouteResourcePaths.has(requestedPath))
            .filter((requestedPath) => !allowedRouteResourcePaths.has(requestedPath))
            .sort()
          expect(unexpectedRouteResourcePaths, `${definition.path} eagerly fetched unrelated route resources`).toEqual(
            [],
          )
          partial.directLinks.push({
            caseIndex,
            result: {
              path: definition.path,
              requestedRouteKey: routeKey(definition.route),
              finalRouteKey: routeKey(finalRoute),
              surfaces: resourceSurfacesForRoute(definition.route),
              requiredPaths,
              requestedPaths: [...foregroundRequestedPaths].sort(),
            },
          })
        }
        partial.complete = true
      } finally {
        await cdp?.detach().catch(() => undefined)
        await context?.close().catch(() => undefined)
        await closeFastBootstrapHarness(harness)
        const output = writeFastBootstrapDirectLinkBatchPartial(partial)
        await testInfo.attach(`fast-bootstrap-direct-links-${batch.batchIndex + 1}-of-${batch.batchCount}.json`, {
          body: output,
          contentType: 'application/json',
        })
      }
    })
  }
})

async function waitForSmokeHook(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__)), { timeout: 20_000 })
    .toBe(true)
}
