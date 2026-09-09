import { expect, test, type Browser, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { buildLargeCorpusFixture } from '../../../test/fixtures/largeCorpusFixture.js'
import type { StartupReadinessSnapshot } from '@risuai/protocol/startup-telemetry'
import { subscribeProtocolMetrics } from '../src/protocolMetrics.js'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
} from './fastBootstrapHarness.js'

interface ApiRequestRecord {
  method: string
  path: string
  startedAtEpochMs: number
}

interface SafeProtocolMetric {
  metric: string
  resource?: string
  revision?: number
  durationMs?: number
  payloadBytes?: number | null
  cacheHits?: number
  cacheMisses?: number
  requestUid?: string
}

interface SafeTraceSummary {
  method: string
  route?: string
  requestUid: string
  timing?: { process?: number; send?: number }
}

interface StartupWorkspaceProbeSnapshot {
  conversationShellMounts: number
  conversationShellRemovals: number
  readerWorkspaceMounts: number
  shellIdentityChanges: number
  sampledFrames: number
  missingOwnedFrames: number
  maximumHorizontalDelta: number
  layoutShifts: {
    count: number
    withoutRecentInput: number
    cumulativeValue: number
  }
  longTasks: {
    count: number
    totalDurationMs: number
    maximumDurationMs: number
  }
}

interface StartupMatrixCase {
  fixture: 'small' | 'large'
  cacheState: 'cold' | 'warm'
  startup: StartupReadinessSnapshot
  browserJavaScript: {
    fileCount: number
    transferBytes: number
    encodedBodyBytes: number
    decodedBodyBytes: number
  }
  server: {
    bootstrapPayloadBytes: number
    resourcePayloadBytes: number
    resourceDurationMs: number
    cacheHits: number
    cacheMisses: number
    resources: SafeProtocolMetric[]
  }
  earlyRequests: {
    mutationsBeforeWriterReady: number
    generationsBeforeChatReady: number
  }
  workspace: StartupWorkspaceProbeSnapshot
  requestUids: string[]
  traces: SafeTraceSummary[]
}

interface StartupMatrixArtifact {
  schemaVersion: 1
  cases: StartupMatrixCase[]
}

const previousProtocolMetrics = process.env.RISU_PROTOCOL_METRICS
const outputDir = path.resolve('fast-bootstrap-results')

test.setTimeout(180_000)

test.afterAll(() => {
  if (previousProtocolMetrics === undefined) delete process.env.RISU_PROTOCOL_METRICS
  else process.env.RISU_PROTOCOL_METRICS = previousProtocolMetrics
})

test('startup matrix keeps cold and warm small/large populations separate', async ({ browser }, testInfo) => {
  process.env.RISU_PROTOCOL_METRICS = '1'
  const cases = [
    ...(await runFixturePair(browser, 'small', smallFastBootstrapFixture())),
    ...(await runFixturePair(browser, 'large', buildLargeCorpusFixture().database)),
  ]

  const artifact: StartupMatrixArtifact = { schemaVersion: 1, cases }
  const machineOutput = `${JSON.stringify(artifact, null, 2)}\n`
  const humanOutput = formatMatrixArtifact(artifact)
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, 'startup-matrix.json'), machineOutput)
  fs.writeFileSync(path.join(outputDir, 'startup-matrix.txt'), humanOutput)
  await testInfo.attach('startup-matrix.json', { body: machineOutput, contentType: 'application/json' })
  await testInfo.attach('startup-matrix.txt', { body: humanOutput, contentType: 'text/plain' })

  expect(cases.map(({ fixture, cacheState }) => `${fixture}:${cacheState}`).sort()).toEqual([
    'large:cold',
    'large:warm',
    'small:cold',
    'small:warm',
  ])

  for (const fixture of ['small', 'large'] as const) {
    const cold = cases.find((entry) => entry.fixture === fixture && entry.cacheState === 'cold')!
    const warm = cases.find((entry) => entry.fixture === fixture && entry.cacheState === 'warm')!
    expect(cold.server.cacheHits).toBe(0)
    expect(cold.server.cacheMisses).toBeGreaterThan(0)
    expect(warm.server.cacheHits).toBeGreaterThan(0)
    expect(warm.server.cacheMisses).toBe(0)
    expect(warm.server.resourcePayloadBytes).toBeLessThan(cold.server.resourcePayloadBytes)
  }
  const smallCold = cases.find((entry) => entry.fixture === 'small' && entry.cacheState === 'cold')!
  const largeCold = cases.find((entry) => entry.fixture === 'large' && entry.cacheState === 'cold')!
  expect(largeCold.server.resourcePayloadBytes).toBeGreaterThan(smallCold.server.resourcePayloadBytes)
  expect(largeCold.server.cacheMisses).toBeGreaterThan(smallCold.server.cacheMisses)
  for (const entry of cases) {
    expect(entry.startup.phase).toBe('background-ready')
    expect(entry.earlyRequests).toEqual({
      mutationsBeforeWriterReady: 0,
      generationsBeforeChatReady: 0,
    })
    expect(entry.server.resources.filter((resource) => resource.resource === 'shell')).toHaveLength(1)
    expect(entry.workspace.conversationShellMounts).toBe(1)
    expect(entry.workspace.conversationShellRemovals).toBe(0)
    expect(entry.workspace.readerWorkspaceMounts).toBe(0)
    expect(entry.workspace.shellIdentityChanges).toBe(0)
  }
})

async function runFixturePair(
  browser: Browser,
  fixture: StartupMatrixCase['fixture'],
  database: Record<string, unknown>,
): Promise<StartupMatrixCase[]> {
  const harness = await startFastBootstrapHarness(database)
  const metrics: SafeProtocolMetric[] = []
  const unsubscribeMetrics = subscribeProtocolMetrics((metric) => metrics.push(safeProtocolMetric(metric)))
  let context: Awaited<ReturnType<Browser['newContext']>> | undefined

  try {
    metrics.length = 0

    context = await browser.newContext()
    const page = await context.newPage()
    await installStartupWorkspaceProbe(page)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.clearBrowserCache')
    await cdp.detach()

    const requests: ApiRequestRecord[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (!url.pathname.startsWith('/api/v1/')) return
      requests.push({ method: request.method(), path: url.pathname, startedAtEpochMs: Date.now() })
    })

    const cold = await measureNavigation(page, fixture, 'cold', metrics, requests, () =>
      page.goto(harness.baseUrl, { waitUntil: 'domcontentloaded' }),
    )
    // Startup does not wait for the optional IndexedDB write lane. Establish
    // the warm-cache precondition after capturing cold metrics, without forcing
    // cache work or changing the measured readiness boundary.
    await expect
      .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getPendingResourceCacheWriteCount()), {
        message: `${fixture} cold cache writes must settle before the warm reload`,
      })
      .toBe(0)
    const warm = await measureNavigation(page, fixture, 'warm', metrics, requests, () =>
      page.reload({ waitUntil: 'domcontentloaded' }),
    )

    await context.close()
    context = undefined
    await harness.app.close()
    const traces = readSafeTraces(harness.dataDir)
    for (const entry of [cold, warm]) {
      const requestUids = new Set(entry.requestUids)
      entry.traces = traces.filter((trace) => requestUids.has(trace.requestUid))
    }
    return [cold, warm]
  } finally {
    unsubscribeMetrics()
    await context?.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
}

async function measureNavigation(
  page: Page,
  fixture: StartupMatrixCase['fixture'],
  cacheState: StartupMatrixCase['cacheState'],
  metrics: SafeProtocolMetric[],
  requests: ApiRequestRecord[],
  navigate: () => Promise<unknown>,
): Promise<StartupMatrixCase> {
  metrics.length = 0
  requests.length = 0
  await navigate()
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__)), { timeout: 20_000 })
    .toBe(true)
  try {
    await page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
  } catch (error) {
    const coordinator = await page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot(),
    )
    throw new Error(`Background readiness failed: ${JSON.stringify(coordinator)}`, { cause: error })
  }
  await expect.poll(() => metrics.some((metric) => metric.metric === 'bootstrap_projection')).toBe(true)
  await expect.poll(() => metrics.some((metric) => metric.metric === 'resource_response')).toBe(true)

  const browserSnapshot = await page.evaluate(() => {
    const startup = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupSnapshot()
    const workspace = (
      window as Window & {
        __RISU_STARTUP_WORKSPACE_PROBE__?: { snapshot: () => StartupWorkspaceProbeSnapshot }
      }
    ).__RISU_STARTUP_WORKSPACE_PROBE__!.snapshot()
    const javascriptEntries = performance
      .getEntriesByType('resource')
      .filter((entry) => new URL(entry.name).pathname.endsWith('.js')) as PerformanceResourceTiming[]
    return {
      startup,
      workspace,
      timeOrigin: performance.timeOrigin,
      browserJavaScript: {
        fileCount: javascriptEntries.length,
        transferBytes: javascriptEntries.reduce((total, entry) => total + entry.transferSize, 0),
        encodedBodyBytes: javascriptEntries.reduce((total, entry) => total + entry.encodedBodySize, 0),
        decodedBodyBytes: javascriptEntries.reduce((total, entry) => total + entry.decodedBodySize, 0),
      },
    }
  })

  const resourceMetrics = metrics.filter((metric) => metric.metric === 'resource_response')
  const bootstrapMetrics = metrics.filter((metric) => metric.metric === 'bootstrap_projection')
  const writerReadyAt = browserSnapshot.timeOrigin + (browserSnapshot.startup.timestamps['writer-ready'] ?? Infinity)
  const chatReadyAt = browserSnapshot.timeOrigin + (browserSnapshot.startup.timestamps['chat-ready'] ?? Infinity)
  const mutationsBeforeWriterReady = requests.filter(
    (request) =>
      request.method !== 'GET' &&
      request.path.startsWith('/api/v1/commands/') &&
      request.startedAtEpochMs < writerReadyAt,
  ).length
  const generationsBeforeChatReady = requests.filter(
    (request) =>
      request.method !== 'GET' &&
      (request.path.startsWith('/api/v1/generate/') || request.path.startsWith('/api/v1/generation-operations')) &&
      request.startedAtEpochMs < chatReadyAt,
  ).length

  return {
    fixture,
    cacheState,
    startup: browserSnapshot.startup,
    workspace: browserSnapshot.workspace,
    browserJavaScript: browserSnapshot.browserJavaScript,
    server: {
      bootstrapPayloadBytes: sumMetric(bootstrapMetrics, 'payloadBytes'),
      resourcePayloadBytes: sumMetric(resourceMetrics, 'payloadBytes'),
      resourceDurationMs: sumMetric(resourceMetrics, 'durationMs'),
      cacheHits: sumMetric(resourceMetrics, 'cacheHits'),
      cacheMisses: sumMetric(resourceMetrics, 'cacheMisses'),
      resources: resourceMetrics,
    },
    earlyRequests: { mutationsBeforeWriterReady, generationsBeforeChatReady },
    requestUids: [...new Set([...bootstrapMetrics, ...resourceMetrics].flatMap((metric) => metric.requestUid ?? []))],
    traces: [],
  }
}

async function installStartupWorkspaceProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: StartupWorkspaceProbeSnapshot & {
      snapshot: () => StartupWorkspaceProbeSnapshot
    } = {
      conversationShellMounts: 0,
      conversationShellRemovals: 0,
      readerWorkspaceMounts: 0,
      shellIdentityChanges: 0,
      sampledFrames: 0,
      missingOwnedFrames: 0,
      maximumHorizontalDelta: 0,
      layoutShifts: { count: 0, withoutRecentInput: 0, cumulativeValue: 0 },
      longTasks: { count: 0, totalDurationMs: 0, maximumDurationMs: 0 },
      snapshot() {
        return {
          conversationShellMounts: state.conversationShellMounts,
          conversationShellRemovals: state.conversationShellRemovals,
          readerWorkspaceMounts: state.readerWorkspaceMounts,
          shellIdentityChanges: state.shellIdentityChanges,
          sampledFrames: state.sampledFrames,
          missingOwnedFrames: state.missingOwnedFrames,
          maximumHorizontalDelta: state.maximumHorizontalDelta,
          layoutShifts: { ...state.layoutShifts },
          longTasks: { ...state.longTasks },
        }
      },
    }
    ;(
      window as Window & {
        __RISU_STARTUP_WORKSPACE_PROBE__?: typeof state
      }
    ).__RISU_STARTUP_WORKSPACE_PROBE__ = state

    const seenShells = new WeakSet<Element>()
    const seenReaders = new WeakSet<Element>()
    let hasMountedShell = false
    const visit = (root: Node, selector: string, seen: WeakSet<Element>, onFirstSeen: (element: Element) => void) => {
      if (!(root instanceof Element)) return
      if (root.matches(selector) && !seen.has(root)) {
        seen.add(root)
        onFirstSeen(root)
      }
      for (const element of root.querySelectorAll(selector)) {
        if (seen.has(element)) continue
        seen.add(element)
        onFirstSeen(element)
      }
    }
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          visit(node, '[data-risu-conversation-shell]', seenShells, () => {
            state.conversationShellMounts += 1
            if (hasMountedShell) state.shellIdentityChanges += 1
            hasMountedShell = true
          })
          visit(node, '[data-risu-workspace][data-reader-layout]', seenReaders, () => {
            state.readerWorkspaceMounts += 1
          })
        }
        for (const node of record.removedNodes) {
          visit(node, '[data-risu-conversation-shell]', new WeakSet(), () => {
            state.conversationShellRemovals += 1
          })
        }
      }
    })
    mutations.observe(document, { childList: true, subtree: true })

    let baseline: Record<string, { left: number; width: number }> | undefined
    const sample = () => {
      const selectors = {
        navigation: '[data-risu-shell-navigation]',
        main: '[data-risu-shell-main]',
      }
      const current = Object.fromEntries(
        Object.entries(selectors).map(([name, selector]) => {
          const rect = document.querySelector(selector)?.getBoundingClientRect()
          return [name, rect ? { left: rect.left, width: rect.width } : null]
        }),
      ) as Record<string, { left: number; width: number } | null>
      const complete = Object.values(current).every(Boolean)
      if (!baseline && complete) baseline = current as Record<string, { left: number; width: number }>
      if (baseline) {
        state.sampledFrames += 1
        if (!complete) state.missingOwnedFrames += 1
        else {
          for (const name of Object.keys(baseline)) {
            state.maximumHorizontalDelta = Math.max(
              state.maximumHorizontalDelta,
              Math.abs(current[name]!.left - baseline[name].left),
              Math.abs(current[name]!.width - baseline[name].width),
            )
          }
        }
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)

    type LayoutShiftEntry = PerformanceEntry & { value: number; hadRecentInput: boolean }
    if (PerformanceObserver.supportedEntryTypes.includes('layout-shift')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as LayoutShiftEntry[]) {
          state.layoutShifts.count += 1
          state.layoutShifts.cumulativeValue += entry.value
          if (!entry.hadRecentInput) state.layoutShifts.withoutRecentInput += 1
        }
      }).observe({ type: 'layout-shift', buffered: false })
    }
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.count += 1
          state.longTasks.totalDurationMs += entry.duration
          state.longTasks.maximumDurationMs = Math.max(state.longTasks.maximumDurationMs, entry.duration)
        }
      }).observe({ type: 'longtask', buffered: false })
    }
  })
}

function safeProtocolMetric(metric: Readonly<Record<string, unknown>>): SafeProtocolMetric {
  return {
    metric: String(metric.metric ?? 'unknown'),
    ...(typeof metric.resource === 'string' ? { resource: metric.resource } : {}),
    ...(typeof metric.revision === 'number' ? { revision: metric.revision } : {}),
    ...(typeof metric.durationMs === 'number' ? { durationMs: metric.durationMs } : {}),
    ...(typeof metric.payloadBytes === 'number' || metric.payloadBytes === null
      ? { payloadBytes: metric.payloadBytes }
      : {}),
    ...(typeof metric.cacheHits === 'number' ? { cacheHits: metric.cacheHits } : {}),
    ...(typeof metric.cacheMisses === 'number' ? { cacheMisses: metric.cacheMisses } : {}),
    ...(typeof metric.requestUid === 'string' ? { requestUid: metric.requestUid } : {}),
  }
}

function sumMetric(metrics: SafeProtocolMetric[], field: 'payloadBytes' | 'durationMs' | 'cacheHits' | 'cacheMisses') {
  return metrics.reduce((total, metric) => total + (typeof metric[field] === 'number' ? metric[field] : 0), 0)
}

function readSafeTraces(dataDir: string): SafeTraceSummary[] {
  const traceFile = path.join(dataDir, 'trace', 'agent.jsonl')
  if (!fs.existsSync(traceFile)) return []
  return fs
    .readFileSync(traceFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .flatMap((entry) => {
      const requestUid = entry['X-Request-UID']
      if (typeof requestUid !== 'string') return []
      return [
        {
          method: String(entry.Method ?? 'UNKNOWN'),
          ...(typeof entry.Route === 'string' ? { route: entry.Route } : {}),
          requestUid,
          ...(entry.Timing && typeof entry.Timing === 'object'
            ? { timing: entry.Timing as SafeTraceSummary['timing'] }
            : {}),
        },
      ]
    })
}

function formatMatrixArtifact(artifact: StartupMatrixArtifact): string {
  const lines = [
    'Phase 0 startup matrix',
    'fixture\tcache\tbackground_ms\tresource_bytes\tcache_hits\tcache_misses\tjs_transfer_bytes\tshell_mounts\tshell_identity_changes\tmissing_owned_frames\tmaximum_horizontal_delta\tlong_tasks',
  ]
  for (const entry of artifact.cases) {
    lines.push(
      [
        entry.fixture,
        entry.cacheState,
        formatNumber(entry.startup.durationsFromEntry['background-ready']),
        entry.server.resourcePayloadBytes,
        entry.server.cacheHits,
        entry.server.cacheMisses,
        entry.browserJavaScript.transferBytes,
        entry.workspace.conversationShellMounts,
        entry.workspace.shellIdentityChanges,
        entry.workspace.missingOwnedFrames,
        formatNumber(entry.workspace.maximumHorizontalDelta),
        entry.workspace.longTasks.count,
      ].join('\t'),
    )
  }
  return `${lines.join('\n')}\n`
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? '' : value.toFixed(2)
}
