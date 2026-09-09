import { expect, test } from '@playwright/test'
import {
  CHAT,
  OTHER_CHAT,
  PARTIAL,
  REPLY,
  IGP_REPLY,
  IGP_SUFFIX,
  IGP_PROMPT,
  addGenerationClient,
  bootGenerationPair,
  createGenerationPair,
  expectEffectReceipts,
  expectGenerationReader,
  expectGenerationWriter,
  expectNoReaderControl,
  expectReaderPartial,
  expectTerminalGeneration,
  finishGenerationPair,
  generationMessageBody,
  openGenerationReader,
  promoteGenerationWriter,
  readGenerationTruth,
  setAssistantInsertFailure,
  startHeldGeneration,
} from './connectedGenerationHarness.js'

test('a connected Reader sees one live partial and the exact persisted reply without control or effect requests', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000)
  const pair = await createGenerationPair(browser)
  try {
    await bootGenerationPair(pair)
    const { operation, attempt } = await startHeldGeneration(pair)
    await expect.poll(() => pair.provider.snapshot().viewers).toBe(2)
    expect(readGenerationTruth(pair.harness.dataDir).ownership).toMatchObject({
      active_writer_session_id: pair.a.sessionId,
      writer_epoch: 1,
    })
    pair.provider.release()
    await expectTerminalGeneration(pair, 'completed', REPLY, operation.operation_id, attempt.job_id)
    const receipts = await expectEffectReceipts(pair, operation.operation_id, 'live_terminal')
    await pair.b.page.locator('[data-reader-refresh]').click()
    await expectGenerationReader(pair.b)
    await expectTerminalGeneration(pair, 'completed', REPLY, operation.operation_id, attempt.job_id)
    expect(readGenerationTruth(pair.harness.dataDir).effects).toEqual(receipts)
    await expect.poll(() => pair.provider.snapshot().viewers).toBe(0)
    expect(
      pair.fetches.filter(
        (record) => record.client === 'B' && /\/generation-operations\/[^/]+\/stream$/u.test(record.path),
      ),
    ).not.toEqual([])
    expectNoReaderControl(pair)
    expect(pair.errors).toEqual([])
    pair.evidence.receipts = receipts
  } finally {
    await finishGenerationPair(pair, testInfo)
  }
})

test('Reader chat switching and close/reopen detach viewers while the same provider job keeps running', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000)
  const pair = await createGenerationPair(browser)
  try {
    await bootGenerationPair(pair)
    const { operation, attempt } = await startHeldGeneration(pair)
    await expect.poll(() => pair.provider.snapshot().viewers).toBe(2)
    for (let visit = 0; visit < 2; visit++) {
      await pair.b.page.locator('[data-reader-go-back]').click()
      await pair.b.page.getByRole('button', { name: 'Open chat Other Chat', exact: true }).click()
      await expectGenerationReader(pair.b, OTHER_CHAT)
      await expect(pair.b.page.locator('[data-reader-transcript]')).not.toContainText(PARTIAL)
      await expect(pair.b.page.locator('[data-generation-display-projection]')).toHaveCount(0)
      await expect.poll(() => pair.provider.snapshot().viewers).toBe(1)
      expect(pair.provider.snapshot()).toMatchObject({
        calls: 1,
        aborts: 0,
        jobId: attempt.job_id,
        done: false,
        aborted: false,
      })
      await pair.b.page.locator('[data-reader-go-back]').click()
      await pair.b.page.getByRole('button', { name: 'Open chat Generation Chat', exact: true }).click()
      await expectGenerationReader(pair.b)
      await expectReaderPartial(pair.b)
      await expect.poll(() => pair.provider.snapshot().viewers).toBe(2)
    }
    expectNoReaderControl(pair)
    await pair.b.context.close()
    await expect.poll(() => pair.provider.snapshot().viewers).toBe(1)
    const closed = readGenerationTruth(pair.harness.dataDir)
    expect(closed.operations[0]).toMatchObject({
      operation_id: operation.operation_id,
      state: 'owned_by_job',
      result_message_id: null,
    })
    expect(closed.attempts).toMatchObject([{ job_id: attempt.job_id, status: 'running' }])
    expect(pair.provider.snapshot()).toMatchObject({ calls: 1, aborts: 0, done: false, aborted: false })
    pair.evidence.afterReaderClose = closed

    const reopened = await addGenerationClient(browser, pair, 'B-reopened')
    await openGenerationReader(pair, reopened)
    await expectReaderPartial(reopened)
    await expect.poll(() => pair.provider.snapshot().viewers).toBe(2)
    pair.provider.release()
    await expectTerminalGeneration(pair, 'completed', REPLY, operation.operation_id, attempt.job_id, [pair.a, reopened])
    await expectEffectReceipts(pair, operation.operation_id, 'live_terminal')
    await expect.poll(() => pair.provider.snapshot().viewers).toBe(0)
    expect(readGenerationTruth(pair.harness.dataDir).ownership).toMatchObject({
      active_writer_session_id: pair.a.sessionId,
      writer_epoch: 1,
    })
    expect(pair.fetches.filter((record) => /\/cancellation$/u.test(record.path))).toEqual([])
    expectNoReaderControl(pair)
    expect(pair.errors).toEqual([])
  } finally {
    await finishGenerationPair(pair, testInfo)
  }
})

test('writer transfers during streaming and stopping preserve one cancelled partial without completion effects', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000)
  const pair = await createGenerationPair(browser, { holdAfterAbort: true })
  try {
    await bootGenerationPair(pair)
    const { operation, attempt } = await startHeldGeneration(pair)
    await promoteGenerationWriter(pair, pair.b, pair.a, 2)
    await expectReaderPartial(pair.a)
    await expect.poll(() => pair.provider.snapshot().viewers).toBe(2)
    expect(pair.provider.snapshot()).toMatchObject({
      calls: 1,
      aborts: 0,
      jobId: attempt.job_id,
      done: false,
      aborted: false,
    })
    expect(readGenerationTruth(pair.harness.dataDir).attempts).toMatchObject([
      { job_id: attempt.job_id, status: 'running', actor_writer_session_id: pair.a.sessionId, actor_writer_epoch: 1 },
    ])

    await pair.b.page.getByTestId('default-chat-cancel-button').click()
    await expect.poll(() => readGenerationTruth(pair.harness.dataDir).operations[0]?.state).toBe('stopping')
    await expect.poll(() => pair.provider.snapshot().aborts).toBe(1)
    const stopping = readGenerationTruth(pair.harness.dataDir)
    expect(stopping.attempts).toMatchObject([{ job_id: attempt.job_id, status: 'stopping' }])
    expect(stopping.effects).toEqual([])
    expect(stopping.messages.filter((message) => message.chat_id === CHAT)).toHaveLength(2)
    await expect(pair.b.page.getByTestId('default-chat-cancel-button')).toContainText('Stopping')
    await expect(pair.b.page.getByTestId('default-chat-cancel-button')).toHaveAttribute('aria-busy', 'true')
    pair.evidence.stoppingBeforeTransfer = stopping

    // The provider has acknowledged abort but has not returned. Transfer now
    // proves the stopping owner survives an actual second role transition.
    await promoteGenerationWriter(pair, pair.a, pair.b, 3)
    expect(readGenerationTruth(pair.harness.dataDir).operations[0]).toMatchObject({
      operation_id: operation.operation_id,
      state: 'stopping',
      current_attempt_no: 1,
      result_message_id: null,
    })
    expect(pair.provider.snapshot()).toMatchObject({
      calls: 1,
      aborts: 1,
      jobId: attempt.job_id,
      done: false,
      aborted: true,
    })
    await expectReaderPartial(pair.b)
    pair.evidence.stoppingAfterTransfer = readGenerationTruth(pair.harness.dataDir)
    pair.provider.release()
    const terminal = await expectTerminalGeneration(pair, 'cancelled', PARTIAL, operation.operation_id, attempt.job_id)
    expect(terminal.effects).toEqual([])
    expect(terminal.ownership).toMatchObject({ active_writer_session_id: pair.a.sessionId, writer_epoch: 3 })
    const cancellations = pair.fetches.filter(
      (record) => record.method === 'PUT' && /\/generation-operations\/[^/]+\/cancellation$/u.test(record.path),
    )
    expect(cancellations).toMatchObject([{ client: 'B', canMutate: true, writerSession: pair.b.sessionId }])
    expect(cancellations).toHaveLength(1)
    expect(
      pair.fetches.filter(
        (record) =>
          record.client === 'A' && record.session?.lifecycle === 'reading' && record.session.writer?.epoch === 2,
      ).length,
    ).toBeGreaterThan(0)
    expect(
      pair.fetches.filter(
        (record) =>
          record.client === 'B' && record.session?.lifecycle === 'reading' && record.session.writer?.epoch === 3,
      ).length,
    ).toBeGreaterThan(0)
    expectNoReaderControl(pair)
    expect(pair.errors).toEqual([])
  } finally {
    await finishGenerationPair(pair, testInfo)
  }
})

test('writer transfer while a real finalization journal is queued commits one result and settles one effect ledger', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000)
  const pair = await createGenerationPair(browser, { finalizationFailure: true, enabledIgp: true })
  try {
    await bootGenerationPair(pair)
    const { operation, attempt } = await startHeldGeneration(pair)
    pair.provider.release()
    await expect.poll(() => readGenerationTruth(pair.harness.dataDir).operations[0]?.state).toBe('finalizing')
    await expect.poll(() => readGenerationTruth(pair.harness.dataDir).finalizations.length).toBe(1)
    await expect.poll(() => pair.provider.snapshot().done).toBe(true)
    const queued = readGenerationTruth(pair.harness.dataDir)
    expect(queued.completionSettings).toMatchObject({
      igpPrompt: IGP_PROMPT,
      subModel: 'echo_model',
      modelRoles: { emotion: 'echo_model' },
      echoMessage: IGP_SUFFIX,
    })
    expect(queued.operations[0]).toMatchObject({
      operation_id: operation.operation_id,
      desired_terminal_outcome: 'completed',
      result_message_id: null,
    })
    expect(queued.attempts).toMatchObject([{ job_id: attempt.job_id, status: 'finalizing' }])
    expect(queued.finalizations).toMatchObject([
      {
        generation_id: attempt.job_id,
        operation_id: operation.operation_id,
        operation_attempt_no: 1,
        chat_id: CHAT,
        status: 'pending',
        terminal_outcome: 'completed',
        accepted_message_id: operation.accepted_message_id,
        actor_writer_session_id: pair.a.sessionId,
        actor_writer_epoch: 1,
      },
    ])
    expect(queued.messages.filter((message) => message.chat_id === CHAT)).toHaveLength(2)
    expect(queued.effects).toEqual([])
    expect(queued.persistedEvents).toEqual([])
    pair.evidence.queuedBeforeTransfer = queued

    // The injected storage failure is reported to the current writer. Exercise
    // its exact real acknowledgement before transferring the still-queued job.
    await expectGenerationWriter(pair.a)
    expect(readGenerationTruth(pair.harness.dataDir).ownership).toEqual(queued.ownership)
    expect(queued.ownership).toMatchObject({ active_writer_session_id: pair.a.sessionId, writer_epoch: 1 })
    const failureAlert = pair.a.page.getByRole('alertdialog', { name: 'Error', exact: true })
    await expect(failureAlert).toHaveCount(1)
    await expect(failureAlert.getByText('browser smoke controlled finalization failure', { exact: true })).toBeVisible()
    await failureAlert.getByRole('button', { name: 'OK', exact: true }).click()
    await expect(failureAlert).toBeHidden()
    const acknowledged = readGenerationTruth(pair.harness.dataDir)
    expect(acknowledged.ownership).toEqual(queued.ownership)
    expect(acknowledged.operations).toEqual(queued.operations)
    expect(acknowledged.attempts).toEqual(queued.attempts)
    // The retry worker may increment failure_count while the user reads the
    // dialog; all journal identity, payload and pending-state fields stay exact.
    expect(acknowledged.finalizations.map(({ failure_count: _count, ...journal }) => journal)).toEqual(
      queued.finalizations.map(({ failure_count: _count, ...journal }) => journal),
    )
    expect(acknowledged.messages).toEqual(queued.messages)
    expect(acknowledged.effects).toEqual([])
    expect(acknowledged.persistedEvents).toEqual([])
    pair.evidence.queuedAfterExpectedAlertAcknowledgement = acknowledged

    await promoteGenerationWriter(pair, pair.b, pair.a, 2)
    const transferred = readGenerationTruth(pair.harness.dataDir)
    expect(transferred.operations[0]).toMatchObject({ state: 'finalizing', result_message_id: null })
    expect(transferred.finalizations).toMatchObject([
      { generation_id: attempt.job_id, operation_id: operation.operation_id, status: 'pending' },
    ])
    expect(transferred.effects).toEqual([])
    expect(transferred.completionSettings).toEqual(queued.completionSettings)
    pair.evidence.queuedAfterTransfer = transferred
    // The real journal and completed UI transfer are now independently proven.
    // Removing the failure lets the ordinary server retry worker commit it.
    setAssistantInsertFailure(pair.harness.dataDir, false)
    const receipts = await expectEffectReceipts(pair, operation.operation_id, 'late_recovery', { enabledIgp: true })
    const terminal = await expectTerminalGeneration(
      pair,
      'completed',
      IGP_REPLY,
      operation.operation_id,
      attempt.job_id,
    )
    const resultId = terminal.operations[0]!.result_message_id!
    const resultText = terminal.messages.find((message) => message.uid === resultId)!.data
    expect(resultText.split(IGP_SUFFIX)).toHaveLength(2)
    expect(terminal.messageUpdateEvents).toMatchObject([
      { type: 'message.updated', id: resultId, parent_id: CHAT, origin_writer_session_id: pair.b.sessionId },
    ])
    expect(terminal.messageUpdateEvents).toHaveLength(1)
    const igp = receipts.find((effect) => effect.effect_kind === 'igp')!
    expect(igp).toMatchObject({ status: 'completed', delivery: 'late_recovery', reason: null })
    const completion = pair.fetches.filter(
      (record) => record.method === 'POST' && record.path === '/api/v1/generate/completion',
    )
    const update = pair.fetches.filter(
      (record) => record.method === 'PATCH' && record.path === `/api/v1/commands/messages/${resultId}`,
    )
    const claim = pair.fetches.filter(
      (record) => record.method === 'POST' && record.path === `/api/v1/generation-effects/${attempt.job_id}/igp/claims`,
    )
    const receipt = pair.fetches.filter(
      (record) => record.method === 'PUT' && record.path === `/api/v1/generation-effects/${attempt.job_id}/igp/receipt`,
    )
    for (const calls of [completion, update, claim, receipt]) {
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        client: 'B',
        canMutate: true,
        session: {
          lifecycle: 'writing',
          sessionId: pair.b.sessionId,
          writer: { sessionId: pair.b.sessionId, epoch: 2 },
        },
      })
    }
    expect(completion[0]).toMatchObject({ status: 200, body: { mode: 'emotion' } })
    expect(update[0]).toMatchObject({
      status: 200,
      writerSession: pair.b.sessionId,
      body: {
        patch: { data: IGP_REPLY },
        expectedData: REPLY,
        expectedChatId: CHAT,
        expectedGenerationId: attempt.job_id,
      },
    })
    expect(claim[0]).toMatchObject({
      status: 201,
      writerSession: pair.b.sessionId,
      body: { delivery: 'late_recovery', messageId: resultId },
    })
    expect(receipt[0]).toMatchObject({
      status: 200,
      writerSession: pair.b.sessionId,
      body: { claimId: igp.claim_id, status: 'completed' },
    })
    await pair.a.page.locator('[data-reader-refresh]').click()
    await expectGenerationReader(pair.a)
    await expectTerminalGeneration(pair, 'completed', IGP_REPLY, operation.operation_id, attempt.job_id)
    expect(readGenerationTruth(pair.harness.dataDir).effects).toEqual(receipts)
    expect(
      pair.fetches.filter((record) => record.method === 'POST' && record.path === '/api/v1/generation-operations'),
    ).toHaveLength(1)
    expect(
      pair.fetches.filter(
        (record) =>
          record.client === 'A' && record.session?.lifecycle === 'reading' && record.session.writer?.epoch === 2,
      ).length,
    ).toBeGreaterThan(0)
    expectNoReaderControl(pair)
    expect(pair.errors).toEqual([])
    pair.evidence.receipts = receipts
  } finally {
    await finishGenerationPair(pair, testInfo)
  }
})

test('an accepted IGP append is already receipted when its writer loses ownership before the PATCH response', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000)
  const pair = await createGenerationPair(browser, { enabledIgp: true })
  let releaseResponse!: () => void
  const heldResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  const gate = {
    releaseRequested: false,
    releasedResponses: 0,
    errors: [] as string[],
    responses: [] as Array<{
      status: number
      mutationId: string | null
      request: Record<string, unknown>
      response: Record<string, unknown>
      truth: ReturnType<typeof readGenerationTruth>
    }>,
  }
  pair.evidence.igpPatchResponseGate = gate
  await pair.a.page.route('**/api/v1/commands/messages/*', async (route) => {
    const request = route.request()
    const body = request.postDataJSON() as Record<string, unknown> | null
    if (request.method() !== 'PATCH' || body?.expectedChatId !== CHAT || body?.expectedData !== REPLY) {
      await route.continue()
      return
    }
    try {
      // Execute the original request against the real server. Only delivery of
      // its unchanged response is held; no message or effect state is injected.
      const response = await route.fetch()
      gate.responses.push({
        status: response.status(),
        mutationId: request.headers()['risu-mutation-id'] ?? null,
        request: body,
        response: (await response.json()) as Record<string, unknown>,
        truth: readGenerationTruth(pair.harness.dataDir),
      })
      if (gate.responses.length === 1) await heldResponse
      await route.fulfill({ response })
      gate.releasedResponses += 1
    } catch (error) {
      gate.errors.push(error instanceof Error ? error.message : String(error))
      await route.abort('failed').catch(() => undefined)
    }
  })
  try {
    await bootGenerationPair(pair)
    const { operation, attempt } = await startHeldGeneration(pair)
    pair.provider.release()
    await expect.poll(() => gate.responses.length, { timeout: 30_000 }).toBe(1)
    const accepted = gate.responses[0]!
    expect(accepted.status).toBe(200)
    expect(gate.releasedResponses).toBe(0)
    const resultId = accepted.truth.operations[0]!.result_message_id!
    const acceptedIgp = accepted.truth.effects.find((effect) => effect.effect_kind === 'igp')!
    expect(accepted.truth.ownership).toMatchObject({
      active_writer_session_id: pair.a.sessionId,
      writer_epoch: 1,
    })
    expect(accepted.truth.operations).toMatchObject([
      { operation_id: operation.operation_id, state: 'completed', result_message_id: resultId },
    ])
    expect(accepted.truth.messages.filter((message) => message.uid === resultId)).toMatchObject([
      { role: 'char', data: IGP_REPLY },
    ])
    expect(accepted.truth.messageUpdateEvents).toMatchObject([
      { type: 'message.updated', id: resultId, parent_id: CHAT, origin_writer_session_id: pair.a.sessionId },
    ])
    expect(accepted.truth.messageUpdateEvents).toHaveLength(1)
    // Server terminal reconciliation settles TTS and then plugin output before
    // index.svelte invokes IGP. Stage-four effects have not started yet.
    expect(
      accepted.truth.effects.map(({ effect_kind, status, delivery, reason }) => ({
        effect_kind,
        status,
        delivery,
        reason,
      })),
    ).toEqual([
      { effect_kind: 'completion_sound', status: 'pending', delivery: null, reason: null },
      { effect_kind: 'emotion_image_state', status: 'pending', delivery: null, reason: null },
      { effect_kind: 'generated_translation', status: 'skipped', delivery: 'server', reason: 'not_applicable' },
      { effect_kind: 'igp', status: 'completed', delivery: 'live_terminal', reason: null },
      { effect_kind: 'notification', status: 'pending', delivery: null, reason: null },
      { effect_kind: 'plugin_output', status: 'skipped', delivery: 'live_terminal', reason: 'not_configured' },
      { effect_kind: 'tts', status: 'skipped', delivery: 'live_terminal', reason: 'not_requested' },
    ])
    const terminalAtHold = accepted.truth.effects.filter((effect) => effect.status !== 'pending')
    for (const effect of accepted.truth.effects.filter((effect) => effect.status === 'pending')) {
      expect(effect).toMatchObject({ claim_id: null, claimed_at: null, settled_at: null, lease_expires_at: null })
    }
    for (const effect of terminalAtHold) {
      expect(effect.claim_id).toMatch(/\S/u)
      expect(effect.claimed_at).toMatch(/\S/u)
      expect(effect.settled_at).toMatch(/\S/u)
    }
    // This is the atomicity oracle: a successful PATCH cannot leave a reclaimable
    // IGP lease after its append has committed, even before the browser responds.
    expect(acceptedIgp).toMatchObject({
      status: 'completed',
      delivery: 'live_terminal',
      generation_id: attempt.job_id,
      operation_id: operation.operation_id,
      message_id: resultId,
      reason: null,
    })
    expect(acceptedIgp.claim_id).toMatch(/\S/u)
    expect(acceptedIgp.settled_at).toMatch(/\S/u)
    expect(accepted.request).toMatchObject({
      patch: { data: IGP_REPLY },
      expectedData: REPLY,
      expectedChatId: CHAT,
      expectedGenerationId: attempt.job_id,
      igpEffect: { generationId: attempt.job_id, claimId: acceptedIgp.claim_id },
    })
    expect(accepted.mutationId).toMatch(/\S/u)
    const commandReceipt = accepted.truth.mutationReceipts.filter(
      (receipt) => receipt.mutation_id === accepted.mutationId,
    )
    expect(commandReceipt).toMatchObject([
      { database_lineage: accepted.truth.ownership.lineage, creator_writer_session_id: pair.a.sessionId },
    ])
    expect(commandReceipt).toHaveLength(1)
    const receiptResult = JSON.parse(commandReceipt[0]!.response_json) as {
      revision: number
      event: Record<string, unknown>
    }
    expect(accepted.response).toMatchObject({ revision: receiptResult.revision, event: receiptResult.event })
    const semanticBody = (body: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'baseRevision'))
    pair.authorizedRecoveryReplays.push({
      mutationId: accepted.mutationId!,
      path: `/api/v1/commands/messages/${resultId}`,
      semanticBody: semanticBody(accepted.request),
    })
    const patches = () =>
      pair.fetches.filter(
        (record) => record.method === 'PATCH' && record.path === `/api/v1/commands/messages/${resultId}`,
      )
    const receiptPuts = () =>
      pair.fetches.filter(
        (record) =>
          record.method === 'PUT' && record.path === `/api/v1/generation-effects/${attempt.job_id}/igp/receipt`,
      )
    await expect.poll(() => patches().length).toBe(1)
    expect(patches()[0]).toMatchObject({
      client: 'A',
      canMutate: true,
      mutationId: accepted.mutationId,
      session: { lifecycle: 'writing', sessionId: pair.a.sessionId, writer: { sessionId: pair.a.sessionId, epoch: 1 } },
    })
    expect(patches()[0]!.status).toBeUndefined()
    expect(receiptPuts()).toEqual([])
    await expect(generationMessageBody(pair.b.page, resultId)).toContainText(IGP_REPLY, { timeout: 30_000 })

    await promoteGenerationWriter(pair, pair.b, pair.a, 2)
    expect(gate.releasedResponses).toBe(0)
    expect(patches()[0]!.status).toBeUndefined()
    const transferred = readGenerationTruth(pair.harness.dataDir)
    expect(
      transferred.effects.filter((effect) => terminalAtHold.some((held) => held.effect_kind === effect.effect_kind)),
    ).toEqual(terminalAtHold)
    expect(transferred.effects.find((effect) => effect.effect_kind === 'igp')).toEqual(acceptedIgp)
    expect(transferred.messageUpdateEvents).toEqual(accepted.truth.messageUpdateEvents)
    pair.evidence.igpCommittedBeforeLateResponse = transferred

    gate.releaseRequested = true
    releaseResponse()
    await expect.poll(() => gate.releasedResponses).toBeGreaterThan(0)
    await expect.poll(() => patches()[0]?.status).toBe(200)
    const receipts = await expectEffectReceipts(pair, operation.operation_id, 'late_recovery', {
      enabledIgp: true,
      liveIgpPatchAccepted: true,
    })
    await expectTerminalGeneration(pair, 'completed', IGP_REPLY, operation.operation_id, attempt.job_id)
    expect(receiptPuts()).toEqual([])

    await promoteGenerationWriter(pair, pair.a, pair.b, 3)
    await pair.b.page.locator('[data-reader-refresh]').click()
    await expectGenerationReader(pair.b)
    const terminal = await expectTerminalGeneration(
      pair,
      'completed',
      IGP_REPLY,
      operation.operation_id,
      attempt.job_id,
    )
    expect(terminal.effects).toEqual(receipts)
    expect(
      terminal.effects.filter((effect) => terminalAtHold.some((held) => held.effect_kind === effect.effect_kind)),
    ).toEqual(terminalAtHold)
    expect(terminal.effects.find((effect) => effect.effect_kind === 'igp')).toEqual(acceptedIgp)
    expect(terminal.messageUpdateEvents).toEqual(accepted.truth.messageUpdateEvents)
    expect(terminal.mutationReceipts.filter((receipt) => receipt.mutation_id === accepted.mutationId)).toEqual(
      commandReceipt,
    )
    expect(terminal.messages.find((message) => message.uid === resultId)!.data.split(IGP_SUFFIX)).toHaveLength(2)
    const completion = pair.fetches.filter(
      (record) => record.method === 'POST' && record.path === '/api/v1/generate/completion',
    )
    expect(completion).toMatchObject([{ client: 'A', canMutate: true, status: 200, body: { mode: 'emotion' } }])
    expect(completion).toHaveLength(1)
    const grantedClaims = pair.fetches.filter(
      (record) =>
        record.method === 'POST' &&
        record.path === `/api/v1/generation-effects/${attempt.job_id}/igp/claims` &&
        record.status === 201,
    )
    expect(grantedClaims).toMatchObject([
      {
        client: 'A',
        canMutate: true,
        writerSession: pair.a.sessionId,
        body: { delivery: 'live_terminal', messageId: resultId },
      },
    ])
    expect(grantedClaims).toHaveLength(1)
    expect(receiptPuts()).toEqual([])
    // A retained outbox may replay the same logical command on promotion back.
    // Such transport must preserve its mutation ID, semantic body and receipt;
    // a second provider execution or a new message revision is never allowed.
    expect(gate.responses).toHaveLength(patches().length)
    for (const patch of patches()) {
      expect(patch.client).toBe('A')
      expect(patch.mutationId).toBe(accepted.mutationId)
      expect(patch.status).toBe(200)
      expect(semanticBody(patch.body!)).toEqual(semanticBody(accepted.request))
    }
    for (const response of gate.responses) {
      expect(response.mutationId).toBe(accepted.mutationId)
      expect(response.status).toBe(200)
      expect(response.response).toMatchObject({ revision: receiptResult.revision, event: receiptResult.event })
      expect(response.truth.messageUpdateEvents).toEqual(accepted.truth.messageUpdateEvents)
      expect(response.truth.effects.find((effect) => effect.effect_kind === 'igp')).toEqual(acceptedIgp)
    }
    pair.evidence.igpPatchTransportCount = patches().length
    pair.evidence.igpClaimProbeCount = pair.fetches.filter(
      (record) => record.method === 'POST' && record.path === `/api/v1/generation-effects/${attempt.job_id}/igp/claims`,
    ).length
    expect(gate.errors).toEqual([])
    expectNoReaderControl(pair)
    expect(pair.errors).toEqual([])
  } finally {
    releaseResponse()
    await pair.a.page.unrouteAll({ behavior: 'wait' })
    await finishGenerationPair(pair, testInfo)
  }
})
