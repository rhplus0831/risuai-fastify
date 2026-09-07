import { expect, test } from '@playwright/test'
import {
  CHAT,
  OTHER_CHAT,
  PARTIAL,
  REPLY,
  addGenerationClient,
  bootGenerationPair,
  createGenerationPair,
  expectEffectReceipts,
  expectGenerationReader,
  expectNoReaderControl,
  expectReaderPartial,
  expectTerminalGeneration,
  finishGenerationPair,
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
      (record) => record.method === 'POST' && /\/generation-operations\/[^/]+\/cancellation$/u.test(record.path),
    )
    expect(cancellations).toMatchObject([{ client: 'B', canMutate: true, writerSession: pair.b.sessionId }])
    expect(cancellations).toHaveLength(1)
    expect(pair.fetches.filter((record) => record.client === 'A' && record.revoked === true).length).toBeGreaterThan(0)
    expect(pair.fetches.filter((record) => record.client === 'B' && record.revoked === true).length).toBeGreaterThan(0)
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
  const pair = await createGenerationPair(browser, { finalizationFailure: true })
  try {
    await bootGenerationPair(pair)
    const { operation, attempt } = await startHeldGeneration(pair)
    pair.provider.release()
    await expect.poll(() => readGenerationTruth(pair.harness.dataDir).operations[0]?.state).toBe('finalizing')
    await expect.poll(() => readGenerationTruth(pair.harness.dataDir).finalizations.length).toBe(1)
    await expect.poll(() => pair.provider.snapshot().done).toBe(true)
    const queued = readGenerationTruth(pair.harness.dataDir)
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

    await promoteGenerationWriter(pair, pair.b, pair.a, 2)
    const transferred = readGenerationTruth(pair.harness.dataDir)
    expect(transferred.operations[0]).toMatchObject({ state: 'finalizing', result_message_id: null })
    expect(transferred.finalizations).toMatchObject([
      { generation_id: attempt.job_id, operation_id: operation.operation_id, status: 'pending' },
    ])
    expect(transferred.effects).toEqual([])
    pair.evidence.queuedAfterTransfer = transferred
    // The real journal and completed UI transfer are now independently proven.
    // Removing the failure lets the ordinary server retry worker commit it.
    setAssistantInsertFailure(pair.harness.dataDir, false)
    await expectTerminalGeneration(pair, 'completed', REPLY, operation.operation_id, attempt.job_id)
    const receipts = await expectEffectReceipts(pair, operation.operation_id, 'late_recovery')
    await pair.a.page.locator('[data-reader-refresh]').click()
    await expectGenerationReader(pair.a)
    await expectTerminalGeneration(pair, 'completed', REPLY, operation.operation_id, attempt.job_id)
    expect(readGenerationTruth(pair.harness.dataDir).effects).toEqual(receipts)
    expect(
      pair.fetches.filter((record) => record.method === 'POST' && record.path === '/api/v1/generation-operations'),
    ).toHaveLength(1)
    expect(pair.fetches.filter((record) => record.client === 'A' && record.revoked === true).length).toBeGreaterThan(0)
    expectNoReaderControl(pair)
    expect(pair.errors).toEqual([])
    pair.evidence.receipts = receipts
  } finally {
    await finishGenerationPair(pair, testInfo)
  }
})
