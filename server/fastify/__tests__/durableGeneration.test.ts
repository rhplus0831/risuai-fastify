import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { DatabaseSync } from 'node:sqlite'
import { buildApp } from '../src/app.js'
import { createCommandEventSink, type CommandEventSink } from '../src/commands/events.js'
import { bumpRevision, getSchemaState, openDatabase } from '../src/db.js'
import { MessageTranslationJobRegistry } from '../src/messageTranslationJobs.js'
import type { CompletionStreamFrame } from '../src/generation/frames.js'
import {
  GENERATION_FINALIZATION_RETRY_MAX_DELAY_MS,
  enqueueGenerationFinalizationRetry,
  markGenerationFinalizationRetryFailure,
} from '../src/generationFinalizationRetry.js'
import {
  retryQueuedGenerationFinalizations,
  type ChatProviderDispatcher,
  type GenerationChatRouteOptions,
} from '../src/routes/generationChat.js'
import { setupAuthedClient } from './helpers/auth.js'
import { readResourceDatabaseFromFetch, type RuntimeBootstrap } from './helpers/resourceDatabase.js'
import { createExtractedModelPreset, createExtractedPromptPreset } from '@risuai/shared-core/preset-split'

// Durable generation lives on a detached job whose lifecycle is not tied to the
// request connection, so these use a real listening server + `fetch`. `app.inject`
// buffers the whole response and cannot model a mid-stream disconnect / reattach.

interface Harness {
  app: FastifyInstance
  dataDir: string
  baseUrl: string
}

type JsonRecord = Record<string, unknown>

// The injected provider is swapped per test through this stable indirection, so the
// app is built once per test with a provider that delegates to the current impl.
let providerImpl: ChatProviderDispatcher = () => {
  async function* g(): AsyncGenerator<CompletionStreamFrame> {
    yield { kind: 'done', finishReason: 'stop' }
  }
  return g()
}
let failNextGenerationPersistEvent = false
let durableLifecycleHook: GenerationChatRouteOptions['onDurableLifecycleTransition']

const DURABLE_PERSONA_ID = 'durable-persona'
const DURABLE_MODEL_PRESET_ID = 'durable-model-preset'
const DURABLE_PROMPT_PRESET_ID = 'durable-prompt-preset'
const durablePromptSettings = {
  assistantPrefill: '',
  postEndInnerFormat: '',
  sendChatAsSystem: false,
  sendName: false,
  utilOverride: false,
}

const openControllers = new Set<AbortController>()

function newController(): AbortController {
  const controller = new AbortController()
  openControllers.add(controller)
  return controller
}

async function startHarness(
  generationChatOverrides: Record<string, unknown> = {},
  existingDataDir?: string,
): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = existingDataDir ?? mkdtempSync(path.join(tmpdir(), 'risu-durable-'))
  const commandEvents = createRetryTestCommandSink()
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    generationChat: {
      dispatchProvider: (ctx) => providerImpl(ctx),
      finalizationRetry: { intervalMs: 10, baseDelayMs: 10, maxDelayMs: 40 },
      onDurableLifecycleTransition: (transition, job) => durableLifecycleHook?.(transition, job),
      ...generationChatOverrides,
    },
    commandEvents,
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address() as AddressInfo
  return { app, dataDir, baseUrl: `http://127.0.0.1:${addr.port}` }
}

function createRetryTestCommandSink(): CommandEventSink {
  const inner = createCommandEventSink()
  return {
    emit(event) {
      if (event.type === 'generation.persisted' && failNextGenerationPersistEvent) {
        failNextGenerationPersistEvent = false
        throw new Error('transient generation event delivery failure')
      }
      inner.emit(event)
    },
    list: () => inner.list(),
    clear: () => inner.clear(),
    subscribe: (listener) => inner.subscribe(listener),
  }
}

function durableGenerationSettings(): Record<string, unknown> {
  return {
    configured: true,
    personaId: DURABLE_PERSONA_ID,
    modelPresetId: DURABLE_MODEL_PRESET_ID,
    promptPresetId: DURABLE_PROMPT_PRESET_ID,
    jailbreakToggle: false,
    sidebarToggles: {},
  }
}

function durableChat(messages: Array<Record<string, unknown>> = []): Record<string, unknown> {
  return {
    id: 'chat-1',
    message: messages,
    note: '',
    name: 'Chat',
    localLore: [],
    generationSettings: durableGenerationSettings(),
  }
}

const fixtureDatabase = {
  currentChar: 0,
  characters: [
    {
      type: 'character',
      name: 'Tess',
      chaId: 'char-1',
      utilityBot: false,
      chatPage: 0,
      desc: 'DESC',
      firstMessage: 'Greetings.',
      chats: [durableChat()],
    },
  ],
  selectedPersona: 0,
  personas: [
    {
      id: DURABLE_PERSONA_ID,
      name: 'Durable User',
      personaPrompt: 'durable persona prompt',
      icon: '',
      note: '',
    },
  ],
  modelPresetsId: 0,
  promptPresetsId: 0,
  botPresets: [],
  modelPresets: [
    {
      id: DURABLE_MODEL_PRESET_ID,
      name: 'Durable Model Preset',
      maxContext: 100_000,
      maxResponse: 50,
    },
  ],
  promptPresets: [
    {
      id: DURABLE_PROMPT_PRESET_ID,
      name: 'Durable Prompt Preset',
      mainPrompt: 'MAIN',
      formatingOrder: ['main', 'description', 'chats'],
      promptSettings: durablePromptSettings,
      customPromptTemplateToggle: '',
    },
  ],
  modules: [],
  enabledModules: [],
  formatingOrder: ['main', 'description', 'chats'],
  promptSettings: durablePromptSettings,
  mainPrompt: 'MAIN',
  maxContext: 100_000,
  maxResponse: 50,
}

let harness: Harness
let assertion: string

interface GenerationFinalizationRetryTestRow {
  generation_id: string
  chat_id: string
  status: string
  failure_count: number
  last_error: string | null
  terminal_error: string | null
}

beforeEach(async () => {
  failNextGenerationPersistEvent = false
  durableLifecycleHook = undefined
  providerImpl = () => {
    async function* g(): AsyncGenerator<CompletionStreamFrame> {
      yield { kind: 'done', finishReason: 'stop' }
    }
    return g()
  }
  harness = await startHarness()
  ;({ assertion } = await setupAuthedClient(harness.app))
  await seedDatabase(fixtureDatabase)
})

afterEach(async () => {
  durableLifecycleHook = undefined
  for (const controller of openControllers) controller.abort()
  openControllers.clear()
  harness.app.server.closeAllConnections()
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
})

async function seedDatabase(database: unknown): Promise<void> {
  await seedDatabaseForHarness(harness, assertion, database)
}

async function resetHarness(generationChatOverrides: Record<string, unknown> = {}): Promise<void> {
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
  harness = await startHarness(generationChatOverrides)
  ;({ assertion } = await setupAuthedClient(harness.app))
  await seedDatabase(fixtureDatabase)
}

async function restartHarness(generationChatOverrides: Record<string, unknown> = {}): Promise<void> {
  const dataDir = harness.dataDir
  await harness.app.close()
  harness = await startHarness(generationChatOverrides, dataDir)
}

async function seedDatabaseForHarness(target: Harness, targetAssertion: string, database: unknown): Promise<number> {
  const res = await fetch(`${target.baseUrl}/api/v1/import/risusave`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'risu-auth': targetAssertion },
    body: JSON.stringify({ database }),
  })
  expect(res.status).toBe(200)
  const imported = (await res.json()) as { revision: number }
  return configureImportedCurrentChatGenerationSettings(target, targetAssertion, database, imported.revision)
}

async function configureImportedCurrentChatGenerationSettings(
  target: Harness,
  targetAssertion: string,
  database: unknown,
  baseRevision: number,
): Promise<number> {
  const chatSettings = activeChatGenerationSettings(database)
  if (!chatSettings) return baseRevision

  const res = await fetch(
    `${target.baseUrl}/api/v1/commands/chats/${encodeURIComponent(chatSettings.chatId)}/generation-settings`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'risu-auth': targetAssertion },
      body: JSON.stringify({
        baseRevision,
        generationSettings: {
          ...chatSettings.generationSettings,
          configured: true,
        },
      }),
    },
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { revision: number }).revision
}

function activeChatGenerationSettings(database: unknown): { chatId: string; generationSettings: JsonRecord } | null {
  if (!isJsonRecord(database)) return null
  const characters = Array.isArray(database.characters) ? database.characters : []
  const currentCharIndex = Number.isInteger(database.currentChar as number) ? (database.currentChar as number) : 0
  const character = findRecordAt(characters, currentCharIndex) ?? findRecordAt(characters, 0)
  if (!character) return null

  const chats = Array.isArray(character.chats) ? character.chats : []
  const chatPage = Number.isInteger(character.chatPage as number) ? (character.chatPage as number) : 0
  const chat = findRecordAt(chats, chatPage) ?? findRecordAt(chats, 0)
  if (!chat || typeof chat.id !== 'string') return null
  const generationSettings = chat.generationSettings
  if (!isJsonRecord(generationSettings)) return null
  if (!generationSettingReferencesExist(database, generationSettings)) return null

  return {
    chatId: chat.id,
    generationSettings,
  }
}

function generationSettingReferencesExist(database: JsonRecord, settings: JsonRecord): boolean {
  return (
    typeof settings.personaId === 'string' &&
    collectionHasId(database.personas, settings.personaId) &&
    typeof settings.modelPresetId === 'string' &&
    collectionHasId(database.modelPresets, settings.modelPresetId) &&
    typeof settings.promptPresetId === 'string' &&
    collectionHasId(database.promptPresets, settings.promptPresetId)
  )
}

function collectionHasId(collection: unknown, id: string): boolean {
  return Array.isArray(collection) && collection.some((row) => isJsonRecord(row) && row.id === id)
}

function findRecordAt(collection: unknown[], index: number): JsonRecord | null {
  const value = collection[index]
  return isJsonRecord(value) ? value : null
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'risu-auth': assertion, ...extra }
}

interface ParsedEvent {
  type: string
  data: Record<string, unknown>
}

function parseSseBlock(block: string): ParsedEvent | null {
  const trimmed = block.replace(/\r/g, '')
  if (trimmed.trim().length === 0) return null
  const [evLine, dataLine] = trimmed.split('\n')
  if (!evLine?.startsWith('event: ')) return null
  try {
    return {
      type: evLine.slice('event: '.length),
      data: JSON.parse((dataLine ?? 'data: {}').slice('data: '.length)) as Record<string, unknown>,
    }
  } catch {
    return null
  }
}

/**
 * Read SSE frames until `until` returns true (then return, leaving the connection
 * open for the caller to drop), or until the stream ends. Swallows the read error
 * a mid-stream abort raises.
 */
async function readSse(res: Response, until: (ev: ParsedEvent) => boolean): Promise<ParsedEvent[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: ParsedEvent[] = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const ev = parseSseBlock(block)
        if (ev) {
          events.push(ev)
          if (until(ev)) return events
        }
      }
    }
  } catch {
    // reader aborted / connection dropped
  } finally {
    // The caller owns connection lifetime, but the reader lock must not keep an
    // aborted or naturally completed fetch alive until garbage collection.
    reader.releaseLock()
  }
  return events
}

function postDurable(
  body: Record<string, unknown>,
  init: { signal?: AbortSignal; writerSession?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = authHeaders({ 'content-type': 'application/json' })
  if (init.writerSession) headers['risu-writer-session'] = init.writerSession
  return fetch(`${harness.baseUrl}/api/v1/generate/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      chatId: 'chat-1',
      characterId: 'char-1',
      mode: 'send',
      userMessage: 'hi',
      durable: true,
      ...body,
    }),
    signal: init.signal,
  })
}

interface OperationProtocolAuthority extends JsonRecord {
  revision: number
  databaseLineage: string
  generationOperationProjectionEpoch: number
  generationOperations: JsonRecord[]
  activeGenerationJobs: JsonRecord[]
  generationFinalizations?: JsonRecord[]
}

interface AtomicOperationResponse extends JsonRecord {
  operation: JsonRecord & {
    operationId: string
    state: string
    stateVersion: number
    projectionEpoch: number
    currentAttempt?: JsonRecord & { attemptNo: number; jobId: string }
  }
  append?: JsonRecord
  stream?: { href: string }
}

async function operationAuthority(writerSession = 'writer-a'): Promise<OperationProtocolAuthority> {
  const response = await fetch(`${harness.baseUrl}/api/v1/bootstrap`, {
    headers: authHeaders({ 'risu-writer-session': writerSession }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as OperationProtocolAuthority
}

function atomicSendRequest(args: {
  operationId: string
  acceptedMessageId: string
  baseRevision: number
  text?: string
}): JsonRecord {
  return {
    protocolVersion: 1,
    operationId: args.operationId,
    baseRevision: args.baseRevision,
    characterId: 'char-1',
    chatId: 'chat-1',
    mode: 'send',
    acceptedMessageId: args.acceptedMessageId,
    message: { role: 'user', data: args.text ?? 'atomic hello', chatId: args.acceptedMessageId },
    draftGeneration: 1,
    generation: {
      syntheticSayNothing: false,
      resetMessages: false,
      inlayAssetRefs: [],
      clientContext: {},
      clientCapabilities: {},
    },
  }
}

function atomicTargetedRequest(args: {
  operationId: string
  baseRevision: number
  mode: 'continue' | 'regenerate'
  targetMessageId: string
  clientCapabilities?: JsonRecord
}): JsonRecord {
  return {
    protocolVersion: 1,
    operationId: args.operationId,
    baseRevision: args.baseRevision,
    characterId: 'char-1',
    chatId: 'chat-1',
    mode: args.mode,
    targetMessageId: args.targetMessageId,
    draftGeneration: 1,
    generation: {
      syntheticSayNothing: false,
      resetMessages: false,
      inlayAssetRefs: [],
      clientContext: {},
      clientCapabilities: args.clientCapabilities ?? {},
    },
  }
}

function postAtomicOperation(databaseLineage: string, body: JsonRecord, writerSession = 'writer-a'): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/v1/generation-operations`, {
    method: 'POST',
    headers: authHeaders({
      'content-type': 'application/json',
      'risu-database-lineage': databaseLineage,
      'risu-writer-session': writerSession,
    }),
    body: JSON.stringify(body),
  })
}

async function operationStatus(operationId: string): Promise<AtomicOperationResponse> {
  const response = await fetch(`${harness.baseUrl}/api/v1/generation-operations/${encodeURIComponent(operationId)}`, {
    headers: authHeaders(),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as AtomicOperationResponse
}

/**
 * A provider that streams `before`, then blocks until either `release()` is called
 * (then streams `after` + done) or the job's signal aborts (then throws, like a real
 * provider whose fetch was aborted) — giving deterministic control over the
 * mid-stream window without timing races.
 */
function makeGatedProvider(opts: { before: string; after?: string }): {
  dispatchProvider: ChatProviderDispatcher
  release: () => void
} {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const dispatchProvider: ChatProviderDispatcher = (ctx) => {
    const signal = ctx.signal
    async function* gen(): AsyncGenerator<CompletionStreamFrame> {
      yield { kind: 'token', content: opts.before }
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'))
          return
        }
        const onAbort = (): void => reject(new Error('aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
        void gate.then(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        })
      })
      if (opts.after !== undefined) yield { kind: 'token', content: opts.after }
      yield { kind: 'done', finishReason: 'stop' }
    }
    return gen()
  }
  return { dispatchProvider, release }
}

function makeReplayCapProvider(tokens: readonly string[]): {
  dispatchProvider: ChatProviderDispatcher
  release: () => void
} {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const dispatchProvider: ChatProviderDispatcher = () => {
    async function* gen(): AsyncGenerator<CompletionStreamFrame> {
      await gate
      for (const content of tokens) yield { kind: 'token', content }
      yield { kind: 'done', finishReason: 'stop' }
    }
    return gen()
  }
  return { dispatchProvider, release }
}

async function bootstrap(): Promise<{
  activeGenerationJobs: Array<{
    chatId: string
    jobId: string
    mode?: 'send' | 'continue' | 'regenerate'
    continueDisposition?: 'append' | 'extend'
    regenerateMessageId?: string
  }>
  database: {
    characters: Array<{
      firstMessage?: string
      chats: Array<{
        message: Array<Record<string, unknown>>
        scriptstate?: Record<string, unknown>
        localLore?: Array<Record<string, unknown>>
      }>
    }>
  }
  revision: number
}> {
  const res = await fetch(`${harness.baseUrl}/api/v1/bootstrap`, { headers: authHeaders() })
  expect(res.status).toBe(200)
  const runtime = (await res.json()) as RuntimeBootstrap
  return {
    ...runtime,
    database: await readResourceDatabaseFromFetch(harness.baseUrl, authHeaders(), runtime),
  } as never
}

async function chatHydration(
  _boot: Awaited<ReturnType<typeof bootstrap>>,
  chatId = 'chat-1',
): Promise<{
  message: Array<Record<string, unknown>>
  alternates: Array<Record<string, unknown>>
}> {
  const res = await fetch(`${harness.baseUrl}/api/v1/chats/${encodeURIComponent(chatId)}/messages`, {
    headers: authHeaders(),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as {
    message: Array<Record<string, unknown>>
    alternates: Array<Record<string, unknown>>
  }
}

async function chatMessages(
  boot: Awaited<ReturnType<typeof bootstrap>>,
  chatId = 'chat-1',
): Promise<Array<Record<string, unknown>>> {
  return (await chatHydration(boot, chatId)).message
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function waitForAssistantMessage(): Promise<Record<string, unknown>> {
  return waitFor(async () => {
    const boot = await bootstrap()
    return (await chatMessages(boot)).find((m) => m.role === 'char')
  })
}

/** Re-seed the fixture chat with an explicit transcript (for continue / regenerate). */
async function seedChatWithMessages(
  messages: Array<Record<string, unknown>>,
  databaseOverrides: Record<string, unknown> = {},
): Promise<void> {
  await seedDatabase({
    ...fixtureDatabase,
    ...databaseOverrides,
    characters: [
      {
        ...fixtureDatabase.characters[0],
        chats: [durableChat(messages)],
      },
    ],
  })
}

async function configureChatForDurableGeneration(chatId: string): Promise<void> {
  const boot = await bootstrap()
  const res = await fetch(
    `${harness.baseUrl}/api/v1/commands/chats/${encodeURIComponent(chatId)}/generation-settings`,
    {
      method: 'PUT',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        baseRevision: boot.revision,
        generationSettings: durableGenerationSettings(),
      }),
    },
  )
  expect(res.status).toBe(200)
}

/** Cancel a running durable job over the DELETE route. */
async function cancelJob(jobId: string): Promise<void> {
  const del = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  expect(del.status).toBe(202)
  expect(await del.json()).toMatchObject({ disposition: 'cancelling', jobId })
}

function generationFinalizationRetryRows(): GenerationFinalizationRetryTestRow[] {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  try {
    return db
      .prepare(
        `
          SELECT generation_id, chat_id, status, failure_count, last_error, terminal_error
          FROM generation_finalization_retries
          ORDER BY generation_id ASC
        `,
      )
      .all() as unknown as GenerationFinalizationRetryTestRow[]
  } finally {
    db.close()
  }
}

function executeDatabase(sql: string): void {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

async function captureProtocolMetrics<T>(run: () => Promise<T>): Promise<{
  result: T
  metrics: Array<Record<string, unknown>>
}> {
  const previous = process.env.RISU_PROTOCOL_METRICS
  process.env.RISU_PROTOCOL_METRICS = '1'
  const metrics: Array<Record<string, unknown>> = []
  const infoSpy = vi.spyOn(console, 'info').mockImplementation((message: unknown) => {
    if (typeof message !== 'string' || !message.startsWith('[protocol-metric] ')) return
    metrics.push(JSON.parse(message.slice('[protocol-metric] '.length)) as Record<string, unknown>)
  })
  try {
    return { result: await run(), metrics }
  } finally {
    infoSpy.mockRestore()
    if (previous === undefined) {
      delete process.env.RISU_PROTOCOL_METRICS
    } else {
      process.env.RISU_PROTOCOL_METRICS = previous
    }
  }
}

function commandEventTypeCount(type: string): number {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM command_events WHERE type = ?').get(type) as
      | { count: number }
      | undefined
    return row?.count ?? 0
  } finally {
    db.close()
  }
}

function retryQueuedFinalizationsOnce(logger?: {
  warn(obj: Record<string, unknown>, msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}): ReturnType<typeof retryQueuedGenerationFinalizations> {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
  try {
    return retryQueuedGenerationFinalizations({
      db,
      dataDir: harness.dataDir,
      eventSink: createCommandEventSink(),
      logger,
      maxPerSweep: 10,
      now: new Date(Date.now() + GENERATION_FINALIZATION_RETRY_MAX_DELAY_MS + 1_000),
      messageTranslationJobs: new MessageTranslationJobRegistry(),
    })
  } finally {
    db.close()
  }
}

function jobIdFromEvents(events: ParsedEvent[]): string {
  const jobId = events.find((ev) => ev.type === 'job_accepted')?.data.jobId
  expect(typeof jobId).toBe('string')
  return jobId as string
}

async function waitForTerminalFinalization(generationId: string): Promise<GenerationFinalizationRetryTestRow> {
  return waitFor(async () => {
    const row = generationFinalizationRetryRows().find((retry) => retry.generation_id === generationId)
    return row?.status === 'terminal' ? row : undefined
  })
}

async function patchMessage(messageId: string, patch: Record<string, unknown>): Promise<void> {
  const boot = await bootstrap()
  const res = await fetch(`${harness.baseUrl}/api/v1/commands/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ baseRevision: boot.revision, patch }),
  })
  expect(res.status).toBe(200)
}

async function deleteMessage(messageId: string): Promise<void> {
  const boot = await bootstrap()
  const res = await fetch(`${harness.baseUrl}/api/v1/commands/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ baseRevision: boot.revision }),
  })
  expect(res.status).toBe(200)
}

async function patchChatScriptstate(patch: Record<string, string | number | boolean>): Promise<void> {
  const boot = await bootstrap()
  const res = await fetch(`${harness.baseUrl}/api/v1/commands/chats/chat-1/scriptstate`, {
    method: 'PATCH',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ baseRevision: boot.revision, patch }),
  })
  expect(res.status).toBe(200)
}

async function patchCharacterFirstMessage(firstMessage: string): Promise<void> {
  const boot = await bootstrap()
  const res = await fetch(`${harness.baseUrl}/api/v1/commands/characters/char-1`, {
    method: 'PATCH',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ baseRevision: boot.revision, patch: { firstMessage } }),
  })
  expect(res.status).toBe(200)
}

async function replaceChatLocalLore(entries: Array<Record<string, unknown>>): Promise<void> {
  const boot = await bootstrap()
  const res = await fetch(`${harness.baseUrl}/api/v1/commands/chats/chat-1/lorebooks`, {
    method: 'PUT',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ baseRevision: boot.revision, entries }),
  })
  expect(res.status).toBe(200)
}

async function appendMessage(message: Record<string, unknown>): Promise<void> {
  const boot = await bootstrap()
  const res = await fetch(`${harness.baseUrl}/api/v1/commands/chats/chat-1/messages`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ baseRevision: boot.revision, message }),
  })
  expect(res.status).toBe(200)
}

async function truncateChat(afterMessageId: string | null): Promise<void> {
  const boot = await bootstrap()
  const res = await fetch(`${harness.baseUrl}/api/v1/commands/chats/chat-1/messages/truncate`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ baseRevision: boot.revision, afterMessageId }),
  })
  expect(res.status).toBe(200)
}

function seedGenerationFinalizationRetryRow(
  db: DatabaseSync,
  generationId: string,
  status: 'pending' | 'terminal',
  updatedAt: string,
): void {
  enqueueGenerationFinalizationRetry(db, {
    generationId,
    chatId: 'chat-1',
    mode: 'send',
    message: {
      role: 'char',
      data: `message for ${generationId}`,
      chatId: generationId,
    } as never,
    chatVarMutations: [],
  })
  if (status === 'terminal') {
    markGenerationFinalizationRetryFailure(db, generationId, 'terminal fixture failure', true)
  }
  db.prepare('UPDATE generation_finalization_retries SET updated_at = ? WHERE generation_id = ?').run(
    updatedAt,
    generationId,
  )
}

describe('Durable generation', () => {
  it('accepts a targeted regenerate while the assistant remains authoritative through admission', async () => {
    await seedChatWithMessages([
      { role: 'user', data: 'greet me', chatId: 'msg-user-1' },
      { role: 'char', data: 'old reply', chatId: 'msg-char-1', saying: 'char-1' },
    ])
    providerImpl = () =>
      (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'a brand new reply' }
        yield { kind: 'done', finishReason: 'stop' }
      })()

    const authority = await operationAuthority()
    const operationId = randomUUID()
    const submitted = await postAtomicOperation(
      authority.databaseLineage,
      atomicTargetedRequest({
        operationId,
        baseRevision: authority.revision,
        mode: 'regenerate',
        targetMessageId: 'msg-char-1',
      }),
    )
    expect(submitted.status).toBe(201)
    expect(await submitted.json()).toMatchObject({
      operation: {
        operationId,
        mode: 'regenerate',
        targetMessageId: 'msg-char-1',
        state: 'owned_by_job',
      },
    })

    await waitFor(async () => {
      const status = await operationStatus(operationId)
      return status.operation.state === 'completed' ? status : undefined
    })
    const hydration = await chatHydration(await bootstrap())
    expect(hydration.message).toHaveLength(2)
    expect(hydration.message[0]).toMatchObject({ role: 'user', chatId: 'msg-user-1' })
    expect(hydration.message[1]).toMatchObject({ role: 'char', data: 'a brand new reply' })
    expect(hydration.message[1].chatId).not.toBe('msg-char-1')
    expect(hydration.alternates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'char', data: 'old reply', chatId: 'msg-char-1' }),
        expect.objectContaining({ role: 'char', data: 'a brand new reply' }),
      ]),
    )
  })

  it('keeps a negotiated regenerate target authoritative while streaming its in-place projection', async () => {
    await seedChatWithMessages([
      { role: 'user', data: 'greet me', chatId: 'msg-user-1' },
      { role: 'char', data: 'old reply', chatId: 'msg-char-1', saying: 'char-1' },
    ])
    const gated = makeGatedProvider({ before: 'projected', after: ' replacement' })
    providerImpl = gated.dispatchProvider

    const authority = await operationAuthority()
    const operationId = randomUUID()
    const submitted = await postAtomicOperation(
      authority.databaseLineage,
      atomicTargetedRequest({
        operationId,
        baseRevision: authority.revision,
        mode: 'regenerate',
        targetMessageId: 'msg-char-1',
        clientCapabilities: {
          compactPromptEvent: true,
          promptMetadataOnly: true,
          regenerateTargetProjection: 1,
        },
      }),
    )
    expect(submitted.status).toBe(201)
    const accepted = (await submitted.json()) as AtomicOperationResponse
    expect(accepted.stream?.href).toBeTypeOf('string')
    const currentOperation = await operationStatus(operationId)
    expect(currentOperation.operation.currentAttempt).toBeDefined()
    const currentAttempt = currentOperation.operation.currentAttempt!
    const currentStreamHref =
      `/api/v1/generation-operations/${encodeURIComponent(operationId)}/stream` +
      `?attemptNo=${currentAttempt.attemptNo}&jobId=${encodeURIComponent(currentAttempt.jobId)}` +
      `&projectionEpoch=${currentOperation.operation.projectionEpoch}`

    const stream = await fetch(`${harness.baseUrl}${currentStreamHref}`, {
      headers: authHeaders({ 'risu-writer-session': 'writer-a' }),
    })
    expect(stream.status).toBe(200)
    const events = await readSse(stream, (event) => event.type === 'token')
    expect(events.some((event) => event.type === 'message_patch')).toBe(false)
    const info = events.find((event) => event.type === 'info')
    expect(info, JSON.stringify(events)).toBeDefined()
    expect(info?.data).toMatchObject({
      generationDisplayProjection: {
        version: 1,
        mode: 'regenerate',
        targetMessageId: 'msg-char-1',
        operationId,
        attemptNo: 1,
        projectionEpoch: expect.any(Number),
        generationId: expect.any(String),
      },
    })
    expect(await chatMessages(await bootstrap())).toEqual([
      expect.objectContaining({ role: 'user', chatId: 'msg-user-1' }),
      expect.objectContaining({ role: 'char', chatId: 'msg-char-1', data: 'old reply' }),
    ])

    gated.release()
    await waitFor(async () => {
      const status = await operationStatus(operationId)
      return status.operation.state === 'completed' ? status : undefined
    })
    expect(await chatMessages(await bootstrap())).toEqual([
      expect.objectContaining({ role: 'user', chatId: 'msg-user-1' }),
      expect.objectContaining({ role: 'char', data: 'projected replacement' }),
    ])
  })

  it('atomically replays one accepted send and carries exact lineage through SSE, bootstrap, journal, result, and events', async () => {
    const gated = makeGatedProvider({ before: 'lineage', after: ' result' })
    let providerCalls = 0
    providerImpl = (context) => {
      providerCalls += 1
      return gated.dispatchProvider(context)
    }

    const authority = await operationAuthority()
    const operationId = randomUUID()
    const acceptedMessageId = randomUUID()
    const request = atomicSendRequest({
      operationId,
      acceptedMessageId,
      baseRevision: authority.revision,
    })

    const first = await postAtomicOperation(authority.databaseLineage, request)
    expect(first.status).toBe(201)
    const accepted = (await first.json()) as AtomicOperationResponse
    expect(accepted.operation).toMatchObject({
      operationId,
      state: 'owned_by_job',
      acceptedMessageId,
      currentAttempt: { attemptNo: 1, jobId: expect.any(String) },
    })
    expect(accepted.append).toMatchObject({
      disposition: 'accepted',
      messageId: acceptedMessageId,
      event: {
        type: 'message.appended',
        databaseLineage: authority.databaseLineage,
        operationId,
        sourceMessageId: acceptedMessageId,
      },
    })
    expect((accepted.append?.event as JsonRecord).origin).toBeUndefined()
    const jobId = accepted.operation.currentAttempt!.jobId

    const replay = await postAtomicOperation(authority.databaseLineage, {
      ...request,
      baseRevision: authority.revision + 999,
    })
    expect(replay.status).toBe(200)
    const replayed = (await replay.json()) as AtomicOperationResponse
    expect(replayed.operation.currentAttempt).toMatchObject({ attemptNo: 1, jobId })
    expect(replayed.append).toMatchObject({ disposition: 'accepted', messageId: acceptedMessageId })
    const conflictingReplay = await postAtomicOperation(authority.databaseLineage, {
      ...request,
      message: { ...(request.message as JsonRecord), data: 'changed immutable message' },
    })
    expect(conflictingReplay.status).toBe(409)
    expect(await conflictingReplay.json()).toEqual({ error: 'operation_id_conflict' })
    expect(providerCalls).toBe(1)

    const running = await operationAuthority()
    const active = running.activeGenerationJobs.find((entry) => entry.operationId === operationId)
    expect(active).toMatchObject({
      databaseLineage: authority.databaseLineage,
      operationId,
      writerSessionId: 'writer-a',
      attemptNo: 1,
      jobId,
      acceptedMessageId,
      operationStateVersion: expect.any(Number),
      projectionEpoch: expect.any(Number),
    })
    expect(running.generationOperations).toContainEqual(
      expect.objectContaining({
        operationId,
        state: 'owned_by_job',
        acceptedMessageId,
        currentAttempt: expect.objectContaining({ attemptNo: 1, jobId }),
      }),
    )

    const staleStream = await fetch(
      `${harness.baseUrl}/api/v1/generation-operations/${encodeURIComponent(operationId)}/stream` +
        `?attemptNo=1&jobId=${encodeURIComponent(jobId)}&projectionEpoch=0`,
      { headers: authHeaders() },
    )
    expect(staleStream.status).toBe(409)
    expect(await staleStream.json()).toMatchObject({
      error: 'stale_generation_attempt',
      operation: {
        operationId,
        projectionEpoch: active!.projectionEpoch,
        currentAttempt: { attemptNo: 1, jobId },
      },
    })

    const streamController = newController()
    const stream = await fetch(
      `${harness.baseUrl}/api/v1/generation-operations/${encodeURIComponent(operationId)}/stream` +
        `?attemptNo=1&jobId=${encodeURIComponent(jobId)}&projectionEpoch=${active!.projectionEpoch}`,
      { headers: authHeaders(), signal: streamController.signal },
    )
    expect(stream.status).toBe(200)
    const initialEvents = await readSse(stream, (event) => event.type === 'token')
    streamController.abort()
    expect(initialEvents.some((event) => event.type === 'job_accepted')).toBe(true)
    for (const event of initialEvents) {
      expect(event.data).toMatchObject({
        databaseLineage: authority.databaseLineage,
        operationId,
        writerSessionId: 'writer-a',
        writerEpoch: expect.any(Number),
        operationStateVersion: expect.any(Number),
        projectionEpoch: expect.any(Number),
        attemptNo: 1,
        jobId,
        acceptedMessageId,
      })
    }

    executeDatabase(`
      CREATE TRIGGER fail_protocol_generation_message_insert
      BEFORE INSERT ON messages
      WHEN NEW.role = 'char'
      BEGIN
        SELECT RAISE(FAIL, 'injected protocol finalization failure');
      END;
    `)
    const beforeFinalization = await operationStatus(operationId)
    const terminalStream = await fetch(
      `${harness.baseUrl}/api/v1/generation-operations/${encodeURIComponent(operationId)}/stream` +
        `?attemptNo=1&jobId=${encodeURIComponent(jobId)}` +
        `&projectionEpoch=${beforeFinalization.operation.projectionEpoch}`,
      { headers: authHeaders() },
    )
    expect(terminalStream.status).toBe(200)
    const terminalPromise = readSse(terminalStream, (event) => event.type === 'error')
    gated.release()
    const terminalEvents = await terminalPromise
    const terminalError = terminalEvents.find((event) => event.type === 'error')
    expect(terminalError?.data).toMatchObject({
      reason: 'generation_persistence_failed',
      persistenceDisposition: 'queued',
      databaseLineage: authority.databaseLineage,
      operationId,
      attemptNo: 1,
      jobId,
      acceptedMessageId,
    })

    const journalDb = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    try {
      expect(
        journalDb
          .prepare(
            `SELECT database_lineage AS databaseLineage, operation_id AS operationId,
                    operation_attempt_no AS attemptNo,
                    actor_writer_session_id AS writerSessionId,
                    accepted_message_id AS acceptedMessageId,
                    generation_id AS jobId, terminal_outcome AS terminalOutcome
             FROM generation_finalization_retries WHERE generation_id = ?`,
          )
          .get(jobId),
      ).toEqual({
        databaseLineage: authority.databaseLineage,
        operationId,
        attemptNo: 1,
        writerSessionId: 'writer-a',
        acceptedMessageId,
        jobId,
        terminalOutcome: 'completed',
      })
    } finally {
      journalDb.close()
    }
    const queuedAuthority = await operationAuthority()
    expect(queuedAuthority.generationFinalizations).toContainEqual(
      expect.objectContaining({
        generationId: jobId,
        databaseLineage: authority.databaseLineage,
        operationId,
        operationAttemptNo: 1,
        acceptedMessageId,
        terminalOutcome: 'completed',
      }),
    )

    executeDatabase('DROP TRIGGER fail_protocol_generation_message_insert')
    await waitFor(async () => {
      const status = await operationStatus(operationId)
      return status.operation.state === 'completed' ? status : undefined
    })
    expect(providerCalls).toBe(1)

    const assistant = (await chatMessages(await bootstrap())).find((message) => message.role === 'char')
    expect(assistant?.generationInfo).toMatchObject({
      databaseLineage: authority.databaseLineage,
      operationId,
      acceptedMessageId,
      attemptNo: 1,
      jobId,
    })
    const eventDb = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    try {
      expect(
        eventDb
          .prepare(
            `SELECT type, database_lineage AS databaseLineage, operation_id AS operationId,
                    source_message_id AS sourceMessageId, job_id AS jobId
             FROM command_events WHERE operation_id = ? ORDER BY revision`,
          )
          .all(operationId),
      ).toEqual([
        {
          type: 'message.appended',
          databaseLineage: authority.databaseLineage,
          operationId,
          sourceMessageId: acceptedMessageId,
          jobId: null,
        },
        {
          type: 'generation.persisted',
          databaseLineage: authority.databaseLineage,
          operationId,
          sourceMessageId: acceptedMessageId,
          jobId,
        },
      ])
    } finally {
      eventDb.close()
    }
  })

  it('binds a cancel-before-submit tombstone without appending or dispatching', async () => {
    let providerCalls = 0
    providerImpl = () => {
      providerCalls += 1
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'done', finishReason: 'stop' }
      })()
    }
    const authority = await operationAuthority()
    const operationId = randomUUID()
    const acceptedMessageId = randomUUID()
    const cancellation = await fetch(
      `${harness.baseUrl}/api/v1/generation-operations/${encodeURIComponent(operationId)}/cancellation`,
      {
        method: 'PUT',
        headers: authHeaders({
          'content-type': 'application/json',
          'risu-database-lineage': authority.databaseLineage,
          'risu-writer-session': 'writer-a',
        }),
        body: JSON.stringify({ reason: 'user_stop' }),
      },
    )
    expect(cancellation.status).toBe(200)
    expect(await cancellation.json()).toMatchObject({
      disposition: 'cancelled_before_acceptance',
      operation: { operationId, state: 'cancel_requested' },
    })

    const submit = await postAtomicOperation(
      authority.databaseLineage,
      atomicSendRequest({ operationId, acceptedMessageId, baseRevision: authority.revision }),
    )
    expect(submit.status).toBe(200)
    expect(await submit.json()).toMatchObject({
      operation: { operationId, state: 'cancelled', acceptedMessageId },
      append: { disposition: 'not_appended', messageId: acceptedMessageId },
    })
    expect(providerCalls).toBe(0)

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE uid = ?').get(acceptedMessageId)).toEqual({
        count: 0,
      })
      expect(
        db
          .prepare('SELECT COUNT(*) AS count FROM generation_operation_attempts WHERE operation_id = ?')
          .get(operationId),
      ).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('converges a submit/cancel arrival race on the same operation without an escaping runner', async () => {
    const gated = makeGatedProvider({ before: 'racing partial' })
    let providerCalls = 0
    providerImpl = (context) => {
      providerCalls += 1
      return gated.dispatchProvider(context)
    }
    const authority = await operationAuthority()
    const operationId = randomUUID()
    const acceptedMessageId = randomUUID()
    const submitPromise = postAtomicOperation(
      authority.databaseLineage,
      atomicSendRequest({ operationId, acceptedMessageId, baseRevision: authority.revision }),
    )
    const cancellationPromise = fetch(
      `${harness.baseUrl}/api/v1/generation-operations/${encodeURIComponent(operationId)}/cancellation`,
      {
        method: 'PUT',
        headers: authHeaders({
          'content-type': 'application/json',
          'risu-database-lineage': authority.databaseLineage,
          'risu-writer-session': 'writer-a',
        }),
        body: JSON.stringify({ reason: 'user_stop' }),
      },
    )
    const [submit, cancellation] = await Promise.all([submitPromise, cancellationPromise])
    expect([200, 201]).toContain(submit.status)
    expect([200, 202]).toContain(cancellation.status)
    expect(await cancellation.json()).toMatchObject({
      disposition: expect.stringMatching(/^(cancelled_before_acceptance|cancelled|cancelling)$/),
      operation: { operationId },
    })
    const terminal = await waitFor(async () => {
      const status = await operationStatus(operationId)
      return status.operation.state === 'cancelled' ? status : undefined
    })
    expect(terminal.operation.currentAttempt).toBeUndefined()
    expect(providerCalls).toBeLessThanOrEqual(1)
  })

  it('settles a cancellation before provider dispatch and admits the next send without a restart', async () => {
    let markAssemblyStarted!: () => void
    const assemblyStarted = new Promise<void>((resolve) => {
      markAssemblyStarted = resolve
    })
    let releaseAssembly!: () => void
    const assemblyGate = new Promise<void>((resolve) => {
      releaseAssembly = resolve
    })
    durableLifecycleHook = async (transition) => {
      if (transition !== 'assembly_started') return
      markAssemblyStarted()
      await assemblyGate
    }
    let providerCalls = 0
    providerImpl = () => {
      providerCalls += 1
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'done', finishReason: 'stop' }
      })()
    }

    try {
      const authority = await operationAuthority()
      const operationId = randomUUID()
      const submit = await postAtomicOperation(
        authority.databaseLineage,
        atomicSendRequest({
          operationId,
          acceptedMessageId: randomUUID(),
          baseRevision: authority.revision,
        }),
      )
      expect(submit.status).toBe(201)
      await assemblyStarted

      const cancellation = await fetch(
        `${harness.baseUrl}/api/v1/generation-operations/${encodeURIComponent(operationId)}/cancellation`,
        {
          method: 'PUT',
          headers: authHeaders({
            'content-type': 'application/json',
            'risu-database-lineage': authority.databaseLineage,
            'risu-writer-session': 'writer-a',
          }),
          body: JSON.stringify({ reason: 'user_stop' }),
        },
      )
      expect(cancellation.status).toBe(202)
      expect(await cancellation.json()).toMatchObject({
        disposition: 'cancelling',
        operation: { operationId, state: 'stopping' },
      })
      releaseAssembly()

      await waitFor(async () => {
        const status = await operationStatus(operationId)
        return status.operation.state === 'cancelled' ? status : undefined
      })
      expect(providerCalls).toBe(0)

      const followUpAuthority = await operationAuthority()
      const followUpOperationId = randomUUID()
      const followUp = await postAtomicOperation(
        followUpAuthority.databaseLineage,
        atomicSendRequest({
          operationId: followUpOperationId,
          acceptedMessageId: randomUUID(),
          baseRevision: followUpAuthority.revision,
          text: 'follow-up after assembly cancellation',
        }),
      )
      expect(followUp.status).toBe(201)
      await waitFor(async () => {
        const status = await operationStatus(followUpOperationId)
        return status.operation.state === 'completed' ? status : undefined
      })
      expect(providerCalls).toBe(1)
    } finally {
      releaseAssembly?.()
    }
  })

  it('settles an unreasoned assembly abort as retryable and releases the durable chat claim', async () => {
    let abortedJob: { done: boolean } | undefined
    durableLifecycleHook = async (transition, job) => {
      if (transition !== 'assembly_started' || abortedJob) return
      abortedJob = job
      // Match the registry deadline/GC abort at an abort-aware assembly await.
      job.abortController.abort()
      throw job.abortController.signal.reason
    }
    let providerCalls = 0
    providerImpl = () => {
      providerCalls += 1
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'done', finishReason: 'stop' }
      })()
    }
    const authority = await operationAuthority()
    const operationId = randomUUID()
    const submit = await postAtomicOperation(
      authority.databaseLineage,
      atomicSendRequest({
        operationId,
        acceptedMessageId: randomUUID(),
        baseRevision: authority.revision,
      }),
    )
    expect(submit.status).toBe(201)
    await waitFor(async () => (abortedJob?.done ? true : undefined))
    const status = await operationStatus(operationId)
    expect(status.operation).toMatchObject({ state: 'retryable', providerMayHaveRun: false })
    expect(status.operation.currentAttempt).toBeUndefined()
    expect(providerCalls).toBe(0)

    const next = await operationAuthority()
    const nextId = randomUUID()
    const followUp = await postAtomicOperation(
      next.databaseLineage,
      atomicSendRequest({
        operationId: nextId,
        acceptedMessageId: randomUUID(),
        baseRevision: next.revision,
        text: 'follow-up after expired assembly',
      }),
    )
    expect(followUp.status).toBe(201)
    await waitFor(async () => ((await operationStatus(nextId)).operation.state === 'completed' ? true : undefined))
    expect(providerCalls).toBe(1)
  })

  it('rejects synchronous generation-settings readiness before append or intent commit', async () => {
    await seedDatabase({
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [{ ...durableChat(), generationSettings: undefined }],
        },
      ],
    })
    let providerCalls = 0
    providerImpl = () => {
      providerCalls += 1
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'done', finishReason: 'stop' }
      })()
    }
    const authority = await operationAuthority()
    const operationId = randomUUID()
    const acceptedMessageId = randomUUID()
    const response = await postAtomicOperation(
      authority.databaseLineage,
      atomicSendRequest({ operationId, acceptedMessageId, baseRevision: authority.revision }),
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'chat_generation_settings_incomplete',
      chatId: 'chat-1',
    })
    expect(providerCalls).toBe(0)

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    try {
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM generation_operations WHERE operation_id = ?').get(operationId),
      ).toEqual({
        count: 0,
      })
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE uid = ?').get(acceptedMessageId)).toEqual({
        count: 0,
      })
    } finally {
      db.close()
    }
  })

  it('repairs persisted undefined markers on startup and keeps model stops after reapplying prompt overrides', async () => {
    const marker = { type: 0, data: { type: 'Buffer', data: [0] } }
    const legacy = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      const settings = JSON.parse(
        (legacy.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }).data_json,
      )
      settings.localStopStrings = marker
      legacy.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
      const row = legacy.prepare('SELECT data_json FROM prompt_presets WHERE position = 0').get() as {
        data_json: string
      }
      const preset = { ...JSON.parse(row.data_json), localStopStrings: marker, overrideModelParameters: true }
      legacy.prepare('UPDATE prompt_presets SET data_json = ? WHERE position = 0').run(JSON.stringify(preset))
      legacy.exec('UPDATE schema_version SET version = 37 WHERE id = 1')
    } finally {
      legacy.close()
    }
    await restartHarness()
    const authority = await operationAuthority()
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-presets',
      headers: authHeaders({ 'risu-writer-session': 'writer-a' }),
      payload: { baseRevision: authority.revision, preset: { id: 'new-model', localStopStrings: ['MODEL STOP'] } },
    })
    expect(create.statusCode, create.body).toBe(200)
    const select = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-presets/select',
      headers: authHeaders({ 'risu-writer-session': 'writer-a' }),
      payload: { baseRevision: create.json<{ revision: number }>().revision, modelPresetId: 'new-model' },
    })
    expect(select.statusCode, select.body).toBe(200)
    let dispatchedStopStrings: unknown
    providerImpl = (context) => {
      dispatchedStopStrings = context.database.localStopStrings
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'Reply after repair' }
        yield { kind: 'done', finishReason: 'stop' }
      })()
    }
    const operationId = randomUUID()
    const acceptedMessageId = randomUUID()
    const response = await postAtomicOperation(
      authority.databaseLineage,
      atomicSendRequest({
        operationId,
        acceptedMessageId,
        baseRevision: select.json<{ revision: number }>().revision,
      }),
    )
    expect(response.status).toBe(201)
    await response.json()
    await waitFor(async () => {
      const status = await operationStatus(operationId)
      return status.operation.state === 'completed' ? status : undefined
    })
    expect(dispatchedStopStrings).toEqual(['MODEL STOP'])
    expect((await chatHydration(await bootstrap())).message).toEqual([
      expect.objectContaining({ role: 'user', chatId: acceptedMessageId }),
      expect.objectContaining({ role: 'char', data: 'Reply after repair' }),
    ])
  })

  it.each([{}, [null], [42], 'STOP', { ext: 0, data: [0] }])(
    'rejects malformed runtime stop strings at save time: %j',
    async (value) => {
      const authority = await operationAuthority()
      const response = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/settings/runtime',
        headers: authHeaders({ 'risu-writer-session': 'writer-a' }),
        payload: { baseRevision: authority.revision, patch: { localStopStrings: value } },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: 'localStopStrings must be an array of strings or null' })
      expect((await operationAuthority()).revision).toBe(authority.revision)
    },
  )

  it('completes a send after custom stop strings are disabled through the settings API', async () => {
    const authority = await operationAuthority()
    const settingsResponse = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: authHeaders({ 'risu-writer-session': 'writer-a' }),
      payload: { baseRevision: authority.revision, patch: { localStopStrings: null } },
    })
    expect(settingsResponse.statusCode, settingsResponse.body).toBe(200)

    let dispatchedStopStrings: unknown
    providerImpl = (context) => {
      dispatchedStopStrings = context.database.localStopStrings
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'Reply after disabling custom stops' }
        yield { kind: 'done', finishReason: 'stop' }
      })()
    }
    const operationId = randomUUID()
    const acceptedMessageId = randomUUID()
    const response = await postAtomicOperation(
      authority.databaseLineage,
      atomicSendRequest({
        operationId,
        acceptedMessageId,
        baseRevision: settingsResponse.json<{ revision: number }>().revision,
      }),
    )
    expect(response.status).toBe(201)
    await response.json()
    await waitFor(async () => {
      const status = await operationStatus(operationId)
      return status.operation.state === 'completed' ? status : undefined
    })
    expect(dispatchedStopStrings).toBeNull()
    const hydration = await chatHydration(await bootstrap())
    expect(hydration.message).toEqual([
      expect.objectContaining({ role: 'user', chatId: acceptedMessageId }),
      expect.objectContaining({ role: 'char', data: 'Reply after disabling custom stops' }),
    ])
  })

  it.each(['legacy presets', 'durable profile'])(
    'completes a send with nullable settings from %s and imported lorebook metadata',
    async (owner) => {
      const legacyPreset = {
        dynamicOutput: null,
        thinkingTokens: null,
        reverseProxyOobaArgs: null,
        seperateModels: null,
        promptSettings: null,
      }
      const modelPreset = createExtractedModelPreset(legacyPreset, {
        id: DURABLE_MODEL_PRESET_ID,
        name: 'Legacy model',
      })
      const promptPreset = createExtractedPromptPreset(legacyPreset, {
        id: DURABLE_PROMPT_PRESET_ID,
        name: 'Legacy prompt',
      })
      if (owner === 'durable profile') {
        modelPreset.modelRoleProfiles = { chatMain: { mode: 'profile', profileId: 'null-profile' } }
        modelPreset.dynamicOutput = { dynamicMessages: true }
        modelPreset.reverseProxyOobaArgs = { mode: 'chat' }
        // Leave this field to the profile; prompt overrides intentionally win after profile application.
        delete promptPreset.dynamicOutput
      }
      await seedDatabase({
        ...fixtureDatabase,
        ...legacyPreset,
        // The model preset explicitly clears previously enabled dynamic output.
        ...(owner === 'legacy presets' ? { dynamicOutput: { dynamicMessages: true } } : {}),
        modelPresets: [
          {
            ...fixtureDatabase.modelPresets[0],
            ...modelPreset,
          },
        ],
        promptPresets: [
          {
            ...fixtureDatabase.promptPresets[0],
            ...promptPreset,
            overrideModelParameters: true,
          },
        ],
        ...(owner === 'durable profile'
          ? {
              modelProfiles: [
                {
                  id: 'null-profile',
                  name: 'Nullable profile',
                  modelId: 'echo_model',
                  runtimeOptions: { dynamicOutput: null },
                  providerOptions: { reverseProxy: { oobaArgs: null } },
                },
              ],
              modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'null-profile' } },
              modelRuntimeDefaults: { dynamicOutput: { dynamicMessages: true } },
            }
          : {}),
        characters: [
          {
            ...fixtureDatabase.characters[0],
            globalLore: [
              {
                key: '',
                secondkey: '',
                insertorder: 0,
                comment: 'Imported lore',
                content: 'Imported lore with no cache',
                mode: 'constant',
                alwaysActive: true,
                selective: false,
                loreCache: null,
                activationPercent: null,
              },
            ],
          },
        ],
      })
      let dispatchedSettings: unknown
      let dispatchedProfile: unknown
      providerImpl = (context) => {
        dispatchedProfile = context.profile
        dispatchedSettings = {
          dynamicOutput: context.database.dynamicOutput,
          thinkingTokens: context.database.thinkingTokens,
          reverseProxyOobaArgs: context.database.reverseProxyOobaArgs,
          promptSettings: context.database.promptSettings,
          seperateModels: context.database.seperateModels,
        }
        return (async function* (): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'Reply with nullable configuration' }
          yield { kind: 'done', finishReason: 'stop' }
        })()
      }
      const authority = await operationAuthority()
      const operationId = randomUUID()
      const acceptedMessageId = randomUUID()
      const response = await postAtomicOperation(
        authority.databaseLineage,
        atomicSendRequest({ operationId, acceptedMessageId, baseRevision: authority.revision }),
      )
      expect(response.status, await response.clone().text()).toBe(201)
      await response.json()
      await waitFor(async () => {
        const status = await operationStatus(operationId)
        return status.operation.state === 'completed' ? status : undefined
      })
      expect(dispatchedSettings).toEqual({
        ...legacyPreset,
        reverseProxyOobaArgs: owner === 'durable profile' ? { mode: 'chat' } : null,
      })
      if (owner === 'durable profile') {
        expect(dispatchedProfile).toMatchObject({
          profileId: 'null-profile',
          source: { kind: 'durable-profile' },
          runtimeOptions: { dynamicOutput: null },
        })
      }
      expect((await chatHydration(await bootstrap())).message).toEqual([
        expect.objectContaining({ role: 'user', chatId: acceptedMessageId }),
        expect.objectContaining({ role: 'char', data: 'Reply with nullable configuration' }),
      ])
    },
  )

  it('rejects a malformed known configuration before accepting a user message or operation', async () => {
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      db.prepare("UPDATE settings SET data_json = json_set(data_json, '$.temperature', ?) WHERE id = 1").run(
        'malformed-private-fixture-value',
      )
    } finally {
      db.close()
    }
    let providerCalls = 0
    providerImpl = () => {
      providerCalls += 1
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'done', finishReason: 'stop' }
      })()
    }
    const authority = await operationAuthority()
    const operationId = randomUUID()
    const acceptedMessageId = randomUUID()
    const response = await postAtomicOperation(
      authority.databaseLineage,
      atomicSendRequest({
        operationId,
        acceptedMessageId,
        baseRevision: authority.revision,
      }),
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('/database/temperature')
    expect(body.error).not.toContain('malformed-private-fixture-value')
    expect(providerCalls).toBe(0)
    const stored = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    try {
      expect(
        stored.prepare('SELECT COUNT(*) AS count FROM generation_operations WHERE operation_id = ?').get(operationId),
      ).toEqual({ count: 0 })
      expect(stored.prepare('SELECT COUNT(*) AS count FROM messages WHERE uid = ?').get(acceptedMessageId)).toEqual({
        count: 0,
      })
      expect(getSchemaState(stored).revision).toBe(authority.revision)
    } finally {
      stored.close()
    }
  })

  it('loads configuration and the accepted message freshly after preflight and append', async () => {
    await seedDatabase({
      ...fixtureDatabase,
      promptPresets: [
        { ...fixtureDatabase.promptPresets[0], formatingOrder: ['main', 'description', 'chats', 'lastChat'] },
      ],
    })
    const authority = await operationAuthority()
    const operationId = randomUUID()
    const acceptedMessageId = randomUUID()
    const acceptedText = 'Accepted text must enter the new assembly snapshot'
    const updatedPrompt = 'Selected prompt changed after acceptance'
    let configurationRevision = 0
    let dispatchedPrompt = ''
    let dispatchedSetting: unknown
    // This synchronous boundary is after acceptance committed and before the
    // detached runner assembles. Model an intervening committed config edit.
    durableLifecycleHook = (transition) => {
      if (transition !== 'registered') return
      const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
      try {
        expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE uid = ?').get(acceptedMessageId)).toEqual({
          count: 1,
        })
        db.exec('BEGIN IMMEDIATE')
        db.prepare(
          "UPDATE prompt_presets SET data_json = json_set(data_json, '$.mainPrompt', ?) WHERE json_extract(data_json, '$.id') = ?",
        ).run(updatedPrompt, DURABLE_PROMPT_PRESET_ID)
        configurationRevision = bumpRevision(db)
        db.exec('COMMIT')
      } finally {
        db.close()
      }
    }
    providerImpl = (context) => {
      dispatchedPrompt = JSON.stringify(context.result.formated)
      dispatchedSetting = context.database.mainPrompt
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'Fresh preparation reply' }
        yield { kind: 'done', finishReason: 'stop' }
      })()
    }
    const response = await postAtomicOperation(
      authority.databaseLineage,
      atomicSendRequest({
        operationId,
        acceptedMessageId,
        baseRevision: authority.revision,
        text: acceptedText,
      }),
    )
    expect(response.status).toBe(201)
    await waitFor(async () => {
      const status = await operationStatus(operationId)
      return status.operation.state === 'completed' ? status : undefined
    })
    expect(configurationRevision).toBe(authority.revision + 2)
    expect(dispatchedSetting).toBe(updatedPrompt)
    expect(dispatchedPrompt).toContain(updatedPrompt)
    expect(dispatchedPrompt).toContain(acceptedText)
  })

  it('shares one SQLite same-chat claim across protocol operations and the compatibility route', async () => {
    const firstGate = makeGatedProvider({ before: 'first', after: ' result' })
    providerImpl = firstGate.dispatchProvider
    let authority = await operationAuthority()
    const firstOperationId = randomUUID()
    const firstMessageId = randomUUID()
    const first = await postAtomicOperation(
      authority.databaseLineage,
      atomicSendRequest({
        operationId: firstOperationId,
        acceptedMessageId: firstMessageId,
        baseRevision: authority.revision,
      }),
    )
    expect(first.status).toBe(201)

    authority = await operationAuthority()
    const blockedOperationId = randomUUID()
    const blockedMessageId = randomUUID()
    const blocked = await postAtomicOperation(
      authority.databaseLineage,
      atomicSendRequest({
        operationId: blockedOperationId,
        acceptedMessageId: blockedMessageId,
        baseRevision: 0,
      }),
    )
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({ error: 'generation_in_progress', operationId: firstOperationId })
    const legacyBlocked = await postDurable({}, { writerSession: 'writer-a' })
    expect(legacyBlocked.status).toBe(409)

    firstGate.release()
    await waitFor(async () => {
      const status = await operationStatus(firstOperationId)
      return status.operation.state === 'completed' ? status : undefined
    })

    const legacyGate = makeGatedProvider({ before: 'legacy', after: ' result' })
    providerImpl = legacyGate.dispatchProvider
    const legacyController = newController()
    const legacy = await postDurable({}, { signal: legacyController.signal, writerSession: 'writer-a' })
    expect(legacy.status).toBe(200)
    await readSse(legacy, (event) => event.type === 'token')
    legacyController.abort()

    const claimDb = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    try {
      expect(
        claimDb
          .prepare(
            "SELECT request_origin AS requestOrigin, state FROM generation_operations WHERE chat_id = 'chat-1' AND request_origin = 'legacy' ORDER BY created_at DESC LIMIT 1",
          )
          .get(),
      ).toEqual({ requestOrigin: 'legacy', state: 'owned_by_job' })
    } finally {
      claimDb.close()
    }

    authority = await operationAuthority()
    const blockedByLegacyOperationId = randomUUID()
    const blockedByLegacyMessageId = randomUUID()
    const blockedByLegacy = await postAtomicOperation(
      authority.databaseLineage,
      atomicSendRequest({
        operationId: blockedByLegacyOperationId,
        acceptedMessageId: blockedByLegacyMessageId,
        baseRevision: authority.revision,
      }),
    )
    expect(blockedByLegacy.status).toBe(409)
    expect(await blockedByLegacy.json()).toMatchObject({ error: 'generation_in_progress' })

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    try {
      expect(
        db
          .prepare('SELECT COUNT(*) AS count FROM messages WHERE uid IN (?, ?)')
          .get(blockedMessageId, blockedByLegacyMessageId),
      ).toEqual({ count: 0 })
    } finally {
      db.close()
    }
    legacyGate.release()
  })

  it('cancels only the authoritative current attempt despite stale advisory fields', async () => {
    const gated = makeGatedProvider({ before: 'partial cancellation' })
    let providerCalls = 0
    providerImpl = (context) => {
      providerCalls += 1
      return gated.dispatchProvider(context)
    }
    const authority = await operationAuthority()
    const operationId = randomUUID()
    const acceptedMessageId = randomUUID()
    const submit = await postAtomicOperation(
      authority.databaseLineage,
      atomicSendRequest({ operationId, acceptedMessageId, baseRevision: authority.revision }),
    )
    expect(submit.status).toBe(201)
    const submitted = (await submit.json()) as AtomicOperationResponse
    const attempt = submitted.operation.currentAttempt!
    await waitFor(async () => (providerCalls === 1 ? true : undefined))

    const cancellation = await fetch(
      `${harness.baseUrl}/api/v1/generation-operations/${encodeURIComponent(operationId)}/cancellation`,
      {
        method: 'PUT',
        headers: authHeaders({
          'content-type': 'application/json',
          'risu-database-lineage': authority.databaseLineage,
          'risu-writer-session': 'writer-a',
        }),
        body: JSON.stringify({
          reason: 'user_stop',
          knownStateVersion: 1,
          knownAttemptNo: attempt.attemptNo + 99,
          knownJobId: randomUUID(),
        }),
      },
    )
    expect(cancellation.status).toBe(202)
    expect(await cancellation.json()).toMatchObject({
      disposition: 'cancelling',
      knownAttemptMatched: false,
      operation: {
        operationId,
        state: 'stopping',
        currentAttempt: { attemptNo: attempt.attemptNo, jobId: attempt.jobId },
      },
    })
    await waitFor(async () => {
      const status = await operationStatus(operationId)
      return status.operation.state === 'cancelled' ? status : undefined
    })
    expect(providerCalls).toBe(1)

    const replay = await fetch(
      `${harness.baseUrl}/api/v1/generation-operations/${encodeURIComponent(operationId)}/cancellation`,
      {
        method: 'PUT',
        headers: authHeaders({
          'content-type': 'application/json',
          'risu-database-lineage': authority.databaseLineage,
          'risu-writer-session': 'writer-a',
        }),
        body: JSON.stringify({ reason: 'user_stop' }),
      },
    )
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ disposition: 'already_cancelled' })
  })

  it('reports an already-completed operation without rewriting its terminal outcome', async () => {
    providerImpl = () =>
      (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'completed before stop' }
        yield { kind: 'done', finishReason: 'stop' }
      })()
    const authority = await operationAuthority()
    const operationId = randomUUID()
    const acceptedMessageId = randomUUID()
    const submit = await postAtomicOperation(
      authority.databaseLineage,
      atomicSendRequest({ operationId, acceptedMessageId, baseRevision: authority.revision }),
    )
    expect(submit.status).toBe(201)
    await waitFor(async () => {
      const status = await operationStatus(operationId)
      return status.operation.state === 'completed' ? status : undefined
    })

    const cancellation = await fetch(
      `${harness.baseUrl}/api/v1/generation-operations/${encodeURIComponent(operationId)}/cancellation`,
      {
        method: 'PUT',
        headers: authHeaders({
          'content-type': 'application/json',
          'risu-database-lineage': authority.databaseLineage,
          'risu-writer-session': 'writer-a',
        }),
        body: JSON.stringify({ reason: 'user_stop' }),
      },
    )
    expect(cancellation.status).toBe(200)
    expect(await cancellation.json()).toMatchObject({
      disposition: 'already_completed',
      operation: { operationId, state: 'completed', resultMessageId: expect.any(String) },
      result: { messageId: expect.any(String), revision: expect.any(Number) },
    })
  })

  it('replays one explicit retry without re-appending or re-running committed submit transforms', async () => {
    const database = structuredClone(fixtureDatabase) as JsonRecord
    const character = (database.characters as JsonRecord[])[0]!
    character.triggerscript = [
      {
        comment: '',
        type: 'input',
        conditions: [],
        effect: [
          {
            type: 'triggerlua',
            code: `
              function onInput(id)
                addChat(id, 'char', 'INPUT-ONCE')
              end
              listenEdit('editInput', function(id, data)
                return data .. ' [EDIT-ONCE]'
              end)
            `,
          },
        ],
      },
    ]
    await seedDatabase(database)
    let providerCalls = 0
    providerImpl = () => {
      providerCalls += 1
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'error', error: 'injected provider failure', nonRetryable: true }
      })()
    }
    const authority = await operationAuthority()
    const operationId = randomUUID()
    const acceptedMessageId = randomUUID()
    const submit = await postAtomicOperation(
      authority.databaseLineage,
      atomicSendRequest({ operationId, acceptedMessageId, baseRevision: authority.revision }),
    )
    expect(submit.status).toBe(201)
    const retryable = await waitFor(async () => {
      const status = await operationStatus(operationId)
      return status.operation.state === 'retryable' ? status : undefined
    })
    expect(providerCalls).toBe(1)
    expect(
      (await chatMessages(await bootstrap())).map((message) => [message.role, message.data, message.chatId]),
    ).toEqual([
      ['char', 'INPUT-ONCE', expect.any(String)],
      ['user', 'atomic hello [EDIT-ONCE]', acceptedMessageId],
    ])

    const retryGate = makeGatedProvider({ before: 'retried', after: ' once' })
    providerImpl = (context) => {
      providerCalls += 1
      return retryGate.dispatchProvider(context)
    }
    const retryRequestId = randomUUID()
    const retryBody = {
      retryRequestId,
      expectedStateVersion: retryable.operation.stateVersion,
    }
    const retry = await fetch(
      `${harness.baseUrl}/api/v1/generation-operations/${encodeURIComponent(operationId)}/retries`,
      {
        method: 'POST',
        headers: authHeaders({
          'content-type': 'application/json',
          'risu-database-lineage': authority.databaseLineage,
          'risu-writer-session': 'writer-a',
        }),
        body: JSON.stringify(retryBody),
      },
    )
    expect(retry.status).toBe(202)
    const retried = (await retry.json()) as AtomicOperationResponse
    expect(retried.operation).toMatchObject({
      operationId,
      state: 'owned_by_job',
      acceptedMessageId,
      currentAttempt: { attemptNo: 2, retryRequestId, jobId: expect.any(String) },
    })
    const retryJobId = retried.operation.currentAttempt!.jobId

    const retryReplay = await fetch(
      `${harness.baseUrl}/api/v1/generation-operations/${encodeURIComponent(operationId)}/retries`,
      {
        method: 'POST',
        headers: authHeaders({
          'content-type': 'application/json',
          'risu-database-lineage': authority.databaseLineage,
          'risu-writer-session': 'writer-a',
        }),
        body: JSON.stringify(retryBody),
      },
    )
    expect(retryReplay.status).toBe(200)
    expect(await retryReplay.json()).toMatchObject({
      operation: { currentAttempt: { attemptNo: 2, retryRequestId, jobId: retryJobId } },
    })
    expect(providerCalls).toBe(2)
    expect(
      (await chatMessages(await bootstrap())).map((message) => [message.role, message.data, message.chatId]),
    ).toEqual([
      ['char', 'INPUT-ONCE', expect.any(String)],
      ['user', 'atomic hello [EDIT-ONCE]', acceptedMessageId],
    ])

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    try {
      expect(
        db
          .prepare('SELECT COUNT(*) AS count FROM generation_operation_attempts WHERE operation_id = ?')
          .get(operationId),
      ).toEqual({ count: 2 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE uid = ?').get(acceptedMessageId)).toEqual({
        count: 1,
      })
    } finally {
      db.close()
    }
    retryGate.release()
    await waitFor(async () => {
      const status = await operationStatus(operationId)
      return status.operation.state === 'completed' ? status : undefined
    })
    const completedReplay = await fetch(
      `${harness.baseUrl}/api/v1/generation-operations/${encodeURIComponent(operationId)}/retries`,
      {
        method: 'POST',
        headers: authHeaders({
          'content-type': 'application/json',
          'risu-database-lineage': authority.databaseLineage,
          'risu-writer-session': 'writer-a',
        }),
        body: JSON.stringify(retryBody),
      },
    )
    expect(completedReplay.status).toBe(200)
    const receipt = (await completedReplay.json()) as Record<string, any>
    expect(receipt).toMatchObject({
      acceptedRetryRequestId: retryRequestId,
      operation: { operationId, state: 'completed' },
    })
    expect(receipt.operation.currentAttempt).toBeUndefined()
    expect(providerCalls).toBe(2)
  })

  it('exposes the accepted durable job id before the SSE body is consumed', async () => {
    const res = await postDurable({})
    const headerJobId = res.headers.get('x-risu-generation-job-id')

    expect(headerJobId).not.toBeNull()
    const events = await readSse(res, (event) => event.type === 'done')
    expect(jobIdFromEvents(events)).toBe(headerJobId)
  })

  it.each(['registered', 'viewer_write_started', 'viewer_attached', 'runner_tracked'] as const)(
    'cleans up the job and chat slot when startup fails after %s',
    async (transition) => {
      let failedJobId = ''
      let failedJobSignal: AbortSignal | undefined
      durableLifecycleHook = (current, job) => {
        if (current !== transition) return
        failedJobId = job.id
        failedJobSignal = job.abortController.signal
        throw new Error(`injected durable lifecycle failure after ${transition}`)
      }

      const failed = await postDurable({})
      if (transition === 'registered') {
        expect(failed.status).toBe(500)
        await expect(failed.json()).resolves.toEqual({ error: 'generation_job_start_failed' })
      } else {
        expect(failed.status).toBe(200)
        await failed.text()
      }

      expect(failedJobId).not.toBe('')
      expect(failedJobSignal?.aborted).toBe(true)
      await waitFor(async () => {
        const state = await bootstrap()
        return state.activeGenerationJobs.length === 0 ? true : undefined
      })

      const missing = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(failedJobId)}/stream`, {
        headers: authHeaders(),
      })
      expect(missing.status).toBe(404)

      durableLifecycleHook = undefined
      const retry = await postDurable({})
      expect(retry.status).toBe(200)
      const events = await readSse(retry, (event) => event.type === 'done')
      expect(events.at(-1)?.type).toBe('done')
    },
  )

  // The generation survives the client drop and persists with no client present.
  it('keeps generating after the client drops mid-stream and persists the result', async () => {
    const gated = makeGatedProvider({ before: 'Hel', after: 'lo' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res = await postDurable({}, { signal: controller.signal })
    let jobId = ''
    await readSse(res, (ev) => {
      if (ev.type === 'job_accepted') jobId = ev.data.jobId as string
      return ev.type === 'token'
    })
    expect(jobId.length).toBeGreaterThan(0)

    // Drop the client mid-stream, then let the provider finish server-side.
    controller.abort()
    gated.release()

    const message = await waitForAssistantMessage()
    expect(message.role).toBe('char')
    expect(message.data).toBe('Hello')
    expect(message.chatId).toBe(jobId)
    // Persisted exactly once; generationId makes the write idempotent.
    const boot = await bootstrap()
    expect((await chatMessages(boot)).filter((m) => m.role === 'char')).toHaveLength(1)
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    try {
      expect(
        db
          .prepare(
            `SELECT key_type AS keyType, key_id AS keyId, COUNT(*) AS count
             FROM generation_effects WHERE generation_id = ? GROUP BY key_type, key_id`,
          )
          .get(jobId),
      ).toEqual({ keyType: 'generation', keyId: jobId, count: 7 })
      expect(
        db
          .prepare(
            "SELECT status FROM generation_effects WHERE generation_id = ? AND effect_kind = 'generated_translation'",
          )
          .get(jobId),
      ).toEqual({ status: 'skipped' })
    } finally {
      db.close()
    }
  })

  it('persists the prompt preset name and active toggle snapshot on the assistant row', async () => {
    await seedDatabase({
      ...fixtureDatabase,
      promptInfoInsideChat: true,
      promptTextInfoInsideChat: false,
      promptPresets: [
        {
          ...fixtureDatabase.promptPresets[0],
          customPromptTemplateToggle: 'flag=Flag\ntone=Tone=select=warm,formal\nnote=Note=text',
        },
      ],
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [
            {
              ...durableChat(),
              generationSettings: {
                ...durableGenerationSettings(),
                sidebarToggles: {
                  flag: '1',
                  tone: '1',
                  note: 'remember this',
                },
              },
            },
          ],
        },
      ],
    })
    providerImpl = () => {
      async function* g(): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'metadata reply' }
        yield { kind: 'done', finishReason: 'stop' }
      }
      return g()
    }

    const controller = newController()
    const res = await postDurable({}, { signal: controller.signal })
    const events = await readSse(res, (event) => event.type === 'done')
    expect(events.some((event) => event.type === 'done')).toBe(true)

    const assistant = await waitForAssistantMessage()
    expect(assistant.promptInfo).toMatchObject({
      promptName: 'Durable Prompt Preset',
      promptToggles: [
        { key: 'Flag', value: 'ON' },
        { key: 'Tone', value: 'formal' },
        { key: 'Note', value: 'remember this' },
      ],
    })
    controller.abort()
  })

  it('streams and atomically persists every multi-generation choice as a reroll candidate', async () => {
    providerImpl = () => {
      async function* g(): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'primary reply' }
        yield {
          kind: 'done',
          finishReason: 'stop',
          alternates: ['second reply', 'third reply'],
        }
      }
      return g()
    }

    const res = await postDurable({})
    const events = await readSse(res, (event) => event.type === 'done')
    const done = events.filter((event) => event.type === 'done').at(-1)
    expect(done?.data.alternates).toEqual(['second reply', 'third reply'])

    const hydration = await chatHydration(await bootstrap())
    const active = hydration.message.find((message) => message.role === 'char')
    expect(active).toMatchObject({ data: 'primary reply' })
    expect(hydration.alternates.map((message) => message.data).sort()).toEqual([
      'primary reply',
      'second reply',
      'third reply',
    ])
    expect(new Set(hydration.alternates.map((message) => message.chatId)).size).toBe(3)
    expect(hydration.alternates.some((message) => message.chatId === active?.chatId)).toBe(true)
    expect(hydration.alternates.find((message) => message.data === 'second reply')?.chatId).toBe(
      `${String(active?.chatId)}:alternate:1`,
    )
    expect(hydration.alternates.find((message) => message.data === 'third reply')?.chatId).toBe(
      `${String(active?.chatId)}:alternate:2`,
    )
    expect(generationFinalizationRetryRows()).toEqual([])
  })

  it('reports committed success when live event bookkeeping fails after the authoritative commit', async () => {
    failNextGenerationPersistEvent = true
    providerImpl = () => {
      async function* g(): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'retry me' }
        yield { kind: 'done', finishReason: 'stop', alternates: ['retry alternate'] }
      }
      return g()
    }

    const controller = newController()
    const { result: events, metrics } = await captureProtocolMetrics(async () => {
      const res = await postDurable({}, { signal: controller.signal })
      return readSse(res, () => false)
    })
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.at(-1)?.type).toBe('done')
    expect(generationFinalizationRetryRows()).toEqual([])
    const hydration = await chatHydration(await bootstrap())
    const assistantMessages = hydration.message.filter((m) => m.role === 'char')
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0].data).toBe('retry me')
    expect(hydration.alternates.map((message) => message.data).sort()).toEqual(['retry alternate', 'retry me'])
    expect(metrics.find((metric) => metric.metric === 'generation_persistence')).toMatchObject({
      status: 'bookkeeping_error',
      phase: 'bookkeeping',
      journalConfirmed: true,
      authoritativeCommitted: true,
      cleanupComplete: true,
    })
    controller.abort()
  })

  it('reports an unconfirmed disposition when finalization journal insertion fails', async () => {
    await resetHarness({ finalizationRetry: false })
    await seedDatabase({
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          triggerscript: [
            {
              comment: '',
              type: 'output',
              conditions: [],
              effect: [{ type: 'setvar', operator: '=', var: 'journalMutation', value: 'must-not-commit' }],
            },
          ],
        },
      ],
    })
    const gated = makeGatedProvider({ before: 'unjournaled', after: ' result' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const response = await postDurable({}, { signal: controller.signal })
    const initialEvents = await readSse(response, (event) => event.type === 'token')
    const jobId = jobIdFromEvents(initialEvents)
    const replay = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
      headers: authHeaders(),
    })
    executeDatabase(`
      CREATE TRIGGER fail_generation_retry_insert
      BEFORE INSERT ON generation_finalization_retries
      BEGIN
        SELECT RAISE(FAIL, 'injected generation journal failure');
      END;
    `)

    const { result: events, metrics } = await captureProtocolMetrics(async () => {
      gated.release()
      return readSse(replay, () => false)
    })

    expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
    expect(events.some((event) => event.type === 'done')).toBe(false)
    expect(events.find((event) => event.type === 'error')?.data).toMatchObject({
      reason: 'generation_persistence_failed',
      persistenceDisposition: 'unconfirmed',
      generationProjection: {
        characterId: 'char-1',
        chatId: 'chat-1',
        generationId: jobId,
        mode: 'send',
      },
    })
    expect(generationFinalizationRetryRows()).toEqual([])
    const failedBootstrap = await bootstrap()
    const hydration = await chatHydration(failedBootstrap)
    expect(hydration.message.some((message) => message.role === 'char')).toBe(false)
    expect(hydration.alternates).toEqual([])
    expect(failedBootstrap.database.characters[0].chats[0].scriptstate).toBeUndefined()
    expect(metrics.find((metric) => metric.metric === 'generation_persistence')).toMatchObject({
      status: 'journal_error',
      phase: 'journal',
      journalConfirmed: false,
      authoritativeCommitted: false,
      cleanupComplete: false,
    })
    expect(
      metrics.some((metric) => metric.metric === 'generation_persistence' && metric.status === 'retry_queued'),
    ).toBe(false)
    controller.abort()
    executeDatabase('DROP TRIGGER fail_generation_retry_insert')
    await restartHarness()
    expect(generationFinalizationRetryRows()).toEqual([])
    expect((await chatMessages(await bootstrap())).some((message) => message.role === 'char')).toBe(false)
  })

  it('does not claim queued when SQLite is busy at journal insertion', async () => {
    await resetHarness({ finalizationRetry: false })
    const gated = makeGatedProvider({ before: 'locked', after: ' result' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const response = await postDurable({}, { signal: controller.signal })
    const initialEvents = await readSse(response, (event) => event.type === 'token')
    const jobId = jobIdFromEvents(initialEvents)
    const replay = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
      headers: authHeaders(),
    })
    const locker = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      locker.exec('BEGIN IMMEDIATE')
      gated.release()
      const events = await readSse(replay, () => false)
      expect(events.find((event) => event.type === 'error')?.data.persistenceDisposition).toBe('unconfirmed')
      expect(events.some((event) => event.type === 'done')).toBe(false)
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
    }
    expect(generationFinalizationRetryRows()).toEqual([])
    expect((await chatMessages(await bootstrap())).some((message) => message.role === 'char')).toBe(false)
    controller.abort()
  })

  it('confirms the exact pending journal row before reporting a retryable persistence failure as queued', async () => {
    await resetHarness({ finalizationRetry: false })
    const gated = makeGatedProvider({ before: 'queued', after: ' result' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const response = await postDurable({}, { signal: controller.signal })
    const initialEvents = await readSse(response, (event) => event.type === 'token')
    const jobId = jobIdFromEvents(initialEvents)
    const replay = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
      headers: authHeaders(),
    })
    executeDatabase(`
      CREATE TRIGGER fail_generation_message_insert
      BEFORE INSERT ON messages
      WHEN NEW.role = 'char'
      BEGIN
        SELECT RAISE(FAIL, 'injected authoritative persistence failure');
      END;
    `)

    const { result: events, metrics } = await captureProtocolMetrics(async () => {
      gated.release()
      return readSse(replay, () => false)
    })
    expect(events.find((event) => event.type === 'error')?.data.persistenceDisposition).toBe('queued')
    expect(events.some((event) => event.type === 'done')).toBe(false)
    expect(generationFinalizationRetryRows()).toEqual([
      expect.objectContaining({ generation_id: jobId, status: 'pending', failure_count: 1 }),
    ])
    expect((await chatMessages(await bootstrap())).some((message) => message.role === 'char')).toBe(false)
    expect(metrics.find((metric) => metric.metric === 'generation_persistence')).toMatchObject({
      status: 'retry_queued',
      phase: 'authoritative_commit',
      journalConfirmed: true,
      authoritativeCommitted: false,
    })

    controller.abort()
    executeDatabase('DROP TRIGGER fail_generation_message_insert')
    await restartHarness()
    expect(generationFinalizationRetryRows()).toEqual([])
    const messages = await chatMessages(await bootstrap())
    expect(messages.filter((message) => message.role === 'char')).toHaveLength(1)
    expect(messages.find((message) => message.role === 'char')?.data).toBe('queued result')
    expect(commandEventTypeCount('generation.persisted')).toBe(1)
  })

  it('preserves the confirmed queue and original persistence error when retry bookkeeping fails', async () => {
    await resetHarness({ finalizationRetry: false })
    const gated = makeGatedProvider({ before: 'bookkeeping', after: ' result' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const response = await postDurable({}, { signal: controller.signal })
    const initialEvents = await readSse(response, (event) => event.type === 'token')
    const jobId = jobIdFromEvents(initialEvents)
    const replay = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
      headers: authHeaders(),
    })
    executeDatabase(`
      CREATE TRIGGER fail_generation_message_insert
      BEFORE INSERT ON messages
      WHEN NEW.role = 'char'
      BEGIN
        SELECT RAISE(FAIL, 'original authoritative failure');
      END;
      CREATE TRIGGER fail_generation_retry_update
      BEFORE UPDATE ON generation_finalization_retries
      BEGIN
        SELECT RAISE(FAIL, 'injected retry bookkeeping failure');
      END;
    `)

    const { result: events, metrics } = await captureProtocolMetrics(async () => {
      gated.release()
      return readSse(replay, () => false)
    })
    const error = events.find((event) => event.type === 'error')?.data
    expect(error).toMatchObject({ persistenceDisposition: 'queued' })
    expect(String(error?.error)).toContain('original authoritative failure')
    expect(generationFinalizationRetryRows()).toEqual([
      expect.objectContaining({ generation_id: jobId, status: 'pending', failure_count: 0 }),
    ])
    expect(metrics.find((metric) => metric.metric === 'generation_persistence')).toMatchObject({
      status: 'retry_queued',
      phase: 'bookkeeping',
      journalConfirmed: true,
      authoritativeCommitted: false,
      bookkeepingError: expect.stringContaining('injected retry bookkeeping failure'),
    })
    controller.abort()
  })

  it('rejects a serialization failure before persistence and leaves no journal row', () => {
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      const circularMessage: Record<string, unknown> = {
        role: 'char',
        data: 'cannot serialize',
        chatId: 'serialization-generation',
      }
      circularMessage.circular = circularMessage
      expect(() =>
        enqueueGenerationFinalizationRetry(db, {
          generationId: 'serialization-generation',
          chatId: 'chat-1',
          mode: 'send',
          message: circularMessage as never,
          chatVarMutations: [],
        }),
      ).toThrow(/circular/i)
      expect(
        db
          .prepare('SELECT generation_id FROM generation_finalization_retries WHERE generation_id = ?')
          .get('serialization-generation'),
      ).toBeUndefined()
      expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'char'").get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('replays an already-persisted chat-var finalization retry as a no-op', async () => {
    await harness.app.close()
    rmSync(harness.dataDir, { recursive: true, force: true })
    harness = await startHarness({ finalizationRetry: false })
    ;({ assertion } = await setupAuthedClient(harness.app))
    providerImpl = () => {
      async function* g(): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'reply text' }
        yield { kind: 'done', finishReason: 'stop' }
      }
      return g()
    }
    await seedDatabase({
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          triggerscript: [
            {
              comment: '',
              type: 'output',
              conditions: [],
              effect: [{ type: 'setvar', operator: '=', var: 'mood', value: 'happy' }],
            },
          ],
        },
      ],
    })
    executeDatabase(`
      CREATE TRIGGER fail_generation_retry_cleanup
      BEFORE DELETE ON generation_finalization_retries
      BEGIN
        SELECT RAISE(FAIL, 'injected generation retry cleanup failure');
      END;
    `)

    const controller = newController()
    const { result: events, metrics } = await captureProtocolMetrics(async () => {
      const res = await postDurable({}, { signal: controller.signal })
      return readSse(res, (ev) => ev.type === 'error' || ev.type === 'done')
    })
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.find((event) => event.type === 'done')?.data.persistenceDisposition).toBe('committed_cleanup_pending')
    expect(metrics.find((metric) => metric.metric === 'generation_persistence')).toMatchObject({
      status: 'cleanup_pending',
      phase: 'cleanup',
      journalConfirmed: true,
      authoritativeCommitted: true,
      cleanupComplete: false,
      cleanupError: expect.stringContaining('injected generation retry cleanup failure'),
    })
    const jobId = jobIdFromEvents(events)

    await waitFor(async () => {
      const row = generationFinalizationRetryRows().find((retry) => retry.generation_id === jobId)
      return row?.status === 'pending' ? row : undefined
    })
    expect(commandEventTypeCount('generation.persisted')).toBe(1)
    const failedBoot = await bootstrap()
    expect(failedBoot.database.characters[0].chats[0].scriptstate).toEqual({ $mood: 'happy' })
    expect((await chatMessages(failedBoot)).filter((message) => message.role === 'char')).toHaveLength(1)

    await patchChatScriptstate({ $mood: 'user-edited' })
    const editedBoot = await bootstrap()
    const revisionBeforeRetry = editedBoot.revision
    expect(editedBoot.database.characters[0].chats[0].scriptstate).toEqual({ $mood: 'user-edited' })

    executeDatabase('DROP TRIGGER fail_generation_retry_cleanup')
    expect(retryQueuedFinalizationsOnce()).toEqual({
      attempted: 1,
      persisted: 1,
      terminal: 0,
      retryable: 0,
    })
    expect(generationFinalizationRetryRows()).toEqual([])

    const retriedBoot = await bootstrap()
    expect(retriedBoot.revision).toBe(revisionBeforeRetry)
    expect(retriedBoot.database.characters[0].chats[0].scriptstate).toEqual({ $mood: 'user-edited' })
    const assistantMessages = (await chatMessages(retriedBoot)).filter((message) => message.role === 'char')
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]).toMatchObject({ data: 'reply text', chatId: jobId })
    expect(commandEventTypeCount('generation.persisted')).toBe(1)
    controller.abort()
  })

  it('a durable retry replay drops a newly stale chat-var write and persists the assistant row', async () => {
    await harness.app.close()
    rmSync(harness.dataDir, { recursive: true, force: true })
    harness = await startHarness({ finalizationRetry: false })
    ;({ assertion } = await setupAuthedClient(harness.app))
    await seedDatabase(fixtureDatabase)

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      enqueueGenerationFinalizationRetry(db, {
        generationId: 'retry-stale-script',
        chatId: 'chat-1',
        mode: 'send',
        message: {
          role: 'char',
          data: 'retry conflict-safe reply',
          chatId: 'retry-stale-script',
        } as never,
        chatVarMutations: [{ key: '$mood', before: null, after: 'script-value' }],
      })
    } finally {
      db.close()
    }
    await patchChatScriptstate({ $mood: 'user-value' })

    const previousMetrics = process.env.RISU_PROTOCOL_METRICS
    process.env.RISU_PROTOCOL_METRICS = '1'
    const metrics: Array<Record<string, unknown>> = []
    const infoSpy = vi.spyOn(console, 'info').mockImplementation((message: unknown) => {
      if (typeof message !== 'string' || !message.startsWith('[protocol-metric] ')) return
      metrics.push(JSON.parse(message.slice('[protocol-metric] '.length)) as Record<string, unknown>)
    })
    const logger = { warn: vi.fn(), error: vi.fn() }
    try {
      expect(retryQueuedFinalizationsOnce(logger)).toEqual({
        attempted: 1,
        persisted: 1,
        terminal: 0,
        retryable: 0,
      })
    } finally {
      infoSpy.mockRestore()
      if (previousMetrics === undefined) {
        delete process.env.RISU_PROTOCOL_METRICS
      } else {
        process.env.RISU_PROTOCOL_METRICS = previousMetrics
      }
    }

    expect(generationFinalizationRetryRows()).toEqual([])
    const boot = await bootstrap()
    expect(boot.database.characters[0].chats[0].scriptstate).toEqual({ $mood: 'user-value' })
    expect((await chatMessages(boot)).at(-1)).toMatchObject({
      role: 'char',
      data: 'retry conflict-safe reply',
      chatId: 'retry-stale-script',
    })
    expect(metrics.find((metric) => metric.metric === 'generation_script_mutation_conflict')).toMatchObject({
      status: 'dropped',
      chatId: 'chat-1',
      droppedMutationCount: 1,
      droppedMutations: [{ scope: 'chat_variable', key: '$mood' }],
    })
    expect(metrics.find((metric) => metric.metric === 'generation_persistence_retry')).toMatchObject({
      status: 'persisted',
      droppedScriptMutationCount: 1,
      droppedScriptMutations: [{ scope: 'chat_variable', key: '$mood' }],
    })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        generationId: 'retry-stale-script',
        droppedScriptMutations: [{ scope: 'chat_variable', key: '$mood' }],
      }),
      'generation finalization retry dropped stale script mutations',
    )
  })

  it('replay selection never silently deletes retained terminal finalization history', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-generation-retention-'))
    const db = openDatabase(dataDir)
    try {
      seedGenerationFinalizationRetryRow(db, 'terminal-old', 'terminal', '2026-06-01T00:00:00.000Z')
      seedGenerationFinalizationRetryRow(db, 'terminal-recent', 'terminal', '2026-06-05T12:00:00.000Z')
      seedGenerationFinalizationRetryRow(db, 'pending-old', 'pending', '2026-06-01T00:00:00.000Z')

      const replay = retryQueuedGenerationFinalizations({
        db,
        dataDir,
        eventSink: createCommandEventSink(),
        now: '2026-06-06T00:00:00.000Z',
        messageTranslationJobs: new MessageTranslationJobRegistry(),
      })
      expect(replay.attempted).toBe(1)

      expect(
        (
          db
            .prepare(
              `
                SELECT generation_id
                FROM generation_finalization_retries
                ORDER BY generation_id ASC
              `,
            )
            .all() as Array<{ generation_id: string }>
        ).map((row) => row.generation_id),
      ).toEqual(['pending-old', 'terminal-old', 'terminal-recent'])
      expect(
        db.prepare('SELECT status FROM generation_finalization_retries WHERE generation_id = ?').get('pending-old'),
      ).toEqual({ status: 'pending' })
    } finally {
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('app retry sweeps retain terminal history after processing due work', async () => {
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      seedGenerationFinalizationRetryRow(db, 'terminal-app-old', 'terminal', '2020-01-01T00:00:00.000Z')
      seedGenerationFinalizationRetryRow(db, 'terminal-app-recent', 'terminal', new Date().toISOString())
      seedGenerationFinalizationRetryRow(db, 'pending-sweep-barrier', 'pending', '2020-01-01T00:00:00.000Z')
    } finally {
      db.close()
    }

    await waitFor(async () => {
      const rows = generationFinalizationRetryRows()
      return rows.some((row) => row.generation_id === 'pending-sweep-barrier') ? undefined : rows
    })

    expect(generationFinalizationRetryRows().map((row) => row.generation_id)).toEqual([
      'terminal-app-old',
      'terminal-app-recent',
    ])
  })

  // Drop the initial connection after it received prompt/info, reattach to the
  // still-running job, then let it produce the remaining tokens and terminal done.
  it('reattaches to an in-flight generation with prompt/info replayed', async () => {
    const gated = makeGatedProvider({ before: 'Hel', after: 'lo' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res = await postDurable(
      { clientCapabilities: { omitDuplicateDoneResult: true } },
      { signal: controller.signal },
    )
    let jobId = ''
    const initialEvents = await readSse(res, (ev) => {
      if (ev.type === 'job_accepted') jobId = ev.data.jobId as string
      return ev.type === 'token'
    })
    expect(jobId.length).toBeGreaterThan(0)
    expect(initialEvents.some((e) => e.type === 'prompt')).toBe(true)
    expect(initialEvents.some((e) => e.type === 'info')).toBe(true)
    // Drop the initial connection while the job is still gated (in-flight).
    controller.abort()

    // Reattach to the in-flight job, THEN release the remaining tokens — they stream
    // live to the reattached viewer.
    const reController = newController()
    const re = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
      headers: authHeaders(),
      signal: reController.signal,
    })
    expect(re.status).toBe(200)
    gated.release()
    const reEvents = await readSse(re, (ev) => ev.type === 'done')
    expect(reEvents[0]?.type).toBe('job_accepted')
    expect(reEvents.some((e) => e.type === 'prompt')).toBe(true)
    expect(reEvents.some((e) => e.type === 'info')).toBe(true)
    expect(reEvents.some((e) => e.type === 'token' && e.data.content === 'Hel')).toBe(true)
    expect(reEvents.some((e) => e.type === 'token' && e.data.content === 'lo')).toBe(true)
    expect(reEvents.at(-1)?.type).toBe('done')
    expect(reEvents.at(-1)?.data.result).toBe('Hello')
    reController.abort()

    // The job ran to completion server-side and persisted the full result.
    const message = await waitForAssistantMessage()
    expect(message.data).toBe('Hello')
  })

  it.each([
    {
      cap: 'event',
      tokens: Array.from({ length: 600 }, (_, index) => `[${index}]`),
      expectGap: false,
      expectSnapshot: false,
    },
    {
      cap: 'byte',
      tokens: Array.from({ length: 256 }, (_, index) => `${index}:${'한'.repeat(2_048)}`),
      expectGap: false,
      expectSnapshot: true,
    },
    {
      cap: 'oversized-terminal',
      tokens: ['x'.repeat(2 * 1024 * 1024 + 16 * 1024)],
      expectGap: true,
      expectSnapshot: true,
    },
  ])(
    'keeps replay bounded with compaction, gap signaling, and terminal recovery at the durable $cap cap',
    async ({ tokens, expectGap, expectSnapshot }) => {
      const provider = makeReplayCapProvider(tokens)
      providerImpl = provider.dispatchProvider
      const fullResult = tokens.join('')

      const controller = newController()
      const response = await postDurable({}, { signal: controller.signal })
      const jobId = response.headers.get('x-risu-generation-job-id') ?? ''
      expect(jobId).not.toBe('')

      // Detach before any token frames are emitted, then let the durable runner
      // overflow its replay window and finish without a viewer.
      controller.abort()
      provider.release()
      const persisted = await waitForAssistantMessage()
      expect(persisted.data).toBe(fullResult)

      const replayController = newController()
      const replay = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
        headers: authHeaders(),
        signal: replayController.signal,
      })
      expect(replay.status).toBe(200)
      const events = await readSse(replay, (event) => event.type === 'done')
      const replayedTokens = events
        .filter((event) => event.type === 'token')
        .map((event) => (typeof event.data.content === 'string' ? event.data.content : ''))
        .join('')
      const done = events.find((event) => event.type === 'done')

      expect(events.some((event) => event.type === 'replay_gap')).toBe(expectGap)
      expect(replayedTokens).toBe(expectGap ? '' : fullResult)
      if (expectSnapshot) {
        const terminalSnapshot = done?.data.terminalSnapshot as { href?: unknown } | undefined
        expect(terminalSnapshot?.href).toBe(`/api/v1/generate/chat/${encodeURIComponent(jobId)}/terminal-snapshot`)
        const snapshotResponse = await fetch(`${harness.baseUrl}${terminalSnapshot?.href}`, {
          headers: authHeaders(),
        })
        expect(snapshotResponse.status).toBe(200)
        expect((await snapshotResponse.json()) as Record<string, unknown>).toMatchObject({ result: fullResult })
      } else {
        expect(done?.data.result).toBe(fullResult)
      }
      expect((await waitForAssistantMessage()).data).toBe(fullResult)
      replayController.abort()
    },
    15_000,
  )

  // Resume-after-reload: a fresh client (no in-memory jobId) discovers the running
  // job from bootstrap `activeGenerationJobs` and reattaches.
  it('surfaces a running generation in bootstrap activeGenerationJobs and frees it at completion', async () => {
    const gated = makeGatedProvider({ before: 'Hel', after: 'lo' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res = await postDurable({}, { signal: controller.signal })
    let jobId = ''
    await readSse(res, (ev) => {
      if (ev.type === 'job_accepted') jobId = ev.data.jobId as string
      return ev.type === 'token'
    })

    const boot = await bootstrap()
    // The runtime payload carries the generating mode so reload-resume renders correctly.
    expect(boot.activeGenerationJobs).toContainEqual(expect.objectContaining({ chatId: 'chat-1', jobId, mode: 'send' }))

    // A fresh client reattaches via the discovered id.
    const reController = newController()
    const re = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
      headers: authHeaders(),
      signal: reController.signal,
    })
    gated.release()
    const reEvents = await readSse(re, (ev) => ev.type === 'done')
    expect(reEvents.at(-1)?.type).toBe('done')

    // The submission lock clears at completion, so bootstrap no longer lists it.
    await waitFor(async () => {
      const after = await bootstrap()
      return after.activeGenerationJobs.length === 0 ? true : undefined
    })
    controller.abort()
    reController.abort()
  })

  // Reattaching to an already-completed in-grace job must close server-side
  // instead of dangling the socket until the client hangs up.
  it('closes the connection itself when reattaching to an already-completed job (no leak)', async () => {
    providerImpl = () => {
      async function* g(): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'final text' }
        yield { kind: 'done', finishReason: 'stop' }
      }
      return g()
    }

    const controllerA = newController()
    const resA = await postDurable({}, { signal: controllerA.signal })
    let jobId = ''
    await readSse(resA, (ev) => {
      if (ev.type === 'job_accepted') jobId = ev.data.jobId as string
      return ev.type === 'done'
    })
    controllerA.abort()
    await waitForAssistantMessage()

    // Reattach to the done (in-grace) job and read until the STREAM ENDS. The server
    // must close it on its own; if it leaks, readSse hangs to the test timeout.
    const reController = newController()
    const re = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
      headers: authHeaders(),
      signal: reController.signal,
    })
    const reEvents = await readSse(re, () => false)
    expect(reEvents.some((e) => e.type === 'job_accepted')).toBe(true)
    reController.abort()
  }, 8000)

  // Explicit cancel must leave a truthful protected terminal frame so the same
  // writer can suspend/reload and reconcile the persisted partial row.
  it('reattaches to a cancelled job with a non-success terminal disposition', async () => {
    const gated = makeGatedProvider({ before: 'partial' }) // never released
    providerImpl = gated.dispatchProvider

    const controllerA = newController()
    const resA = await postDurable({}, { signal: controllerA.signal })
    let jobId = ''
    await readSse(resA, (ev) => {
      if (ev.type === 'job_accepted') jobId = ev.data.jobId as string
      return ev.type === 'token'
    })

    const del = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(del.status).toBe(202)

    controllerA.abort()
    const persisted = await waitForAssistantMessage()
    expect(persisted.data).toBe('partial')

    const obsController = newController()
    const obs = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
      headers: authHeaders(),
      signal: obsController.signal,
    })
    const obsEvents = await readSse(obs, (ev) => ev.type === 'done')
    expect(obsEvents.at(-1)).toMatchObject({
      type: 'done',
      data: {
        outcome: 'cancelled',
        result: 'partial',
        generationId: jobId,
        postGeneration: { messageId: jobId, revision: expect.any(Number), finalText: 'partial' },
      },
    })
    controllerA.abort()
    obsController.abort()
  }, 8000)

  it('keeps an accepted append when its durable generation hits the same-chat lock (409)', async () => {
    const gated = makeGatedProvider({ before: 'one' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res1 = await postDurable({}, { signal: controller.signal })
    const firstEvents = await readSse(res1, (ev) => ev.type === 'token')
    const firstJobId = jobIdFromEvents(firstEvents)

    await appendMessage({
      role: 'user',
      data: 'accepted while the remote job runs',
      chatId: 'accepted-user-message',
    })
    expect(
      (await chatMessages(await bootstrap())).filter((message) => message.chatId === 'accepted-user-message'),
    ).toEqual([expect.objectContaining({ role: 'user', data: 'accepted while the remote job runs' })])

    const res2 = await postDurable({ userMessage: 'accepted while the remote job runs' })
    expect(res2.status).toBe(409)
    expect((await res2.json()).error).toBe('generation_in_progress')

    const running = await bootstrap()
    expect(running.activeGenerationJobs).toHaveLength(1)
    expect(running.activeGenerationJobs[0]).toMatchObject({ chatId: 'chat-1', jobId: firstJobId, mode: 'send' })
    expect((await chatMessages(running)).filter((message) => message.chatId === 'accepted-user-message')).toEqual([
      expect.objectContaining({ role: 'user', data: 'accepted while the remote job runs' }),
    ])

    gated.release()
    controller.abort()
  })

  it('runs durable generations for two different chats concurrently and persists both', async () => {
    await seedDatabase({
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [durableChat(), { ...durableChat(), id: 'chat-2', name: 'Chat 2' }],
        },
      ],
    })
    await configureChatForDurableGeneration('chat-2')

    const chatOne = makeGatedProvider({ before: 'one', after: ' complete' })
    const chatTwo = makeGatedProvider({ before: 'two', after: ' complete' })
    providerImpl = (context) =>
      context.input.chatId === 'chat-2' ? chatTwo.dispatchProvider(context) : chatOne.dispatchProvider(context)

    const controllerOne = newController()
    const responseOne = await postDurable({}, { signal: controllerOne.signal })
    const eventsOne = await readSse(responseOne, (event) => event.type === 'token')
    const jobOne = jobIdFromEvents(eventsOne)

    const controllerTwo = newController()
    const responseTwo = await postDurable({ chatId: 'chat-2' }, { signal: controllerTwo.signal })
    const eventsTwo = await readSse(responseTwo, (event) => event.type === 'token')
    const jobTwo = jobIdFromEvents(eventsTwo)

    const running = await bootstrap()
    expect(running.activeGenerationJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chatId: 'chat-1', jobId: jobOne }),
        expect.objectContaining({ chatId: 'chat-2', jobId: jobTwo }),
      ]),
    )
    expect(running.activeGenerationJobs).toHaveLength(2)

    chatOne.release()
    chatTwo.release()

    await waitFor(async () => {
      const boot = await bootstrap()
      const [messagesOne, messagesTwo] = await Promise.all([chatMessages(boot, 'chat-1'), chatMessages(boot, 'chat-2')])
      const resultOne = messagesOne.find((message) => message.role === 'char')
      const resultTwo = messagesTwo.find((message) => message.role === 'char')
      if (resultOne?.data !== 'one complete' || resultTwo?.data !== 'two complete') return undefined
      if (boot.activeGenerationJobs.length !== 0) return undefined
      return true
    })

    controllerOne.abort()
    controllerTwo.abort()
  })

  it('rejects a durable send from a stale (non-active) writer with 423', async () => {
    // writer-a claims the active-writer role via bootstrap.
    const claim = await fetch(`${harness.baseUrl}/api/v1/bootstrap`, {
      headers: authHeaders({ 'risu-writer-session': 'writer-a' }),
    })
    expect(claim.status).toBe(200)

    const res = await postDurable({}, { writerSession: 'writer-b' })
    expect(res.status).toBe(423)
    expect((await res.json()).error).toBe('active_writer_stale')

    // Nothing was started — bootstrap shows no active job and an empty transcript.
    const boot = await bootstrap()
    expect(boot.activeGenerationJobs).toEqual([])
    expect(await chatMessages(boot)).toEqual([])
  })

  it('reports an unconfirmed cancelled partial when its journal insert fails', async () => {
    await resetHarness({ finalizationRetry: false })
    const gated = makeGatedProvider({ before: 'unsaved cancelled partial' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const response = await postDurable({}, { signal: controller.signal })
    const initialEvents = await readSse(response, (event) => event.type === 'token')
    const jobId = jobIdFromEvents(initialEvents)
    const operationId = initialEvents.find((event) => event.type === 'job_accepted')?.data.operationId as string
    const observer = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
      headers: authHeaders(),
    })
    const observerEvents = readSse(observer, () => false)
    executeDatabase(`
      CREATE TRIGGER fail_cancel_retry_insert
      BEFORE INSERT ON generation_finalization_retries
      BEGIN
        SELECT RAISE(FAIL, 'injected cancelled-result journal failure');
      END;
    `)

    const { result: events, metrics } = await captureProtocolMetrics(async () => {
      await cancelJob(jobId)
      return observerEvents
    })
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
    expect(events.some((event) => event.type === 'done')).toBe(false)
    expect(events.find((event) => event.type === 'error')?.data).toMatchObject({
      reason: 'generation_cancel_persistence_failed',
      persistenceDisposition: 'unconfirmed',
      generationProjection: {
        characterId: 'char-1',
        chatId: 'chat-1',
        generationId: jobId,
        mode: 'send',
      },
    })
    expect(generationFinalizationRetryRows()).toEqual([])
    expect((await chatMessages(await bootstrap())).some((message) => message.role === 'char')).toBe(false)
    expect(metrics.find((metric) => metric.metric === 'generation_cancel_persistence')).toMatchObject({
      status: 'journal_error',
      phase: 'journal',
      journalConfirmed: false,
      authoritativeCommitted: false,
    })
    const operationDb = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    try {
      expect(
        operationDb
          .prepare('SELECT state, failure_code AS failureCode FROM generation_operations WHERE operation_id = ?')
          .get(operationId),
      ).toEqual({ state: 'abandoned', failureCode: 'cancel_finalization_journal_unconfirmed' })
    } finally {
      operationDb.close()
    }
    controller.abort()
  })

  it('reports a cancelled partial as queued only when its retry row is replayable', async () => {
    await resetHarness({ finalizationRetry: false })
    const gated = makeGatedProvider({ before: 'queued cancelled partial' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const response = await postDurable({}, { signal: controller.signal })
    const initialEvents = await readSse(response, (event) => event.type === 'token')
    const jobId = jobIdFromEvents(initialEvents)
    const observer = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
      headers: authHeaders(),
    })
    const observerEvents = readSse(observer, () => false)
    executeDatabase(`
      CREATE TRIGGER fail_cancel_message_insert
      BEFORE INSERT ON messages
      WHEN NEW.role = 'char'
      BEGIN
        SELECT RAISE(FAIL, 'injected cancelled-result persistence failure');
      END;
    `)

    await cancelJob(jobId)
    const events = await observerEvents
    expect(events.find((event) => event.type === 'error')?.data.persistenceDisposition).toBe('queued')
    expect(events.some((event) => event.type === 'done')).toBe(false)
    expect(generationFinalizationRetryRows()).toEqual([
      expect.objectContaining({ generation_id: jobId, status: 'pending', failure_count: 1 }),
    ])
    expect((await chatMessages(await bootstrap())).some((message) => message.role === 'char')).toBe(false)

    const blockedAuthority = await operationAuthority()
    const blockedOperationId = randomUUID()
    const blockedMessageId = randomUUID()
    const blocked = await postAtomicOperation(
      blockedAuthority.databaseLineage,
      atomicSendRequest({
        operationId: blockedOperationId,
        acceptedMessageId: blockedMessageId,
        baseRevision: blockedAuthority.revision,
        text: 'must wait for the previous reply',
      }),
    )
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({
      error: 'generation_finalization_pending',
      generationId: jobId,
      message: expect.stringContaining('reply is still saving'),
    })
    const legacyBlocked = await postDurable(
      { userMessage: 'legacy send must also wait' },
      { writerSession: 'writer-a' },
    )
    expect(legacyBlocked.status).toBe(409)
    expect(await legacyBlocked.json()).toMatchObject({
      error: 'generation_finalization_pending',
      generationId: jobId,
      reason: expect.stringContaining('reply is still saving'),
    })
    const blockedDb = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    try {
      expect(blockedDb.prepare('SELECT COUNT(*) AS count FROM messages WHERE uid = ?').get(blockedMessageId)).toEqual({
        count: 0,
      })
    } finally {
      blockedDb.close()
    }

    executeDatabase('DROP TRIGGER fail_cancel_message_insert')
    expect(retryQueuedFinalizationsOnce()).toEqual({ attempted: 1, persisted: 1, terminal: 0, retryable: 0 })
    expect(generationFinalizationRetryRows()).toEqual([])
    expect((await chatMessages(await bootstrap())).find((message) => message.role === 'char')?.data).toBe(
      'queued cancelled partial',
    )

    providerImpl = () =>
      (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'next reply' }
        yield { kind: 'done', finishReason: 'stop' }
      })()
    const releasedAuthority = await operationAuthority()
    const releasedOperationId = randomUUID()
    const releasedMessageId = randomUUID()
    const released = await postAtomicOperation(
      releasedAuthority.databaseLineage,
      atomicSendRequest({
        operationId: releasedOperationId,
        acceptedMessageId: releasedMessageId,
        baseRevision: releasedAuthority.revision,
        text: 'now the next send can start',
      }),
    )
    expect(released.status).toBe(201)
    await waitFor(async () => {
      const status = await operationStatus(releasedOperationId)
      return status.operation.state === 'completed' ? status : undefined
    })
    controller.abort()
  })

  it('lets a new writer cancel a prior writer’s generation (writer handoff)', async () => {
    // writer-a claims, starts a generation, then "disconnects".
    await fetch(`${harness.baseUrl}/api/v1/bootstrap`, {
      headers: authHeaders({ 'risu-writer-session': 'writer-a' }),
    })
    const gated = makeGatedProvider({ before: 'partial' })
    providerImpl = gated.dispatchProvider
    const controller = newController()
    const res = await postDurable({}, { signal: controller.signal, writerSession: 'writer-a' })
    let jobId = ''
    await readSse(res, (ev) => {
      if (ev.type === 'job_accepted') jobId = ev.data.jobId as string
      return ev.type === 'token'
    })
    controller.abort()

    // writer-b becomes the active writer and cancels the abandoned job.
    await fetch(`${harness.baseUrl}/api/v1/bootstrap`, {
      headers: authHeaders({ 'risu-writer-session': 'writer-b' }),
    })
    const del = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      headers: authHeaders({ 'risu-writer-session': 'writer-b' }),
    })
    expect(del.status).toBe(202)

    // After cancel the chat accepts a new generation (the slot is free).
    await waitFor(async () => {
      const boot = await bootstrap()
      return boot.activeGenerationJobs.length === 0 ? true : undefined
    })
  })

  // The durable path runs the post-gen pass, persists the scriptstate delta and
  // assistant message, and folds the bumped revision onto done.postGeneration.
  it('runs the post-generation pass on the durable path and persists the derived result', async () => {
    providerImpl = () => {
      async function* g(): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'reply text' }
        yield { kind: 'done', finishReason: 'stop' }
      }
      return g()
    }
    await seedDatabase({
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          triggerscript: [
            {
              comment: '',
              type: 'output',
              conditions: [],
              effect: [{ type: 'setvar', operator: '=', var: 'mood', value: 'happy' }],
            },
          ],
        },
      ],
    })

    const controller = newController()
    const res = await postDurable({}, { signal: controller.signal })
    const events = await readSse(res, (ev) => ev.type === 'done')
    const done = events.at(-1)!
    expect(done.type).toBe('done')
    const postGeneration = done.data.postGeneration as {
      revision?: number
      messagePatch?: { chatVarMutations?: Array<{ key: string; after: unknown }> }
    }
    expect(postGeneration?.messagePatch?.chatVarMutations).toEqual([{ key: '$mood', before: null, after: 'happy' }])
    expect(typeof postGeneration?.revision).toBe('number')

    const boot = await bootstrap()
    // The derived scriptstate + the assistant message both persisted server-side.
    expect(boot.database.characters[0].chats[0].scriptstate).toEqual({ $mood: 'happy' })
    const assistant = (await chatMessages(boot)).find((m) => m.role === 'char')
    expect(assistant?.data).toBe('reply text')
    controller.abort()
  })

  it.each([
    { scope: 'character_field', key: 'firstMessage' },
    { scope: 'local_lore', key: undefined },
    { scope: 'chat_variable', key: '$mood' },
  ] as const)(
    'durable finalization reconciles a concurrent $scope mutation without losing the generated message',
    async (testCase) => {
      const gated = makeGatedProvider({ before: 'durable conflict-safe', after: ' reply' })
      providerImpl = gated.dispatchProvider
      const outputEffect =
        testCase.scope === 'chat_variable'
          ? [{ type: 'setvar', operator: '=', var: 'mood', value: 'script-value' }]
          : [
              {
                type: 'triggerlua',
                code:
                  testCase.scope === 'character_field'
                    ? `function onOutput(id) setCharacterFirstMessage(id, 'script greeting') end`
                    : `function onOutput(id) upsertLocalLoreBook(id, 'script-lore', 'script lore') end`,
              },
            ]
      await seedDatabase({
        ...fixtureDatabase,
        characters: [
          {
            ...fixtureDatabase.characters[0],
            triggerscript: [
              {
                comment: '',
                type: 'output',
                conditions: [],
                effect: outputEffect,
              },
            ],
          },
        ],
      })

      const controller = newController()
      const response = await postDurable({}, { signal: controller.signal })
      const initialEvents = await readSse(response, (event) => event.type === 'token')
      const jobId = jobIdFromEvents(initialEvents)
      const replay = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
        headers: authHeaders(),
      })
      expect(replay.status).toBe(200)

      if (testCase.scope === 'character_field') {
        await patchCharacterFirstMessage('user greeting')
      } else if (testCase.scope === 'local_lore') {
        await replaceChatLocalLore([
          {
            id: 'user-lore-id',
            key: 'user',
            secondkey: '',
            insertorder: 100,
            comment: 'user-lore',
            content: 'user lore',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
          },
        ])
      } else {
        await patchChatScriptstate({ $mood: 'user-value' })
      }
      gated.release()

      const terminalEvents = await readSse(replay, (event) => event.type === 'done')
      expect(terminalEvents.find((event) => event.type === 'error')).toBeUndefined()
      if (testCase.scope === 'local_lore') {
        expect(terminalEvents.find((event) => event.type === 'warning')).toBeUndefined()
      } else {
        expect(terminalEvents.find((event) => event.type === 'warning')?.data).toMatchObject({
          message: 'Some server script updates were skipped because their targets changed during generation.',
          context: {
            kind: 'stale_generation_script_mutations',
            droppedMutations: [{ scope: testCase.scope, key: testCase.key }],
          },
        })
      }
      const done = terminalEvents.find((event) => event.type === 'done')
      const postGeneration = done?.data.postGeneration as
        | {
            messagePatch?: {
              chatVarMutations?: unknown[]
              characterFieldMutations?: unknown[]
              localLoreMutation?: unknown
            }
          }
        | undefined
      if (testCase.scope === 'character_field') {
        expect(postGeneration?.messagePatch?.characterFieldMutations).toBeUndefined()
      } else if (testCase.scope === 'local_lore') {
        expect(postGeneration?.messagePatch?.localLoreMutation).toMatchObject({
          after: [
            expect.objectContaining({ id: 'user-lore-id', content: 'user lore' }),
            expect.objectContaining({ comment: 'script-lore', content: 'script lore' }),
          ],
        })
      } else {
        expect(postGeneration?.messagePatch?.chatVarMutations ?? []).toEqual([])
      }

      const boot = await bootstrap()
      expect((await chatMessages(boot)).at(-1)).toMatchObject({
        role: 'char',
        data: 'durable conflict-safe reply',
      })
      if (testCase.scope === 'character_field') {
        expect(boot.database.characters[0].firstMessage).toBe('user greeting')
      } else if (testCase.scope === 'local_lore') {
        expect(boot.database.characters[0].chats[0].localLore).toEqual([
          expect.objectContaining({ id: 'user-lore-id', content: 'user lore' }),
          expect.objectContaining({ comment: 'script-lore', content: 'script lore' }),
        ])
      } else {
        expect(boot.database.characters[0].chats[0].scriptstate).toEqual({ $mood: 'user-value' })
      }
      expect(generationFinalizationRetryRows()).toEqual([])
      controller.abort()
    },
  )

  it('rejects stale durable send finalization when the submitted user tail is truncated', async () => {
    await seedChatWithMessages([{ role: 'user', data: 'hi', chatId: 'msg-user-1' }])
    const gated = makeGatedProvider({ before: 'stale', after: ' reply' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res = await postDurable({}, { signal: controller.signal })
    const events = await readSse(res, (ev) => ev.type === 'token')
    const jobId = jobIdFromEvents(events)

    await truncateChat(null)
    gated.release()

    const terminal = await waitForTerminalFinalization(jobId)
    expect(terminal.terminal_error).toContain('stale')
    expect(await chatMessages(await bootstrap())).toEqual([])

    const replay = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
      headers: authHeaders(),
    })
    const replayEvents = await readSse(replay, (event) => event.type === 'error')
    expect(replayEvents.find((event) => event.type === 'error')?.data).toMatchObject({
      reason: 'generation_persistence_failed',
      persistenceDisposition: 'rejected',
      generationProjection: {
        characterId: 'char-1',
        chatId: 'chat-1',
        generationId: jobId,
        mode: 'send',
      },
    })
    controller.abort()
  })

  it('rejects stale durable continue finalization when a newer row is appended after the target', async () => {
    await seedChatWithMessages([
      { role: 'user', data: 'story', chatId: 'msg-user-1' },
      { role: 'char', data: 'Once upon a time', chatId: 'msg-char-1', saying: 'char-1' },
    ])
    const gated = makeGatedProvider({ before: ' and then', after: ' something changed' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res = await postDurable({ mode: 'continue', userMessage: undefined }, { signal: controller.signal })
    const events = await readSse(res, (ev) => ev.type === 'token')
    const jobId = jobIdFromEvents(events)

    await appendMessage({ role: 'user', data: 'newer user turn', chatId: 'msg-user-2' })
    gated.release()

    const terminal = await waitForTerminalFinalization(jobId)
    expect(terminal.terminal_error).toContain('stale')
    const messages = await chatMessages(await bootstrap())
    expect(messages).toEqual([
      { role: 'user', data: 'story', chatId: 'msg-user-1' },
      { role: 'char', data: 'Once upon a time', chatId: 'msg-char-1', saying: 'char-1' },
      { role: 'user', data: 'newer user turn', chatId: 'msg-user-2' },
    ])
    controller.abort()
  })

  it('rejects stale durable continue finalization when an orthogonal target field changes', async () => {
    await seedChatWithMessages([
      { role: 'user', data: 'story', chatId: 'msg-user-1' },
      { role: 'char', data: 'Once upon a time', chatId: 'msg-char-1', saying: 'char-1' },
    ])
    const gated = makeGatedProvider({ before: ' and then', after: ' the end' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res = await postDurable({ mode: 'continue', userMessage: undefined }, { signal: controller.signal })
    const events = await readSse(res, (ev) => ev.type === 'token')
    const jobId = jobIdFromEvents(events)

    await patchMessage('msg-char-1', { disabled: true })
    gated.release()

    const terminal = await waitForTerminalFinalization(jobId)
    expect(terminal.terminal_error).toContain('stale')
    const messages = await chatMessages(await bootstrap())
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      role: 'char',
      data: 'Once upon a time',
      chatId: 'msg-char-1',
      disabled: true,
    })
    expect(messages.some((message) => message.data === 'Once upon a time and then the end')).toBe(false)
    controller.abort()
  })

  it('rejects stale durable regenerate finalization when the target assistant was edited', async () => {
    await seedChatWithMessages([
      { role: 'user', data: 'greet me', chatId: 'msg-user-1' },
      { role: 'char', data: 'old reply', chatId: 'msg-char-1', saying: 'char-1' },
    ])
    const gated = makeGatedProvider({ before: 'new', after: ' reply' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res = await postDurable(
      { mode: 'regenerate', regenerateMessageId: 'msg-char-1', userMessage: undefined },
      { signal: controller.signal },
    )
    const events = await readSse(res, (ev) => ev.type === 'token')
    const jobId = jobIdFromEvents(events)

    await patchMessage('msg-char-1', { data: 'edited old reply' })
    gated.release()

    const terminal = await waitForTerminalFinalization(jobId)
    expect(terminal.terminal_error).toContain('stale')
    const messages = await chatMessages(await bootstrap())
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({ role: 'char', data: 'edited old reply', chatId: 'msg-char-1' })
    expect(messages.some((message) => message.data === 'new reply')).toBe(false)
    controller.abort()
  })

  it.each(['continue', 'regenerate'] as const)(
    'rejects stale durable %s finalization when the admitted target assistant is deleted',
    async (mode) => {
      await seedChatWithMessages(
        [
          { role: 'user', data: mode === 'continue' ? 'story' : 'greet me', chatId: 'msg-user-1' },
          {
            role: 'char',
            data: mode === 'continue' ? 'Once upon a time' : 'old reply',
            chatId: 'msg-char-1',
            saying: 'char-1',
          },
        ],
        { useSayNothing: false },
      )
      const gated = makeGatedProvider({ before: 'partial', after: ' completion' })
      providerImpl = gated.dispatchProvider

      const controller = newController()
      const res = await postDurable(
        mode === 'continue'
          ? { mode, userMessage: undefined }
          : { mode, regenerateMessageId: 'msg-char-1', userMessage: undefined },
        { signal: controller.signal },
      )
      const events = await readSse(res, (event) => event.type === 'token')
      const jobId = jobIdFromEvents(events)

      await deleteMessage('msg-char-1')
      gated.release()

      const terminal = await waitForTerminalFinalization(jobId)
      expect(terminal.terminal_error).toContain('stale')
      expect(await chatMessages(await bootstrap())).toEqual([
        expect.objectContaining({ role: 'user', chatId: 'msg-user-1' }),
      ])
      expect((await chatHydration(await bootstrap())).alternates).toEqual([])

      const replay = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
        headers: authHeaders(),
      })
      const replayEvents = await readSse(replay, (event) => event.type === 'error')
      expect(replayEvents.find((event) => event.type === 'error')?.data).toMatchObject({
        reason: 'generation_persistence_failed',
        persistenceDisposition: 'rejected',
        generationProjection: {
          characterId: 'char-1',
          chatId: 'chat-1',
          generationId: jobId,
          mode,
          ...(mode === 'regenerate' ? { targetMessageId: 'msg-char-1' } : {}),
        },
      })
      controller.abort()
    },
  )

  // Durable continue / regenerate.
  // The durable job finalizes all three generating modes: Continue follows its
  // append/extend disposition, regenerate replaces the target, and send appends.
  // Each survives a mid-stream disconnect, and streaming-cancel persistence is mode-aware too.

  it('survives a disconnect on an append-style durable continue without replacing the prior assistant', async () => {
    await seedChatWithMessages([
      { role: 'user', data: 'tell me a story', chatId: 'msg-user-1' },
      { role: 'char', data: 'Once upon a time', chatId: 'msg-char-1', saying: 'char-1' },
    ])
    const gated = makeGatedProvider({ before: ' and they', after: ' lived happily.' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res = await postDurable({ mode: 'continue', userMessage: undefined }, { signal: controller.signal })
    await readSse(res, (ev) => ev.type === 'token')
    controller.abort() // disconnect mid-stream — the job must keep running

    const running = await bootstrap()
    expect(running.activeGenerationJobs).toContainEqual(
      expect.objectContaining({ chatId: 'chat-1', mode: 'continue', continueDisposition: 'append' }),
    )

    gated.release()
    const appended = await waitFor(async () => {
      const row = (await chatMessages(await bootstrap())).find((m) => m.role === 'char' && m.chatId !== 'msg-char-1')
      return typeof row?.data === 'string' && row.data.includes('lived happily') ? row : undefined
    })
    expect(appended.data).toBe('*says nothing* and they lived happily.')
    const messages = await chatMessages(await bootstrap())
    expect(messages).toHaveLength(3)
    expect(messages[1]).toMatchObject({ chatId: 'msg-char-1', data: 'Once upon a time' })
    expect(messages[2].chatId).not.toBe('msg-char-1')
  })

  it('survives a disconnect on a durable regenerate and replaces the target', async () => {
    await seedChatWithMessages([
      { role: 'user', data: 'greet me', chatId: 'msg-user-1' },
      { role: 'char', data: 'old reply', chatId: 'msg-char-1', saying: 'char-1' },
    ])
    const gated = makeGatedProvider({ before: 'a brand', after: ' new reply' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res = await postDurable(
      { mode: 'regenerate', regenerateMessageId: 'msg-char-1', userMessage: undefined },
      { signal: controller.signal },
    )
    await readSse(res, (ev) => ev.type === 'token')
    controller.abort()

    gated.release()
    const regenerated = await waitFor(async () => {
      const row = (await chatMessages(await bootstrap())).find((m) => m.role === 'char')
      return typeof row?.data === 'string' && row.data.includes('new reply') ? row : undefined
    })
    expect(regenerated.data).toBe('a brand new reply')
    // The old target was REPLACED in place (not duplicated): a single char row under
    // a fresh id, and the old text is gone.
    const messages = await chatMessages(await bootstrap())
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', chatId: 'msg-user-1' })
    expect(messages[1].chatId).not.toBe('msg-char-1')
    expect(messages.some((m) => m.data === 'old reply')).toBe(false)
  })

  it('rejects a durable regenerate when the requested target is no longer authoritative', async () => {
    await seedChatWithMessages([{ role: 'user', data: 'greet me', chatId: 'msg-user-1' }])
    providerImpl = () => {
      async function* gen(): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'a brand new reply' }
        yield { kind: 'done', finishReason: 'stop' }
      }
      return gen()
    }

    const res = await postDurable({
      mode: 'regenerate',
      regenerateMessageId: 'stale-msg-char-1',
      userMessage: undefined,
    })
    const events = await readSse(res, (ev) => ev.type === 'done')
    expect(String(events.find((event) => event.type === 'error')?.data.error)).toMatch(/regenerate message not found/)

    const messages = await chatMessages(await bootstrap())
    expect(messages).toEqual([expect.objectContaining({ role: 'user', chatId: 'msg-user-1' })])
    expect(generationFinalizationRetryRows()).toEqual([])
  })

  it('preserves reroll alternates while durable regenerate keeps its target authoritative', async () => {
    await seedChatWithMessages([
      { role: 'user', data: 'greet me', chatId: 'msg-user-1' },
      { role: 'char', data: 'old reply', chatId: 'msg-char-1', saying: 'char-1' },
    ])
    providerImpl = () => {
      async function* gen(): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'a brand new reply' }
        yield { kind: 'done', finishReason: 'stop' }
      }
      return gen()
    }

    const res = await postDurable({
      mode: 'regenerate',
      regenerateMessageId: 'msg-char-1',
      userMessage: undefined,
    })
    const events = await readSse(res, (ev) => ev.type === 'done')
    expect(events.some((ev) => ev.type === 'error')).toBe(false)

    const hydration = await chatHydration(await bootstrap())
    expect(hydration.message).toHaveLength(2)
    expect(hydration.message[0]).toMatchObject({ role: 'user', chatId: 'msg-user-1' })
    expect(hydration.message[1]).toMatchObject({ role: 'char', data: 'a brand new reply' })
    expect(hydration.alternates).toHaveLength(2)
    expect(hydration.alternates.some((m) => m.chatId === 'msg-char-1' && m.data === 'old reply')).toBe(true)
    expect(
      hydration.alternates.some((m) => m.chatId === hydration.message[1].chatId && m.data === 'a brand new reply'),
    ).toBe(true)
  })

  it('cancels an append-style durable continue without replacing the prior assistant', async () => {
    await seedChatWithMessages([
      { role: 'user', data: 'story', chatId: 'msg-user-1' },
      { role: 'char', data: 'Once upon a time', chatId: 'msg-char-1', saying: 'char-1' },
    ])
    const gated = makeGatedProvider({ before: ' and then' }) // never released
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res = await postDurable({ mode: 'continue', userMessage: undefined }, { signal: controller.signal })
    let jobId = ''
    await readSse(res, (ev) => {
      if (ev.type === 'job_accepted') jobId = ev.data.jobId as string
      return ev.type === 'token'
    })
    await cancelJob(jobId)

    const appended = await waitFor(async () => {
      const row = (await chatMessages(await bootstrap())).find((m) => m.role === 'char' && m.chatId !== 'msg-char-1')
      return typeof row?.data === 'string' && row.data.includes('and then') ? row : undefined
    })
    expect(appended.data).toBe('*says nothing* and then')
    const messages = await chatMessages(await bootstrap())
    expect(messages).toHaveLength(3)
    expect(messages[1]).toMatchObject({ chatId: 'msg-char-1', data: 'Once upon a time' })
    const replayController = newController()
    const replay = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
      headers: authHeaders(),
      signal: replayController.signal,
    })
    const replayEvents = await readSse(replay, (event) => event.type === 'done')
    expect(replayEvents.at(-1)).toMatchObject({
      type: 'done',
      data: {
        outcome: 'cancelled',
        result: ' and then',
        generationId: jobId,
        postGeneration: {
          messageId: appended.chatId,
          revision: expect.any(Number),
          finalText: '*says nothing* and then',
        },
      },
    })
    controller.abort()
    replayController.abort()
  })

  it('cancels an extend-style durable continue by persisting the partial on the original assistant row', async () => {
    await seedChatWithMessages(
      [
        { role: 'user', data: 'story', chatId: 'msg-user-1' },
        { role: 'char', data: 'Once upon a time', chatId: 'msg-char-1', saying: 'char-1' },
      ],
      { useSayNothing: false },
    )
    const gated = makeGatedProvider({ before: ' and then' }) // never released
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res = await postDurable({ mode: 'continue', userMessage: undefined }, { signal: controller.signal })
    let jobId = ''
    await readSse(res, (event) => {
      if (event.type === 'job_accepted') jobId = event.data.jobId as string
      return event.type === 'token'
    })
    await cancelJob(jobId)

    await waitFor(async () => {
      const row = (await chatMessages(await bootstrap())).find((message) => message.chatId === 'msg-char-1')
      return row?.data === 'Once upon a time and then' ? row : undefined
    })
    const hydration = await chatHydration(await bootstrap())
    expect(hydration.message).toEqual([
      expect.objectContaining({ role: 'user', data: 'story', chatId: 'msg-user-1' }),
      expect.objectContaining({ role: 'char', data: 'Once upon a time and then', chatId: 'msg-char-1' }),
    ])
    expect(hydration.alternates).toEqual([])
    expect(generationFinalizationRetryRows()).toEqual([])

    const replayController = newController()
    const replay = await fetch(`${harness.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
      headers: authHeaders(),
      signal: replayController.signal,
    })
    const replayEvents = await readSse(replay, (event) => event.type === 'done')
    expect(replayEvents.at(-1)).toMatchObject({
      type: 'done',
      data: {
        outcome: 'cancelled',
        result: ' and then',
        generationId: jobId,
        continueDisposition: 'extend',
        continueBase: 'Once upon a time',
        postGeneration: {
          messageId: 'msg-char-1',
          revision: expect.any(Number),
          finalText: 'Once upon a time and then',
        },
      },
    })
    controller.abort()
    replayController.abort()
  })

  it('cancels a durable regenerate and replaces the target with the streamed-so-far text', async () => {
    await seedChatWithMessages([
      { role: 'user', data: 'greet me', chatId: 'msg-user-1' },
      { role: 'char', data: 'old reply', chatId: 'msg-char-1', saying: 'char-1' },
    ])
    const gated = makeGatedProvider({ before: 'partial regen' }) // never released
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res = await postDurable(
      { mode: 'regenerate', regenerateMessageId: 'msg-char-1', userMessage: undefined },
      { signal: controller.signal },
    )
    let jobId = ''
    await readSse(res, (ev) => {
      if (ev.type === 'job_accepted') jobId = ev.data.jobId as string
      return ev.type === 'token'
    })
    await cancelJob(jobId)

    await waitFor(async () => {
      const row = (await chatMessages(await bootstrap())).find((m) => m.role === 'char')
      return row?.data === 'partial regen' ? row : undefined
    })
    const messages = await chatMessages(await bootstrap())
    // Replaced the target with the partial text, not duplicated; old text gone.
    expect(messages).toHaveLength(2)
    expect(messages.some((m) => m.data === 'old reply')).toBe(false)
    expect(messages[1].chatId).not.toBe('msg-char-1')
    controller.abort()
  })

  it('surfaces the generating mode + regenerate target on activeGenerationJobs', async () => {
    await seedChatWithMessages([
      { role: 'user', data: 'greet me', chatId: 'msg-user-1' },
      { role: 'char', data: 'old reply', chatId: 'msg-char-1', saying: 'char-1' },
    ])
    const gated = makeGatedProvider({ before: 'partial' }) // never released — keeps the job running
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res = await postDurable(
      { mode: 'regenerate', regenerateMessageId: 'msg-char-1', userMessage: undefined },
      { signal: controller.signal },
    )
    let jobId = ''
    await readSse(res, (ev) => {
      if (ev.type === 'job_accepted') jobId = ev.data.jobId as string
      return ev.type === 'token'
    })

    const boot = await bootstrap()
    expect(boot.activeGenerationJobs).toContainEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        jobId,
        mode: 'regenerate',
        regenerateMessageId: 'msg-char-1',
      }),
    )
    gated.release()
    controller.abort()
  })

  it('rejects a second durable generation (continue) while one is running for the chat (409)', async () => {
    await seedChatWithMessages([
      { role: 'user', data: 'story', chatId: 'msg-user-1' },
      { role: 'char', data: 'Once upon a time', chatId: 'msg-char-1', saying: 'char-1' },
    ])
    const gated = makeGatedProvider({ before: ' more' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res1 = await postDurable({ mode: 'continue', userMessage: undefined }, { signal: controller.signal })
    await readSse(res1, (ev) => ev.type === 'token')

    const res2 = await postDurable({ mode: 'continue', userMessage: undefined })
    expect(res2.status).toBe(409)
    expect((await res2.json()).error).toBe('generation_in_progress')

    gated.release()
    controller.abort()
  })

  // If the target chat is gone at completion, persistence fails gracefully with a
  // job error and no bad write.
  it('records a job error when the target chat vanishes mid-generation (gotcha C)', async () => {
    const gated = makeGatedProvider({ before: 'Hel', after: 'lo' })
    providerImpl = gated.dispatchProvider

    const controller = newController()
    const res = await postDurable({}, { signal: controller.signal })
    let jobId = ''
    const live: ParsedEvent[] = []
    // Read live on this connection through to a terminal frame.
    const livePromise = (async () => {
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            const ev = parseSseBlock(block)
            if (!ev) continue
            if (ev.type === 'job_accepted') jobId = ev.data.jobId as string
            live.push(ev)
            if (ev.type === 'error' || ev.type === 'done') return
          }
        }
      } catch {
        /* dropped */
      } finally {
        reader.releaseLock()
      }
    })()

    await waitFor(async () => (jobId.length > 0 ? true : undefined))
    // Replace the whole database so chat-1 no longer exists, then let the job finish.
    await seedDatabase({
      ...fixtureDatabase,
      characters: [{ ...fixtureDatabase.characters[0], chats: [] }],
    })
    gated.release()
    await livePromise

    expect(live.some((e) => e.type === 'error')).toBe(true)
    // No bad write: the imported db has no chat-1 to receive a message.
    const boot = await bootstrap()
    expect(boot.database.characters[0].chats).toEqual([])
    const terminalRow = await waitFor(async () => {
      const row = generationFinalizationRetryRows()[0]
      return row?.status === 'terminal' ? row : undefined
    })
    expect(terminalRow.failure_count).toBeGreaterThan(0)
    expect(terminalRow.terminal_error).toContain('Chat not found')
    controller.abort()
  })

  it('returns 404 reattaching/cancelling an unknown job', async () => {
    const re = await fetch(`${harness.baseUrl}/api/v1/generate/chat/no-such-job/stream`, {
      headers: authHeaders(),
    })
    expect(re.status).toBe(404)
    const del = await fetch(`${harness.baseUrl}/api/v1/generate/chat/no-such-job`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(del.status).toBe(404)
    expect(await del.json()).toMatchObject({ disposition: 'not_found', error: 'generation_job_not_found' })
  })

  // A non-durable send (no durable flag) keeps the inline connection-scoped flow and
  // is NOT tracked as an active generation job.
  it('leaves a non-durable send on the inline flow (no active job tracked)', async () => {
    providerImpl = () => {
      async function* g(): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'inline reply' }
        yield { kind: 'done', finishReason: 'stop' }
      }
      return g()
    }
    const res = await postDurable({ durable: false })
    const events = await readSse(res, (ev) => ev.type === 'done')
    expect(events.some((e) => e.type === 'job_accepted')).toBe(false)
    expect(events.at(-1)?.type).toBe('done')
    const boot = await bootstrap()
    expect(boot.activeGenerationJobs).toEqual([])
  })

  // Shutdown records system abandonment before aborting the detached runner.
  // It must not reinterpret a server shutdown as a user-cancelled partial.
  it('abandons detached runners before closing the database on shutdown', async () => {
    const gated = makeGatedProvider({ before: 'partial shutdown text' }) // never released
    providerImpl = gated.dispatchProvider
    const local = await startHarness()
    let localDataDirKept: string | null = local.dataDir
    try {
      const { assertion: localAssertion } = await setupAuthedClient(local.app)
      await seedDatabaseForHarness(local, localAssertion, fixtureDatabase)

      const controller = newController()
      const res = await fetch(`${local.baseUrl}/api/v1/generate/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'risu-auth': localAssertion },
        body: JSON.stringify({
          chatId: 'chat-1',
          characterId: 'char-1',
          mode: 'send',
          userMessage: 'hi',
          durable: true,
        }),
        signal: controller.signal,
      })
      const initialEvents = await readSse(res, (ev) => ev.type === 'token')
      const operationId = initialEvents.find((event) => event.type === 'job_accepted')?.data.operationId as string
      controller.abort() // bare disconnect; the job keeps running

      // Shutdown aborts the job after committing explicit system abandonment.
      await local.app.close()

      const db = new DatabaseSync(path.join(local.dataDir, 'risu.db'), { readOnly: true })
      try {
        const rows = db
          .prepare("SELECT data FROM messages WHERE chat_id = 'chat-1' AND alternate = 0 ORDER BY seq")
          .all() as Array<{ data: string }>
        expect(rows.map((row) => row.data)).not.toContain('partial shutdown text')
        const operation = db
          .prepare('SELECT state, failure_code AS failureCode FROM generation_operations WHERE operation_id = ?')
          .get(operationId) as { state: string; failureCode: string }
        expect(operation).toEqual({ state: 'abandoned', failureCode: 'server_shutdown' })
      } finally {
        db.close()
      }
    } finally {
      if (localDataDirKept) rmSync(localDataDirKept, { recursive: true, force: true })
      localDataDirKept = null
    }
  })

  it('lets an acknowledged stopping runner persist its partial before graceful shutdown closes SQLite', async () => {
    const gated = makeGatedProvider({ before: 'partial stopped during shutdown' })
    providerImpl = gated.dispatchProvider
    let markCancelPersistenceStarted!: () => void
    const cancelPersistenceStarted = new Promise<void>((resolve) => {
      markCancelPersistenceStarted = resolve
    })
    let releaseCancelPersistence!: () => void
    const cancelPersistenceGate = new Promise<void>((resolve) => {
      releaseCancelPersistence = resolve
    })
    durableLifecycleHook = async (transition) => {
      if (transition !== 'cancel_persistence_started') return
      markCancelPersistenceStarted()
      await cancelPersistenceGate
    }

    const local = await startHarness()
    let localClosed = false
    try {
      const { assertion: localAssertion } = await setupAuthedClient(local.app)
      await seedDatabaseForHarness(local, localAssertion, fixtureDatabase)
      const controller = newController()
      const response = await fetch(`${local.baseUrl}/api/v1/generate/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'risu-auth': localAssertion },
        body: JSON.stringify({
          chatId: 'chat-1',
          characterId: 'char-1',
          mode: 'send',
          userMessage: 'hi',
          durable: true,
        }),
        signal: controller.signal,
      })
      const initialEvents = await readSse(response, (event) => event.type === 'token')
      const jobId = jobIdFromEvents(initialEvents)
      const operationId = initialEvents.find((event) => event.type === 'job_accepted')?.data.operationId as string

      const cancellation = await fetch(`${local.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: { 'risu-auth': localAssertion },
      })
      expect(cancellation.status).toBe(202)
      await cancelPersistenceStarted

      const close = local.app.close()
      releaseCancelPersistence()
      await close
      localClosed = true

      const db = new DatabaseSync(path.join(local.dataDir, 'risu.db'), { readOnly: true })
      try {
        expect(
          db
            .prepare("SELECT data FROM messages WHERE chat_id = 'chat-1' AND role = 'char' ORDER BY seq DESC LIMIT 1")
            .get(),
        ).toEqual({ data: 'partial stopped during shutdown' })
        expect(
          db
            .prepare(
              'SELECT state, result_message_id AS resultMessageId FROM generation_operations WHERE operation_id = ?',
            )
            .get(operationId),
        ).toEqual({ state: 'cancelled', resultMessageId: jobId })
      } finally {
        db.close()
      }
    } finally {
      releaseCancelPersistence?.()
      if (!localClosed) await local.app.close()
      rmSync(local.dataDir, { recursive: true, force: true })
    }
  })

  // A long silent window (slow assembly / provider connect) must not look idle
  // to intermediary proxies: the viewer gets SSE comment heartbeats, which are
  // invisible to the frame parser and never enter the replay buffer (audit L14).
  it('heartbeats the durable SSE viewer during silent windows', async () => {
    const gated = makeGatedProvider({ before: 'Hel', after: 'lo' })
    providerImpl = gated.dispatchProvider
    const local = await startHarness({ viewerHeartbeatMs: 25 })
    try {
      const { assertion: localAssertion } = await setupAuthedClient(local.app)
      await seedDatabaseForHarness(local, localAssertion, fixtureDatabase)

      const controller = newController()
      const res = await fetch(`${local.baseUrl}/api/v1/generate/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'risu-auth': localAssertion },
        body: JSON.stringify({
          chatId: 'chat-1',
          characterId: 'char-1',
          mode: 'send',
          userMessage: 'hi',
          durable: true,
        }),
        signal: controller.signal,
      })

      // Read raw SSE text: the provider is gated after the first token, so the
      // stream goes silent — the comment heartbeat must arrive on its own.
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let raw = ''
      let jobId = ''
      const deadline = Date.now() + 5_000
      while (!raw.includes(': heartbeat\n\n')) {
        if (Date.now() > deadline) throw new Error('no viewer heartbeat observed')
        const { value, done } = await reader.read()
        if (done) break
        raw += decoder.decode(value, { stream: true })
        const accepted = /event: job_accepted\ndata: (\{[^\n]*\})/.exec(raw)
        if (accepted) jobId = (JSON.parse(accepted[1]) as { jobId: string }).jobId
      }
      expect(raw).toContain(': heartbeat\n\n')
      expect(jobId).not.toBe('')
      controller.abort()
      reader.releaseLock()

      // Heartbeats are per-viewer keep-alives: the reattach replay buffer must
      // not contain them.
      gated.release()
      const re = await fetch(`${local.baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
        headers: { 'risu-auth': localAssertion },
      })
      const replayEvents = await readSse(re, (ev) => ev.type === 'done')
      expect(replayEvents.at(-1)?.type).toBe('done')
    } finally {
      local.app.server.closeAllConnections()
      await local.app.close()
      rmSync(local.dataDir, { recursive: true, force: true })
    }
  })
})
