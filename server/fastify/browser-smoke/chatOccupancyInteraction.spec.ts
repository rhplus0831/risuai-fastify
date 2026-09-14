import {
  devices,
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from '@playwright/test'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ChatProviderDispatchContext, ChatProviderDispatcher } from '../src/routes/generationChat.js'
import {
  closeFastBootstrapHarness,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
  type FastBootstrapHarness,
} from './fastBootstrapHarness.js'

const CHARACTER = 'occupancy-interaction-character'
const CHAT_OWNER = 'occupancy-owner-chat'
const CHAT_READER = 'occupancy-reader-chat'
const CHAT_READER_TWO = 'occupancy-reader-two-chat'
const CHAT_STOP = 'occupancy-stop-chat'
const CHAT_OBSERVER = 'occupancy-observer-chat'
const CHAT_CONFLICT = 'occupancy-conflict-chat'
const ALL_CHATS = [CHAT_OWNER, CHAT_READER, CHAT_READER_TWO, CHAT_STOP, CHAT_OBSERVER, CHAT_CONFLICT] as const
const SESSION_KEY = 'risu:active-writer-session-id'
const STATIC_LAST_INTERACTION = 1_234
const GENERATION_SETTINGS = {
  configured: true,
  personaId: 'occupancy-persona',
  modelPresetId: 'occupancy-model',
  promptPresetId: 'occupancy-prompt',
  jailbreakToggle: false,
  sidebarToggles: {},
}

interface ProviderPlan {
  chunks: string[]
  holdAfterChunk?: number
}

class OccupancyProvider {
  private readonly plans = new Map<string, ProviderPlan[]>()
  private readonly callsByChat = new Map<string, number>()
  private readonly abortsByChat = new Map<string, number>()
  private readonly releaseResolvers = new Map<string, () => void>()
  private readonly released = new Set<string>()

  configure(chatId: string, ...plans: ProviderPlan[]): void {
    this.plans.set(chatId, plans)
  }

  calls(chatId: string): number {
    return this.callsByChat.get(chatId) ?? 0
  }

  aborts(chatId: string): number {
    return this.abortsByChat.get(chatId) ?? 0
  }

  release(chatId: string, callNo = 1): void {
    const key = `${chatId}:${callNo}`
    const release = this.releaseResolvers.get(key)
    if (release) release()
    else this.released.add(key)
  }

  releaseAll(): void {
    for (const release of this.releaseResolvers.values()) release()
  }

  readonly dispatch: ChatProviderDispatcher = (context) => {
    const chatId = context.input.chatId
    const callNo = this.calls(chatId) + 1
    this.callsByChat.set(chatId, callNo)
    const plan = this.plans.get(chatId)?.[callNo - 1]
    if (!plan) throw new Error(`No occupancy browser plan for ${chatId} call ${callNo}`)
    return this.frames(context, plan, callNo)
  }

  private async *frames(context: ChatProviderDispatchContext, plan: ProviderPlan, callNo: number) {
    const onAbort = () => this.abortsByChat.set(context.input.chatId, this.aborts(context.input.chatId) + 1)
    if (context.signal.aborted) onAbort()
    else context.signal.addEventListener('abort', onAbort, { once: true })
    try {
      for (let index = 0; index < plan.chunks.length; index += 1) {
        if (context.signal.aborted) return
        yield { kind: 'token' as const, content: plan.chunks[index] }
        if (plan.holdAfterChunk === index + 1) await this.waitForRelease(context, callNo)
      }
      if (!context.signal.aborted) yield { kind: 'done' as const, finishReason: 'stop' }
    } finally {
      context.signal.removeEventListener('abort', onAbort)
    }
  }

  private waitForRelease(context: ChatProviderDispatchContext, callNo: number): Promise<void> {
    if (context.signal.aborted) return Promise.resolve()
    const key = `${context.input.chatId}:${callNo}`
    if (this.released.delete(key)) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => {
        context.signal.removeEventListener('abort', finish)
        this.releaseResolvers.delete(key)
        resolve()
      }
      this.releaseResolvers.set(key, finish)
      context.signal.addEventListener('abort', finish, { once: true })
    })
  }
}

interface ApiRecord {
  client: string
  request: Request
  method: string
  path: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
  status?: number
}

interface Client {
  name: string
  context: BrowserContext
  page: Page
  records: ApiRecord[]
  sessionId: string
}

interface OperationRow {
  operation_id: string
  chat_id: string
  mode: string
  creator_writer_session_id: string
  admission_kind: string | null
  occupancy_session_id: string | null
  occupancy_epoch: number | null
  occupancy_claim_class: string | null
  state: string
  accepted_message_id: string | null
  result_message_id: string | null
}

interface MessageRow {
  chat_id: string
  seq: number
  uid: string
  role: string
  data: string
  json: string
  alternate: number
}

function route(chatId: string): string {
  return `/character/${CHARACTER}/${chatId}`
}

function fixture(): Record<string, unknown> {
  const base = smallFastBootstrapFixture()
  const baseCharacter = (base.characters as Array<Record<string, unknown>>)[0]!
  const chatName = (chatId: (typeof ALL_CHATS)[number]) =>
    ({
      [CHAT_OWNER]: 'Owner Chat',
      [CHAT_READER]: 'Reader Chat',
      [CHAT_READER_TWO]: 'Reader Two Chat',
      [CHAT_STOP]: 'Stop Chat',
      [CHAT_OBSERVER]: 'Observer Chat',
      [CHAT_CONFLICT]: 'Conflict Chat',
    })[chatId]
  return {
    ...base,
    currentChar: 0,
    selectedCharID: 0,
    characterOrder: [CHARACTER],
    characters: [
      {
        ...baseCharacter,
        chaId: CHARACTER,
        name: 'Occupancy Interaction Character',
        lastInteraction: STATIC_LAST_INTERACTION,
        chatPage: 0,
        alternateGreetings: [],
        chats: ALL_CHATS.map((chatId) => ({
          id: chatId,
          name: chatName(chatId),
          fmIndex: -1,
          note: '',
          localLore: [],
          message: [{ chatId: `seed-${chatId}`, role: 'char', data: `Seed for ${chatId}.` }],
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
    modelPresets: [{ id: 'occupancy-model', name: 'Occupancy Model' }],
    promptPresets: [{ id: 'occupancy-prompt', name: 'Occupancy Prompt', promptTemplate: [] }],
    personas: [
      {
        id: 'occupancy-persona',
        name: 'Occupancy User',
        icon: '',
        largePortrait: false,
        personaPrompt: '',
      },
    ],
    modules: [
      {
        id: 'occupancy-module',
        name: 'Static Module',
        description: 'Unchanged shared-state sentinel.',
        namespace: 'occupancy-static-module',
      },
    ],
    plugins: [
      {
        id: 'occupancy-plugin',
        name: 'Static Plugin',
        script: '',
        arguments: {},
        realArg: {},
        version: '3.0',
        customLink: [],
        argMeta: {},
        enabled: false,
      },
    ],
    pluginCustomStorage: { occupancyPluginKey: { fixed: true } },
    username: 'Occupancy User',
    selectedPersona: 0,
    loreBookToken: 8_000,
    mainPrompt: 'MAIN',
    maxContext: 100_000,
    maxResponse: 100,
    aiModel: 'echo_model',
    subModel: 'echo_model',
    modelRoles: { emotion: 'echo_model' },
    useStreaming: true,
    removeIncompleteResponse: false,
    requestRetrys: 0,
    echoMessage: 'unused',
    echoDelay: 0,
    igpPrompt: '',
    notification: false,
    ttsAuto: false,
    playMessage: false,
  }
}

function readTruth(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    return {
      ownership: db
        .prepare('SELECT lineage, active_writer_session_id, writer_epoch FROM database_metadata WHERE id = 1')
        .get() as { lineage: string; active_writer_session_id: string | null; writer_epoch: number },
      occupancy: db
        .prepare(
          'SELECT chat_id, occupant_session_id, occupancy_epoch, claim_class, lease_expires_at_ms, released_at_ms FROM chat_occupancies ORDER BY chat_id',
        )
        .all(),
      operations: db
        .prepare(
          'SELECT operation_id, chat_id, mode, creator_writer_session_id, admission_kind, occupancy_session_id, occupancy_epoch, occupancy_claim_class, state, accepted_message_id, result_message_id FROM generation_operations ORDER BY created_at',
        )
        .all() as unknown as OperationRow[],
      messages: db
        .prepare('SELECT chat_id, seq, uid, role, data, json, alternate FROM messages ORDER BY chat_id, seq')
        .all() as unknown as MessageRow[],
      effects: db
        .prepare(
          'SELECT operation_id, chat_id, message_id, effect_kind, effect_class, status, reason FROM generation_effects ORDER BY operation_id, effect_kind',
        )
        .all(),
    }
  } finally {
    db.close()
  }
}

function readSharedMutationBoundary(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    const readRows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    return {
      settings: readRows('settings'),
      characters: readRows('characters'),
      modules: readRows('modules'),
      plugins: readRows('plugins'),
      pluginStorage: readRows('plugin_custom_storage'),
    }
  } finally {
    db.close()
  }
}

async function startHarness(provider: OccupancyProvider, prefix: string): Promise<FastBootstrapHarness> {
  return startFastBootstrapHarness(fixture(), {
    temporaryDirectoryPrefix: prefix,
    databaseSeedMode: 'unowned-migration',
    chatOccupancy: { enabled: true },
    generationChat: {
      dispatchProvider: provider.dispatch,
      pushNotifications: false,
      finalizationRetry: { intervalMs: 100, baseDelayMs: 100, maxDelayMs: 200 },
    },
  })
}

async function createClient(
  browser: Browser,
  name: string,
  options: Parameters<Browser['newContext']>[0] = {},
): Promise<Client> {
  const context = await browser.newContext(options)
  context.setDefaultTimeout(12_000)
  const records: ApiRecord[] = []
  const byRequest = new Map<Request, ApiRecord>()
  context.on('request', (request) => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return
    let body: Record<string, unknown> | null = null
    const rawBody = request.postData()
    if (rawBody) {
      try {
        const parsed: unknown = JSON.parse(rawBody)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
      } catch {}
    }
    const record = {
      client: name,
      request,
      method: request.method(),
      path: url.pathname,
      headers: request.headers(),
      body,
    }
    records.push(record)
    byRequest.set(request, record)
  })
  context.on('response', (response) => {
    const record = byRequest.get(response.request())
    if (record) record.status = response.status()
  })
  const page = await context.newPage()
  return { name, context, page, records, sessionId: '' }
}

async function waitForHook(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__)), { timeout: 30_000 })
    .toBe(true)
}

async function bootOwner(client: Client, harness: FastBootstrapHarness, chatId: string): Promise<void> {
  await client.page.goto(`${harness.baseUrl}${route(chatId)}`, { waitUntil: 'domcontentloaded' })
  await waitForHook(client.page)
  await client.page.evaluate(() =>
    window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
  )
  await expect(client.page.getByTestId('default-chat-composer')).toBeVisible({ timeout: 30_000 })
  client.sessionId = await client.page.evaluate((key) => sessionStorage.getItem(key) ?? '', SESSION_KEY)
  expect(client.sessionId).toMatch(/\S/u)
}

async function bootReader(client: Client, harness: FastBootstrapHarness, chatId: string): Promise<void> {
  await client.page.goto(`${harness.baseUrl}${route(chatId)}`, { waitUntil: 'domcontentloaded' })
  await waitForHook(client.page)
  await expect(client.page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', chatId, {
    timeout: 30_000,
  })
  await expect
    .poll(() => client.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot().lifecycle))
    .toBe('reading')
  client.sessionId = await client.page.evaluate((key) => sessionStorage.getItem(key) ?? '', SESSION_KEY)
  expect(client.sessionId).toMatch(/\S/u)
}

async function configureChats(page: Page): Promise<void> {
  for (const chatId of ALL_CHATS) {
    const result = await page.evaluate(
      async ({ chatId, settings }) => {
        const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const bootstrap = await fetch('/api/v1/bootstrap', { headers })
          const { revision } = (await bootstrap.json()) as { revision: number }
          const response = await fetch(`/api/v1/commands/chats/${encodeURIComponent(chatId)}/generation-settings`, {
            method: 'PUT',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ baseRevision: revision, generationSettings: settings }),
          })
          const body = (await response.json()) as { error?: string }
          if (response.status !== 409 || body.error !== 'revision_conflict') return { status: response.status, body }
        }
        return { status: 599, body: { error: 'revision_retry_exhausted' } }
      },
      { chatId, settings: GENERATION_SETTINGS },
    )
    expect(result.status, JSON.stringify(result.body)).toBe(200)
  }
}

async function directClaim(page: Page, chatId: string, claimClass: 'owner' | 'chat_only', epoch = 0) {
  return page.evaluate(
    async ({ chatId, claimClass, epoch }) => {
      const hook = window.__RISU_FASTIFY_BROWSER_SMOKE__!
      const session = hook.getClientSessionSnapshot()
      const headers = await hook.activeWriterHeaders()
      const response = await fetch(`/api/v1/chat-occupancies/${encodeURIComponent(chatId)}/claim`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'risu-database-lineage': session.databaseLineage!,
          'risu-chat-occupancy-epoch': String(epoch),
        },
        body: JSON.stringify({ version: 1, claimClass }),
      })
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    },
    { chatId, claimClass, epoch },
  )
}

async function appendOwnerMessage(page: Page, chatId: string, messageId: string, data: string): Promise<number> {
  const result = await page.evaluate(
    async ({ chatId, messageId, data }) => {
      const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const bootstrap = await fetch('/api/v1/bootstrap', { headers })
        const { revision } = (await bootstrap.json()) as { revision: number }
        const response = await fetch(`/api/v1/commands/chats/${encodeURIComponent(chatId)}/messages`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ baseRevision: revision, message: { chatId: messageId, role: 'char', data } }),
        })
        const body = (await response.json()) as { error?: string; currentRevision?: number; revision?: number }
        if (response.status !== 409 || body.error !== 'revision_conflict') {
          return { status: response.status, body }
        }
      }
      return { status: 599, body: { error: 'revision_retry_exhausted' } }
    },
    { chatId, messageId, data },
  )
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  expect(result.body.revision).toEqual(expect.any(Number))
  return result.body.revision!
}

async function rejectForeignMutationControls(client: Client, operation: OperationRow) {
  return client.page.evaluate(
    async ({ messageId, operationId, chatId }) => {
      const hook = window.__RISU_FASTIFY_BROWSER_SMOKE__!
      const headers = await hook.activeWriterHeaders()
      const session = hook.getClientSessionSnapshot()
      const bootstrap = await fetch('/api/v1/bootstrap', { headers })
      const { revision } = (await bootstrap.json()) as { revision: number }
      const edit = await fetch(`/api/v1/commands/messages/${encodeURIComponent(messageId)}`, {
        method: 'PATCH',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'risu-database-lineage': session.databaseLineage!,
        },
        body: JSON.stringify({
          baseRevision: revision,
          patch: { data: 'forbidden foreign edit' },
          expectedChatId: chatId,
        }),
      })
      const stop = await fetch(`/api/v1/generation-operations/${operationId}/cancellation`, {
        method: 'PUT',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'risu-database-lineage': session.databaseLineage!,
        },
        body: JSON.stringify({ reason: 'user_stop' }),
      })
      return {
        edit: { status: edit.status, body: await edit.json() },
        stop: { status: stop.status, body: await stop.json() },
      }
    },
    {
      messageId: operation.accepted_message_id!,
      operationId: operation.operation_id,
      chatId: operation.chat_id,
    },
  )
}

async function expectOccupancyState(page: Page, state: string): Promise<void> {
  await expect(page.locator('[data-reader-chat-occupancy]')).toHaveAttribute(
    'data-reader-chat-occupancy-state',
    state,
    {
      timeout: 30_000,
    },
  )
}

async function promoteViaUi(
  client: Client,
  previous: Client,
  dataDir: string,
  expectedWriterEpoch: number,
): Promise<void> {
  await expect(client.page.locator('[data-reader-use-this-device]')).toBeEnabled({ timeout: 30_000 })
  await client.page.locator('[data-reader-use-this-device]').click()
  const confirmation = client.page.getByRole('button', { name: 'Disconnect existing client', exact: true })
  await expect(confirmation).toBeVisible()
  await confirmation.click()
  await expect
    .poll(() => readTruth(dataDir).ownership, { timeout: 30_000 })
    .toMatchObject({ active_writer_session_id: client.sessionId, writer_epoch: expectedWriterEpoch })
  await expect
    .poll(() => client.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot().lifecycle))
    .toBe('writing')
  await expect
    .poll(() =>
      previous.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getClientSessionSnapshot().lifecycle),
    )
    .toBe('reading')
}

function stableOccupancyTuples(dataDir: string) {
  return readTruth(dataDir).occupancy.map((row) => {
    const value = row as Record<string, unknown>
    return {
      chatId: value.chat_id,
      sessionId: value.occupant_session_id,
      occupancyEpoch: value.occupancy_epoch,
      claimClass: value.claim_class,
      released: value.released_at_ms !== null,
    }
  })
}

async function claimFromUi(client: Client): Promise<void> {
  await expectOccupancyState(client.page, 'available')
  await client.page.locator('[data-reader-occupancy-claim]').click()
  await expectOccupancyState(client.page, 'self-owned')
  await expect(client.page.locator('[data-reader-composer-field="message"]')).toBeEnabled()
  await expect(client.page.locator('[data-reader-composer-send]')).toBeDisabled()
}

async function sendFromUi(client: Client, text: string, owner = false): Promise<void> {
  const composer = owner
    ? client.page.getByTestId('default-chat-composer')
    : client.page.locator('[data-reader-composer-field="message"]')
  const send = owner
    ? client.page.getByTestId('default-chat-send-button')
    : client.page.locator('[data-reader-composer-send]')
  await composer.fill(text)
  await send.click()
}

async function openReaderChat(page: Page, name: string, chatId: string): Promise<void> {
  const toggle = page.locator('[data-reader-navigation-toggle]')
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
  const back = page.locator('[data-reader-go-back]')
  if (await back.isVisible()) await back.click()
  await page.getByRole('button', { name: `Open chat ${name}`, exact: true }).click()
  await expect(page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', chatId)
  await expect(page).toHaveURL(new RegExp(`${route(chatId)}$`))
}

function chatMessages(truth: ReturnType<typeof readTruth>, chatId: string): MessageRow[] {
  return truth.messages.filter((message) => message.chat_id === chatId && message.alternate === 0)
}

function alternateChatMessages(truth: ReturnType<typeof readTruth>, chatId: string): MessageRow[] {
  return truth.messages.filter((message) => message.chat_id === chatId && message.alternate === 1)
}

async function expectCompleted(dataDir: string, chatId: string, count = 1): Promise<OperationRow[]> {
  await expect
    .poll(
      () =>
        readTruth(dataDir).operations.filter(
          (operation) => operation.chat_id === chatId && operation.state === 'completed',
        ).length,
      { timeout: 30_000 },
    )
    .toBe(count)
  return readTruth(dataDir).operations.filter((operation) => operation.chat_id === chatId)
}

async function expectSubmitAuthority(
  client: Client,
  chatId: string,
  interaction: 'send' | 'reroll',
): Promise<ApiRecord> {
  const findSubmit = () =>
    client.records.find(
      (record) =>
        record.method === 'POST' &&
        record.path === '/api/v1/generation-operations' &&
        record.body?.chatId === chatId &&
        (record.body?.chatOccupancy as { interaction?: unknown } | undefined)?.interaction === interaction &&
        [200, 201].includes(record.status ?? 0),
    )
  await expect.poll(() => Boolean(findSubmit())).toBe(true)
  const submit = findSubmit()
  expect(submit, `${client.name} ${interaction} submit for ${chatId}`).toBeDefined()
  expect(submit).toMatchObject({
    headers: {
      'risu-writer-session': client.sessionId,
      'risu-chat-occupancy-epoch': expect.stringMatching(/^\d+$/u),
    },
  })
  expect(submit!.body).toMatchObject({
    chatId,
    chatOccupancy: { version: 1, interaction },
    mode: interaction === 'reroll' ? 'regenerate' : 'send',
  })
  return submit!
}

function forbiddenChatOnlyRequests(client: Client): ApiRecord[] {
  return client.records.filter((record) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(record.method)) return false
    return (
      /^\/api\/v1\/commands\/(?:settings|characters|modules|plugins)(?:\/|$)/u.test(record.path) ||
      /^\/api\/v1\/commands\/(?:chats|messages)(?:\/|$)/u.test(record.path) ||
      /^\/api\/v1\/generation-effects(?:\/|$)/u.test(record.path) ||
      /^\/api\/v1\/(?:proxy\/plugin-fetch|assets)(?:\/|$)/u.test(record.path) ||
      record.path === '/api/v1/import/risusave'
    )
  })
}

test('T01/T03/T04/T08/T11: owner, two chat-only senders, and an observer remain independently scoped', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, { chunks: ['Owner partial', ' reply.'], holdAfterChunk: 1 })
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
    expect(forbiddenChatOnlyRequests(reader)).toEqual([])
    expect(forbiddenChatOnlyRequests(readerTwo)).toEqual([])
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
          truth: readTruth(harness.dataDir),
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

test('T02/T11: simultaneous same-chat claims have one winner and every foreign session fails closed', async ({
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
