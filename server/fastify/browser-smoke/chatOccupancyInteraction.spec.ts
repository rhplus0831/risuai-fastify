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
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildApp } from '../src/app.js'
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
const ACCEPTED_IGP_PROMPT =
  '<|im_start|>system<|im_sep|>Last={{lastmessage}}; Char={{lastcharmessage}}; Index={{lastmessageid}}<|im_end|>'
const ACCEPTED_IGP_SUFFIX = ' [accepted IGP snapshot]'
const ACCEPTED_IGP_INPUT_ROW = 'INPUT-LUA-ROW'
const ACCEPTED_IGP_MODEL = 'accepted-igp-model'
const ACCEPTED_IGP_CREDENTIAL = 'accepted-igp-key'
const ACCEPTED_TRANSLATION_MODEL = 'accepted-translation-model'
const ACCEPTED_TRANSLATION = 'Translated configured IGP source.'
const CLEARED_MODEL_ROLE_PROFILES = {
  chatMain: { mode: 'legacy' },
  chatAux: { mode: 'legacy' },
  memory: { mode: 'legacy' },
  translate: { mode: 'legacy' },
  emotion: { mode: 'legacy' },
  otherAx: { mode: 'legacy' },
  scriptMain: { mode: 'legacy' },
  scriptAux: { mode: 'legacy' },
}
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

interface IgpProviderRequest {
  method: string
  path: string
  authorization: string | undefined
  body: Record<string, unknown>
}

async function startIgpProvider(options: { translationGate?: Promise<void> } = {}) {
  const requests: IgpProviderRequest[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
    })
    const body = requests.at(-1)!.body
    if (body.model === ACCEPTED_TRANSLATION_MODEL) await options.translationGate
    const content = body.model === ACCEPTED_TRANSLATION_MODEL ? ACCEPTED_TRANSLATION : ACCEPTED_IGP_SUFFIX
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('IGP provider did not bind to a TCP port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

async function startHeldImageProvider(responseStatus = 200) {
  const requests: Array<{
    method: string
    path: string
    authorization: string | undefined
    body: Record<string, unknown>
  }> = []
  let announceStarted!: () => void
  let releaseResponse!: () => void
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve
  })
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
    })
    announceStarted()
    await responseGate
    response.writeHead(responseStatus, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        data: [
          {
            b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY4xAAAAAASUVORK5CYII=',
          },
        ],
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Image provider did not bind to a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}/v1/images/generations`,
    requests,
    started,
    release: releaseResponse,
    async close() {
      releaseResponse()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

async function startSequentialImageProvider() {
  const requests: Array<{
    method: string
    path: string
    authorization: string | undefined
    body: Record<string, unknown>
  }> = []
  let announceSecondStarted!: () => void
  let releaseSecondResponse!: () => void
  let secondReleased = false
  let secondAborted = false
  const secondStarted = new Promise<void>((resolve) => {
    announceSecondStarted = resolve
  })
  const secondResponseGate = new Promise<void>((resolve) => {
    releaseSecondResponse = resolve
  })
  const imageResponse = JSON.stringify({
    data: [
      {
        b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY4xAAAAAASUVORK5CYII=',
      },
    ],
  })
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
    })
    if (requests.length === 1) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(imageResponse)
      return
    }
    const markAborted = () => {
      if (!secondReleased && !response.writableEnded) secondAborted = true
    }
    request.once('aborted', markAborted)
    response.once('close', markAborted)
    announceSecondStarted()
    await secondResponseGate
    secondReleased = true
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(imageResponse)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Sequential image provider did not bind to a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}/v1/images/generations`,
    requests,
    secondStarted,
    get secondAborted() {
      return secondAborted
    },
    releaseSecond() {
      if (secondReleased) return
      secondReleased = true
      releaseSecondResponse()
    },
    async close() {
      secondReleased = true
      releaseSecondResponse()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
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
  failure_code: string | null
  failure_phase: string | null
  accepted_message_id: string | null
  target_message_id: string | null
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

interface EffectRow {
  operation_id: string
  generation_id: string
  chat_id: string
  message_id: string
  effect_kind: string
  effect_class: string
  status: string
  claim_id: string | null
  delivery: string | null
  reason: string | null
}

interface AuthorizedEffectMutation {
  method: string
  generationId: string
  effectKind: string
  action: 'claims' | 'lease' | 'receipt' | 'commit' | 'completion'
  operationId: string
  chatId: string
  messageId: string
  responseStatus: number
  terminalStatus: string
  terminalDelivery: string | null
  terminalReason: string | null
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
    useSayNothing: false,
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
      revision: (db.prepare('SELECT revision FROM schema_version WHERE id = 1').get() as { revision: number }).revision,
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
          'SELECT operation_id, chat_id, mode, creator_writer_session_id, admission_kind, occupancy_session_id, occupancy_epoch, occupancy_claim_class, state, failure_code, failure_phase, accepted_message_id, target_message_id, result_message_id FROM generation_operations ORDER BY created_at',
        )
        .all() as unknown as OperationRow[],
      messages: db
        .prepare('SELECT chat_id, seq, uid, role, data, json, alternate FROM messages ORDER BY chat_id, seq')
        .all() as unknown as MessageRow[],
      effects: db
        .prepare(
          'SELECT operation_id, generation_id, chat_id, message_id, effect_kind, effect_class, status, claim_id, delivery, reason FROM generation_effects ORDER BY operation_id, effect_kind',
        )
        .all() as unknown as EffectRow[],
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

function readCurrentSettings(dataDir: string): Record<string, unknown> {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
    return JSON.parse(row.data_json) as Record<string, unknown>
  } finally {
    db.close()
  }
}

function readInlayPreparation(dataDir: string, operationId: string) {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    return db
      .prepare(
        `SELECT inlay_preparation_id AS preparationId,
                inlay_preparation_expected_data AS expectedData,
                status
         FROM generation_effects
         WHERE operation_id = ? AND effect_kind = 'igp'`,
      )
      .get(operationId) as { preparationId: string | null; expectedData: string | null; status: string } | undefined
  } finally {
    db.close()
  }
}

async function startHarness(
  provider: OccupancyProvider,
  prefix: string,
  options: { now?: () => number; database?: Record<string, unknown>; chatOccupancyEnabled?: boolean } = {},
): Promise<FastBootstrapHarness> {
  return startFastBootstrapHarness(options.database ?? fixture(), {
    temporaryDirectoryPrefix: prefix,
    databaseSeedMode: 'unowned-migration',
    chatOccupancy: { enabled: options.chatOccupancyEnabled ?? true, ...(options.now ? { now: options.now } : {}) },
    generationChat: {
      dispatchProvider: provider.dispatch,
      pushNotifications: false,
      finalizationRetry: { intervalMs: 100, baseDelayMs: 100, maxDelayMs: 200 },
    },
  })
}

async function restartHarness(
  harness: FastBootstrapHarness,
  provider: OccupancyProvider,
  now: () => number,
): Promise<void> {
  const address = new URL(harness.baseUrl)
  const port = Number(address.port)
  harness.app.server.closeAllConnections()
  await harness.app.close()
  const { app } = await buildApp({
    config: {
      host: address.hostname,
      port,
      dataDir: harness.dataDir,
      bodyLimit: 20 * 1024 * 1024,
      importMaxBytes: Number.POSITIVE_INFINITY,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      staticRoot: path.resolve('dist'),
      requestTrace: { mode: 'agent' },
    },
    assetGc: false,
    chatOccupancy: { enabled: true, now },
    memoryWorker: false,
    generationChat: {
      dispatchProvider: provider.dispatch,
      pushNotifications: false,
      finalizationRetry: { intervalMs: 100, baseDelayMs: 100, maxDelayMs: 200 },
    },
  })
  await app.listen({ host: address.hostname, port })
  harness.app = app
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

async function directOccupancySnapshot(page: Page) {
  return page.evaluate(async () => {
    const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
    const response = await fetch('/api/v1/chat-occupancies', { headers })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  })
}

async function directTupleMutation(
  page: Page,
  input: {
    chatId: string
    databaseLineage: string
    sessionId: string
    occupancyEpoch: number
    action: 'renew' | 'release'
    authenticated?: boolean
  },
) {
  return page.evaluate(async (input) => {
    const authHeaders =
      input.authenticated === false ? {} : await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
    const response = await fetch(
      `/api/v1/chat-occupancies/${encodeURIComponent(input.chatId)}${input.action === 'renew' ? '/lease' : ''}`,
      {
        method: input.action === 'renew' ? 'PUT' : 'DELETE',
        headers: {
          ...authHeaders,
          'content-type': 'application/json',
          'risu-writer-session': input.sessionId,
          'risu-database-lineage': input.databaseLineage,
          'risu-chat-occupancy-epoch': String(input.occupancyEpoch),
        },
        body: JSON.stringify({ version: 1 }),
      },
    )
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }, input)
}

async function destructiveImport(page: Page, database: Record<string, unknown>) {
  return page.evaluate(async (database) => {
    const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
    const response = await fetch('/api/v1/import/risusave', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ database }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }, database)
}

async function chatOccupancyOutboxRows(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    () =>
      new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const opened = indexedDB.open('risu-pending-mutations-v1')
        opened.onerror = () => reject(opened.error)
        opened.onsuccess = () => {
          const database = opened.result
          if (!database.objectStoreNames.contains('mutations')) {
            database.close()
            resolve([])
            return
          }
          const transaction = database.transaction('mutations', 'readonly')
          const request = transaction.objectStore('mutations').getAll()
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            database.close()
            resolve(
              (request.result as Array<Record<string, unknown>>).filter(
                (record) => record.authorityKind === 'chat-occupancy',
              ),
            )
          }
        }
      }),
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

async function patchOwnerSettings(
  page: Page,
  group: 'advanced' | 'providers',
  patch: Record<string, unknown>,
): Promise<number> {
  const result = await page.evaluate(
    async ({ group, patch }) => {
      const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const bootstrap = await fetch('/api/v1/bootstrap', { headers })
        const { revision } = (await bootstrap.json()) as { revision: number }
        const response = await fetch(`/api/v1/commands/settings/${encodeURIComponent(group)}`, {
          method: 'PATCH',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ baseRevision: revision, patch }),
        })
        const body = (await response.json()) as { error?: string; revision?: number }
        if (response.status !== 409 || body.error !== 'revision_conflict') {
          return { status: response.status, body }
        }
      }
      return { status: 599, body: { error: 'revision_retry_exhausted' } }
    },
    { group, patch },
  )
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  expect(result.body.revision).toEqual(expect.any(Number))
  return result.body.revision!
}

async function setRetainedReaderDraft(page: Page, draft: string): Promise<void> {
  const composer = page.locator('[data-reader-composer-field="message"]')
  await expect(composer).toBeVisible()
  await composer.evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (!setter) throw new Error('textarea value setter is unavailable')
    setter.call(element, value)
    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
  }, draft)
  await expect(composer).toHaveValue(draft)
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

async function continueFromOwnerUi(client: Client, chatId: string, occurrence = 1): Promise<ApiRecord> {
  const send = client.page.getByTestId('default-chat-send-button')
  await expect(send).toBeVisible({ timeout: 30_000 })
  await expect(send).toBeEnabled({ timeout: 30_000 })
  await client.page.getByTestId('default-chat-menu-button').click()
  await client.page.getByRole('menuitem', { name: 'Continue Response', exact: true }).click()
  return expectSubmitAuthority(client, chatId, 'continue', occurrence, 30_000)
}

async function expectOwnerGenerationRecoverySettled(
  client: Client,
  dataDir: string,
  generationId: string,
): Promise<void> {
  const finalRecoveryClaim = `/api/v1/generation-effects/${encodeURIComponent(generationId)}/emotion_image_state/claims`
  await expect
    .poll(
      () =>
        client.records.some(
          (record) =>
            record.method === 'POST' &&
            record.path === finalRecoveryClaim &&
            (record.status === 200 || record.status === 201),
        ),
      { timeout: 30_000 },
    )
    .toBe(true)
  await expect
    .poll(
      () => {
        const effects = readTruth(dataDir).effects.filter((candidate) => candidate.generation_id === generationId)
        return (
          effects.length > 0 &&
          effects.every((candidate) => ['completed', 'skipped', 'failed'].includes(candidate.status))
        )
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  await expect
    .poll(() => client.page.evaluate(() => window.__RISU_FASTIFY_BROWSER_SMOKE__!.getGenerationReadinessDiagnostic()), {
      timeout: 30_000,
    })
    .toMatchObject({ ready: true, blockers: [] })
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
  interaction: 'send' | 'reroll' | 'continue' | 'regenerate',
  occurrence = 1,
  timeout = 5_000,
): Promise<ApiRecord> {
  const findSubmits = () =>
    client.records.filter(
      (record) =>
        record.method === 'POST' &&
        record.path === '/api/v1/generation-operations' &&
        record.body?.chatId === chatId &&
        (record.body?.chatOccupancy as { interaction?: unknown } | undefined)?.interaction === interaction &&
        [200, 201].includes(record.status ?? 0),
    )
  await expect.poll(() => findSubmits().length, { timeout }).toBeGreaterThanOrEqual(occurrence)
  const submit = findSubmits()[occurrence - 1]
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
    mode: interaction === 'send' ? 'send' : interaction === 'continue' ? 'continue' : 'regenerate',
  })
  return submit!
}

function auditChatOnlyMutations(
  client: Client,
  truth: ReturnType<typeof readTruth>,
  allowedChatIds: readonly string[],
): { violations: string[]; authorizedEffects: AuthorizedEffectMutation[] } {
  const violations: string[] = []
  const authorizedEffects: AuthorizedEffectMutation[] = []
  const allowedChats = new Set(allowedChatIds)
  const terminalStatuses = new Set(['completed', 'skipped', 'failed'])
  const ordinaryForbidden = (record: ApiRecord) =>
    /^\/api\/v1\/commands\/(?:settings|characters|modules|plugins)(?:\/|$)/u.test(record.path) ||
    /^\/api\/v1\/commands\/(?:chats|messages)(?:\/|$)/u.test(record.path) ||
    /^\/api\/v1\/(?:proxy\/plugin-fetch|assets)(?:\/|$)/u.test(record.path) ||
    record.path === '/api/v1/import/risusave'

  for (const record of client.records) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(record.method)) continue
    if (!record.path.startsWith('/api/v1/generation-effects/')) {
      if (ordinaryForbidden(record)) violations.push(`${record.method} ${record.path}: shared mutation`)
      continue
    }

    const routeMatch = record.path.match(
      /^\/api\/v1\/generation-effects\/([^/]+)\/([^/]+)\/(claims|lease|receipt|commit|completion)$/u,
    )
    if (!routeMatch) {
      violations.push(`${record.method} ${record.path}: unrecognized effect mutation route`)
      continue
    }
    const [, encodedGenerationId, encodedEffectKind, rawAction] = routeMatch
    const generationId = decodeURIComponent(encodedGenerationId!)
    const effectKind = decodeURIComponent(encodedEffectKind!)
    const action = rawAction as AuthorizedEffectMutation['action']
    const expectedMethod = action === 'claims' || action === 'completion' ? 'POST' : 'PUT'
    const effect = truth.effects.find(
      (candidate) => candidate.generation_id === generationId && candidate.effect_kind === effectKind,
    )
    const operation = effect
      ? truth.operations.find((candidate) => candidate.operation_id === effect.operation_id)
      : undefined
    const problems: string[] = []

    if (record.method !== expectedMethod) problems.push(`method ${record.method}, expected ${expectedMethod}`)
    if (!effect) problems.push('no exact generation/effect ledger row')
    if (!operation) problems.push('no exact originating operation')
    if (effect && !allowedChats.has(effect.chat_id)) problems.push(`chat ${effect.chat_id} is outside client scope`)
    if (operation?.chat_id !== effect?.chat_id) problems.push('effect/operation chat mismatch')
    if (operation?.occupancy_session_id !== client.sessionId) problems.push('originating session mismatch')
    if (operation?.admission_kind !== 'chat_only') problems.push(`admission ${operation?.admission_kind ?? 'missing'}`)
    if (operation?.result_message_id !== effect?.message_id) problems.push('accepted result/effect message mismatch')
    if (record.headers['risu-writer-session'] !== client.sessionId) problems.push('request session header mismatch')
    if (record.headers['risu-database-lineage'] !== truth.ownership.lineage) problems.push('request lineage mismatch')
    const allowedResponseStatuses = action === 'claims' ? [200, 201] : [200]
    if (!allowedResponseStatuses.includes(record.status ?? 0))
      problems.push(`response status ${record.status ?? 'missing'}`)
    if (effect && !terminalStatuses.has(effect.status)) problems.push(`nonterminal ledger status ${effect.status}`)

    const body = record.body ?? {}
    const bodyKeys = Object.keys(body).sort()
    if (action === 'claims') {
      const expectedKeys = [
        'delivery',
        'messageId',
        ...(body.recoverRecentCompletionAlert === true ? ['recoverRecentCompletionAlert'] : []),
      ].sort()
      if (JSON.stringify(bodyKeys) !== JSON.stringify(expectedKeys)) problems.push(`claim keys ${bodyKeys.join(',')}`)
      if (body.messageId !== effect?.message_id) problems.push('claim message identity mismatch')
      if (body.delivery !== 'live_terminal' && body.delivery !== 'late_recovery') {
        problems.push(`claim delivery ${String(body.delivery)}`)
      }
    } else if (action === 'lease') {
      if (JSON.stringify(bodyKeys) !== JSON.stringify(['claimId'])) problems.push(`lease keys ${bodyKeys.join(',')}`)
      if (body.claimId !== effect?.claim_id) problems.push('lease claim identity mismatch')
    } else if (action === 'completion') {
      if (effectKind !== 'igp') problems.push(`completion is not IGP (${effectKind})`)
      if (JSON.stringify(bodyKeys) !== JSON.stringify(['claimId'])) {
        problems.push(`completion keys ${bodyKeys.join(',')}`)
      }
      if (body.claimId !== effect?.claim_id) problems.push('completion claim identity mismatch')
    } else if (action === 'receipt') {
      const allowedKeys = new Set(['claimId', 'lastError', 'reason', 'status'])
      if (bodyKeys.some((key) => !allowedKeys.has(key))) problems.push(`receipt keys ${bodyKeys.join(',')}`)
      if (body.claimId !== effect?.claim_id) problems.push('receipt claim identity mismatch')
      if (!terminalStatuses.has(String(body.status))) problems.push(`receipt disposition ${String(body.status)}`)
      if (effect && body.status !== effect.status) problems.push('receipt/final ledger disposition mismatch')
    } else {
      const expectedKeys = ['baseRevision', 'claimId', 'data', 'expectedData', 'expectedGenerationId'].sort()
      if (effectKind !== 'igp') problems.push(`commit is not IGP (${effectKind})`)
      if (JSON.stringify(bodyKeys) !== JSON.stringify(expectedKeys)) problems.push(`commit keys ${bodyKeys.join(',')}`)
      if (body.claimId !== effect?.claim_id) problems.push('commit claim identity mismatch')
      if (body.expectedGenerationId !== generationId) problems.push('commit generation identity mismatch')
      if (effect?.status !== 'completed') problems.push(`commit disposition ${effect?.status ?? 'missing'}`)
    }

    if (problems.length > 0) {
      violations.push(`${record.method} ${record.path}: ${problems.join('; ')}`)
      continue
    }
    authorizedEffects.push({
      method: record.method,
      generationId,
      effectKind,
      action,
      operationId: operation!.operation_id,
      chatId: effect!.chat_id,
      messageId: effect!.message_id,
      responseStatus: record.status!,
      terminalStatus: effect!.status,
      terminalDelivery: effect!.delivery,
      terminalReason: effect!.reason,
    })
  }
  return { violations, authorizedEffects }
}

test('T01/T03/T04/T08/T11: owner, two chat-only senders, and an observer remain independently scoped', async ({
  browser,
}, testInfo) => {
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

test('Phase 4 T01/T04/T06/T08/T10: same-base send retry survives response loss, suspension, role transfer, and restart', async ({
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

test('Phase 4 T08/T09/T11: a promoted chat-only owner can reacquire, Continue, release, and unblock restore', async ({
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

test('T03/T07: full-to-targeted character hydration supersession restores one-click Continue readiness', async ({
  browser,
}) => {
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

test('T05/T06: suspension, expiry, reacquisition, and simultaneous release/claim keep epochs fenced', async ({
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

test('T07/T08/T10: a lost acceptance survives sender disappearance, role transfer, and pinned handoff', async ({
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

test('T07: an accepted owner Send settles after same-tuple chat-only normalization without redispatch', async ({
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

test('T07: a lost Stop response reconciles after reload without cancelling twice or replacing a newer draft', async ({
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

test('T07: a normalized owner Continue replays one pre-server Stop without losing the retained draft', async ({
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

test('T07: an exact pre-acceptance cancellation tombstone drains its sibling Send after reload', async ({
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

test('owner emotion inlay finalizes through exact accepted-operation lineage in Chromium', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  // Keep the provider open until Chromium has attached the accepted-operation
  // stream. An instant provider can legitimately finish before the browser GET
  // reaches Fastify, exercising reattachment rather than the live terminal path
  // whose inlay transport this regression proves.
  provider.configure(CHAT_OWNER, { chunks: ['Reply <Emotion="happy">'], holdAfterChunk: 1 })
  const configuredDatabase = fixture()
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'emotion'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.emotionImages = [['happy', 'happy.png']]
  const harness = await startHarness(provider, 'risu-chat-occupancy-emotion-inlay-', {
    database: configuredDatabase,
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'emotion-owner')
    clients.push(owner)
    owner.page.on('pageerror', (error) => pageErrors.push(error.message))
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)
    const ownerClaim = await directClaim(owner.page, CHAT_OWNER, 'owner')
    expect(ownerClaim.status, JSON.stringify(ownerClaim.body)).toBe(200)
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(owner.page)
    await owner.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )

    await sendFromUi(owner, 'Show a happy emotion.', true)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream(?:\?|$)/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await expectCompleted(harness.dataDir, CHAT_OWNER)
    await expect
      .poll(
        () =>
          owner.records.filter(
            (record) =>
              record.method === 'PUT' &&
              /\/api\/v1\/generation-effects\/[^/]+\/igp\/inlay-(?:preparation|finalization)$/u.test(record.path) &&
              record.status === 200,
          ).length,
        { timeout: 30_000 },
      )
      .toBe(2)

    const truth = readTruth(harness.dataDir)
    const operation = truth.operations.find((candidate) => candidate.chat_id === CHAT_OWNER)!
    const result = truth.messages.find((candidate) => candidate.uid === operation.result_message_id)!
    const inlayMutations = owner.records.filter(
      (record) =>
        record.method === 'PUT' &&
        /\/api\/v1\/generation-effects\/[^/]+\/igp\/inlay-(?:preparation|finalization)$/u.test(record.path),
    )
    const preparation = inlayMutations.find((record) => record.path.endsWith('/inlay-preparation'))!
    const finalization = inlayMutations.find((record) => record.path.endsWith('/inlay-finalization'))!
    expect(provider.calls(CHAT_OWNER)).toBe(1)
    expect(result.data).toBe('Reply {{emotion::happy}}')
    expect(result.data).not.toContain('<Emotion=')
    expect(inlayMutations).toHaveLength(2)
    expect(preparation).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': owner.sessionId,
        'risu-database-lineage': truth.ownership.lineage,
      },
      body: {
        baseRevision: expect.any(Number),
        operationId: operation.operation_id,
        preparationId: expect.any(String),
        expectedData: 'Reply <Emotion="happy">',
      },
    })
    expect(finalization).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': owner.sessionId,
        'risu-database-lineage': truth.ownership.lineage,
      },
      body: {
        baseRevision: expect.any(Number),
        operationId: operation.operation_id,
        preparationId: preparation.body?.preparationId,
        expectedData: 'Reply <Emotion="happy">',
        finalData: 'Reply {{emotion::happy}}',
      },
    })
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('owner-emotion-inlay-lineage.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          operation,
          result,
          inlayMutations: inlayMutations.map(({ method, path, headers, body, status }) => ({
            method,
            path,
            headers,
            body,
            status,
          })),
          truth,
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('owner-emotion-inlay-lineage', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('legacy owner emotion inlay persists with lineage when chat occupancy rollout is disabled', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, { chunks: ['Reply <Emotion="happy">'], holdAfterChunk: 1 })
  const configuredDatabase = fixture()
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'emotion'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.emotionImages = [['happy', 'happy.png']]
  const harness = await startHarness(provider, 'risu-chat-occupancy-disabled-emotion-inlay-', {
    database: configuredDatabase,
    chatOccupancyEnabled: false,
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'legacy-emotion-owner')
    clients.push(owner)
    owner.page.on('pageerror', (error) => pageErrors.push(error.message))
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)

    await sendFromUi(owner, 'Show a legacy happy emotion.', true)
    await expect.poll(() => provider.calls(CHAT_OWNER), { timeout: 30_000 }).toBe(1)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream(?:\?|$)/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await expect
      .poll(() => chatMessages(readTruth(harness.dataDir), CHAT_OWNER).at(-1)?.data, { timeout: 30_000 })
      .toBe('Reply {{emotion::happy}}')

    const truth = readTruth(harness.dataDir)
    const result = chatMessages(truth, CHAT_OWNER).at(-1)!
    const findMessageMutation = () =>
      owner.records.find(
        (record) =>
          record.method === 'PATCH' &&
          record.path === `/api/v1/commands/messages/${encodeURIComponent(result.uid)}` &&
          record.body?.expectedData === 'Reply <Emotion="happy">',
      )
    await expect.poll(() => findMessageMutation()?.status, { timeout: 30_000 }).toBe(200)
    const messageMutation = findMessageMutation()
    expect(messageMutation).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': owner.sessionId,
        'risu-database-lineage': truth.ownership.lineage,
      },
      body: {
        expectedChatId: CHAT_OWNER,
        expectedGenerationId: expect.any(String),
        patch: { data: 'Reply {{emotion::happy}}' },
      },
    })
    expect(
      owner.records.filter((record) => /\/igp\/inlay-(?:preparation|finalization|abandonment)$/u.test(record.path)),
    ).toHaveLength(0)
    expect(pageErrors).toEqual([])
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
  }
})

test('legacy owner image inlay persists with lineage when chat occupancy rollout is disabled', async ({ browser }) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, { chunks: ['Reply <ImgGen="happy cat">'], holdAfterChunk: 1 })
  const imageProvider = await startHeldImageProvider()
  const configuredDatabase = fixture()
  configuredDatabase.sdProvider = 'openai-compat'
  configuredDatabase.openaiCompatImage = {
    url: imageProvider.url,
    key: 'legacy-image-key',
    model: 'legacy-image-model',
    size: '1024x1024',
    quality: 'auto',
  }
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'imggen'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.newGenData = {
    prompt: 'best quality, {{slot}}',
    negative: 'worse quality',
    instructions: '',
    emotionInstructions: '',
  }
  const harness = await startHarness(provider, 'risu-chat-occupancy-disabled-image-inlay-', {
    database: configuredDatabase,
    chatOccupancyEnabled: false,
  }).catch(async (error: unknown) => {
    await imageProvider.close()
    throw error
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'legacy-image-owner')
    clients.push(owner)
    owner.page.on('pageerror', (error) => pageErrors.push(error.message))
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)

    await sendFromUi(owner, 'Show a legacy image.', true)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream(?:\?|$)/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await imageProvider.started
    expect(imageProvider.requests).toHaveLength(1)
    imageProvider.release()
    await expect
      .poll(() => chatMessages(readTruth(harness.dataDir), CHAT_OWNER).at(-1)?.data, { timeout: 30_000 })
      .toMatch(/^Reply \{\{inlay::[a-f0-9]{64}\}\}$/u)

    const truth = readTruth(harness.dataDir)
    const result = chatMessages(truth, CHAT_OWNER).at(-1)!
    const findMessageMutation = () =>
      owner.records.find(
        (record) =>
          record.method === 'PATCH' &&
          record.path === `/api/v1/commands/messages/${encodeURIComponent(result.uid)}` &&
          record.body?.expectedData === 'Reply <ImgGen="happy cat">',
      )
    await expect.poll(() => findMessageMutation()?.status, { timeout: 30_000 }).toBe(200)
    const messageMutation = findMessageMutation()
    expect(messageMutation).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': owner.sessionId,
        'risu-database-lineage': truth.ownership.lineage,
      },
      body: {
        expectedChatId: CHAT_OWNER,
        expectedGenerationId: expect.any(String),
        patch: { data: result.data },
      },
    })
    expect(
      owner.records.filter((record) => /\/igp\/inlay-(?:preparation|finalization|abandonment)$/u.test(record.path)),
    ).toHaveLength(0)
    expect(pageErrors).toEqual([])
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await Promise.all([closeFastBootstrapHarness(harness), imageProvider.close()])
  }
})

test('legacy held image failure preserves a newer owner edit through failed refreshes', async ({ browser }) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, { chunks: ['Reply <ImgGen="happy cat">'], holdAfterChunk: 1 })
  const imageProvider = await startHeldImageProvider(500)
  const configuredDatabase = fixture()
  configuredDatabase.sdProvider = 'openai-compat'
  configuredDatabase.disableAutoPopupMessageEditor = true
  configuredDatabase.openaiCompatImage = {
    url: imageProvider.url,
    key: 'failed-image-key',
    model: 'failed-image-model',
    size: '1024x1024',
    quality: 'auto',
  }
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'imggen'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.newGenData = {
    prompt: '{{slot}}',
    negative: '',
    instructions: '',
    emotionInstructions: '',
  }
  const harness = await startHarness(provider, 'risu-chat-occupancy-disabled-stale-image-', {
    database: configuredDatabase,
    chatOccupancyEnabled: false,
  }).catch(async (error: unknown) => {
    await imageProvider.close()
    throw error
  })
  const clients: Client[] = []
  try {
    const owner = await createClient(browser, 'legacy-stale-image-owner')
    clients.push(owner)
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)

    await sendFromUi(owner, 'Image before editing.', true)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream$/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await imageProvider.started

    const operation = readTruth(harness.dataDir).operations.find((candidate) => candidate.chat_id === CHAT_OWNER)!
    const messageId = operation.result_message_id!
    const newerData = 'Newer owner edit must survive.'
    const edit = await owner.page.evaluate(
      async ({ messageId, lineage, newerData }) => {
        const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
        const bootstrap = await fetch('/api/v1/bootstrap', { headers })
        const { revision } = (await bootstrap.json()) as { revision: number }
        const response = await fetch(`/api/v1/commands/messages/${encodeURIComponent(messageId)}`, {
          method: 'PATCH',
          headers: {
            ...headers,
            'content-type': 'application/json',
            'risu-database-lineage': lineage,
          },
          body: JSON.stringify({ baseRevision: revision, patch: { data: newerData } }),
        })
        return { status: response.status, body: (await response.json()) as Record<string, unknown> }
      },
      { messageId, lineage: readTruth(harness.dataDir).ownership.lineage, newerData },
    )
    expect(edit.status, JSON.stringify(edit.body)).toBe(200)
    const projection = () =>
      owner.page.evaluate(
        ({ chatId, messageId }) => {
          const database = window.__RISU_FASTIFY_BROWSER_SMOKE__!.getDatabaseSnapshot()
          const chats = database.characters.flatMap((character) => character.chats) as Array<{
            id?: string
            message?: Array<{ chatId?: string; data?: string }>
          }>
          return chats.find((chat) => chat.id === chatId)?.message?.find((message) => message.chatId === messageId)
            ?.data
        },
        { chatId: CHAT_OWNER, messageId },
      )
    await expect.poll(projection, { timeout: 30_000 }).toBe(newerData)
    await owner.context.route('**/api/v1/chats/**', (route) => route.abort('failed'))
    await owner.context.route('**/api/v1/characters/**', (route) => route.abort('failed'))

    imageProvider.release()
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.filter(
            (effect) => effect.chat_id === CHAT_OWNER && ['pending', 'claimed'].includes(effect.status),
          ).length,
        { timeout: 30_000 },
      )
      .toBe(0)
    expect(
      chatMessages(readTruth(harness.dataDir), CHAT_OWNER).find((message) => message.uid === messageId)?.data,
    ).toBe(newerData)
    await expect.poll(projection, { timeout: 5_000 }).toBe(newerData)
    expect(
      owner.records.filter(
        (record) =>
          record.method === 'PATCH' &&
          record.path === `/api/v1/commands/messages/${encodeURIComponent(messageId)}` &&
          record.body?.expectedData === 'Reply <ImgGen="happy cat">',
      ),
    ).toHaveLength(0)
  } finally {
    provider.releaseAll()
    imageProvider.release()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await Promise.all([closeFastBootstrapHarness(harness), imageProvider.close()])
  }
})

test('held browser image generation keeps translated IGP pending until exact inlay settlement', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, { chunks: ['Reply <ImgGen="happy cat">'], holdAfterChunk: 1 })
  const igpProvider = await startIgpProvider()
  const imageProvider = await startHeldImageProvider()
  const configuredDatabase = fixture()
  configuredDatabase.igpPrompt = ACCEPTED_IGP_PROMPT
  configuredDatabase.sdProvider = 'openai-compat'
  configuredDatabase.openaiCompatImage = {
    url: imageProvider.url,
    key: 'accepted-image-key',
    model: 'accepted-image-model',
    size: '1024x1024',
    quality: 'auto',
  }
  configuredDatabase.providerCredentials = [
    {
      id: 'accepted-igp-credential',
      name: 'Accepted IGP credential',
      type: 'apiKey',
      apiKey: ACCEPTED_IGP_CREDENTIAL,
    },
  ]
  configuredDatabase.modelProfiles = [
    {
      id: 'accepted-igp-profile',
      name: 'Accepted IGP profile',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: 'accepted-igp-credential',
        baseUrl: igpProvider.baseUrl,
        requestModel: ACCEPTED_IGP_MODEL,
      },
      runtimeOptions: { useStreaming: false },
    },
    {
      id: 'accepted-translation-profile',
      name: 'Accepted translation profile',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: 'accepted-igp-credential',
        baseUrl: igpProvider.baseUrl,
        requestModel: ACCEPTED_TRANSLATION_MODEL,
      },
      runtimeOptions: { useStreaming: false },
    },
  ]
  configuredDatabase.modelProfileOrder = ['accepted-igp-profile', 'accepted-translation-profile']
  configuredDatabase.modelRoleProfiles = {
    emotion: { mode: 'profile', profileId: 'accepted-igp-profile' },
    translate: { mode: 'profile', profileId: 'accepted-translation-profile' },
  }
  configuredDatabase.translator = 'ko'
  configuredDatabase.translatorInputLanguage = 'en'
  configuredDatabase.translatorType = 'llm'
  configuredDatabase.translatorSendTextAsIs = true
  configuredDatabase.translatorPrompt = 'Translate {{slot::content}}'
  configuredDatabase.translatorMaxResponse = 128
  configuredDatabase.autoTranslateNotificationDeferCapSeconds = 30
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'imggen'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.newGenData = {
    prompt: 'best quality, {{slot}}',
    negative: 'worse quality',
    instructions: '',
    emotionInstructions: '',
  }
  const configuredChat = (configuredCharacter.chats as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === CHAT_OWNER,
  )!
  configuredChat.autoTranslate = true
  configuredChat.autoTranslateBotOnly = true
  const seedText = `Seed for ${CHAT_OWNER}.`
  const seedMessage = (configuredChat.message as Array<Record<string, unknown>>)[0]!
  seedMessage.translation = {
    source: 'raw',
    text: 'Translated seed.',
    sourceHash: createHash('sha256').update(seedText).digest('hex'),
    targetLanguage: 'ko',
    inputLanguage: 'en',
    translatorType: 'llm',
    settingsHash: 'seed-translation-already-present',
    updatedAt: STATIC_LAST_INTERACTION,
  }
  const harness = await startHarness(provider, 'risu-chat-occupancy-held-imggen-', {
    database: configuredDatabase,
  }).catch(async (error: unknown) => {
    await Promise.all([igpProvider.close(), imageProvider.close()])
    throw error
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'held-image-owner')
    clients.push(owner)
    owner.page.on('pageerror', (error) => pageErrors.push(error.message))
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)
    const ownerClaim = await directClaim(owner.page, CHAT_OWNER, 'owner')
    expect(ownerClaim.status, JSON.stringify(ownerClaim.body)).toBe(200)
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(owner.page)
    await owner.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    expect(igpProvider.requests).toEqual([])

    await sendFromUi(owner, 'Generate one held image.', true)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream(?:\?|$)/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await expectCompleted(harness.dataDir, CHAT_OWNER)
    await expect.poll(() => imageProvider.requests.length, { timeout: 30_000 }).toBe(1)
    await imageProvider.started
    await expect
      .poll(() => igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL).length, {
        timeout: 30_000,
      })
      .toBe(1)
    const heldTruth = readTruth(harness.dataDir)
    const operation = heldTruth.operations.find((candidate) => candidate.chat_id === CHAT_OWNER)!
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.find(
            (effect) =>
              effect.operation_id === operation.operation_id && effect.effect_kind === 'generated_translation',
          )?.status,
        { timeout: 30_000 },
      )
      .toBe('completed')
    await expect
      .poll(() => readInlayPreparation(harness.dataDir, operation.operation_id), { timeout: 30_000 })
      .toMatchObject({
        preparationId: expect.any(String),
        expectedData: 'Reply <ImgGen="happy cat">',
        status: 'pending',
      })
    const heldMessage = readTruth(harness.dataDir).messages.find(
      (candidate) => candidate.uid === operation.result_message_id,
    )!
    expect(heldMessage.data).toBe('Reply <ImgGen="happy cat">')
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(0)
    expect(owner.records.filter((record) => record.path.endsWith('/igp/inlay-finalization'))).toHaveLength(0)

    imageProvider.release()
    await expect
      .poll(
        () =>
          owner.records.filter((record) => record.path.endsWith('/igp/inlay-finalization') && record.status === 200),
        { timeout: 30_000 },
      )
      .toHaveLength(1)
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.find(
            (effect) => effect.operation_id === operation.operation_id && effect.effect_kind === 'igp',
          )?.status,
        { timeout: 30_000 },
      )
      .toBe('completed')
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir)
            .effects.filter(
              (effect) =>
                effect.operation_id === operation.operation_id && ['pending', 'claimed'].includes(effect.status),
            )
            .map((effect) => `${effect.effect_kind}:${effect.status}`),
        { timeout: 30_000 },
      )
      .toEqual([])

    const completed = readTruth(harness.dataDir)
    const result = completed.messages.find((candidate) => candidate.uid === operation.result_message_id)!
    const assetMatch = /\{\{inlay::([a-f0-9]{64})\}\}/u.exec(result.data)
    const inlayPreparation = owner.records.find((record) => record.path.endsWith('/igp/inlay-preparation'))!
    const inlayFinalization = owner.records.find((record) => record.path.endsWith('/igp/inlay-finalization'))!
    expect(provider.calls(CHAT_OWNER)).toBe(1)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL)).toHaveLength(1)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(1)
    expect(imageProvider.requests).toHaveLength(1)
    expect(assetMatch?.[1]).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.data).toBe(`Reply {{inlay::${assetMatch?.[1]}}}${ACCEPTED_IGP_SUFFIX}`)
    expect(result.data).not.toContain('<ImgGen=')
    expect(readInlayPreparation(harness.dataDir, operation.operation_id)).toEqual({
      preparationId: null,
      expectedData: null,
      status: 'completed',
    })
    expect(imageProvider.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/images/generations',
      authorization: 'Bearer accepted-image-key',
      body: {
        prompt: 'best quality, happy cat',
        response_format: 'b64_json',
        model: 'accepted-image-model',
      },
    })
    expect(inlayPreparation).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': owner.sessionId,
        'risu-database-lineage': completed.ownership.lineage,
      },
      body: {
        operationId: operation.operation_id,
        preparationId: expect.any(String),
        expectedData: 'Reply <ImgGen="happy cat">',
      },
    })
    expect(inlayFinalization).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': owner.sessionId,
        'risu-database-lineage': completed.ownership.lineage,
      },
      body: {
        operationId: operation.operation_id,
        preparationId: inlayPreparation.body?.preparationId,
        expectedData: 'Reply <ImgGen="happy cat">',
        finalData: `Reply {{inlay::${assetMatch?.[1]}}}`,
      },
    })
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('held-imggen-translation-inlay-igp.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          operation,
          providerCounts: {
            main: provider.calls(CHAT_OWNER),
            translation: igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL)
              .length,
            igp: igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL).length,
            image: imageProvider.requests.length,
          },
          imageProviderRequests: imageProvider.requests,
          igpProviderRequests: igpProvider.requests,
          inlayMutations: [inlayPreparation, inlayFinalization].map(({ method, path, headers, body, status }) => ({
            method,
            path,
            headers,
            body,
            status,
          })),
          completed,
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('held-imggen-translation-inlay-igp', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    provider.releaseAll()
    imageProvider.release()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
    await Promise.all([igpProvider.close(), imageProvider.close()])
  }
})

test('a completed first ImgGen settlement cannot time out a later provider across regex passes', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, {
    chunks: ['First <ImgGen="fast"> then {{ImgGen="slow"}}'],
    holdAfterChunk: 1,
  })
  const imageProvider = await startSequentialImageProvider()
  const configuredDatabase = fixture()
  configuredDatabase.sdProvider = 'openai-compat'
  configuredDatabase.openaiCompatImage = {
    url: imageProvider.url,
    key: 'sequential-image-key',
    model: 'sequential-image-model',
    size: '1024x1024',
    quality: 'auto',
  }
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'imggen'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.newGenData = {
    prompt: 'best quality, {{slot}}',
    negative: 'worse quality',
    instructions: '',
    emotionInstructions: '',
  }
  const harness = await startHarness(provider, 'risu-chat-occupancy-sequential-imggen-', {
    database: configuredDatabase,
  }).catch(async (error: unknown) => {
    await imageProvider.close()
    throw error
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'sequential-image-owner')
    clients.push(owner)
    owner.page.on('pageerror', (error) => pageErrors.push(error.message))
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)
    const ownerClaim = await directClaim(owner.page, CHAT_OWNER, 'owner')
    expect(ownerClaim.status, JSON.stringify(ownerClaim.body)).toBe(200)
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(owner.page)
    await owner.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )

    await sendFromUi(owner, 'Generate sequential mixed image tags.', true)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream(?:\?|$)/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await expectCompleted(harness.dataDir, CHAT_OWNER)
    await imageProvider.secondStarted
    const operation = readTruth(harness.dataDir).operations.find((candidate) => candidate.chat_id === CHAT_OWNER)!
    await expect
      .poll(
        () => owner.records.filter((record) => record.method === 'POST' && record.path === '/api/v1/assets').length,
        { timeout: 30_000 },
      )
      .toBe(1)
    expect(imageProvider.requests).toHaveLength(2)
    expect(imageProvider.requests.map((request) => request.body.prompt)).toEqual([
      'best quality, fast',
      'best quality, slow',
    ])

    // The retired shared deadline failed here: it started when the first
    // provider returned and aborted the still-running second request at 30s.
    await owner.page.waitForTimeout(31_000)
    expect(imageProvider.secondAborted).toBe(false)
    expect(owner.records.filter((record) => record.path.endsWith('/igp/inlay-abandonment'))).toHaveLength(0)
    expect(owner.records.filter((record) => record.path.endsWith('/igp/inlay-finalization'))).toHaveLength(0)
    expect(readInlayPreparation(harness.dataDir, operation.operation_id)).toMatchObject({
      preparationId: expect.any(String),
      expectedData: 'First <ImgGen="fast"> then {{ImgGen="slow"}}',
      status: 'pending',
    })

    imageProvider.releaseSecond()
    await expect
      .poll(
        () =>
          owner.records.filter((record) => record.path.endsWith('/igp/inlay-finalization') && record.status === 200)
            .length,
        { timeout: 30_000 },
      )
      .toBe(1)
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.filter(
            (effect) =>
              effect.operation_id === operation.operation_id && ['pending', 'claimed'].includes(effect.status),
          ).length,
        { timeout: 30_000 },
      )
      .toBe(0)

    const completed = readTruth(harness.dataDir)
    const result = completed.messages.find((candidate) => candidate.uid === operation.result_message_id)!
    const assetIds = [...result.data.matchAll(/\{\{inlay::([a-f0-9]{64})\}\}/gu)].map((match) => match[1])
    expect(provider.calls(CHAT_OWNER)).toBe(1)
    expect(imageProvider.requests).toHaveLength(2)
    expect(owner.records.filter((record) => record.method === 'POST' && record.path === '/api/v1/assets')).toHaveLength(
      2,
    )
    expect(assetIds).toHaveLength(2)
    expect(result.data).toBe(`First {{inlay::${assetIds[0]}}} then {{inlay::${assetIds[1]}}}`)
    expect(result.data).not.toMatch(/<ImgGen=|\{\{ImgGen=/u)
    expect(readInlayPreparation(harness.dataDir, operation.operation_id)).toEqual({
      preparationId: null,
      expectedData: null,
      status: 'skipped',
    })
    const occupied = completed.occupancy.find(
      (candidate) => (candidate as { chat_id?: string }).chat_id === CHAT_OWNER,
    ) as { occupancy_epoch: number }
    const released = await directTupleMutation(owner.page, {
      chatId: CHAT_OWNER,
      databaseLineage: completed.ownership.lineage,
      sessionId: owner.sessionId,
      occupancyEpoch: occupied.occupancy_epoch,
      action: 'release',
    })
    expect(released).toMatchObject({ status: 200, body: { state: 'released' } })
    expect(pageErrors).toEqual([])
  } finally {
    provider.releaseAll()
    imageProvider.releaseSecond()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await Promise.all([closeFastBootstrapHarness(harness), imageProvider.close()])
  }
})

test('role loss cancels a held inlay asset upload and releases exact recovery without reload', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, { chunks: ['Reply <ImgGen="happy cat">'], holdAfterChunk: 1 })
  const igpProvider = await startIgpProvider()
  const imageProvider = await startHeldImageProvider()
  const configuredDatabase = fixture()
  configuredDatabase.igpPrompt = ACCEPTED_IGP_PROMPT
  configuredDatabase.sdProvider = 'openai-compat'
  configuredDatabase.openaiCompatImage = {
    url: imageProvider.url,
    key: 'cancelled-upload-image-key',
    model: 'cancelled-upload-image-model',
    size: '1024x1024',
    quality: 'auto',
  }
  configuredDatabase.providerCredentials = [
    {
      id: 'cancelled-upload-igp-credential',
      name: 'Cancelled upload IGP credential',
      type: 'apiKey',
      apiKey: ACCEPTED_IGP_CREDENTIAL,
    },
  ]
  configuredDatabase.modelProfiles = [
    {
      id: 'cancelled-upload-igp-profile',
      name: 'Cancelled upload IGP',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: 'cancelled-upload-igp-credential',
        baseUrl: igpProvider.baseUrl,
        requestModel: ACCEPTED_IGP_MODEL,
      },
      runtimeOptions: { useStreaming: false },
    },
    {
      id: 'cancelled-upload-translation-profile',
      name: 'Cancelled upload translation',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: 'cancelled-upload-igp-credential',
        baseUrl: igpProvider.baseUrl,
        requestModel: ACCEPTED_TRANSLATION_MODEL,
      },
      runtimeOptions: { useStreaming: false },
    },
  ]
  configuredDatabase.modelProfileOrder = ['cancelled-upload-igp-profile', 'cancelled-upload-translation-profile']
  configuredDatabase.modelRoleProfiles = {
    emotion: { mode: 'profile', profileId: 'cancelled-upload-igp-profile' },
    translate: { mode: 'profile', profileId: 'cancelled-upload-translation-profile' },
  }
  configuredDatabase.translator = 'ko'
  configuredDatabase.translatorInputLanguage = 'en'
  configuredDatabase.translatorType = 'llm'
  configuredDatabase.translatorSendTextAsIs = true
  configuredDatabase.translatorPrompt = 'Translate {{slot::content}}'
  configuredDatabase.translatorMaxResponse = 128
  configuredDatabase.autoTranslateNotificationDeferCapSeconds = 30
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'imggen'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.newGenData = {
    prompt: 'best quality, {{slot}}',
    negative: 'worse quality',
    instructions: '',
    emotionInstructions: '',
  }
  const configuredChat = (configuredCharacter.chats as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === CHAT_OWNER,
  )!
  configuredChat.autoTranslate = true
  configuredChat.autoTranslateBotOnly = true
  const seedText = `Seed for ${CHAT_OWNER}.`
  const seedMessage = (configuredChat.message as Array<Record<string, unknown>>)[0]!
  seedMessage.translation = {
    source: 'raw',
    text: 'Translated seed.',
    sourceHash: createHash('sha256').update(seedText).digest('hex'),
    targetLanguage: 'ko',
    inputLanguage: 'en',
    translatorType: 'llm',
    settingsHash: 'cancelled-upload-seed-translation',
    updatedAt: STATIC_LAST_INTERACTION,
  }
  const harness = await startHarness(provider, 'risu-chat-occupancy-cancelled-inlay-upload-', {
    database: configuredDatabase,
  }).catch(async (error: unknown) => {
    await Promise.all([igpProvider.close(), imageProvider.close()])
    throw error
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  let releaseUpload!: () => void
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve
  })
  let uploadStarted = false
  try {
    const owner = await createClient(browser, 'cancelled-upload-owner')
    clients.push(owner)
    owner.page.on('pageerror', (error) => pageErrors.push(`${owner.name}: ${error.message}`))
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)
    const ownerClaim = await directClaim(owner.page, CHAT_OWNER, 'owner')
    expect(ownerClaim.status, JSON.stringify(ownerClaim.body)).toBe(200)
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(owner.page)
    await owner.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await owner.context.route('**/api/v1/assets', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      uploadStarted = true
      await uploadGate
      await route.continue().catch(() => undefined)
    })

    await sendFromUi(owner, 'Cancel the held upload after its provider.', true)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream(?:\?|$)/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await expectCompleted(harness.dataDir, CHAT_OWNER)
    await imageProvider.started
    await expect
      .poll(() => igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL).length, {
        timeout: 30_000,
      })
      .toBe(1)
    const operation = readTruth(harness.dataDir).operations.find((candidate) => candidate.chat_id === CHAT_OWNER)!
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.find(
            (effect) =>
              effect.operation_id === operation.operation_id && effect.effect_kind === 'generated_translation',
          )?.status,
        { timeout: 30_000 },
      )
      .toBe('completed')
    await expect
      .poll(() => readInlayPreparation(harness.dataDir, operation.operation_id), { timeout: 30_000 })
      .toMatchObject({
        preparationId: expect.any(String),
        expectedData: 'Reply <ImgGen="happy cat">',
        status: 'pending',
      })
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(0)

    imageProvider.release()
    await expect.poll(() => uploadStarted, { timeout: 30_000 }).toBe(true)
    expect(owner.records.filter((record) => record.method === 'POST' && record.path === '/api/v1/assets')).toHaveLength(
      1,
    )
    expect(owner.records.filter((record) => record.path.endsWith('/igp/inlay-finalization'))).toHaveLength(0)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(0)

    const successor = await createClient(browser, 'cancelled-upload-successor')
    clients.push(successor)
    successor.page.on('pageerror', (error) => pageErrors.push(`${successor.name}: ${error.message}`))
    await bootReader(successor, harness, CHAT_OBSERVER)
    const writerEpoch = readTruth(harness.dataDir).ownership.writer_epoch
    await promoteViaUi(successor, owner, harness.dataDir, writerEpoch + 1)
    await expectOccupancyState(owner.page, 'normalization-required')
    const normalize = owner.page.locator('[data-reader-occupancy-normalize]')
    await expect(normalize).toBeEnabled()
    await normalize.click()
    await expectOccupancyState(owner.page, 'self-owned')

    await expect
      .poll(
        () =>
          owner.records.filter((record) => record.path.endsWith('/igp/inlay-abandonment') && record.status === 200)
            .length,
        { timeout: 30_000 },
      )
      .toBe(1)
    expect(owner.records.filter((record) => record.path.endsWith('/igp/inlay-finalization'))).toHaveLength(0)
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir)
            .effects.filter(
              (effect) =>
                effect.operation_id === operation.operation_id && ['pending', 'claimed'].includes(effect.status),
            )
            .map((effect) => `${effect.effect_kind}:${effect.status}`),
        { timeout: 30_000 },
      )
      .toEqual([])

    const completed = readTruth(harness.dataDir)
    const result = completed.messages.find((message) => message.uid === operation.result_message_id)!
    const operationEffects = completed.effects.filter((effect) => effect.operation_id === operation.operation_id)
    expect(provider.calls(CHAT_OWNER)).toBe(1)
    expect(imageProvider.requests).toHaveLength(1)
    expect(owner.records.filter((record) => record.method === 'POST' && record.path === '/api/v1/assets')).toHaveLength(
      1,
    )
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL)).toHaveLength(1)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(1)
    expect(result.data).toBe(`Reply <ImgGen="happy cat">${ACCEPTED_IGP_SUFFIX}`)
    expect(operationEffects.filter((effect) => ['pending', 'claimed'].includes(effect.status))).toHaveLength(0)
    expect(readInlayPreparation(harness.dataDir, operation.operation_id)).toEqual({
      preparationId: null,
      expectedData: null,
      status: 'completed',
    })

    const occupied = completed.occupancy.find(
      (candidate) => (candidate as { chat_id?: string }).chat_id === CHAT_OWNER,
    ) as { occupancy_epoch: number }
    const released = await directTupleMutation(owner.page, {
      chatId: CHAT_OWNER,
      databaseLineage: completed.ownership.lineage,
      sessionId: owner.sessionId,
      occupancyEpoch: occupied.occupancy_epoch,
      action: 'release',
    })
    expect(released).toMatchObject({ status: 200, body: { state: 'released' } })
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('role-loss-held-inlay-upload.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          operation,
          providerCounts: {
            main: provider.calls(CHAT_OWNER),
            image: imageProvider.requests.length,
            upload: owner.records.filter((record) => record.method === 'POST' && record.path === '/api/v1/assets')
              .length,
            translation: igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL)
              .length,
            igp: igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL).length,
          },
          inlayMutations: owner.records
            .filter((record) => /\/igp\/inlay-(?:preparation|finalization|abandonment)$/u.test(record.path))
            .map(({ method, path, headers, body, status }) => ({ method, path, headers, body, status })),
          completed,
          released,
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('role-loss-held-inlay-upload', {
      path: evidencePath,
      contentType: 'application/json',
    })
    releaseUpload()
  } finally {
    releaseUpload()
    provider.releaseAll()
    imageProvider.release()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
    await Promise.all([igpProvider.close(), imageProvider.close()])
  }
})

test('held inlay preparation acknowledgement blocks translated recovery until exact settlement', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OWNER, { chunks: ['Reply <Emotion="happy">'], holdAfterChunk: 1 })
  let releaseTranslation!: () => void
  const translationGate = new Promise<void>((resolve) => {
    releaseTranslation = resolve
  })
  const igpProvider = await startIgpProvider({ translationGate })
  const configuredDatabase = fixture()
  configuredDatabase.igpPrompt = ACCEPTED_IGP_PROMPT
  configuredDatabase.providerCredentials = [
    {
      id: 'held-ack-credential',
      name: 'Held acknowledgement credential',
      type: 'apiKey',
      apiKey: ACCEPTED_IGP_CREDENTIAL,
    },
  ]
  configuredDatabase.modelProfiles = [
    {
      id: 'held-ack-igp-profile',
      name: 'Held acknowledgement IGP',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: 'held-ack-credential',
        baseUrl: igpProvider.baseUrl,
        requestModel: ACCEPTED_IGP_MODEL,
      },
      runtimeOptions: { useStreaming: false },
    },
    {
      id: 'held-ack-translation-profile',
      name: 'Held acknowledgement translation',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: 'held-ack-credential',
        baseUrl: igpProvider.baseUrl,
        requestModel: ACCEPTED_TRANSLATION_MODEL,
      },
      runtimeOptions: { useStreaming: false },
    },
  ]
  configuredDatabase.modelProfileOrder = ['held-ack-igp-profile', 'held-ack-translation-profile']
  configuredDatabase.modelRoleProfiles = {
    emotion: { mode: 'profile', profileId: 'held-ack-igp-profile' },
    translate: { mode: 'profile', profileId: 'held-ack-translation-profile' },
  }
  configuredDatabase.translator = 'ko'
  configuredDatabase.translatorInputLanguage = 'en'
  configuredDatabase.translatorType = 'llm'
  configuredDatabase.translatorSendTextAsIs = true
  configuredDatabase.translatorPrompt = 'Translate {{slot::content}}'
  configuredDatabase.translatorMaxResponse = 128
  configuredDatabase.autoTranslateNotificationDeferCapSeconds = 1
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.viewScreen = 'emotion'
  configuredCharacter.inlayViewScreen = true
  configuredCharacter.emotionImages = [['happy', 'happy.png']]
  const configuredChat = (configuredCharacter.chats as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === CHAT_OWNER,
  )!
  configuredChat.autoTranslate = true
  configuredChat.autoTranslateBotOnly = true
  const seedText = `Seed for ${CHAT_OWNER}.`
  const seedMessage = (configuredChat.message as Array<Record<string, unknown>>)[0]!
  seedMessage.translation = {
    source: 'raw',
    text: 'Translated seed.',
    sourceHash: createHash('sha256').update(seedText).digest('hex'),
    targetLanguage: 'ko',
    inputLanguage: 'en',
    translatorType: 'llm',
    settingsHash: 'held-ack-seed-translation',
    updatedAt: STATIC_LAST_INTERACTION,
  }
  const harness = await startHarness(provider, 'risu-chat-occupancy-held-preparation-ack-', {
    database: configuredDatabase,
  }).catch(async (error: unknown) => {
    releaseTranslation()
    await igpProvider.close()
    throw error
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  let releasePreparation!: () => void
  const preparationGate = new Promise<void>((resolve) => {
    releasePreparation = resolve
  })
  let heldPreparation = false
  try {
    const owner = await createClient(browser, 'held-preparation-owner')
    clients.push(owner)
    owner.page.on('pageerror', (error) => pageErrors.push(error.message))
    await bootOwner(owner, harness, CHAT_OWNER)
    await configureChats(owner.page)
    const ownerClaim = await directClaim(owner.page, CHAT_OWNER, 'owner')
    expect(ownerClaim.status, JSON.stringify(ownerClaim.body)).toBe(200)
    await owner.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(owner.page)
    await owner.page.evaluate(() =>
      window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
    )
    await owner.context.route('**/api/v1/generation-effects/*/igp/inlay-preparation', async (route) => {
      heldPreparation = true
      await preparationGate
      await route.continue()
    })

    await sendFromUi(owner, 'Reserve before recovered IGP.', true)
    await expect
      .poll(
        () =>
          owner.records.some(
            (record) =>
              record.method === 'GET' &&
              /\/api\/v1\/generation-operations\/[^/]+\/stream(?:\?|$)/u.test(record.path) &&
              record.status === 200,
          ),
        { timeout: 30_000 },
      )
      .toBe(true)
    provider.release(CHAT_OWNER)
    await expectCompleted(harness.dataDir, CHAT_OWNER)
    await expect.poll(() => heldPreparation, { timeout: 30_000 }).toBe(true)
    await expect
      .poll(() => igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL).length, {
        timeout: 30_000,
      })
      .toBe(1)
    const operation = readTruth(harness.dataDir).operations.find((candidate) => candidate.chat_id === CHAT_OWNER)!
    const bootstrapCountBeforeTranslation = owner.records.filter(
      (record) => record.method === 'GET' && record.path === '/api/v1/bootstrap',
    ).length

    releaseTranslation()
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.find(
            (effect) =>
              effect.operation_id === operation.operation_id && effect.effect_kind === 'generated_translation',
          )?.status,
        { timeout: 30_000 },
      )
      .toBe('completed')
    await expect
      .poll(
        () => owner.records.filter((record) => record.method === 'GET' && record.path === '/api/v1/bootstrap').length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(bootstrapCountBeforeTranslation)

    const heldTruth = readTruth(harness.dataDir)
    expect(readInlayPreparation(harness.dataDir, operation.operation_id)).toEqual({
      preparationId: null,
      expectedData: null,
      status: 'pending',
    })
    expect(
      heldTruth.effects.find((effect) => effect.operation_id === operation.operation_id && effect.effect_kind === 'igp')
        ?.status,
    ).toBe('pending')
    expect(heldTruth.messages.find((message) => message.uid === operation.result_message_id)?.data).toBe(
      'Reply <Emotion="happy">',
    )
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(0)
    expect(owner.records.filter((record) => record.path.endsWith('/igp/claims'))).toHaveLength(0)

    releasePreparation()
    await expect
      .poll(
        () =>
          owner.records.filter((record) => record.path.endsWith('/igp/inlay-preparation') && record.status === 200)
            .length,
        { timeout: 30_000 },
      )
      .toBe(1)
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.find(
            (effect) => effect.operation_id === operation.operation_id && effect.effect_kind === 'igp',
          )?.status,
        { timeout: 30_000 },
      )
      .toBe('completed')
    await expect
      .poll(
        () =>
          readTruth(harness.dataDir).effects.filter(
            (effect) =>
              effect.operation_id === operation.operation_id && ['pending', 'claimed'].includes(effect.status),
          ).length,
        { timeout: 30_000 },
      )
      .toBe(0)

    const completed = readTruth(harness.dataDir)
    const result = completed.messages.find((message) => message.uid === operation.result_message_id)!
    const operationEffects = completed.effects.filter((effect) => effect.operation_id === operation.operation_id)
    const generationRequests = owner.records.filter((record) => record.path.includes('/generation-effects/'))
    const preparations = generationRequests.filter((record) => record.path.endsWith('/igp/inlay-preparation'))
    const preparation = preparations.find((record) => record.status === 200)!
    const finalization = generationRequests.find((record) => record.path.endsWith('/igp/inlay-finalization'))!
    const claim = generationRequests.find((record) => record.path.endsWith('/igp/claims'))!
    expect(provider.calls(CHAT_OWNER)).toBe(1)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL)).toHaveLength(1)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(1)
    expect(result.data).toBe(`Reply {{emotion::happy}}${ACCEPTED_IGP_SUFFIX}`)
    expect(result.data).not.toContain('<Emotion=')
    expect(operationEffects.filter((effect) => ['pending', 'claimed'].includes(effect.status))).toHaveLength(0)
    // Translation advanced the shared revision while Chromium deliberately
    // held the first request. The client replays the same stable preparation
    // identity once, rather than starting another provider obligation.
    expect(preparations.map((record) => record.status)).toEqual([409, 200])
    expect(new Set(preparations.map((record) => record.body?.preparationId)).size).toBe(1)
    expect(generationRequests.filter((record) => record.path.endsWith('/igp/inlay-finalization'))).toHaveLength(1)
    expect(generationRequests.indexOf(preparation)).toBeLessThan(generationRequests.indexOf(finalization))
    expect(generationRequests.indexOf(finalization)).toBeLessThan(generationRequests.indexOf(claim))
    expect(readInlayPreparation(harness.dataDir, operation.operation_id)).toEqual({
      preparationId: null,
      expectedData: null,
      status: 'completed',
    })
    expect(pageErrors).toEqual([])

    const occupied = completed.occupancy.find(
      (candidate) => (candidate as { chat_id?: string }).chat_id === CHAT_OWNER,
    ) as { occupancy_epoch: number }
    const released = await directTupleMutation(owner.page, {
      chatId: CHAT_OWNER,
      databaseLineage: completed.ownership.lineage,
      sessionId: owner.sessionId,
      occupancyEpoch: occupied.occupancy_epoch,
      action: 'release',
    })
    expect(released).toMatchObject({ status: 200, body: { state: 'released' } })

    const evidencePath = testInfo.outputPath('held-preparation-translation-inlay-igp.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          operation,
          heldTruth,
          completed,
          providerCounts: {
            main: provider.calls(CHAT_OWNER),
            translation: igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL)
              .length,
            igp: igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL).length,
          },
          generationRequests,
          released,
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('held-preparation-translation-inlay-igp', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    releaseTranslation()
    releasePreparation()
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
    await igpProvider.close()
  }
})

test('T07/T10: configured chat-only IGP commits atomically once when its response and receipt are lost', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000)
  const provider = new OccupancyProvider()
  provider.configure(CHAT_OBSERVER, { chunks: ['Configured IGP source.'] })
  const igpProvider = await startIgpProvider()
  const configuredDatabase = fixture()
  configuredDatabase.igpPrompt = ACCEPTED_IGP_PROMPT
  configuredDatabase.providerCredentials = [
    {
      id: 'accepted-igp-credential',
      name: 'Accepted IGP credential',
      type: 'apiKey',
      apiKey: ACCEPTED_IGP_CREDENTIAL,
    },
  ]
  configuredDatabase.modelProfiles = [
    {
      id: 'accepted-igp-profile',
      name: 'Accepted IGP profile',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: 'accepted-igp-credential',
        baseUrl: igpProvider.baseUrl,
        requestModel: ACCEPTED_IGP_MODEL,
      },
      runtimeOptions: { useStreaming: false },
    },
    {
      id: 'accepted-translation-profile',
      name: 'Accepted translation profile',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: {
        credentialId: 'accepted-igp-credential',
        baseUrl: igpProvider.baseUrl,
        requestModel: ACCEPTED_TRANSLATION_MODEL,
      },
      runtimeOptions: { useStreaming: false },
    },
  ]
  configuredDatabase.modelProfileOrder = ['accepted-igp-profile', 'accepted-translation-profile']
  configuredDatabase.modelRoleProfiles = {
    emotion: { mode: 'profile', profileId: 'accepted-igp-profile' },
    translate: { mode: 'profile', profileId: 'accepted-translation-profile' },
  }
  configuredDatabase.translator = 'ko'
  configuredDatabase.translatorInputLanguage = 'en'
  configuredDatabase.translatorType = 'llm'
  configuredDatabase.translatorSendTextAsIs = true
  configuredDatabase.translatorPrompt = 'Translate {{slot::content}}'
  configuredDatabase.translatorMaxResponse = 128
  configuredDatabase.autoTranslateNotificationDeferCapSeconds = 30
  const configuredCharacter = (configuredDatabase.characters as Array<Record<string, unknown>>)[0]!
  configuredCharacter.triggerscript = [
    {
      comment: '',
      type: 'input',
      conditions: [],
      effect: [
        {
          type: 'triggerlua',
          code: `
            function onInput(triggerId)
              addChat(triggerId, 'char', '${ACCEPTED_IGP_INPUT_ROW}')
            end
          `,
        },
      ],
    },
  ]
  const configuredChat = (configuredCharacter.chats as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === CHAT_OBSERVER,
  )!
  configuredChat.autoTranslate = true
  const harness = await startHarness(provider, 'risu-chat-occupancy-configured-igp-', {
    database: configuredDatabase,
  }).catch(async (error: unknown) => {
    await igpProvider.close()
    throw error
  })
  const clients: Client[] = []
  const pageErrors: string[] = []
  try {
    const owner = await createClient(browser, 'owner')
    const sender = await createClient(browser, 'igp-sender', devices['Pixel 7'])
    clients.push(owner, sender)
    for (const client of clients)
      client.page.on('pageerror', (error) => pageErrors.push(`${client.name}: ${error.message}`))

    await bootOwner(owner, harness, CHAT_OBSERVER)
    await configureChats(owner.page)
    await bootReader(sender, harness, CHAT_OBSERVER)
    await claimFromUi(sender)
    const senderMutationAuditStart = sender.records.length
    const serverStatuses = new Map<Request, number>()
    const completionExecutions: Array<{
      request: Request
      status: number
      headers: Record<string, string>
      body: Record<string, unknown>
      response: Record<string, unknown>
    }> = []
    let lostCommit:
      | {
          request: Request
          status: number
          headers: Record<string, string>
          body: Record<string, unknown>
          response: Record<string, unknown>
        }
      | undefined
    let lostReceipt:
      | {
          request: Request
          status: number
          headers: Record<string, string>
          body: Record<string, unknown>
          response: Record<string, unknown>
        }
      | undefined
    let resolveLostCommit!: () => void
    let resolveLostReceipt!: () => void
    const commitReached = new Promise<void>((resolve) => {
      resolveLostCommit = resolve
    })
    const receiptReached = new Promise<void>((resolve) => {
      resolveLostReceipt = resolve
    })
    let commitTransports = 0
    let receiptTransports = 0
    let resolveHeldIgpClaim!: () => void
    let releaseHeldIgpClaim!: () => void
    const igpClaimIntercepted = new Promise<void>((resolve) => {
      resolveHeldIgpClaim = resolve
    })
    const heldIgpClaimRelease = new Promise<void>((resolve) => {
      releaseHeldIgpClaim = resolve
    })
    const holdProductionIgpClaim = async (route: Route) => {
      resolveHeldIgpClaim()
      await heldIgpClaimRelease
      await route.continue()
    }
    const observeProductionCompletion = async (route: Route) => {
      const request = route.request()
      const response = await route.fetch()
      const body = (await response.json()) as Record<string, unknown>
      completionExecutions.push({
        request,
        status: response.status(),
        headers: request.headers(),
        body: request.postDataJSON() as Record<string, unknown>,
        response: body,
      })
      await route.fulfill({ response })
    }
    const loseProductionCommitResponse = async (route: Route) => {
      commitTransports += 1
      if (commitTransports > 1) return route.continue()
      const request = route.request()
      const response = await route.fetch()
      lostCommit = {
        request,
        status: response.status(),
        headers: request.headers(),
        body: request.postDataJSON() as Record<string, unknown>,
        response: (await response.json()) as Record<string, unknown>,
      }
      serverStatuses.set(request, response.status())
      resolveLostCommit()
      await route.abort('connectionclosed')
    }
    const loseProductionReceiptResponse = async (route: Route) => {
      receiptTransports += 1
      if (receiptTransports > 1) return route.continue()
      const request = route.request()
      const response = await route.fetch()
      lostReceipt = {
        request,
        status: response.status(),
        headers: request.headers(),
        body: request.postDataJSON() as Record<string, unknown>,
        response: (await response.json()) as Record<string, unknown>,
      }
      serverStatuses.set(request, response.status())
      resolveLostReceipt()
      await route.abort('connectionclosed')
    }
    await sender.context.route('**/api/v1/generation-effects/*/igp/completion', observeProductionCompletion)
    await sender.context.route('**/api/v1/generation-effects/*/igp/commit', loseProductionCommitResponse)
    await sender.context.route('**/api/v1/generation-effects/*/igp/receipt', loseProductionReceiptResponse)
    await sender.context.route('**/api/v1/generation-effects/*/igp/claims', holdProductionIgpClaim)

    await sendFromUi(sender, 'Run configured IGP.')
    await igpClaimIntercepted
    await expect.poll(() => provider.calls(CHAT_OBSERVER)).toBe(1)
    await expect
      .poll(() => {
        const truth = readTruth(harness.dataDir)
        const operation = truth.operations.find((candidate) => candidate.chat_id === CHAT_OBSERVER)
        return truth.effects.find(
          (candidate) =>
            candidate.operation_id === operation?.operation_id && candidate.effect_kind === 'generated_translation',
        )?.status
      })
      .toBe('completed')
    const acceptedBeforeSettingsMutation = readTruth(harness.dataDir)
    const acceptedOperation = acceptedBeforeSettingsMutation.operations.find(
      (candidate) => candidate.chat_id === CHAT_OBSERVER,
    )!
    expect(acceptedOperation).toMatchObject({
      state: 'completed',
      admission_kind: 'chat_only',
      occupancy_session_id: sender.sessionId,
      occupancy_epoch: 1,
      occupancy_claim_class: 'chat_only',
      accepted_message_id: expect.any(String),
      result_message_id: expect.any(String),
    })
    expect(
      chatMessages(acceptedBeforeSettingsMutation, CHAT_OBSERVER).map(({ role, data, uid }) => ({
        role,
        data,
        uid,
      })),
    ).toEqual([
      { role: 'char', data: `Seed for ${CHAT_OBSERVER}.`, uid: `seed-${CHAT_OBSERVER}` },
      { role: 'char', data: ACCEPTED_IGP_INPUT_ROW, uid: expect.any(String) },
      { role: 'user', data: 'Run configured IGP.', uid: acceptedOperation.accepted_message_id },
      { role: 'char', data: 'Configured IGP source.', uid: acceptedOperation.result_message_id },
    ])
    const translatedResultBeforeIgp = acceptedBeforeSettingsMutation.messages.find(
      (message) => message.uid === acceptedOperation.result_message_id,
    )!
    const translatedResultJson = JSON.parse(translatedResultBeforeIgp.json) as Record<string, unknown>
    expect(translatedResultJson.translation).toEqual({
      source: 'raw',
      text: ACCEPTED_TRANSLATION,
      sourceHash: createHash('sha256').update('Configured IGP source.').digest('hex'),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      updatedAt: expect.any(Number),
    })
    const translatedEffectBeforeIgp = acceptedBeforeSettingsMutation.effects.find(
      (candidate) =>
        candidate.operation_id === acceptedOperation.operation_id && candidate.effect_kind === 'generated_translation',
    )!
    expect(translatedEffectBeforeIgp).toEqual({
      operation_id: acceptedOperation.operation_id,
      generation_id: expect.any(String),
      chat_id: CHAT_OBSERVER,
      message_id: acceptedOperation.result_message_id,
      effect_kind: 'generated_translation',
      effect_class: 'durable',
      status: 'completed',
      claim_id: expect.any(String),
      delivery: 'server',
      reason: null,
    })
    expect(completionExecutions).toEqual([])

    await patchOwnerSettings(owner.page, 'providers', {
      providerCredentials: [],
      modelProfiles: [],
      modelProfileOrder: [],
      modelRoleProfiles: {},
    })
    await expect
      .poll(() => {
        const settings = readCurrentSettings(harness.dataDir)
        return {
          igpPrompt: settings.igpPrompt,
          providerCredentials: settings.providerCredentials,
          modelProfiles: settings.modelProfiles,
          modelProfileOrder: settings.modelProfileOrder,
          modelRoleProfiles: settings.modelRoleProfiles,
        }
      })
      .toEqual({
        igpPrompt: ACCEPTED_IGP_PROMPT,
        providerCredentials: [],
        modelProfiles: [],
        modelProfileOrder: [],
        modelRoleProfiles: CLEARED_MODEL_ROLE_PROFILES,
      })
    const settingsAfterMutation = readCurrentSettings(harness.dataDir)
    const sharedAfterOwnerMutation = readSharedMutationBoundary(harness.dataDir)
    expect(completionExecutions).toEqual([])

    releaseHeldIgpClaim()
    await expect.poll(() => completionExecutions.length, { timeout: 30_000 }).toBe(1)
    await expect.poll(() => commitTransports, { timeout: 30_000 }).toBe(1)
    await expect.poll(() => receiptTransports, { timeout: 30_000 }).toBe(1)
    await Promise.all([commitReached, receiptReached])
    await expectCompleted(harness.dataDir, CHAT_OBSERVER)
    expect(provider.calls(CHAT_OBSERVER)).toBe(1)
    const completed = readTruth(harness.dataDir)
    const operation = completed.operations.find((candidate) => candidate.chat_id === CHAT_OBSERVER)!
    const result = completed.messages.find((message) => message.uid === operation.result_message_id)!
    const igp = completed.effects.find(
      (candidate) => candidate.operation_id === operation.operation_id && candidate.effect_kind === 'igp',
    )!
    expect(igp).toMatchObject({
      generation_id: expect.any(String),
      message_id: result.uid,
      status: 'completed',
      claim_id: expect.any(String),
      reason: null,
    })
    const generationId = String(igp.generation_id)
    const claimId = String(igp.claim_id)
    const committedData = `Configured IGP source.${ACCEPTED_IGP_SUFFIX}`
    expect(igpProvider.requests).toHaveLength(4)
    const translationProviderRequests = igpProvider.requests.filter(
      (request) => request.body.model === ACCEPTED_TRANSLATION_MODEL,
    )
    const igpProviderRequests = igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)
    // The connected owner auto-translates ordinary newly exposed rows, while
    // the generated result remains owned by the durable server effect above.
    expect(translationProviderRequests).toHaveLength(3)
    expect(
      translationProviderRequests
        .map(({ method, path, authorization, body }) => ({
          method,
          path,
          authorization,
          model: body.model,
          stream: body.stream,
          messages: body.messages,
        }))
        .sort((left, right) => JSON.stringify(left.messages).localeCompare(JSON.stringify(right.messages))),
    ).toEqual([
      {
        method: 'POST',
        path: '/v1/chat/completions',
        authorization: `Bearer ${ACCEPTED_IGP_CREDENTIAL}`,
        model: ACCEPTED_TRANSLATION_MODEL,
        stream: false,
        messages: [{ role: 'system', content: 'Translate Configured IGP source.' }],
      },
      {
        method: 'POST',
        path: '/v1/chat/completions',
        authorization: `Bearer ${ACCEPTED_IGP_CREDENTIAL}`,
        model: ACCEPTED_TRANSLATION_MODEL,
        stream: false,
        messages: [{ role: 'system', content: `Translate ${ACCEPTED_IGP_INPUT_ROW}` }],
      },
      {
        method: 'POST',
        path: '/v1/chat/completions',
        authorization: `Bearer ${ACCEPTED_IGP_CREDENTIAL}`,
        model: ACCEPTED_TRANSLATION_MODEL,
        stream: false,
        messages: [{ role: 'system', content: 'Translate Run configured IGP.' }],
      },
    ])
    expect(igpProviderRequests).toHaveLength(1)
    expect(igpProviderRequests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/chat/completions',
      authorization: `Bearer ${ACCEPTED_IGP_CREDENTIAL}`,
      body: {
        model: ACCEPTED_IGP_MODEL,
        stream: false,
        messages: [
          {
            role: 'system',
            content: 'Last=Configured IGP source.; Char=Configured IGP source.; Index=3',
          },
        ],
      },
    })
    expect(JSON.stringify(igpProviderRequests[0].body)).not.toContain('Run configured IGP.')
    expect(JSON.stringify(igpProviderRequests[0].body)).not.toContain(`Seed for ${CHAT_OBSERVER}.`)
    expect(JSON.stringify(igpProviderRequests[0].body)).not.toContain(ACCEPTED_IGP_INPUT_ROW)
    expect(JSON.stringify(igpProviderRequests[0].body)).not.toContain(ACCEPTED_TRANSLATION)
    expect(completionExecutions).toHaveLength(1)
    expect(completionExecutions[0]).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': sender.sessionId,
        'risu-database-lineage': completed.ownership.lineage,
      },
      body: { claimId },
      response: { type: 'success', result: ACCEPTED_IGP_SUFFIX },
    })
    expect(lostCommit).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': sender.sessionId,
        'risu-database-lineage': completed.ownership.lineage,
      },
      body: {
        baseRevision: expect.any(Number),
        claimId,
        data: committedData,
        expectedData: 'Configured IGP source.',
        expectedGenerationId: generationId,
      },
      response: {
        revision: expect.any(Number),
        chatId: CHAT_OBSERVER,
        messageId: result.uid,
        effect: { status: 'completed', claimId },
      },
    })
    expect(lostReceipt).toMatchObject({
      status: 200,
      headers: {
        'risu-writer-session': sender.sessionId,
        'risu-database-lineage': completed.ownership.lineage,
      },
      body: { claimId, status: 'completed' },
      response: { effect: { status: 'completed', claimId } },
    })
    expect(result.data).toBe(committedData)
    expect((JSON.parse(result.json) as Record<string, unknown>).translation).toBeNull()
    expect(readTruth(harness.dataDir).effects.filter((candidate) => candidate.generation_id === generationId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ effect_kind: 'igp', status: 'completed', claim_id: claimId }),
        expect.objectContaining({
          effect_kind: 'plugin_output',
          status: 'skipped',
          reason: 'unsupported_chat_only_scope',
        }),
        expect.objectContaining({
          effect_kind: 'emotion_image_state',
          status: 'skipped',
          reason: 'unsupported_chat_only_scope',
        }),
      ]),
    )

    const newerDraft = 'IGP recovery must not replace this newer draft.'
    await expect(sender.page.locator('[data-reader-composer-field="message"]')).toBeEnabled()
    await sender.page.locator('[data-reader-composer-field="message"]').fill(newerDraft)
    await Promise.all([
      sender.context.unroute('**/api/v1/generation-effects/*/igp/completion', observeProductionCompletion),
      sender.context.unroute('**/api/v1/generation-effects/*/igp/commit', loseProductionCommitResponse),
      sender.context.unroute('**/api/v1/generation-effects/*/igp/receipt', loseProductionReceiptResponse),
      sender.context.unroute('**/api/v1/generation-effects/*/igp/claims', holdProductionIgpClaim),
    ])
    await sender.page.reload({ waitUntil: 'domcontentloaded' })
    await waitForHook(sender.page)
    await expect(sender.page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', CHAT_OBSERVER)
    await expectOccupancyState(sender.page, 'self-owned')
    await expect(sender.page.locator('[data-reader-composer-field="message"]')).toHaveValue(newerDraft)
    await expect(
      sender.page.locator(`.risu-chat[data-risu-message-id="${result.uid}"] .chat-message-body`),
    ).toContainText(committedData)
    await expect
      .poll(() =>
        readTruth(harness.dataDir)
          .effects.filter((candidate) => candidate.operation_id === operation.operation_id)
          .every((candidate) => ['completed', 'skipped', 'failed'].includes(candidate.status)),
      )
      .toBe(true)
    expect(completionExecutions).toHaveLength(1)
    expect(commitTransports).toBe(1)
    expect(receiptTransports).toBe(1)
    expect(provider.calls(CHAT_OBSERVER)).toBe(1)
    expect(igpProvider.requests).toHaveLength(4)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_TRANSLATION_MODEL)).toHaveLength(3)
    expect(igpProvider.requests.filter((request) => request.body.model === ACCEPTED_IGP_MODEL)).toHaveLength(1)
    const settingsAfterReload = readCurrentSettings(harness.dataDir)
    expect({
      igpPrompt: settingsAfterReload.igpPrompt,
      providerCredentials: settingsAfterReload.providerCredentials,
      modelProfiles: settingsAfterReload.modelProfiles,
      modelProfileOrder: settingsAfterReload.modelProfileOrder,
      modelRoleProfiles: settingsAfterReload.modelRoleProfiles,
    }).toEqual({
      igpPrompt: ACCEPTED_IGP_PROMPT,
      providerCredentials: [],
      modelProfiles: [],
      modelProfileOrder: [],
      modelRoleProfiles: CLEARED_MODEL_ROLE_PROFILES,
    })
    expect(readSharedMutationBoundary(harness.dataDir)).toEqual(sharedAfterOwnerMutation)

    const terminalTruth = readTruth(harness.dataDir)
    const automaticTranslationConflicts = clients
      .flatMap((client) => client.records)
      .filter(
        (record) =>
          record.path === `/api/v1/commands/messages/${acceptedOperation.result_message_id}/translate` &&
          record.body?.automatic === true,
      )
      .map((record) => ({ automatic: record.body?.automatic, status: record.status }))
    // A client that observes the raw row before the server translation settles
    // may race one automatic request, which must be rejected. If the server-
    // authored translation hydrates first, the client suppresses that request.
    expect(automaticTranslationConflicts.length).toBeLessThanOrEqual(1)
    expect(automaticTranslationConflicts.every((record) => record.automatic === true && record.status === 409)).toBe(
      true,
    )
    const auditedRecords = sender.records.slice(senderMutationAuditStart).map((record) => {
      const serverStatus = serverStatuses.get(record.request)
      return serverStatus === undefined ? record : { ...record, status: serverStatus }
    })
    const senderMutationAudit = auditChatOnlyMutations({ ...sender, records: auditedRecords }, terminalTruth, [
      CHAT_OBSERVER,
    ])
    expect(senderMutationAudit.violations).toEqual([])
    expect(
      senderMutationAudit.authorizedEffects.filter(
        (effect) => effect.generationId === generationId && effect.effectKind === 'igp',
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'claims', operationId: operation.operation_id, messageId: result.uid }),
        expect.objectContaining({ action: 'completion', operationId: operation.operation_id, messageId: result.uid }),
        expect.objectContaining({ action: 'commit', operationId: operation.operation_id, messageId: result.uid }),
        expect.objectContaining({ action: 'receipt', operationId: operation.operation_id, messageId: result.uid }),
      ]),
    )
    const occupancy = readTruth(harness.dataDir).occupancy.find(
      (candidate) => (candidate as Record<string, unknown>).chat_id === CHAT_OBSERVER,
    ) as Record<string, unknown>
    const released = await directTupleMutation(sender.page, {
      chatId: CHAT_OBSERVER,
      databaseLineage: completed.ownership.lineage,
      sessionId: sender.sessionId,
      occupancyEpoch: Number(occupancy.occupancy_epoch),
      action: 'release',
    })
    expect(released).toMatchObject({ status: 200, body: { state: 'released' } })
    expect(provider.calls(CHAT_OBSERVER)).toBe(1)
    expect(pageErrors).toEqual([])

    const evidencePath = testInfo.outputPath('chat-occupancy-configured-igp.json')
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          sessions: clients.map(({ name, sessionId }) => ({ name, sessionId })),
          acceptedBeforeSettingsMutation,
          settingsAfterMutation: {
            igpPrompt: settingsAfterMutation.igpPrompt,
            providerCredentials: settingsAfterMutation.providerCredentials,
            modelProfiles: settingsAfterMutation.modelProfiles,
            modelProfileOrder: settingsAfterMutation.modelProfileOrder,
            modelRoleProfiles: settingsAfterMutation.modelRoleProfiles,
          },
          igpProviderRequests: igpProvider.requests,
          operation,
          completionExecutions: completionExecutions.map(({ request: _request, ...execution }) => execution),
          lostCommit: lostCommit ? { ...lostCommit, request: undefined } : undefined,
          lostReceipt: lostReceipt ? { ...lostReceipt, request: undefined } : undefined,
          transportCounts: { commit: commitTransports, receipt: receiptTransports },
          committedData,
          newerDraft,
          automaticTranslationConflicts,
          mutationAudit: senderMutationAudit,
          released,
          providerCalls: provider.calls(CHAT_OBSERVER),
          truth: terminalTruth,
          pageErrors,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('chat-occupancy-configured-igp', {
      path: evidencePath,
      contentType: 'application/json',
    })
  } finally {
    provider.releaseAll()
    for (const client of clients) await client.context.close().catch(() => undefined)
    await closeFastBootstrapHarness(harness)
    await igpProvider.close()
  }
})

test('T10: a real Fastify restart terminalizes expired accepted work without resubmission and lineage fences old tuples', async ({
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
