import { expect, test, type Page } from '@playwright/test'
import {
  closeFastBootstrapHarness,
  startFastBootstrapHarness,
  type FastBootstrapHarness,
} from './fastBootstrapHarness.js'
import {
  attachRolloutEvidence,
  expectEmptyRolloutQueues,
  expectRolloutReader,
  expectRolloutWriter,
  isForbiddenReaderRequest,
  observeRolloutEventConnections,
  recordRolloutApiRequest,
  restartRolloutServer,
  ROLLOUT_MESSAGE,
  ROLLOUT_ORIGINAL,
  ROLLOUT_ROUTE,
  rolloutDurableSnapshot,
  rolloutFixture,
  rolloutMessageBody,
  rolloutPageIdentity,
  saveRolloutMessageThroughUi,
  stopRolloutServer,
  type RolloutApiRequest,
} from './connectedReaderRolloutHarness.js'

const RESTART_EDIT = 'The same writer saved this edit after the actual server restarted.'

async function openRolloutPair(
  harness: FastBootstrapHarness,
  writer: Page,
  reader: Page,
  evidence: Record<string, unknown>,
) {
  evidence.initial = rolloutDurableSnapshot(harness.dataDir)
  expect(rolloutDurableSnapshot(harness.dataDir).ownership).toMatchObject({
    active_writer_session_id: null,
    writer_epoch: 0,
  })
  await writer.goto(`${harness.baseUrl}${ROLLOUT_ROUTE}`, { waitUntil: 'domcontentloaded' })
  await expectRolloutWriter(writer)
  const writerIdentity = await rolloutPageIdentity(writer)
  expect(writerIdentity.role).toMatchObject({ managed: true, lifecycle: 'writing' })
  expect(writerIdentity.sessionId).toMatch(/\S/u)
  expect(rolloutDurableSnapshot(harness.dataDir).ownership).toMatchObject({
    active_writer_session_id: writerIdentity.sessionId,
    writer_epoch: 1,
  })
  await reader.goto(`${harness.baseUrl}${ROLLOUT_ROUTE}`, { waitUntil: 'domcontentloaded' })
  await expectRolloutReader(reader)
  await expect(rolloutMessageBody(reader)).toHaveText(ROLLOUT_ORIGINAL)
  const readerIdentity = await rolloutPageIdentity(reader)
  expect(readerIdentity.sessionId).toMatch(/\S/u)
  expect(readerIdentity.sessionId).not.toBe(writerIdentity.sessionId)
  expect(readerIdentity.role).toMatchObject({
    managed: true,
    lifecycle: 'reading',
    writer: { sessionId: writerIdentity.sessionId, epoch: 1 },
  })
  await expectEmptyRolloutQueues(writer)
  await expectEmptyRolloutQueues(reader)
  evidence.initialPages = { writer: writerIdentity, reader: readerIdentity }
  return { writerIdentity, readerIdentity }
}

async function expectReaderAudit(reader: Page, requests: RolloutApiRequest[], writerSession: string | null) {
  await expectRolloutReader(reader)
  await expectEmptyRolloutQueues(reader)
  const identity = await rolloutPageIdentity(reader)
  expect(identity.role).toMatchObject({
    managed: true,
    lifecycle: 'reading',
    writer: { sessionId: writerSession, epoch: 1 },
  })
  expect(requests.filter(isForbiddenReaderRequest)).toEqual([])
  const bootstraps = requests.filter((request) => request.path === '/api/v1/bootstrap')
  expect(bootstraps.length).toBeGreaterThan(0)
  expect(
    bootstraps.every((request) => request.observerSession === identity.sessionId && request.writerSession === null),
  ).toBe(true)
  expect(requests.some((request) => request.path === '/api/v1/events' && request.writerSession === null)).toBe(true)
  return {
    identity,
    lifecycle: await reader.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getLifecycleSnapshot()),
  }
}

test('default connected Reader reconnects after an actual server restart without page reload or write takeover', async ({
  browser,
}, testInfo) => {
  test.setTimeout(150_000)
  const harness = await startFastBootstrapHarness(rolloutFixture(), {
    temporaryDirectoryPrefix: 'risu-reader-rollout-restart-',
  })
  const writerContext = await browser.newContext()
  const readerContext = await browser.newContext()
  writerContext.setDefaultTimeout(10_000)
  readerContext.setDefaultTimeout(10_000)
  const writer = await writerContext.newPage()
  const reader = await readerContext.newPage()
  const readerRequests: RolloutApiRequest[] = []
  const writerRequests: RolloutApiRequest[] = []
  const pageErrors: string[] = []
  const evidence: Record<string, unknown> = {
    variant: 'default-restart',
    restartMechanism:
      'Close all Fastify HTTP connections and SQLite, rebuild Fastify on the same port and data directory; the Node test process remains alive.',
    editEntry: 'Message Edit → default Popup Editor plain-text input → Close, which invokes saveMessageEdit.',
    readerRequests,
    writerRequests,
    pageErrors,
  }
  const initialConnections = observeRolloutEventConnections(harness.app)
  evidence.initialEventConnections = initialConnections.records
  readerContext.on('request', (request) => recordRolloutApiRequest(request, readerRequests))
  writerContext.on('request', (request) => recordRolloutApiRequest(request, writerRequests))
  writer.on('pageerror', (error) => pageErrors.push(`writer: ${error.message}`))
  reader.on('pageerror', (error) => pageErrors.push(`reader: ${error.message}`))
  try {
    const { writerIdentity, readerIdentity } = await openRolloutPair(harness, writer, reader, evidence)
    const beforeRestart = rolloutDurableSnapshot(harness.dataDir)
    await expect.poll(initialConnections.active).toEqual({ writer: 1, reader: 1 })
    evidence.beforeRestart = beforeRestart
    await stopRolloutServer(harness)
    await expect.poll(initialConnections.active).toEqual({ writer: 0, reader: 0 })
    await expect(reader.locator('[data-reader-lifecycle-status]')).toHaveText(
      'Connection interrupted. Showing the last received content.',
      { timeout: 20_000 },
    )
    await expect(rolloutMessageBody(reader)).toHaveText(ROLLOUT_ORIGINAL)
    await expect(reader.locator('[data-reader-composer-field="message"]')).toBeDisabled()
    evidence.interrupted = await rolloutPageIdentity(reader)
    const restartedConnections = await restartRolloutServer(harness)
    evidence.restartedEventConnections = restartedConnections.records
    await expectRolloutReader(reader)
    await expectRolloutWriter(writer)
    await expect.poll(restartedConnections.active, { timeout: 30_000 }).toEqual({ writer: 1, reader: 1 })
    expect(rolloutDurableSnapshot(harness.dataDir)).toEqual(beforeRestart)
    for (const [page, previous] of [
      [writer, writerIdentity],
      [reader, readerIdentity],
    ] as const) {
      expect(await rolloutPageIdentity(page)).toMatchObject({
        sessionId: previous.sessionId,
        timeOrigin: previous.timeOrigin,
        url: previous.url,
      })
    }

    await saveRolloutMessageThroughUi(writer, RESTART_EDIT)
    await expect(rolloutMessageBody(reader)).toHaveText(RESTART_EDIT, { timeout: 30_000 })
    await expectEmptyRolloutQueues(writer)
    const final = rolloutDurableSnapshot(harness.dataDir)
    expect(final.ownership).toEqual(beforeRestart.ownership)
    expect(final.revision).toBe(beforeRestart.revision + 1)
    expect(final.messages).toEqual([expect.objectContaining({ uid: ROLLOUT_MESSAGE, data: RESTART_EDIT })])
    expect(final.events.slice(beforeRestart.events.length)).toEqual([
      expect.objectContaining({
        revision: final.revision,
        id: ROLLOUT_MESSAGE,
        origin_writer_session_id: writerIdentity.sessionId,
      }),
    ])
    evidence.readerAudit = await expectReaderAudit(reader, readerRequests, writerIdentity.sessionId)
    expect(writerRequests.filter((request) => request.disconnectExistingWriter !== null)).toEqual([])
    const writerBootstraps = writerRequests.filter(
      (request) => request.path === '/api/v1/bootstrap' && request.writerSession !== null,
    )
    expect(writerBootstraps.length).toBeGreaterThan(0)
    expect(writerBootstraps.every((request) => request.writerSession === writerIdentity.sessionId)).toBe(true)
    evidence.final = final
    await expect.poll(restartedConnections.active).toEqual({ writer: 1, reader: 1 })
    await readerContext.close()
    await expect.poll(restartedConnections.active).toEqual({ writer: 1, reader: 0 })
    await writerContext.close()
    await expect.poll(restartedConnections.active).toEqual({ writer: 0, reader: 0 })
    evidence.eventConnections = {
      initial: initialConnections.records,
      restarted: restartedConnections.records,
      finalActive: restartedConnections.active(),
    }
    expect(pageErrors).toEqual([])
  } finally {
    try {
      evidence.forbiddenReaderRequests = readerRequests.filter(isForbiddenReaderRequest)
      evidence.terminal = rolloutDurableSnapshot(harness.dataDir)
      await attachRolloutEvidence(testInfo, evidence)
    } finally {
      await readerContext.close().catch(() => undefined)
      await writerContext.close().catch(() => undefined)
      await closeFastBootstrapHarness(harness)
    }
  }
})
