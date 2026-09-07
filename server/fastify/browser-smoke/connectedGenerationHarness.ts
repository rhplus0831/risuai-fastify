import { expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ChatProviderDispatchContext,
  ChatProviderDispatcher,
  GenerationChatRouteOptions,
} from '../src/routes/generationChat.js'
import type { StreamJob } from '../src/streamJobs.js'
import type { BrowserSmokeClientSessionSnapshot } from '@risuai/shared-core/browser-smoke'
import {
  closeFastBootstrapHarness,
  setObserverShellMode,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
  type FastBootstrapHarness,
} from './fastBootstrapHarness.js'

export const CHARACTER = 'connected-generation-character'
export const CHAT = 'connected-generation-chat'
export const OTHER_CHAT = 'connected-generation-other-chat'
export const ROUTE = `/character/${CHARACTER}/${CHAT}`
export const OTHER_ROUTE = `/character/${CHARACTER}/${OTHER_CHAT}`
export const REQUEST = 'One accepted request from the current writer.'
export const PARTIAL = 'Connected reader partial'
export const REPLY = `${PARTIAL} and canonical completed reply.`
export const IGP_SUFFIX = ' [One durable IGP effect]'
export const IGP_REPLY = `${REPLY}${IGP_SUFFIX}`
const SESSION_KEY = 'risu:active-writer-session-id'
const GENERATION_SETTINGS = {
  configured: true,
  personaId: 'reader-persona',
  modelPresetId: 'reader-model',
  promptPresetId: 'reader-prompt',
  jailbreakToggle: false,
  sidebarToggles: {},
}

function fixture(enabledIgp = false): Record<string, unknown> {
  const database = smallFastBootstrapFixture()
  const character = (database.characters as Array<Record<string, unknown>>)[0]!
  return {
    ...database,
    characterOrder: [CHARACTER],
    characters: [
      {
        ...character,
        chaId: CHARACTER,
        name: 'Generation Character',
        alternateGreetings: [],
        chats: [CHAT, OTHER_CHAT].map((id) => ({
          id,
          name: id === CHAT ? 'Generation Chat' : 'Other Chat',
          fmIndex: -1,
          note: '',
          localLore: [],
          message: [{ chatId: `seed-${id}`, role: 'char', data: `Committed seed for ${id}.` }],
          generationSettings: { ...GENERATION_SETTINGS },
        })),
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
    modelPresets: [{ id: 'reader-model', name: 'Reader Model' }],
    promptPresets: [{ id: 'reader-prompt', name: 'Reader Prompt', promptTemplate: [] }],
    username: 'Reader User',
    selectedPersona: 0,
    personas: [{ id: 'reader-persona', name: 'Reader User', icon: '', largePortrait: false, personaPrompt: '' }],
    loreBookToken: 8000,
    mainPrompt: 'MAIN',
    maxContext: 100_000,
    maxResponse: 100,
    aiModel: 'echo_model',
    subModel: 'echo_model',
    modelRoles: { emotion: 'echo_model' },
    useStreaming: true,
    removeIncompleteResponse: false,
    requestRetrys: 0,
    echoMessage: enabledIgp ? IGP_SUFFIX : 'unused deterministic echo',
    echoDelay: 0,
    // The queued-finalization journey executes a real scoped IGP message update
    // through the built-in local echo provider; other journeys disable effects.
    igpPrompt: enabledIgp ? '<|im_start|>system<|im_sep|>Return the deterministic fixture suffix.<|im_end|>' : '',
    notification: false,
    ttsAuto: false,
    playMessage: false,
  }
}

interface OperationRow {
  operation_id: string
  chat_id: string
  creator_writer_session_id: string
  creator_writer_epoch: number
  state: string
  current_attempt_no: number | null
  accepted_message_id: string | null
  result_message_id: string | null
  provider_may_have_run: number
  desired_terminal_outcome: string | null
}
interface AttemptRow {
  operation_id: string
  attempt_no: number
  job_id: string
  actor_writer_session_id: string
  actor_writer_epoch: number
  status: string
}
interface MessageRow {
  chat_id: string
  seq: number
  uid: string
  role: string
  data: string
  json: string
}
export interface EffectRow {
  database_lineage: string
  key_type: string
  key_id: string
  operation_id: string
  generation_id: string
  character_id: string
  chat_id: string
  message_id: string
  effect_kind: string
  effect_class: string
  status: string
  claim_id: string | null
  delivery: string | null
  reason: string | null
  claimed_at: string | null
  settled_at: string | null
  lease_expires_at: string | null
}

export function readGenerationTruth(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    return {
      ownership: db
        .prepare('SELECT lineage, active_writer_session_id, writer_epoch FROM database_metadata WHERE id = 1')
        .get() as { lineage: string; active_writer_session_id: string | null; writer_epoch: number },
      operations: db
        .prepare(
          'SELECT operation_id, chat_id, creator_writer_session_id, creator_writer_epoch, state, current_attempt_no, accepted_message_id, result_message_id, provider_may_have_run, desired_terminal_outcome FROM generation_operations ORDER BY created_at',
        )
        .all() as unknown as OperationRow[],
      attempts: db
        .prepare(
          'SELECT operation_id, attempt_no, job_id, actor_writer_session_id, actor_writer_epoch, status FROM generation_operation_attempts ORDER BY operation_id, attempt_no',
        )
        .all() as unknown as AttemptRow[],
      messages: db
        .prepare('SELECT chat_id, seq, uid, role, data, json FROM messages ORDER BY chat_id, seq')
        .all() as unknown as MessageRow[],
      finalizations: db
        .prepare(
          'SELECT generation_id, database_lineage, operation_id, operation_attempt_no, actor_writer_session_id, actor_writer_epoch, accepted_message_id, terminal_outcome, chat_id, status, failure_count, message_json FROM generation_finalization_retries ORDER BY generation_id',
        )
        .all(),
      effects: db
        .prepare(
          'SELECT database_lineage, key_type, key_id, operation_id, generation_id, character_id, chat_id, message_id, effect_kind, effect_class, status, claim_id, delivery, reason, claimed_at, settled_at, lease_expires_at FROM generation_effects ORDER BY effect_kind',
        )
        .all() as unknown as EffectRow[],
      persistedEvents: db
        .prepare(
          "SELECT revision, type, id, parent_id FROM command_events WHERE type = 'generation.persisted' ORDER BY revision",
        )
        .all(),
      messageUpdateEvents: db
        .prepare(
          "SELECT revision, type, id, parent_id, origin_writer_session_id FROM command_events WHERE type = 'message.updated' ORDER BY revision",
        )
        .all(),
    }
  } finally {
    db.close()
  }
}

/** The sole SQL write seam injects a storage failure before generation begins.
 * It never fabricates an operation, journal, message, effect, or receipt. */
export function setAssistantInsertFailure(dataDir: string, enabled: boolean): void {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    db.exec('DROP TRIGGER IF EXISTS browser_smoke_reader_finalization_failure')
    if (enabled)
      db.exec(
        `CREATE TRIGGER browser_smoke_reader_finalization_failure BEFORE INSERT ON messages WHEN NEW.chat_id = '${CHAT}' AND NEW.role = 'char' BEGIN SELECT RAISE(ABORT, 'browser smoke controlled finalization failure'); END`,
      )
  } finally {
    db.close()
  }
}

export class HeldReaderGenerationProvider {
  calls = 0
  aborts = 0
  job: StreamJob | undefined
  viewerStarts = 0
  private releaseHold!: () => void
  private readonly held = new Promise<void>((resolve) => {
    this.releaseHold = resolve
  })
  private viewerReady!: () => void
  private readonly ready = new Promise<void>((resolve) => {
    this.viewerReady = resolve
  })
  constructor(private readonly holdAfterAbort = false) {}
  readonly lifecycle: NonNullable<GenerationChatRouteOptions['onDurableLifecycleTransition']> = (transition, job) => {
    if (transition === 'registered') this.job = job
    if (transition === 'viewer_write_started') {
      this.viewerStarts += 1
      this.viewerReady()
    }
  }
  readonly dispatch: ChatProviderDispatcher = (context) => {
    this.calls += 1
    if (this.calls !== 1) throw new Error('Connected generation must dispatch exactly one provider invocation')
    return this.frames(context)
  }
  release(): void {
    this.releaseHold()
  }
  snapshot() {
    return {
      calls: this.calls,
      aborts: this.aborts,
      jobId: this.job?.id,
      operationId: this.job?.operationId,
      done: this.job?.done,
      aborted: this.job?.abortController.signal.aborted,
      viewers: this.job?.clients.size ?? 0,
      viewerStarts: this.viewerStarts,
    }
  }
  private async waitFor(promise: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const finish = () => {
        signal.removeEventListener('abort', finish)
        resolve()
      }
      signal.addEventListener('abort', finish, { once: true })
      void promise.then(finish)
    })
  }
  private async *frames(context: ChatProviderDispatchContext) {
    const onAbort = () => {
      this.aborts += 1
    }
    context.signal.addEventListener('abort', onAbort, { once: true })
    try {
      await this.waitFor(this.ready, context.signal)
      if (context.signal.aborted) return
      yield { kind: 'token' as const, content: PARTIAL }
      if (this.holdAfterAbort) await this.held
      else await this.waitFor(this.held, context.signal)
      if (context.signal.aborted) return
      yield { kind: 'token' as const, content: REPLY.slice(PARTIAL.length) }
      yield { kind: 'done' as const, finishReason: 'stop' }
    } finally {
      context.signal.removeEventListener('abort', onAbort)
    }
  }
}

interface FetchRecord {
  id: number
  at: number
  client: string
  method: string
  path: string
  query: string
  writerSession: string | null
  observerSession: string | null
  transfer: boolean
  expectedWriterEpoch: string | null
  expectedLineage: string | null
  canMutate: boolean | null
  revoked: boolean | null
  auditActive: boolean
  session: BrowserSmokeClientSessionSnapshot | null
  status?: number
  body: Record<string, unknown> | null
}
export interface GenerationClient {
  name: string
  context: BrowserContext
  page: Page
  sessionId: string
  timeOrigin: number
}
export interface GenerationPair {
  harness: FastBootstrapHarness
  provider: HeldReaderGenerationProvider
  a: GenerationClient
  b: GenerationClient
  clients: GenerationClient[]
  fetches: FetchRecord[]
  network: Array<{ client: string; method: string; path: string; writerSession: string | null }>
  errors: Array<{ client: string; message: string }>
  evidence: Record<string, unknown>
  ownerships: ReturnType<typeof readGenerationTruth>['ownership'][]
  finalizationFailureInstalled?: boolean
}

export async function createGenerationPair(
  browser: Browser,
  options: { holdAfterAbort?: boolean; finalizationFailure?: boolean; enabledIgp?: boolean } = {},
): Promise<GenerationPair> {
  const provider = new HeldReaderGenerationProvider(options.holdAfterAbort)
  const harness = await startFastBootstrapHarness(fixture(options.enabledIgp), {
    temporaryDirectoryPrefix: 'risu-connected-reader-generation-',
    databaseSeedMode: 'unowned-migration',
    generationChat: {
      dispatchProvider: provider.dispatch,
      onDurableLifecycleTransition: provider.lifecycle,
      viewerHeartbeatMs: 250,
      pushNotifications: false,
      finalizationRetry: { intervalMs: 100, baseDelayMs: 100, maxDelayMs: 200 },
    },
  })
  const pair = {
    harness,
    provider,
    clients: [],
    fetches: [],
    network: [],
    errors: [],
    evidence: {},
    ownerships: [],
  } as unknown as GenerationPair
  try {
    if (options.finalizationFailure) {
      setAssistantInsertFailure(harness.dataDir, true)
      pair.finalizationFailureInstalled = true
    }
    pair.a = await addGenerationClient(browser, pair, 'A')
    pair.b = await addGenerationClient(browser, pair, 'B')
    return pair
  } catch (error) {
    provider.release()
    for (const client of pair.clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
    throw error
  }
}

export async function addGenerationClient(
  browser: Browser,
  pair: GenerationPair,
  name: string,
): Promise<GenerationClient> {
  const context = await browser.newContext({ viewport: { width: 1365, height: 950 } })
  context.setDefaultTimeout(10_000)
  await setObserverShellMode(context, 'enabled')
  const requests = new Map<number, FetchRecord>()
  await context.exposeBinding('__recordConnectedGenerationFetch', (_source, record: Omit<FetchRecord, 'client'>) => {
    const existing = requests.get(record.id)
    if (existing) Object.assign(existing, record)
    else {
      const entry = { ...record, client: name }
      requests.set(record.id, entry)
      pair.fetches.push(entry)
    }
  })
  // Observe real calls at dispatch time. No request, response, production store,
  // or callback is replaced; the original fetch promise is returned unchanged.
  await context.addInitScript(() => {
    const observedWindow = window as unknown as {
      __recordConnectedGenerationFetch(record: unknown): Promise<void>
      __connectedGenerationAuditActive?: boolean
    }
    const original = window.fetch
    let requestId = 0
    window.fetch = function (input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      const snapshot = window.__RISU_FASTIFY_BROWSER_SMOKE__?.getStartupCoordinatorSnapshot()
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      let body: Record<string, unknown> | null = null
      if (
        typeof init?.body === 'string' &&
        (url.pathname === '/api/v1/generate/completion' ||
          /^\/api\/v1\/commands\/messages\/[^/]+$/u.test(url.pathname) ||
          /^\/api\/v1\/generation-effects\/[^/]+\/igp\/(?:claims|receipt)$/u.test(url.pathname))
      ) {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>
        } catch {}
      }
      const record = {
        id: ++requestId,
        at: performance.timeOrigin + performance.now(),
        method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
        path: url.pathname,
        query: url.search,
        writerSession: headers.get('risu-writer-session'),
        observerSession: headers.get('risu-writer-observer-session'),
        transfer: headers.get('risu-disconnect-existing-writer') === 'true',
        expectedWriterEpoch: headers.get('risu-expected-writer-epoch'),
        expectedLineage: headers.get('risu-expected-database-lineage'),
        canMutate: snapshot?.capabilities.canMutate ?? null,
        revoked: snapshot?.writerCapabilitiesRevoked ?? null,
        auditActive: observedWindow.__connectedGenerationAuditActive === true,
        session: window.__RISU_FASTIFY_BROWSER_SMOKE__?.getClientSessionSnapshot() ?? null,
        body,
      }
      const observed = url.origin === location.origin && url.pathname.startsWith('/api/')
      if (observed) void observedWindow.__recordConnectedGenerationFetch(record).catch(() => undefined)
      const response = original.call(this, input, init)
      if (observed)
        void response
          .then((value) => observedWindow.__recordConnectedGenerationFetch({ ...record, status: value.status }))
          .catch(() => undefined)
      return response
    }
  })
  const page = await context.newPage()
  const client = { name, context, page, sessionId: '', timeOrigin: 0 }
  pair.clients.push(client)
  context.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/'))
      pair.network.push({
        client: name,
        method: request.method(),
        path: url.pathname,
        writerSession: request.headers()['risu-writer-session'] ?? null,
      })
  })
  page.on('pageerror', (error) => {
    pair.errors.push({ client: name, message: error.message })
  })
  return client
}

async function readSession(client: GenerationClient): Promise<void> {
  await expect
    .poll(() => client.page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__)), { timeout: 30_000 })
    .toBe(true)
  await expect.poll(() => client.page.evaluate((key) => sessionStorage.getItem(key) ?? '', SESSION_KEY)).not.toBe('')
  client.sessionId = await client.page.evaluate((key) => sessionStorage.getItem(key)!, SESSION_KEY)
  client.timeOrigin = await client.page.evaluate(() => performance.timeOrigin)
}

export async function expectGenerationWriter(client: GenerationClient): Promise<void> {
  await expect
    .poll(
      () =>
        client.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
      { timeout: 30_000 },
    )
    .toMatchObject({ canMutate: true, canGenerate: true })
  await expect(client.page.locator('[data-observer-shell]')).toHaveCount(0)
  await expect(client.page.getByTestId('default-chat-composer')).toBeVisible()
  await expect(client.page).toHaveURL(new RegExp(`${ROUTE}$`))
}

export async function expectGenerationReader(client: GenerationClient, chatId = CHAT): Promise<void> {
  await expect(client.page.locator('[data-observer-lifecycle-status]')).toHaveText(
    'Read only. Updates from the writer appear here.',
    { timeout: 30_000 },
  )
  await expect(client.page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', chatId)
  await expect(client.page.locator('[data-reader-composer] textarea')).toBeDisabled()
  await expect
    .poll(() =>
      client.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
    )
    .toMatchObject({ canMutate: false, canGenerate: false })
  await expect(client.page).toHaveURL(new RegExp(`${chatId === CHAT ? ROUTE : OTHER_ROUTE}$`))
}

export async function openGenerationReader(pair: GenerationPair, client: GenerationClient): Promise<void> {
  await client.page.goto(`${pair.harness.baseUrl}${ROUTE}`)
  await readSession(client)
  await expectGenerationReader(client)
  await armRoleAudit(client)
  expect(client.sessionId).not.toBe(pair.a.sessionId)
}

async function armRoleAudit(client: GenerationClient): Promise<void> {
  // Initial bootstrap can legitimately register the first writer before the
  // writer-ready milestone. Audit every dispatch once the initial role is
  // established, including all later demotion and promotion transitions.
  await client.page.evaluate(() => {
    ;(window as unknown as { __connectedGenerationAuditActive: boolean }).__connectedGenerationAuditActive = true
  })
}

export async function bootGenerationPair(pair: GenerationPair): Promise<void> {
  expect(readGenerationTruth(pair.harness.dataDir).ownership).toMatchObject({
    active_writer_session_id: null,
    writer_epoch: 0,
  })
  await pair.a.page.goto(`${pair.harness.baseUrl}${ROUTE}`)
  await readSession(pair.a)
  await pair.a.page.evaluate(() =>
    window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
  )
  await expectGenerationWriter(pair.a)
  await armRoleAudit(pair.a)
  await openGenerationReader(pair, pair.b)
  expect(readGenerationTruth(pair.harness.dataDir).ownership).toMatchObject({
    active_writer_session_id: pair.a.sessionId,
    writer_epoch: 1,
  })
  pair.ownerships.push(readGenerationTruth(pair.harness.dataDir).ownership)
  // Imported settings are normalized during startup. Configure through the same
  // supported writer command as acceptedSendProtocol, never through SQLite.
  const result = await pair.a.page.evaluate(
    async ({ chatId, settings }) => {
      const hook = window.__RISU_FASTIFY_BROWSER_SMOKE__!
      const headers = await hook.activeWriterHeaders()
      let revision = ((await (await fetch('/api/v1/bootstrap', { headers })).json()) as { revision: number }).revision
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await fetch(`/api/v1/commands/chats/${chatId}/generation-settings`, {
          method: 'PUT',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ baseRevision: revision, generationSettings: settings }),
        })
        const body = (await response.json()) as { currentRevision?: number; error?: string }
        if (response.status !== 409 || body.error !== 'revision_conflict' || typeof body.currentRevision !== 'number')
          return { status: response.status, body }
        revision = body.currentRevision
      }
      throw new Error('Generation settings revision retry exhausted')
    },
    { chatId: CHAT, settings: GENERATION_SETTINGS },
  )
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  await expect
    .poll(() =>
      pair.a.page.evaluate(
        (chatId) =>
          window
            .__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
            .characters?.flatMap((character) => character.chats ?? [])
            .find((chat) => chat.id === chatId)?.generationSettings?.configured,
        CHAT,
      ),
    )
    .toBe(true)
}

export function generationMessageBody(page: Page, messageId: string) {
  return page.locator(`.risu-chat[data-risu-message-id="${messageId}"] .chat-message-body`)
}

export async function expectReaderPartial(client: GenerationClient): Promise<void> {
  await expect(
    client.page.locator('[data-reader-transcript] .chat-message-body').filter({ hasText: PARTIAL }),
  ).toHaveCount(1, { timeout: 30_000 })
  await expect(
    client.page.locator('[data-reader-transcript] .chat-message-body').filter({ hasText: PARTIAL }),
  ).toBeVisible()
  await expect(
    client.page.locator('[data-reader-transcript] .chat-message-container[data-generation-display-projection="send"]'),
  ).toHaveCount(1)
  await expect(client.page.getByTestId('default-chat-cancel-button')).toHaveCount(0)
}

export async function startHeldGeneration(pair: GenerationPair) {
  await pair.a.page.getByTestId('default-chat-composer').fill(REQUEST)
  await pair.a.page.getByTestId('default-chat-send-button').click()
  await expect(pair.a.page.locator('.default-chat-screen .chat-message-body').filter({ hasText: PARTIAL })).toBeVisible(
    { timeout: 30_000 },
  )
  await expect.poll(() => readGenerationTruth(pair.harness.dataDir).operations[0]?.state).toBe('owned_by_job')
  const truth = readGenerationTruth(pair.harness.dataDir)
  expect(truth.operations).toHaveLength(1)
  expect(truth.attempts).toHaveLength(1)
  const operation = truth.operations[0]!
  const attempt = truth.attempts[0]!
  expect(operation).toMatchObject({
    chat_id: CHAT,
    creator_writer_session_id: pair.a.sessionId,
    creator_writer_epoch: 1,
    current_attempt_no: 1,
    result_message_id: null,
    provider_may_have_run: 1,
  })
  expect(attempt).toMatchObject({
    operation_id: operation.operation_id,
    attempt_no: 1,
    actor_writer_session_id: pair.a.sessionId,
    actor_writer_epoch: 1,
    status: 'running',
  })
  expect(truth.messages.filter((message) => message.uid === operation.accepted_message_id)).toMatchObject([
    { role: 'user', data: REQUEST },
  ])
  expect(truth.messages.filter((message) => message.chat_id === CHAT)).toHaveLength(2)
  expect(truth.effects).toEqual([])
  expect(pair.provider.snapshot()).toMatchObject({
    calls: 1,
    aborts: 0,
    jobId: attempt.job_id,
    operationId: operation.operation_id,
    done: false,
    aborted: false,
  })
  await expectReaderPartial(pair.b)
  pair.evidence.running = truth
  return { operation, attempt }
}

export async function promoteGenerationWriter(
  pair: GenerationPair,
  next: GenerationClient,
  previous: GenerationClient,
  epoch: number,
): Promise<void> {
  const before = readGenerationTruth(pair.harness.dataDir).ownership
  expect(before).toMatchObject({ active_writer_session_id: previous.sessionId, writer_epoch: epoch - 1 })
  const firstRequest = pair.fetches.length
  await next.page.locator('[data-reader-use-this-device]').click()
  const confirm = next.page.getByRole('button', { name: 'Disconnect existing client', exact: true })
  await expect(confirm).toBeVisible()
  expect(readGenerationTruth(pair.harness.dataDir).ownership).toEqual(before)
  await confirm.click()
  await expect
    .poll(() => readGenerationTruth(pair.harness.dataDir).ownership, { timeout: 30_000 })
    .toEqual({ ...before, active_writer_session_id: next.sessionId, writer_epoch: epoch })
  pair.ownerships.push(readGenerationTruth(pair.harness.dataDir).ownership)
  await expectGenerationWriter(next)
  await expectGenerationReader(previous)
  const acquisitions = () =>
    pair.fetches.slice(firstRequest).filter((record) => record.client === next.name && isPromotionAcquisition(record))
  await expect
    .poll(() => acquisitions().map(({ transfer, status }) => ({ transfer, status })))
    .toEqual([
      { transfer: false, status: 409 },
      { transfer: true, status: 200 },
    ])
  for (const request of acquisitions())
    expect(request).toMatchObject({
      writerSession: next.sessionId,
      expectedWriterEpoch: String(epoch - 1),
      expectedLineage: before.lineage,
      canMutate: false,
      session: { lifecycle: 'promoting', recoveryAuthorized: false },
    })
  await expect
    .poll(() =>
      pair.fetches
        .slice(firstRequest)
        .some(
          (record) =>
            record.client === next.name &&
            isAuthorizedRecovery(record) &&
            record.path === '/api/v1/events' &&
            record.writerSession === next.sessionId &&
            record.status === 200,
        ),
    )
    .toBe(true)
  for (const client of [next, previous])
    expect(await client.page.evaluate(() => performance.timeOrigin)).toBe(client.timeOrigin)
}

const PURE_POST_PATHS = new Set([
  '/api/v1/diagnostics',
  '/api/v1/telemetry/startup',
  '/api/v1/settings',
  '/api/v1/collections',
  '/api/v1/characters',
  '/api/v1/characters/aggregate',
  '/api/v1/chats/messages/bulk',
  '/api/v1/characters/lorebooks/bulk',
  ...['display', 'sidebar', 'advanced', 'media', 'modules', 'agents', 'language', 'prompt'].map(
    (group) => `/api/v1/settings/${group}`,
  ),
  ...['modules', 'promptPresets', 'modelPresets', 'personas', 'plugins'].map((name) => `/api/v1/collections/${name}`),
])

function isPromotionAcquisition(record: FetchRecord): boolean {
  return (
    record.session?.lifecycle === 'promoting' &&
    record.method === 'GET' &&
    record.path === '/api/v1/bootstrap' &&
    record.writerSession !== null
  )
}

function isAuthorizedRecovery(record: FetchRecord): boolean {
  const session = record.session
  // Match the actual canUseClientRecoveryAccess contract. Neither a retained
  // writer ID nor canMutate=false establishes recovery authority on its own.
  return (
    session?.managed === true &&
    session.lifecycle === 'recovering-writer' &&
    session.recoveryAuthorized &&
    session.authenticated &&
    session.connection !== 'interrupted' &&
    session.sessionId !== null &&
    session.writer?.sessionId === session.sessionId
  )
}

function isPureRead(record: FetchRecord): boolean {
  if (/^\/api\/v1\/(?:proxy\/(?:fetch|plugin-fetch)|hub)(?:\/|$)/u.test(record.path)) return false
  if (['GET', 'HEAD', 'OPTIONS'].includes(record.method)) return true
  return (
    record.method === 'POST' &&
    (PURE_POST_PATHS.has(record.path) || /^\/api\/v1\/chats\/[^/]+\/display-sources$/u.test(record.path))
  )
}

export function expectNoReaderControl(pair: GenerationPair): void {
  const audited = pair.fetches.filter((record) => record.auditActive)
  expect(
    audited.every((record) => record.session?.managed === true),
    'Every audited dispatch has a real managed-session snapshot',
  ).toBe(true)
  const recoveries = audited.filter(isAuthorizedRecovery)
  for (const record of recoveries) {
    const session = record.session!
    expect(record.canMutate, 'Authorized recovery keeps ordinary mutation readiness closed').toBe(false)
    expect(pair.ownerships).toContainEqual({
      lineage: session.databaseLineage,
      active_writer_session_id: session.sessionId,
      writer_epoch: session.writer!.epoch,
    })
    if (record.writerSession !== null) expect(record.writerSession).toBe(session.sessionId)
    // This fixture has no undispatched outbox intent. Recovery may read status,
    // subscribe as writer, and acknowledge a retained command receipt only.
    expect(
      isPureRead(record) || (record.method === 'POST' && record.path === '/api/v1/commands/mutation-receipts/ack'),
      `Unexpected authority-bearing recovery call: ${JSON.stringify(record)}`,
    ).toBe(true)
  }
  const readerCalls = audited.filter(
    (record) => record.session?.lifecycle !== 'writing' && !isAuthorizedRecovery(record),
  )
  expect(readerCalls.length).toBeGreaterThan(0)
  const forbidden = readerCalls.filter((record) => {
    if (record.canMutate !== false) return true
    // The real UI performs a conditional ownership probe, then its confirmed
    // takeover. promoteGenerationWriter asserts both exact requests/statuses.
    if (isPromotionAcquisition(record))
      return !(
        record.writerSession === record.session?.sessionId &&
        record.expectedWriterEpoch === String(record.session?.writer?.epoch) &&
        record.expectedLineage === record.session?.databaseLineage
      )
    if (record.writerSession !== null) return true
    return !isPureRead(record)
  })
  expect(
    forbidden,
    'Readers, including demoted former writers, never dispatch control/effect/provider mutations',
  ).toEqual([])
  const key = (record: { client: string; method: string; path: string }) =>
    `${record.client}:${record.method}:${record.path}`
  const dispatches = new Map<string, number>()
  for (const record of pair.fetches) dispatches.set(key(record), (dispatches.get(key(record)) ?? 0) + 1)
  const uncovered = pair.network.filter((record) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(record.method) || record.path.startsWith('/api/v1/auth/')) return false
    const remaining = dispatches.get(key(record)) ?? 0
    dispatches.set(key(record), remaining - 1)
    return remaining <= 0
  })
  expect(uncovered, 'Every mutation transport is covered by the synchronous role recorder').toEqual([])
  pair.evidence.readerCalls = readerCalls
  pair.evidence.authorizedRecoveryCalls = recoveries
  pair.evidence.ownerships = pair.ownerships
}

export async function expectTerminalGeneration(
  pair: GenerationPair,
  state: 'completed' | 'cancelled',
  reply: string,
  operationId: string,
  jobId: string,
  clients = [pair.a, pair.b],
) {
  await expect
    .poll(() => readGenerationTruth(pair.harness.dataDir).operations[0]?.state, { timeout: 30_000 })
    .toBe(state)
  const truth = readGenerationTruth(pair.harness.dataDir)
  expect(truth.operations).toHaveLength(1)
  expect(truth.operations[0]).toMatchObject({
    operation_id: operationId,
    state,
    current_attempt_no: null,
    creator_writer_session_id: pair.a.sessionId,
    creator_writer_epoch: 1,
  })
  expect(truth.attempts).toMatchObject([{ operation_id: operationId, attempt_no: 1, job_id: jobId, status: state }])
  expect(truth.attempts).toHaveLength(1)
  const resultId = truth.operations[0]!.result_message_id!
  expect(resultId).toMatch(/\S/u)
  const messages = truth.messages.filter((message) => message.chat_id === CHAT)
  expect(messages).toHaveLength(3)
  expect(messages.filter((message) => message.uid === resultId)).toMatchObject([{ role: 'char', data: reply }])
  expect(JSON.parse(messages.find((message) => message.uid === resultId)!.json).generationInfo).toMatchObject({
    operationId,
    generationId: jobId,
  })
  expect(truth.finalizations).toEqual([])
  expect(truth.persistedEvents).toHaveLength(1)
  for (const client of clients) {
    await expect(generationMessageBody(client.page, resultId)).toContainText(reply, { timeout: 30_000 })
    await expect
      .poll(() =>
        client.page.locator('.risu-chat[data-risu-message-id]').evaluateAll((rows) =>
          rows
            .map((row) => row.getAttribute('data-risu-message-id'))
            .filter(Boolean)
            .sort(),
        ),
      )
      .toEqual(messages.map((message) => message.uid).sort())
    await expect(client.page.locator('[data-generation-display-projection]')).toHaveCount(0)
    await expect(client.page.locator('.chat-generation-loading[aria-busy="true"]')).toHaveCount(0)
  }
  expect(pair.provider.snapshot()).toMatchObject({
    calls: 1,
    aborts: state === 'cancelled' ? 1 : 0,
    jobId,
    operationId,
    done: true,
  })
  return truth
}

export async function expectEffectReceipts(
  pair: GenerationPair,
  operationId: string,
  delivery: 'live_terminal' | 'late_recovery',
  enabledIgp = false,
): Promise<EffectRow[]> {
  // All seven rows are mandatory even with disabled features. In particular,
  // asserting only no duplicate keys on an empty ledger would be vacuous.
  const expected = [
    ['completion_sound', 'ephemeral', delivery === 'late_recovery' ? 'late_recovery' : 'not_configured'],
    ['emotion_image_state', 'recomputed', 'current_state_not_applicable'],
    ['generated_translation', 'durable', 'not_applicable'],
    ['igp', 'durable', 'not_configured'],
    ['notification', 'ephemeral', delivery === 'late_recovery' ? 'late_recovery' : 'not_configured'],
    ['plugin_output', 'durable', 'not_configured'],
    ['tts', 'ephemeral', delivery === 'late_recovery' ? 'late_recovery' : 'not_requested'],
  ].map(([effect_kind, effect_class, reason]) => ({
    effect_kind,
    effect_class,
    status: effect_kind === 'igp' && enabledIgp ? 'completed' : 'skipped',
    reason: effect_kind === 'igp' && enabledIgp ? null : reason,
    delivery: effect_kind === 'generated_translation' ? 'server' : delivery,
  }))
  await expect
    .poll(
      () =>
        readGenerationTruth(pair.harness.dataDir).effects.map(
          ({ effect_kind, effect_class, status, reason, delivery }) => ({
            effect_kind,
            effect_class,
            status,
            reason,
            delivery,
          }),
        ),
      { timeout: 30_000 },
    )
    .toEqual(expected)
  const truth = readGenerationTruth(pair.harness.dataDir)
  const operation = truth.operations[0]!
  for (const effect of truth.effects) {
    expect(effect).toMatchObject({
      database_lineage: truth.ownership.lineage,
      key_type: 'operation',
      key_id: operationId,
      operation_id: operationId,
      generation_id: truth.attempts[0]!.job_id,
      character_id: CHARACTER,
      chat_id: CHAT,
      message_id: operation.result_message_id,
    })
    expect(effect.claim_id).toMatch(/\S/u)
    expect(effect.claimed_at).toMatch(/\S/u)
    expect(effect.settled_at).toMatch(/\S/u)
  }
  expect(new Set(truth.effects.map((effect) => effect.claim_id)).size).toBe(7)
  return truth.effects
}

export async function finishGenerationPair(pair: GenerationPair, testInfo: TestInfo): Promise<void> {
  try {
    const output = testInfo.outputPath('connected-reader-generation.json')
    writeFileSync(
      output,
      JSON.stringify(
        {
          ...pair.evidence,
          terminal: readGenerationTruth(pair.harness.dataDir),
          provider: pair.provider.snapshot(),
          fetches: pair.fetches,
          network: pair.network,
          errors: pair.errors,
          sessions: pair.clients.map(({ name, sessionId, timeOrigin }) => ({ name, sessionId, timeOrigin })),
        },
        null,
        2,
      ),
    )
    await testInfo.attach('connected-reader-generation', { path: output, contentType: 'application/json' })
    if (testInfo.status !== testInfo.expectedStatus)
      for (const client of pair.clients)
        if (!client.page.isClosed())
          await client.page
            .screenshot({ path: testInfo.outputPath(`reader-generation-${client.name}.png`) })
            .catch(() => undefined)
  } finally {
    pair.provider.release()
    if (pair.finalizationFailureInstalled) setAssistantInsertFailure(pair.harness.dataDir, false)
    for (const client of pair.clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(pair.harness)
  }
}
