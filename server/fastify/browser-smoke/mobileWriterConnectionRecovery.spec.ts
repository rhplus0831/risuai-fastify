import { devices, expect, test, type Browser, type Page, type Request, type TestInfo } from '@playwright/test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
} from './fastBootstrapHarness.js'

const CHAT_PATH = '/character/fast-bootstrap-small-character/fast-bootstrap-small-chat'
const DRAFT = 'retained mobile draft'

type FaultMode = 'event-stream-close' | 'offline'

interface ApiRequestRecord {
  method: string
  path: string
  resourceType: string
}

interface DurableSnapshot {
  revision: number
  databaseLineage: string
  writerSessionId: string | null
  writerEpoch: number
}

interface PageSnapshot {
  url: string
  timeOrigin: number
  lifecycle: string
  connection: string
  sessionId: string | null
  databaseLineage: string | null
  writerSessionId: string | null
  writerEpoch: number | null
  appliedRevision: number | null
  canMutate: boolean
  canGenerate: boolean
  readerLayout: boolean
  composerPresent: boolean
  sameComposer: boolean
  composerInert: boolean
  composerValue: string | null
  recoveryStatus: string | null
}

interface EventResponseRecord {
  request: IncomingMessage
  response: ServerResponse
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function recordApiRequest(request: Request, records: ApiRequestRecord[]): void {
  const url = new URL(request.url())
  if (!url.pathname.startsWith('/api/v1/')) return
  records.push({ method: request.method(), path: url.pathname, resourceType: request.resourceType() })
}

function isProjectionHydrationRequest(request: ApiRequestRecord): boolean {
  return (
    request.path === '/api/v1/resources/shell' ||
    /^\/api\/v1\/settings\//u.test(request.path) ||
    /^\/api\/v1\/collections\//u.test(request.path) ||
    /^\/api\/v1\/characters(?:\/|$)/u.test(request.path) ||
    /^\/api\/v1\/chats\//u.test(request.path) ||
    /^\/api\/v1\/assets\/index$/u.test(request.path) ||
    /^\/api\/v1\/inlay\//u.test(request.path)
  )
}

function durableSnapshot(dataDir: string): DurableSnapshot {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    const schema = db.prepare('SELECT revision FROM schema_version WHERE id = 1').get() as { revision: number }
    const ownership = db
      .prepare('SELECT lineage, active_writer_session_id, writer_epoch FROM database_metadata WHERE id = 1')
      .get() as { lineage: string; active_writer_session_id: string | null; writer_epoch: number }
    return {
      revision: schema.revision,
      databaseLineage: ownership.lineage,
      writerSessionId: ownership.active_writer_session_id,
      writerEpoch: ownership.writer_epoch,
    }
  } finally {
    db.close()
  }
}

async function pageSnapshot(page: Page): Promise<PageSnapshot> {
  return page.evaluate(() => {
    const smoke = window.__RISU_FASTIFY_BROWSER_SMOKE__!
    const session = smoke.getClientSessionSnapshot()
    const coordinator = smoke.getStartupCoordinatorSnapshot()
    const composer = document.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')
    const markedWindow = window as typeof window & { __mobileRecoveryComposer?: Element }
    return {
      url: location.href,
      timeOrigin: performance.timeOrigin,
      lifecycle: session.lifecycle,
      connection: session.connection,
      sessionId: session.sessionId,
      databaseLineage: session.databaseLineage,
      writerSessionId: session.writer?.sessionId ?? null,
      writerEpoch: session.writer?.epoch ?? null,
      appliedRevision: smoke.getAppliedServerResourceRevision(),
      canMutate: coordinator.capabilities.canMutate,
      canGenerate: coordinator.capabilities.canGenerate,
      readerLayout: Boolean(document.querySelector('[data-risu-workspace][data-reader-layout]')),
      composerPresent: composer !== null,
      sameComposer: composer !== null && markedWindow.__mobileRecoveryComposer === composer,
      composerInert: composer !== null && composer.closest('[inert]') !== null,
      composerValue: composer?.value ?? null,
      recoveryStatus: document.querySelector('[data-writer-connection-recovery]')?.textContent?.trim() ?? null,
    }
  })
}

async function waitForWriter(page: Page): Promise<void> {
  await expect(page.getByTestId('default-chat-composer')).toBeEditable({ timeout: 30_000 })
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const session = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot()
          return `${session.lifecycle}/${session.connection}/${session.projectionReady}`
        }),
      { timeout: 30_000 },
    )
    .toBe('writing/live/true')
}

async function waitForRecoveringWriter(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot().lifecycle), {
      timeout: 30_000,
    })
    .toBe('recovering-writer')
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
}

async function waitForAppliedRevision(page: Page, revision: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision()), {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(revision)
}

async function runRecoveryJourney(browser: Browser, faultMode: FaultMode, testInfo: TestInfo): Promise<void> {
  test.setTimeout(120_000)
  const harness = await startFastBootstrapHarness(smallFastBootstrapFixture(), {
    temporaryDirectoryPrefix: `risu-mobile-writer-${faultMode}-`,
  })
  const context = await browser.newContext({ ...devices['Pixel 7'] })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  const pageErrors: string[] = []
  const recoveryRequests: ApiRequestRecord[] = []
  const documentRequests: string[] = []
  const eventResponses: EventResponseRecord[] = []
  const evidence: Record<string, unknown> = { faultMode, pageErrors, recoveryRequests, documentRequests }
  const onServerRequest = (request: IncomingMessage, response: ServerResponse) => {
    if (new URL(request.url ?? '/', harness.baseUrl).pathname !== '/api/v1/events') return
    if (!request.headers['risu-writer-session']) return
    eventResponses.push({ request, response })
  }
  harness.app.server.on('request', onServerRequest)
  page.on('pageerror', (error) => pageErrors.push(error.message))

  let recoveryTrafficStarted = false
  page.on('request', (request) => {
    if (!recoveryTrafficStarted) return
    if (request.resourceType() === 'document') documentRequests.push(request.url())
    recordApiRequest(request, recoveryRequests)
  })
  let releaseRecovery: (() => void) | undefined

  try {
    await page.goto(`${harness.baseUrl}${CHAT_PATH}`)
    await waitForWriter(page)
    await page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await page.getByTestId('default-chat-composer').fill(DRAFT)
    await page.evaluate(() => {
      const composer = document.querySelector('[data-testid="default-chat-composer"]')
      if (!composer) throw new Error('Writer composer was not mounted before the recovery journey')
      ;(window as typeof window & { __mobileRecoveryComposer?: Element }).__mobileRecoveryComposer = composer
    })

    const before = await pageSnapshot(page)
    const durableBefore = durableSnapshot(harness.dataDir)
    evidence.before = before
    evidence.durableBefore = durableBefore
    recoveryTrafficStarted = true

    if (faultMode === 'event-stream-close') {
      await expect.poll(() => eventResponses.filter(({ response }) => !response.destroyed).length).toBeGreaterThan(0)
      const bootstrapReleased = deferred<void>()
      let holdNextBootstrap = true
      let recoveryBootstrapStarted = false
      releaseRecovery = () => bootstrapReleased.resolve()
      await page.route('**/api/v1/bootstrap', async (route) => {
        if (holdNextBootstrap) {
          holdNextBootstrap = false
          recoveryBootstrapStarted = true
          await bootstrapReleased.promise
        }
        await route.continue()
      })
      const activeEventResponse = eventResponses.filter(({ response }) => !response.destroyed).at(-1)
      if (!activeEventResponse) throw new Error('Active writer event response disappeared before interruption')
      activeEventResponse.response.destroy()
      await expect.poll(() => recoveryBootstrapStarted, { timeout: 30_000 }).toBe(true)
    } else {
      await context.setOffline(true)
    }

    await waitForRecoveringWriter(page)
    const interrupted = await pageSnapshot(page)
    evidence.interrupted = interrupted

    if (faultMode === 'event-stream-close') releaseRecovery?.()
    else await context.setOffline(false)

    await waitForWriter(page)
    if (faultMode === 'event-stream-close') await page.unrouteAll({ behavior: 'wait' })
    const recovered = await pageSnapshot(page)
    const durableRecovered = durableSnapshot(harness.dataDir)
    const recoveryTrafficEnd = recoveryRequests.length
    evidence.recovered = recovered
    evidence.durableRecovered = durableRecovered
    evidence.recoveryTrafficEnd = recoveryTrafficEnd
    evidence.eventStreamConnections = eventResponses.length

    const postRecoveryMutation = await page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.patchRuntimeSettings({ streamGeminiThoughts: true }),
    )
    evidence.postRecoveryMutation = postRecoveryMutation
    expect(postRecoveryMutation).toMatchObject({ status: 'ok', revision: expect.any(Number) })
    if (postRecoveryMutation.status === 'ok') await waitForAppliedRevision(page, postRecoveryMutation.revision)

    const refreshRequests = recoveryRequests.slice(0, recoveryTrafficEnd).filter(isProjectionHydrationRequest)
    evidence.refreshRequests = refreshRequests

    // Safety authority is revoked while transport health is unknown, but the
    // already coherent writer surface and its local draft stay mounted.
    expect(interrupted).toMatchObject({
      lifecycle: 'recovering-writer',
      canMutate: false,
      canGenerate: false,
      readerLayout: false,
      composerPresent: true,
      sameComposer: true,
      composerInert: true,
      composerValue: DRAFT,
    })
    expect(['interrupted', 'connecting']).toContain(interrupted.connection)
    expect(interrupted.recoveryStatus).toBe(
      interrupted.connection === 'interrupted'
        ? 'Connection interrupted. Showing the last received content.'
        : 'Connecting to updates…',
    )

    // With no intervening commit or writer change, reconnect only revalidates
    // ownership and restarts the event stream; it must not rehydrate projection resources.
    expect(refreshRequests).toEqual([])
    expect(recovered).toMatchObject({
      url: before.url,
      timeOrigin: before.timeOrigin,
      lifecycle: 'writing',
      connection: 'live',
      sessionId: before.sessionId,
      databaseLineage: before.databaseLineage,
      writerSessionId: before.writerSessionId,
      writerEpoch: before.writerEpoch,
      appliedRevision: before.appliedRevision,
      canMutate: true,
      canGenerate: true,
      readerLayout: false,
      composerPresent: true,
      sameComposer: true,
      composerInert: false,
      composerValue: DRAFT,
      recoveryStatus: null,
    })
    expect(durableRecovered).toEqual(durableBefore)
    expect(documentRequests).toEqual([])
    expect(eventResponses.length).toBeGreaterThanOrEqual(2)
    expect(pageErrors).toEqual([])
  } finally {
    releaseRecovery?.()
    if (faultMode === 'offline') await context.setOffline(false).catch(() => undefined)
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined)
    await testInfo.attach(`mobile-writer-${faultMode}`, {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    })
    harness.app.server.off('request', onServerRequest)
    await context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
}

test('mobile writer reconnects in place after its event stream closes', async ({ browser }, testInfo) => {
  await runRecoveryJourney(browser, 'event-stream-close', testInfo)
})

test('mobile writer reconnects in place after a temporary offline period', async ({ browser }, testInfo) => {
  await runRecoveryJourney(browser, 'offline', testInfo)
})
