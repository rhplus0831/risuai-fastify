import { devices, expect, test, type Page } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import type {
  ChatProviderDispatchContext,
  ChatProviderDispatcher,
  GenerationChatRouteOptions,
} from '../src/routes/generationChat.js'
import type { StreamJob } from '../src/streamJobs.js'
import type { GenerationJobRegistry } from '../src/generationJobs.js'
import { setupBrowserSmokeAuth } from './auth.js'
import { importFastBootstrapDatabase } from './fastBootstrapHarness.js'

interface ProviderPlan {
  chunks: string[]
  errorBeforeTokens?: string
  holdAfterChunk?: number
  holdAfterAbort?: boolean
}

interface OperationProjection {
  operationId: string
  chatId?: string
  state: string
  stateVersion: number
  projectionEpoch: number
  acceptedMessageId?: string
  resultMessageId?: string
  providerMayHaveRun: boolean
  currentAttempt?: { attemptNo: number; jobId: string; status: string }
}

interface LifecycleSnapshot {
  acceptedSendRecoveries: Array<{
    operationId?: string
    target: { chatId?: string }
    phase: string
    operationState?: string
    providerMayHaveRun: boolean
  }>
  activeGenerationJobs: Array<{ chatId: string; jobId: string; operationId?: string }>
  activeChatGenerations: Array<{ chatId?: string; operationId?: string; stage: number }>
  generationFinalizations: Array<{ chatId: string; generationId: string; state?: string }>
  generationJobLifecycles: Record<string, { chatId: string; status: string; reattachAttempts: number }>
  generationOperationCancellations: Array<{
    operationId: string
    state: string
    target?: { chatId?: string }
  }>
  generationOperations: OperationProjection[]
  outbox: Array<{ key: string; mutationId: string; phase: string; kind?: string }>
}

interface ApiMessage {
  role: string
  data: string
  chatId: string
  generationInfo?: { operationId?: string; generationId?: string }
}

interface BootstrapProjection {
  generationOperations?: OperationProjection[]
  activeGenerationJobs?: Array<{ chatId: string; jobId: string; operationId?: string }>
  generationFinalizations?: Array<{ chatId: string; generationId: string; state: string }>
  pendingGenerationEffects?: Array<{ chatId: string; operationId?: string; status: string }>
}

class ControlledProvider {
  private readonly plans = new Map<string, ProviderPlan[]>()
  private readonly callsByChat = new Map<string, number>()
  private readonly jobsByChat = new Map<string, StreamJob[]>()
  private readonly viewerStartsByChat = new Map<string, number>()
  private readonly viewerReadyJobs = new Set<string>()
  private readonly viewerReadyResolvers = new Map<string, Set<() => void>>()
  private readonly releaseResolvers = new Map<string, () => void>()
  private readonly releasePromises = new Map<string, Promise<void>>()
  private readonly abortsByChat = new Map<string, number>()

  configure(chatId: string, ...plans: ProviderPlan[]): void {
    this.plans.set(chatId, plans)
  }

  calls(chatId: string): number {
    return this.callsByChat.get(chatId) ?? 0
  }

  aborts(chatId: string): number {
    return this.abortsByChat.get(chatId) ?? 0
  }

  viewerStarts(chatId: string): number {
    return this.viewerStartsByChat.get(chatId) ?? 0
  }

  latestJob(chatId: string): StreamJob | undefined {
    return this.jobsByChat.get(chatId)?.at(-1)
  }

  release(chatId: string, callNo = 1): void {
    this.releaseResolvers.get(this.releaseKey(chatId, callNo))?.()
  }

  releaseAll(): void {
    for (const release of this.releaseResolvers.values()) release()
  }

  severCurrentViewers(chatId: string): number {
    const job = [...(this.jobsByChat.get(chatId) ?? [])].reverse().find((candidate) => !candidate.done)
    if (!job) return 0
    let severed = 0
    for (const client of [...job.clients]) {
      client.close()
      severed += 1
    }
    return severed
  }

  readonly onLifecycleTransition: NonNullable<GenerationChatRouteOptions['onDurableLifecycleTransition']> = (
    transition,
    job,
  ) => {
    if (transition === 'registered' && job.chatId) {
      this.jobsByChat.set(job.chatId, [...(this.jobsByChat.get(job.chatId) ?? []), job])
    }
    if (transition === 'viewer_write_started' && job.chatId) {
      this.viewerStartsByChat.set(job.chatId, this.viewerStarts(job.chatId) + 1)
      this.viewerReadyJobs.add(job.id)
      for (const resolve of this.viewerReadyResolvers.get(job.id) ?? []) resolve()
      this.viewerReadyResolvers.delete(job.id)
    }
  }

  readonly dispatch: ChatProviderDispatcher = (context) => {
    const chatId = context.input.chatId
    const callNo = this.calls(chatId) + 1
    this.callsByChat.set(chatId, callNo)
    const plan = this.plans.get(chatId)?.[callNo - 1]
    if (!plan) throw new Error(`No browser-smoke provider plan for ${chatId} call ${callNo}`)
    return this.frames(context, plan, callNo)
  }

  private async *frames(context: ChatProviderDispatchContext, plan: ProviderPlan, callNo: number) {
    const { signal } = context
    const onAbort = () => this.abortsByChat.set(context.input.chatId, this.aborts(context.input.chatId) + 1)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    try {
      await this.waitForViewer(context.generationId, signal)
      if (signal.aborted) return
      if (plan.errorBeforeTokens) {
        yield { kind: 'error' as const, error: plan.errorBeforeTokens, status: 503 }
        return
      }
      for (let index = 0; index < plan.chunks.length; index += 1) {
        yield { kind: 'token' as const, content: plan.chunks[index] }
        if (plan.holdAfterChunk === index + 1) {
          await this.waitForRelease(context.input.chatId, callNo, signal, plan.holdAfterAbort === true)
        }
        if (signal.aborted) return
      }
      yield { kind: 'done' as const, finishReason: 'stop' }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private waitForViewer(jobId: string, signal: AbortSignal): Promise<void> {
    if (this.viewerReadyJobs.has(jobId) || signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => {
        signal.removeEventListener('abort', finish)
        this.viewerReadyResolvers.get(jobId)?.delete(finish)
        resolve()
      }
      const resolvers = this.viewerReadyResolvers.get(jobId) ?? new Set<() => void>()
      resolvers.add(finish)
      this.viewerReadyResolvers.set(jobId, resolvers)
      signal.addEventListener('abort', finish, { once: true })
    })
  }

  private waitForRelease(chatId: string, callNo: number, signal: AbortSignal, holdAfterAbort: boolean): Promise<void> {
    const key = this.releaseKey(chatId, callNo)
    let released = this.releasePromises.get(key)
    if (!released) {
      released = new Promise<void>((resolve) => {
        this.releaseResolvers.set(key, () => {
          this.releaseResolvers.delete(key)
          resolve()
        })
      })
      this.releasePromises.set(key, released)
    }
    if (holdAfterAbort) return released
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => {
        signal.removeEventListener('abort', finish)
        resolve()
      }
      signal.addEventListener('abort', finish, { once: true })
      void released!.then(finish)
    })
  }

  private releaseKey(chatId: string, callNo: number): string {
    return `${chatId}:${callNo}`
  }
}

class LifecycleHarness {
  app!: FastifyInstance
  generationJobs!: GenerationJobRegistry
  readonly dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-lifecycle-matrix-'))
  readonly provider = new ControlledProvider()
  baseUrl = ''
  private port = 0

  async start(): Promise<void> {
    await this.startApp(0)
  }

  async restart(): Promise<void> {
    this.app.server.closeAllConnections()
    await this.app.close()
    await this.startApp(this.port)
  }

  async close(): Promise<void> {
    this.provider.releaseAll()
    await this.app.close()
    rmSync(this.dataDir, { recursive: true, force: true })
  }

  installAssistantInsertFailure(chatId: string): void {
    this.withDatabase((db) => {
      db.exec('DROP TRIGGER IF EXISTS browser_smoke_fail_assistant_insert')
      db.exec(`
        CREATE TRIGGER browser_smoke_fail_assistant_insert
        BEFORE INSERT ON messages
        WHEN NEW.chat_id = ${sqlString(chatId)} AND NEW.role = 'char'
        BEGIN
          SELECT RAISE(ABORT, 'browser smoke injected finalization failure');
        END
      `)
    })
  }

  clearAssistantInsertFailure(): void {
    this.withDatabase((db) => db.exec('DROP TRIGGER IF EXISTS browser_smoke_fail_assistant_insert'))
  }

  generationEffects(operationId: string): Array<{ kind: string; status: string }> {
    return this.withDatabase((db) =>
      (
        db
          .prepare(
            `SELECT effect_kind AS kind, status
             FROM generation_effects
             WHERE operation_id = ?
             ORDER BY effect_kind`,
          )
          .all(operationId) as Array<{ kind: string; status: string }>
      ).map((row) => ({ ...row })),
    )
  }

  expireLatestJob(chatId: string): boolean {
    const job = this.provider.latestJob(chatId)
    return job ? this.generationJobs.registry.deleteJob(job.id, new Error('browser smoke replay expiry')) : false
  }

  private async startApp(port: number): Promise<void> {
    process.env.LOG_LEVEL = 'silent'
    const built = await buildApp({
      config: {
        host: '127.0.0.1',
        port,
        dataDir: this.dataDir,
        bodyLimit: 1024 * 1024,
        importMaxBytes: Number.POSITIVE_INFINITY,
        trustProxy: false,
        hubUrl: 'https://sv.risuai.xyz',
        staticRoot: path.resolve('dist'),
      },
      assetGc: false,
      memoryWorker: false,
      generationChat: {
        dispatchProvider: this.provider.dispatch,
        onDurableLifecycleTransition: this.provider.onLifecycleTransition,
        viewerHeartbeatMs: 250,
        finalizationRetry: {
          intervalMs: 250,
          baseDelayMs: 3_000,
          maxDelayMs: 3_000,
          maxPerSweep: 8,
        },
      },
    })
    this.app = built.app
    this.generationJobs = built.generationJobs
    await this.app.listen({ host: '127.0.0.1', port })
    const address = this.app.server.address()
    if (!address || typeof address === 'string') throw new Error('Lifecycle browser-smoke harness did not bind')
    this.port = address.port
    this.baseUrl = `http://127.0.0.1:${this.port}`
  }

  private withDatabase<T>(run: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(path.join(this.dataDir, 'risu.db'))
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      return run(db)
    } finally {
      db.close()
    }
  }
}

const CHARACTER_ID = 'char-lifecycle'
const chats = {
  reloadDesktop: 'chat-reload-desktop',
  responseLoss: 'chat-response-loss',
  retryableProviderFailure: 'chat-retryable-provider-failure',
  reloadMobile: 'chat-reload-mobile',
  restart: 'chat-restart',
  stopDesktop: 'chat-stop-desktop',
  stopMobile: 'chat-stop-mobile',
  transport: 'chat-transport',
  preservedExpired: 'chat-preserved-expired',
  concurrentA: 'chat-concurrent-a',
  concurrentB: 'chat-concurrent-b',
  finalization: 'chat-finalization',
} as const

let harness: LifecycleHarness
const configuredChatIds = new Set<string>()

test.beforeAll(async () => {
  harness = new LifecycleHarness()
  await harness.start()
  const assertion = await setupBrowserSmokeAuth(harness.app)
  await importDatabase(harness.app, assertion, lifecycleFixtureDatabase())
})

test.afterAll(async () => {
  await harness.close()
})

test('send -> mid-stream and completed reloads retain one exact reply', async ({ page }) => {
  const chatId = chats.reloadDesktop
  const userText = 'desktop reload request'
  const partial = 'Desktop reload'
  const reply = `${partial} reply`
  harness.provider.configure(chatId, { chunks: [partial, ' reply'], holdAfterChunk: 1 })

  await bootChat(page, chatId)
  await sendMessage(page, userText)
  const operation = await expectRunningTruth(page, chatId, userText, partial)

  await page.reload()
  await waitForBrowserLoaded(page)
  await dispatchLifecycleRecoveryEvents(page)
  await expectRunningTruth(page, chatId, userText, partial, operation.operationId)

  harness.provider.release(chatId)
  await expectTerminalTruth(page, chatId, userText, reply, 'completed', operation.operationId)
  const committed = await authoritativeMessages(page, chatId)
  expect(committed).toHaveLength(2)
  const [userMessage, replyMessage] = committed
  expect(userMessage!.chatId).toBe(operation.acceptedMessageId)
  expect(replyMessage!.chatId).toMatch(/\S/u)
  expect(replyMessage!.chatId).not.toBe(userMessage!.chatId)
  expect(replyMessage!.generationInfo?.operationId).toBe(operation.operationId)

  // A completed reply must survive ordinary bootstrap and ranged hydration,
  // independently of the live stream or an explicit foreground-recovery signal.
  const documentTimeOrigin = await page.evaluate(() => performance.timeOrigin)
  await page.reload()
  await waitForBrowserLoaded(page)
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(documentTimeOrigin)
  await expectTerminalTruth(page, chatId, userText, reply, 'completed', operation.operationId)
  const identity = (messages: ApiMessage[]) =>
    messages.map(({ chatId: messageId, role, data }) => ({ messageId, role, data }))
  expect(identity(await residentMessages(page, chatId))).toEqual(identity(committed))
  expect(identity(await authoritativeMessages(page, chatId))).toEqual(identity(committed))
  const completedOperation = {
    operationId: operation.operationId,
    chatId,
    state: 'completed',
    acceptedMessageId: userMessage!.chatId,
    resultMessageId: replyMessage!.chatId,
  }
  expect(await operationForChat(page, chatId)).toMatchObject(completedOperation)
  expect(
    (await authoritativeBootstrap(page)).generationOperations?.find(
      (entry) => entry.operationId === operation.operationId,
    ),
  ).toMatchObject(completedOperation)
  for (const [index, message] of committed.entries()) {
    await expect(page.locator(`.default-chat-screen .risu-chat[data-chat-index="${index}"]`)).toHaveAttribute(
      'data-risu-message-id',
      message.chatId,
    )
  }
  expect(harness.provider.calls(chatId)).toBe(1)
})

test('accepted send recovers when the operation response is lost before identity reaches the browser', async ({
  page,
}) => {
  const chatId = chats.responseLoss
  const userText = 'lost operation response request'
  const partial = 'Recovered response'
  const reply = `${partial} reply`
  harness.provider.configure(chatId, { chunks: [partial, ' reply'], holdAfterChunk: 1 })

  await bootChat(page, chatId)
  let responseDropped = false
  await page.route('**/api/v1/generation-operations', async (route) => {
    if (responseDropped || route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    responseDropped = true
    await route.fetch()
    await route.abort('connectionclosed')
  })

  try {
    await sendMessage(page, userText)
    await expect.poll(() => responseDropped).toBe(true)
    await dispatchLifecycleRecoveryEvents(page)
    const operation = await expectRunningTruth(page, chatId, userText, partial)

    harness.provider.release(chatId)
    await expectTerminalTruth(page, chatId, userText, reply, 'completed', operation.operationId)
    expect(harness.provider.calls(chatId)).toBe(1)
  } finally {
    harness.provider.release(chatId)
    await page.unroute('**/api/v1/generation-operations')
  }
})

test('provider failure before tokens exposes an exact Retry that succeeds without duplicating the user row', async ({
  page,
}) => {
  const chatId = chats.retryableProviderFailure
  const userText = 'retryable provider failure request'
  const reply = 'Retry recovered reply'
  harness.provider.configure(
    chatId,
    { chunks: [], errorBeforeTokens: 'browser smoke retryable provider failure' },
    { chunks: [reply] },
  )

  await bootChat(page, chatId)
  await sendMessage(page, userText)

  const recovery = page.getByTestId('accepted-send-recovery')
  await expect(recovery).toBeVisible({ timeout: 15_000 })
  await expect(recovery).toContainText('could not be started')
  await expect(recovery).toContainText('may already have run and may have been billed')
  const providerError = page.getByRole('alertdialog')
  await expect(providerError).toContainText('browser smoke retryable provider failure')
  await providerError.getByRole('button', { name: 'OK', exact: true }).click()
  const operation = await waitForOperation(page, chatId)
  await expect
    .poll(async () => summarizeMessages(await residentMessages(page, chatId)))
    .toEqual([{ role: 'user', data: userText }])
  expect(summarizeMessages(await authoritativeMessages(page, chatId))).toEqual([{ role: 'user', data: userText }])
  expect(operation).toMatchObject({ state: 'retryable', providerMayHaveRun: true })
  expect(harness.provider.calls(chatId)).toBe(1)

  await recovery.getByTestId('accepted-send-retry').click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toContainText('may already have been billed')
  await confirmation.getByRole('button', { name: 'YES' }).click()

  await expectTerminalTruth(page, chatId, userText, reply, 'completed', operation.operationId)
  expect(harness.provider.calls(chatId)).toBe(2)
  expect(summarizeMessages(await authoritativeMessages(page, chatId))).toEqual([
    { role: 'user', data: userText },
    { role: 'char', data: reply },
  ])
})

test('Pixel reload plus visibility/pageshow reattaches and commits one reply', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['Pixel 7'] })
  const page = await context.newPage()
  const chatId = chats.reloadMobile
  const userText = 'mobile reload request'
  const partial = 'Mobile reload'
  const reply = `${partial} reply`
  harness.provider.configure(chatId, { chunks: [partial, ' reply'], holdAfterChunk: 1 })

  try {
    await bootChat(page, chatId)
    await sendMessage(page, userText)
    const operation = await expectRunningTruth(page, chatId, userText, partial)

    await page.reload()
    await waitForBrowserLoaded(page)
    await dispatchLifecycleRecoveryEvents(page)
    await expectRunningTruth(page, chatId, userText, partial, operation.operationId)

    harness.provider.release(chatId)
    await expectTerminalTruth(page, chatId, userText, reply, 'completed', operation.operationId)
    expect(harness.provider.calls(chatId)).toBe(1)
  } finally {
    harness.provider.release(chatId)
    await context.close()
  }
})

test('server restart projects a billing-aware abandoned recovery and exact retry', async ({ page }) => {
  test.setTimeout(45_000)
  const chatId = chats.restart
  const userText = 'restart request'
  const partial = 'Interrupted provider output'
  const reply = 'Restart retry reply'
  harness.provider.configure(chatId, { chunks: [partial, ' discarded'], holdAfterChunk: 1 }, { chunks: [reply] })

  await bootChat(page, chatId)
  await sendMessage(page, userText)
  const operation = await expectRunningTruth(page, chatId, userText, partial)
  expect(operation.providerMayHaveRun).toBe(true)

  await page.context().setOffline(true)
  try {
    await harness.restart()
  } finally {
    await page.context().setOffline(false)
  }
  await page.reload()
  await waitForBrowserLoaded(page)
  const recovery = page.getByTestId('accepted-send-recovery')
  await expect(recovery).toBeVisible()
  await expect(recovery).toContainText('interrupted by a server restart')
  await expect(recovery).toContainText('may already have run and may have been billed')
  await expectAbandonedTruth(page, chatId, userText, operation.operationId)

  await recovery.getByTestId('accepted-send-retry').click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toContainText('may already have been billed')
  await confirmation.getByRole('button', { name: 'YES' }).click()

  await expectTerminalTruth(page, chatId, userText, reply, 'completed', operation.operationId)
  expect(harness.provider.calls(chatId)).toBe(2)
  expect(harness.provider.aborts(chatId)).toBe(1)
})

test('Stop acknowledges Stopping, persists a stopped partial, and runs no success effects', async ({ page }) => {
  const chatId = chats.stopDesktop
  const userText = 'desktop stop request'
  const partial = 'Desktop stopped partial'
  harness.provider.configure(chatId, {
    chunks: [partial, ' must not land'],
    holdAfterChunk: 1,
    holdAfterAbort: true,
  })

  await bootChat(page, chatId)
  await sendMessage(page, userText)
  const operation = await expectRunningTruth(page, chatId, userText, partial)

  const stop = page.getByTestId('default-chat-cancel-button')
  await stop.click()
  try {
    await expect(stop).toContainText('Stopping…')
    await expect(stop).toHaveAttribute('aria-busy', 'true')
    await expectStoppingTruth(page, chatId, userText, partial, operation.operationId)
  } finally {
    harness.provider.release(chatId)
  }

  await expectTerminalTruth(page, chatId, userText, partial, 'cancelled', operation.operationId)
  expect(harness.provider.aborts(chatId)).toBe(1)
  expect(harness.generationEffects(operation.operationId)).toEqual([])
})

test('Pixel visibility/pageshow Stop remains exact and persists one stopped partial', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['Pixel 7'] })
  const page = await context.newPage()
  const chatId = chats.stopMobile
  const userText = 'mobile stop request'
  const partial = 'Mobile stopped partial'
  harness.provider.configure(chatId, {
    chunks: [partial, ' must not land'],
    holdAfterChunk: 1,
    holdAfterAbort: true,
  })

  try {
    await bootChat(page, chatId)
    await sendMessage(page, userText)
    const operation = await expectRunningTruth(page, chatId, userText, partial)
    await dispatchLifecycleRecoveryEvents(page)
    await expectRunningTruth(page, chatId, userText, partial, operation.operationId)

    const stop = page.getByTestId('default-chat-cancel-button')
    await stop.click()
    try {
      await expect(stop).toContainText('Stopping…')
      await expect(stop).toHaveAttribute('aria-busy', 'true')
      await expectStoppingTruth(page, chatId, userText, partial, operation.operationId)
    } finally {
      harness.provider.release(chatId)
    }

    await expectTerminalTruth(page, chatId, userText, partial, 'cancelled', operation.operationId)
    expect(harness.generationEffects(operation.operationId)).toEqual([])
  } finally {
    harness.provider.release(chatId)
    await context.close()
  }
})

test('viewer transport loss reconnects boundedly and terminal snapshot stays canonical', async ({ page }) => {
  const chatId = chats.transport
  const userText = 'transport recovery request'
  const partial = 'Canonical'
  const reply = `${partial} terminal snapshot`
  harness.provider.configure(chatId, { chunks: [partial, ' terminal', ' snapshot'], holdAfterChunk: 1 })

  await bootChat(page, chatId)
  await sendMessage(page, userText)
  const operation = await expectRunningTruth(page, chatId, userText, partial)
  expect(harness.provider.severCurrentViewers(chatId)).toBeGreaterThanOrEqual(1)
  await expect.poll(() => harness.provider.viewerStarts(chatId), { timeout: 10_000 }).toBe(2)

  harness.provider.release(chatId)
  await expectTerminalTruth(page, chatId, userText, reply, 'completed', operation.operationId)
  expect(harness.provider.calls(chatId)).toBe(1)
  expect(harness.provider.viewerStarts(chatId)).toBe(2)
})

test('preserved runtime reconciles completion after its observer and replay job expire', async ({ page }) => {
  test.setTimeout(45_000)
  const chatId = chats.preservedExpired
  const userText = 'preserved runtime expiry request'
  const partial = 'Background completion'
  const reply = `${partial} survived`
  harness.provider.configure(chatId, { chunks: [partial, ' survived'], holdAfterChunk: 1 })

  await bootChat(page, chatId)
  await sendMessage(page, userText)
  const operation = await expectRunningTruth(page, chatId, userText, partial)

  await page.context().setOffline(true)
  try {
    expect(harness.provider.severCurrentViewers(chatId)).toBeGreaterThanOrEqual(1)
    harness.provider.release(chatId)
    await expect.poll(() => harness.provider.latestJob(chatId)?.done, { timeout: 15_000 }).toBe(true)
    expect(harness.expireLatestJob(chatId)).toBe(true)
  } finally {
    await page.context().setOffline(false)
  }

  await dispatchLifecycleRecoveryEvents(page)
  await expectTerminalTruth(page, chatId, userText, reply, 'completed', operation.operationId)
  await expect(page.getByTestId('generation-reattach-failure')).toHaveCount(0)
  await expect(page.getByTestId('accepted-send-recovery')).toHaveCount(0)
  await expect(page.locator('.default-chat-screen .risu-error')).toHaveCount(0)
  expect(harness.provider.calls(chatId)).toBe(1)
})

test('two concurrent chats keep stable-target UI, recovery, and jobs isolated', async ({ page }) => {
  const userA = 'concurrent request A'
  const userB = 'concurrent request B'
  const partialA = 'Chat A partial'
  const partialB = 'Chat B partial'
  const replyA = `${partialA} complete`
  const replyB = `${partialB} complete`
  harness.provider.configure(chats.concurrentA, { chunks: [partialA, ' complete'], holdAfterChunk: 1 })
  harness.provider.configure(chats.concurrentB, { chunks: [partialB, ' complete'], holdAfterChunk: 1 })

  await bootChat(page, chats.concurrentA)
  await sendMessage(page, userA)
  const operationA = await expectRunningTruth(page, chats.concurrentA, userA, partialA)

  await navigateToChat(page, chats.concurrentB)
  await sendMessage(page, userB)
  const operationB = await expectRunningTruth(page, chats.concurrentB, userB, partialB)
  await expect(page.locator('.default-chat-screen')).not.toContainText(partialA)
  await expectConcurrentJobs(page, [chats.concurrentA, chats.concurrentB])

  await navigateToChat(page, chats.concurrentA)
  await expectVisibleTranscript(page, userA, partialA)
  await expect(page.locator('.default-chat-screen')).not.toContainText(partialB)
  await expectConcurrentJobs(page, [chats.concurrentA, chats.concurrentB])

  harness.provider.release(chats.concurrentB)
  await expect.poll(async () => (await operationForChat(page, chats.concurrentB))?.state).toBe('completed')
  await expectRunningTruth(page, chats.concurrentA, userA, partialA, operationA.operationId)

  harness.provider.release(chats.concurrentA)
  await expectTerminalTruth(page, chats.concurrentA, userA, replyA, 'completed', operationA.operationId)
  await navigateToChat(page, chats.concurrentB)
  await expectTerminalTruth(page, chats.concurrentB, userB, replyB, 'completed', operationB.operationId)
  expect(harness.provider.calls(chats.concurrentA)).toBe(1)
  expect(harness.provider.calls(chats.concurrentB)).toBe(1)
})

test('queued finalization keeps a provisional row through reload and later settles', async ({ page }) => {
  test.setTimeout(45_000)
  const chatId = chats.finalization
  const userText = 'queued finalization request'
  const reply = 'Journaled provisional reply'
  harness.provider.configure(chatId, { chunks: [reply] })
  harness.installAssistantInsertFailure(chatId)

  try {
    await bootChat(page, chatId)
    await sendMessage(page, userText)
    const operation = await waitForOperation(page, chatId)
    await expectQueuedFinalizationTruth(page, chatId, userText, reply, operation.operationId)

    await page.reload()
    await waitForBrowserLoaded(page)
    await expectQueuedFinalizationTruth(page, chatId, userText, reply, operation.operationId)
  } finally {
    harness.clearAssistantInsertFailure()
  }

  await expectTerminalTruth(page, chatId, userText, reply, 'completed')
  expect(harness.provider.calls(chatId)).toBe(1)
})

async function bootChat(page: Page, chatId: string): Promise<void> {
  await page.goto(`${harness.baseUrl}/character/${CHARACTER_ID}/${chatId}`)
  // This suite deliberately shares one server across independent cases. A new
  // page must explicitly acquire its writer precondition from the prior case;
  // the mid-stream/completed reloads and restart journeys above do not use this.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const hook = window.__RISU_FASTIFY_BROWSER_SMOKE__
          if (!hook) return 'starting'
          const session = hook.getClientSessionSnapshot()
          if (
            session.managed &&
            session.lifecycle === 'reading' &&
            session.authenticated &&
            session.projectionReady &&
            session.connection === 'live' &&
            session.writer?.sessionId &&
            session.writer.sessionId !== session.sessionId
          )
            return 'reader'
          return hook.isLoaded() && (!session.managed || session.lifecycle === 'writing') ? 'loaded' : 'starting'
        }),
      { timeout: 15_000 },
    )
    .not.toBe('starting')
  const session = await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot())
  if (
    session.managed &&
    session.lifecycle === 'reading' &&
    session.writer?.sessionId &&
    session.writer.sessionId !== session.sessionId
  ) {
    await page.getByRole('button', { name: 'Use this device', exact: true }).click()
    const confirmation = page.getByRole('button', { name: 'Disconnect existing client', exact: true })
    await expect
      .poll(
        async () => {
          const current = await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot())
          return current.lifecycle === 'writing'
            ? 'writer'
            : (await confirmation.isVisible())
              ? 'confirmation'
              : 'promoting'
        },
        { timeout: 15_000 },
      )
      .not.toBe('promoting')
    if (await confirmation.isVisible()) await confirmation.click()
    await expect
      .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot().lifecycle), {
        timeout: 15_000,
      })
      .toBe('writing')
  }
  await waitForBrowserLoaded(page)
  const writerHeaders = await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders())
  const database = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  try {
    expect(database.prepare('SELECT active_writer_session_id FROM database_metadata WHERE id = 1').get()).toMatchObject(
      {
        active_writer_session_id: writerHeaders['risu-writer-session'],
      },
    )
  } finally {
    database.close()
  }
  await expect(page.locator('.default-chat-screen')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('default-chat-composer')).toBeVisible()
  await ensureChatGenerationSettingsReady(page, chatId)
}

async function waitForBrowserLoaded(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__?.isLoaded() ?? false), { timeout: 15_000 })
    .toBe(true)
}

async function sendMessage(page: Page, message: string): Promise<void> {
  await page.getByTestId('default-chat-composer').fill(message)
  await page.getByTestId('default-chat-send-button').click()
}

async function navigateToChat(page: Page, chatId: string): Promise<void> {
  const back = page.locator('[data-risu-chat-action="back-to-chat-list"]').first()
  await expect(back).toBeVisible({ timeout: 10_000 })
  await back.click()
  const row = page.locator(`[data-risu-chat-idx][data-risu-chat-id="${chatId}"]`).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.locator('button[data-risu-chat-action="select"]').click()
  await expect(page).toHaveURL(new RegExp(`/character/${CHARACTER_ID}/${chatId}$`))
  await expect(page.getByTestId('default-chat-composer')).toBeVisible()
  await ensureChatGenerationSettingsReady(page, chatId)
}

async function ensureChatGenerationSettingsReady(page: Page, chatId: string): Promise<void> {
  await waitForChatSelectionBeforeGenerationSettings(page, chatId)
  if (configuredChatIds.has(chatId)) return
  const result = await page.evaluate(async (targetChatId) => {
    const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
    const bootstrap = await fetch('/api/v1/bootstrap', { headers })
    const bootstrapBody = (await bootstrap.json()) as { revision?: unknown }
    let baseRevision = bootstrapBody.revision
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`/api/v1/commands/chats/${encodeURIComponent(targetChatId)}/generation-settings`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          baseRevision,
          generationSettings: {
            configured: true,
            personaId: 'persona-lifecycle',
            modelPresetId: 'model-preset-lifecycle',
            promptPresetId: 'prompt-preset-lifecycle',
            jailbreakToggle: false,
            sidebarToggles: {},
          },
        }),
      })
      const body = (await response.json()) as { error?: unknown; currentRevision?: unknown }
      if (
        response.status !== 409 ||
        body.error !== 'revision_conflict' ||
        typeof body.currentRevision !== 'number' ||
        attempt === 4
      ) {
        return { status: response.status, body }
      }
      baseRevision = body.currentRevision
    }
    throw new Error('generation-settings revision retry loop exhausted')
  }, chatId)
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  await expect
    .poll(() =>
      page.evaluate((targetChatId) => {
        const snapshot = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
        return snapshot.characters
          ?.flatMap((character) => character.chats ?? [])
          .find((chat) => chat.id === targetChatId)?.generationSettings?.configured
      }, chatId),
    )
    .toBe(true)
  configuredChatIds.add(chatId)
}

async function waitForChatSelectionBeforeGenerationSettings(page: Page, chatId: string): Promise<void> {
  const observations: Record<string, unknown>[] = []
  const database = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  const selectedChat = database.prepare(`
    SELECT chat.id AS selected_chat_id
    FROM characters AS owner
    JOIN chats AS chat
      ON chat.character_id = owner.id
      AND chat.position = json_extract(owner.data_json, '$.chatPage')
    WHERE owner.id = ?
  `)
  try {
    // Writer/background readiness can precede the asynchronous native selection
    // command. Wait for its actual owner pointer before this fixture writes.
    await expect
      .poll(
        async () => {
          const local = await page.evaluate(
            async ({ characterId, targetChatId }) => {
              const hook = window.__RISU_FASTIFY_BROWSER_SMOKE__!
              const lifecycle = await hook.getLifecycleSnapshot()
              const character = hook.getDatabaseSnapshot().characters?.find((owner) => owner.chaId === characterId)
              const selectionPath = `/chats/${encodeURIComponent(targetChatId)}`
              return {
                pathname: location.pathname,
                route: hook.getCurrentRoute(),
                routeLoad: hook.getRouteResourceLoadState(),
                localSelectedChatId: character?.chats?.[character.chatPage]?.id ?? null,
                pendingTargetSelections: lifecycle.outbox.filter((entry) =>
                  entry.requests.some((request) => {
                    if (!request || typeof request !== 'object' || Array.isArray(request)) return false
                    const record = request as Record<string, unknown>
                    const body = record.body
                    return (
                      record.method === 'PATCH' &&
                      record.path === selectionPath &&
                      body !== null &&
                      typeof body === 'object' &&
                      !Array.isArray(body) &&
                      (body as Record<string, unknown>).select === true
                    )
                  }),
                ).length,
              }
            },
            { characterId: CHARACTER_ID, targetChatId: chatId },
          )
          const persisted = selectedChat.get(CHARACTER_ID) as { selected_chat_id: string } | undefined
          const observed = { ...local, authoritativeSelectedChatId: persisted?.selected_chat_id ?? null }
          observations.push(observed)
          return observed
        },
        { message: 'native chat selection is ready and durable before generation-settings setup', timeout: 15_000 },
      )
      .toMatchObject({
        pathname: `/character/${CHARACTER_ID}/${chatId}`,
        route: { kind: 'character', chaId: CHARACTER_ID, chatId },
        routeLoad: { routeKey: `character:${CHARACTER_ID}:${chatId}`, status: 'ready' },
        localSelectedChatId: chatId,
        authoritativeSelectedChatId: chatId,
        pendingTargetSelections: 0,
      })
  } finally {
    database.close()
    await test.info().attach(`generation-settings-selection-${chatId}.json`, {
      body: JSON.stringify({ chatId, observations }, null, 2),
      contentType: 'application/json',
    })
  }
}

async function dispatchLifecycleRecoveryEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  })
}

async function expectRunningTruth(
  page: Page,
  chatId: string,
  userText: string,
  partial: string,
  expectedOperationId?: string,
): Promise<OperationProjection> {
  await expectVisibleTranscript(page, userText, partial)
  await expect
    .poll(async () => summarizeMessages(await residentMessages(page, chatId)), { timeout: 15_000 })
    .toEqual([
      { role: 'user', data: userText },
      { role: 'char', data: partial },
    ])
  await expect
    .poll(async () => summarizeMessages(await authoritativeMessages(page, chatId)), { timeout: 15_000 })
    .toEqual([{ role: 'user', data: userText }])
  await expect
    .poll(async () => {
      const snapshot = await lifecycleSnapshot(page)
      const operation = snapshot.generationOperations.find((candidate) => candidate.chatId === chatId)
      return {
        operationId: operation?.operationId,
        state: operation?.state,
        activeJobs: snapshot.activeGenerationJobs.filter((job) => job.chatId === chatId).length,
        activities: snapshot.activeChatGenerations.filter((activity) => activity.chatId === chatId).length,
        retryableRecoveries: snapshot.acceptedSendRecoveries.filter(
          (recovery) => recovery.target.chatId === chatId && recovery.phase === 'retryable',
        ).length,
        outbox: generationOutboxCount(snapshot),
      }
    })
    .toEqual({
      operationId: expectedOperationId ?? expect.any(String),
      state: 'owned_by_job',
      activeJobs: 1,
      activities: 1,
      retryableRecoveries: 0,
      outbox: 0,
    })
  await expect
    .poll(async () => {
      const bootstrap = await authoritativeBootstrap(page)
      return {
        state: bootstrap.generationOperations?.find((candidate) => candidate.chatId === chatId)?.state,
        activeJobs: bootstrap.activeGenerationJobs?.filter((job) => job.chatId === chatId).length ?? 0,
        finalizations: bootstrap.generationFinalizations?.filter((entry) => entry.chatId === chatId).length ?? 0,
      }
    })
    .toEqual({ state: 'owned_by_job', activeJobs: 1, finalizations: 0 })
  const operation = await operationForChat(page, chatId)
  expect(operation).toBeDefined()
  return operation!
}

async function expectStoppingTruth(
  page: Page,
  chatId: string,
  userText: string,
  partial: string,
  operationId: string,
): Promise<void> {
  await expectVisibleTranscript(page, userText, partial)
  expect(summarizeMessages(await residentMessages(page, chatId))).toEqual([
    { role: 'user', data: userText },
    { role: 'char', data: partial },
  ])
  expect(summarizeMessages(await authoritativeMessages(page, chatId))).toEqual([{ role: 'user', data: userText }])
  await expect
    .poll(async () => {
      const snapshot = await lifecycleSnapshot(page)
      return {
        state: snapshot.generationOperations.find((candidate) => candidate.operationId === operationId)?.state,
        activeJobs: snapshot.activeGenerationJobs.filter((job) => job.chatId === chatId).length,
        cancellation: snapshot.generationOperationCancellations.find((control) => control.operationId === operationId)
          ?.state,
        outbox: generationOutboxCount(snapshot),
      }
    })
    .toEqual({ state: 'stopping', activeJobs: 1, cancellation: 'stop_waiting', outbox: 1 })
  const bootstrap = await authoritativeBootstrap(page)
  expect(bootstrap.generationOperations?.find((candidate) => candidate.operationId === operationId)?.state).toBe(
    'stopping',
  )
  expect(bootstrap.activeGenerationJobs?.filter((job) => job.chatId === chatId)).toHaveLength(1)
}

async function expectAbandonedTruth(page: Page, chatId: string, userText: string, operationId: string): Promise<void> {
  await expect(page.locator('.default-chat-screen .risu-chat[data-chat-index="0"]')).toContainText(userText)
  await expect(page.locator('.default-chat-screen .risu-chat[data-chat-index="1"]')).toHaveCount(0)
  await expect
    .poll(async () => summarizeMessages(await residentMessages(page, chatId)))
    .toEqual([{ role: 'user', data: userText }])
  expect(summarizeMessages(await authoritativeMessages(page, chatId))).toEqual([{ role: 'user', data: userText }])
  await expect
    .poll(async () => {
      const snapshot = await lifecycleSnapshot(page)
      const recovery = snapshot.acceptedSendRecoveries.find((candidate) => candidate.operationId === operationId)
      return {
        state: snapshot.generationOperations.find((candidate) => candidate.operationId === operationId)?.state,
        jobs: snapshot.activeGenerationJobs.filter((job) => job.chatId === chatId).length,
        recoveryPhase: recovery?.phase,
        recoveryState: recovery?.operationState,
        providerMayHaveRun: recovery?.providerMayHaveRun,
        outbox: generationOutboxCount(snapshot),
      }
    })
    .toEqual({
      state: 'abandoned',
      jobs: 0,
      recoveryPhase: 'retryable',
      recoveryState: 'abandoned',
      providerMayHaveRun: true,
      outbox: 0,
    })
  const bootstrap = await authoritativeBootstrap(page)
  expect(bootstrap.generationOperations?.find((candidate) => candidate.operationId === operationId)?.state).toBe(
    'abandoned',
  )
  expect(bootstrap.activeGenerationJobs?.filter((job) => job.chatId === chatId)).toHaveLength(0)
}

async function expectQueuedFinalizationTruth(
  page: Page,
  chatId: string,
  userText: string,
  reply: string,
  operationId: string,
): Promise<void> {
  await expectVisibleTranscript(page, userText, reply)
  await expect(page.locator('[data-generation-persistence-state="queued"]')).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(async () => summarizeMessages(await residentMessages(page, chatId)))
    .toEqual([
      { role: 'user', data: userText },
      { role: 'char', data: reply },
    ])
  await expect
    .poll(async () => summarizeMessages(await authoritativeMessages(page, chatId)))
    .toEqual([{ role: 'user', data: userText }])
  await expect
    // The live wire disposition records the row with `state` unset; the
    // periodic finalization refresh (5s cadence) replaces it with the
    // projected `queued` state, so this poll must outlast one full cycle.
    .poll(
      async () => {
        const snapshot = await lifecycleSnapshot(page)
        return {
          state: snapshot.generationOperations.find((candidate) => candidate.operationId === operationId)?.state,
          jobs: snapshot.activeGenerationJobs.filter((job) => job.chatId === chatId).length,
          finalizations: snapshot.generationFinalizations.filter((entry) => entry.chatId === chatId).length,
          finalizationState: snapshot.generationFinalizations.find((entry) => entry.chatId === chatId)?.state,
          outbox: generationOutboxCount(snapshot),
        }
      },
      { timeout: 15_000 },
    )
    .toEqual({ state: 'finalizing', jobs: 0, finalizations: 1, finalizationState: 'queued', outbox: 0 })
  const bootstrap = await authoritativeBootstrap(page)
  expect(bootstrap.generationOperations?.find((candidate) => candidate.operationId === operationId)?.state).toBe(
    'finalizing',
  )
  expect(bootstrap.activeGenerationJobs?.filter((job) => job.chatId === chatId)).toHaveLength(0)
  expect(bootstrap.generationFinalizations?.filter((entry) => entry.chatId === chatId)).toHaveLength(1)
}

async function expectConcurrentJobs(page: Page, chatIds: string[]): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await lifecycleSnapshot(page)
      return {
        activities: snapshot.activeChatGenerations
          .filter((activity) => activity.chatId && chatIds.includes(activity.chatId))
          .map((activity) => activity.chatId)
          .sort(),
        jobs: snapshot.activeGenerationJobs
          .filter((job) => chatIds.includes(job.chatId))
          .map((job) => job.chatId)
          .sort(),
        retryableRecoveries: snapshot.acceptedSendRecoveries.filter(
          (recovery) =>
            recovery.target.chatId && chatIds.includes(recovery.target.chatId) && recovery.phase === 'retryable',
        ).length,
      }
    })
    .toEqual({ activities: [...chatIds].sort(), jobs: [...chatIds].sort(), retryableRecoveries: 0 })
  await expect
    .poll(async () =>
      (await authoritativeBootstrap(page)).activeGenerationJobs
        ?.filter((job) => chatIds.includes(job.chatId))
        .map((job) => job.chatId)
        .sort(),
    )
    .toEqual([...chatIds].sort())
}

async function expectTerminalTruth(
  page: Page,
  chatId: string,
  userText: string,
  replyText: string,
  terminalState: 'completed' | 'cancelled',
  operationId?: string,
): Promise<void> {
  await expectVisibleTranscript(page, userText, replyText)
  await expect
    .poll(async () => summarizeMessages(await residentMessages(page, chatId)), { timeout: 20_000 })
    .toEqual([
      { role: 'user', data: userText },
      { role: 'char', data: replyText },
    ])
  await expect
    .poll(async () => summarizeMessages(await authoritativeMessages(page, chatId)), { timeout: 20_000 })
    .toEqual([
      { role: 'user', data: userText },
      { role: 'char', data: replyText },
    ])
  await expect
    .poll(
      async () => {
        const snapshot = await lifecycleSnapshot(page)
        const operation = operationId
          ? snapshot.generationOperations.find((candidate) => candidate.operationId === operationId)
          : snapshot.generationOperations.find((candidate) => candidate.chatId === chatId)
        return {
          state: operation?.state,
          jobs: snapshot.activeGenerationJobs.filter((job) => job.chatId === chatId).length,
          activities: snapshot.activeChatGenerations.filter((activity) => activity.chatId === chatId).length,
          recoveries: snapshot.acceptedSendRecoveries.filter(
            (recovery) => recovery.target.chatId === chatId && recovery.phase !== 'completed',
          ).length,
          finalizations: snapshot.generationFinalizations.filter((entry) => entry.chatId === chatId).length,
          outbox: generationOutboxCount(snapshot),
        }
      },
      { timeout: 20_000 },
    )
    .toEqual({
      state: terminalState,
      jobs: 0,
      activities: 0,
      recoveries: 0,
      finalizations: 0,
      outbox: 0,
    })
  await expect
    .poll(
      async () => {
        const bootstrap = await authoritativeBootstrap(page)
        const operation = operationId
          ? bootstrap.generationOperations?.find((candidate) => candidate.operationId === operationId)
          : bootstrap.generationOperations?.find((candidate) => candidate.chatId === chatId)
        return {
          state: operation?.state,
          jobs: bootstrap.activeGenerationJobs?.filter((job) => job.chatId === chatId).length ?? 0,
          finalizations: bootstrap.generationFinalizations?.filter((entry) => entry.chatId === chatId).length ?? 0,
          effects: bootstrap.pendingGenerationEffects?.filter((entry) => entry.chatId === chatId).length ?? 0,
        }
      },
      { timeout: 20_000 },
    )
    .toEqual({ state: terminalState, jobs: 0, finalizations: 0, effects: 0 })
}

async function expectVisibleTranscript(page: Page, userText: string, replyText: string): Promise<void> {
  const user = page.locator('.default-chat-screen .risu-chat[data-chat-index="0"]')
  const reply = page.locator('.default-chat-screen .risu-chat[data-chat-index="1"]')
  await expect(user).toBeVisible({ timeout: 15_000 })
  await expect(user).toContainText(userText)
  await expect(reply).toBeVisible({ timeout: 15_000 })
  await expect(reply).toContainText(replyText)
  await expect(page.locator('.default-chat-screen .risu-chat[data-chat-index="2"]')).toHaveCount(0)
}

async function lifecycleSnapshot(page: Page): Promise<LifecycleSnapshot> {
  return (await page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getLifecycleSnapshot())) as LifecycleSnapshot
}

async function residentMessages(page: Page, chatId: string): Promise<ApiMessage[]> {
  return page.evaluate((targetChatId) => {
    const snapshot = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
    for (const character of snapshot.characters ?? []) {
      const chat = character.chats?.find((candidate) => candidate.id === targetChatId)
      if (chat) return (chat.message ?? []) as ApiMessage[]
    }
    return []
  }, chatId)
}

async function authoritativeMessages(page: Page, chatId: string): Promise<ApiMessage[]> {
  const result = await browserFetch(page, `/api/v1/chats/${encodeURIComponent(chatId)}/messages`)
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return ((result.body as { message?: ApiMessage[] }).message ?? []) as ApiMessage[]
}

async function authoritativeBootstrap(page: Page): Promise<BootstrapProjection> {
  const result = await browserFetch(page, '/api/v1/bootstrap')
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return result.body as BootstrapProjection
}

async function browserFetch(page: Page, pathname: string): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async (pathToFetch) => {
    const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
    const response = await fetch(pathToFetch, { headers })
    return { status: response.status, body: await response.json() }
  }, pathname)
}

async function waitForOperation(page: Page, chatId: string): Promise<OperationProjection> {
  await expect
    .poll(async () => (await operationForChat(page, chatId))?.operationId, { timeout: 15_000 })
    .toEqual(expect.any(String))
  return (await operationForChat(page, chatId))!
}

async function operationForChat(page: Page, chatId: string): Promise<OperationProjection | undefined> {
  return (await lifecycleSnapshot(page)).generationOperations.find((candidate) => candidate.chatId === chatId)
}

function generationOutboxCount(snapshot: LifecycleSnapshot): number {
  return snapshot.outbox.filter((entry) => entry.kind?.startsWith('generation-operation-')).length
}

function summarizeMessages(messages: ApiMessage[]): Array<{ role: string; data: string }> {
  return messages.map((message) => ({ role: message.role, data: message.data }))
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function lifecycleFixtureDatabase(): Record<string, unknown> {
  const chatRows = Object.values(chats).map((id) => ({
    id,
    name: id,
    note: '',
    localLore: [],
    message: [],
    generationSettings: {
      configured: true,
      personaId: 'persona-lifecycle',
      modelPresetId: 'model-preset-lifecycle',
      promptPresetId: 'prompt-preset-lifecycle',
      jailbreakToggle: false,
      sidebarToggles: {},
    },
  }))
  return {
    version: 1,
    didFirstSetup: true,
    formatversion: 5,
    currentChar: 0,
    selectedCharID: 0,
    characterOrder: [],
    characters: [
      {
        chaId: CHARACTER_ID,
        type: 'character',
        name: 'Lifecycle Character',
        desc: 'A deterministic lifecycle browser-smoke character.',
        utilityBot: false,
        chatPage: 0,
        firstMessage: '',
        customscript: [],
        globalLore: [],
        viewScreen: 'none',
        emotionImages: [],
        chats: chatRows,
      },
    ],
    formatingOrder: ['main', 'description', 'chats'],
    promptSettings: {
      assistantPrefill: '',
      postEndInnerFormat: '',
      sendChatAsSystem: false,
      sendName: false,
      utilOverride: false,
    },
    modelPresets: [{ id: 'model-preset-lifecycle', name: 'Lifecycle Model Preset' }],
    promptPresets: [{ id: 'prompt-preset-lifecycle', name: 'Lifecycle Prompt Preset', promptTemplate: [] }],
    loadouts: [],
    modules: [],
    username: 'Lifecycle User',
    selectedPersona: 0,
    personas: [
      {
        id: 'persona-lifecycle',
        name: 'Lifecycle User',
        icon: '',
        largePortrait: false,
        personaPrompt: '',
      },
    ],
    plugins: [],
    pluginCustomStorage: {},
    language: 'en',
    loreBookToken: 8000,
    mainPrompt: 'MAIN',
    maxContext: 100_000,
    maxResponse: 100,
    aiModel: 'echo_model',
    useStreaming: true,
    removeIncompleteResponse: false,
    requestRetrys: 0,
    echoMessage: 'unused browser-smoke echo',
    echoDelay: 0,
  }
}

async function importDatabase(app: FastifyInstance, auth: string, database: Record<string, unknown>): Promise<void> {
  await importFastBootstrapDatabase(app, auth, database, { dataDir: harness.dataDir })
}
