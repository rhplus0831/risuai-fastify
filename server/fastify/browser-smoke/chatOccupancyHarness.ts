import { expect, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildApp } from '../src/app.js'
import type { ChatProviderDispatchContext, ChatProviderDispatcher } from '../src/routes/generationChat.js'
import {
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
  type FastBootstrapHarness,
} from './fastBootstrapHarness.js'

// Shared fixtures and fault barriers; each journey owns its server and browser contexts.
export const CHARACTER = 'occupancy-interaction-character'

export const CHAT_OWNER = 'occupancy-owner-chat'

export const CHAT_READER = 'occupancy-reader-chat'

export const CHAT_READER_TWO = 'occupancy-reader-two-chat'

export const CHAT_STOP = 'occupancy-stop-chat'

export const CHAT_OBSERVER = 'occupancy-observer-chat'

export const CHAT_CONFLICT = 'occupancy-conflict-chat'

export const ALL_CHATS = [CHAT_OWNER, CHAT_READER, CHAT_READER_TWO, CHAT_STOP, CHAT_OBSERVER, CHAT_CONFLICT] as const

export const SESSION_KEY = 'risu:active-writer-session-id'

export const STATIC_LAST_INTERACTION = 1_234

export const ACCEPTED_IGP_PROMPT =
  '<|im_start|>system<|im_sep|>Last={{lastmessage}}; Char={{lastcharmessage}}; Index={{lastmessageid}}<|im_end|>'

export const ACCEPTED_IGP_SUFFIX = ' [accepted IGP snapshot]'

export const ACCEPTED_IGP_INPUT_ROW = 'INPUT-LUA-ROW'

export const ACCEPTED_IGP_MODEL = 'accepted-igp-model'

export const ACCEPTED_IGP_CREDENTIAL = 'accepted-igp-key'

export const ACCEPTED_TRANSLATION_MODEL = 'accepted-translation-model'

export const ACCEPTED_TRANSLATION = 'Translated configured IGP source.'

export const CLEARED_MODEL_ROLE_PROFILES = {
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

export class OccupancyProvider {
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

export async function startIgpProvider(options: { translationGate?: Promise<void> } = {}) {
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

export async function startHeldImageProvider(responseStatus = 200) {
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

export async function startSequentialImageProvider() {
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

export interface Client {
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

export function route(chatId: string): string {
  return `/character/${CHARACTER}/${chatId}`
}

export function fixture(): Record<string, unknown> {
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

export function readTruth(dataDir: string) {
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

export function readSharedMutationBoundary(dataDir: string) {
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

export function readCurrentSettings(dataDir: string): Record<string, unknown> {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
    return JSON.parse(row.data_json) as Record<string, unknown>
  } finally {
    db.close()
  }
}

export function readInlayPreparation(dataDir: string, operationId: string) {
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

export async function startHarness(
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

export async function restartHarness(
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

export async function createClient(
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

export async function waitForHook(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__RISU_FASTIFY_BROWSER_SMOKE__)), { timeout: 30_000 })
    .toBe(true)
}

export async function bootOwner(client: Client, harness: FastBootstrapHarness, chatId: string): Promise<void> {
  await client.page.goto(`${harness.baseUrl}${route(chatId)}`, { waitUntil: 'domcontentloaded' })
  await waitForHook(client.page)
  await client.page.evaluate(() =>
    window.__RISU_FASTIFY_BROWSER_SMOKE__!.waitForStartupMilestone('background-ready', 30_000),
  )
  await expect(client.page.getByTestId('default-chat-composer')).toBeVisible({ timeout: 30_000 })
  client.sessionId = await client.page.evaluate((key) => sessionStorage.getItem(key) ?? '', SESSION_KEY)
  expect(client.sessionId).toMatch(/\S/u)
}

export async function bootReader(client: Client, harness: FastBootstrapHarness, chatId: string): Promise<void> {
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

export async function configureChats(page: Page): Promise<void> {
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

export async function directClaim(page: Page, chatId: string, claimClass: 'owner' | 'chat_only', epoch = 0) {
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

export async function directOccupancySnapshot(page: Page) {
  return page.evaluate(async () => {
    const headers = await window.__RISU_FASTIFY_BROWSER_SMOKE__!.activeWriterHeaders()
    const response = await fetch('/api/v1/chat-occupancies', { headers })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  })
}

export async function directTupleMutation(
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

export async function destructiveImport(page: Page, database: Record<string, unknown>) {
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

export async function chatOccupancyOutboxRows(page: Page): Promise<Array<Record<string, unknown>>> {
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

export async function appendOwnerMessage(page: Page, chatId: string, messageId: string, data: string): Promise<number> {
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

export async function patchOwnerSettings(
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

export async function setRetainedReaderDraft(page: Page, draft: string): Promise<void> {
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

export async function rejectForeignMutationControls(client: Client, operation: OperationRow) {
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

export async function expectOccupancyState(page: Page, state: string): Promise<void> {
  await expect(page.locator('[data-reader-chat-occupancy]')).toHaveAttribute(
    'data-reader-chat-occupancy-state',
    state,
    {
      timeout: 30_000,
    },
  )
}

export async function promoteViaUi(
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

export function stableOccupancyTuples(dataDir: string) {
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

export async function claimFromUi(client: Client): Promise<void> {
  await expectOccupancyState(client.page, 'available')
  await client.page.locator('[data-reader-occupancy-claim]').click()
  await expectOccupancyState(client.page, 'self-owned')
  await expect(client.page.locator('[data-reader-composer-field="message"]')).toBeEnabled()
  await expect(client.page.locator('[data-reader-composer-send]')).toBeDisabled()
}

export async function sendFromUi(client: Client, text: string, owner = false): Promise<void> {
  const composer = owner
    ? client.page.getByTestId('default-chat-composer')
    : client.page.locator('[data-reader-composer-field="message"]')
  const send = owner
    ? client.page.getByTestId('default-chat-send-button')
    : client.page.locator('[data-reader-composer-send]')
  await composer.fill(text)
  await send.click()
}

export async function continueFromOwnerUi(client: Client, chatId: string, occurrence = 1): Promise<ApiRecord> {
  const send = client.page.getByTestId('default-chat-send-button')
  await expect(send).toBeVisible({ timeout: 30_000 })
  await expect(send).toBeEnabled({ timeout: 30_000 })
  await client.page.getByTestId('default-chat-menu-button').click()
  await client.page.getByRole('menuitem', { name: 'Continue Response', exact: true }).click()
  return expectSubmitAuthority(client, chatId, 'continue', occurrence, 30_000)
}

export async function expectOwnerGenerationRecoverySettled(
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

export async function openReaderChat(page: Page, name: string, chatId: string): Promise<void> {
  const toggle = page.locator('[data-reader-navigation-toggle]')
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
  const back = page.locator('[data-reader-go-back]')
  if (await back.isVisible()) await back.click()
  await page.getByRole('button', { name: `Open chat ${name}`, exact: true }).click()
  await expect(page.locator('[data-reader-transcript]')).toHaveAttribute('data-reader-chat-id', chatId)
  await expect(page).toHaveURL(new RegExp(`${route(chatId)}$`))
}

export function chatMessages(truth: ReturnType<typeof readTruth>, chatId: string): MessageRow[] {
  return truth.messages.filter((message) => message.chat_id === chatId && message.alternate === 0)
}

export function alternateChatMessages(truth: ReturnType<typeof readTruth>, chatId: string): MessageRow[] {
  return truth.messages.filter((message) => message.chat_id === chatId && message.alternate === 1)
}

export async function expectCompleted(dataDir: string, chatId: string, count = 1): Promise<OperationRow[]> {
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

export async function expectSubmitAuthority(
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

export function auditChatOnlyMutations(
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
