import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildLargeCorpusFixture } from '../../../test/fixtures/largeCorpusFixture.js'
import { STARTUP_TELEMETRY_FAILURE_CODES, STARTUP_TELEMETRY_MILESTONES } from '@risuai/protocol/startup-telemetry'
import { subscribeProtocolMetrics } from '../src/protocolMetrics.js'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
} from './fastBootstrapHarness.js'
import {
  emptyFastBootstrapRecoveryArtifact,
  writeFastBootstrapRecoveryPartial,
  type BrowserStartupTelemetry,
  type FastBootstrapRecoveryArtifact,
  type WorkspaceStartupCase,
} from './fastBootstrapIntegrationArtifact.js'

interface ApiRequestRecord {
  method: string
  path: string
  startedAtEpochMs: number
}

const previousProtocolMetrics = process.env.RISU_PROTOCOL_METRICS
const artifact: FastBootstrapRecoveryArtifact = emptyFastBootstrapRecoveryArtifact()

test.setTimeout(240_000)

test.afterAll(async ({}, testInfo) => {
  const machineOutput = writeFastBootstrapRecoveryPartial(artifact)
  await testInfo.attach('fast-bootstrap-integration.recovery.partial.json', {
    body: machineOutput,
    contentType: 'application/json',
  })
})

test('role-first startup matrix covers small and large fixtures', async ({ browser }) => {
  process.env.RISU_PROTOCOL_METRICS = '1'
  try {
    const workspaceStartup: WorkspaceStartupCase[] = []
    for (const fixture of ['small', 'large'] as const) {
      const database = fixture === 'small' ? smallFastBootstrapFixture() : buildLargeCorpusFixture().database
      workspaceStartup.push(await runWorkspaceStartupCase(browser, fixture, database))
    }

    artifact.workspaceStartup = workspaceStartup
  } finally {
    if (previousProtocolMetrics === undefined) delete process.env.RISU_PROTOCOL_METRICS
    else process.env.RISU_PROTOCOL_METRICS = previousProtocolMetrics
  }
})

test('legacy and null shell values normalize during built-browser startup', async ({ browser }) => {
  const harness = await startFastBootstrapHarness(smallFastBootstrapFixture(), {
    temporaryDirectoryPrefix: 'risu-phase2-legacy-shell-',
  })
  const context = await browser.newContext()
  try {
    const sqlite = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      const row = sqlite.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
      const settings = JSON.parse(row.data_json) as Record<string, unknown>
      delete settings.language
      settings.username = null
      settings.customCSS = ''
      settings.keepSessionAlive = 'pip'
      settings.animationSpeed = 'fast'
      settings.colorScheme = {}
      settings.doNotWarnExternalServers = 1
      settings.characterOrder = null
      settings.currentChar = 99
      sqlite.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
    } finally {
      sqlite.close()
    }

    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await page.goto(harness.baseUrl, { waitUntil: 'domcontentloaded' })
    await waitForSmokeHook(page)
    await page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )

    expect(await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot())).toMatchObject({
      language: 'en',
      username: 'User',
      customCSS: '',
      keepSessionAlive: 'sound',
      animationSpeed: 0.4,
      colorScheme: expect.objectContaining({ type: 'dark' }),
      doNotWarnExternalServers: false,
      characterOrder: [],
      currentChar: -1,
    })
    expect(pageErrors).toEqual([])
  } finally {
    await context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('durable recovery replays committed work whose response was lost', async ({ browser }) => {
  for (const scenario of ['response-lost-after-commit'] as const) {
    const harness = await startFastBootstrapHarness(smallFastBootstrapFixture(), {
      temporaryDirectoryPrefix: `risu-fast-bootstrap-${scenario}-`,
    })
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      const commandMutationIds: string[] = []
      const receiptAcknowledgements: Array<{ body: string; status: number }> = []
      page.on('request', (request) => {
        const url = new URL(request.url())
        const headers = request.headers()
        if (url.pathname === '/api/v1/commands/settings/runtime') {
          commandMutationIds.push(headers['risu-mutation-id'] ?? '')
        }
      })
      page.on('response', (response) => {
        if (new URL(response.url()).pathname !== '/api/v1/commands/mutation-receipts/ack') return
        receiptAcknowledgements.push({ body: response.request().postData() ?? '', status: response.status() })
      })

      await page.goto(harness.baseUrl, { waitUntil: 'domcontentloaded' })
      await waitForSmokeHook(page)
      await page.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
      )
      const initialRevision = await page.evaluate(
        () => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision()!,
      )

      let responseDropped = false
      await page.route('**/api/v1/commands/settings/runtime', async (route) => {
        if (responseDropped) {
          await route.continue()
          return
        }
        responseDropped = true
        await route.fetch()
        await route.abort('connectionclosed')
      })

      const failedResult = await page.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.patchRuntimeSettings({ streamGeminiThoughts: true }),
      )
      expect(failedResult).toMatchObject({ status: 'error' })
      const retained = await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getLifecycleSnapshot())
      expect(retained.outbox).toHaveLength(1)
      const retainedMutationId = retained.outbox[0]!.mutationId
      expect(retainedMutationId).toMatch(/\S/u)
      expect(retained.receiptAcknowledgements).toEqual([])

      await context.setOffline(false)
      await page.unroute('**/api/v1/commands/settings/runtime')
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForSmokeHook(page)
      await page.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
      )
      await expect
        .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getLifecycleSnapshot()))
        .toMatchObject({ outbox: [], receiptAcknowledgements: [] })
      expect(
        await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().streamGeminiThoughts),
      ).toBe(true)
      const finalRevision = await page.evaluate(
        () => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision()!,
      )
      expect(finalRevision).toBe(initialRevision + 1)
      // A live heartbeat replay can begin after the deliberately lost
      // response and then be interrupted by this test's reload. Startup must
      // retry that retained intent, but every transport attempt must preserve
      // the same idempotency key and still produce one committed revision.
      expect(commandMutationIds.length).toBeGreaterThanOrEqual(2)
      expect(new Set(commandMutationIds)).toEqual(new Set([retainedMutationId]))
      await expect.poll(() => receiptAcknowledgements.length).toBe(1)
      expect(receiptAcknowledgements[0]!.status).toBe(200)
      expect(JSON.parse(receiptAcknowledgements[0]!.body)).toMatchObject({
        mutationId: retainedMutationId,
        requestCount: 1,
      })

      artifact.recoveryJourneys.push({
        scenario,
        initialRevision,
        finalRevision,
        retainedMutationId,
        commandAttempts: commandMutationIds.length,
        receiptAcknowledgements: receiptAcknowledgements.length,
        resourceRefreshes: 0,
      })
    } finally {
      await context.setOffline(false).catch(() => undefined)
      await context.close().catch(() => undefined)
      await closeFastBootstrapHarness(harness)
    }
  }
})

test('event-gap recovery performs an authoritative refresh before reconnecting', async ({ browser }) => {
  const harness = await startFastBootstrapHarness(smallFastBootstrapFixture(), {
    temporaryDirectoryPrefix: 'risu-fast-bootstrap-event-gap-',
  })
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const fullRefreshPaths = new Set([
      '/api/v1/settings',
      '/api/v1/collections',
      '/api/v1/characters',
      '/api/v1/inlay-assets',
    ])
    let fullRefreshRequests = 0
    let gapSeen = false
    const recoveryOrder: string[] = []
    page.on('request', (request) => {
      if (fullRefreshPaths.has(new URL(request.url()).pathname)) fullRefreshRequests += 1
    })
    page.on('response', (response) => {
      const pathname = new URL(response.url()).pathname
      if (pathname === '/api/v1/events' && response.status() === 409) {
        gapSeen = true
        recoveryOrder.push('events:gap')
        return
      }
      if (!gapSeen) return
      if (fullRefreshPaths.has(pathname)) recoveryOrder.push(`refresh:${pathname}`)
      if (pathname === '/api/v1/events' && response.status() === 200) recoveryOrder.push('events:reconnected')
    })

    await page.goto(harness.baseUrl, { waitUntil: 'domcontentloaded' })
    await waitForSmokeHook(page)
    await page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    const initialRevision = await page.evaluate(
      () => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision()!,
    )
    const activeWriterHeaders = await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders())
    const fullRefreshRequestsBeforeGap = fullRefreshRequests
    const reconnectHeld = deferred<void>()
    const releaseReconnect = deferred<void>()
    let heldReconnect = false
    await page.route('**/api/v1/events*', async (route) => {
      if (heldReconnect) {
        await route.continue()
        return
      }
      heldReconnect = true
      reconnectHeld.resolve()
      await releaseReconnect.promise
      await route.continue()
    })

    harness.app.server.closeAllConnections()
    await reconnectHeld.promise
    const changed = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { ...activeWriterHeaders, 'content-type': 'application/json' },
      payload: { baseRevision: initialRevision, patch: { streamGeminiThoughts: true } },
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toMatchObject({ revision: initialRevision + 1 })
    expect(
      await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().streamGeminiThoughts),
    ).toBe(false)

    const database = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      const deleted = database.prepare('DELETE FROM command_events WHERE revision = ?').run(initialRevision + 1)
      expect(deleted.changes).toBe(1)
    } finally {
      database.close()
    }

    const replayUnavailable = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/events' && response.status() === 409,
      { timeout: 30_000 },
    )
    releaseReconnect.resolve()
    expect(await (await replayUnavailable).json()).toMatchObject({
      error: 'event_replay_unavailable',
      requestedRevision: initialRevision,
      currentRevision: initialRevision + 1,
    })
    await expect
      .poll(() => fullRefreshRequests, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(fullRefreshRequestsBeforeGap + 4)
    await expect
      .poll(
        () =>
          page.evaluate(() => ({
            revision: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision(),
            value: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().streamGeminiThoughts,
          })),
        { timeout: 30_000 },
      )
      .toEqual({ revision: initialRevision + 1, value: true })
    await expect
      .poll(() =>
        page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
      )
      .toMatchObject({ canApplyRoutes: true, canMutate: true })
    await expect.poll(() => recoveryOrder.includes('events:reconnected')).toBe(true)
    const gapIndex = recoveryOrder.indexOf('events:gap')
    const reconnectIndex = recoveryOrder.indexOf('events:reconnected')
    expect(gapIndex).toBeGreaterThanOrEqual(0)
    expect(reconnectIndex).toBeGreaterThan(gapIndex)
    for (const refreshPath of fullRefreshPaths) {
      const refreshIndex = recoveryOrder.indexOf(`refresh:${refreshPath}`)
      expect(refreshIndex, `${refreshPath} did not complete before the event reconnect`).toBeGreaterThan(gapIndex)
      expect(refreshIndex, `${refreshPath} completed after the event reconnect`).toBeLessThan(reconnectIndex)
    }

    artifact.recoveryJourneys.push({
      scenario: 'event-gap',
      initialRevision,
      finalRevision: initialRevision + 1,
      commandAttempts: 1,
      receiptAcknowledgements: 0,
      resourceRefreshes: fullRefreshRequests - fullRefreshRequestsBeforeGap,
    })
  } finally {
    await context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('mixed-client journey denies pre-authority mutation and keeps the old writer connected after takeover', async ({
  browser,
}) => {
  const harness = await startFastBootstrapHarness(smallFastBootstrapFixture(), {
    temporaryDirectoryPrefix: 'risu-fast-bootstrap-writer-takeover-',
    databaseSeedMode: 'unowned-migration',
  })
  const writerContext = await browser.newContext()
  const readerContext = await browser.newContext()
  try {
    const writerPage = await writerContext.newPage()
    const readerPage = await readerContext.newPage()
    const writerCommands: string[] = []
    const readerCommands: string[] = []
    recordCommandPaths(writerPage, writerCommands)
    recordCommandPaths(readerPage, readerCommands)

    await writerPage.goto(harness.baseUrl, { waitUntil: 'domcontentloaded' })
    await waitForSmokeHook(writerPage)
    await writerPage.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )

    await readerPage.goto(harness.baseUrl, { waitUntil: 'domcontentloaded' })
    await waitForSmokeHook(readerPage)
    await expect(readerPage.locator('[data-reader-use-this-device]')).toBeVisible()
    const deniedMutation = await readerPage.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.patchRuntimeSettings({ streamGeminiThoughts: true }),
    )
    expect(deniedMutation).toMatchObject({ status: 'unavailable' })
    expect(readerCommands).toEqual([])
    await readerPage.locator('[data-reader-use-this-device]').click()
    await readerPage.getByRole('button', { name: 'Disconnect existing client', exact: true }).click()
    await expect
      .poll(() => readerPage.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot()))
      .toMatchObject({ lifecycle: 'writing' })
    await expect
      .poll(() =>
        readerPage.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
      )
      .toMatchObject({ canMutate: true })
    expect(readerCommands).toEqual([])

    await expect(writerPage.locator('[data-risu-workspace]')).toBeVisible()
    await expect
      .poll(() =>
        writerPage.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
      )
      .toMatchObject({ canApplyRoutes: true, canGenerate: false, canMutate: false })
    await expect(writerPage.getByRole('button', { name: 'Stay on this page (offline)', exact: true })).toHaveCount(0)
    await expect(writerPage.locator('[data-reader-lifecycle-status]')).toContainText(
      'Updates from the writer appear here.',
    )
    const revokedMutation = await writerPage.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.patchRuntimeSettings({ streamGeminiThoughts: true }),
    )
    expect(revokedMutation).toMatchObject({ status: 'unavailable' })
    expect(writerCommands).toEqual([])

    const mutation = await readerPage.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.patchRuntimeSettings({ streamGeminiThoughts: true }),
    )
    expect(mutation).toMatchObject({ status: 'ok' })
    expect(readerCommands).toEqual(['/api/v1/commands/settings/runtime'])
    expect(writerCommands).toEqual([])
    await expect
      .poll(() =>
        writerPage.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().streamGeminiThoughts),
      )
      .toBe(true)

    artifact.writerJourneys.push({
      scenario: 'denial-then-takeover',
      readerCommandsBeforePromotion: 0,
      oldWriterCommandsAfterTakeover: writerCommands.length,
      newWriterMutationAccepted: mutation.status === 'ok',
    })
  } finally {
    await Promise.all([writerContext.close().catch(() => undefined), readerContext.close().catch(() => undefined)])
    await closeFastBootstrapHarness(harness)
  }
})

test('background runtimes cannot delay or fail shell, mutation, and chat readiness', async ({ browser }) => {
  for (const mode of ['slow', 'failed'] as const) {
    const harness = await startFastBootstrapHarness(smallFastBootstrapFixture(), {
      temporaryDirectoryPrefix: `risu-fast-bootstrap-background-${mode}-`,
    })
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      const requested = deferred<void>()
      const release = deferred<void>()
      await page.route('**/api/v1/settings/display', async (route) => {
        requested.resolve()
        if (mode === 'failed') {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'fast_bootstrap_optional_runtime_failure' }),
          })
          return
        }
        await release.promise
        await route.continue()
      })

      const navigation = page.goto(
        `${harness.baseUrl}/character/fast-bootstrap-small-character/fast-bootstrap-small-chat`,
        {
          waitUntil: 'domcontentloaded',
        },
      )
      await requested.promise
      await waitForSmokeHook(page)
      await expect
        .poll(() =>
          page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
        )
        .toMatchObject({ canRenderShell: true, canMutate: true, pluginsReady: true, canGenerate: true })
      const mutation = await page.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.patchRuntimeSettings({ streamGeminiThoughts: true }),
      )
      expect(mutation).toMatchObject({ status: 'ok' })
      expect(
        await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().streamGeminiThoughts),
      ).toBe(true)

      if (mode === 'slow') {
        expect(await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupSnapshot().phase)).not.toBe(
          'background-ready',
        )
        release.resolve()
      }
      await page.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
      )
      const coordinator = await page.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot(),
      )
      expect(coordinator.failures).toEqual({})

      artifact.optionalRuntimeJourneys.push({
        runtime: 'background-resources',
        mode,
        canRenderShell: coordinator.capabilities.canRenderShell,
        canMutate: coordinator.capabilities.canMutate,
        canGenerate: coordinator.capabilities.canGenerate,
        localizedFailure: mode === 'failed',
        retrySucceeded: mode === 'slow',
      })
    } finally {
      await context.close().catch(() => undefined)
      await closeFastBootstrapHarness(harness)
    }
  }
})

test('inlay runtime stays route-local when slow or failed and recovers through Retry', async ({ browser }) => {
  for (const mode of ['slow', 'failed'] as const) {
    const harness = await startFastBootstrapHarness(smallFastBootstrapFixture(), {
      temporaryDirectoryPrefix: `risu-fast-bootstrap-inlay-${mode}-`,
    })
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.goto(harness.baseUrl, { waitUntil: 'domcontentloaded' })
      await waitForSmokeHook(page)
      await page.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
      )

      const requested = deferred<void>()
      const release = deferred<void>()
      await page.route('**/api/v1/inlay-assets', async (route) => {
        requested.resolve()
        if (mode === 'failed') {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'fast_bootstrap_inlay_failure' }),
          })
          return
        }
        await release.promise
        await route.continue()
      })

      await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.navigateTo('/inlay'))
      await requested.promise
      const coordinator = await page.evaluate(() =>
        window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot(),
      )
      expect(coordinator.capabilities).toMatchObject({ canRenderShell: true, canMutate: true })

      if (mode === 'slow') {
        await expect(page.getByTestId('route-resource-loading')).toBeVisible()
        expect(await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getRouteResourceLoadState())).toEqual({
          routeKey: 'inlay',
          status: 'loading',
          error: null,
        })
        release.resolve()
      } else {
        await expect(page.getByTestId('route-resource-error')).toBeVisible()
        expect(
          await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getRouteResourceLoadState()),
        ).toMatchObject({ routeKey: 'inlay', status: 'error' })
        await page.unroute('**/api/v1/inlay-assets')
        await page.getByRole('button', { name: 'Retry', exact: true }).click()
      }

      await expect
        .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getRouteResourceLoadState()))
        .toEqual({ routeKey: 'inlay', status: 'ready', error: null })
      expect(
        await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
      ).toMatchObject({ canRenderShell: true, canMutate: true })

      artifact.optionalRuntimeJourneys.push({
        runtime: 'inlay-catalog',
        mode,
        canRenderShell: coordinator.capabilities.canRenderShell,
        canMutate: coordinator.capabilities.canMutate,
        canGenerate: coordinator.capabilities.canGenerate,
        localizedFailure: mode === 'failed',
        retrySucceeded: true,
      })
    } finally {
      await context.close().catch(() => undefined)
      await closeFastBootstrapHarness(harness)
    }
  }
})

async function runWorkspaceStartupCase(
  browser: Browser,
  fixture: WorkspaceStartupCase['fixture'],
  database: Record<string, unknown>,
): Promise<WorkspaceStartupCase> {
  const harness = await startFastBootstrapHarness(database, {
    temporaryDirectoryPrefix: `risu-fast-bootstrap-${fixture}-`,
    databaseSeedMode: 'unowned-migration',
  })
  const telemetry: BrowserStartupTelemetry[] = []
  const unsubscribeMetrics = subscribeProtocolMetrics((metric) => {
    const safe = safeBrowserStartupTelemetry(metric)
    if (safe) telemetry.push(safe)
  })
  let context: BrowserContext | undefined
  try {
    context = await browser.newContext()
    const page = await context.newPage()
    const requests = recordApiRequests(page)
    const writerBootstrap = await delayFirstWriterBootstrap(page)

    await page.goto(harness.baseUrl, { waitUntil: 'domcontentloaded' })
    await waitForSmokeHook(page)
    await writerBootstrap.requested

    const coordinatorBeforeWriter = await page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot(),
    )
    expect(coordinatorBeforeWriter.capabilities.canMutate).toBe(false)
    expect(coordinatorBeforeWriter.capabilities.canGenerate).toBe(false)
    await expect(page.locator('[data-risu-workspace]')).toHaveCount(0)
    expect(coordinatorBeforeWriter.capabilities.canRenderShell).toBe(false)

    writerBootstrap.release()
    await writerBootstrap.finished
    await page.unroute('**/api/v1/bootstrap')
    await page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await expect
      .poll(
        () =>
          telemetry.some((entry) => entry.kind === 'phase-ready' && entry.milestone === 'background-ready') &&
          telemetry.some((entry) => entry.kind === 'attempt-completed'),
      )
      .toBe(true)

    const final = await page.evaluate(() => ({
      startup: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupSnapshot(),
      coordinator: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot(),
      timeOrigin: performance.timeOrigin,
    }))
    expect(final.startup.phase).toBe('background-ready')
    expect(final.coordinator.capabilities).toMatchObject({
      canApplyRoutes: true,
      canMutate: true,
    })
    expect(final.startup.timestamps['reader-ready']).toBeLessThanOrEqual(final.startup.timestamps['writer-ready']!)

    const writerReadyAt = final.timeOrigin + (final.startup.timestamps['writer-ready'] ?? Number.POSITIVE_INFINITY)
    const chatReadyAt = final.timeOrigin + (final.startup.timestamps['chat-ready'] ?? Number.POSITIVE_INFINITY)
    const earlyRequests = {
      mutationsBeforeWriterReady: requests.filter(
        (request) =>
          request.method !== 'GET' &&
          request.path.startsWith('/api/v1/commands/') &&
          request.startedAtEpochMs < writerReadyAt,
      ).length,
      generationsBeforeChatReady: requests.filter(
        (request) =>
          request.method !== 'GET' &&
          (request.path.startsWith('/api/v1/generate/') || request.path.startsWith('/api/v1/generation-operations')) &&
          request.startedAtEpochMs < chatReadyAt,
      ).length,
    }
    expect(earlyRequests).toEqual({ mutationsBeforeWriterReady: 0, generationsBeforeChatReady: 0 })
    expect(telemetry.filter((entry) => entry.kind === 'phase-ready').map((entry) => entry.milestone)).toEqual(
      STARTUP_TELEMETRY_MILESTONES,
    )
    expect(telemetry.filter((entry) => entry.kind === 'attempt-completed')).toHaveLength(1)
    expect(telemetry.filter((entry) => entry.kind === 'attempt-failed')).toEqual([])
    expect(
      telemetry
        .filter((entry) => entry.kind === 'diagnostic-failure')
        .every(
          (entry) =>
            entry.failureCode !== undefined &&
            STARTUP_TELEMETRY_FAILURE_CODES.includes(
              entry.failureCode as (typeof STARTUP_TELEMETRY_FAILURE_CODES)[number],
            ),
        ),
    ).toBe(true)
    return {
      fixture,
      startup: final.startup,
      coordinator: final.coordinator,
      earlyRequests,
      telemetry,
    }
  } finally {
    unsubscribeMetrics()
    await context?.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
}

function safeBrowserStartupTelemetry(metric: Readonly<Record<string, unknown>>): BrowserStartupTelemetry | null {
  if (
    metric.metric !== 'browser_startup' ||
    typeof metric.schemaVersion !== 'number' ||
    typeof metric.kind !== 'string' ||
    typeof metric.attemptCount !== 'number'
  ) {
    return null
  }
  return {
    schemaVersion: metric.schemaVersion,
    kind: metric.kind,
    attemptCount: metric.attemptCount,
    ...(typeof metric.milestone === 'string' ? { milestone: metric.milestone } : {}),
    ...(typeof metric.entryDurationMs === 'number' ? { entryDurationMs: metric.entryDurationMs } : {}),
    ...(typeof metric.attemptDurationMs === 'number' ? { attemptDurationMs: metric.attemptDurationMs } : {}),
    ...(typeof metric.failureCode === 'string' ? { failureCode: metric.failureCode } : {}),
    ...(typeof metric.failureMilestone === 'string' ? { failureMilestone: metric.failureMilestone } : {}),
    ...(typeof metric.requestUid === 'string' ? { requestUid: metric.requestUid } : {}),
  }
}

function recordApiRequests(page: Page): ApiRequestRecord[] {
  const requests: ApiRequestRecord[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/v1/')) return
    requests.push({ method: request.method(), path: url.pathname, startedAtEpochMs: Date.now() })
  })
  return requests
}

async function delayFirstWriterBootstrap(page: Page): Promise<{
  requested: Promise<void>
  release: () => void
  finished: Promise<void>
}> {
  const requested = deferred<void>()
  const release = deferred<void>()
  const finished = deferred<void>()
  let delayed = false
  await page.route('**/api/v1/bootstrap', async (route) => {
    const headers = await route.request().allHeaders()
    if (!delayed && headers['risu-writer-session']) {
      delayed = true
      requested.resolve()
      await release.promise
      await route.continue()
      finished.resolve()
      return
    }
    await route.continue()
  })
  return { requested: requested.promise, release: release.resolve, finished: finished.promise }
}

async function waitForSmokeHook(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__)), { timeout: 20_000 })
    .toBe(true)
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function recordCommandPaths(page: Page, paths: string[]): void {
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.startsWith('/api/v1/commands/') && pathname !== '/api/v1/commands/mutation-receipts/ack') {
      paths.push(pathname)
    }
  })
}
