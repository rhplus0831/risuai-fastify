import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
  type TestInfo,
} from '@playwright/test'
import { writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getSchemaState } from '../src/db.js'
import type {
  ChatProviderDispatchContext,
  ChatProviderDispatcher,
  GenerationChatRouteOptions,
} from '../src/routes/generationChat.js'
import type { StreamJob } from '../src/streamJobs.js'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
  type FastBootstrapHarness,
} from './fastBootstrapHarness.js'
import {
  analyzeHorizontalLayoutFrames,
  findOwnedLayoutShifts,
  formatLayoutFrameFailure,
  startLayoutFrameSampler,
  startLayoutShiftSampler,
  stopLayoutFrameSampler,
  stopLayoutShiftSampler,
} from './layoutFrameSampler.js'

const CHARACTER_A = 'connected-switch-character-a'
const CHARACTER_B = 'connected-switch-character-b'
const CHAT_A = 'connected-switch-chat-a'
const CHAT_B = 'connected-switch-chat-b'
const ROUTE_A = `/character/${CHARACTER_A}/${CHAT_A}`
const ROUTE_B = `/character/${CHARACTER_B}/${CHAT_B}`
const SESSION_KEY = 'risu:active-writer-session-id'
const UNSENT_A = 'This unsent composer draft belongs only to device A.'
const GENERATION_REQUEST = 'A accepted this generation before ownership moved.'
const GENERATION_PARTIAL = 'Held generation'
const GENERATION_REPLY = `${GENERATION_PARTIAL} completed after takeover.`
const GENERATION_SETTINGS = {
  configured: true,
  personaId: 'switch-persona',
  modelPresetId: 'switch-model-preset',
  promptPresetId: 'switch-prompt-preset',
  jailbreakToggle: false,
  sidebarToggles: {},
}
const SHELL_LAYOUT_SELECTORS = {
  rail: '[data-risu-navigation-rail]',
  panel: '[data-risu-shell-sidebar-panel]',
  main: '[data-risu-shell-main]',
}

interface Ownership {
  lineage: string
  active_writer_session_id: string | null
  writer_epoch: number
}

interface MessageRow {
  chat_id: string
  seq: number
  uid: string
  role: string
  data: string
  json: string
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
}

interface AttemptRow {
  operation_id: string
  attempt_no: number
  job_id: string
  actor_writer_session_id: string
  actor_writer_epoch: number
  status: string
}

interface ApiRecord {
  client: 'A' | 'B'
  method: string
  path: string
  query: string
  writerSession: string | null
  observerSession: string | null
  disconnectExistingWriter: string | null
  expectedWriterEpoch: string | null
  expectedLineage: string | null
  status?: number
}

interface Client {
  name: 'A' | 'B'
  context: BrowserContext
  page: Page
  sessionId: string
  timeOrigin: number
}

interface Pair {
  harness: FastBootstrapHarness
  a: Client
  b: Client
  apiRequests: ApiRecord[]
  documentRequests: { client: 'A' | 'B'; path: string }[]
  scriptResponses: { client: 'A' | 'B'; url: string; path: string; status: number }[]
  consoleDiagnostics: { client: 'A' | 'B'; type: string; text: string }[]
  pageErrors: { client: 'A' | 'B'; message: string }[]
}

function fixture(): Record<string, unknown> {
  const database = smallFastBootstrapFixture()
  const baseCharacter = (database.characters as Array<Record<string, unknown>>)[0]!
  return {
    ...database,
    characterOrder: [CHARACTER_A, CHARACTER_B],
    characters: [
      [CHARACTER_A, CHAT_A, 'A'],
      [CHARACTER_B, CHAT_B, 'B'],
    ].map(([characterId, chatId, suffix]) => ({
      ...baseCharacter,
      chaId: characterId,
      name: `Switch Character ${suffix}`,
      desc: 'A deterministic connected writer switching fixture.',
      alternateGreetings: [],
      chats: [
        {
          id: chatId,
          name: `Switch Chat ${suffix}`,
          fmIndex: -1,
          note: '',
          localLore: [],
          message: [{ chatId: `switch-seed-${suffix}`, role: 'char', data: `Committed switch seed ${suffix}.` }],
          generationSettings: { ...GENERATION_SETTINGS },
        },
      ],
    })),
    formatingOrder: ['main', 'description', 'chats'],
    promptSettings: {
      assistantPrefill: '',
      postEndInnerFormat: '',
      sendChatAsSystem: false,
      sendName: false,
      utilOverride: false,
    },
    modelPresets: [{ id: 'switch-model-preset', name: 'Switch Model Preset' }],
    promptPresets: [{ id: 'switch-prompt-preset', name: 'Switch Prompt Preset', promptTemplate: [] }],
    username: 'Switch User',
    selectedPersona: 0,
    personas: [{ id: 'switch-persona', name: 'Switch User', icon: '', largePortrait: false, personaPrompt: '' }],
    loreBookToken: 8000,
    mainPrompt: 'MAIN',
    maxContext: 100_000,
    maxResponse: 100,
    aiModel: 'echo_model',
    useStreaming: true,
    removeIncompleteResponse: false,
    requestRetrys: 0,
    echoMessage: 'unused connected switching echo',
    echoDelay: 0,
  }
}

function durableSnapshot(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    const settingsRow = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
    const settings = JSON.parse(settingsRow.data_json) as { currentChar?: number }
    const characters = db.prepare('SELECT id, position FROM characters ORDER BY position').all() as Array<{
      id: string
      position: number
    }>
    return {
      revision: getSchemaState(db).revision,
      ownership: db
        .prepare('SELECT lineage, active_writer_session_id, writer_epoch FROM database_metadata WHERE id = 1')
        .get() as unknown as Ownership,
      selectedCharacterId: characters[settings.currentChar ?? 0]?.id,
      messages: db
        .prepare('SELECT chat_id, seq, uid, role, data, json FROM messages ORDER BY chat_id, seq')
        .all() as unknown as MessageRow[],
      events: db
        .prepare(
          'SELECT revision, type, resource, id, parent_id, origin_writer_session_id FROM command_events ORDER BY revision',
        )
        .all() as Array<{
        revision: number
        type: string
        resource: string
        id: string
        parent_id: string | null
        origin_writer_session_id: string | null
      }>,
      operations: db
        .prepare(
          'SELECT operation_id, chat_id, creator_writer_session_id, creator_writer_epoch, state, current_attempt_no, accepted_message_id, result_message_id, provider_may_have_run FROM generation_operations ORDER BY created_at',
        )
        .all() as unknown as OperationRow[],
      attempts: db
        .prepare(
          'SELECT operation_id, attempt_no, job_id, actor_writer_session_id, actor_writer_epoch, status FROM generation_operation_attempts ORDER BY operation_id, attempt_no',
        )
        .all() as unknown as AttemptRow[],
      finalizations: db
        .prepare(
          'SELECT generation_id, operation_id, chat_id, status FROM generation_finalization_retries ORDER BY generation_id',
        )
        .all(),
    }
  } finally {
    db.close()
  }
}

async function createPair(browser: Browser, generationChat?: GenerationChatRouteOptions): Promise<Pair> {
  const harness = await startFastBootstrapHarness(fixture(), {
    temporaryDirectoryPrefix: 'risu-connected-writer-switching-',
    databaseSeedMode: 'unowned-migration',
    generationChat,
  })
  const contexts: BrowserContext[] = []
  try {
    const contextA = await browser.newContext({ viewport: { width: 1365, height: 950 } })
    contexts.push(contextA)
    const contextB = await browser.newContext({ viewport: { width: 1365, height: 950 } })
    contexts.push(contextB)
    for (const context of contexts) {
      context.setDefaultTimeout(10_000)
    }
    const pair: Pair = {
      harness,
      a: { name: 'A', context: contextA, page: await contextA.newPage(), sessionId: '', timeOrigin: 0 },
      b: { name: 'B', context: contextB, page: await contextB.newPage(), sessionId: '', timeOrigin: 0 },
      apiRequests: [],
      documentRequests: [],
      scriptResponses: [],
      consoleDiagnostics: [],
      pageErrors: [],
    }
    for (const client of [pair.a, pair.b]) {
      const requests = new Map<Request, ApiRecord>()
      client.context.on('request', (request) => {
        const url = new URL(request.url())
        if (request.resourceType() === 'document')
          pair.documentRequests.push({ client: client.name, path: url.pathname })
        if (!url.pathname.startsWith('/api/')) return
        const headers = request.headers()
        const record: ApiRecord = {
          client: client.name,
          method: request.method(),
          path: url.pathname,
          query: url.search,
          writerSession: headers['risu-writer-session'] ?? null,
          observerSession: headers['risu-writer-observer-session'] ?? null,
          disconnectExistingWriter: headers['risu-disconnect-existing-writer'] ?? null,
          expectedWriterEpoch: headers['risu-expected-writer-epoch'] ?? null,
          expectedLineage: headers['risu-expected-database-lineage'] ?? null,
        }
        requests.set(request, record)
        pair.apiRequests.push(record)
      })
      client.context.on('response', (response) => {
        const request = response.request()
        const record = requests.get(request)
        if (record) record.status = response.status()
        if (request.resourceType() === 'script' && response.ok()) {
          pair.scriptResponses.push({
            client: client.name,
            url: response.url(),
            path: new URL(response.url()).pathname,
            status: response.status(),
          })
        }
      })
      client.page.on('pageerror', (error) => pair.pageErrors.push({ client: client.name, message: error.message }))
      client.page.on('console', (message) => {
        if (message.type() === 'warning' || message.type() === 'error') {
          pair.consoleDiagnostics.push({ client: client.name, type: message.type(), text: message.text() })
        }
      })
    }
    return pair
  } catch (error) {
    for (const context of contexts) await context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
    throw error
  }
}

function messageBody(page: Page, messageId: string) {
  return page.locator(`.risu-chat[data-risu-message-id="${messageId}"] .chat-message-body`)
}

async function waitForSmokeHook(client: Client): Promise<void> {
  await expect
    .poll(() => client.page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__)), { timeout: 30_000 })
    .toBe(true)
  await expect.poll(() => client.page.evaluate((key) => sessionStorage.getItem(key) ?? '', SESSION_KEY)).not.toBe('')
  client.sessionId = await client.page.evaluate((key) => sessionStorage.getItem(key) ?? '', SESSION_KEY)
  expect(client.sessionId).not.toBe('')
  client.timeOrigin = await client.page.evaluate(() => performance.timeOrigin)
}

async function expectWriter(client: Client, route: string): Promise<void> {
  await expect
    .poll(
      () =>
        client.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
      { timeout: 30_000 },
    )
    .toMatchObject({ canMutate: true, canGenerate: true })
  await expect(client.page.getByTestId('default-chat-composer')).toBeVisible()
  await expect(client.page.getByTestId('default-chat-composer')).toBeEnabled()
  await expect(client.page).toHaveURL(new RegExp(`${route}$`))
}

async function expectReader(client: Client, route: string, chatId: string): Promise<void> {
  await expect(client.page.locator('[data-reader-lifecycle-status]')).toHaveText(
    'Read only. Updates from the writer appear here.',
    { timeout: 30_000 },
  )
  await expect(client.page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', chatId)
  await expect(client.page.locator('[data-reader-composer-field="message"]')).toBeDisabled()
  await expect(client.page.locator('[data-reader-use-this-device]')).toBeEnabled()
  await expect
    .poll(() =>
      client.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities),
    )
    .toMatchObject({ canApplyRoutes: true, canMutate: false, canGenerate: false })
  await expect(client.page).toHaveURL(new RegExp(`${route}$`))
}

async function expectNoReload(pair: Pair): Promise<void> {
  for (const client of [pair.a, pair.b]) {
    expect(await client.page.evaluate(() => performance.timeOrigin), `${client.name} keeps its document`).toBe(
      client.timeOrigin,
    )
    expect(
      pair.documentRequests.filter((request) => request.client === client.name),
      `${client.name} makes no replacement document request`,
    ).toHaveLength(1)
    expect(await client.page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)).toBe(client.sessionId)
  }
}

async function bootPair(pair: Pair): Promise<Ownership> {
  const initial = durableSnapshot(pair.harness.dataDir).ownership
  expect(initial).toMatchObject({ active_writer_session_id: null, writer_epoch: 0 })
  await pair.a.page.goto(`${pair.harness.baseUrl}${ROUTE_A}`)
  await waitForSmokeHook(pair.a)
  await pair.a.page.evaluate(() =>
    window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
  )
  await expectWriter(pair.a, ROUTE_A)
  await expect(messageBody(pair.a.page, 'switch-seed-A')).toContainText('Committed switch seed A.')
  await pair.b.page.goto(`${pair.harness.baseUrl}${ROUTE_A}`)
  await waitForSmokeHook(pair.b)
  await expectReader(pair.b, ROUTE_A, CHAT_A)
  await expect(messageBody(pair.b.page, 'switch-seed-A')).toContainText('Committed switch seed A.')
  expect(pair.a.sessionId).not.toBe(pair.b.sessionId)
  expect(durableSnapshot(pair.harness.dataDir).ownership).toEqual({
    ...initial,
    active_writer_session_id: pair.a.sessionId,
    writer_epoch: 1,
  })
  const readerBootstrap = pair.apiRequests.filter(
    (request) => request.client === 'B' && request.path === '/api/v1/bootstrap',
  )
  expect(readerBootstrap.length).toBeGreaterThan(0)
  expect(
    readerBootstrap.every((request) => request.writerSession === null && request.observerSession === pair.b.sessionId),
  ).toBe(true)
  await expectNoReload(pair)
  return initial
}

async function promoteViaUi(pair: Pair, client: Client, previous: Client, route: string, epoch: number): Promise<void> {
  const before = durableSnapshot(pair.harness.dataDir).ownership
  expect(before.active_writer_session_id).toBe(previous.sessionId)
  expect(before.writer_epoch).toBe(epoch - 1)
  const start = pair.apiRequests.length
  await client.page.locator('[data-reader-use-this-device]').click()
  const confirmation = client.page.getByRole('button', { name: 'Disconnect existing client', exact: true })
  await expect(confirmation).toBeVisible()
  expect(durableSnapshot(pair.harness.dataDir).ownership).toEqual(before)
  expect(
    await client.page.evaluate(
      () => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities.canMutate,
    ),
  ).toBe(false)
  await confirmation.click()
  await expect
    .poll(() => durableSnapshot(pair.harness.dataDir).ownership, { timeout: 30_000 })
    .toEqual({ ...before, active_writer_session_id: client.sessionId, writer_epoch: epoch })
  await expectWriter(client, route)
  const confirmed = pair.apiRequests
    .slice(start)
    .filter(
      (request) =>
        request.client === client.name &&
        request.path === '/api/v1/bootstrap' &&
        request.disconnectExistingWriter === 'true',
    )
  expect(confirmed).toHaveLength(1)
  expect(confirmed[0]).toMatchObject({
    writerSession: client.sessionId,
    expectedWriterEpoch: String(epoch - 1),
    expectedLineage: before.lineage,
    status: 200,
  })
  await expectNoReload(pair)
}

async function holdNativeGetResponses(page: Page, pathname: string) {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const responses: Array<{ status: number; delivered: boolean; deliveryFailed?: boolean }> = []
  const matches = (url: URL) => url.pathname === pathname
  const handler = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const record = { status: response.status(), delivered: false, deliveryFailed: false }
    responses.push(record)
    await held
    try {
      // Preserve the complete native response; only its delivery is scheduled.
      await route.fulfill({ response })
      record.delivered = true
    } catch {
      record.deliveryFailed = true
    }
  }
  await page.route(matches, handler)
  return {
    responses,
    release,
    async dispose() {
      release()
      await page.unroute(matches, handler)
    },
  }
}

type RecoveryPause = 'reader-events' | 'acquisition-json' | 'hydration-json' | 'writer-events'

declare global {
  interface Window {
    __heldRecoveryResponse?: {
      reached: boolean
      released: boolean
      settled: boolean
      aborted: boolean
      status?: number
      release(fail?: boolean): void
      dispose(): void
    }
  }
}

/** Hold native transport completion even after abort, leaving all client owners real. */
async function holdRecoveryResponse(page: Page, pause: RecoveryPause): Promise<void> {
  await page.evaluate((pause) => {
    const nativeFetch = window.fetch
    let selected = false
    let release!: (fail: boolean) => void
    const held = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const fault: NonNullable<Window['__heldRecoveryResponse']> = {
      reached: false,
      released: false,
      settled: false,
      aborted: false,
      release(fail = false) {
        fault.released = true
        release(fail)
      },
      dispose() {
        fault.release()
        window.fetch = nativeFetch
      },
    }
    window.__heldRecoveryResponse = fault
    window.fetch = async (input, init) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input), location.href).pathname
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      const writer = headers.has('risu-writer-session')
      const matches =
        pause === 'reader-events'
          ? pathname === '/api/v1/events' && !writer
          : pause === 'writer-events'
            ? pathname === '/api/v1/events' && writer
            : pause === 'acquisition-json'
              ? pathname === '/api/v1/bootstrap' && headers.get('risu-disconnect-existing-writer') === 'true'
              : pathname === '/api/v1/resources/shell'
      if (selected || !matches) return nativeFetch(input, init)
      selected = true
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      signal?.addEventListener(
        'abort',
        () => {
          fault.aborted = true
        },
        { once: true },
      )
      // Only this external fault ignores abort. Preserve the server's actual response.
      const response = await nativeFetch(input, { ...init, signal: undefined })
      fault.status = response.status
      const wait = async () => {
        fault.reached = true
        const fail = await held
        fault.settled = true
        if (fail) throw new Error('Injected late recovery transport failure')
      }
      if (pause.endsWith('-json')) {
        const body = await response.json()
        response.json = async () => {
          await wait()
          return body
        }
      } else {
        try {
          await wait()
        } finally {
          // The native network intentionally ignored cancellation; release its socket too.
          if (fault.aborted) void response.body?.cancel().catch(() => undefined)
        }
      }
      return response
    }
  }, pause)
}

async function setRecoveryVisibility(page: Page, state: DocumentVisibilityState): Promise<void> {
  await page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

for (const pause of ['reader-events', 'acquisition-json', 'hydration-json', 'writer-events'] as const) {
  for (const lateResult of ['success', 'failure'] as const) {
    test(`reader promotion replaces held ${pause} before late ${lateResult}`, async ({ browser }, testInfo) => {
      test.setTimeout(90_000)
      const pair = await createPair(browser)
      const evidence: Record<string, unknown> = { pause, lateResult }
      const writerStreams: ServerResponse[] = []
      const onRequest = (request: IncomingMessage, response: ServerResponse) => {
        if (
          new URL(request.url ?? '/', pair.harness.baseUrl).pathname === '/api/v1/events' &&
          request.headers['risu-writer-session'] === pair.b.sessionId
        )
          writerStreams.push(response)
      }
      pair.harness.app.server.on('request', onRequest)
      try {
        await bootPair(pair)
        await pair.a.page.getByTestId('default-chat-composer').fill(UNSENT_A)
        await holdRecoveryResponse(pair.b.page, pause)
        await pair.b.page.locator('[data-reader-use-this-device]').click()
        if (pause !== 'reader-events') {
          await pair.b.page.getByRole('button', { name: 'Disconnect existing client', exact: true }).click()
        }
        await expect.poll(() => pair.b.page.evaluate(() => window.__heldRecoveryResponse!.reached)).toBe(true)
        expect(await pair.b.page.evaluate(() => window.__heldRecoveryResponse!.status)).toBe(200)
        expect(
          await pair.b.page.evaluate(
            () => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities.canMutate,
          ),
        ).toBe(false)

        await setRecoveryVisibility(pair.b.page, 'hidden')
        // Retirement must cancel now; eventual success after the 30s control
        // deadline would hide a missing lease cancellation behind polling.
        expect(await pair.b.page.evaluate(() => window.__heldRecoveryResponse!.aborted)).toBe(true)
        // Before authorization, retry requires explicit promotion. After authorization,
        // the same owner resumes writer recovery on foreground without a new takeover.
        const authorized = pause === 'hydration-json' || pause === 'writer-events'
        await expect
          .poll(() =>
            pair.b.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot().lifecycle),
          )
          .toBe(authorized ? 'recovering-writer' : 'reading')
        expect(await pair.b.page.evaluate(() => window.__heldRecoveryResponse!.released)).toBe(false)
        await setRecoveryVisibility(pair.b.page, 'visible')
        if (authorized) await expectWriter(pair.b, ROUTE_A)
        else {
          await expectReader(pair.b, ROUTE_A, CHAT_A)
          await expect(pair.b.page.locator('[data-reader-use-this-device]')).toHaveAttribute('aria-busy', 'false')
          if (pause === 'reader-events') await promoteViaUi(pair, pair.b, pair.a, ROUTE_A, 2)
          else {
            await pair.b.page.locator('[data-reader-use-this-device]').click()
            await expectWriter(pair.b, ROUTE_A)
          }
        }
        await expectReader(pair.a, ROUTE_A, CHAT_A)
        const replacement = await pair.b.page.evaluate(() =>
          window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot(),
        )
        evidence.replacementBeforeRelease = replacement
        expect(
          await pair.b.page.evaluate(() => ({
            released: window.__heldRecoveryResponse!.released,
            aborted: window.__heldRecoveryResponse!.aborted,
          })),
        ).toEqual({ released: false, aborted: true })
        await pair.b.page.getByTestId('default-chat-composer').fill('Newer replacement draft')
        const durableBeforeRelease = durableSnapshot(pair.harness.dataDir)
        const replacementStream = writerStreams.at(-1)!
        const streamCount = writerStreams.length
        expect(replacementStream).toBeDefined()
        expect(replacementStream.destroyed || replacementStream.writableEnded).toBe(false)

        await pair.b.page.evaluate((fail) => window.__heldRecoveryResponse!.release(fail), lateResult === 'failure')
        await expect.poll(() => pair.b.page.evaluate(() => window.__heldRecoveryResponse!.settled)).toBe(true)
        await expectWriter(pair.b, ROUTE_A)
        expect(
          await pair.b.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot()),
        ).toEqual(replacement)
        await expect(pair.b.page.getByTestId('default-chat-composer')).toHaveValue('Newer replacement draft')
        expect(durableSnapshot(pair.harness.dataDir)).toEqual(durableBeforeRelease)
        evidence.postReleaseRevision = await commitVisibleMessage(
          pair,
          pair.b,
          pair.a,
          await writerHeaders(pair.b),
          CHAT_A,
          `late-${pause}-${lateResult}`,
          'Replacement writer committed after the retired response settled.',
        )
        await expect(messageBody(pair.b.page, `late-${pause}-${lateResult}`)).toContainText(
          'Replacement writer committed after the retired response settled.',
        )
        expect(writerStreams).toHaveLength(streamCount)
        expect(writerStreams.at(-1)).toBe(replacementStream)
        expect(replacementStream.destroyed || replacementStream.writableEnded).toBe(false)
        evidence.replacementStreamSurvived = true
        expect((await composerDrafts(pair.a)).some((draft) => draft.messageInput === UNSENT_A)).toBe(true)
        await expectNoReload(pair)
        expect(pair.pageErrors).toEqual([])
      } finally {
        pair.harness.app.server.off('request', onRequest)
        await pair.b.page.evaluate(() => window.__heldRecoveryResponse?.dispose()).catch(() => undefined)
        await finishPair(pair, testInfo, evidence)
      }
    })
  }
}

async function promoteWithPendingStartupChat(pair: Pair, evidence: Record<string, unknown>): Promise<void> {
  const characterA = await holdNativeGetResponses(pair.a.page, `/api/v1/characters/${CHARACTER_A}`)
  const chatB = await holdNativeGetResponses(pair.a.page, `/api/v1/chats/${CHAT_B}/messages`)
  const scheduling: Record<string, unknown> = {
    heldResponses: { characterA: characterA.responses, chatB: chatB.responses },
  }
  evidence.startupTargetScheduling = scheduling
  let promotion: Promise<void> | undefined
  try {
    promotion = promoteViaUi(pair, pair.a, pair.b, ROUTE_B, 3)
    void promotion.catch(() => undefined)
    await expect.poll(() => characterA.responses.length, { timeout: 30_000 }).toBeGreaterThan(0)
    await expect.poll(() => chatB.responses.length, { timeout: 30_000 }).toBeGreaterThan(0)
    expect(characterA.responses.every((response) => response.status === 200 && !response.delivered)).toBe(true)
    expect(chatB.responses.every((response) => response.status === 200 && !response.delivered)).toBe(true)

    // Eager hydration can also request B. Require the actual startup owner to
    // be awaiting B before allowing the retained A route to finish its reads.
    const pendingB = () =>
      pair.a.page.evaluate(
        ({ characterId, chatId }) => {
          const smoke = window.__RISU_FASTIFY_BROWSER_SMOKE__!
          const generation = smoke.getClientSessionSnapshot().generation
          return smoke.getStartupChatReadinessEvaluations().find((evaluation) => {
            const target = evaluation.target.split('\u0000')
            return (
              evaluation.sessionGeneration === generation &&
              evaluation.phase === 'chat-and-prompt' &&
              target[3] === characterId &&
              target[4] === chatId
            )
          })
        },
        { characterId: CHARACTER_B, chatId: CHAT_B },
      )
    await expect.poll(pendingB, { timeout: 30_000 }).toBeTruthy()
    const evaluation = (await pendingB())!
    scheduling.pendingBeforeRouteRelease = evaluation
    const beforeRouteRelease = durableSnapshot(pair.harness.dataDir)
    expect(beforeRouteRelease.selectedCharacterId).toBe(CHARACTER_B)
    expect(beforeRouteRelease.ownership).toMatchObject({
      active_writer_session_id: pair.a.sessionId,
      writer_epoch: 3,
    })

    characterA.release()
    const afterRouteRelease = durableSnapshot(pair.harness.dataDir)
    expect(afterRouteRelease.selectedCharacterId).toBe(CHARACTER_B)
    expect(
      afterRouteRelease.events.filter(
        (event) =>
          event.revision > beforeRouteRelease.revision &&
          event.type === 'character.selected' &&
          event.id === CHARACTER_A,
      ),
    ).toEqual([])
    const beforeChatRelease = await pair.a.page.evaluate(() => {
      const smoke = window.__RISU_FASTIFY_BROWSER_SMOKE__!
      return {
        route: smoke.getCurrentRoute(),
        capabilities: smoke.getStartupCoordinatorSnapshot().capabilities,
        generationReadiness: smoke.getGenerationReadinessDiagnostic(),
        evaluations: smoke.getStartupChatReadinessEvaluations(),
      }
    })
    expect(beforeChatRelease.route).toMatchObject({ path: ROUTE_B, chaId: CHARACTER_B, chatId: CHAT_B })
    expect(beforeChatRelease.capabilities).toMatchObject({ canMutate: true, canGenerate: false })
    expect(beforeChatRelease.evaluations).toContainEqual(evaluation)
    expect(chatB.responses.every((response) => !response.delivered)).toBe(true)
    scheduling.retainedRouteWasNotPersisted = {
      beforeRevision: beforeRouteRelease.revision,
      afterRevision: afterRouteRelease.revision,
      selectedCharacterId: afterRouteRelease.selectedCharacterId,
    }
    scheduling.beforeChatRelease = beforeChatRelease

    chatB.release()
    await promotion
    await expect
      .poll(
        () =>
          [...characterA.responses, ...chatB.responses].every(
            (response) => response.status === 200 && response.delivered && !response.deliveryFailed,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    scheduling.nativeResponsesDelivered = true
  } finally {
    characterA.release()
    chatB.release()
    await Promise.all([characterA.dispose(), chatB.dispose()])
    await promotion?.catch(() => undefined)
  }
}

async function writerHeaders(client: Client): Promise<Record<string, string>> {
  return client.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders())
}

async function command(
  client: Client,
  headers: Record<string, string>,
  route: string,
  method: 'POST' | 'PUT',
  body: Record<string, unknown>,
  ownership: Ownership,
  revision: number,
) {
  return client.page.evaluate(
    async ({ headers, route, method, body, lineage, revision }) => {
      const response = await fetch(route, {
        method,
        headers: { ...headers, 'content-type': 'application/json', 'risu-database-lineage': lineage },
        body: JSON.stringify({ ...body, baseRevision: revision }),
      })
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    },
    { headers, route, method, body, lineage: ownership.lineage, revision },
  )
}

async function acceptedCommand(
  pair: Pair,
  client: Client,
  headers: Record<string, string>,
  route: string,
  method: 'POST' | 'PUT',
  body: Record<string, unknown>,
): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = durableSnapshot(pair.harness.dataDir)
    const result = await command(client, headers, route, method, body, before.ownership, before.revision)
    if (result.status === 409 && result.body.error === 'revision_conflict' && attempt < 2) continue
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    expect(result.body.revision).toEqual(expect.any(Number))
    return result.body.revision as number
  }
  throw new Error('Current writer command did not settle')
}

async function expectStaleMessageRejected(
  pair: Pair,
  client: Client,
  headers: Record<string, string>,
  messageId: string,
): Promise<void> {
  const before = durableSnapshot(pair.harness.dataDir)
  const result = await command(
    client,
    headers,
    `/api/v1/commands/chats/${CHAT_A}/messages`,
    'POST',
    { message: { role: 'char', data: 'A stale writer must not commit this row.', chatId: messageId } },
    before.ownership,
    before.revision,
  )
  expect(result).toMatchObject({ status: 423, body: { error: 'active_writer_stale' } })
  const after = durableSnapshot(pair.harness.dataDir)
  expect(after.ownership).toEqual(before.ownership)
  expect(after.messages.some((message) => message.uid === messageId)).toBe(false)
}

async function commitVisibleMessage(
  pair: Pair,
  client: Client,
  reader: Client,
  headers: Record<string, string>,
  chatId: string,
  messageId: string,
  text: string,
): Promise<number> {
  const revision = await acceptedCommand(pair, client, headers, `/api/v1/commands/chats/${chatId}/messages`, 'POST', {
    message: { role: 'char', data: text, chatId: messageId },
  })
  const durable = durableSnapshot(pair.harness.dataDir)
  expect(durable.messages.filter((message) => message.uid === messageId)).toMatchObject([
    { chat_id: chatId, role: 'char', data: text },
  ])
  expect(durable.events.find((event) => event.revision === revision)).toMatchObject({
    origin_writer_session_id: client.sessionId,
  })
  await expect(messageBody(reader.page, messageId)).toContainText(text, { timeout: 30_000 })
  await expect
    .poll(() =>
      reader.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getAppliedServerResourceRevision() ?? -1),
    )
    .toBeGreaterThanOrEqual(revision)
  return revision
}

async function composerDrafts(client: Client) {
  return client.page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith('risu:recovery-draft:composer:v1:'))
      .flatMap((key) => {
        try {
          const record = JSON.parse(sessionStorage.getItem(key) ?? 'null')
          return record
            ? [
                {
                  databaseLineage: record.databaseLineage,
                  writerSessionId: record.writerSessionId,
                  transcriptIdentity: record.owner?.transcriptIdentity,
                  messageInput: record.payload?.messageInput,
                },
              ]
            : []
        } catch {
          return []
        }
      }),
  )
}

async function finishPair(
  pair: Pair,
  testInfo: TestInfo,
  evidence: Record<string, unknown>,
  release?: () => void,
): Promise<void> {
  try {
    evidence.terminalDurable = durableSnapshot(pair.harness.dataDir)
    evidence.terminalClients = await Promise.all(
      [pair.a, pair.b].map(async (client) => ({
        client: client.name,
        snapshot: await client.page
          .evaluate(() => {
            const smoke = window.__RISU_FASTIFY_BROWSER_SMOKE__
            if (!smoke) return null
            return {
              coordinator: smoke.getStartupCoordinatorSnapshot(),
              generationReadiness: smoke.getGenerationReadinessDiagnostic(),
              chatReadinessEvaluations: smoke.getStartupChatReadinessEvaluations(),
              session: smoke.getClientSessionSnapshot(),
              route: smoke.getCurrentRoute(),
              routeResources: smoke.getRouteResourceLoadState(),
              appliedRevision: smoke.getAppliedServerResourceRevision(),
            }
          })
          .catch(() => null),
      })),
    )
    const output = testInfo.outputPath('connected-writer-switching.json')
    writeFileSync(
      output,
      JSON.stringify(
        {
          ...evidence,
          apiRequests: pair.apiRequests,
          documentRequests: pair.documentRequests,
          scriptResponses: pair.scriptResponses,
          consoleDiagnostics: pair.consoleDiagnostics,
          pageErrors: pair.pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('connected-writer-switching', { path: output, contentType: 'application/json' })
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const client of [pair.a, pair.b]) {
        await client.page
          .screenshot({ path: testInfo.outputPath(`writer-switch-${client.name}.png`) })
          .catch(() => undefined)
      }
    }
  } finally {
    release?.()
    await pair.a.context.close().catch(() => undefined)
    await pair.b.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(pair.harness)
  }
}

test('Use this device switches A to B to A in place while preserving reader routes and the originating draft', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000)
  const pair = await createPair(browser)
  const evidence: Record<string, unknown> = {}
  try {
    const initial = await bootPair(pair)
    evidence.initialOwnership = initial
    const headersA = await writerHeaders(pair.a)
    await pair.a.page.getByTestId('default-chat-composer').fill(UNSENT_A)
    await expect(pair.a.page.getByTestId('default-chat-composer')).toHaveValue(UNSENT_A)

    await pair.b.page.locator('[data-reader-go-back]').click()
    await pair.b.page.getByRole('button', { name: 'Open Switch Character B', exact: true }).click()
    await pair.b.page.getByRole('button', { name: 'Open chat Switch Chat B', exact: true }).click()
    await expectReader(pair.b, ROUTE_B, CHAT_B)
    await expect(messageBody(pair.b.page, 'switch-seed-B')).toContainText('Committed switch seed B.')
    const beforeReaderPromotion = durableSnapshot(pair.harness.dataDir)
    expect(beforeReaderPromotion.selectedCharacterId).toBe(CHARACTER_A)

    const [writerDemotionSampler, readerPromotionSampler, writerDemotionShifts, readerPromotionShifts] =
      await Promise.all([
        startLayoutFrameSampler(pair.a.page, SHELL_LAYOUT_SELECTORS, 'writer-demotion'),
        startLayoutFrameSampler(pair.b.page, SHELL_LAYOUT_SELECTORS, 'reader-promotion'),
        startLayoutShiftSampler(pair.a.page, SHELL_LAYOUT_SELECTORS, 'writer-demotion'),
        startLayoutShiftSampler(pair.b.page, SHELL_LAYOUT_SELECTORS, 'reader-promotion'),
      ])
    await promoteViaUi(pair, pair.b, pair.a, ROUTE_A, 2)
    await expectReader(pair.a, ROUTE_A, CHAT_A)
    const [writerDemotionFrames, readerPromotionFrames] = await Promise.all([
      stopLayoutFrameSampler(pair.a.page, writerDemotionSampler),
      stopLayoutFrameSampler(pair.b.page, readerPromotionSampler),
    ])
    const [writerDemotionLayoutShifts, readerPromotionLayoutShifts] = await Promise.all([
      stopLayoutShiftSampler(pair.a.page, writerDemotionShifts),
      stopLayoutShiftSampler(pair.b.page, readerPromotionShifts),
    ])
    const transitionFrames = {
      writerDemotion: analyzeHorizontalLayoutFrames(writerDemotionFrames),
      readerPromotion: analyzeHorizontalLayoutFrames(readerPromotionFrames),
    }
    evidence.transitionFrames = transitionFrames
    for (const [transition, report] of Object.entries(transitionFrames)) {
      expect(report.missing, `${transition}: ${formatLayoutFrameFailure(report)}`).toEqual([])
      expect(report.maximumDelta, `${transition}: ${formatLayoutFrameFailure(report)}`).toBeLessThanOrEqual(1)
    }
    const transitionLayoutShifts = {
      writerDemotion: writerDemotionLayoutShifts,
      readerPromotion: readerPromotionLayoutShifts,
    }
    evidence.transitionLayoutShifts = transitionLayoutShifts
    for (const [transition, shifts] of Object.entries(transitionLayoutShifts)) {
      expect(
        findOwnedLayoutShifts(shifts).filter((shift) => !shift.hadRecentInput),
        `${transition}: ${JSON.stringify(shifts, null, 2)}`,
      ).toEqual([])
    }
    const afterReaderPromotion = durableSnapshot(pair.harness.dataDir)
    expect(afterReaderPromotion.selectedCharacterId).toBe(CHARACTER_A)
    expect(
      afterReaderPromotion.events.filter(
        (event) =>
          event.revision > beforeReaderPromotion.revision &&
          event.type === 'character.selected' &&
          event.id === CHARACTER_B,
      ),
    ).toEqual([])
    evidence.readerRouteWasNotPersisted = {
      beforeRevision: beforeReaderPromotion.revision,
      afterRevision: afterReaderPromotion.revision,
      selectedCharacterId: afterReaderPromotion.selectedCharacterId,
    }

    await pair.b.page.getByRole('button', { name: 'Switch Character B', exact: true }).click()
    await pair.b.page.getByRole('button', { name: 'Open most recent chat Switch Chat B', exact: true }).click()
    await expect(pair.b.page).toHaveURL(new RegExp(`${ROUTE_B}$`))
    await expect
      .poll(() => durableSnapshot(pair.harness.dataDir).selectedCharacterId, { timeout: 30_000 })
      .toBe(CHARACTER_B)
    const writerSelection = durableSnapshot(pair.harness.dataDir).events.find(
      (event) =>
        event.revision > afterReaderPromotion.revision &&
        event.type === 'character.selected' &&
        event.id === CHARACTER_B,
    )
    expect(writerSelection).toMatchObject({ origin_writer_session_id: pair.b.sessionId })
    evidence.writerSelection = writerSelection
    await expect(pair.b.page.getByTestId('default-chat-composer')).toHaveValue('')
    await expect
      .poll(async () =>
        (await composerDrafts(pair.a)).some(
          (draft) =>
            draft.writerSessionId === pair.a.sessionId &&
            draft.databaseLineage === initial.lineage &&
            draft.messageInput === UNSENT_A,
        ),
      )
      .toBe(true)
    expect((await composerDrafts(pair.b)).some((draft) => draft.messageInput === UNSENT_A)).toBe(false)
    evidence.dormantDraftsA = await composerDrafts(pair.a)
    await pair.a.page.getByRole('button', { name: /^Local edits \(/u }).click()
    const localEdits = pair.a.page.getByRole('dialog', { name: 'Saved local edits', exact: true })
    const composerCopy = localEdits.locator('details[data-writer-draft-key^="composer:"]')
    await composerCopy.locator('summary').click()
    await expect(composerCopy.locator('textarea').first()).toHaveValue(UNSENT_A)
    await expect(composerCopy.locator('textarea').first()).toBeVisible()
    await expect(pair.b.page.locator('[data-writer-draft-recovery]')).toHaveCount(0)
    await localEdits.getByRole('button', { name: 'Close', exact: true }).click()
    await expectStaleMessageRejected(pair, pair.a, headersA, 'switch-stale-a-message')
    const headersB = await writerHeaders(pair.b)
    evidence.writerBRevision = await commitVisibleMessage(
      pair,
      pair.b,
      pair.a,
      headersB,
      CHAT_A,
      'switch-accepted-b-message',
      'Writer B committed this while A remained a connected reader.',
    )
    expect(durableSnapshot(pair.harness.dataDir).selectedCharacterId).toBe(CHARACTER_B)

    await promoteWithPendingStartupChat(pair, evidence)
    await expectReader(pair.b, ROUTE_B, CHAT_B)
    const beforeWriterASelection = durableSnapshot(pair.harness.dataDir)
    expect(beforeWriterASelection.selectedCharacterId).toBe(CHARACTER_B)
    await pair.a.page.getByRole('button', { name: 'Switch Character A', exact: true }).click()
    await pair.a.page.getByRole('button', { name: 'Open most recent chat Switch Chat A', exact: true }).click()
    await expect(pair.a.page).toHaveURL(new RegExp(`${ROUTE_A}$`))
    await expect
      .poll(() => durableSnapshot(pair.harness.dataDir).selectedCharacterId, { timeout: 30_000 })
      .toBe(CHARACTER_A)
    const writerASelection = durableSnapshot(pair.harness.dataDir).events.find(
      (event) =>
        event.revision > beforeWriterASelection.revision &&
        event.type === 'character.selected' &&
        event.id === CHARACTER_A,
    )
    expect(writerASelection).toMatchObject({ origin_writer_session_id: pair.a.sessionId })
    evidence.writerASelection = writerASelection
    await expect(pair.a.page.getByTestId('default-chat-composer')).toHaveValue(UNSENT_A)
    await expectStaleMessageRejected(pair, pair.b, headersB, 'switch-stale-b-message')
    evidence.writerARevision = await commitVisibleMessage(
      pair,
      pair.a,
      pair.b,
      headersA,
      CHAT_B,
      'switch-accepted-a-message',
      'Writer A committed this after returning to the same document.',
    )
    await expect(pair.a.page.getByTestId('default-chat-composer')).toHaveValue(UNSENT_A)
    expect((await composerDrafts(pair.b)).some((draft) => draft.messageInput === UNSENT_A)).toBe(false)
    const final = durableSnapshot(pair.harness.dataDir)
    expect(final.ownership).toEqual({ ...initial, active_writer_session_id: pair.a.sessionId, writer_epoch: 3 })
    expect(final.selectedCharacterId).toBe(CHARACTER_A)
    expect(final.messages.some((message) => message.data === UNSENT_A)).toBe(false)
    expect(final.messages).toHaveLength(4)
    await expectNoReload(pair)
    expect(pair.pageErrors).toEqual([])
    evidence.sessions = { a: pair.a.sessionId, b: pair.b.sessionId }
    evidence.timeOrigins = { a: pair.a.timeOrigin, b: pair.b.timeOrigin }
  } finally {
    await finishPair(pair, testInfo, evidence)
  }
})

class HeldGenerationProvider {
  calls = 0
  aborts = 0
  job: StreamJob | undefined
  private releaseHold!: () => void
  private readonly held = new Promise<void>((resolve) => {
    this.releaseHold = resolve
  })
  private readonly readyViewers = new Set<string>()
  private readonly viewerResolvers = new Map<string, () => void>()

  readonly lifecycle: NonNullable<GenerationChatRouteOptions['onDurableLifecycleTransition']> = (transition, job) => {
    if (transition === 'registered') this.job = job
    if (transition === 'viewer_write_started') {
      this.readyViewers.add(job.id)
      this.viewerResolvers.get(job.id)?.()
      this.viewerResolvers.delete(job.id)
    }
  }

  readonly dispatch: ChatProviderDispatcher = (context) => {
    this.calls += 1
    if (this.calls !== 1) throw new Error('The held switching provider must be dispatched exactly once')
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
    if (context.signal.aborted) onAbort()
    else context.signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (!this.readyViewers.has(context.generationId)) {
        await this.waitFor(
          new Promise<void>((resolve) => {
            this.viewerResolvers.set(context.generationId, resolve)
          }),
          context.signal,
        )
      }
      if (context.signal.aborted) return
      yield { kind: 'token' as const, content: GENERATION_PARTIAL }
      await this.waitFor(this.held, context.signal)
      if (context.signal.aborted) return
      yield { kind: 'token' as const, content: GENERATION_REPLY.slice(GENERATION_PARTIAL.length) }
      yield { kind: 'done' as const, finishReason: 'stop' }
    } finally {
      context.signal.removeEventListener('abort', onAbort)
      this.viewerResolvers.delete(context.generationId)
    }
  }
}

test('an accepted server generation keeps its job and durable reply when Use this device transfers the writer', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000)
  const provider = new HeldGenerationProvider()
  const pair = await createPair(browser, {
    dispatchProvider: provider.dispatch,
    onDurableLifecycleTransition: provider.lifecycle,
    viewerHeartbeatMs: 250,
  })
  const evidence: Record<string, unknown> = {}
  try {
    const initial = await bootPair(pair)
    const headersA = await writerHeaders(pair.a)
    await acceptedCommand(pair, pair.a, headersA, `/api/v1/commands/chats/${CHAT_A}/generation-settings`, 'PUT', {
      generationSettings: GENERATION_SETTINGS,
    })
    await expect
      .poll(() =>
        pair.a.page.evaluate(
          (chatId) =>
            window
              .__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
              .characters?.flatMap((character) => character.chats ?? [])
              .find((chat) => chat.id === chatId)?.generationSettings?.configured,
          CHAT_A,
        ),
      )
      .toBe(true)
    await pair.a.page.getByTestId('default-chat-composer').fill(GENERATION_REQUEST)
    await pair.a.page.getByTestId('default-chat-send-button').click()
    await expect(
      pair.a.page.locator('.default-chat-screen .chat-message-body').filter({ hasText: GENERATION_PARTIAL }),
    ).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(
        () => durableSnapshot(pair.harness.dataDir).operations.find((operation) => operation.chat_id === CHAT_A)?.state,
      )
      .toBe('owned_by_job')
    const running = durableSnapshot(pair.harness.dataDir)
    const operation = running.operations.find((candidate) => candidate.chat_id === CHAT_A)!
    expect(operation).toMatchObject({
      creator_writer_session_id: pair.a.sessionId,
      creator_writer_epoch: 1,
      current_attempt_no: 1,
      provider_may_have_run: 1,
      result_message_id: null,
    })
    expect(operation.accepted_message_id).toEqual(expect.any(String))
    expect(running.messages.filter((message) => message.uid === operation.accepted_message_id)).toMatchObject([
      { role: 'user', data: GENERATION_REQUEST },
    ])
    expect(running.attempts.filter((attempt) => attempt.operation_id === operation.operation_id)).toMatchObject([
      { attempt_no: 1, actor_writer_session_id: pair.a.sessionId, actor_writer_epoch: 1, status: 'running' },
    ])
    const jobId = running.attempts.find((attempt) => attempt.operation_id === operation.operation_id)!.job_id
    expect(provider.snapshot()).toMatchObject({
      calls: 1,
      aborts: 0,
      jobId,
      operationId: operation.operation_id,
      done: false,
      aborted: false,
    })
    await expect(messageBody(pair.b.page, operation.accepted_message_id!)).toContainText(GENERATION_REQUEST)
    evidence.runningBeforeTransfer = running

    await promoteViaUi(pair, pair.b, pair.a, ROUTE_A, 2)
    await expectReader(pair.a, ROUTE_A, CHAT_A)
    await expect(messageBody(pair.a.page, operation.accepted_message_id!)).toContainText(GENERATION_REQUEST)
    const transferred = durableSnapshot(pair.harness.dataDir)
    expect(transferred.operations.find((candidate) => candidate.operation_id === operation.operation_id)).toMatchObject(
      {
        state: 'owned_by_job',
        current_attempt_no: 1,
        creator_writer_session_id: pair.a.sessionId,
        creator_writer_epoch: 1,
        result_message_id: null,
      },
    )
    expect(transferred.attempts.filter((attempt) => attempt.operation_id === operation.operation_id)).toMatchObject([
      { job_id: jobId, attempt_no: 1, status: 'running' },
    ])
    expect(provider.snapshot()).toMatchObject({
      calls: 1,
      aborts: 0,
      jobId,
      operationId: operation.operation_id,
      done: false,
      aborted: false,
    })
    evidence.runningAfterTransfer = transferred
    provider.release()

    await expect
      .poll(
        () =>
          durableSnapshot(pair.harness.dataDir).operations.find(
            (candidate) => candidate.operation_id === operation.operation_id,
          )?.state,
        { timeout: 30_000 },
      )
      .toBe('completed')
    const terminal = durableSnapshot(pair.harness.dataDir)
    const completed = terminal.operations.find((candidate) => candidate.operation_id === operation.operation_id)!
    expect(terminal.operations.filter((candidate) => candidate.chat_id === CHAT_A)).toHaveLength(1)
    expect(completed).toMatchObject({
      accepted_message_id: operation.accepted_message_id,
      creator_writer_session_id: pair.a.sessionId,
      creator_writer_epoch: 1,
      current_attempt_no: null,
    })
    expect(completed.result_message_id).toEqual(expect.any(String))
    expect(terminal.attempts.filter((attempt) => attempt.operation_id === operation.operation_id)).toMatchObject([
      { job_id: jobId, attempt_no: 1, status: 'completed' },
    ])
    const messages = terminal.messages.filter((message) => message.chat_id === CHAT_A)
    expect(messages).toHaveLength(3)
    expect(messages.filter((message) => message.uid === operation.accepted_message_id)).toMatchObject([
      { role: 'user', data: GENERATION_REQUEST },
    ])
    expect(messages.filter((message) => message.uid === completed.result_message_id)).toMatchObject([
      { role: 'char', data: GENERATION_REPLY },
    ])
    for (const client of [pair.a, pair.b]) {
      await expect(messageBody(client.page, completed.result_message_id!)).toContainText(GENERATION_REPLY, {
        timeout: 30_000,
      })
      await expect
        .poll(() =>
          client.page.locator('.risu-chat[data-risu-message-id]').evaluateAll((rows) =>
            rows
              .map((row) => row.getAttribute('data-risu-message-id'))
              .filter((id): id is string => Boolean(id))
              .sort(),
          ),
        )
        .toEqual(messages.map((message) => message.uid).sort())
    }
    expect(provider.snapshot()).toMatchObject({
      calls: 1,
      aborts: 0,
      jobId,
      operationId: operation.operation_id,
      aborted: false,
    })
    expect(
      pair.apiRequests.filter(
        (request) => request.method === 'POST' && request.path === '/api/v1/generation-operations',
      ),
    ).toHaveLength(1)
    expect(
      pair.apiRequests.filter(
        (request) =>
          !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
          (/^\/api\/v1\/generation-operations\/[^/]+\/cancellation$/u.test(request.path) ||
            /^\/api\/v1\/generate\/chat\/[^/]+$/u.test(request.path)),
      ),
    ).toEqual([])
    expect(terminal.ownership).toEqual({ ...initial, active_writer_session_id: pair.b.sessionId, writer_epoch: 2 })
    await expectNoReload(pair)
    expect(pair.pageErrors).toEqual([])
    evidence.provider = provider.snapshot()
    evidence.sessions = { a: pair.a.sessionId, b: pair.b.sessionId }
    evidence.timeOrigins = { a: pair.a.timeOrigin, b: pair.b.timeOrigin }
  } finally {
    evidence.provider = provider.snapshot()
    await finishPair(pair, testInfo, evidence, () => provider.release())
  }
})

function initializationSnapshot(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    const settingsRow = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as
      | { data_json: string }
      | undefined
    const settings: unknown = settingsRow ? JSON.parse(settingsRow.data_json) : null
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('database_metadata', 'generation_operation_projection_state', 'schema_version') ORDER BY name",
      )
      .all() as Array<{ name: string }>
    const domainRowCounts = Object.fromEntries(
      tables.map(({ name }) => [
        name,
        (db.prepare(`SELECT COUNT(*) AS rows FROM "${name.replaceAll('"', '""')}"`).get() as { rows: number }).rows,
      ]),
    )
    return {
      ownership: db
        .prepare('SELECT lineage, active_writer_session_id, writer_epoch FROM database_metadata WHERE id = 1')
        .get() as unknown as Ownership,
      revision: getSchemaState(db).revision,
      generationProjectionEpoch: (
        db.prepare('SELECT epoch FROM generation_operation_projection_state WHERE id = 1').get() as { epoch: number }
      ).epoch,
      settingsIsObject: settings !== null && typeof settings === 'object' && !Array.isArray(settings),
      domainRowCounts,
      initializationEvents: db
        .prepare(
          "SELECT revision, type, origin_writer_session_id FROM command_events WHERE type = 'state.initialized' ORDER BY revision",
        )
        .all() as Array<{ revision: number; type: string; origin_writer_session_id: string | null }>,
    }
  } finally {
    db.close()
  }
}

test('an empty server without Web Locks initializes only after the explicit setup action with a fresh writer identity', async ({
  browser,
}, testInfo) => {
  test.setTimeout(90_000)
  const previousSessionId = '9c5b118c-9bf6-4c0d-9dbe-55f109608037'
  const previousSessionKey = 'risu:connected-reader-previous-session-id'
  const harness = await startFastBootstrapHarness(
    {},
    {
      temporaryDirectoryPrefix: 'risu-connected-empty-setup-',
      databaseSeedMode: 'empty',
    },
  )
  let context: BrowserContext | undefined
  let page: Page | undefined
  const apiRequests: ApiRecord[] = []
  const documentRequests: string[] = []
  const scriptResponses: { url: string; path: string; status: number }[] = []
  const consoleDiagnostics: { type: string; text: string }[] = []
  const pageErrors: string[] = []
  const evidence: Record<string, unknown> = { previousSessionId }
  try {
    const initial = initializationSnapshot(harness.dataDir)
    evidence.initial = initial
    expect(initial.ownership).toMatchObject({ active_writer_session_id: null, writer_epoch: 0 })
    expect(initial).toMatchObject({
      revision: 0,
      generationProjectionEpoch: 0,
      settingsIsObject: false,
      initializationEvents: [],
    })
    expect(Object.values(initial.domainRowCounts).every((rows) => rows === 0)).toBe(true)
    context = await browser.newContext({ locale: 'en-US' })
    await context.addInitScript(
      ({ sessionKey, previousSessionId }) => {
        Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
        try {
          sessionStorage.setItem(sessionKey, previousSessionId)
        } catch {}
      },
      { sessionKey: SESSION_KEY, previousSessionId },
    )
    page = await context.newPage()
    const requests = new Map<Request, ApiRecord>()
    context.on('request', (request) => {
      const url = new URL(request.url())
      if (request.resourceType() === 'document') documentRequests.push(url.pathname)
      if (!url.pathname.startsWith('/api/')) return
      const headers = request.headers()
      const record: ApiRecord = {
        client: 'A',
        method: request.method(),
        path: url.pathname,
        query: url.search,
        writerSession: headers['risu-writer-session'] ?? null,
        observerSession: headers['risu-writer-observer-session'] ?? null,
        disconnectExistingWriter: headers['risu-disconnect-existing-writer'] ?? null,
        expectedWriterEpoch: headers['risu-expected-writer-epoch'] ?? null,
        expectedLineage: headers['risu-expected-database-lineage'] ?? null,
      }
      requests.set(request, record)
      apiRequests.push(record)
    })
    context.on('response', (response) => {
      const request = response.request()
      const record = requests.get(request)
      if (record) record.status = response.status()
      if (request.resourceType() === 'script' && response.ok()) {
        scriptResponses.push({ url: response.url(), path: new URL(response.url()).pathname, status: response.status() })
      }
    })
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        consoleDiagnostics.push({ type: message.type(), text: message.text() })
      }
    })
    const client: Client = { name: 'A', context, page, sessionId: '', timeOrigin: 0 }
    await page.goto(harness.baseUrl)
    const setup = page.getByRole('button', { name: 'Set up on this device', exact: true })
    await expect(setup).toBeVisible({ timeout: 30_000 })
    await waitForSmokeHook(client)
    expect(await page.evaluate(() => navigator.locks)).toBeUndefined()
    expect(client.sessionId).not.toBe(previousSessionId)
    expect(await page.evaluate((key) => sessionStorage.getItem(key), previousSessionKey)).toBe(previousSessionId)
    const readBootstraps = apiRequests.filter((request) => request.path === '/api/v1/bootstrap')
    expect(readBootstraps.length).toBeGreaterThan(0)
    expect(
      readBootstraps.every((request) => request.writerSession === null && request.observerSession === client.sessionId),
    ).toBe(true)
    expect(apiRequests.filter((request) => request.path.startsWith('/api/v1/commands/'))).toEqual([])
    expect(initializationSnapshot(harness.dataDir)).toEqual(initial)
    expect(
      await page.evaluate(
        () => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities.canMutate,
      ),
    ).toBe(false)
    evidence.beforeSetup = initializationSnapshot(harness.dataDir)
    evidence.freshSessionId = client.sessionId
    evidence.setupClickAttempted = true
    await setup.click()
    evidence.setupClicked = true

    await expect.poll(() => initializationSnapshot(harness.dataDir).settingsIsObject, { timeout: 30_000 }).toBe(true)
    await page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await expect
      .poll(() =>
        page!.evaluate(
          () => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getStartupCoordinatorSnapshot().capabilities.canMutate,
        ),
      )
      .toBe(true)
    await expect
      .poll(() =>
        apiRequests.some(
          (request) =>
            request.path === '/api/v1/events' && request.writerSession === client.sessionId && request.status === 200,
        ),
      )
      .toBe(true)
    const initialized = initializationSnapshot(harness.dataDir)
    expect(initialized).toMatchObject({ revision: 1, settingsIsObject: true, domainRowCounts: { settings: 1 } })
    expect(initialized.ownership).toEqual({
      ...initial.ownership,
      active_writer_session_id: client.sessionId,
      writer_epoch: 1,
    })
    expect(initialized.initializationEvents).toMatchObject([{ revision: 1, type: 'state.initialized' }])
    const initializeRequests = apiRequests.filter((request) => request.path === '/api/v1/commands/state/initialize')
    expect(initializeRequests).toHaveLength(1)
    expect(initializeRequests[0]).toMatchObject({ method: 'POST', writerSession: client.sessionId, status: 200 })
    const writerBootstraps = apiRequests.filter(
      (request) => request.path === '/api/v1/bootstrap' && request.writerSession !== null,
    )
    expect(writerBootstraps).toHaveLength(1)
    expect(writerBootstraps[0]).toMatchObject({
      writerSession: client.sessionId,
      expectedWriterEpoch: '0',
      expectedLineage: initial.ownership.lineage,
      status: 200,
    })

    // This deny-only control observes the server's live writer-stream tracking.
    const connectedControl = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: {
        'risu-auth': harness.assertion,
        'risu-writer-session': 'empty-setup-connected-writer-probe',
        'risu-expected-writer-epoch': '1',
        'risu-expected-database-lineage': initial.ownership.lineage,
      },
    })
    evidence.connectedControl = { status: connectedControl.statusCode, body: connectedControl.json() }
    expect(connectedControl.statusCode).toBe(409)
    expect(connectedControl.json()).toMatchObject({ error: 'active_writer_connected' })
    expect(initializationSnapshot(harness.dataDir)).toEqual(initialized)
    expect(await page.evaluate((key) => sessionStorage.getItem(key), previousSessionKey)).toBe(previousSessionId)
    expect(await page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)).toBe(client.sessionId)
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(client.timeOrigin)
    expect(documentRequests).toHaveLength(1)
    expect(pageErrors).toEqual([])
  } finally {
    try {
      evidence.terminalInitialization = initializationSnapshot(harness.dataDir)
      const output = testInfo.outputPath('connected-writer-switching.json')
      writeFileSync(
        output,
        JSON.stringify(
          { ...evidence, apiRequests, documentRequests, scriptResponses, consoleDiagnostics, pageErrors },
          null,
          2,
        ),
      )
      await testInfo.attach('connected-writer-switching', { path: output, contentType: 'application/json' })
      if (testInfo.status !== testInfo.expectedStatus)
        await page?.screenshot({ path: testInfo.outputPath('empty-server-setup.png') }).catch(() => undefined)
    } finally {
      await context?.close().catch(() => undefined)
      await closeFastBootstrapHarness(harness)
    }
  }
})
