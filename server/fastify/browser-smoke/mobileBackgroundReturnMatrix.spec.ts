import { devices, expect, test, type BrowserContext, type CDPSession, type Page, type TestInfo } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import net from 'node:net'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
  type FastBootstrapHarness,
} from './fastBootstrapHarness.js'

/**
 * Single-device Android Chrome return-from-background matrix.
 *
 * Every case starts an established mobile writer, suspends it the way the OS
 * or the radio would, returns it, and requires a bounded return to
 * `writing/live` with the same DOM and draft. The recovery reason journal
 * recorded by `src/ts/server/recoveryDiagnostics.ts` is asserted by content
 * ("contains"), never by exact order, and read back through the same
 * authenticated `GET /api/v1/diagnostics?version=2` a desktop panel would use.
 *
 * Suspension is emulated with Chromium's frozen lifecycle state (hidden +
 * frozen, no timers), a TCP proxy that can kill or stall only the browser side
 * of a socket so the server keeps believing the writer is connected, and the
 * fake clock for a timer jump. None of this claims to emulate process eviction;
 * the reload cases cover that shape separately.
 */

const CHAT_PATH = '/character/fast-bootstrap-small-character/fast-bootstrap-small-chat'
const DRAFT = 'retained background-return draft'
const RECOVERY_BOUND_MS = 30_000
const BUTTON_DISABLED_BOUND_MS = 5_000
/** Outlasts the preference read's inline retries (about 3.5 s) with margin. */
const PREFERENCE_OUTAGE_MS = 6_000

type Mode =
  | 'frozen-socket-drop'
  | 'frozen-silent-stall'
  | 'hidden-clock-jump'
  | 'offline-at-resume'
  | 'stale-online-flag'
  | 'repeat-cycles'
  | 'reload-session-restored'
  | 'reload-fresh-session'
  | 'reload-preference-read-fails'
  | 'reload-preference-read-outage'

interface Sample {
  at: number
  lifecycle: string
  connection: string
  readerLayout: boolean
  buttonPresent: boolean
  buttonDisabled: boolean
  composerEditable: boolean
}

interface RecoveryEntry {
  timestamp?: number
  event?: string
  reason?: string
  outcome?: string
  lifecycle?: string
  connection?: string
  visible?: boolean
  online?: boolean
  lease?: string
  attemptCount?: number
  delayMs?: number
  durationMs?: number
  suspensionEvidence?: boolean
  exclusive?: boolean
}

declare global {
  interface Window {
    __risuReturnSamples?: Sample[]
    __risuReturnComposer?: Element
  }
}

/* ---------------------------------------------------------------- TCP proxy */

interface ProxyPair {
  client: net.Socket
  upstream: net.Socket
  requestLine: string
  detached: boolean
  stalled: boolean
}

interface TcpProxy {
  baseUrl: string
  /** Destroy only the browser side of matching sockets; the server side stays open and keeps accepting bytes. */
  dropClientSide(match?: RegExp): number
  /** Stop forwarding bytes on matching sockets in both directions without closing either side. */
  stall(match?: RegExp): number
  close(): Promise<void>
}

const EVENT_STREAM_REQUEST = /^GET \/api\/v1\/events/u
const HTTP_REQUEST_LINE = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \//u

async function startTcpProxy(targetPort: number): Promise<TcpProxy> {
  const pairs = new Set<ProxyPair>()
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort })
    const pair: ProxyPair = { client, upstream, requestLine: '', detached: false, stalled: false }
    pairs.add(pair)
    client.on('data', (chunk: Buffer) => {
      // Keep-alive sockets carry many requests; remember the latest request
      // line so the socket currently holding the event stream is selectable.
      const line = chunk.toString('latin1').split('\r\n')[0] ?? ''
      if (HTTP_REQUEST_LINE.test(line)) pair.requestLine = line
      if (!pair.detached && !pair.stalled) upstream.write(chunk)
    })
    upstream.on('data', (chunk: Buffer) => {
      // A detached pair keeps consuming server bytes so the server never sees
      // back-pressure or a close; that is the half-open radio-sleep shape.
      if (!pair.detached && !pair.stalled) client.write(chunk)
    })
    client.on('end', () => {
      if (!pair.detached) upstream.end()
    })
    upstream.on('end', () => {
      if (!pair.detached) client.end()
    })
    client.on('close', () => {
      if (!pair.detached) upstream.destroy()
      if (!pair.detached) pairs.delete(pair)
    })
    upstream.on('close', () => {
      if (!pair.detached) client.destroy()
      pairs.delete(pair)
    })
    client.on('error', () => undefined)
    upstream.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TCP proxy did not bind to a port')
  const select = (match: RegExp) => [...pairs].filter((pair) => match.test(pair.requestLine) && !pair.detached)
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dropClientSide(match = EVENT_STREAM_REQUEST) {
      const selected = select(match)
      for (const pair of selected) {
        pair.detached = true
        pair.client.destroy()
      }
      return selected.length
    },
    stall(match = EVENT_STREAM_REQUEST) {
      const selected = select(match)
      for (const pair of selected) pair.stalled = true
      return selected.length
    },
    async close() {
      for (const pair of pairs) {
        pair.client.destroy()
        pair.upstream.destroy()
      }
      pairs.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/* ------------------------------------------------------------- page helpers */

/** The smoke hook is installed by app startup; before that (and during a reload) the page is still booting. */
async function sessionState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const smoke = window.__RISU_FASTIFY_BROWSER_SMOKE__
    if (!smoke) return 'booting'
    const session = smoke.getClientSessionSnapshot()
    return `${session.lifecycle}/${session.connection}/${session.projectionReady}`
  })
}

async function waitForWriter(page: Page, timeout = RECOVERY_BOUND_MS): Promise<void> {
  await expect.poll(() => sessionState(page), { timeout }).toBe('writing/live/true')
  await expect(page.getByTestId('default-chat-composer')).toBeEditable({ timeout })
}

async function waitForSession(page: Page, lifecycle: string, connection: string, timeout = RECOVERY_BOUND_MS) {
  await expect
    .poll(async () => (await sessionState(page)).split('/').slice(0, 2).join('/'), { timeout })
    .toBe(`${lifecycle}/${connection}`)
}

async function installStateSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__risuReturnSamples = []
    const sample = () => {
      const session = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot()
      const button = document.querySelector<HTMLButtonElement>('[data-reader-use-this-device]')
      const composer = document.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')
      window.__risuReturnSamples!.push({
        at: Date.now(),
        lifecycle: session.lifecycle,
        connection: session.connection,
        readerLayout: Boolean(document.querySelector('[data-risu-workspace][data-reader-layout]')),
        buttonPresent: button !== null,
        buttonDisabled: button?.disabled === true,
        composerEditable: composer !== null && !composer.disabled && composer.closest('[inert]') === null,
      })
    }
    sample()
    setInterval(sample, 250)
  })
}

async function readSamples(page: Page): Promise<Sample[]> {
  return page.evaluate(() => window.__risuReturnSamples ?? [])
}

function longestDisabledButtonMs(samples: Sample[]): number {
  let longest = 0
  let runStart: number | null = null
  for (const sample of samples) {
    if (sample.buttonPresent && sample.buttonDisabled) {
      runStart ??= sample.at
      longest = Math.max(longest, sample.at - runStart)
    } else runStart = null
  }
  return longest
}

async function readRecoveryEntries(page: Page): Promise<RecoveryEntry[]> {
  const entries = (await page.evaluate(() =>
    window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientDiagnostics(),
  )) as RecoveryEntry[]
  return entries.filter((entry) => entry.event === 'recovery')
}

function reasons(entries: RecoveryEntry[]): string[] {
  return entries.map((entry) => entry.reason ?? '')
}

/** The read a desktop Settings → Advanced → Diagnostics panel or an operator curl performs. */
async function readUploadedRecoveryEntries(page: Page): Promise<RecoveryEntry[]> {
  return page.evaluate(async () => {
    const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
    const response = await fetch('/api/v1/diagnostics?version=2&limit=200', {
      cache: 'no-store',
      headers: { 'risu-auth': headers['risu-auth'] },
    })
    if (!response.ok) return []
    const body = (await response.json()) as {
      entries?: Array<{ provenance?: { kind?: string }; entry?: Record<string, unknown> }>
    }
    return (body.entries ?? [])
      .filter((record) => record.provenance?.kind === 'browser' && record.entry?.stage === 'recovery')
      .map((record) => record.entry as RecoveryEntry)
  })
}

async function markComposer(page: Page): Promise<void> {
  await page.getByTestId('default-chat-composer').fill(DRAFT)
  await page.evaluate(() => {
    const composer = document.querySelector('[data-testid="default-chat-composer"]')
    if (!composer) throw new Error('Writer composer was not mounted before the journey')
    window.__risuReturnComposer = composer
  })
}

async function recoveredSnapshot(page: Page) {
  return page.evaluate(() => {
    const session = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot()
    const composer = document.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')
    return {
      lifecycle: session.lifecycle,
      connection: session.connection,
      readerLayout: Boolean(document.querySelector('[data-risu-workspace][data-reader-layout]')),
      composerPresent: composer !== null,
      sameComposer: composer !== null && window.__risuReturnComposer === composer,
      composerValue: composer?.value ?? null,
      recoveryBanner: document.querySelector('[data-writer-connection-recovery]')?.textContent?.trim() ?? null,
    }
  })
}

async function setVisibilityOverride(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((next) => {
    if (next === 'visible') {
      // Drop the own-property override so the real getter answers again.
      delete (document as { visibilityState?: unknown }).visibilityState
    } else {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next })
    }
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

/**
 * Android backgrounding fires `visibilitychange` (hidden) before the process
 * is frozen, and `visibilitychange` (visible) after it resumes. Chromium's
 * frozen lifecycle state alone stops JS and timers without touching
 * visibility, so both are applied.
 */
async function suspendPage(page: Page, cdp: CDPSession): Promise<void> {
  await setVisibilityOverride(page, 'hidden')
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' })
}

async function returnPage(page: Page, cdp: CDPSession): Promise<void> {
  await cdp.send('Page.setWebLifecycleState', { state: 'active' })
  await setVisibilityOverride(page, 'visible')
}

/* ------------------------------------------------------------------ journey */

interface Journey {
  harness: FastBootstrapHarness
  proxy: TcpProxy
  context: BrowserContext
  page: Page
  cdp: CDPSession
  pageErrors: string[]
  evidence: Record<string, unknown>
}

async function openMobileWriter(
  browser: Parameters<Parameters<typeof test>[2]>[0]['browser'],
  mode: Mode,
  options: { fakeClock?: boolean } = {},
): Promise<Journey> {
  // Production defaults acquisition of a disconnected writer to on; the shared
  // fixture opts out for multi-client journeys, so opt back in here.
  const harness = await startFastBootstrapHarness(
    { ...smallFastBootstrapFixture(), autoAcquireDisconnectedWriter: true },
    { temporaryDirectoryPrefix: `risu-mobile-return-${mode}-`, diagnostics: true },
  )
  const proxy = await startTcpProxy(Number(new URL(harness.baseUrl).port))
  const context = await browser.newContext({ ...devices['Pixel 7'] })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  if (options.fakeClock) await page.clock.install()
  await page.goto(`${proxy.baseUrl}${CHAT_PATH}`)
  await waitForWriter(page)
  await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000))
  await markComposer(page)
  await installStateSampler(page)
  const cdp = await context.newCDPSession(page)
  return { harness, proxy, context, page, cdp, pageErrors, evidence: { mode } }
}

async function closeJourney(journey: Journey, testInfo: TestInfo, name: string): Promise<void> {
  const body = JSON.stringify(journey.evidence, null, 2)
  writeFileSync(testInfo.outputPath(`${name}.json`), body)
  await testInfo.attach(name, { body, contentType: 'application/json' })
  await journey.context.close().catch(() => undefined)
  await journey.proxy.close().catch(() => undefined)
  await closeFastBootstrapHarness(journey.harness)
}

async function expectRecoveredWriter(journey: Journey, options: { returnedAt: number }): Promise<void> {
  const { page, evidence, pageErrors } = journey
  await waitForWriter(page)
  // Let the 250 ms sampler observe the settled state at least once.
  await page.waitForTimeout(400)
  const recovered = await recoveredSnapshot(page)
  const samples = await readSamples(page)
  const entries = await readRecoveryEntries(page)
  const recoveredAt = samples.find(
    (sample) => sample.at >= options.returnedAt && sample.lifecycle === 'writing' && sample.connection === 'live',
  )?.at
  evidence.recovered = recovered
  evidence.recoveryMs = recoveredAt === undefined ? null : recoveredAt - options.returnedAt
  evidence.longestDisabledButtonMs = longestDisabledButtonMs(samples)
  evidence.reasons = reasons(entries)
  expect(recovered).toMatchObject({
    lifecycle: 'writing',
    connection: 'live',
    readerLayout: false,
    composerPresent: true,
    sameComposer: true,
    composerValue: DRAFT,
    recoveryBanner: null,
  })
  expect(longestDisabledButtonMs(samples)).toBeLessThanOrEqual(BUTTON_DISABLED_BOUND_MS)
  expect(pageErrors).toEqual([])
}

/* -------------------------------------------------------------------- tests */

test('frozen page whose socket died silently reconnects in place', async ({ browser }, testInfo) => {
  test.setTimeout(120_000)
  const journey = await openMobileWriter(browser, 'frozen-socket-drop')
  const { page, proxy, cdp, evidence } = journey
  try {
    await suspendPage(page, cdp)
    // The OS suspended the process and the radio dropped the connection; the
    // server still counts this writer as connected.
    expect(proxy.dropClientSide()).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const returnedAt = Date.now()
    await returnPage(page, cdp)
    await expectRecoveredWriter(journey, { returnedAt })
    const entries = await readRecoveryEntries(page)
    expect(reasons(entries)).toEqual(expect.arrayContaining(['page-hidden', 'page-visible', 'stream-connected']))
    expect(entries.some((entry) => entry.reason === 'page-visible' && entry.suspensionEvidence === true)).toBe(true)
    // The server-side read a desktop panel performs sees the phone's reasons.
    await expect
      .poll(async () => (await readUploadedRecoveryEntries(page)).map((entry) => entry.reason), { timeout: 20_000 })
      .toEqual(expect.arrayContaining(['page-visible', 'stream-connected']))
    evidence.uploaded = (await readUploadedRecoveryEntries(page)).length
  } finally {
    await closeJourney(journey, testInfo, 'frozen-socket-drop')
  }
})

test('frozen page whose stream went silent recovers through the heartbeat watchdog', async ({ browser }, testInfo) => {
  test.setTimeout(180_000)
  const journey = await openMobileWriter(browser, 'frozen-silent-stall')
  const { page, proxy, cdp, evidence } = journey
  try {
    await suspendPage(page, cdp)
    // Both sides stay open; no bytes flow. Only the 60 s watchdog can notice.
    expect(proxy.stall()).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const returnedAt = Date.now()
    await returnPage(page, cdp)
    await expect
      .poll(async () => reasons(await readRecoveryEntries(page)), { timeout: 90_000 })
      .toContain('stream-watchdog')
    await waitForWriter(page, 60_000)
    await page.waitForTimeout(400)
    const samples = await readSamples(page)
    const recovered = await recoveredSnapshot(page)
    const entries = await readRecoveryEntries(page)
    const watchdog = entries.find((entry) => entry.reason === 'stream-watchdog')
    const watchdogAt = watchdog?.timestamp ?? returnedAt
    evidence.recovered = recovered
    evidence.watchdogAfterReturnMs = watchdogAt - returnedAt
    evidence.recoveryAfterWatchdogMs =
      (samples.find((s) => s.at >= watchdogAt && s.lifecycle === 'writing' && s.connection === 'live')?.at ?? 0) -
      watchdogAt
    evidence.longestDisabledButtonMs = longestDisabledButtonMs(samples)
    evidence.reasons = reasons(entries)
    expect(recovered).toMatchObject({
      lifecycle: 'writing',
      connection: 'live',
      composerValue: DRAFT,
      sameComposer: true,
    })
    expect(longestDisabledButtonMs(samples)).toBeLessThanOrEqual(BUTTON_DISABLED_BOUND_MS)
    expect(watchdog?.durationMs).toBeGreaterThanOrEqual(60_000)
    expect(reasons(entries)).toEqual(expect.arrayContaining(['probe-started', 'stream-watchdog', 'stream-connected']))
    expect(journey.pageErrors).toEqual([])
  } finally {
    await closeJourney(journey, testInfo, 'frozen-silent-stall')
  }
})

test('hidden page whose timers jump past the watchdog recovers when shown', async ({ browser }, testInfo) => {
  test.setTimeout(120_000)
  const journey = await openMobileWriter(browser, 'hidden-clock-jump', { fakeClock: true })
  const { page, evidence } = journey
  try {
    await setVisibilityOverride(page, 'hidden')
    // Throttled timers fire late and all at once: the watchdog is already due
    // when the page becomes visible, so it races the foreground probe.
    await page.clock.fastForward(61_000)
    const returnedAt = await page.evaluate(() => Date.now())
    await setVisibilityOverride(page, 'visible')
    await expectRecoveredWriter(journey, { returnedAt })
    const entries = await readRecoveryEntries(page)
    expect(reasons(entries)).toEqual(expect.arrayContaining(['page-hidden', 'page-visible', 'stream-connected']))
    evidence.watchdogFired = reasons(entries).includes('stream-watchdog')
  } finally {
    await closeJourney(journey, testInfo, 'hidden-clock-jump')
  }
})

test('page shown while still offline waits, then recovers once online', async ({ browser }, testInfo) => {
  test.setTimeout(120_000)
  const journey = await openMobileWriter(browser, 'offline-at-resume')
  const { page, context, cdp, evidence } = journey
  try {
    await context.setOffline(true)
    evidence.onLineWhileOffline = await page.evaluate(() => navigator.onLine)
    await suspendPage(page, cdp)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    await returnPage(page, cdp)
    await waitForSession(page, 'recovering-writer', 'interrupted')
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const suspendedEntries = await readRecoveryEntries(page)
    evidence.offlineReasons = reasons(suspendedEntries)
    evidence.offlineEntries = suspendedEntries.slice(-12)
    expect(
      suspendedEntries.some(
        (entry) => ['foreground-suspended', 'resume-suspended'].includes(entry.reason ?? '') && entry.online === false,
      ),
    ).toBe(true)
    const returnedAt = Date.now()
    await context.setOffline(false)
    await expectRecoveredWriter(journey, { returnedAt })
    expect(reasons(await readRecoveryEntries(page))).toEqual(
      expect.arrayContaining(['browser-online', 'stream-connected']),
    )
  } finally {
    await closeJourney(journey, testInfo, 'offline-at-resume')
  }
})

test('page shown with a stale offline flag but a working network still recovers', async ({ browser }, testInfo) => {
  test.setTimeout(120_000)
  // Android can report `navigator.onLine === false` on a connected network and
  // never fire `online`. Recovery must not wait for that event: a visible page
  // gated only by the flag probes the server, and one answer retires the flag.
  const journey = await openMobileWriter(browser, 'stale-online-flag')
  const { page, proxy, cdp, evidence } = journey
  try {
    // Nothing here blocks traffic; only the flag lies.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    })
    await suspendPage(page, cdp)
    expect(proxy.dropClientSide()).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const returnedAt = Date.now()
    await returnPage(page, cdp)
    await expectRecoveredWriter(journey, { returnedAt })
    const entries = await readRecoveryEntries(page)
    evidence.entries = entries.slice(-20)
    const suspended = entries.findIndex((entry) => entry.reason === 'foreground-suspended' && entry.online === false)
    const probed = entries.findIndex(
      (entry) => entry.reason === 'network-probe' && entry.outcome === 'ok' && entry.online === false,
    )
    const connected = entries.findIndex((entry, index) => index > probed && entry.reason === 'stream-connected')
    expect(suspended, 'the flag suspended the foreground dispatch first').toBeGreaterThanOrEqual(0)
    expect(probed, 'a probe answered while the flag still said offline').toBeGreaterThan(suspended)
    expect(connected, 'the writer stream reconnected after the probe').toBeGreaterThan(probed)
    expect(await page.evaluate(() => navigator.onLine)).toBe(false)
    // A server on this branch accepts the new reason and the phone's upload
    // shows the probe answer to a desktop panel or an operator read. The v2
    // browser family spells a recorded `ok` outcome as `ready`.
    await expect
      .poll(
        async () =>
          (await readUploadedRecoveryEntries(page)).some(
            (entry) => entry.reason === 'network-probe' && entry.outcome === 'ready' && entry.online === false,
          ),
        { timeout: 20_000 },
      )
      .toBe(true)
  } finally {
    await closeJourney(journey, testInfo, 'stale-online-flag')
  }
})

test('repeated background cycles recover within a bound every time', async ({ browser }, testInfo) => {
  test.setTimeout(180_000)
  const journey = await openMobileWriter(browser, 'repeat-cycles')
  const { page, proxy, cdp, evidence } = journey
  const cycles: Array<{ recoveryMs: number | null; scheduledDelaysMs: number[] }> = []
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const before = (await readRecoveryEntries(page)).length
      await suspendPage(page, cdp)
      expect(proxy.dropClientSide()).toBeGreaterThan(0)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      const returnedAt = Date.now()
      await returnPage(page, cdp)
      await waitForWriter(page)
      await page.waitForTimeout(400)
      const samples = await readSamples(page)
      const recoveredAt = samples.find(
        (s) => s.at >= returnedAt && s.lifecycle === 'writing' && s.connection === 'live',
      )?.at
      const entries = (await readRecoveryEntries(page)).slice(before)
      cycles.push({
        recoveryMs: recoveredAt === undefined ? null : recoveredAt - returnedAt,
        scheduledDelaysMs: entries
          .filter((entry) => entry.reason === 'resume-scheduled')
          .map((entry) => entry.delayMs ?? 0),
      })
    }
    evidence.cycles = cycles
    const samples = await readSamples(page)
    evidence.longestDisabledButtonMs = longestDisabledButtonMs(samples)
    for (const cycle of cycles) {
      expect(cycle.recoveryMs).not.toBeNull()
      expect(cycle.recoveryMs!).toBeLessThanOrEqual(20_000)
      // A successful resume resets the backoff counter; a later cycle must not
      // start from a longer delay than the first one did.
      for (const delay of cycle.scheduledDelaysMs) expect(delay).toBeLessThanOrEqual(1_300)
    }
    expect(longestDisabledButtonMs(samples)).toBeLessThanOrEqual(BUTTON_DISABLED_BOUND_MS)
    expect(await recoveredSnapshot(page)).toMatchObject({ composerValue: DRAFT, sameComposer: true })
    expect(journey.pageErrors).toEqual([])
  } finally {
    await closeJourney(journey, testInfo, 'repeat-cycles')
  }
})

/* --------------------------------------------------------- discard + reload */

async function reloadJourney(
  browser: Parameters<Parameters<typeof test>[2]>[0]['browser'],
  testInfo: TestInfo,
  mode:
    | 'reload-session-restored'
    | 'reload-fresh-session'
    | 'reload-preference-read-fails'
    | 'reload-preference-read-outage',
): Promise<void> {
  test.setTimeout(120_000)
  const journey = await openMobileWriter(browser, mode)
  const { page, evidence } = journey
  try {
    const before = await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot())
    if (mode !== 'reload-session-restored') {
      // Process eviction without session restore: the page returns with no
      // sessionStorage, so it is a new session facing its own disconnected writer.
      await page.evaluate(() => sessionStorage.clear())
    }
    let preferenceReads = 0
    let outageUntil = 0
    if (mode === 'reload-preference-read-fails' || mode === 'reload-preference-read-outage') {
      await page.route('**/api/v1/settings/sidebar', async (route) => {
        preferenceReads += 1
        const failed = mode === 'reload-preference-read-fails' ? preferenceReads === 1 : Date.now() < outageUntil
        if (failed) await route.abort('failed')
        else await route.continue()
      })
    }
    const returnedAt = Date.now()
    // Longer than the inline read retries, so startup must settle as a reader
    // and the deferred acquisition path has to finish the job.
    outageUntil = returnedAt + PREFERENCE_OUTAGE_MS
    await page.reload()
    let recovered = true
    try {
      await waitForWriter(page)
    } catch (error) {
      recovered = false
      evidence.failure = error instanceof Error ? error.message.split('\n')[0] : String(error)
    }
    const after = await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot())
    const entries = await readRecoveryEntries(page)
    evidence.before = { sessionId: before.sessionId, writer: before.writer }
    evidence.after = { lifecycle: after.lifecycle, connection: after.connection, sessionId: after.sessionId }
    evidence.reasons = reasons(entries)
    evidence.entries = entries.slice(-16)
    evidence.recoveryMs = Date.now() - returnedAt
    evidence.preferenceReads = preferenceReads
    const identity = entries.find((entry) => entry.reason === 'startup-identity')
    expect(identity).toMatchObject({ exclusive: true })
    const preference = entries.find((entry) => entry.reason === 'startup-auto-acquire-preference')
    if (mode === 'reload-session-restored') {
      expect(after.sessionId).toBe(before.sessionId)
      expect(preference).toBeUndefined()
    } else {
      expect(after.sessionId).not.toBe(before.sessionId)
      expect(preference).toBeDefined()
    }
    if (mode === 'reload-preference-read-fails') {
      // The first read was aborted; the inline retry answered and startup
      // acquired directly without ever settling as a reader.
      expect(preference).toMatchObject({ outcome: 'ok', attemptCount: 2 })
      expect(preferenceReads).toBeGreaterThanOrEqual(2)
      expect(reasons(entries)).not.toContain('startup-reader')
    }
    if (mode === 'reload-preference-read-outage') {
      // Every inline retry failed, so startup settled as a reader with
      // acquisition deferred, and the scheduled retry promoted it.
      expect(preference).toMatchObject({ outcome: 'failed' })
      const reader = reasons(entries).indexOf('startup-reader')
      const scheduled = reasons(entries).indexOf('promotion-retry-scheduled')
      const promoted = reasons(entries).lastIndexOf('promotion-completed')
      expect(reader, 'startup settled as a reader').toBeGreaterThanOrEqual(0)
      expect(scheduled, 'acquisition was rescheduled after the reader settled').toBeGreaterThan(reader)
      expect(promoted, 'the scheduled retry promoted the reader').toBeGreaterThan(scheduled)
    }
    if (!recovered) {
      throw new Error(`Reload did not recover a writer: ${JSON.stringify(reasons(entries))}`)
    }
    expect(after).toMatchObject({ lifecycle: 'writing', connection: 'live' })
    expect(journey.pageErrors).toEqual([])
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined)
    await closeJourney(journey, testInfo, mode)
  }
}

test('discarded tab restored with its session resumes as the same writer', async ({ browser }, testInfo) => {
  await reloadJourney(browser, testInfo, 'reload-session-restored')
})

test('discarded tab restored without its session acquires its own disconnected writer', async ({
  browser,
}, testInfo) => {
  await reloadJourney(browser, testInfo, 'reload-fresh-session')
})

test('discarded tab whose preference read fails once still acquires its own disconnected writer', async ({
  browser,
}, testInfo) => {
  // One failed `/api/v1/settings/sidebar` read is absorbed by the inline retry;
  // an unreadable preference never decides the role.
  await reloadJourney(browser, testInfo, 'reload-preference-read-fails')
})

test('discarded tab whose preference read stays down settles as a reader and then acquires by itself', async ({
  browser,
}, testInfo) => {
  // The outage outlasts the inline retries. Startup settles as a reader without
  // taking over, then keeps retrying acquisition with backoff until the read
  // answers, instead of waiting for a foreground return or a Use this device tap.
  await reloadJourney(browser, testInfo, 'reload-preference-read-outage')
})
