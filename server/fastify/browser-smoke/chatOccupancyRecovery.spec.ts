import { devices, expect, test, type BrowserContext, type Route } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { closeFastBootstrapHarness } from './fastBootstrapHarness.js'
import {
  CHARACTER,
  CHAT_OWNER,
  CHAT_READER,
  CHAT_READER_TWO,
  CHAT_STOP,
  CHAT_OBSERVER,
  SESSION_KEY,
  OccupancyProvider,
  type Client,
  route,
  fixture,
  readTruth,
  readSharedMutationBoundary,
  startHarness,
  restartHarness,
  createClient,
  waitForHook,
  bootOwner,
  bootReader,
  configureChats,
  directClaim,
  directTupleMutation,
  destructiveImport,
  chatOccupancyOutboxRows,
  patchOwnerSettings,
  setRetainedReaderDraft,
  expectOccupancyState,
  promoteViaUi,
  stableOccupancyTuples,
  claimFromUi,
  sendFromUi,
  continueFromOwnerUi,
  expectOwnerGenerationRecoverySettled,
  openReaderChat,
  chatMessages,
  expectCompleted,
  auditChatOnlyMutations,
} from './chatOccupancyHarness.js'

test('same-base send retry survives response loss, suspension, role transfer, and restart', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000)
  let nowMs = Date.now()
  const provider = new OccupancyProvider()
  provider.configure(CHAT_READER, {
    chunks: ['Integrated reader partial', ' must not survive restart.'],
    holdAfterChunk: 1,
  })
  provider.configure(CHAT_READER_TWO, {
    chunks: ['Integrated second-reader partial', ' must not survive restart.'],
    holdAfterChunk: 1,
  })
  const harness = await startHarness(provider, 'risu-chat-occupancy-integrated-faults-', {
    now: () => nowMs,
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  let suspendedClient: Client | undefined
  let suspendedDevtools: Awaited<ReturnType<BrowserContext['newCDPSession']>> | undefined
  try {
    const owner = await createClient(browser, 'integrated-owner')
    const reader = await createClient(browser, 'integrated-reader-mobile', devices['Pixel 7'])
    const readerTwo = await createClient(browser, 'integrated-reader-desktop')
    const observer = await createClient(browser, 'integrated-observer')
    clients.push(owner, reader, readerTwo, observer)
    for (const client of clients)
      client.page.on('pageerror', (error) => pageErrors.push(`${client.name}: ${error.message}`))

    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)
    await bootReader(reader, harness, CHAT_READER)
    await bootReader(readerTwo, harness, CHAT_READER_TWO)
    await bootReader(observer, harness, CHAT_OBSERVER)
    await claimFromUi(reader)
    await claimFromUi(readerTwo)
    expect(new Set(clients.map((client) => client.sessionId)).size).toBe(4)

    const sharedBefore = readSharedMutationBoundary(harness.dataDir)
    const occupancyBeforeFaults = stableOccupancyTuples(harness.dataDir)
    expect(occupancyBeforeFaults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatId: CHAT_READER,
          sessionId: reader.sessionId,
          occupancyEpoch: 1,
          claimClass: 'chat_only',
          released: false,
        }),
        expect.objectContaining({
          chatId: CHAT_READER_TWO,
          sessionId: readerTwo.sessionId,
          occupancyEpoch: 1,
          claimClass: 'chat_only',
          released: false,
        }),
      ]),
    )

    const racingClients = [reader, readerTwo] as const
    const initialBodies = new Map<string, Record<string, unknown>>()
    const initialResults: Array<{
      client: string
      status: number
      request: Record<string, unknown>
      response: Record<string, unknown>
    }> = []
    let releaseInitialSubmits!: () => void
    const initialSubmitGate = new Promise<void>((resolve) => {
      releaseInitialSubmits = resolve
    })
    let lostAcceptance:
      | {
          client: string
          status: number
          operationId: string
          requestedOperationId: string
          acceptedMessageId: string
        }
      | undefined

    const raceHandlers = new Map<Client, (route: Route) => Promise<void>>()
    for (const client of racingClients) {
      const handler = async (route: Route) => {
        const requestBody = route.request().postDataJSON() as Record<string, unknown>
        if (initialBodies.has(client.name)) {
          await route.continue()
          return
        }
        initialBodies.set(client.name, requestBody)
        if (initialBodies.size === racingClients.length) releaseInitialSubmits()
        await initialSubmitGate

        const response = await route.fetch()
        const responseBody = (await response.json()) as Record<string, unknown>
        initialResults.push({
          client: client.name,
          status: response.status(),
          request: requestBody,
          response: responseBody,
        })
        if (response.status() === 201) {
          const operation = responseBody.operation as Record<string, unknown> | undefined
          lostAcceptance = {
            client: client.name,
            status: response.status(),
            operationId: String(operation?.operationId ?? ''),
            requestedOperationId: String(requestBody.operationId ?? ''),
            acceptedMessageId: String(requestBody.acceptedMessageId ?? ''),
          }
          await route.abort('connectionclosed')
          return
        }
        await route.fulfill({ response })
      }
      raceHandlers.set(client, handler)
      await client.context.route('**/api/v1/generation-operations', handler)
    }

    await Promise.all([
      sendFromUi(reader, 'Integrated reader request.'),
      sendFromUi(readerTwo, 'Integrated second-reader request.'),
    ])
    await expect.poll(() => initialResults.length).toBe(2)
    expect(initialResults.map(({ status }) => status).sort()).toEqual([201, 409])
    expect(new Set([...initialBodies.values()].map((body) => body.baseRevision)).size).toBe(1)
    expect(lostAcceptance).toMatchObject({
      status: 201,
      operationId: expect.stringMatching(/\S/u),
      requestedOperationId: expect.stringMatching(/\S/u),
      acceptedMessageId: expect.stringMatching(/\S/u),
    })
    expect(lostAcceptance!.operationId).toBe(lostAcceptance!.requestedOperationId)

    const retriedClient = racingClients.find((client) => client.name !== lostAcceptance!.client)!
    suspendedClient = racingClients.find((client) => client.name === lostAcceptance!.client)!
    await expect
      .poll(() =>
        racingClients.reduce(
          (count, client) =>
            count +
            client.records.filter(
              (record) => record.method === 'POST' && record.path === '/api/v1/generation-operations',
            ).length,
          0,
        ),
      )
      .toBe(3)
    await expect.poll(() => [provider.calls(CHAT_READER), provider.calls(CHAT_READER_TWO)]).toEqual([1, 1])
    await expect.poll(async () => (await chatOccupancyOutboxRows(suspendedClient!.page)).length).toBe(1)
    await expect(suspendedClient.page.locator('[data-reader-feedback]')).toContainText('not yet confirmed')

    for (const [client, handler] of raceHandlers) {
      await client.context.unroute('**/api/v1/generation-operations', handler)
    }
    const retriedSubmits = retriedClient.records.filter(
      (record) => record.method === 'POST' && record.path === '/api/v1/generation-operations',
    )
    expect(retriedSubmits).toHaveLength(2)
    expect(retriedSubmits.map((record) => record.status)).toEqual([409, 201])
    expect(retriedSubmits[1]!.body).toMatchObject({
      operationId: retriedSubmits[0]!.body!.operationId,
      acceptedMessageId: retriedSubmits[0]!.body!.acceptedMessageId,
      chatOccupancy: retriedSubmits[0]!.body!.chatOccupancy,
    })
    expect(Number(retriedSubmits[1]!.body!.baseRevision)).toBeGreaterThan(Number(retriedSubmits[0]!.body!.baseRevision))

    const retainedDraft = 'Integrated newer draft survives navigation, suspension, owner transfer, and restart.'
    await setRetainedReaderDraft(suspendedClient.page, retainedDraft)
    await openReaderChat(suspendedClient.page, 'Observer Chat', CHAT_OBSERVER)
    await expectOccupancyState(suspendedClient.page, 'switch-required')
    await openReaderChat(
      suspendedClient.page,
      suspendedClient === reader ? 'Reader Chat' : 'Reader Two Chat',
      suspendedClient === reader ? CHAT_READER : CHAT_READER_TWO,
    )
    await expectOccupancyState(suspendedClient.page, 'self-owned')
    await expect(suspendedClient.page.locator('[data-reader-composer-field="message"]')).toHaveValue(retainedDraft)

    suspendedDevtools = await suspendedClient.context.newCDPSession(suspendedClient.page)
    await suspendedClient.context.setOffline(true)
    await suspendedDevtools.send('Page.setWebLifecycleState', { state: 'frozen' })
    await promoteViaUi(observer, owner, harness.dataDir, 2)
    expect(stableOccupancyTuples(harness.dataDir)).toEqual(occupancyBeforeFaults)
    expect(readSharedMutationBoundary(harness.dataDir)).toEqual(sharedBefore)

    const acceptedBeforeRestart = readTruth(harness.dataDir)
    const acceptedOperations = acceptedBeforeRestart.operations.filter((operation) =>
      [CHAT_READER, CHAT_READER_TWO].includes(operation.chat_id as typeof CHAT_READER | typeof CHAT_READER_TWO),
    )
    expect(acceptedOperations).toHaveLength(2)
    expect(new Set(acceptedOperations.map((operation) => operation.operation_id))).toEqual(
      new Set([...initialBodies.values()].map((body) => String(body.operationId))),
    )
    expect(acceptedOperations.every((operation) => operation.state === 'owned_by_job')).toBe(true)

    await restartHarness(harness, provider, () => nowMs)
    await expect.poll(() => [provider.aborts(CHAT_READER), provider.aborts(CHAT_READER_TWO)]).toEqual([1, 1])
    const afterRestart = readTruth(harness.dataDir)
    expect(
      afterRestart.operations
        .filter((operation) => acceptedOperations.some((accepted) => accepted.operation_id === operation.operation_id))
        .map(({ operation_id, state, failure_code }) => ({ operation_id, state, failure_code })),
    ).toEqual(
      acceptedOperations.map(({ operation_id }) => ({
        operation_id,
        state: 'abandoned',
        failure_code: 'server_shutdown',
      })),
    )

    await suspendedDevtools.send('Page.setWebLifecycleState', { state: 'active' })
    await suspendedClient.context.setOffline(false)
    await expect(suspendedClient.page).toHaveURL(
      new RegExp(`${route(suspendedClient === reader ? CHAT_READER : CHAT_READER_TWO)}$`),
    )
    await expect(suspendedClient.page.locator('[data-reader-composer-field="message"]')).toHaveValue(retainedDraft)
    expect(provider.calls(CHAT_READER)).toBe(1)
    expect(provider.calls(CHAT_READER_TWO)).toBe(1)

    await Promise.all(racingClients.map((client) => client.context.close()))
    nowMs += 90_001
    const recoveryReader = await createClient(browser, 'integrated-recovery-reader')
    const recoveryReaderTwo = await createClient(browser, 'integrated-recovery-reader-two')
    clients.push(recoveryReader, recoveryReaderTwo)
    for (const client of [recoveryReader, recoveryReaderTwo])
      client.page.on('pageerror', (error) => pageErrors.push(`${client.name}: ${error.message}`))
    await bootReader(recoveryReader, harness, CHAT_READER)
    await bootReader(recoveryReaderTwo, harness, CHAT_READER_TWO)

    const recoveredClaims = await Promise.all([
      directClaim(recoveryReader.page, CHAT_READER, 'chat_only', 1),
      directClaim(recoveryReaderTwo.page, CHAT_READER_TWO, 'chat_only', 1),
    ])
    for (const claim of recoveredClaims) {
      expect(claim).toMatchObject({
        status: 200,
        body: { occupancyEpoch: 2, claimClass: 'chat_only', state: 'occupied' },
      })
    }
    const recoveredTruth = readTruth(harness.dataDir)
    for (const operation of acceptedOperations) {
      expect(
        recoveredTruth.operations.find((candidate) => candidate.operation_id === operation.operation_id),
      ).toMatchObject({
        state: 'terminal_failed',
        failure_code: 'occupancy_recovery_expired',
        failure_phase: 'occupancy_recovery',
        accepted_message_id: operation.accepted_message_id,
        result_message_id: null,
      })
      expect(
        chatMessages(recoveredTruth, operation.chat_id).filter(
          (message) => message.uid === operation.accepted_message_id,
        ),
      ).toHaveLength(1)
    }
    expect(chatMessages(recoveredTruth, CHAT_READER).map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'char', data: `Seed for ${CHAT_READER}.` },
      { role: 'user', data: 'Integrated reader request.' },
    ])
    expect(chatMessages(recoveredTruth, CHAT_READER_TWO).map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'char', data: `Seed for ${CHAT_READER_TWO}.` },
      { role: 'user', data: 'Integrated second-reader request.' },
    ])
    expect(auditChatOnlyMutations(reader, recoveredTruth, [CHAT_READER]).violations).toEqual([])
    expect(auditChatOnlyMutations(readerTwo, recoveredTruth, [CHAT_READER_TWO]).violations).toEqual([])
    expect(readSharedMutationBoundary(harness.dataDir)).toEqual(sharedBefore)
    expect(readTruth(harness.dataDir).ownership).toMatchObject({
      active_writer_session_id: observer.sessionId,
      writer_epoch: 2,
    })

    const lineage = recoveredTruth.ownership.lineage
    const releases = await Promise.all([
      directTupleMutation(recoveryReader.page, {
        chatId: CHAT_READER,
        databaseLineage: lineage,
        sessionId: recoveryReader.sessionId,
        occupancyEpoch: 2,
        action: 'release',
      }),
      directTupleMutation(recoveryReaderTwo.page, {
        chatId: CHAT_READER_TWO,
        databaseLineage: lineage,
        sessionId: recoveryReaderTwo.sessionId,
        occupancyEpoch: 2,
        action: 'release',
      }),
    ])
    expect(releases).toEqual([
      expect.objectContaining({ status: 200, body: expect.objectContaining({ occupancyEpoch: 3, state: 'released' }) }),
      expect.objectContaining({ status: 200, body: expect.objectContaining({ occupancyEpoch: 3, state: 'released' }) }),
    ])
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('chat-occupancy-integrated-fault-matrix.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          sessions: clients.map(({ name, sessionId }) => ({ name, sessionId })),
          sameBaseRevision: [...initialBodies.values()][0]!.baseRevision,
          initialResults,
          lostAcceptance,
          retriedRequests: retriedSubmits.map(({ request: _request, ...record }) => record),
          suspensionEmulation: ['Page.setWebLifecycleState:frozen', 'BrowserContext.setOffline:true'],
          occupancyBeforeFaults,
          operationsBeforeRestart: acceptedOperations,
          operationsAfterRecovery: recoveredTruth.operations.filter((operation) =>
            acceptedOperations.some((accepted) => accepted.operation_id === operation.operation_id),
          ),
          provider: {
            [CHAT_READER]: { calls: provider.calls(CHAT_READER), aborts: provider.aborts(CHAT_READER) },
            [CHAT_READER_TWO]: {
              calls: provider.calls(CHAT_READER_TWO),
              aborts: provider.aborts(CHAT_READER_TWO),
            },
          },
          retainedDraft,
          releases,
          truth: readTruth(harness.dataDir),
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('chat-occupancy-integrated-fault-matrix', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    if (suspendedDevtools)
      await suspendedDevtools.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => undefined)
    if (suspendedClient) await suspendedClient.context.setOffline(false).catch(() => undefined)
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('a promoted chat-only owner can reacquire, Continue, release, and unblock restore', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(
    CHAT_READER,
    { chunks: ['Promoted owner base reply.'] },
    { chunks: [' Continued after explicit owner reacquisition.'] },
  )
  const harness = await startHarness(provider, 'risu-chat-occupancy-promoted-owner-controls-')
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'owner-before-reader-promotion')
    const promoted = await createClient(browser, 'promoted-chat-only-reader', devices['Pixel 7'])
    clients.push(owner, promoted)
    for (const client of clients)
      client.page.on('pageerror', (error) => pageErrors.push(`${client.name}: ${error.message}`))

    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)
    await bootReader(promoted, harness, CHAT_READER)
    await claimFromUi(promoted)
    await sendFromUi(promoted, 'Create the accepted chat-only base.')
    await expectCompleted(harness.dataDir, CHAT_READER)
    await expect
      .poll(
        () => {
          const truth = readTruth(harness.dataDir)
          const operation = truth.operations.find((candidate) => candidate.chat_id === CHAT_READER)
          const effects = operation
            ? truth.effects.filter((candidate) => candidate.operation_id === operation.operation_id)
            : []
          return (
            operation?.state === 'completed' &&
            effects.length > 0 &&
            effects.every((effect) => ['completed', 'skipped', 'failed'].includes(effect.status))
          )
        },
        { timeout: 30_000 },
      )
      .toBe(true)

    const afterSend = readTruth(harness.dataDir)
    const acceptedSend = afterSend.operations.find((candidate) => candidate.chat_id === CHAT_READER)!
    expect(acceptedSend).toMatchObject({
      mode: 'send',
      creator_writer_session_id: promoted.sessionId,
      admission_kind: 'chat_only',
      occupancy_session_id: promoted.sessionId,
      occupancy_epoch: 1,
      occupancy_claim_class: 'chat_only',
      state: 'completed',
      accepted_message_id: expect.any(String),
      result_message_id: expect.any(String),
    })
    expect(provider.calls(CHAT_READER)).toBe(1)

    await promoteViaUi(promoted, owner, harness.dataDir, 2)
    const promotedSessionId = promoted.sessionId
    await bootOwner(promoted, harness, CHAT_READER)
    expect(promoted.sessionId).toBe(promotedSessionId)
    const ownerServerProjection = await promoted.page.evaluate(async () => {
      const hook = window.__RISU_FASTIFY_BROWSER_SMOKE__!
      const session = hook.getClientSessionSnapshot()
      const headers = {
        ...(await hook.activeWriterHeaders()),
        'risu-database-lineage': session.databaseLineage!,
      }
      const [occupancyResponse, bootstrapResponse] = await Promise.all([
        fetch('/api/v1/chat-occupancies', { cache: 'no-store', headers }),
        fetch('/api/v1/bootstrap', { cache: 'no-store', headers }),
      ])
      return {
        session,
        occupancy: { status: occupancyResponse.status, body: await occupancyResponse.json() },
        bootstrap: { status: bootstrapResponse.status, body: await bootstrapResponse.json() },
      }
    })
    expect(ownerServerProjection).toMatchObject({
      session: {
        lifecycle: 'writing',
        connection: 'live',
        sessionId: promoted.sessionId,
        writer: { sessionId: promoted.sessionId, epoch: 2 },
      },
      occupancy: {
        status: 200,
        body: {
          occupancies: [
            expect.objectContaining({
              chatId: CHAT_READER,
              occupantSessionId: promoted.sessionId,
              occupancyEpoch: 1,
              claimClass: 'chat_only',
              state: 'occupied',
            }),
          ],
        },
      },
      bootstrap: {
        status: 200,
        body: {
          writer: { sessionId: promoted.sessionId, epoch: 2 },
          chatOccupancies: {
            occupancies: [
              expect.objectContaining({
                chatId: CHAT_READER,
                occupantSessionId: promoted.sessionId,
                occupancyEpoch: 1,
                claimClass: 'chat_only',
                state: 'occupied',
              }),
            ],
          },
        },
      },
    })
    const management = promoted.page.locator('[data-owner-chat-occupancy]')
    const promoteOccupancy = promoted.page.locator('[data-owner-occupancy-promote]')
    const releaseOccupancy = promoted.page.locator('[data-owner-occupancy-release]')
    await expect(management).toBeVisible()
    await expect(promoteOccupancy).toBeVisible()
    await expect(promoteOccupancy).toBeEnabled()
    await expect(releaseOccupancy).toBeVisible()
    await expect(releaseOccupancy).toBeEnabled()
    expect(readTruth(harness.dataDir).occupancy).toContainEqual(
      expect.objectContaining({
        chat_id: CHAT_READER,
        occupant_session_id: promoted.sessionId,
        occupancy_epoch: 1,
        claim_class: 'chat_only',
        released_at_ms: null,
      }),
    )
    expect(
      readTruth(harness.dataDir).operations.find((candidate) => candidate.operation_id === acceptedSend.operation_id),
    ).toEqual(acceptedSend)

    const occupancyMutationStart = promoted.records.length
    await promoteOccupancy.click()
    await expect
      .poll(() =>
        readTruth(harness.dataDir).occupancy.find(
          (candidate) => (candidate as Record<string, unknown>).chat_id === CHAT_READER,
        ),
      )
      .toMatchObject({
        chat_id: CHAT_READER,
        occupant_session_id: promoted.sessionId,
        occupancy_epoch: 3,
        claim_class: 'owner',
        released_at_ms: null,
      })
    await expect(promoteOccupancy).toHaveCount(0)
    await expect(releaseOccupancy).toBeEnabled()

    const promotionRequests = promoted.records
      .slice(occupancyMutationStart)
      .filter(
        (record) =>
          (record.method === 'DELETE' && record.path === `/api/v1/chat-occupancies/${CHAT_READER}`) ||
          (record.method === 'POST' && record.path === `/api/v1/chat-occupancies/${CHAT_READER}/claim`),
      )
    expect(promotionRequests).toMatchObject([
      {
        method: 'DELETE',
        path: `/api/v1/chat-occupancies/${CHAT_READER}`,
        headers: {
          'risu-writer-session': promoted.sessionId,
          'risu-chat-occupancy-epoch': '1',
        },
        status: 200,
      },
      {
        method: 'POST',
        path: `/api/v1/chat-occupancies/${CHAT_READER}/claim`,
        headers: {
          'risu-writer-session': promoted.sessionId,
          'risu-chat-occupancy-epoch': '2',
        },
        body: { version: 1, claimClass: 'owner' },
        status: 200,
      },
    ])
    expect(
      readTruth(harness.dataDir).operations.find((candidate) => candidate.operation_id === acceptedSend.operation_id),
    ).toEqual(acceptedSend)

    let continueCompletedBeforeResponse = false
    await promoted.context.route('**/api/v1/generation-operations', async (route) => {
      const request = route.request()
      const body = request.postDataJSON() as Record<string, unknown>
      if (request.method() !== 'POST' || body.mode !== 'continue') return route.continue()
      const response = await route.fetch()
      await expect
        .poll(
          () =>
            readTruth(harness.dataDir).operations.some(
              (candidate) =>
                candidate.chat_id === CHAT_READER && candidate.mode === 'continue' && candidate.state === 'completed',
            ),
          { timeout: 30_000 },
        )
        .toBe(true)
      continueCompletedBeforeResponse = true
      await route.fulfill({ response })
    })
    const continueSubmit = await continueFromOwnerUi(promoted, CHAT_READER)
    expect(continueSubmit.status).toBe(201)
    expect(continueCompletedBeforeResponse).toBe(true)
    const continueOperationId = continueSubmit.body?.operationId
    expect(continueOperationId).toEqual(expect.any(String))
    await expect
      .poll(() =>
        promoted.records.some(
          (record) =>
            record.method === 'GET' &&
            record.path === `/api/v1/generation-operations/${continueOperationId as string}/stream` &&
            record.status === 409,
        ),
      )
      .toBe(true)
    await expect
      .poll(() =>
        promoted.records.some(
          (record) =>
            record.method === 'GET' &&
            record.path === `/api/v1/generation-operations/${continueOperationId as string}` &&
            record.status === 200,
        ),
      )
      .toBe(true)
    await expectCompleted(harness.dataDir, CHAT_READER, 2)
    expect(provider.calls(CHAT_READER)).toBe(2)
    await expect
      .poll(
        () => {
          const truth = readTruth(harness.dataDir)
          const operation = truth.operations.find(
            (candidate) => candidate.chat_id === CHAT_READER && candidate.mode === 'continue',
          )
          const effects = operation
            ? truth.effects.filter((candidate) => candidate.operation_id === operation.operation_id)
            : []
          return {
            operationState: operation?.state,
            hasEffects: effects.length > 0,
            nonterminal: effects
              .filter((effect) => !['completed', 'skipped', 'failed'].includes(effect.status))
              .map((effect) => ({ kind: effect.effect_kind, status: effect.status })),
          }
        },
        { timeout: 30_000 },
      )
      .toEqual({ operationState: 'completed', hasEffects: true, nonterminal: [] })

    const afterContinue = readTruth(harness.dataDir)
    const continued = afterContinue.operations.find(
      (candidate) => candidate.chat_id === CHAT_READER && candidate.mode === 'continue',
    )!
    expect(continued).toMatchObject({
      creator_writer_session_id: promoted.sessionId,
      admission_kind: 'owner_occupancy',
      occupancy_session_id: promoted.sessionId,
      occupancy_epoch: 3,
      occupancy_claim_class: 'owner',
      target_message_id: acceptedSend.result_message_id,
      result_message_id: acceptedSend.result_message_id,
      state: 'completed',
    })
    expect(afterContinue.operations.find((candidate) => candidate.operation_id === acceptedSend.operation_id)).toEqual(
      acceptedSend,
    )
    expect(chatMessages(afterContinue, CHAT_READER).map(({ uid, role, data }) => ({ uid, role, data }))).toEqual([
      { uid: `seed-${CHAT_READER}`, role: 'char', data: `Seed for ${CHAT_READER}.` },
      { uid: acceptedSend.accepted_message_id, role: 'user', data: 'Create the accepted chat-only base.' },
      {
        uid: acceptedSend.result_message_id,
        role: 'char',
        data: 'Promoted owner base reply. Continued after explicit owner reacquisition.',
      },
    ])
    expect(
      promoted.records.filter(
        (record) =>
          record.method === 'POST' &&
          record.path === '/api/v1/generation-operations' &&
          record.body?.chatId === CHAT_READER &&
          (record.body?.chatOccupancy as { interaction?: unknown } | undefined)?.interaction === 'continue',
      ),
    ).toHaveLength(1)

    const blockedRestore = await destructiveImport(promoted.page, fixture())
    expect(blockedRestore).toMatchObject({
      status: 423,
      body: { error: 'chat_occupied', conflictingChatIds: expect.arrayContaining([CHAT_READER]) },
    })
    const lineageBeforeRelease = afterContinue.ownership.lineage
    await releaseOccupancy.click()
    await expect
      .poll(() =>
        readTruth(harness.dataDir).occupancy.find(
          (candidate) => (candidate as Record<string, unknown>).chat_id === CHAT_READER,
        ),
      )
      .toMatchObject({
        chat_id: CHAT_READER,
        occupant_session_id: null,
        occupancy_epoch: 4,
        claim_class: null,
        released_at_ms: expect.any(Number),
      })
    await expect
      .poll(() =>
        promoted.records
          .filter((record) => record.method === 'DELETE' && record.path === `/api/v1/chat-occupancies/${CHAT_READER}`)
          .map((record) => record.status),
      )
      .toEqual([200, 200])
    const releaseRequests = promoted.records.filter(
      (record) => record.method === 'DELETE' && record.path === `/api/v1/chat-occupancies/${CHAT_READER}`,
    )
    expect(releaseRequests).toHaveLength(2)
    expect(releaseRequests[1]).toMatchObject({
      headers: {
        'risu-writer-session': promoted.sessionId,
        'risu-chat-occupancy-epoch': '3',
      },
      status: 200,
    })

    const restored = await destructiveImport(promoted.page, fixture())
    expect(restored.status, JSON.stringify(restored.body)).toBe(200)
    expect(readTruth(harness.dataDir).ownership.lineage).not.toBe(lineageBeforeRelease)
    expect(provider.calls(CHAT_READER)).toBe(2)
    expect(provider.aborts(CHAT_READER)).toBe(0)
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('chat-occupancy-promoted-owner-controls.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          sessions: clients.map(({ name, sessionId }) => ({ name, sessionId })),
          acceptedSend,
          ownerServerProjection,
          promotionRequests: promotionRequests.map(({ request: _request, ...record }) => record),
          continued,
          blockedRestore,
          releaseRequests: releaseRequests.map(({ request: _request, ...record }) => record),
          restored,
          provider: { calls: provider.calls(CHAT_READER), aborts: provider.aborts(CHAT_READER) },
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('chat-occupancy-promoted-owner-controls', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('full-to-targeted character hydration supersession restores one-click Continue readiness', async ({ browser }) => {
  test.setTimeout(120_000)
  const provider = new OccupancyProvider()
  provider.configure(
    CHAT_OWNER,
    { chunks: ['Readiness overlap base reply.'] },
    { chunks: [' continued after readiness recovery.'] },
  )
  const harness = await startHarness(provider, 'risu-chat-occupancy-readiness-overlap-')
  const owner = await createClient(browser, 'readiness-owner')
  const staleName = 'Stale full-refresh character response'
  let detailRequests = 0
  let firstResponseRevision: number | null = null
  let secondResponseRevision: number | null = null
  let releaseFirstResponse!: () => void
  let markFirstResponseReached!: () => void
  let markFirstResponseSettled!: () => void
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve
  })
  const firstResponseReached = new Promise<void>((resolve) => {
    markFirstResponseReached = resolve
  })
  const firstResponseSettled = new Promise<void>((resolve) => {
    markFirstResponseSettled = resolve
  })

  try {
    await bootOwner(owner, harness, CHAT_OWNER)
    const claim = await directClaim(owner.page, CHAT_OWNER, 'owner')
    expect(claim.status, JSON.stringify(claim.body)).toBe(200)
    await sendFromUi(owner, 'Create a continuation base.', true)
    await expectCompleted(harness.dataDir, CHAT_OWNER)
    const baseMessage = chatMessages(readTruth(harness.dataDir), CHAT_OWNER).at(-1)!
    const baseGenerationId = (JSON.parse(baseMessage.json) as { generationInfo?: { generationId?: unknown } })
      .generationInfo?.generationId
    expect(baseGenerationId).toEqual(expect.any(String))
    await expectOwnerGenerationRecoverySettled(owner, harness.dataDir, baseGenerationId as string)

    await owner.page.route(`**/api/v1/characters/${CHARACTER}`, async (intercepted) => {
      const response = await intercepted.fetch()
      const body = (await response.json()) as {
        revision: number
        character: { name: string }
      }
      detailRequests += 1
      if (detailRequests === 1) {
        firstResponseRevision = body.revision
        body.character.name = staleName
        markFirstResponseReached()
        await firstResponseGate
        await intercepted
          .fulfill({
            response,
            contentType: 'application/json',
            body: JSON.stringify(body),
          })
          .catch(() => undefined)
        markFirstResponseSettled()
        return
      }
      secondResponseRevision = body.revision
      await intercepted.fulfill({ response })
    })

    await owner.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.clearAppliedServerResourceRevision())
    const fullRevision = await patchOwnerSettings(owner.page, 'advanced', { useSayNothing: true })
    await firstResponseReached
    expect(firstResponseRevision).toBe(fullRevision)
    await expect
      .poll(() => owner.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getGenerationReadinessDiagnostic()))
      .toMatchObject({ ready: false, blockers: ['chat-dependencies'] })

    const targetedRevision = await patchOwnerSettings(owner.page, 'advanced', { useSayNothing: false })
    expect(targetedRevision).toBe(fullRevision + 1)
    await expect.poll(() => detailRequests).toBe(2)
    expect(secondResponseRevision).toBe(targetedRevision)
    await expect
      .poll(
        () =>
          owner.page.evaluate(() => ({
            readiness: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getGenerationReadinessDiagnostic(),
            characterName: window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().characters[0]?.name,
          })),
        { timeout: 30_000 },
      )
      .toEqual({
        readiness: expect.objectContaining({ ready: true, blockers: [] }),
        characterName: 'Occupancy Interaction Character',
      })

    releaseFirstResponse()
    await firstResponseSettled
    expect(
      await owner.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot().characters[0]?.name),
    ).toBe('Occupancy Interaction Character')

    const continueSubmit = await continueFromOwnerUi(owner, CHAT_OWNER)
    expect(continueSubmit.status).toBe(201)
    await expectCompleted(harness.dataDir, CHAT_OWNER, 2)
    expect(provider.calls(CHAT_OWNER)).toBe(2)
    expect(
      owner.records.filter(
        (record) =>
          record.method === 'POST' &&
          record.path === '/api/v1/generation-operations' &&
          record.body?.chatId === CHAT_OWNER &&
          (record.body?.chatOccupancy as { interaction?: unknown } | undefined)?.interaction === 'continue',
      ),
    ).toHaveLength(1)
    expect(readTruth(harness.dataDir).operations.filter((operation) => operation.mode === 'continue')).toEqual([
      expect.objectContaining({
        chat_id: CHAT_OWNER,
        mode: 'continue',
        admission_kind: 'owner_occupancy',
        occupancy_session_id: owner.sessionId,
        state: 'completed',
      }),
    ])
  } finally {
    releaseFirstResponse?.()
    provider.releaseAll()
    await owner.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('a lost acceptance survives sender disappearance, role transfer, and pinned handoff', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000)
  let nowMs = Date.now()
  const provider = new OccupancyProvider()
  provider.configure(CHAT_READER, { chunks: ['Durable partial', ' survives disappearance.'], holdAfterChunk: 1 })
  const harness = await startHarness(provider, 'risu-chat-occupancy-lost-acceptance-', { now: () => nowMs })
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'owner')
    const sender = await createClient(browser, 'sender', devices['Pixel 7'])
    const successor = await createClient(browser, 'successor')
    clients.push(owner, sender, successor)
    for (const client of clients)
      client.page.on('pageerror', (error) => pageErrors.push(`${client.name}: ${error.message}`))

    await bootOwner(owner, harness, CHAT_READER)
    await configureChats(owner.page)
    await bootReader(sender, harness, CHAT_READER)
    await bootReader(successor, harness, CHAT_READER)
    await claimFromUi(sender)
    const claimed = readTruth(harness.dataDir).occupancy.find(
      (row) => (row as Record<string, unknown>).chat_id === CHAT_READER,
    ) as Record<string, unknown>
    expect(claimed).toMatchObject({
      occupant_session_id: sender.sessionId,
      occupancy_epoch: 1,
      claim_class: 'chat_only',
    })
    const databaseLineage = String(claimed.database_lineage ?? readTruth(harness.dataDir).ownership.lineage)

    let lostAcceptance:
      | { status: number; body: Record<string, unknown>; operationId: string; requestedOperationId: string }
      | undefined
    let resolveLostAcceptance!: () => void
    const lostAcceptanceCommitted = new Promise<void>((resolve) => {
      resolveLostAcceptance = resolve
    })
    let intercepted = false
    const loseAcceptedResponse = async (route: Route) => {
      if (intercepted) return route.continue()
      intercepted = true
      const response = await route.fetch()
      const body = (await response.json()) as Record<string, unknown>
      const operation = body.operation as Record<string, unknown> | undefined
      const requestBody = route.request().postDataJSON() as Record<string, unknown>
      lostAcceptance = {
        status: response.status(),
        body,
        operationId: String(operation?.operationId ?? ''),
        requestedOperationId: String(requestBody.operationId ?? ''),
      }
      resolveLostAcceptance()
      await route.abort('connectionclosed')
    }
    await sender.context.route('**/api/v1/generation-operations', loseAcceptedResponse)
    await sendFromUi(sender, 'Persist this accepted request.')
    await lostAcceptanceCommitted
    expect(lostAcceptance).toMatchObject({
      status: 201,
      body: { operation: { operationId: expect.any(String) } },
      operationId: expect.stringMatching(/\S/u),
      requestedOperationId: expect.stringMatching(/\S/u),
    })
    expect(lostAcceptance!.requestedOperationId).toBe(lostAcceptance!.operationId)
    await expect.poll(() => provider.calls(CHAT_READER)).toBe(1)
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).operations.find(
            (operation) => operation.operation_id === lostAcceptance!.operationId,
          )?.state,
      )
      .toBe('owned_by_job')
    await expect.poll(async () => (await chatOccupancyOutboxRows(sender.page)).length).toBe(1)
    await expect(sender.page.locator('[data-reader-feedback]')).toContainText('not yet confirmed')
    await sender.context.unroute('**/api/v1/generation-operations', loseAcceptedResponse)
    await sender.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(sender.page)
    await expect(sender.page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', CHAT_READER)
    await expectOccupancyState(sender.page, 'self-owned')
    await expect.poll(async () => (await chatOccupancyOutboxRows(sender.page)).length).toBe(0)
    expect(provider.calls(CHAT_READER)).toBe(1)

    const occupancyBeforeRoleTransfer = stableOccupancyTuples(harness.dataDir)
    await promoteViaUi(successor, owner, harness.dataDir, 2)
    expect(stableOccupancyTuples(harness.dataDir)).toEqual(occupancyBeforeRoleTransfer)
    expect(provider.calls(CHAT_READER)).toBe(1)

    await sender.context.close()
    nowMs += 90_001
    const blockedHandoff = await directClaim(successor.page, CHAT_READER, 'owner', 1)
    expect(blockedHandoff).toMatchObject({
      status: 409,
      body: {
        error: 'chat_occupancy_recovery_blocked',
        blocking: expect.arrayContaining([
          expect.objectContaining({ id: lostAcceptance!.operationId, kind: expect.any(String) }),
        ]),
      },
    })
    expect(provider.calls(CHAT_READER)).toBe(1)

    const lineageBeforeDestructiveAttempt = readTruth(harness.dataDir).ownership.lineage
    const destructiveWhilePinned = await destructiveImport(successor.page, fixture())
    expect(destructiveWhilePinned).toMatchObject({
      status: 423,
      body: {
        error: 'chat_occupied',
        conflictingChatIds: expect.arrayContaining([CHAT_READER]),
      },
    })
    expect(readTruth(harness.dataDir).ownership.lineage).toBe(lineageBeforeDestructiveAttempt)
    expect(provider.calls(CHAT_READER)).toBe(1)

    provider.release(CHAT_READER)
    await expectCompleted(harness.dataDir, CHAT_READER)
    const completed = readTruth(harness.dataDir)
    const operation = completed.operations.find((candidate) => candidate.operation_id === lostAcceptance!.operationId)!
    expect(operation).toMatchObject({
      state: 'completed',
      occupancy_session_id: sender.sessionId,
      occupancy_epoch: 1,
      occupancy_claim_class: 'chat_only',
    })
    expect(chatMessages(completed, CHAT_READER).map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'char', data: `Seed for ${CHAT_READER}.` },
      { role: 'user', data: 'Persist this accepted request.' },
      { role: 'char', data: 'Durable partial survives disappearance.' },
    ])
    expect(provider.calls(CHAT_READER)).toBe(1)

    const handedOff = await directClaim(successor.page, CHAT_READER, 'owner', 1)
    expect(handedOff).toMatchObject({
      status: 200,
      body: {
        occupantSessionId: successor.sessionId,
        occupancyEpoch: 2,
        claimClass: 'owner',
        state: 'occupied',
      },
    })
    const delayedSenderRelease = await directTupleMutation(successor.page, {
      chatId: CHAT_READER,
      databaseLineage,
      sessionId: sender.sessionId,
      occupancyEpoch: 1,
      action: 'release',
    })
    expect(delayedSenderRelease).toMatchObject({ status: 409, body: { error: 'chat_occupancy_stale' } })
    expect(readTruth(harness.dataDir).occupancy).toContainEqual(
      expect.objectContaining({
        chat_id: CHAT_READER,
        occupant_session_id: successor.sessionId,
        occupancy_epoch: 2,
        claim_class: 'owner',
        released_at_ms: null,
      }),
    )
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('chat-occupancy-lost-acceptance-handoff.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          sessions: clients.map(({ name, sessionId }) => ({ name, sessionId })),
          lostAcceptance,
          occupancyBeforeRoleTransfer,
          blockedHandoff,
          destructiveWhilePinned,
          handedOff,
          delayedSenderRelease,
          provider: { calls: provider.calls(CHAT_READER), aborts: provider.aborts(CHAT_READER) },
          truth: readTruth(harness.dataDir),
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('chat-occupancy-lost-acceptance-handoff', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('an accepted owner Send settles after same-tuple chat-only normalization without redispatch', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_READER, {
    chunks: ['Normalized owner partial', ' completes once.'],
    holdAfterChunk: 1,
  })
  const harness = await startHarness(provider, 'risu-chat-occupancy-normalized-send-')
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const sender = await createClient(browser, 'normalized-send-sender', devices['Pixel 7'])
    const successor = await createClient(browser, 'normalized-send-successor')
    clients.push(sender, successor)
    for (const client of clients)
      client.page.on('pageerror', (error) => pageErrors.push(`${client.name}: ${error.message}`))

    await bootOwner(sender, harness, CHAT_READER)
    await configureChats(sender.page)
    const ownerClaim = await directClaim(sender.page, CHAT_READER, 'owner')
    expect(ownerClaim).toMatchObject({ status: 200, body: { occupancyEpoch: 1, claimClass: 'owner' } })
    await sender.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(sender.page)
    await sender.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await expect(sender.page.getByTestId('default-chat-composer')).toBeVisible()
    await bootReader(successor, harness, CHAT_READER)

    let lostAcceptance:
      | { status: number; body: Record<string, unknown>; operationId: string; requestedOperationId: string }
      | undefined
    let resolveLostAcceptance!: () => void
    const lostAcceptanceCommitted = new Promise<void>((resolve) => {
      resolveLostAcceptance = resolve
    })
    const loseAcceptedResponse = async (route: Route) => {
      const response = await route.fetch()
      const body = (await response.json()) as Record<string, unknown>
      const operation = body.operation as Record<string, unknown> | undefined
      const requestBody = route.request().postDataJSON() as Record<string, unknown>
      lostAcceptance = {
        status: response.status(),
        body,
        operationId: String(operation?.operationId ?? ''),
        requestedOperationId: String(requestBody.operationId ?? ''),
      }
      resolveLostAcceptance()
      await route.abort('connectionclosed')
    }
    await sender.context.route('**/api/v1/generation-operations', loseAcceptedResponse)
    await sendFromUi(sender, 'Recover this accepted owner Send.', true)
    await lostAcceptanceCommitted
    expect(lostAcceptance).toMatchObject({
      status: 201,
      body: {
        operation: {
          requestOrigin: 'accepted_send',
          generationScope: { admissionKind: 'owner_occupancy', occupancyClaimClass: 'owner' },
        },
      },
      operationId: expect.stringMatching(/\S/u),
    })
    expect(lostAcceptance!.requestedOperationId).toBe(lostAcceptance!.operationId)
    await expect.poll(() => provider.calls(CHAT_READER)).toBe(1)
    await expect.poll(async () => (await chatOccupancyOutboxRows(sender.page)).length).toBe(1)
    await sender.context.unroute('**/api/v1/generation-operations', loseAcceptedResponse)

    let blockedStatusReads = 0
    const blockRecoveryStatus = async (route: Route) => {
      const url = new URL(route.request().url())
      if (
        route.request().method() === 'GET' &&
        url.pathname === `/api/v1/generation-operations/${lostAcceptance!.operationId}`
      ) {
        blockedStatusReads += 1
        await route.abort('connectionclosed')
        return
      }
      await route.continue()
    }
    await sender.context.route('**/api/v1/generation-operations/*', blockRecoveryStatus)
    await promoteViaUi(successor, sender, harness.dataDir, 2)
    await sender.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(sender.page)
    await expect(sender.page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', CHAT_READER)
    await expectOccupancyState(sender.page, 'normalization-required')
    await expect.poll(() => blockedStatusReads).toBeGreaterThan(0)
    await sender.page.locator('[data-reader-occupancy-normalize]').click()
    await expectOccupancyState(sender.page, 'self-owned')
    const normalizedOccupancy = readTruth(harness.dataDir).occupancy.find(
      (candidate) => (candidate as Record<string, unknown>).chat_id === CHAT_READER,
    ) as Record<string, unknown>
    expect(normalizedOccupancy).toMatchObject({
      occupant_session_id: sender.sessionId,
      occupancy_epoch: 1,
      claim_class: 'chat_only',
      released_at_ms: null,
    })
    await expect.poll(async () => (await chatOccupancyOutboxRows(sender.page)).length).toBe(1)
    const newerDraft = 'A newer draft survives normalized accepted-Send recovery.'
    await setRetainedReaderDraft(sender.page, newerDraft)

    await sender.context.unroute('**/api/v1/generation-operations/*', blockRecoveryStatus)
    await sender.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(sender.page)
    await expect(sender.page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', CHAT_READER)
    await expectOccupancyState(sender.page, 'self-owned')
    await expect.poll(async () => (await chatOccupancyOutboxRows(sender.page)).length).toBe(0)
    await expect(sender.page.locator('[data-reader-composer-field="message"]')).toHaveValue(newerDraft)
    expect(provider.calls(CHAT_READER)).toBe(1)
    expect(
      sender.records.filter((record) => record.method === 'POST' && record.path === '/api/v1/generation-operations'),
    ).toHaveLength(1)
    expect(
      readTruth(harness.dataDir).operations.find((candidate) => candidate.operation_id === lostAcceptance!.operationId),
    ).toMatchObject({
      admission_kind: 'owner_occupancy',
      occupancy_session_id: sender.sessionId,
      occupancy_epoch: 1,
      occupancy_claim_class: 'owner',
      state: 'owned_by_job',
    })

    provider.release(CHAT_READER)
    await expectCompleted(harness.dataDir, CHAT_READER)
    const terminalTruth = readTruth(harness.dataDir)
    expect(chatMessages(terminalTruth, CHAT_READER).map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'char', data: `Seed for ${CHAT_READER}.` },
      { role: 'user', data: 'Recover this accepted owner Send.' },
      { role: 'char', data: 'Normalized owner partial completes once.' },
    ])
    expect(provider.calls(CHAT_READER)).toBe(1)
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('chat-occupancy-normalized-owner-send.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          sessions: clients.map(({ name, sessionId }) => ({ name, sessionId })),
          lostAcceptance,
          blockedStatusReads,
          normalizedOccupancy,
          newerDraft,
          provider: { calls: provider.calls(CHAT_READER), aborts: provider.aborts(CHAT_READER) },
          truth: terminalTruth,
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('chat-occupancy-normalized-owner-send', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('a real Fastify restart terminalizes expired accepted work without resubmission and lineage fences old tuples', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000)
  let nowMs = Date.now()
  const provider = new OccupancyProvider()
  provider.configure(CHAT_STOP, { chunks: ['Restart partial', ' must never be replayed.'], holdAfterChunk: 1 })
  const harness = await startHarness(provider, 'risu-chat-occupancy-restart-', { now: () => nowMs })
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'owner-before-restart')
    const sender = await createClient(browser, 'sender-before-restart', devices['Pixel 7'])
    clients.push(owner, sender)
    for (const client of clients)
      client.page.on('pageerror', (error) => pageErrors.push(`${client.name}: ${error.message}`))

    await bootOwner(owner, harness, CHAT_STOP)
    await configureChats(owner.page)
    await bootReader(sender, harness, CHAT_STOP)
    await claimFromUi(sender)
    await sendFromUi(sender, 'Accepted before restart.')
    await expect.poll(() => provider.calls(CHAT_STOP)).toBe(1)
    const beforeRestart = readTruth(harness.dataDir)
    const operation = beforeRestart.operations.find((candidate) => candidate.chat_id === CHAT_STOP)!
    expect(operation).toMatchObject({
      state: 'owned_by_job',
      occupancy_session_id: sender.sessionId,
      occupancy_epoch: 1,
      occupancy_claim_class: 'chat_only',
      accepted_message_id: expect.any(String),
    })
    const lineageBeforeRestart = beforeRestart.ownership.lineage
    const ownerSessionId = owner.sessionId

    await Promise.all([owner.context.close(), sender.context.close()])
    await restartHarness(harness, provider, () => nowMs)
    expect(provider.calls(CHAT_STOP)).toBe(1)
    expect(provider.aborts(CHAT_STOP)).toBe(1)
    expect(
      readTruth(harness.dataDir).operations.find((candidate) => candidate.operation_id === operation.operation_id),
    ).toMatchObject({
      state: 'abandoned',
      failure_code: 'server_shutdown',
      accepted_message_id: operation.accepted_message_id,
      result_message_id: null,
    })

    const recovery = await createClient(browser, 'recovery-after-restart')
    clients.push(recovery)
    recovery.page.on('pageerror', (error) => pageErrors.push(`${recovery.name}: ${error.message}`))
    await bootReader(recovery, harness, CHAT_STOP)
    await expectOccupancyState(recovery.page, 'foreign-owned')
    nowMs += 90_001

    const recoveredClaim = await directClaim(recovery.page, CHAT_STOP, 'chat_only', 1)
    expect(recoveredClaim).toMatchObject({
      status: 200,
      body: {
        occupantSessionId: recovery.sessionId,
        occupancyEpoch: 2,
        claimClass: 'chat_only',
        state: 'occupied',
      },
    })
    const afterRecovery = readTruth(harness.dataDir)
    expect(
      afterRecovery.operations.find((candidate) => candidate.operation_id === operation.operation_id),
    ).toMatchObject({
      state: 'terminal_failed',
      failure_code: 'occupancy_recovery_expired',
      failure_phase: 'occupancy_recovery',
      accepted_message_id: operation.accepted_message_id,
      result_message_id: null,
    })
    expect(
      chatMessages(afterRecovery, CHAT_STOP).filter((message) => message.uid === operation.accepted_message_id),
    ).toMatchObject([{ role: 'user', data: 'Accepted before restart.' }])
    expect(provider.calls(CHAT_STOP)).toBe(1)

    const released = await directTupleMutation(recovery.page, {
      chatId: CHAT_STOP,
      databaseLineage: lineageBeforeRestart,
      sessionId: recovery.sessionId,
      occupancyEpoch: 2,
      action: 'release',
    })
    expect(released).toMatchObject({ status: 200, body: { occupancyEpoch: 3, state: 'released' } })

    const restoredOwner = await createClient(browser, 'owner-after-restart')
    clients.push(restoredOwner)
    restoredOwner.page.on('pageerror', (error) => pageErrors.push(`${restoredOwner.name}: ${error.message}`))
    await restoredOwner.context.addInitScript(({ key, sessionId }) => sessionStorage.setItem(key, sessionId), {
      key: SESSION_KEY,
      sessionId: ownerSessionId,
    })
    await bootOwner(restoredOwner, harness, CHAT_STOP)
    expect(restoredOwner.sessionId).toBe(ownerSessionId)
    const replaced = await destructiveImport(restoredOwner.page, fixture())
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200)
    const lineageAfterReplacement = readTruth(harness.dataDir).ownership.lineage
    expect(lineageAfterReplacement).not.toBe(lineageBeforeRestart)

    const oldLineageRenewal = await directTupleMutation(recovery.page, {
      chatId: CHAT_STOP,
      databaseLineage: lineageBeforeRestart,
      sessionId: recovery.sessionId,
      occupancyEpoch: 2,
      action: 'renew',
    })
    expect(oldLineageRenewal).toMatchObject({ status: 409, body: { error: 'chat_occupancy_stale' } })
    expect(readTruth(harness.dataDir).occupancy).toEqual([])
    expect(provider.calls(CHAT_STOP)).toBe(1)
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('chat-occupancy-server-restart.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          sessions: clients.map(({ name, sessionId }) => ({ name, sessionId })),
          lineageBeforeRestart,
          lineageAfterReplacement,
          operationBeforeRestart: operation,
          operationAfterRestart: readTruth(harness.dataDir).operations.find(
            (candidate) => candidate.operation_id === operation.operation_id,
          ),
          recoveredClaim,
          released,
          oldLineageRenewal,
          provider: { calls: provider.calls(CHAT_STOP), aborts: provider.aborts(CHAT_STOP) },
          truthAfterReplacement: readTruth(harness.dataDir),
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('chat-occupancy-server-restart', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})
