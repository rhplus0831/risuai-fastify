import { devices, expect, test, type Route } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { closeFastBootstrapHarness } from './fastBootstrapHarness.js'
import {
  CHAT_OWNER,
  CHAT_READER,
  CHAT_READER_TWO,
  CHAT_STOP,
  CHAT_OBSERVER,
  CHAT_CONFLICT,
  ALL_CHATS,
  SESSION_KEY,
  OccupancyProvider,
  type Client,
  route,
  readTruth,
  readSharedMutationBoundary,
  startHarness,
  createClient,
  waitForHook,
  bootOwner,
  bootReader,
  configureChats,
  directClaim,
  directOccupancySnapshot,
  directTupleMutation,
  appendOwnerMessage,
  patchOwnerSettings,
  rejectForeignMutationControls,
  expectOccupancyState,
  promoteViaUi,
  stableOccupancyTuples,
  claimFromUi,
  sendFromUi,
  continueFromOwnerUi,
  expectOwnerGenerationRecoverySettled,
  openReaderChat,
  chatMessages,
  alternateChatMessages,
  expectCompleted,
  expectSubmitAuthority,
  auditChatOnlyMutations,
} from './chatOccupancyHarness.js'

test('owner, two chat-only senders, and an observer remain independently scoped', async ({ browser }, testInfo) => {
  test.setTimeout(240_000)
  const provider = new OccupancyProvider()
  provider.configure(
    CHAT_OWNER,
    { chunks: ['Owner partial', ' reply.'], holdAfterChunk: 1 },
    { chunks: [' continued.'] },
    { chunks: [' appended.'] },
  )
  provider.configure(
    CHAT_READER,
    { chunks: ['Reader partial', ' reply.'], holdAfterChunk: 1 },
    { chunks: ['Reader concurrent partial', ' reply.'], holdAfterChunk: 1 },
    { chunks: ['Reader rerolled reply.'] },
    { chunks: ['Stopped partial', ' must not finish.'], holdAfterChunk: 1 },
  )
  provider.configure(
    CHAT_READER_TWO,
    { chunks: ['Second reader partial', ' reply.'], holdAfterChunk: 1 },
    { chunks: ['Second reader rerolled reply.'] },
    { chunks: ['Second reader stopped', ' must not finish.'], holdAfterChunk: 1 },
  )
  provider.configure(CHAT_STOP, { chunks: ['Switched chat reply.'] })
  const harness = await startHarness(provider, 'risu-chat-occupancy-interaction-')
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'owner')
    const reader = await createClient(browser, 'reader-mobile', devices['Pixel 7'])
    const readerTwo = await createClient(browser, 'reader-desktop')
    const observer = await createClient(browser, 'observer')
    clients.push(owner, reader, readerTwo, observer)
    for (const client of clients)
      client.page.on('pageerror', (error) => pageErrors.push(`${client.name}: ${error.message}`))

    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)
    await bootReader(reader, harness, CHAT_READER)
    await bootReader(readerTwo, harness, CHAT_READER_TWO)
    await bootReader(observer, harness, CHAT_OBSERVER)
    expect(new Set(clients.map((client) => client.sessionId)).size).toBe(4)

    await claimFromUi(reader)
    await claimFromUi(readerTwo)
    for (const chatOnly of [reader, readerTwo]) {
      await expect(chatOnly.page.locator('[data-reader-composer-reroll]')).toBeVisible()
      await expect(chatOnly.page.locator('[data-reader-composer-menu]')).toBeDisabled()
      await expect(chatOnly.page.locator('[data-reader-deferred-actions]')).toContainText('Continue')
      await expect(chatOnly.page.locator('[data-reader-deferred-actions]')).toContainText('Regenerate')
      await expect(chatOnly.page.locator('[data-reader-composer-attachment]')).toBeDisabled()
      await expect(chatOnly.page.locator('[data-risu-message-action="regenerate"]')).toHaveCount(0)
    }
    // Measure the touch targets in Chromium; utility class names alone cannot
    // prove that the mobile composer remains usable.
    for (const selector of [
      '[data-reader-composer-field="message"]',
      '[data-reader-composer-send]',
      '[data-reader-composer-reroll]',
      '[data-reader-occupancy-release]',
    ]) {
      const control = reader.page.locator(selector)
      await expect(control).toBeVisible()
      const box = await control.boundingBox()
      expect(box?.height, selector).toBeGreaterThanOrEqual(44)
    }
    expect(reader.page.viewportSize()?.width).toBeLessThan(600)
    expect(readerTwo.page.viewportSize()?.width).toBeGreaterThan(1_000)
    const ownerClaim = await directClaim(owner.page, CHAT_OWNER, 'owner')
    expect(ownerClaim.status, JSON.stringify(ownerClaim.body)).toBe(200)
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(owner.page)
    await owner.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await expect(owner.page.getByTestId('default-chat-composer')).toBeVisible()
    expect(await owner.page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)).toBe(owner.sessionId)

    await expectOccupancyState(observer.page, 'available')
    await expect(observer.page.locator('[data-reader-composer-field="message"]')).toBeDisabled()
    const sharedBefore = readSharedMutationBoundary(harness.dataDir)
    const ownerTupleBefore = readTruth(harness.dataDir).ownership

    await Promise.all([sendFromUi(reader, 'Reader request.'), sendFromUi(readerTwo, 'Second reader request.')])
    await expect.poll(() => [provider.calls(CHAT_READER), provider.calls(CHAT_READER_TWO)]).toEqual([1, 1])
    provider.release(CHAT_READER)
    provider.release(CHAT_READER_TWO)
    await Promise.all([
      expectCompleted(harness.dataDir, CHAT_READER),
      expectCompleted(harness.dataDir, CHAT_READER_TWO),
    ])

    const chatOnlyTruth = readTruth(harness.dataDir)
    for (const [chatId, sessionId, request, reply] of [
      [CHAT_READER, reader.sessionId, 'Reader request.', 'Reader partial reply.'],
      [CHAT_READER_TWO, readerTwo.sessionId, 'Second reader request.', 'Second reader partial reply.'],
    ] as const) {
      const operation = chatOnlyTruth.operations.find((candidate) => candidate.chat_id === chatId)!
      expect(operation).toMatchObject({
        creator_writer_session_id: sessionId,
        admission_kind: 'chat_only',
        occupancy_session_id: sessionId,
        occupancy_claim_class: 'chat_only',
        state: 'completed',
      })
      expect(operation.occupancy_epoch).toEqual(expect.any(Number))
      expect(chatMessages(chatOnlyTruth, chatId).map(({ uid, role, data }) => ({ uid, role, data }))).toEqual([
        { uid: `seed-${chatId}`, role: 'char', data: `Seed for ${chatId}.` },
        { uid: operation.accepted_message_id, role: 'user', data: request },
        { uid: operation.result_message_id, role: 'char', data: reply },
      ])
    }
    expect(provider.calls(CHAT_READER)).toBe(1)
    expect(provider.calls(CHAT_READER_TWO)).toBe(1)
    expect(chatOnlyTruth.effects.every((effect) => ['pending', 'skipped'].includes(String(effect.status)))).toBe(true)
    const chatOnlyIgps = chatOnlyTruth.effects.filter((effect) => String(effect.effect_kind) === 'igp')
    expect(chatOnlyIgps).toHaveLength(2)
    expect(chatOnlyIgps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chat_id: CHAT_READER,
          effect_class: 'durable',
          status: 'skipped',
          reason: 'not_configured',
        }),
        expect.objectContaining({
          chat_id: CHAT_READER_TWO,
          effect_class: 'durable',
          status: 'skipped',
          reason: 'not_configured',
        }),
      ]),
    )
    expect(
      chatOnlyTruth.effects.filter((effect) =>
        ['emotion_image_state', 'plugin_output'].includes(String(effect.effect_kind)),
      ),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'skipped', reason: 'unsupported_chat_only_scope' })]),
    )
    expect(readSharedMutationBoundary(harness.dataDir)).toEqual(sharedBefore)
    expect(readTruth(harness.dataDir).ownership).toEqual(ownerTupleBefore)
    expect(ownerTupleBefore).toMatchObject({ active_writer_session_id: owner.sessionId, writer_epoch: 1 })
    expect(
      await owner.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot()),
    ).toMatchObject({
      lifecycle: 'writing',
      sessionId: owner.sessionId,
    })

    const retainedDraft = 'Occupied draft survives foreign events, refresh, and detach.'
    await reader.page.locator('[data-reader-composer-field="message"]').fill(retainedDraft)
    const observerMessageId = 'occupancy-observer-live-message'
    const observerMessage = 'Owner event remains scoped to the observed transcript.'
    await appendOwnerMessage(owner.page, CHAT_OBSERVER, observerMessageId, observerMessage)
    await expect(
      observer.page.locator(`.risu-chat[data-risu-message-id="${observerMessageId}"] .chat-message-body`),
    ).toContainText(observerMessage)
    await expect(observer.page).toHaveURL(new RegExp(`${route(CHAT_OBSERVER)}$`))
    await expect(reader.page).toHaveURL(new RegExp(`${route(CHAT_READER)}$`))
    await expect(reader.page.locator('[data-reader-composer-field="message"]')).toHaveValue(retainedDraft)
    await reader.page.locator('[data-reader-refresh]').click()
    await expect(reader.page.locator('[data-reader-composer-field="message"]')).toHaveValue(retainedDraft)
    await openReaderChat(reader.page, 'Observer Chat', CHAT_OBSERVER)
    await expectOccupancyState(reader.page, 'switch-required')
    await openReaderChat(reader.page, 'Reader Chat', CHAT_READER)
    await expectOccupancyState(reader.page, 'self-owned')
    await expect(reader.page.locator('[data-reader-composer-field="message"]')).toHaveValue(retainedDraft)
    await reader.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(reader.page)
    await expect(reader.page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', CHAT_READER)
    await expectOccupancyState(reader.page, 'self-owned')
    await expect(reader.page.locator('[data-reader-composer-field="message"]')).toHaveValue(retainedDraft)
    expect(await reader.page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)).toBe(reader.sessionId)
    await observer.page.locator('[data-reader-refresh]').click()
    await expect(observer.page).toHaveURL(new RegExp(`${route(CHAT_OBSERVER)}$`))
    expect(
      observer.records.filter(
        (record) =>
          /\/chat-occupancies\/[^/]+\/(?:claim|lease)$/u.test(record.path) ||
          record.path === '/api/v1/chat-occupancies/switch' ||
          record.path === '/api/v1/generation-operations' ||
          record.path.includes('/cancellation') ||
          record.path.includes('/generation-effects/'),
      ),
    ).toEqual([])
    expect(readSharedMutationBoundary(harness.dataDir)).toEqual(sharedBefore)
    expect(readTruth(harness.dataDir).ownership).toEqual(ownerTupleBefore)

    await Promise.all([sendFromUi(owner, 'Owner request.', true), sendFromUi(reader, 'Reader concurrent request.')])
    await expect.poll(() => [provider.calls(CHAT_OWNER), provider.calls(CHAT_READER)]).toEqual([1, 2])
    provider.release(CHAT_OWNER)
    provider.release(CHAT_READER, 2)
    await Promise.all([expectCompleted(harness.dataDir, CHAT_OWNER), expectCompleted(harness.dataDir, CHAT_READER, 2)])
    const ownerAndReaderTruth = readTruth(harness.dataDir)
    const ownerOperation = ownerAndReaderTruth.operations.find((candidate) => candidate.chat_id === CHAT_OWNER)!
    expect(ownerOperation).toMatchObject({
      creator_writer_session_id: owner.sessionId,
      admission_kind: 'owner_occupancy',
      occupancy_session_id: owner.sessionId,
      occupancy_claim_class: 'owner',
      state: 'completed',
    })
    expect(chatMessages(ownerAndReaderTruth, CHAT_OWNER).map(({ uid, role, data }) => ({ uid, role, data }))).toEqual([
      { uid: `seed-${CHAT_OWNER}`, role: 'char', data: `Seed for ${CHAT_OWNER}.` },
      { uid: ownerOperation.accepted_message_id, role: 'user', data: 'Owner request.' },
      { uid: ownerOperation.result_message_id, role: 'char', data: 'Owner partial reply.' },
    ])
    const readerOperationsAfterConcurrent = ownerAndReaderTruth.operations.filter(
      (operation) => operation.chat_id === CHAT_READER,
    )
    expect(readerOperationsAfterConcurrent).toHaveLength(2)
    expect(
      chatMessages(ownerAndReaderTruth, CHAT_READER).map(({ uid, role, data, alternate }) => ({
        uid,
        role,
        data,
        alternate,
      })),
    ).toEqual([
      { uid: `seed-${CHAT_READER}`, role: 'char', data: `Seed for ${CHAT_READER}.`, alternate: 0 },
      {
        uid: readerOperationsAfterConcurrent[0]!.accepted_message_id,
        role: 'user',
        data: 'Reader request.',
        alternate: 0,
      },
      {
        uid: readerOperationsAfterConcurrent[0]!.result_message_id,
        role: 'char',
        data: 'Reader partial reply.',
        alternate: 0,
      },
      {
        uid: readerOperationsAfterConcurrent[1]!.accepted_message_id,
        role: 'user',
        data: 'Reader concurrent request.',
        alternate: 0,
      },
      {
        uid: readerOperationsAfterConcurrent[1]!.result_message_id,
        role: 'char',
        data: 'Reader concurrent partial reply.',
        alternate: 0,
      },
    ])

    const initialOwnerAssistant = chatMessages(ownerAndReaderTruth, CHAT_OWNER).at(-1)!
    const initialOwnerGenerationInfo = (
      JSON.parse(initialOwnerAssistant.json) as {
        generationInfo?: { generationId?: unknown; operationId?: unknown }
      }
    ).generationInfo
    expect(initialOwnerGenerationInfo).toEqual(
      expect.objectContaining({
        operationId: ownerOperation.operation_id,
        generationId: expect.any(String),
      }),
    )
    await expectOwnerGenerationRecoverySettled(
      owner,
      harness.dataDir,
      initialOwnerGenerationInfo!.generationId as string,
    )
    const extendSubmit = await continueFromOwnerUi(owner, CHAT_OWNER)
    await expectCompleted(harness.dataDir, CHAT_OWNER, 2)
    expect(provider.calls(CHAT_OWNER)).toBe(2)
    await expect(owner.page.locator('.default-chat-screen')).toContainText('Owner partial reply. continued.')
    const afterOwnerExtend = readTruth(harness.dataDir)
    const ownerOperationsAfterExtend = afterOwnerExtend.operations.filter(
      (operation) => operation.chat_id === CHAT_OWNER,
    )
    expect(ownerOperationsAfterExtend).toHaveLength(2)
    const extendOperation = ownerOperationsAfterExtend[1]!
    expect(extendOperation).toMatchObject({
      mode: 'continue',
      creator_writer_session_id: owner.sessionId,
      admission_kind: 'owner_occupancy',
      occupancy_session_id: owner.sessionId,
      occupancy_epoch: ownerOperation.occupancy_epoch,
      occupancy_claim_class: 'owner',
      target_message_id: ownerOperation.result_message_id,
      result_message_id: ownerOperation.result_message_id,
      state: 'completed',
    })
    const extendedOwnerMessages = chatMessages(afterOwnerExtend, CHAT_OWNER)
    expect(extendedOwnerMessages.map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'char', data: `Seed for ${CHAT_OWNER}.` },
      { role: 'user', data: 'Owner request.' },
      { role: 'char', data: 'Owner partial reply. continued.' },
    ])
    expect((JSON.parse(extendedOwnerMessages.at(-1)!.json) as { generationInfo?: unknown }).generationInfo).toEqual(
      initialOwnerGenerationInfo,
    )
    await patchOwnerSettings(owner.page, 'advanced', { useSayNothing: true })
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(owner.page)
    await owner.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await expect(owner.page.getByTestId('default-chat-composer')).toBeVisible()
    expect(await owner.page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)).toBe(owner.sessionId)

    const appendSubmit = await continueFromOwnerUi(owner, CHAT_OWNER, 2)
    await expectCompleted(harness.dataDir, CHAT_OWNER, 3)
    expect(provider.calls(CHAT_OWNER)).toBe(3)
    await expect(owner.page.locator('.default-chat-screen')).toContainText('says nothing appended.')
    const afterOwnerAppend = readTruth(harness.dataDir)
    const ownerOperationsAfterAppend = afterOwnerAppend.operations.filter(
      (operation) => operation.chat_id === CHAT_OWNER,
    )
    expect(ownerOperationsAfterAppend).toHaveLength(3)
    const appendOperation = ownerOperationsAfterAppend[2]!
    expect(appendOperation).toMatchObject({
      mode: 'continue',
      creator_writer_session_id: owner.sessionId,
      admission_kind: 'owner_occupancy',
      occupancy_session_id: owner.sessionId,
      occupancy_epoch: ownerOperation.occupancy_epoch,
      occupancy_claim_class: 'owner',
      target_message_id: ownerOperation.result_message_id,
      result_message_id: expect.any(String),
      state: 'completed',
    })
    expect(appendOperation.result_message_id).not.toBe(appendOperation.target_message_id)
    const appendedOwnerMessages = chatMessages(afterOwnerAppend, CHAT_OWNER)
    expect(appendedOwnerMessages.map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'char', data: `Seed for ${CHAT_OWNER}.` },
      { role: 'user', data: 'Owner request.' },
      { role: 'char', data: 'Owner partial reply. continued.' },
      { role: 'char', data: '*says nothing* appended.' },
    ])
    expect((JSON.parse(appendedOwnerMessages[2]!.json) as { generationInfo?: unknown }).generationInfo).toEqual(
      initialOwnerGenerationInfo,
    )
    expect(
      (JSON.parse(appendedOwnerMessages[3]!.json) as { generationInfo?: Record<string, unknown> }).generationInfo,
    ).toMatchObject({ operationId: appendOperation.operation_id, generationId: expect.any(String) })
    expect(extendSubmit.headers['risu-chat-occupancy-epoch']).toBe(String(ownerOperation.occupancy_epoch))
    expect(appendSubmit.headers['risu-chat-occupancy-epoch']).toBe(String(ownerOperation.occupancy_epoch))

    expect(readTruth(harness.dataDir).ownership).toEqual(ownerTupleBefore)
    const sharedAfterOwnerAndReader = readSharedMutationBoundary(harness.dataDir)

    await expect(reader.page.locator('[data-reader-composer-reroll]')).toBeVisible()
    await reader.page.locator('[data-reader-composer-reroll]').click()
    await expectCompleted(harness.dataDir, CHAT_READER, 3)
    expect(provider.calls(CHAT_READER)).toBe(3)
    await expectSubmitAuthority(reader, CHAT_READER, 'reroll')
    const afterReroll = readTruth(harness.dataDir)
    expect(chatMessages(afterReroll, CHAT_READER)).toHaveLength(5)
    expect(chatMessages(afterReroll, CHAT_READER).at(-1)?.data).toBe('Reader rerolled reply.')
    const readerOperations = afterReroll.operations.filter((operation) => operation.chat_id === CHAT_READER)
    expect(alternateChatMessages(afterReroll, CHAT_READER).map(({ uid, role, data }) => ({ uid, role, data }))).toEqual(
      [
        { uid: readerOperations[2]!.result_message_id, role: 'char', data: 'Reader rerolled reply.' },
        { uid: readerOperations[1]!.result_message_id, role: 'char', data: 'Reader concurrent partial reply.' },
      ],
    )

    await sendFromUi(reader, 'Stop this request.')
    await expect.poll(() => provider.calls(CHAT_READER)).toBe(4)
    await expect(
      reader.page.locator('[data-reader-transcript] .chat-message-body').filter({ hasText: 'Stopped partial' }),
    ).toBeVisible()
    const cancellationRequestsBeforeNavigation = reader.records.filter((record) =>
      record.path.includes('/cancellation'),
    ).length
    await openReaderChat(reader.page, 'Observer Chat', CHAT_OBSERVER)
    await expectOccupancyState(reader.page, 'switch-required')
    expect(provider.aborts(CHAT_STOP)).toBe(0)
    expect(reader.records.filter((record) => record.path.includes('/cancellation'))).toHaveLength(
      cancellationRequestsBeforeNavigation,
    )
    await openReaderChat(reader.page, 'Reader Chat', CHAT_READER)
    await expectOccupancyState(reader.page, 'self-owned')
    await reader.page.getByTestId('default-chat-cancel-button').click()
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir)
            .operations.filter((operation) => operation.chat_id === CHAT_READER)
            .at(-1)?.state,
      )
      .toBe('cancelled')
    expect(provider.aborts(CHAT_READER)).toBe(1)
    const stoppedTruth = readTruth(harness.dataDir)
    expect(chatMessages(stoppedTruth, CHAT_READER).map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'char', data: `Seed for ${CHAT_READER}.` },
      { role: 'user', data: 'Reader request.' },
      { role: 'char', data: 'Reader partial reply.' },
      { role: 'user', data: 'Reader concurrent request.' },
      { role: 'char', data: 'Reader rerolled reply.' },
      { role: 'user', data: 'Stop this request.' },
      { role: 'char', data: 'Stopped partial' },
    ])
    expect(alternateChatMessages(stoppedTruth, CHAT_READER)).toEqual([])

    await openReaderChat(reader.page, 'Stop Chat', CHAT_STOP)
    await expectOccupancyState(reader.page, 'switch-required')
    await reader.page.locator('[data-reader-occupancy-switch]').click()
    await expectOccupancyState(reader.page, 'self-owned')
    await sendFromUi(reader, 'Switched request.')
    await expectCompleted(harness.dataDir, CHAT_STOP)
    expect(provider.calls(CHAT_STOP)).toBe(1)
    expect(chatMessages(readTruth(harness.dataDir), CHAT_STOP).map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'char', data: `Seed for ${CHAT_STOP}.` },
      { role: 'user', data: 'Switched request.' },
      { role: 'char', data: 'Switched chat reply.' },
    ])

    await readerTwo.page.locator('[data-reader-composer-reroll]').click()
    await expectCompleted(harness.dataDir, CHAT_READER_TWO, 2)
    expect(provider.calls(CHAT_READER_TWO)).toBe(2)
    await expectSubmitAuthority(readerTwo, CHAT_READER_TWO, 'reroll')
    const desktopAfterReroll = readTruth(harness.dataDir)
    expect(chatMessages(desktopAfterReroll, CHAT_READER_TWO).map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'char', data: `Seed for ${CHAT_READER_TWO}.` },
      { role: 'user', data: 'Second reader request.' },
      { role: 'char', data: 'Second reader rerolled reply.' },
    ])

    await sendFromUi(readerTwo, 'Second reader stop request.')
    await expect.poll(() => provider.calls(CHAT_READER_TWO)).toBe(3)
    await expect(
      readerTwo.page
        .locator('[data-reader-transcript] .chat-message-body')
        .filter({ hasText: 'Second reader stopped' }),
    ).toBeVisible()
    await readerTwo.page.getByTestId('default-chat-cancel-button').click()
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir)
            .operations.filter((operation) => operation.chat_id === CHAT_READER_TWO)
            .at(-1)?.state,
      )
      .toBe('cancelled')
    expect(provider.aborts(CHAT_READER_TWO)).toBe(1)
    const desktopStopped = readTruth(harness.dataDir)
    expect(chatMessages(desktopStopped, CHAT_READER_TWO).map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'char', data: `Seed for ${CHAT_READER_TWO}.` },
      { role: 'user', data: 'Second reader request.' },
      { role: 'char', data: 'Second reader rerolled reply.' },
      { role: 'user', data: 'Second reader stop request.' },
      { role: 'char', data: 'Second reader stopped' },
    ])
    expect(alternateChatMessages(desktopStopped, CHAT_READER_TWO)).toEqual([])
    expect(readSharedMutationBoundary(harness.dataDir)).toEqual(sharedAfterOwnerAndReader)

    const occupancyBeforeOwnerTransfers = stableOccupancyTuples(harness.dataDir)
    await promoteViaUi(observer, owner, harness.dataDir, 2)
    expect(stableOccupancyTuples(harness.dataDir)).toEqual(occupancyBeforeOwnerTransfers)
    await promoteViaUi(owner, observer, harness.dataDir, 3)
    expect(stableOccupancyTuples(harness.dataDir)).toEqual(occupancyBeforeOwnerTransfers)
    expect(readTruth(harness.dataDir).occupancy).toContainEqual(
      expect.objectContaining({
        chat_id: CHAT_STOP,
        occupant_session_id: reader.sessionId,
        claim_class: 'chat_only',
        released_at_ms: null,
      }),
    )
    expect(readSharedMutationBoundary(harness.dataDir)).toEqual(sharedAfterOwnerAndReader)

    await expectSubmitAuthority(owner, CHAT_OWNER, 'send')
    await expectSubmitAuthority(reader, CHAT_READER, 'send')
    await expectSubmitAuthority(reader, CHAT_STOP, 'send')
    await expectSubmitAuthority(readerTwo, CHAT_READER_TWO, 'send')
    await expect
      .poll(() => {
        const truth = readTruth(harness.dataDir)
        return [
          ...auditChatOnlyMutations(reader, truth, [CHAT_READER, CHAT_STOP]).violations,
          ...auditChatOnlyMutations(readerTwo, truth, [CHAT_READER_TWO]).violations,
        ]
      })
      .toEqual([])
    const terminalTruth = readTruth(harness.dataDir)
    const readerMutationAudit = auditChatOnlyMutations(reader, terminalTruth, [CHAT_READER, CHAT_STOP])
    const readerTwoMutationAudit = auditChatOnlyMutations(readerTwo, terminalTruth, [CHAT_READER_TWO])
    expect(readerMutationAudit.violations).toEqual([])
    expect(readerTwoMutationAudit.violations).toEqual([])
    expect(new Set(readerMutationAudit.authorizedEffects.map((effect) => effect.chatId))).toEqual(
      new Set([CHAT_READER, CHAT_STOP]),
    )
    expect(new Set(readerTwoMutationAudit.authorizedEffects.map((effect) => effect.chatId))).toEqual(
      new Set([CHAT_READER_TWO]),
    )
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('chat-occupancy-interaction.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          sessions: clients.map(({ name, sessionId }) => ({ name, sessionId })),
          provider: Object.fromEntries(
            ALL_CHATS.map((chatId) => [chatId, { calls: provider.calls(chatId), aborts: provider.aborts(chatId) }]),
          ),
          truth: terminalTruth,
          effectMutationAudit: {
            [reader.name]: readerMutationAudit.authorizedEffects,
            [readerTwo.name]: readerTwoMutationAudit.authorizedEffects,
          },
          requests: clients.flatMap((client) =>
            client.records.map(({ request: _request, ...record }) => ({ ...record, headers: undefined })),
          ),
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('chat-occupancy-interaction', { path: evidencePath, contentType: 'application/json' })
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('simultaneous same-chat claims have one winner and every foreign session fails closed', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_CONFLICT, { chunks: ['Winner partial', ' must not finish.'], holdAfterChunk: 1 })
  const harness = await startHarness(provider, 'risu-chat-occupancy-conflict-')
  const clients: Client[] = []
  try {
    const owner = await createClient(browser, 'owner')
    const contenderA = await createClient(browser, 'contender-a', devices['Pixel 7'])
    const contenderB = await createClient(browser, 'contender-b')
    clients.push(owner, contenderA, contenderB)
    await bootOwner(owner, harness, CHAT_CONFLICT)
    await configureChats(owner.page)
    await bootReader(contenderA, harness, CHAT_CONFLICT)
    await bootReader(contenderB, harness, CHAT_CONFLICT)

    let interceptedClaims = 0
    let releaseClaims!: () => void
    const bothClaimsIntercepted = new Promise<void>((resolve) => {
      releaseClaims = resolve
    })
    const holdClaim = async (route: Route) => {
      interceptedClaims += 1
      if (interceptedClaims === 2) releaseClaims()
      await bothClaimsIntercepted
      await route.continue()
    }
    await contenderA.context.route('**/api/v1/chat-occupancies/**/claim', holdClaim)
    await contenderB.context.route('**/api/v1/chat-occupancies/**/claim', holdClaim)
    const responseA = contenderA.page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/chat-occupancies/${CHAT_CONFLICT}/claim`,
    )
    const responseB = contenderB.page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/chat-occupancies/${CHAT_CONFLICT}/claim`,
    )
    await Promise.all([
      contenderA.page.locator('[data-reader-occupancy-claim]').click(),
      contenderB.page.locator('[data-reader-occupancy-claim]').click(),
    ])
    const [claimResponseA, claimResponseB] = await Promise.all([responseA, responseB])
    await Promise.all([
      contenderA.context.unroute('**/api/v1/chat-occupancies/**/claim', holdClaim),
      contenderB.context.unroute('**/api/v1/chat-occupancies/**/claim', holdClaim),
    ])
    const [claimA, claimB] = await Promise.all(
      [claimResponseA, claimResponseB].map(async (response) => ({
        status: response.status(),
        body: (await response.json()) as Record<string, unknown>,
      })),
    )
    expect([claimA.status, claimB.status].sort()).toEqual([200, 409])
    const winner = claimA.status === 200 ? contenderA : contenderB
    const loser = winner === contenderA ? contenderB : contenderA
    const rejected = claimA.status !== 200 ? claimA : claimB
    expect(rejected.body).toMatchObject({ error: 'chat_occupancy_stale', chatId: CHAT_CONFLICT })
    expect(readTruth(harness.dataDir).occupancy).toContainEqual(
      expect.objectContaining({
        chat_id: CHAT_CONFLICT,
        occupant_session_id: winner.sessionId,
        claim_class: 'chat_only',
        released_at_ms: null,
      }),
    )
    await expectOccupancyState(winner.page, 'self-owned')
    await expectOccupancyState(loser.page, 'foreign-owned')
    await expect(loser.page.locator('[data-reader-composer-field="message"]')).toBeDisabled()
    await expect(loser.page.locator('[data-reader-occupancy-detail]')).toBeVisible()
    await expect(loser.page.locator('[data-reader-feedback]')).toContainText(
      'Chat access could not be changed. Refresh and try again.',
    )

    await sendFromUi(winner, 'Winning request.')
    await expect.poll(() => provider.calls(CHAT_CONFLICT)).toBe(1)
    await expect
      .poll(() => readTruth(harness.dataDir).operations.find((operation) => operation.chat_id === CHAT_CONFLICT)?.state)
      .toBe('owned_by_job')
    const running = readTruth(harness.dataDir)
    const operation = running.operations.find((candidate) => candidate.chat_id === CHAT_CONFLICT)!
    expect(operation).toMatchObject({
      creator_writer_session_id: winner.sessionId,
      admission_kind: 'chat_only',
      occupancy_session_id: winner.sessionId,
      state: 'owned_by_job',
    })
    expect(chatMessages(running, CHAT_CONFLICT).filter((message) => message.role === 'user')).toMatchObject([
      { uid: operation.accepted_message_id, data: 'Winning request.' },
    ])

    await owner.page.getByTestId('default-chat-composer').fill('Foreign owner attempt.')
    await owner.page.getByTestId('default-chat-send-button').click()
    await expect
      .poll(() =>
        owner.records.some(
          (record) =>
            [409, 423].includes(record.status ?? 0) &&
            (record.path === '/api/v1/generation-operations' ||
              record.path === `/api/v1/chat-occupancies/${CHAT_CONFLICT}/claim`),
        ),
      )
      .toBe(true)
    await expect(owner.page.getByTestId('default-chat-composer')).toHaveValue('Foreign owner attempt.')
    expect(provider.calls(CHAT_CONFLICT)).toBe(1)
    expect(
      chatMessages(readTruth(harness.dataDir), CHAT_CONFLICT).some(
        (message) => message.data === 'Foreign owner attempt.',
      ),
    ).toBe(false)

    const ownerRejections = await rejectForeignMutationControls(owner, operation)
    expect(ownerRejections.edit).toMatchObject({ status: 423, body: { error: 'chat_occupied', chatId: CHAT_CONFLICT } })
    expect(ownerRejections.stop).toMatchObject({ status: 423 })
    expect(['generation_operation_foreign_session', 'chat_occupied']).toContain(
      (ownerRejections.stop.body as { error?: string }).error,
    )
    const loserRejections = await rejectForeignMutationControls(loser, operation)
    expect(loserRejections.edit).toMatchObject({ status: 423 })
    expect(loserRejections.stop).toMatchObject({ status: 423 })
    expect(provider.aborts(CHAT_CONFLICT)).toBe(0)
    expect(
      readTruth(harness.dataDir).operations.find((candidate) => candidate.operation_id === operation.operation_id)
        ?.state,
    ).toBe('owned_by_job')

    await winner.page.getByTestId('default-chat-cancel-button').click()
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).operations.find((candidate) => candidate.operation_id === operation.operation_id)
            ?.state,
      )
      .toBe('cancelled')
    expect(provider.aborts(CHAT_CONFLICT)).toBe(1)
    expect(provider.calls(CHAT_CONFLICT)).toBe(1)
    const terminal = readTruth(harness.dataDir)
    expect(chatMessages(terminal, CHAT_CONFLICT).map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'char', data: `Seed for ${CHAT_CONFLICT}.` },
      { role: 'user', data: 'Winning request.' },
      { role: 'char', data: 'Winner partial' },
    ])
    await expectSubmitAuthority(winner, CHAT_CONFLICT, 'send')

    const evidencePath = testInfo.outputPath('chat-occupancy-conflict.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          sessions: clients.map(({ name, sessionId }) => ({ name, sessionId })),
          claims: [claimA, claimB],
          ownerRejections,
          loserRejections,
          truth: terminal,
          requests: clients.flatMap((client) =>
            client.records.map(({ request: _request, ...record }) => ({ ...record, headers: undefined })),
          ),
        },
        null,
        2,
      ),
    )
    await testInfo.attach('chat-occupancy-conflict', { path: evidencePath, contentType: 'application/json' })
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('suspension, expiry, reacquisition, and simultaneous release/claim keep epochs fenced', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  let nowMs = Date.now()
  const provider = new OccupancyProvider()
  const harness = await startHarness(provider, 'risu-chat-occupancy-lifecycle-', { now: () => nowMs })
  const clients: Client[] = []
  const pageErrors: string[] = []
  let duplicateSessionId = ''
  try {
    const owner = await createClient(browser, 'owner')
    const original = await createClient(browser, 'suspended-original', devices['Pixel 7'])
    const successor = await createClient(browser, 'successor')
    clients.push(owner, original, successor)
    for (const client of clients)
      client.page.on('pageerror', (error) => pageErrors.push(`${client.name}: ${error.message}`))

    await bootOwner(owner, harness, CHAT_CONFLICT)
    await bootReader(original, harness, CHAT_CONFLICT)
    await bootReader(successor, harness, CHAT_CONFLICT)

    const initialClaim = await directClaim(original.page, CHAT_CONFLICT, 'chat_only')
    expect(initialClaim).toMatchObject({ status: 200, body: { occupancyEpoch: 1, state: 'occupied' } })
    await expectOccupancyState(original.page, 'self-owned')

    const duplicatePage = await original.context.newPage()
    duplicatePage.on('pageerror', (error) => pageErrors.push(`duplicated-tab: ${error.message}`))
    const duplicate: Client = {
      name: 'duplicated-tab',
      context: original.context,
      page: duplicatePage,
      records: original.records,
      sessionId: '',
    }
    await bootReader(duplicate, harness, CHAT_CONFLICT)
    duplicateSessionId = duplicate.sessionId
    expect(duplicateSessionId).not.toBe(original.sessionId)
    await expectOccupancyState(duplicate.page, 'foreign-owned')
    await expect(duplicate.page.locator('[data-reader-composer-field="message"]')).toBeDisabled()
    await duplicate.page.close()
    await expectOccupancyState(original.page, 'self-owned')

    // Chromium's frozen lifecycle plus transport-offline mode is the closest
    // deterministic browser automation analogue to an OS-suspended page. It
    // does not claim to emulate mobile process eviction.
    const devtools = await original.context.newCDPSession(original.page)
    await original.context.setOffline(true)
    await devtools.send('Page.setWebLifecycleState', { state: 'frozen' })
    nowMs += 90_001
    await devtools.send('Page.setWebLifecycleState', { state: 'active' })
    await original.context.setOffline(false)

    const expiredRenewal = await directTupleMutation(original.page, {
      chatId: CHAT_CONFLICT,
      databaseLineage: String(initialClaim.body.databaseLineage),
      sessionId: original.sessionId,
      occupancyEpoch: 1,
      action: 'renew',
    })
    expect(expiredRenewal).toMatchObject({ status: 409, body: { error: 'chat_occupancy_stale' } })

    const reacquired = await directClaim(original.page, CHAT_CONFLICT, 'chat_only', 1)
    expect(reacquired).toMatchObject({ status: 200, body: { occupancyEpoch: 2, state: 'occupied' } })
    for (const action of ['renew', 'release'] as const) {
      const delayedOldRequest = await directTupleMutation(original.page, {
        chatId: CHAT_CONFLICT,
        databaseLineage: String(initialClaim.body.databaseLineage),
        sessionId: original.sessionId,
        occupancyEpoch: 1,
        action,
      })
      expect(delayedOldRequest).toMatchObject({ status: 409, body: { error: 'chat_occupancy_stale' } })
    }
    expect(readTruth(harness.dataDir).occupancy).toContainEqual(
      expect.objectContaining({
        chat_id: CHAT_CONFLICT,
        occupant_session_id: original.sessionId,
        occupancy_epoch: 2,
        released_at_ms: null,
      }),
    )

    const [released, racingClaim] = await Promise.all([
      directTupleMutation(original.page, {
        chatId: CHAT_CONFLICT,
        databaseLineage: String(initialClaim.body.databaseLineage),
        sessionId: original.sessionId,
        occupancyEpoch: 2,
        action: 'release',
      }),
      directClaim(successor.page, CHAT_CONFLICT, 'chat_only', 2),
    ])
    expect(released).toMatchObject({ status: 200, body: { occupancyEpoch: 3, state: 'released' } })
    expect([409, 423]).toContain(racingClaim.status)
    expect(['chat_occupancy_stale', 'chat_occupied']).toContain(String(racingClaim.body.error))

    const snapshot = await directOccupancySnapshot(successor.page)
    expect(snapshot.status).toBe(200)
    const current = (snapshot.body.occupancies as Array<Record<string, unknown>>).find(
      (candidate) => candidate.chatId === CHAT_CONFLICT,
    )!
    expect(current).toMatchObject({ occupancyEpoch: 3, state: 'released' })
    const successorClaim = await directClaim(successor.page, CHAT_CONFLICT, 'chat_only', 3)
    expect(successorClaim).toMatchObject({ status: 200, body: { occupancyEpoch: 4, state: 'occupied' } })
    await expectOccupancyState(successor.page, 'self-owned')

    const unauthenticatedRenewal = await directTupleMutation(successor.page, {
      chatId: CHAT_CONFLICT,
      databaseLineage: String(successorClaim.body.databaseLineage),
      sessionId: successor.sessionId,
      occupancyEpoch: 4,
      action: 'renew',
      authenticated: false,
    })
    expect(unauthenticatedRenewal).toMatchObject({ status: 401, body: { error: 'Auth required' } })
    const delayedOriginalRenewal = await directTupleMutation(original.page, {
      chatId: CHAT_CONFLICT,
      databaseLineage: String(initialClaim.body.databaseLineage),
      sessionId: original.sessionId,
      occupancyEpoch: 2,
      action: 'renew',
    })
    expect(delayedOriginalRenewal).toMatchObject({ status: 409, body: { error: 'chat_occupancy_stale' } })
    expect(readTruth(harness.dataDir).occupancy).toContainEqual(
      expect.objectContaining({
        chat_id: CHAT_CONFLICT,
        occupant_session_id: successor.sessionId,
        occupancy_epoch: 4,
        released_at_ms: null,
      }),
    )
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('chat-occupancy-lifecycle-faults.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          suspensionEmulation: ['Page.setWebLifecycleState:frozen', 'BrowserContext.setOffline:true'],
          sessions: clients.map(({ name, sessionId }) => ({ name, sessionId })),
          duplicateSessionId,
          initialClaim,
          expiredRenewal,
          reacquired,
          simultaneousReleaseAndClaim: { released, racingClaim },
          successorClaim,
          unauthenticatedRenewal,
          delayedOriginalRenewal,
          truth: readTruth(harness.dataDir),
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('chat-occupancy-lifecycle-faults', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})
