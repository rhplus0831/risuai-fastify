import { devices, expect, test, type Route } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { closeFastBootstrapHarness } from './fastBootstrapHarness.js'
import {
  CHAT_READER_TWO,
  CHAT_STOP,
  OccupancyProvider,
  type Client,
  readTruth,
  readSharedMutationBoundary,
  startHarness,
  createClient,
  waitForHook,
  bootOwner,
  bootReader,
  configureChats,
  directClaim,
  chatOccupancyOutboxRows,
  appendOwnerMessage,
  setRetainedReaderDraft,
  expectOccupancyState,
  promoteViaUi,
  claimFromUi,
  sendFromUi,
  continueFromOwnerUi,
  chatMessages,
  auditChatOnlyMutations,
} from './chatOccupancyHarness.js'

test('a lost Stop response reconciles after reload without cancelling twice or replacing a newer draft', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_READER_TWO, {
    chunks: ['Cancellation partial', ' must not finish.'],
    holdAfterChunk: 1,
  })
  const harness = await startHarness(provider, 'risu-chat-occupancy-lost-stop-')
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'owner')
    const sender = await createClient(browser, 'stop-sender', devices['Pixel 7'])
    clients.push(owner, sender)
    for (const client of clients)
      client.page.on('pageerror', (error) => pageErrors.push(`${client.name}: ${error.message}`))

    await bootOwner(owner, harness, CHAT_READER_TWO)
    await configureChats(owner.page)
    await bootReader(sender, harness, CHAT_READER_TWO)
    await claimFromUi(sender)
    await sendFromUi(sender, 'Cancel this accepted request.')
    await expect.poll(() => provider.calls(CHAT_READER_TWO)).toBe(1)
    await expect(
      sender.page.locator('[data-reader-transcript] .chat-message-body').filter({ hasText: 'Cancellation partial' }),
    ).toBeVisible()
    const operation = readTruth(harness.dataDir).operations.find((candidate) => candidate.chat_id === CHAT_READER_TWO)!
    expect(operation.state).toBe('owned_by_job')

    let lostStop: { status: number; body: Record<string, unknown>; operationId: string } | undefined
    let resolveLostStop!: () => void
    const stopCommitted = new Promise<void>((resolve) => {
      resolveLostStop = resolve
    })
    let intercepted = false
    const loseStopResponse = async (route: Route) => {
      if (intercepted) return route.continue()
      intercepted = true
      const response = await route.fetch()
      lostStop = {
        status: response.status(),
        body: (await response.json()) as Record<string, unknown>,
        operationId: new URL(route.request().url()).pathname.split('/').at(-2) ?? '',
      }
      resolveLostStop()
      await route.abort('connectionclosed')
    }
    await sender.context.route('**/api/v1/generation-operations/*/cancellation', loseStopResponse)
    await sender.page.getByTestId('default-chat-cancel-button').click()
    await stopCommitted
    expect([200, 202]).toContain(lostStop!.status)
    expect(lostStop).toMatchObject({
      operationId: operation.operation_id,
      body: { operation: { operationId: operation.operation_id } },
    })
    const stopOutboxBeforeReload = await chatOccupancyOutboxRows(sender.page)
    expect(stopOutboxBeforeReload.length).toBeLessThanOrEqual(1)
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).operations.find((candidate) => candidate.operation_id === operation.operation_id)
            ?.state,
      )
      .toBe('cancelled')
    expect(provider.calls(CHAT_READER_TWO)).toBe(1)
    expect(provider.aborts(CHAT_READER_TWO)).toBe(1)
    const newerDraft = 'A newer draft must survive Stop recovery.'
    await expect(sender.page.locator('[data-reader-composer-field="message"]')).toBeEnabled()
    await sender.page.locator('[data-reader-composer-field="message"]').fill(newerDraft)

    await sender.context.unroute('**/api/v1/generation-operations/*/cancellation', loseStopResponse)
    await sender.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(sender.page)
    await expect(sender.page.locator('[data-reader-transcript]')).toHaveAttribute(
      'data-reader-chat-id',
      CHAT_READER_TWO,
    )
    await expectOccupancyState(sender.page, 'self-owned')
    await expect.poll(async () => (await chatOccupancyOutboxRows(sender.page)).length).toBe(0)
    await expect(sender.page.locator('[data-reader-composer-field="message"]')).toHaveValue(newerDraft)
    expect(provider.calls(CHAT_READER_TWO)).toBe(1)
    expect(provider.aborts(CHAT_READER_TWO)).toBe(1)
    expect(
      sender.records.filter(
        (record) => record.path === `/api/v1/generation-operations/${operation.operation_id}/cancellation`,
      ),
    ).toHaveLength(1)
    expect(chatMessages(readTruth(harness.dataDir), CHAT_READER_TWO).map(({ role, data }) => ({ role, data }))).toEqual(
      [
        { role: 'char', data: `Seed for ${CHAT_READER_TWO}.` },
        { role: 'user', data: 'Cancel this accepted request.' },
        { role: 'char', data: 'Cancellation partial' },
      ],
    )
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('chat-occupancy-lost-stop.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          sessions: clients.map(({ name, sessionId }) => ({ name, sessionId })),
          lostStop,
          stopOutboxBeforeReload,
          newerDraft,
          provider: { calls: provider.calls(CHAT_READER_TWO), aborts: provider.aborts(CHAT_READER_TWO) },
          truth: readTruth(harness.dataDir),
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('chat-occupancy-lost-stop', { path: evidencePath, contentType: 'application/json' })
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('a normalized owner Continue replays one pre-server Stop without losing the retained draft', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_READER_TWO, {
    chunks: [' Continue partial', ' must not finish.'],
    holdAfterChunk: 1,
  })
  const harness = await startHarness(provider, 'risu-chat-occupancy-pre-server-stop-')
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const sender = await createClient(browser, 'pre-server-stop-sender', devices['Pixel 7'])
    const successor = await createClient(browser, 'successor')
    clients.push(sender, successor)
    for (const client of clients)
      client.page.on('pageerror', (error) => pageErrors.push(`${client.name}: ${error.message}`))

    await bootOwner(sender, harness, CHAT_READER_TWO)
    await configureChats(sender.page)
    const ownerClaim = await directClaim(sender.page, CHAT_READER_TWO, 'owner')
    expect(ownerClaim).toMatchObject({ status: 200, body: { occupancyEpoch: 1, claimClass: 'owner' } })
    await sender.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(sender.page)
    await sender.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await expect(sender.page.getByTestId('default-chat-composer')).toBeVisible()
    await appendOwnerMessage(sender.page, CHAT_READER_TWO, 'normalized-continue-target', 'Owner Continue target.')
    await sender.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(sender.page)
    await sender.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await expect(sender.page.locator('.default-chat-screen')).toContainText('Owner Continue target.')
    await bootReader(successor, harness, CHAT_READER_TWO)
    await expect(sender.page.getByTestId('default-chat-send-button')).toBeVisible()
    await expect(sender.page.getByTestId('default-chat-send-button')).toBeEnabled()
    await expect
      .poll(
        () => sender.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getGenerationReadinessDiagnostic()),
        { timeout: 30_000 },
      )
      .toMatchObject({ ready: true, blockers: [] })
    await continueFromOwnerUi(sender, CHAT_READER_TWO)
    await expect.poll(() => provider.calls(CHAT_READER_TWO)).toBe(1)
    await expect(
      sender.page.locator('.default-chat-screen .chat-message-body').filter({ hasText: 'Continue partial' }).first(),
    ).toBeVisible()
    const running = readTruth(harness.dataDir)
    const operation = running.operations.filter((candidate) => candidate.chat_id === CHAT_READER_TWO).at(-1)!
    expect(operation).toMatchObject({
      creator_writer_session_id: sender.sessionId,
      mode: 'continue',
      admission_kind: 'owner_occupancy',
      occupancy_session_id: sender.sessionId,
      occupancy_epoch: 1,
      occupancy_claim_class: 'owner',
      state: 'owned_by_job',
    })
    await promoteViaUi(successor, sender, harness.dataDir, 2)
    await sender.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(sender.page)
    await expect(sender.page.locator('[data-reader-transcript]')).toHaveAttribute(
      'data-reader-chat-id',
      CHAT_READER_TWO,
    )
    await expectOccupancyState(sender.page, 'normalization-required')
    await sender.page.locator('[data-reader-occupancy-normalize]').click()
    await expectOccupancyState(sender.page, 'self-owned')
    const normalizedOccupancy = readTruth(harness.dataDir).occupancy.find(
      (candidate) => (candidate as Record<string, unknown>).chat_id === CHAT_READER_TWO,
    ) as Record<string, unknown>
    expect(normalizedOccupancy).toMatchObject({
      occupant_session_id: sender.sessionId,
      occupancy_epoch: 1,
      claim_class: 'chat_only',
      released_at_ms: null,
    })
    const sharedBefore = readSharedMutationBoundary(harness.dataDir)
    const senderMutationAuditStart = sender.records.length

    let preServerStopAttempts = 0
    const failStopBeforeServer = async (route: Route) => {
      preServerStopAttempts += 1
      await route.abort('connectionclosed')
    }
    const cancellationPath = `/api/v1/generation-operations/${operation.operation_id}/cancellation`
    await sender.context.route('**/api/v1/generation-operations/*/cancellation', failStopBeforeServer)
    await sender.page.getByTestId('default-chat-cancel-button').click()
    await expect.poll(() => preServerStopAttempts).toBe(1)
    await expect.poll(async () => (await chatOccupancyOutboxRows(sender.page)).length).toBe(1)
    expect(
      readTruth(harness.dataDir).operations.find((candidate) => candidate.operation_id === operation.operation_id)
        ?.state,
    ).toBe('owned_by_job')
    expect(provider.aborts(CHAT_READER_TWO)).toBe(0)
    const blockedStopRecord = sender.records.find(
      (record) => record.method === 'PUT' && record.path === cancellationPath,
    )
    expect(blockedStopRecord).toMatchObject({
      headers: {
        'risu-writer-session': sender.sessionId,
        'risu-chat-occupancy-epoch': '1',
      },
      body: {
        reason: 'user_stop',
        chatId: CHAT_READER_TWO,
        chatOccupancy: { version: 1, interaction: 'continue' },
      },
    })
    expect(blockedStopRecord?.status).toBeUndefined()

    const newerDraft = 'Draft written after the failed transport must survive recovery.'
    await setRetainedReaderDraft(sender.page, newerDraft)
    const stopOutboxBeforeReload = await chatOccupancyOutboxRows(sender.page)
    expect(stopOutboxBeforeReload).toHaveLength(1)
    expect(stopOutboxBeforeReload[0]).toMatchObject({
      authorityKind: 'chat-occupancy',
      ownerWriterSessionId: sender.sessionId,
      writerEpoch: 1,
      databaseLineage: running.ownership.lineage,
    })

    await sender.context.unroute('**/api/v1/generation-operations/*/cancellation', failStopBeforeServer)
    await sender.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(sender.page)
    await expect(sender.page.locator('[data-reader-transcript]')).toHaveAttribute(
      'data-reader-chat-id',
      CHAT_READER_TWO,
    )
    await expectOccupancyState(sender.page, 'self-owned')
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).operations.find((candidate) => candidate.operation_id === operation.operation_id)
            ?.state,
      )
      .toBe('cancelled')
    await expect.poll(async () => (await chatOccupancyOutboxRows(sender.page)).length).toBe(0)
    await expect(sender.page.locator('[data-reader-composer-field="message"]')).toHaveValue(newerDraft)
    expect(provider.calls(CHAT_READER_TWO)).toBe(1)
    expect(provider.aborts(CHAT_READER_TWO)).toBe(1)

    const cancellationRecords = sender.records.filter(
      (record) => record.method === 'PUT' && record.path === cancellationPath,
    )
    expect(cancellationRecords).toHaveLength(2)
    expect(cancellationRecords.filter((record) => record.status === undefined)).toEqual([blockedStopRecord])
    expect(cancellationRecords.filter((record) => [200, 202].includes(record.status ?? 0))).toHaveLength(1)
    const terminalTruth = readTruth(harness.dataDir)
    expect(
      terminalTruth.operations.find((candidate) => candidate.operation_id === operation.operation_id),
    ).toMatchObject({
      state: 'cancelled',
      admission_kind: 'owner_occupancy',
      occupancy_session_id: sender.sessionId,
      occupancy_epoch: 1,
      occupancy_claim_class: 'owner',
    })
    expect(chatMessages(terminalTruth, CHAT_READER_TWO).map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'char', data: `Seed for ${CHAT_READER_TWO}.` },
      { role: 'char', data: 'Owner Continue target. Continue partial' },
    ])
    expect(
      sender.records.filter((record) => record.method === 'POST' && record.path === '/api/v1/generation-operations'),
    ).toHaveLength(1)
    const senderMutationAudit = auditChatOnlyMutations(
      { ...sender, records: sender.records.slice(senderMutationAuditStart) },
      terminalTruth,
      [CHAT_READER_TWO],
    )
    expect(senderMutationAudit.violations).toEqual([])
    expect(readSharedMutationBoundary(harness.dataDir)).toEqual(sharedBefore)
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('chat-occupancy-pre-server-stop.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          sessions: clients.map(({ name, sessionId }) => ({ name, sessionId })),
          operation,
          ownerClaim,
          normalizedOccupancy,
          blockedStop: {
            attempts: preServerStopAttempts,
            record: blockedStopRecord ? { ...blockedStopRecord, request: undefined, headers: undefined } : undefined,
          },
          stopOutboxBeforeReload,
          successfulServerCancellations: cancellationRecords.filter((record) => [200, 202].includes(record.status ?? 0))
            .length,
          newerDraft,
          provider: { calls: provider.calls(CHAT_READER_TWO), aborts: provider.aborts(CHAT_READER_TWO) },
          mutationAudit: senderMutationAudit,
          truth: terminalTruth,
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('chat-occupancy-pre-server-stop', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('an exact pre-acceptance cancellation tombstone drains its sibling Send after reload', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  const harness = await startHarness(provider, 'risu-chat-occupancy-pre-acceptance-cancel-')
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'owner')
    const sender = await createClient(browser, 'pre-acceptance-cancel-sender', devices['Pixel 7'])
    clients.push(owner, sender)
    for (const client of clients)
      client.page.on('pageerror', (error) => pageErrors.push(`${client.name}: ${error.message}`))

    await bootOwner(owner, harness, CHAT_STOP)
    await configureChats(owner.page)
    await bootReader(sender, harness, CHAT_STOP)
    await claimFromUi(sender)
    const initialTruth = readTruth(harness.dataDir)
    const sharedBefore = readSharedMutationBoundary(harness.dataDir)
    let blockedSubmit: { operationId: string; acceptedMessageId: string } | undefined
    let blockedSubmitAttempts = 0
    const failSubmitBeforeServer = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const body = route.request().postDataJSON() as Record<string, unknown>
      blockedSubmitAttempts += 1
      blockedSubmit = {
        operationId: String(body.operationId ?? ''),
        acceptedMessageId: String(body.acceptedMessageId ?? ''),
      }
      await route.abort('connectionclosed')
    }
    await sender.context.route('**/api/v1/generation-operations', failSubmitBeforeServer)

    await sendFromUi(sender, 'Cancel before this Send is accepted.')
    await expect.poll(() => blockedSubmitAttempts).toBe(1)
    expect(blockedSubmit).toMatchObject({
      operationId: expect.stringMatching(/\S/u),
      acceptedMessageId: expect.stringMatching(/\S/u),
    })
    await expect.poll(async () => (await chatOccupancyOutboxRows(sender.page)).length).toBe(1)
    expect(readTruth(harness.dataDir).operations).toEqual([])
    expect(provider.calls(CHAT_STOP)).toBe(0)

    const cancellation = await sender.page.evaluate(
      async ({ operationId, chatId }) => {
        const hook = window.__RISU_FASTIFY_BROWSER_SMOKE__!
        const session = hook.getClientSessionSnapshot()
        const headers = await hook.activeWriterHeaders()
        const response = await fetch(`/api/v1/generation-operations/${encodeURIComponent(operationId)}/cancellation`, {
          method: 'PUT',
          headers: {
            ...headers,
            'content-type': 'application/json',
            'risu-database-lineage': session.databaseLineage!,
            'risu-chat-occupancy-epoch': '1',
          },
          body: JSON.stringify({
            reason: 'user_stop',
            chatId,
            chatOccupancy: { version: 1, interaction: 'send' },
          }),
        })
        return { status: response.status, body: (await response.json()) as Record<string, unknown> }
      },
      { operationId: blockedSubmit!.operationId, chatId: CHAT_STOP },
    )
    expect(cancellation).toMatchObject({
      status: 200,
      body: {
        disposition: 'cancelled_before_acceptance',
        operation: {
          operationId: blockedSubmit!.operationId,
          requestOrigin: 'unbound',
          state: 'cancel_requested',
          chatId: CHAT_STOP,
          mode: 'send',
        },
      },
    })
    const tombstone = readTruth(harness.dataDir).operations.find(
      (candidate) => candidate.operation_id === blockedSubmit!.operationId,
    )
    expect(tombstone).toMatchObject({
      chat_id: CHAT_STOP,
      mode: 'send',
      creator_writer_session_id: sender.sessionId,
      admission_kind: 'chat_only',
      occupancy_session_id: sender.sessionId,
      occupancy_epoch: 1,
      occupancy_claim_class: 'chat_only',
      state: 'cancel_requested',
      accepted_message_id: null,
    })
    expect(provider.calls(CHAT_STOP)).toBe(0)

    const newerDraft = 'A newer draft survives sibling Send tombstone settlement.'
    await setRetainedReaderDraft(sender.page, newerDraft)
    const outboxBeforeReload = await chatOccupancyOutboxRows(sender.page)
    expect(outboxBeforeReload).toHaveLength(1)
    expect(outboxBeforeReload[0]).toMatchObject({
      authorityKind: 'chat-occupancy',
      ownerWriterSessionId: sender.sessionId,
      writerEpoch: 1,
      databaseLineage: initialTruth.ownership.lineage,
    })

    await sender.context.unroute('**/api/v1/generation-operations', failSubmitBeforeServer)
    await sender.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(sender.page)
    await expect(sender.page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', CHAT_STOP)
    await expectOccupancyState(sender.page, 'self-owned')
    await expect.poll(async () => (await chatOccupancyOutboxRows(sender.page)).length).toBe(0)
    await expect(sender.page.locator('[data-reader-composer-field="message"]')).toHaveValue(newerDraft)
    expect(provider.calls(CHAT_STOP)).toBe(0)
    expect(provider.aborts(CHAT_STOP)).toBe(0)
    expect(
      sender.records.filter((record) => record.method === 'POST' && record.path === '/api/v1/generation-operations'),
    ).toHaveLength(1)
    expect(chatMessages(readTruth(harness.dataDir), CHAT_STOP).map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'char', data: `Seed for ${CHAT_STOP}.` },
    ])
    expect(readSharedMutationBoundary(harness.dataDir)).toEqual(sharedBefore)
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('chat-occupancy-pre-acceptance-cancel.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          sessions: clients.map(({ name, sessionId }) => ({ name, sessionId })),
          blockedSubmit,
          cancellation,
          tombstone,
          outboxBeforeReload,
          newerDraft,
          provider: { calls: provider.calls(CHAT_STOP), aborts: provider.aborts(CHAT_STOP) },
          truth: readTruth(harness.dataDir),
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('chat-occupancy-pre-acceptance-cancel', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})
