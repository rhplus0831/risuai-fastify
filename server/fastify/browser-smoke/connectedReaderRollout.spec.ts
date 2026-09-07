import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import {
  closeFastBootstrapHarness,
  OBSERVER_SHELL_OVERRIDE_KEY,
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
  readNativeRolloutOutbox,
  readRolloutComposerDrafts,
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

const COMPILED_FALLBACK = process.env.RISU_READER_ROLLOUT_COMPILED_FALLBACK === 'TRUE'
const FALLBACK_PHASE_KEY = 'risu:browser-smoke:reader-rollout-fallback-phase'
const COMMAND_PATH = `/api/v1/commands/messages/${ROLLOUT_MESSAGE}`
const RESTART_EDIT = 'The same writer saved this edit after the actual server restarted.'
const FALLBACK_EDIT = 'This exact saved edit committed before its response was lost during fallback.'
const OLDER_DRAFT = 'Earlier unsent composer draft before the pending edit.'
const NEWER_DRAFT = 'Newer unsent composer draft typed while the saved edit response was held.'

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
  evidence.initialOverrides = await Promise.all(
    [writer, reader].map((page) => page.evaluate((key) => sessionStorage.getItem(key), OBSERVER_SHELL_OVERRIDE_KEY)),
  )
  expect(evidence.initialOverrides).toEqual(COMPILED_FALLBACK ? ['enabled', 'enabled'] : [null, null])
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
  test.skip(COMPILED_FALLBACK, 'The compiled-FALSE campaign selects only the retained-command fallback case.')
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
    await expect(reader.locator('[data-observer-lifecycle-status]')).toHaveText(
      'Connection interrupted. Showing the last received content.',
      { timeout: 20_000 },
    )
    await expect(rolloutMessageBody(reader)).toHaveText(ROLLOUT_ORIGINAL)
    await expect(reader.locator('[data-reader-composer] textarea')).toBeDisabled()
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
      expect(await page.evaluate((key) => sessionStorage.getItem(key), OBSERVER_SHELL_OVERRIDE_KEY)).toBeNull()
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

/** Only the dedicated FALSE-build campaign needs an enabled fixture before fallback. */
async function configureCompiledFallbackFixture(context: BrowserContext): Promise<void> {
  if (!COMPILED_FALLBACK) return
  await context.addInitScript(
    ({ overrideKey, phaseKey }) => {
      if (!sessionStorage.getItem(phaseKey)) sessionStorage.setItem(overrideKey, 'enabled')
    },
    { overrideKey: OBSERVER_SHELL_OVERRIDE_KEY, phaseKey: FALLBACK_PHASE_KEY },
  )
}

test('conservative fallback reload replays one UI-saved command and preserves the newer unsent composer draft', async ({
  browser,
}, testInfo) => {
  test.setTimeout(150_000)
  const harness = await startFastBootstrapHarness(rolloutFixture(), {
    temporaryDirectoryPrefix: 'risu-reader-rollout-fallback-',
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
  const commandAttempts: Array<{
    afterReloadStarted: boolean
    mutationId: string
    body: Record<string, unknown>
    status?: number
  }> = []
  const acknowledgements: Array<{ body: unknown; status: number }> = []
  const evidence: Record<string, unknown> = {
    variant: COMPILED_FALLBACK ? 'compiled-FALSE-fallback' : 'default-to-explicit-disabled-fallback',
    editEntry: 'Message Edit → default Popup Editor plain-text input → Close, which invokes saveMessageEdit.',
    readerRequests,
    writerRequests,
    pageErrors,
    commandAttempts,
    acknowledgements,
  }
  let releaseLostResponse!: () => void
  const heldResponse = new Promise<void>((resolve) => {
    releaseLostResponse = resolve
  })
  let acceptedResponse: Record<string, unknown> | null = null
  let reloadStarted = false
  readerContext.on('request', (request) => recordRolloutApiRequest(request, readerRequests))
  writerContext.on('request', (request) => recordRolloutApiRequest(request, writerRequests))
  writer.on('pageerror', (error) => pageErrors.push(`writer: ${error.message}`))
  reader.on('pageerror', (error) => pageErrors.push(`reader: ${error.message}`))
  writer.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/v1/commands/mutation-receipts/ack')
      acknowledgements.push({
        body: JSON.parse(response.request().postData() ?? '{}') as unknown,
        status: response.status(),
      })
  })
  try {
    await configureCompiledFallbackFixture(writerContext)
    await configureCompiledFallbackFixture(readerContext)
    const { writerIdentity, readerIdentity } = await openRolloutPair(harness, writer, reader, evidence)
    const beforeEdit = rolloutDurableSnapshot(harness.dataDir)
    const composer = writer.getByTestId('default-chat-composer')
    await composer.fill(OLDER_DRAFT)
    const olderDraft = (await readRolloutComposerDrafts(writer)).find(
      (draft) => draft.payload.messageInput === OLDER_DRAFT,
    )
    expect(olderDraft).toBeDefined()
    evidence.olderDraft = olderDraft
    await writer.route(`**${COMMAND_PATH}`, async (route) => {
      const request = route.request()
      const firstAttempt = commandAttempts.length === 0
      const attempt: (typeof commandAttempts)[number] = {
        afterReloadStarted: reloadStarted,
        mutationId: request.headers()['risu-mutation-id'] ?? '',
        body: JSON.parse(request.postData() ?? '{}') as Record<string, unknown>,
      }
      commandAttempts.push(attempt)
      const response = await route.fetch()
      attempt.status = response.status()
      if (firstAttempt) {
        acceptedResponse = (await response.json()) as Record<string, unknown>
        await heldResponse
        // The old document was destroyed by a real reload. Never deliver its
        // accepted response; the new runtime must replay the durable intent.
        await route.abort('connectionclosed').catch(() => undefined)
      } else {
        await route.fulfill({ response })
      }
    })
    await saveRolloutMessageThroughUi(writer, FALLBACK_EDIT)
    await expect.poll(() => acceptedResponse, { timeout: 20_000 }).toMatchObject({ revision: beforeEdit.revision + 1 })
    expect(commandAttempts[0]).toMatchObject({ status: 200, afterReloadStarted: false })
    evidence.acceptedResponseHeldUntilReload = acceptedResponse
    await expect(rolloutMessageBody(reader)).toHaveText(FALLBACK_EDIT, { timeout: 30_000 })
    await composer.fill(NEWER_DRAFT)
    await expect(composer).toHaveValue(NEWER_DRAFT)
    const newerDraft = (await readRolloutComposerDrafts(writer)).find(
      (draft) => draft.payload.messageInput === NEWER_DRAFT,
    )
    expect(newerDraft).toMatchObject({
      writerSessionId: writerIdentity.sessionId,
      databaseLineage: beforeEdit.ownership.lineage,
    })
    expect(newerDraft!.sequence).toBeGreaterThan(olderDraft!.sequence)
    evidence.newerDraftBeforeReload = newerDraft
    const retained = await writer.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getLifecycleSnapshot())
    expect(retained.outbox).toHaveLength(1)
    expect(retained.receiptAcknowledgements).toEqual([])
    const mutationId = retained.outbox[0]!.mutationId
    expect(mutationId).toMatch(/\S/u)
    expect(commandAttempts[0]!.mutationId).toBe(mutationId)
    const nativeRows = await readNativeRolloutOutbox(writer)
    expect(nativeRows).toHaveLength(1)
    expect(nativeRows[0]).toMatchObject({
      mutationId,
      ownerWriterSessionId: writerIdentity.sessionId,
      writerEpoch: 1,
      databaseLineage: beforeEdit.ownership.lineage,
      dispatchStarted: true,
      ivBytes: 12,
    })
    expect(nativeRows[0]!.ciphertextBytes).toBeGreaterThan(16)
    expect(nativeRows[0]!.ciphertextSha256).toMatch(/^[a-f0-9]{64}$/u)
    for (const key of ['intent', 'requests', 'patch', 'data']) expect(nativeRows[0]!.keys).not.toContain(key)
    for (const text of [FALLBACK_EDIT, OLDER_DRAFT, NEWER_DRAFT])
      expect(nativeRows[0]!.ciphertextText).not.toContain(text)
    evidence.retained = retained
    evidence.nativeOutbox = nativeRows.map(({ ciphertextText: _ciphertextText, ...metadata }) => metadata)
    const committedBeforeReload = rolloutDurableSnapshot(harness.dataDir)
    expect(committedBeforeReload.revision).toBe(beforeEdit.revision + 1)
    expect(committedBeforeReload.receipts).toHaveLength(beforeEdit.receipts.length + 1)
    const originalReceipt = committedBeforeReload.receipts.find((row) => row.mutation_id === mutationId)!
    expect(originalReceipt).toMatchObject({
      creator_writer_session_id: writerIdentity.sessionId,
      database_lineage: beforeEdit.ownership.lineage,
      acknowledged_at: null,
    })
    evidence.committedBeforeReload = committedBeforeReload

    await writer.evaluate(
      ({ overrideKey, phaseKey, compiledFallback }) => {
        sessionStorage.setItem(phaseKey, 'reload')
        if (compiledFallback) sessionStorage.removeItem(overrideKey)
        else sessionStorage.setItem(overrideKey, 'disabled')
      },
      { overrideKey: OBSERVER_SHELL_OVERRIDE_KEY, phaseKey: FALLBACK_PHASE_KEY, compiledFallback: COMPILED_FALLBACK },
    )
    reloadStarted = true
    await writer.reload({ waitUntil: 'domcontentloaded' })
    releaseLostResponse()
    await expectRolloutWriter(writer)
    await expectEmptyRolloutQueues(writer)
    await expect(composer).toHaveValue(NEWER_DRAFT)
    await expect(rolloutMessageBody(writer)).toHaveText(FALLBACK_EDIT)
    const finalWriter = await rolloutPageIdentity(writer)
    expect(finalWriter.timeOrigin).toBeGreaterThan(writerIdentity.timeOrigin)
    expect(finalWriter.sessionId).toBe(writerIdentity.sessionId)
    expect(finalWriter.role.managed).toBe(false)
    const finalOverride = await writer.evaluate((key) => sessionStorage.getItem(key), OBSERVER_SHELL_OVERRIDE_KEY)
    expect(finalOverride).toBe(COMPILED_FALLBACK ? null : 'disabled')
    evidence.fallback = { writer: finalWriter, override: finalOverride, draft: await readRolloutComposerDrafts(writer) }
    expect(await readNativeRolloutOutbox(writer)).toEqual([])
    expect(commandAttempts.length).toBeGreaterThanOrEqual(2)
    expect(commandAttempts.some((attempt) => attempt.afterReloadStarted && attempt.status === 200)).toBe(true)
    expect(new Set(commandAttempts.map((attempt) => attempt.mutationId))).toEqual(new Set([mutationId]))
    const semanticBody = ({ baseRevision: _baseRevision, ...body }: Record<string, unknown>) => body
    for (const attempt of commandAttempts)
      expect(semanticBody(attempt.body)).toEqual(semanticBody(commandAttempts[0]!.body))
    await expect.poll(() => acknowledgements.length).toBe(1)
    expect(acknowledgements[0]).toMatchObject({ status: 200, body: { mutationId, requestCount: 1 } })
    const final = rolloutDurableSnapshot(harness.dataDir)
    expect(final.ownership).toEqual(beforeEdit.ownership)
    expect(final.revision).toBe(beforeEdit.revision + 1)
    expect(final.messages).toEqual([expect.objectContaining({ uid: ROLLOUT_MESSAGE, data: FALLBACK_EDIT })])
    expect(final.events.slice(beforeEdit.events.length)).toEqual([
      expect.objectContaining({
        revision: final.revision,
        id: ROLLOUT_MESSAGE,
        origin_writer_session_id: writerIdentity.sessionId,
      }),
    ])
    expect(final.receipts).toHaveLength(committedBeforeReload.receipts.length)
    const finalReceipt = final.receipts.find((row) => row.mutation_id === mutationId)!
    expect(finalReceipt).toEqual({ ...originalReceipt, acknowledged_at: expect.any(String) })
    for (const draft of [OLDER_DRAFT, NEWER_DRAFT]) expect(JSON.stringify(final.messages)).not.toContain(draft)
    evidence.final = final
    evidence.readerAudit = await expectReaderAudit(reader, readerRequests, writerIdentity.sessionId)
    expect(await rolloutPageIdentity(reader)).toMatchObject({
      timeOrigin: readerIdentity.timeOrigin,
      sessionId: readerIdentity.sessionId,
    })
    expect(writerRequests.filter((request) => request.disconnectExistingWriter !== null)).toEqual([])
    const writerBootstraps = writerRequests.filter(
      (request) => request.path === '/api/v1/bootstrap' && request.writerSession !== null,
    )
    expect(writerBootstraps.length).toBeGreaterThanOrEqual(2)
    expect(writerBootstraps.every((request) => request.writerSession === writerIdentity.sessionId)).toBe(true)
    expect(pageErrors).toEqual([])
  } finally {
    releaseLostResponse()
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
