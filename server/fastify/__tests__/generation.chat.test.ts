import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, webcrypto } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { listPersistedCommandEventHistory } from '../src/commands/events.js'
import { openDatabase } from '../src/db.js'
import { applyImport, assetById, hydrateAssemblyModuleBodies, listInlayCatalogEntries } from '../src/repository.js'
import type { CompletionStreamFrame } from '../src/generation/frames.js'
import { clearOpenRouterFreeModelCacheForTests } from '../src/generation/openrouterFreeModel.js'
import { type ChatProviderDispatchContext, type GenerationChatRouteOptions } from '../src/routes/generationChat.js'
import { normalizeRisuSaveSnapshotDatabase } from '../src/risuSave/importSnapshot.js'
import { saveSelectedPersonaSnapshot } from '../src/commands/personas.js'
import { LLMFlags, LLMFormat, LLMTokenizer } from '@risuai/shared-core/model-types'
import { extractModelPresetFields, extractPromptPresetFields } from '@risuai/shared-core/preset-split'
import { assertCommandMetricGate, type CommandMutationMetric } from './helpers/commandMetricGates.js'
import { parseEvents, type PromptChatFrame } from './helpers/terminalFrameAssertions.js'
import {
  getChatMessageDiffInstrumentation,
  resetChatMessageDiffInstrumentation,
  resolveActiveMessageLocationById,
} from '../src/messageStore.js'
import { summarizePromptRows, type PromptRowSummary } from '../src/prompt/promptSummary.js'
import type { GenerationTraceOptions, GenerationTraceSidecarEntry } from '../src/generation/generationTraceSidecar.js'
import { runServerMessageTranslation } from '../src/translation/serverMessageTranslation.js'
import type { ServerMessageTranslationRunner } from '../src/translation/generationCompletionTranslation.js'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { createMemoryChunk, createMemoryEmbedding, createMemorySummary } from '../src/memoryRepository.js'
import { createBardWikiDocument } from '../src/bardWikiRepository.js'
import { DEFAULT_BARDWIKI_GLOBAL_SETTINGS } from '@risuai/protocol'

vi.mock('../src/generation/horde.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/generation/horde.js')>()
  return {
    ...actual,
    // Route tests own request mapping; horde.test.ts owns real poll cadence.
    runHorde: (request: Parameters<typeof actual.runHorde>[0]) =>
      actual.runHorde({ ...request, pollIntervalMs: request.pollIntervalMs ?? 1 }),
  }
})

const subtle = webcrypto.subtle

interface Harness {
  app: FastifyInstance
  dataDir: string
}

async function startHarness(
  generationChat?: GenerationChatRouteOptions,
  generationTrace?: GenerationTraceOptions,
): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      generationTrace,
    },
    generationChat,
    bardWikiWorker: false,
  })
  return { app, dataDir }
}

async function stopHarness(h: Harness): Promise<void> {
  await h.app.close()
  rmSync(h.dataDir, { recursive: true, force: true })
}

async function restartHarness(
  generationChat: GenerationChatRouteOptions,
  generationTrace?: GenerationTraceOptions,
): Promise<void> {
  await stopHarness(harness)
  harness = await startHarness(generationChat, generationTrace)
}

async function signAssertion(privateKey: CryptoKey, publicJwk: JsonWebKey, ttlSec = 60): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'ES256', typ: 'JWT' }
  const payload = { iat: now, exp: now + ttlSec, pub: publicJwk }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signingInput = `${headerB64}.${payloadB64}`
  const signature = await subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    Buffer.from(signingInput),
  )
  const sigB64 = Buffer.from(signature).toString('base64url')
  return `${signingInput}.${sigB64}`
}

async function setupAuthedClient(app: FastifyInstance): Promise<{ assertion: string }> {
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { password: 'hunter2' },
  })
  expect(setup.statusCode).toBe(200)

  const keypair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicKey = await subtle.exportKey('jwk', keypair.publicKey)

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'hunter2', publicKey },
  })
  expect(login.statusCode).toBe(200)

  const assertion = await signAssertion(keypair.privateKey, publicKey)
  return { assertion }
}

let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await stopHarness(harness)
})

const basePayload = {
  chatId: 'chat-1',
  characterId: 'char-1',
  mode: 'send',
  userMessage: 'hi',
}

/** A minimal but complete database the assembler can flatten. */
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
      chats: [{ id: 'chat-1', message: [], note: '', name: 'Chat', localLore: [] }],
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
  mainPrompt: 'MAIN',
  maxContext: 100_000,
  maxResponse: 50,
}

type JsonRecord = Record<string, unknown>

const DEFAULT_TEST_PERSONA_ID = 'persona-default'
const DEFAULT_TEST_MODEL_PRESET_ID = 'model-preset-default'
const DEFAULT_TEST_PROMPT_PRESET_ID = 'prompt-preset-default'

function normalizeGenerationFixtureDatabase(database: unknown): unknown {
  const normalized = structuredClone(database)
  if (!isJsonRecord(normalized)) return normalized

  ensureDefaultFixturePersona(normalized)
  ensureDefaultFixturePresets(normalized)
  fillDefaultChatGenerationSettings(normalized)

  return normalized
}

function ensureDefaultFixturePersona(database: JsonRecord): void {
  if (!Array.isArray(database.personas) || database.personas.length === 0) {
    const personas: Parameters<typeof saveSelectedPersonaSnapshot>[1] = [
      {
        id: DEFAULT_TEST_PERSONA_ID,
        name: 'User',
        icon: '',
        personaPrompt: '',
        note: '',
      },
    ]
    database.personas = personas
    database.selectedPersona = 0
    database.selectedPersonaId = DEFAULT_TEST_PERSONA_ID
    saveSelectedPersonaSnapshot(database, personas)
  }
}

function ensureDefaultFixturePresets(database: JsonRecord): void {
  if (!Array.isArray(database.modelPresets) || database.modelPresets.length === 0) {
    const modelFields = extractModelPresetFields(database)
    delete modelFields.modelProfiles
    delete modelFields.modelProfileOrder
    delete modelFields.modelRoleProfiles
    delete modelFields.modelRuntimeDefaults
    database.modelPresets = [
      {
        ...modelFields,
        id: DEFAULT_TEST_MODEL_PRESET_ID,
        name: 'Default Model',
        maxContext: database.maxContext ?? 100_000,
        maxResponse: database.maxResponse ?? 50,
      },
    ]
    database.modelPresetsId = 0
  }

  if (!Array.isArray(database.promptPresets) || database.promptPresets.length === 0) {
    database.promptPresets = [
      {
        ...extractPromptPresetFields(database),
        id: DEFAULT_TEST_PROMPT_PRESET_ID,
        name: 'Default Prompt',
        mainPrompt: database.mainPrompt ?? 'MAIN',
        formatingOrder: database.formatingOrder ?? ['main', 'description', 'chats'],
        promptSettings: database.promptSettings ?? {
          assistantPrefill: '',
          postEndInnerFormat: '',
          sendChatAsSystem: false,
          sendName: false,
          utilOverride: false,
        },
        customPromptTemplateToggle: '',
      },
    ]
    database.promptPresetsId = 0
  }
}

function fillDefaultChatGenerationSettings(database: JsonRecord): void {
  const personaId = firstId(database.personas, DEFAULT_TEST_PERSONA_ID)
  const modelPresetId = firstId(database.modelPresets, DEFAULT_TEST_MODEL_PRESET_ID)
  const promptPresetId = firstId(database.promptPresets, DEFAULT_TEST_PROMPT_PRESET_ID)
  const characters = Array.isArray(database.characters) ? database.characters : []
  for (const character of characters) {
    if (!isJsonRecord(character) || !Array.isArray(character.chats)) continue
    for (const chat of character.chats) {
      if (!isJsonRecord(chat)) continue
      if (Object.prototype.hasOwnProperty.call(chat, 'generationSettings')) continue
      chat.generationSettings = {
        configured: true,
        personaId,
        modelPresetId,
        promptPresetId,
        jailbreakToggle: database.jailbreakToggle === true,
        sidebarToggles: {},
      }
    }
  }
}

function firstId(collection: unknown, fallback: string): string {
  if (!Array.isArray(collection)) return fallback
  const first = collection.find((item) => isJsonRecord(item) && typeof item.id === 'string')
  return isJsonRecord(first) && typeof first.id === 'string' ? first.id : fallback
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function seedDatabase(_app: FastifyInstance, _assertion: string, database: unknown): Promise<number> {
  const db = openDatabase(harness.dataDir)
  try {
    const result = await applyImport(
      db,
      harness.dataDir,
      normalizeRisuSaveSnapshotDatabase(normalizeGenerationFixtureDatabase(database)),
    )
    return result.revision
  } finally {
    db.close()
  }
}

function overwritePersistedLocalLore(localLore: readonly unknown[]): void {
  const db = openDatabase(harness.dataDir)
  try {
    const row = db.prepare('SELECT data_json FROM chats WHERE id = ?').get('chat-1') as
      | { data_json: string }
      | undefined
    if (!row) throw new Error('chat-1 fixture row not found')
    const chat = JSON.parse(row.data_json) as Record<string, unknown>
    chat.localLore = localLore
    db.prepare('UPDATE chats SET data_json = ? WHERE id = ?').run(JSON.stringify(chat), 'chat-1')
  } finally {
    db.close()
  }
}

function seedSimilarMemoryRows(): void {
  const db = openDatabase(harness.dataDir)
  try {
    createMemoryChunk(db, {
      id: 'memory-cat-chunk',
      chatId: 'chat-1',
      rangeStartSeq: 0,
      rangeEndSeq: 0,
      text: 'A remembered cat curled up in the library.',
      status: 'summarized',
    })
    createMemorySummary(db, {
      id: 'memory-cat-summary',
      chatId: 'chat-1',
      chunkId: 'memory-cat-chunk',
      model: 'subModel',
      text: 'A remembered cat curled up in the library.',
      tokens: 10,
    })
    createMemoryEmbedding(db, {
      id: 'memory-cat-embedding',
      chatId: 'chat-1',
      chunkId: 'memory-cat-chunk',
      model: 'custom',
      vector: [1, 0],
    })

    createMemoryChunk(db, {
      id: 'memory-dog-chunk',
      chatId: 'chat-1',
      rangeStartSeq: 1,
      rangeEndSeq: 1,
      text: 'A remembered dog chased a ball in the park.',
      status: 'summarized',
    })
    createMemorySummary(db, {
      id: 'memory-dog-summary',
      chatId: 'chat-1',
      chunkId: 'memory-dog-chunk',
      model: 'subModel',
      text: 'A remembered dog chased a ball in the park.',
      tokens: 10,
    })
    createMemoryEmbedding(db, {
      id: 'memory-dog-embedding',
      chatId: 'chat-1',
      chunkId: 'memory-dog-chunk',
      model: 'custom',
      vector: [0, 1],
    })
  } finally {
    db.close()
  }
}

function seedBardWikiDocument(input: { contextPolicy?: 'relevant' | 'pinned'; markdown?: string } = {}): void {
  const db = openDatabase(harness.dataDir)
  try {
    createBardWikiDocument(db, {
      id: 'bardwiki-alice',
      chatId: 'chat-1',
      kind: 'character',
      title: 'Alice',
      logicalPath: 'Characters/Alice',
      aliases: [],
      contextPolicy: input.contextPolicy ?? 'relevant',
      reviewState: 'active',
      markdown: input.markdown ?? '## Alice\n\nAlice is a ranger. BARDWIKI_PRIVATE_BODY',
      commandRevision: 1,
    })
  } finally {
    db.close()
  }
}

function similarityMemoryDatabase(): unknown {
  return {
    ...fixtureDatabase,
    maxContext: 100,
    maxResponse: 10,
    hypaV3: true,
    hypaModel: 'custom',
    hypaCustomSettings: {
      url: 'https://embeddings.example.test/v1',
      key: 'custom-key',
      model: 'custom-query-model',
    },
    hypaV3PresetId: 0,
    hypaV3Presets: [
      {
        name: 'Similarity only',
        settings: {
          summarizationModel: 'subModel',
          memoryTokensRatio: 0.1,
          recentMemoryRatio: 0,
          similarMemoryRatio: 1,
          queryChatCount: 1,
        },
      },
    ],
    characters: [
      {
        ...fixtureDatabase.characters[0],
        supaMemory: true,
      },
    ],
  }
}

async function readPersistedMessages(
  assertion: string,
  chatId = 'chat-1',
): Promise<Array<{ role: string; data: string; chatId: string; generationInfo?: Record<string, unknown> }>> {
  const res = await harness.app.inject({
    method: 'GET',
    url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    headers: { 'risu-auth': assertion },
  })
  expect(res.statusCode).toBe(200)
  return res.json().message
}

async function importRisuSaveDatabase(app: FastifyInstance, assertion: string, database: unknown): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion },
    payload: { database },
  })
  expect(res.statusCode).toBe(200)
  return res.json().revision as number
}

interface ProtocolMetric {
  metric: string
  type?: string
  status?: string
  chatId?: string
  characterId?: string
  mode?: string
  requestId?: string
  requestUid?: string
  xRisuCaller?: string
  loadoutId?: string
  expectedRevision?: number
  inlayAssetsCount?: number
  inlayAssetRefsCount?: number
  durable?: boolean
  compactPromptEvent?: boolean
  generationId?: string
  durableJobId?: string
  revision?: number
  durationMs?: number
  promptMs?: number
  databaseLoadCount?: number
  databaseLoadMs?: number
  stageTimingsMs?: Record<string, number>
  chatVarMutationCount?: number
  persistMessages?: boolean
  hasVarWrite?: boolean
  eventType?: string
  mutationPath?: string
  dbJsonWriteMs?: number
  loadMs?: number
  totalMs?: number
  writtenTables?: string[]
  fallbackType?: string
  targetMessageId?: string
  targetSnapshotKind?: string
  targetSnapshotTranscriptLength?: number
  completionLength?: number
  completionBytes?: number
  completionSha256?: string
  error?: string
  source?: string
  promptHash?: string
  promptRowCount?: number
  promptRoleSequence?: string
  promptRows?: PromptRowSummary[]
  promptContentBytes?: number
  promptContentChars?: number
  promptMultimodalCount?: number
  promptMultimodalBase64Bytes?: number
  inputTokens?: number
  outputTokens?: number
  modelPresetId?: string
  promptPresetId?: string
  activeModuleCount?: number
  activeModuleIds?: string[]
  lorebookActivationCount?: number
  lorebookActivationSourceCount?: number
  messageMutationCount?: number
  additionalSystemPromptMutationCount?: number
  varChanged?: boolean
  submitTranscriptChanged?: boolean
  persistedRevision?: number
  shouldDispatch?: boolean
  promptEventHasFormated?: boolean
  promptEventHasMessages?: boolean
  promptEventHasLorebookActivation?: boolean
  promptEventHasPromptInfo?: boolean
  bardWikiReason?: string
  bardWikiQueryHash?: string
  bardWikiCandidateCount?: number
  bardWikiSelectedCount?: number
  bardWikiRetainedCount?: number
  bardWikiTrimmedCount?: number
  bardWikiConsumedTokens?: number
  bardWikiSelectedDocumentIds?: string[]
  bardWikiSelectedContentHashes?: string[]
  bardWikiFinalPromptRowCount?: number
  fullPromptSidecar?: GenerationTraceSidecarEntry
  bodySidecar?: GenerationTraceSidecarEntry
  runCount?: number
  hostEventCount?: number
  logCount?: number
  llmAttemptCount?: number
  llmBlockedCount?: number
  axLlmAttemptCount?: number
  axLlmCompletedCount?: number
  setChatCount?: number
  setChatChangedCount?: number
  transcriptChanged?: boolean
  editOutputTextChanged?: boolean
  runs?: Array<Record<string, unknown>>
}

const EXPECTED_PROMPT_ASSEMBLY_STAGES = [
  'scope_resolution',
  'submit_transforms',
  'static_plain_slots',
  'lorebook_preflight',
  'history_bias',
  'memory_bridge',
  'final_render',
  'budget',
] as const

function expectPromptAssemblyStageTimings(metric: ProtocolMetric | undefined): void {
  expect(metric?.stageTimingsMs).toBeDefined()
  for (const stage of EXPECTED_PROMPT_ASSEMBLY_STAGES) {
    expect(metric?.stageTimingsMs?.[stage]).toBeGreaterThanOrEqual(0)
  }
}

async function withProtocolMetrics<T>(
  run: (metrics: ProtocolMetric[], rawMetricLines: string[]) => Promise<T>,
): Promise<T> {
  const previous = process.env.RISU_PROTOCOL_METRICS
  const metrics: ProtocolMetric[] = []
  const rawMetricLines: string[] = []
  process.env.RISU_PROTOCOL_METRICS = '1'
  const infoSpy = vi.spyOn(console, 'info').mockImplementation((message: unknown) => {
    if (typeof message !== 'string' || !message.startsWith('[protocol-metric] ')) return
    rawMetricLines.push(message)
    metrics.push(JSON.parse(message.slice('[protocol-metric] '.length)) as ProtocolMetric)
  })
  try {
    return await run(metrics, rawMetricLines)
  } finally {
    infoSpy.mockRestore()
    if (previous === undefined) {
      delete process.env.RISU_PROTOCOL_METRICS
    } else {
      process.env.RISU_PROTOCOL_METRICS = previous
    }
  }
}

function readGenerationSidecar(dataDir: string, entry: GenerationTraceSidecarEntry | undefined): unknown {
  expect(entry).toMatchObject({ status: 'written', path: expect.stringMatching(/^trace\/generation\/.+\.json\.gz$/) })
  const sidecar = entry as Extract<GenerationTraceSidecarEntry, { status: 'written' }>
  return JSON.parse(gunzipSync(readFileSync(path.join(dataDir, sidecar.path))).toString('utf8'))
}

async function listenHarness(): Promise<string> {
  await harness.app.listen({ port: 0, host: '127.0.0.1' })
  const address = harness.app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('test harness did not bind to a TCP address')
  }
  return `http://127.0.0.1:${(address as AddressInfo).port}`
}

function authHeaders(assertion: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'risu-auth': assertion, ...extra }
}

async function readStreamingEvents(
  res: Response,
  until: (frame: PromptChatFrame) => boolean,
): Promise<PromptChatFrame[]> {
  expect(res.body).toBeTruthy()
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const events: PromptChatFrame[] = []
  let buffer = ''

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let frameEnd: number
      while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, frameEnd)
        buffer = buffer.slice(frameEnd + 2)
        if (
          !block
            .replace(/\r/g, '')
            .split('\n')
            .some((line) => line.startsWith('event: '))
        ) {
          continue
        }
        const [frame] = parseEvents(`${block}\n\n`)
        events.push(frame)
        if (until(frame)) return events
      }
    }
  } catch {
    // The test may intentionally abort the client after the terminal proof.
  } finally {
    reader.releaseLock()
  }

  return events
}

describe('POST /api/v1/generate/chat', () => {
  it('returns 401 without auth once a password is set', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      payload: basePayload,
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a body missing chatId with 400', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, chatId: undefined },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'chatId is required' })
  })

  it('rejects a body missing characterId with 400', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, characterId: undefined },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'characterId is required' })
  })

  it('rejects an unrecognized mode with 400', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, mode: 'shout' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/mode must be one of/)
  })

  it('rejects mode=send without userMessage or an explicit empty-send marker', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, userMessage: undefined },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: 'userMessage or emptySend is required when mode is "send"',
    })
  })

  it.each([
    {
      name: 'a non-boolean empty-send marker',
      payload: { ...basePayload, userMessage: undefined, emptySend: 'yes' },
      error: 'emptySend must be a boolean when provided',
    },
    {
      name: 'an empty-send marker with user text',
      payload: { ...basePayload, emptySend: true },
      error: 'emptySend requires mode "send" without userMessage',
    },
  ])('rejects $name', async ({ payload, error }) => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error })
  })

  it.each([
    {
      name: 'a non-boolean marker',
      payload: { ...basePayload, syntheticSayNothing: 'yes' },
      error: 'syntheticSayNothing must be a boolean when provided',
    },
    {
      name: 'a marker on ordinary text',
      payload: { ...basePayload, syntheticSayNothing: true },
      error: 'syntheticSayNothing requires mode "send" and the say-nothing sentinel',
    },
  ])('rejects $name', async ({ payload, error }) => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error })
  })

  it('rejects mode=regenerate without regenerateMessageId', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'regenerate' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: 'regenerateMessageId is required when mode is "regenerate"',
    })
  })

  it('blocks every /generate/chat mode when chat generation settings are incomplete before provider, job, or message side effects', async () => {
    let providerCalls = 0
    await restartHarness({
      dispatchProvider: () => {
        providerCalls++
        async function* source(): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'should not stream' }
        }
        return source()
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [
            {
              id: 'chat-1',
              message: [
                { role: 'user', data: 'first', chatId: 'msg-user-1' },
                { role: 'char', data: 'old reply', chatId: 'msg-char-1', saying: 'char-1' },
              ],
              note: '',
              name: 'Chat',
              localLore: [],
              generationSettings: undefined,
            },
          ],
        },
      ],
    })

    const beforeDb = openDatabase(harness.dataDir)
    let eventCountBefore = 0
    try {
      eventCountBefore = listPersistedCommandEventHistory(beforeDb).length
    } finally {
      beforeDb.close()
    }

    const cases: Array<{ label: string; payload: Record<string, unknown> }> = [
      { label: 'send', payload: basePayload },
      {
        label: 'continue',
        payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'continue' },
      },
      {
        label: 'regenerate',
        payload: {
          chatId: 'chat-1',
          characterId: 'char-1',
          mode: 'regenerate',
          regenerateMessageId: 'msg-char-1',
        },
      },
      {
        label: 'preview',
        payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'preview' },
      },
    ]

    for (const testCase of cases) {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: testCase.payload,
      })
      expect(res.statusCode, testCase.label).toBe(409)
      expect(res.headers['content-type'], testCase.label).toMatch(/application\/json/)
      expect(res.body, testCase.label).not.toContain('event:')
      expect(res.json(), testCase.label).toMatchObject({
        statusCode: 409,
        error: 'chat_generation_settings_incomplete',
        message: 'Chat generation settings are incomplete',
        chatId: 'chat-1',
        staleSidebarToggleKeys: [],
      })
      expect(
        res.json().missing.map((reason: { code: string }) => reason.code),
        testCase.label,
      ).toContain('settings_missing')
    }

    expect(providerCalls).toBe(0)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.json().activeGenerationJobs).toEqual([])
    const persisted = await persistedMessages(assertion)
    expect(
      persisted.map((message) => ({
        role: message.role,
        data: message.data,
        chatId: message.chatId,
      })),
    ).toEqual([
      { role: 'user', data: 'first', chatId: 'msg-user-1' },
      { role: 'char', data: 'old reply', chatId: 'msg-char-1' },
    ])

    const afterDb = openDatabase(harness.dataDir)
    try {
      expect(listPersistedCommandEventHistory(afterDb)).toHaveLength(eventCountBefore)
    } finally {
      afterDb.close()
    }
  })

  it('streams a regenerate message patch and assembled prompt for the truncated transcript', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [
            {
              id: 'chat-1',
              message: [
                { role: 'user', data: 'try again', chatId: 'msg-user-1' },
                { role: 'char', data: 'old reply', chatId: 'msg-char-1', saying: 'char-1' },
              ],
              note: '',
              name: 'Chat',
              localLore: [],
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'regenerate',
        regenerateMessageId: 'msg-char-1',
        clientCapabilities: { compactPromptEvent: true },
      },
    })
    expect(res.statusCode, res.body).toBe(200)

    const events = parseEvents(res.body)
    expect(events.map((e) => e.type)).toEqual([
      'stage',
      'stage',
      'stage',
      'prompt',
      'message_patch',
      'stage',
      'info',
      'error',
      'done',
    ])
    const patch = events.find((e) => e.type === 'message_patch')?.data.patch as
      | {
          messageMutations?: Array<{
            type?: string
            source?: string
            beforeLength?: number
            afterLength?: number
            firstChangedIndex?: number
            messages?: unknown[]
          }>
        }
      | undefined
    expect(patch?.messageMutations).toEqual([
      {
        type: 'replace_all',
        source: 'regenerate',
        beforeLength: 2,
        afterLength: 1,
        firstChangedIndex: 1,
        messages: [],
      },
    ])
    const prompt = events.find((e) => e.type === 'prompt')!
    const formated = prompt.data.formated as Array<{ content: unknown }>
    expect(formated.some((row) => row.content === 'old reply')).toBe(false)
  })

  it('emits an SSE error for an invalid regenerate target', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [
            {
              id: 'chat-1',
              message: [
                { role: 'user', data: 'first', chatId: 'msg-user-1' },
                { role: 'char', data: 'old reply', chatId: 'msg-char-1' },
                { role: 'user', data: 'second', chatId: 'msg-user-2' },
              ],
              note: '',
              name: 'Chat',
              localLore: [],
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'regenerate',
        regenerateMessageId: 'msg-char-1',
      },
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    expect(events.find((e) => e.type === 'prompt')).toBeUndefined()
    expect(String(events.find((e) => e.type === 'error')?.data.error)).toMatch(/latest assistant message/)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('streams the assembled prompt for a seeded database', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')

    const events = parseEvents(res.body)
    expect(events.map((e) => e.type)).toEqual([
      'stage',
      'stage',
      'stage',
      'prompt',
      'message_patch',
      'stage',
      'info',
      'error',
      'done',
    ])
    const prompt = events.find((e) => e.type === 'prompt')!
    expect(Array.isArray(prompt.data.messages)).toBe(true)
    expect((prompt.data.messages as unknown[]).length).toBeGreaterThan(0)
    // The prompt event also carries full OpenAIChat rows so preview clients can
    // inspect the dispatch payload. `formated` preserves the
    // `role`/`content` of the lossy `messages` projection.
    const formated = prompt.data.formated as Array<{ role: string; content: unknown }>
    expect(Array.isArray(formated)).toBe(true)
    expect(formated.map((r) => ({ role: r.role, content: r.content }))).toEqual(prompt.data.messages)
    expect((prompt.data as Record<string, unknown>).biases).toEqual([])
    const messagePatch = events.find((e) => e.type === 'message_patch')
    expect(messagePatch?.data.patch).toMatchObject({
      chatId: 'chat-1',
      characterId: 'char-1',
      messageMutations: expect.any(Array),
      chatVarMutations: expect.any(Array),
    })
    // The prompt stage closes after the patch, then telemetry rides before the
    // provider-dispatch terminal frames.
    expect(events.at(-4)).toEqual({ type: 'stage', data: { stage: 'prompt', status: 'end' } })
    expect(events.at(-3)?.type).toBe('info')
    expect(events.at(-2)?.type).toBe('error')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('prefetches live Hypa query vectors and selects similar memory through the generation route', async () => {
    let dispatchContext: ChatProviderDispatchContext | undefined
    const embedPromptMemoryQueryTexts: NonNullable<GenerationChatRouteOptions['embedPromptMemoryQueryTexts']> = vi.fn(
      async ({ input }) => ({
        model: 'custom',
        vectors: input.map(() => new Float32Array([1, 0])),
        dim: 2,
      }),
    )
    await restartHarness({
      embedPromptMemoryQueryTexts,
      dispatchProvider: (context) => {
        dispatchContext = context
        return null
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, similarityMemoryDatabase())
    seedSimilarMemoryRows()

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, userMessage: 'Tell me about the cat.' },
    })

    expect(res.statusCode).toBe(200)
    expect(embedPromptMemoryQueryTexts).toHaveBeenCalledTimes(1)
    expect(embedPromptMemoryQueryTexts).toHaveBeenCalledWith(
      expect.objectContaining({ input: ['Tell me about the cat.'] }),
    )
    const prompt = parseEvents(res.body).find((event) => event.type === 'prompt')
    const formated = prompt?.data.formated as Array<{ content: unknown }>
    expect(formated.some((row) => String(row.content).includes('remembered cat'))).toBe(true)
    expect(formated.some((row) => String(row.content).includes('remembered dog'))).toBe(false)
    expect(dispatchContext?.result.state?.promptMemoryQueryDiagnostics).toMatchObject({
      status: 'success',
      providerCallAttempted: true,
      queryTexts: 1,
      vectors: 1,
      error: null,
    })
    expect(dispatchContext?.result.state?.promptMemorySelectionDiagnostics?.selection?.ranking).toMatchObject({
      queryVectors: 1,
      validQueryVectors: 1,
    })
    expect(dispatchContext?.result.state?.promptMemorySelectionDiagnostics?.hotPathWork).toMatchObject({
      generatedQueryEmbeddings: true,
      calledProviders: true,
    })
  })

  it('accepts an explicit empty send from an assistant-tail transcript without appending a user row', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [
            {
              id: 'chat-1',
              message: [
                { role: 'user', data: 'first turn', chatId: 'msg-user-1' },
                { role: 'char', data: 'first reply', chatId: 'msg-char-1' },
              ],
              note: '',
              name: 'Chat',
              localLore: [],
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, userMessage: undefined, emptySend: true },
    })

    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    expect(events.find((event) => event.type === 'prompt')).toBeDefined()
    expect(events.find((event) => event.type === 'message_patch')?.data.patch).toMatchObject({
      messageMutations: [],
      chatVarMutations: [],
    })
  })

  it('persists server-owned stage-2 memory timing while keeping browser-owned stage 4 at zero', async () => {
    const embedPromptMemoryQueryTexts: NonNullable<GenerationChatRouteOptions['embedPromptMemoryQueryTexts']> = vi.fn(
      async ({ input }) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return {
          model: 'custom',
          vectors: input.map(() => new Float32Array([1, 0])),
          dim: 2,
        }
      },
    )
    await restartHarness({
      embedPromptMemoryQueryTexts,
      dispatchProvider: () =>
        (async function* (): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'timed reply' }
          yield { kind: 'done', finishReason: 'stop' }
        })(),
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, similarityMemoryDatabase())
    seedSimilarMemoryRows()

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, userMessage: 'Tell me about the cat.' },
    })
    expect(res.statusCode).toBe(200)

    const generationInfo = (await readPersistedMessages(assertion)).at(-1)?.generationInfo as
      | { stageTiming?: Record<string, number> }
      | undefined
    expect(generationInfo?.stageTiming?.stage1).toBeGreaterThanOrEqual(0)
    expect(generationInfo?.stageTiming?.stage2).toBeGreaterThan(0)
    // Browser stage 4 has no narrow metadata-patch command. The authoritative
    // server row therefore pins this browser-owned timing to zero.
    expect(generationInfo?.stageTiming?.stage4).toBe(0)
  })

  it('degrades query-embedding provider failures to empty vectors with prompt-memory diagnostics', async () => {
    let dispatchContext: ChatProviderDispatchContext | undefined
    const embedPromptMemoryQueryTexts = vi.fn(async () => ({
      error: 'embedding provider offline',
      code: 'fetch' as const,
    }))
    await restartHarness({
      embedPromptMemoryQueryTexts,
      dispatchProvider: (context) => {
        dispatchContext = context
        return null
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, similarityMemoryDatabase())
    seedSimilarMemoryRows()

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, userMessage: 'Tell me about the cat.' },
    })

    expect(res.statusCode).toBe(200)
    expect(parseEvents(res.body).some((event) => event.type === 'prompt')).toBe(true)
    expect(dispatchContext?.result.state?.promptMemoryQueryVectors).toEqual([])
    expect(dispatchContext?.result.state?.promptMemoryQueryDiagnostics).toMatchObject({
      status: 'failed',
      providerCallAttempted: true,
      queryTexts: 1,
      vectors: 0,
      error: 'embedding provider offline',
    })
    expect(dispatchContext?.result.state?.promptMemorySelectionDiagnostics?.hotPathWork).toMatchObject({
      generatedQueryEmbeddings: false,
      calledProviders: true,
    })
  })

  it('bounds query-embedding latency and continues generation after timeout', async () => {
    let dispatchContext: ChatProviderDispatchContext | undefined
    const embedPromptMemoryQueryTexts: NonNullable<GenerationChatRouteOptions['embedPromptMemoryQueryTexts']> = vi.fn(
      async ({ signal }) =>
        await new Promise<{ error: string; code: 'aborted' }>((resolve) => {
          signal.addEventListener('abort', () => resolve({ error: 'aborted', code: 'aborted' }), { once: true })
        }),
    )
    await restartHarness({
      embedPromptMemoryQueryTexts,
      promptMemoryEmbeddingDeadlineMs: 5,
      dispatchProvider: (context) => {
        dispatchContext = context
        return null
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, similarityMemoryDatabase())
    seedSimilarMemoryRows()

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, userMessage: 'Tell me about the cat.' },
    })

    expect(res.statusCode).toBe(200)
    expect(parseEvents(res.body).some((event) => event.type === 'prompt')).toBe(true)
    expect(dispatchContext?.result.state?.promptMemoryQueryVectors).toEqual([])
    expect(dispatchContext?.result.state?.promptMemoryQueryDiagnostics).toMatchObject({
      status: 'timed-out',
      providerCallAttempted: true,
      queryTexts: 1,
      vectors: 0,
      deadlineMs: 5,
      error: 'prompt memory query embedding timed out after 5ms',
    })
  })

  it('omits duplicate prompt fields for compact-capable clients', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        ...basePayload,
        clientCapabilities: { compactPromptEvent: true },
      },
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    const prompt = events.find((e) => e.type === 'prompt')!
    expect(prompt).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(prompt.data, 'messages')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(prompt.data, 'lorebookActivation')).toBe(false)
    expect(Array.isArray(prompt.data.formated)).toBe(true)
    expect(prompt.data.promptInfo).toBeDefined()
  })

  it('sends prompt metadata without provider rows to server-dispatched clients', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        ...basePayload,
        clientCapabilities: { compactPromptEvent: true, promptMetadataOnly: true },
      },
    })
    expect(res.statusCode).toBe(200)

    const prompt = parseEvents(res.body).find((event) => event.type === 'prompt')!
    expect(prompt).toBeDefined()
    expect(Object.keys(prompt.data)).toEqual(['promptInfo'])
    expect(prompt.data.promptInfo).toBeDefined()
  })

  it('retains provider rows for previews that request prompt metadata only', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        ...basePayload,
        mode: 'preview',
        clientCapabilities: { compactPromptEvent: true, promptMetadataOnly: true },
      },
    })
    expect(res.statusCode).toBe(200)

    const prompt = parseEvents(res.body).find((event) => event.type === 'prompt')!
    expect(Array.isArray(prompt.data.formated)).toBe(true)
  })

  it('leaves chat SSE uncompressed when gzip is requested', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion, 'accept-encoding': 'gzip' },
      payload: { ...basePayload, clientCapabilities: { compactPromptEvent: true } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.headers['content-encoding']).toBeUndefined()

    const events = parseEvents(res.body)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('emits an info event with token counts and the response budget', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    const info = events.find((e) => e.type === 'info')!
    expect(info).toBeDefined()
    const tokens = info.data.tokens as { prompt?: number; total?: number }
    expect(typeof tokens.prompt).toBe('number')
    expect(tokens.total).toBe(tokens.prompt)
    // `responseBudget` mirrors the clamped `maxResponse` from the fixture.
    expect(info.data.responseBudget).toBe(50)
    expect(typeof (info.data.timings as Record<string, number>).prompt).toBe('number')
  })

  it('persists the baseline-formatted provider display label in generationInfo', async () => {
    await restartHarness({
      dispatchProvider: () =>
        (async function* (): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'labeled reply' }
          yield { kind: 'done', finishReason: 'stop' }
        })(),
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'openrouter',
      openrouterKey: 'test-openrouter-key',
      openrouterRequestModel: 'vendor/model-name',
      modelPresets: [
        {
          id: DEFAULT_TEST_MODEL_PRESET_ID,
          name: 'Default Model',
          modelProfiles: [
            {
              id: 'openrouter-profile',
              name: 'OpenRouter',
              modelId: 'openrouter',
              providerOptions: {
                apiKey: 'test-openrouter-key',
                requestModel: 'vendor/model-name',
              },
            },
          ],
          modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'openrouter-profile' } },
          maxContext: 100_000,
          maxResponse: 50,
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode, res.body).toBe(200)

    expect(parseEvents(res.body).at(-1)?.data.generationInfo).toMatchObject({
      model: 'openrouter-vendor/model-name',
    })
    expect((await readPersistedMessages(assertion)).at(-1)?.generationInfo).toMatchObject({
      model: 'openrouter-vendor/model-name',
    })
  })

  it('resolves risu/free at dispatch and persists the selected OpenRouter model label', async () => {
    clearOpenRouterFreeModelCacheForTests()
    const upstreamCalls: Array<{ url: string; body?: Record<string, unknown> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const call = {
          url: String(url),
          ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
        }
        upstreamCalls.push(call)
        if (call.url === 'https://openrouter.ai/api/v1/models') {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'provider/smaller:free',
                  name: 'Provider: Smaller Free',
                  context_length: 32_000,
                  pricing: { prompt: '0', completion: '0' },
                },
                {
                  id: 'provider/largest:free',
                  name: 'Provider: Largest Free',
                  context_length: 128_000,
                  pricing: { prompt: '0', completion: '0' },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'resolved free reply' }, finish_reason: 'stop' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'openrouter',
      openrouterKey: 'test-openrouter-free-key',
      openrouterRequestModel: 'risu/free',
      useStreaming: false,
      providerCredentials: [
        {
          id: 'openrouter-credential',
          name: 'OpenRouter',
          type: 'apiKey',
          apiKey: 'test-openrouter-free-key',
        },
      ],
      modelPresets: [
        {
          id: DEFAULT_TEST_MODEL_PRESET_ID,
          name: 'Default Model',
          modelProfiles: [
            {
              id: 'openrouter-free-profile',
              name: 'OpenRouter Free',
              modelId: 'openrouter',
              providerOptions: {
                credentialId: 'openrouter-credential',
                requestModel: 'risu/free',
              },
              runtimeOptions: { useStreaming: false },
            },
          ],
          modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'openrouter-free-profile' } },
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    expect(upstreamCalls.map((call) => call.url)).toEqual([
      'https://openrouter.ai/api/v1/models',
      'https://openrouter.ai/api/v1/chat/completions',
    ])
    expect(upstreamCalls[1]?.body?.model).toBe('provider/largest:free')
    expect(parseEvents(res.body).at(-1)?.data.generationInfo).toMatchObject({
      model: 'openrouter-provider/largest:free',
    })
    expect((await readPersistedMessages(assertion)).at(-1)?.generationInfo).toMatchObject({
      model: 'openrouter-provider/largest:free',
    })
  })

  it('omits retired character additional-description data from the generated prompt', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          additionalText: 'PA1-PRIVATE-APPENDIX-MUST-NOT-REACH-THE-PROMPT',
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const prompt = parseEvents(res.body).find((event) => event.type === 'prompt')
    const serializedRows = JSON.stringify(prompt?.data.formated ?? [])
    expect(serializedRows).toContain('DESC')
    // Accepted divergence: baseline index.svelte.ts:430 called
    // embedding/addinfo.ts to retrieve additionalText; Fastify intentionally
    // retires that embedding retrieval while preserving imported data.
    expect(serializedRows).not.toContain('PA1-PRIVATE-APPENDIX-MUST-NOT-REACH-THE-PROMPT')
  })

  it('keeps unsupported trigger families as no-ops and warns once per effect type', async () => {
    await restartHarness({
      dispatchProvider: () =>
        (async function* (): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'completed reply' }
          yield { kind: 'done', finishReason: 'stop' }
        })(),
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          customscript: [
            {
              id: 'unsupported-emo-one',
              comment: 'unsupported emotion effect one',
              in: 'completed reply',
              out: '@@emo joy',
              type: 'editoutput',
            },
            {
              id: 'unsupported-emo-two',
              comment: 'unsupported emotion effect two',
              in: 'completed reply',
              out: '@@emo calm',
              type: 'editoutput',
            },
          ],
          triggerscript: [
            {
              comment: 'unsupported server effects',
              type: 'start',
              conditions: [],
              effect: [
                {
                  type: 'v2SetCharacterDesc',
                  value: 'MUTATED-DESCRIPTION',
                  valueType: 'value',
                  indent: 0,
                },
                {
                  type: 'v2SetCharacterDesc',
                  value: 'MUTATED-AGAIN',
                  valueType: 'value',
                  indent: 0,
                },
                { type: 'command', value: 'delete everything' },
              ],
            },
            {
              comment: 'unsupported output effect',
              type: 'output',
              conditions: [],
              effect: [
                {
                  type: 'v2RunLLM',
                  value: 'privileged request',
                  valueType: 'value',
                  model: 'scriptMain',
                  outputVar: 'llmResult',
                  indent: 0,
                },
              ],
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    const warnings = events.filter((event) => event.type === 'warning').map((event) => event.data)
    expect(warnings).toEqual([
      {
        message: 'Trigger effect "v2SetCharacterDesc" is unsupported on this server and was skipped.',
        context: { kind: 'unsupported_trigger_effect', effectType: 'v2SetCharacterDesc' },
      },
      {
        message: 'Trigger effect "command" is unsupported on this server and was skipped.',
        context: { kind: 'unsupported_trigger_effect', effectType: 'command' },
      },
      {
        message: 'Trigger effect "@@emo" is unsupported on this server and was skipped.',
        context: { kind: 'unsupported_trigger_effect', effectType: '@@emo' },
      },
      {
        message: 'Trigger effect "v2RunLLM" is unsupported on this server and was skipped.',
        context: { kind: 'unsupported_trigger_effect', effectType: 'v2RunLLM' },
      },
    ])
    expect(JSON.stringify(events.find((event) => event.type === 'prompt')?.data.formated ?? [])).not.toContain(
      'MUTATED-DESCRIPTION',
    )
    expect(
      warnings.filter((warning) => (warning.context as { effectType?: unknown } | undefined)?.effectType === '@@emo'),
    ).toHaveLength(1)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].desc).toBe('DESC')
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate?.$llmResult).toBeUndefined()
  })

  it('resolves browser language and screen dimensions from request-local client context', async () => {
    await restartHarness({
      dispatchProvider: () =>
        (async function* (): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'context reply' }
          yield { kind: 'done', finishReason: 'stop' }
        })(),
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          desc: 'WIDTH={{screenwidth}} LANG={{metadata::browserlanguage}} HEIGHT={{screenheight}}',
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        ...basePayload,
        clientContext: { browserLanguage: 'ko-KR', screenWidth: 777, screenHeight: 555 },
      },
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    const promptText = JSON.stringify(events.find((event) => event.type === 'prompt')?.data.formated ?? [])
    expect(promptText).toContain('WIDTH=777 LANG=ko-KR HEIGHT=555')
    expect(promptText).not.toContain('{{screenheight}}')
    expect(events.filter((event) => event.type === 'warning')).toEqual([])
    expect(events.at(-1)?.type).toBe('done')
  })

  it('keeps implemented browser-context CBS non-throwing when older clients report no context', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          desc: 'WIDTH={{screenwidth}} HEIGHT={{screenheight}} LANG={{metadata::browserlanguage}}',
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    expect(events.filter((event) => event.type === 'warning').map((event) => event.data)).toEqual([
      {
        message:
          'CBS callback "screenwidth" could not resolve because client context was not reported and returned an empty value.',
        context: {
          kind: 'unsupported_cbs_callback',
          callbackName: 'screenwidth',
          reason: 'client_context_unavailable',
        },
      },
      {
        message:
          'CBS callback "screenheight" could not resolve because client context was not reported and returned an empty value.',
        context: {
          kind: 'unsupported_cbs_callback',
          callbackName: 'screenheight',
          reason: 'client_context_unavailable',
        },
      },
      {
        message:
          'CBS callback "browserlanguage" could not resolve because client context was not reported and returned an empty value.',
        context: {
          kind: 'unsupported_cbs_callback',
          callbackName: 'browserlanguage',
          reason: 'client_context_unavailable',
        },
      },
    ])
    expect(events.at(-1)?.type).toBe('done')
  })

  it('persists the assembly-time chat-var delta in send mode and bumps the revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      characters: Array<(typeof fixtureDatabase.characters)[number] & { triggerscript?: unknown }>
    }
    db.characters[0].triggerscript = [
      {
        comment: '',
        type: 'start',
        conditions: [],
        effect: [{ type: 'setvar', operator: '=', var: 'score', value: '9' }],
      },
    ]
    await seedDatabase(harness.app, assertion, db)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    expect(events.at(-1)?.type).toBe('done')
    const patch = events.find((e) => e.type === 'message_patch')?.data.patch as
      | { chatVarMutations?: unknown[]; varChanged?: boolean }
      | undefined
    expect(patch?.varChanged).toBe(true)
    expect(patch?.chatVarMutations).toEqual([{ key: '$score', before: null, after: '9' }])

    // The route persists the assembly-time delta itself and returns the bumped
    // revision on the info frame so the browser can reconcile its cached command
    // revision.
    const info = events.find((e) => e.type === 'info')
    expect(info?.data.revision).toBe(2)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().revision).toBe(2)
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toEqual({ $score: '9' })
  })

  it('rejects a stale assembly chat-var write and preserves the newer durable value', async () => {
    let releaseEmbedding!: () => void
    let markEmbeddingStarted!: () => void
    const embeddingStarted = new Promise<void>((resolve) => {
      markEmbeddingStarted = resolve
    })
    const embeddingGate = new Promise<void>((resolve) => {
      releaseEmbedding = resolve
    })
    await restartHarness({
      embedPromptMemoryQueryTexts: async ({ input }) => {
        markEmbeddingStarted()
        await embeddingGate
        return {
          model: 'custom',
          vectors: input.map(() => new Float32Array([1, 0])),
          dim: 2,
        }
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const database = structuredClone(similarityMemoryDatabase()) as JsonRecord
    const character = (database.characters as Array<JsonRecord>)[0]!
    const chat = (character.chats as Array<JsonRecord>)[0]!
    chat.scriptstate = { $score: '0' }
    character.triggerscript = [
      {
        comment: '',
        type: 'start',
        conditions: [],
        effect: [{ type: 'setvar', operator: '=', var: 'score', value: '1' }],
      },
    ]
    await seedDatabase(harness.app, assertion, database)
    seedSimilarMemoryRows()

    const generation = harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, userMessage: 'Tell me about the cat.' },
    })
    await embeddingStarted

    const bootstrapBeforeEdit = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const edit = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-1/scriptstate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: bootstrapBeforeEdit.json().revision, patch: { $score: '9' } },
    })
    expect(edit.statusCode).toBe(200)
    releaseEmbedding()

    const response = await generation
    const events = parseEvents(response.body)
    expect(events.find((event) => event.type === 'error')?.data.error).toContain(
      'Generation chat variable is stale for chat chat-1: $score',
    )
    expect(events.at(-1)?.type).toBe('done')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toEqual({ $score: '9' })
  })

  it('persists lorebook @@keep_activate_after_match and uses it on the next send', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      characters: Array<
        (typeof fixtureDatabase.characters)[number] & {
          globalLore?: unknown[]
        }
      >
    }
    db.formatingOrder = ['main', 'description', 'lorebook', 'chats']
    db.characters[0].globalLore = [
      {
        id: 'lore-keep',
        key: 'cat',
        secondkey: '',
        insertorder: 100,
        comment: 'Sticky route lore',
        content: '@@keep_activate_after_match\nSticky route lore.',
        mode: 'normal',
        alwaysActive: false,
        selective: false,
      },
    ]
    await seedDatabase(harness.app, assertion, db)

    const send = async (userMessage: string): Promise<PromptChatFrame[]> => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: { ...basePayload, userMessage },
      })
      expect(res.statusCode).toBe(200)
      return parseEvents(res.body)
    }

    const firstEvents = await send('cat')
    const firstPrompt = firstEvents.find((e) => e.type === 'prompt')!
    expect(
      (firstPrompt.data.messages as Array<{ content: string }>).some(
        (message) => message.content === 'Sticky route lore.',
      ),
    ).toBe(true)
    const firstPatch = firstEvents.find((e) => e.type === 'message_patch')?.data.patch as
      | {
          chatVarMutations?: Array<{ key: string; before: unknown; after: unknown }>
          varChanged?: boolean
        }
      | undefined
    expect(firstPatch?.varChanged).toBe(true)
    expect(firstPatch?.chatVarMutations).toEqual([{ key: '$__internal_ka_lore-keep', before: null, after: 'true' }])
    expect(firstEvents.find((e) => e.type === 'info')?.data.revision).toBe(2)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toEqual({
      '$__internal_ka_lore-keep': 'true',
    })

    const secondEvents = await send('unrelated')
    const secondPrompt = secondEvents.find((e) => e.type === 'prompt')!
    expect(
      (secondPrompt.data.messages as Array<{ content: string }>).some(
        (message) => message.content === 'Sticky route lore.',
      ),
    ).toBe(true)
    const secondPatch = secondEvents.find((e) => e.type === 'message_patch')?.data.patch as
      | { chatVarMutations?: unknown[] }
      | undefined
    expect(secondPatch?.chatVarMutations).toEqual([])
  })

  it('records prompt assembly and assembly-persistence protocol metrics separately', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      characters: Array<(typeof fixtureDatabase.characters)[number] & { triggerscript?: unknown }>
    }
    db.characters[0].triggerscript = [
      {
        comment: '',
        type: 'start',
        conditions: [],
        effect: [{ type: 'setvar', operator: '=', var: 'score', value: '9' }],
      },
    ]
    await seedDatabase(harness.app, assertion, db)

    await withProtocolMetrics(async (metrics) => {
      const sentinel = 'slice-2-secret-route-prompt'
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion, 'x-risu-caller': 'chat-generate' },
        payload: { ...basePayload, userMessage: sentinel, expectedRevision: 1, inlayAssets: [], inlayAssetRefs: [] },
      })
      expect(res.statusCode).toBe(200)

      const assembly = metrics.find((entry) => entry.metric === 'generation_prompt_assembly')
      expect(assembly).toMatchObject({
        status: 'ok',
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'send',
        xRisuCaller: 'chat-generate',
        expectedRevision: 1,
        inlayAssetsCount: 0,
        inlayAssetRefsCount: 0,
        durable: false,
        compactPromptEvent: false,
        databaseLoadCount: 1,
        promptRowCount: expect.any(Number),
        promptRows: expect.any(Array),
        promptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        inputTokens: expect.any(Number),
        outputTokens: 50,
        modelPresetId: DEFAULT_TEST_MODEL_PRESET_ID,
        promptPresetId: DEFAULT_TEST_PROMPT_PRESET_ID,
        activeModuleCount: 0,
        lorebookActivationCount: 0,
        messageMutationCount: 1,
        chatVarMutationCount: 1,
        additionalSystemPromptMutationCount: 0,
        varChanged: true,
      })
      expect(typeof assembly?.requestId).toBe('string')
      expect(assembly?.durationMs).toBeGreaterThanOrEqual(0)
      expect(assembly?.promptMs).toBeGreaterThanOrEqual(0)
      expect(assembly?.databaseLoadMs).toBeGreaterThanOrEqual(0)
      expectPromptAssemblyStageTimings(assembly)

      const emission = metrics.find((entry) => entry.metric === 'generation_prompt_emission')
      expect(emission).toMatchObject({
        status: 'ok',
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'send',
        durable: false,
        compactPromptEvent: false,
        shouldDispatch: true,
        revision: 2,
        persistedRevision: 2,
        promptHash: assembly?.promptHash,
        promptRowCount: assembly?.promptRowCount,
        promptRoleSequence: assembly?.promptRoleSequence,
        promptRows: assembly?.promptRows,
        promptEventHasFormated: true,
        promptEventHasMessages: true,
        promptEventHasLorebookActivation: true,
        promptEventHasPromptInfo: true,
      })

      const prompt = parseEvents(res.body).find((event) => event.type === 'prompt')
      expect(Array.isArray(prompt?.data.formated)).toBe(true)
      const emittedSummary = summarizePromptRows(prompt!.data.formated as never)
      expect(emittedSummary.promptHash).toBe(assembly?.promptHash)
      expect(emittedSummary.promptHash).toBe(emission?.promptHash)
      expect(emittedSummary.rows).toEqual(assembly?.promptRows)
      expect(emittedSummary.rows).toEqual(emission?.promptRows)

      const metricsJson = JSON.stringify(metrics)
      expect(metricsJson).not.toContain(sentinel)

      const persistence = metrics.find((entry) => entry.metric === 'generation_assembly_persistence')
      expect(persistence).toMatchObject({
        status: 'ok',
        chatId: 'chat-1',
        mode: 'send',
        revision: 2,
        eventType: 'chat.scriptstate.updated',
        chatVarMutationCount: 1,
        persistMessages: false,
        hasVarWrite: true,
      })
      expect(persistence?.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  it('does not write full prompt sidecars when only protocol metrics are enabled', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    await withProtocolMetrics(async (metrics) => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: { ...basePayload, userMessage: 'SIDEcar disabled sentinel' },
      })
      expect(res.statusCode).toBe(200)

      const emission = metrics.find((entry) => entry.metric === 'generation_prompt_emission')
      expect(emission?.fullPromptSidecar).toBeUndefined()
      expect(existsSync(path.join(harness.dataDir, 'trace', 'generation'))).toBe(false)
    })
  })

  it('writes opt-in full prompt sidecars without putting prompt text in metrics', async () => {
    await restartHarness({}, { fullPrompt: true, maxGzipBytes: 10 * 1024 * 1024 })
    const { assertion } = await setupAuthedClient(harness.app)
    const sentinel = 'FULL_PROMPT_SIDECAR_SENTINEL'
    await seedDatabase(harness.app, assertion, { ...fixtureDatabase, mainPrompt: `MAIN ${sentinel}` })

    await withProtocolMetrics(async (metrics, rawMetricLines) => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: { ...basePayload, userMessage: 'hi' },
      })
      expect(res.statusCode).toBe(200)

      const emission = metrics.find((entry) => entry.metric === 'generation_prompt_emission')
      expect(emission?.fullPromptSidecar).toMatchObject({
        status: 'written',
        path: expect.stringMatching(/^trace\/generation\/prompt-.+\.json\.gz$/),
        bytes: expect.any(Number),
        gzipBytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      const sidecar = readGenerationSidecar(harness.dataDir, emission?.fullPromptSidecar)
      expect(JSON.stringify(sidecar)).toContain(sentinel)
      expect(rawMetricLines.join('\n')).not.toContain(sentinel)
    })
  })

  it('omits full prompt sidecars over the gzip cap without writing a file', async () => {
    await restartHarness({}, { fullPrompt: true, maxGzipBytes: 1 })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    await withProtocolMetrics(async (metrics) => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: { ...basePayload, userMessage: 'cap overflow sentinel' },
      })
      expect(res.statusCode).toBe(200)

      const emission = metrics.find((entry) => entry.metric === 'generation_prompt_emission')
      expect(emission?.fullPromptSidecar).toMatchObject({
        status: 'omitted',
        reason: 'max_gzip_bytes_exceeded',
        maxGzipBytes: 1,
      })
      expect(existsSync(path.join(harness.dataDir, 'trace', 'generation'))).toBe(false)
    })
  })

  it('uses authoritative prompt rows for sidecars when compact prompt events are requested', async () => {
    await restartHarness({}, { fullPrompt: true, maxGzipBytes: 10 * 1024 * 1024 })
    const { assertion } = await setupAuthedClient(harness.app)
    const sentinel = 'COMPACT_PROMPT_AUTH_ROWS_SENTINEL'
    await seedDatabase(harness.app, assertion, { ...fixtureDatabase, mainPrompt: `MAIN ${sentinel}` })

    await withProtocolMetrics(async (metrics) => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: {
          ...basePayload,
          userMessage: 'hi',
          clientCapabilities: { compactPromptEvent: true },
        },
      })
      expect(res.statusCode).toBe(200)
      const prompt = parseEvents(res.body).find((event) => event.type === 'prompt')
      expect(prompt?.data.messages).toBeUndefined()

      const emission = metrics.find((entry) => entry.metric === 'generation_prompt_emission')
      expect(emission?.compactPromptEvent).toBe(true)
      const sidecar = readGenerationSidecar(harness.dataDir, emission?.fullPromptSidecar)
      expect(JSON.stringify(sidecar)).toContain(sentinel)
    })
  })

  it('records prompt and persistence metrics for plain, side-effecting, preview, and durable generation paths', async () => {
    await withProtocolMetrics(async (metrics) => {
      const collect = (from: number): ProtocolMetric[] => metrics.slice(from)
      const postChat = async (assertion: string, payload: Record<string, unknown>) => {
        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/v1/generate/chat',
          headers: { 'risu-auth': assertion },
          payload,
        })
        expect(res.statusCode).toBe(200)
        return res
      }

      let auth = await setupAuthedClient(harness.app)
      await seedDatabase(harness.app, auth.assertion, fixtureDatabase)
      let before = metrics.length
      await postChat(auth.assertion, basePayload)
      const plain = collect(before)
      const plainAssembly = plain.find((entry) => entry.metric === 'generation_prompt_assembly')
      expect(plainAssembly).toMatchObject({
        status: 'ok',
        mode: 'send',
        databaseLoadCount: 1,
      })
      expectPromptAssemblyStageTimings(plainAssembly)
      expect(plain.find((entry) => entry.metric === 'generation_assembly_persistence')).toMatchObject({
        status: 'skipped',
        mode: 'send',
        persistMessages: false,
        hasVarWrite: false,
      })
      expect(plain.some((entry) => entry.metric === 'command_mutation')).toBe(false)

      const chatVarDb = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
        characters: Array<(typeof fixtureDatabase.characters)[number] & { triggerscript?: unknown }>
      }
      chatVarDb.characters[0].triggerscript = [
        {
          comment: '',
          type: 'start',
          conditions: [],
          effect: [{ type: 'setvar', operator: '=', var: 'score', value: '9' }],
        },
      ]
      await seedDatabase(harness.app, auth.assertion, chatVarDb)
      before = metrics.length
      await postChat(auth.assertion, basePayload)
      const chatVar = collect(before)
      expectPromptAssemblyStageTimings(chatVar.find((entry) => entry.metric === 'generation_prompt_assembly'))
      expect(chatVar.find((entry) => entry.metric === 'generation_assembly_persistence')).toMatchObject({
        status: 'ok',
        mode: 'send',
        eventType: 'chat.scriptstate.updated',
        persistMessages: false,
        hasVarWrite: true,
      })
      expect(chatVar.find((entry) => entry.metric === 'command_mutation')).toMatchObject({
        type: 'chat.scriptstate.updated',
        mutationPath: 'targeted-assembly',
        writtenTables: ['chats'],
      })
      assertCommandMetricGate(chatVar.find((entry) => entry.metric === 'command_mutation') as CommandMutationMetric)

      await seedDatabase(
        harness.app,
        auth.assertion,
        dbWithSubmitLua(
          `
            listenEdit('editInput', function(id, data, meta)
              return data .. ' [EDITINPUT]'
            end)
          `,
          ['main', 'description', 'chats', 'lastChat'],
        ),
      )
      before = metrics.length
      await postChat(auth.assertion, basePayload)
      const transcriptRewrite = collect(before)
      expectPromptAssemblyStageTimings(transcriptRewrite.find((entry) => entry.metric === 'generation_prompt_assembly'))
      expect(transcriptRewrite.find((entry) => entry.metric === 'generation_assembly_persistence')).toMatchObject({
        status: 'ok',
        mode: 'send',
        eventType: 'generation.assemblyPersisted',
        persistMessages: true,
        hasVarWrite: false,
      })
      expect(transcriptRewrite.find((entry) => entry.metric === 'command_mutation')).toMatchObject({
        type: 'generation.assemblyPersisted',
        mutationPath: 'targeted-assembly',
        writtenTables: ['messages'],
      })
      assertCommandMetricGate(
        transcriptRewrite.find((entry) => entry.metric === 'command_mutation') as CommandMutationMetric,
      )

      await seedDatabase(
        harness.app,
        auth.assertion,
        dbWithSubmitLua(`
          function onInput(triggerId)
            addChat(triggerId, 'char', 'INPUT-LUA-ROW')
            setState(triggerId, 'inputseen', 1)
          end
        `),
      )
      before = metrics.length
      await postChat(auth.assertion, basePayload)
      const combinedSideEffects = collect(before)
      expectPromptAssemblyStageTimings(
        combinedSideEffects.find((entry) => entry.metric === 'generation_prompt_assembly'),
      )
      expect(combinedSideEffects.find((entry) => entry.metric === 'generation_assembly_persistence')).toMatchObject({
        status: 'ok',
        mode: 'send',
        eventType: 'generation.assemblyPersisted',
        persistMessages: true,
        hasVarWrite: true,
      })
      expect(combinedSideEffects.find((entry) => entry.metric === 'command_mutation')).toMatchObject({
        type: 'generation.assemblyPersisted',
        mutationPath: 'targeted-assembly',
        writtenTables: ['chats', 'messages'],
      })
      assertCommandMetricGate(
        combinedSideEffects.find((entry) => entry.metric === 'command_mutation') as CommandMutationMetric,
      )

      await seedDatabase(harness.app, auth.assertion, fixtureDatabase)
      before = metrics.length
      const preview = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/preview-prompt',
        headers: { 'risu-auth': auth.assertion, 'x-risu-caller': 'preview-prompt' },
        payload: {
          chatId: 'chat-1',
          characterId: 'char-1',
          clientCapabilities: { compactPromptEvent: true },
        },
      })
      expect(preview.statusCode).toBe(200)
      const previewMetrics = collect(before)
      const previewAssembly = previewMetrics.find((entry) => entry.metric === 'generation_prompt_assembly')
      expect(previewAssembly).toMatchObject({
        status: 'ok',
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'preview_prompt',
        xRisuCaller: 'preview-prompt',
        durable: false,
        compactPromptEvent: true,
        databaseLoadCount: 1,
      })
      expectPromptAssemblyStageTimings(previewAssembly)
      expect(previewMetrics.some((entry) => entry.metric === 'generation_assembly_persistence')).toBe(false)

      await restartHarness({
        dispatchProvider: () => {
          async function* source(): AsyncGenerator<CompletionStreamFrame> {
            yield { kind: 'token', content: 'Durable hello' }
            yield { kind: 'done', finishReason: 'stop' }
          }
          return source()
        },
      })
      auth = await setupAuthedClient(harness.app)
      await seedDatabase(harness.app, auth.assertion, fixtureDatabase)
      before = metrics.length
      const durableRes = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': auth.assertion, 'x-risu-caller': 'chat-generate' },
        payload: { ...basePayload, durable: true },
      })
      expect(durableRes.statusCode).toBe(200)
      const durable = collect(before)
      const durableAssembly = durable.find((entry) => entry.metric === 'generation_prompt_assembly')
      expect(durableAssembly).toMatchObject({
        status: 'ok',
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'send',
        xRisuCaller: 'chat-generate',
        durable: true,
        databaseLoadCount: 1,
        promptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        promptRows: expect.any(Array),
      })
      expect(typeof durableAssembly?.generationId).toBe('string')
      expect(durableAssembly?.durableJobId).toBe(durableAssembly?.generationId)
      expectPromptAssemblyStageTimings(durableAssembly)
      const durableEmission = durable.find((entry) => entry.metric === 'generation_prompt_emission')
      expect(durableEmission).toMatchObject({
        status: 'ok',
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'send',
        xRisuCaller: 'chat-generate',
        durable: true,
        durableJobId: durableAssembly?.durableJobId,
        generationId: durableAssembly?.generationId,
        promptHash: durableAssembly?.promptHash,
        promptRowCount: durableAssembly?.promptRowCount,
        promptRoleSequence: durableAssembly?.promptRoleSequence,
        promptRows: durableAssembly?.promptRows,
        shouldDispatch: true,
      })
      expect(durable.find((entry) => entry.metric === 'generation_assembly_persistence')).toMatchObject({
        status: 'skipped',
        mode: 'send',
      })
      expect(durable.find((entry) => entry.metric === 'generation_persistence')).toMatchObject({
        status: 'persisted',
      })
      const durablePersistMetric = durable.find(
        (entry) => entry.metric === 'command_mutation' && entry.type === 'generation.persisted',
      )
      expect(durablePersistMetric).toMatchObject({
        mutationPath: 'targeted-generation',
        dbJsonWriteMs: 0,
        writtenTables: ['messages'],
      })
      assertCommandMetricGate(durablePersistMetric as CommandMutationMetric)
    })
  })

  // The server Lua VM runs the `editRequest` hook during assembly, mirroring the
  // browser's `runLuaEditTrigger(char,'editRequest',formated)`.
  function dbWithEditRequestLua(code: string): unknown {
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      characters: Array<(typeof fixtureDatabase.characters)[number] & { triggerscript?: unknown }>
    }
    db.characters[0].triggerscript = [
      { comment: '', type: 'request', conditions: [], effect: [{ type: 'triggerlua', code }] },
    ]
    return db
  }

  it('runs a Lua editRequest hook that rewrites the assembled prompt rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    // Suffix every rendered row. The regex-only baseline leaves 'MAIN' untouched
    // (see the plain-fixture send above); the Lua hook makes it 'MAIN [LUA]'.
    await seedDatabase(
      harness.app,
      assertion,
      dbWithEditRequestLua(`
        listenEdit('editRequest', function(id, data, meta)
          for i = 1, #data do
            data[i].content = data[i].content .. ' [LUA]'
          end
          return data
        end)
      `),
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    const prompt = events.find((e) => e.type === 'prompt')!
    const messages = prompt.data.messages as Array<{ role: string; content: string }>
    expect(messages.length).toBeGreaterThan(0)
    // The 'MAIN' row was rewritten in place (not duplicated), proving the hook
    // ran over the final server-assembled rows.
    expect(messages.some((m) => m.content === 'MAIN [LUA]')).toBe(true)
    expect(messages.some((m) => m.content === 'MAIN')).toBe(false)
    expect(messages.every((m) => typeof m.content === 'string' && m.content.endsWith(' [LUA]'))).toBe(true)
  })

  it('persists a Lua editRequest setChatVar write via the assembly chat-var delta', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    // The hook's var engine is bound to the same db chat scriptstate the route
    // persists, so a `setChatVar`/`setState` during the hook lands in the
    // assembly chat-var delta and bumps the revision (no extra browser re-POST).
    await seedDatabase(
      harness.app,
      assertion,
      dbWithEditRequestLua(`
        listenEdit('editRequest', function(id, data, meta)
          setState(id, 'turns', 3)
          return data
        end)
      `),
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    const patch = events.find((e) => e.type === 'message_patch')?.data.patch as
      | {
          chatVarMutations?: Array<{ key: string; before: unknown; after: unknown }>
          varChanged?: boolean
        }
      | undefined
    // `setState(id,'turns',3)` writes the JSON-encoded value under the `__`-prefixed
    // key; the var engine stores it at `$__turns` in scriptstate.
    expect(patch?.varChanged).toBe(true)
    expect(patch?.chatVarMutations).toEqual([{ key: '$__turns', before: null, after: '3' }])

    const info = events.find((e) => e.type === 'info')
    expect(info?.data.revision).toBe(2)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toEqual({ $__turns: '3' })
  })

  it.each([
    { field: 'name', lua: "setName(id, 'Renamed Tess')", before: 'Tess', expected: 'Renamed Tess' },
    {
      field: 'firstMessage',
      lua: "setCharacterFirstMessage(id, 'A durable new greeting.')",
      before: 'Greetings.',
      expected: 'A durable new greeting.',
    },
    {
      field: 'backgroundHTML',
      lua: "setBackgroundEmbedding(id, '<section>Durable background</section>')",
      before: null,
      expected: '<section>Durable background</section>',
    },
    {
      field: 'desc',
      lua: "setDescription(id, 'A durable new description.')",
      before: 'DESC',
      expected: 'A durable new description.',
    },
  ])(
    'durably persists Lua editRequest character field $field and emits a character-refreshing event',
    async (testCase) => {
      const { assertion } = await setupAuthedClient(harness.app)
      const database = dbWithEditRequestLua(`
      listenEdit('editRequest', function(id, data, meta)
        ${testCase.lua}
        return data
      end)
    `) as JsonRecord
      database.aiModel = 'echo_model'
      database.echoMessage = 'server echo reply'
      await seedDatabase(harness.app, assertion, database)

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: basePayload,
      })
      expect(res.statusCode).toBe(200)
      const patch = parseEvents(res.body).find((event) => event.type === 'message_patch')?.data.patch as
        | { characterFieldMutations?: Array<{ key: string; before: unknown; after: unknown }> }
        | undefined
      expect(patch?.characterFieldMutations).toEqual([
        { key: testCase.field, before: testCase.before, after: testCase.expected },
      ])

      const character = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/characters/char-1',
        headers: { 'risu-auth': assertion },
      })
      expect(character.statusCode).toBe(200)
      expect(character.json().character[testCase.field]).toBe(testCase.expected)

      const db = openDatabase(harness.dataDir)
      try {
        expect(
          listPersistedCommandEventHistory(db)
            .filter((event) => event.type === 'generation.assemblyPersisted')
            .at(-1),
        ).toMatchObject({
          type: 'generation.assemblyPersisted',
          resource: 'chatTranscript',
          id: 'chat-1',
          parentId: 'char-1',
        })
      } finally {
        db.close()
      }
    },
  )

  it('durably upserts local lore by comment while preserving stable entry identity and exact siblings', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const database = dbWithEditRequestLua(`
      listenEdit('editRequest', function(id, data, meta)
        upsertLocalLoreBook(id, 'shared', 'replacement', { insertOrder = 7, key = 'new-key' })
        return data
      end)
    `) as JsonRecord
    database.aiModel = 'echo_model'
    database.echoMessage = 'server echo reply'
    const character = (database.characters as Array<JsonRecord>)[0]!
    const chat = (character.chats as Array<JsonRecord>)[0]!
    chat.unrelatedExactField = { keep: ['byte-for-byte'] }
    chat.localLore = [
      {
        id: 'stable-shared-id',
        key: 'old-key',
        secondkey: '',
        insertorder: 10,
        comment: 'shared',
        content: 'old',
        mode: 'normal',
        alwaysActive: false,
        selective: false,
      },
      {
        id: 'other-id',
        key: 'other',
        secondkey: '',
        insertorder: 20,
        comment: 'other',
        content: 'untouched',
        mode: 'normal',
        alwaysActive: true,
        selective: false,
      },
      {
        id: 'duplicate-comment-id',
        key: 'duplicate',
        secondkey: '',
        insertorder: 30,
        comment: 'shared',
        content: 'removed duplicate',
        mode: 'normal',
        alwaysActive: false,
        selective: false,
      },
    ]
    await seedDatabase(harness.app, assertion, database)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const reloaded = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-1',
      headers: { 'risu-auth': assertion },
    })
    expect(reloaded.statusCode).toBe(200)
    const persistedChat = reloaded.json().character.chats[0]
    expect(persistedChat.unrelatedExactField).toEqual({ keep: ['byte-for-byte'] })
    expect(persistedChat.localLore.map((entry: { id: string }) => entry.id)).toEqual(['other-id', 'stable-shared-id'])
    expect(persistedChat.localLore[1]).toMatchObject({
      id: 'stable-shared-id',
      comment: 'shared',
      content: 'replacement',
      insertorder: 7,
      key: 'new-key',
    })
    expect(new Set(persistedChat.localLore.map((entry: { id: string }) => entry.id)).size).toBe(2)
  })

  it('keeps Lua character and local-lore setters request-local in preview mode', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithEditRequestLua(`
        listenEdit('editRequest', function(id, data, meta)
          setName(id, 'Preview-only name')
          setCharacterFirstMessage(id, 'Preview-only greeting')
          setBackgroundEmbedding(id, 'Preview-only background')
          upsertLocalLoreBook(id, 'preview-only', 'must not persist', {})
          return data
        end)
      `),
    )
    const dbBefore = openDatabase(harness.dataDir)
    const eventCountBefore = listPersistedCommandEventHistory(dbBefore).length
    dbBefore.close()

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, mode: 'preview' },
    })
    expect(res.statusCode).toBe(200)

    const reloaded = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-1',
      headers: { 'risu-auth': assertion },
    })
    expect(reloaded.json().character).toMatchObject({
      name: 'Tess',
      firstMessage: 'Greetings.',
      chats: [{ localLore: [] }],
    })
    expect(reloaded.json().character.backgroundHTML).toBeUndefined()
    const dbAfter = openDatabase(harness.dataDir)
    try {
      expect(listPersistedCommandEventHistory(dbAfter)).toHaveLength(eventCountBefore)
    } finally {
      dbAfter.close()
    }
  })

  // Byte-parity vs the local golden. The browser fixture sweep
  // (`src/ts/process/__fixtures__`) computes its `editrequest-trigger` golden with
  // a *mocked* `runLuaEditTrigger` that appends a fixed marker row whenever a char
  // has a triggerscript. Here the real server Lua VM runs Lua that appends the
  // same row — so the server reproduces the golden marker byte-for-byte. (This
  // lives in the node-env server suite because wasmoon cannot initialize under the
  // browser suite's jsdom environment; see the note in
  // `src/ts/process/__tests__/sendChat.fixtures.serverBacked.test.ts`.)
  it('reproduces the local golden editRequest marker row byte-for-byte', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithEditRequestLua(`
        listenEdit('editRequest', function(id, data, meta)
          data[#data + 1] = { role = 'system', content = '[edit-request marker]', memo = 'edit-request-marker' }
          return data
        end)
      `),
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    const prompt = events.find((e) => e.type === 'prompt')!
    const formated = prompt.data.formated as Array<Record<string, unknown>>
    const serverMarker = formated.find((row) => row.content === '[edit-request marker]')

    // Load the committed local golden and pull its editRequest marker row.
    const goldenPath = fileURLToPath(
      new URL('../../../src/ts/process/__fixtures__/expected/editrequest-trigger.json', import.meta.url),
    )
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as {
      providerCalls: Array<{ formated: Array<Record<string, unknown>> }>
    }
    const goldenMarker = golden.providerCalls[0].formated.find((row) => row.content === '[edit-request marker]')
    expect(goldenMarker).toBeDefined()
    expect(serverMarker).toEqual(goldenMarker)
  })

  // Lua `editprocess` is a browser no-op, so a `triggerlua` char must assemble
  // history identically to the same char without it. The Lua here would rewrite
  // any body it processed, so the marker's absence proves the no-op is faithful.
  it('runs Lua editprocess through the runtime as a no-op at parity', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const editProcessLua = `
      function editprocess(id)
        return 'EDITPROCESS-MUTATED'
      end
    `

    const collect = async (): Promise<Array<{ role: string; content: unknown }>> => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: basePayload,
      })
      expect(res.statusCode).toBe(200)
      const prompt = parseEvents(res.body).find((e) => e.type === 'prompt')!
      return prompt.data.messages as Array<{ role: string; content: unknown }>
    }

    // Baseline: a history body ('PROC-BODY') + the fixture first message
    // ('Greetings.'), no Lua. Re-seeding before the second send resets the
    // transcript (the first send appended `userMessage`), so both assemble from
    // the same starting point.
    await seedDatabase(harness.app, assertion, dbWithHistoryMessage('PROC-BODY'))
    const baseline = await collect()

    // Same char + the editprocess-defining triggerlua.
    await seedDatabase(
      harness.app,
      assertion,
      dbWithHistoryMessage('PROC-BODY', {
        triggerscript: [
          {
            comment: '',
            type: 'request',
            conditions: [],
            effect: [{ type: 'triggerlua', code: editProcessLua }],
          },
        ],
      }),
    )
    const withLua = await collect()

    // Byte-identical assembled rows: the editprocess no-op rewrote nothing.
    expect(withLua).toEqual(baseline)
    // Both the per-message body and the first message survive verbatim…
    expect(withLua.some((m) => m.content === 'PROC-BODY')).toBe(true)
    expect(withLua.some((m) => m.content === 'Greetings.')).toBe(true)
    // …and the would-be editprocess rewrite never surfaced anywhere.
    expect(withLua.every((m) => !String(m.content).includes('EDITPROCESS-MUTATED'))).toBe(true)
  })

  // The marker rides on a *history* user message (the `chats` slot); the
  // appended `userMessage` would land in the unrendered `lastChat` slot given
  // this fixture's `['main','description','chats']` order.
  function dbWithHistoryMessage(data: string, extraChar: Record<string, unknown> = {}): unknown {
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      characters: Array<Record<string, unknown>>
    }
    Object.assign(db.characters[0], extraChar)
    ;(db.characters[0].chats as Array<{ message: unknown[] }>)[0].message = [
      { role: 'user', data, chatId: 'msg-marker' },
    ]
    return db
  }

  it.each([
    {
      mode: 'send' as const,
      messages: [{ role: 'user', data: 'prior row', chatId: 'prior-send-row' }],
      payload: { ...basePayload, userMessage: 'hello {{char}} SECRET' },
      targetId: undefined as string | undefined,
    },
    {
      mode: 'continue' as const,
      messages: [
        { role: 'user', data: 'hello {{char}} SECRET', chatId: 'inject-target-continue' },
        { role: 'char', data: 'partial reply', chatId: 'continue-row' },
      ],
      payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'continue' },
      targetId: 'inject-target-continue',
    },
    {
      mode: 'regenerate' as const,
      messages: [
        { role: 'user', data: 'hello {{char}} SECRET', chatId: 'inject-target-regenerate' },
        { role: 'char', data: 'old reply', chatId: 'regenerate-row' },
      ],
      payload: {
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'regenerate',
        regenerateMessageId: 'regenerate-row',
      },
      targetId: 'inject-target-regenerate',
    },
  ])(
    'persists an identity-addressed @@inject rewrite in $mode mode while stripping provider text',
    async (testCase) => {
      const providerPrompts: Array<Array<{ content: string }>> = []
      await restartHarness({
        dispatchProvider: (context) => {
          providerPrompts.push(context.result.formated as Array<{ content: string }>)
          return (async function* (): AsyncGenerator<CompletionStreamFrame> {
            yield { kind: 'token', content: 'provider reply' }
            yield { kind: 'done', finishReason: 'stop' }
          })()
        },
      })
      const { assertion } = await setupAuthedClient(harness.app)
      const db = dbWithHistoryMessage('unused') as typeof fixtureDatabase & {
        aiModel: string
        characters: Array<
          (typeof fixtureDatabase.characters)[number] & {
            customscript?: unknown
            chats: Array<(typeof fixtureDatabase.characters)[number]['chats'][number]>
          }
        >
      }
      db.aiModel = 'echo_model'
      ;(db as unknown as { useSayNothing: boolean }).useSayNothing = false
      db.formatingOrder = ['main', 'description', 'chats', 'lastChat']
      db.characters[0].customscript = [
        { in: 'SECRET', out: '@@inject', type: 'editprocess', flag: '', ableFlag: false },
      ]
      db.characters[0].chats[0].message = testCase.messages as never
      await seedDatabase(harness.app, assertion, db)

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: testCase.payload,
      })

      expect(response.statusCode).toBe(200)
      expect(providerPrompts, response.body).toHaveLength(1)
      expect(providerPrompts[0].some((row) => row.content === 'hello Tess')).toBe(true)
      expect(providerPrompts[0].every((row) => !row.content.includes('SECRET'))).toBe(true)
      const events = parseEvents(response.body)
      expect(events.some((event) => event.type === 'error')).toBe(false)
      const injectPatch = (
        events.find((event) => event.type === 'message_patch')?.data.patch as {
          messageMutations?: Array<{ type: string; source: string; messageId?: string }>
        }
      ).messageMutations?.find((mutation) => mutation.source === 'history_inject')
      expect(injectPatch).toMatchObject({
        type: 'replace_by_id',
        source: 'history_inject',
        messageId: testCase.targetId ?? expect.any(String),
        before: expect.any(Object),
        message: expect.any(Object),
      })
      const targetId = testCase.targetId ?? injectPatch?.messageId
      expect(targetId).toEqual(expect.any(String))

      // The hydration endpoint is authoritative after assembly + generation
      // persistence, equivalent to observing the row after a browser reload.
      const persisted = await persistedMessages(assertion)
      expect(persisted.find((message) => message.chatId === targetId)?.data).toBe('hello Tess SECRET')
      if (testCase.mode === 'send') {
        expect(persisted.at(-1)?.data).toBe('provider reply')
      } else if (testCase.mode === 'continue') {
        expect(persisted.find((message) => message.chatId === 'continue-row')?.data).toContain('provider reply')
      } else {
        expect(persisted.some((message) => message.chatId === 'regenerate-row')).toBe(false)
        expect(persisted.at(-1)?.data).toBe('provider reply')
        expect(await persistedAlternates(assertion)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ chatId: 'regenerate-row', data: 'old reply' }),
            expect.objectContaining({ data: 'provider reply' }),
          ]),
        )
      }
    },
  )

  it('keeps a plain editprocess history regex prompt-local', async () => {
    const providerPrompts: Array<Array<{ content: string }>> = []
    await restartHarness({
      dispatchProvider: (context) => {
        providerPrompts.push(context.result.formated as Array<{ content: string }>)
        return (async function* (): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'provider reply' }
          yield { kind: 'done', finishReason: 'stop' }
        })()
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const db = dbWithHistoryMessage('hello {{char}} SECRET', {
      customscript: [{ in: 'SECRET', out: 'PROMPT_ONLY', type: 'editprocess', flag: '', ableFlag: false }],
    }) as typeof fixtureDatabase & { aiModel: string }
    db.aiModel = 'echo_model'
    await seedDatabase(harness.app, assertion, db)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, userMessage: 'new request' },
    })

    expect(response.statusCode).toBe(200)
    expect(providerPrompts[0].some((row) => row.content === 'hello Tess PROMPT_ONLY')).toBe(true)
    const persisted = await persistedMessages(assertion)
    expect(persisted.find((message) => message.chatId === 'msg-marker')?.data).toBe('hello {{char}} SECRET')
    const patch = parseEvents(response.body).find((event) => event.type === 'message_patch')?.data.patch as {
      messageMutations?: Array<{ source: string }>
    }
    expect(patch.messageMutations?.some((mutation) => mutation.source === 'history_inject')).toBe(false)
  })

  // Submit-time input trigger + `editinput`.
  //
  // The server runs the chat-screen submit handler's input trigger and
  // `editinput` transform before assembly, then owns the post-`editinput`
  // transcript write. These tests live in node because wasmoon cannot init under
  // the browser suite's jsdom.

  /** A char whose `triggerlua` defines the submit-time hook (`onInput` for the
   * input trigger, `listenEdit('editInput', …)` for editinput). `type: 'input'`
   * is cosmetic — a `triggerlua` first effect bypasses the mode filter. */
  function dbWithSubmitLua(code: string, formatOrder?: string[]): unknown {
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      characters: Array<(typeof fixtureDatabase.characters)[number] & { triggerscript?: unknown }>
      formatingOrder: string[]
    }
    if (formatOrder) db.formatingOrder = formatOrder
    db.characters[0].triggerscript = [
      { comment: '', type: 'input', conditions: [], effect: [{ type: 'triggerlua', code }] },
    ]
    return db
  }

  async function sendBase(assertion: string): Promise<PromptChatFrame[]> {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    return parseEvents(res.body)
  }

  // Read persisted chat messages via hydration; bootstrap ships message-free stubs.
  async function persistedMessages(
    assertion: string,
    chatId = 'chat-1',
  ): Promise<Array<{ role: string; data: string; chatId: string; [k: string]: unknown }>> {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
      headers: { 'risu-auth': assertion },
    })
    expect(res.statusCode).toBe(200)
    return res.json().message
  }

  // Preserved reroll candidates surfaced on the hydration endpoint.
  async function persistedAlternates(
    assertion: string,
    chatId = 'chat-1',
  ): Promise<Array<{ role: string; data: string; chatId: string; [k: string]: unknown }>> {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
      headers: { 'risu-auth': assertion },
    })
    expect(res.statusCode).toBe(200)
    return res.json().alternates
  }

  async function bootstrapChat(assertion: string): Promise<{
    message: Array<{ role: string; data: string }>
    scriptstate?: Record<string, unknown>
  }> {
    const res = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(res.statusCode).toBe(200)
    // Chat metadata (incl. scriptstate) comes from the stub bootstrap; message[]
    // is hydrated separately.
    const chat = res.resourceDatabase.characters[0].chats[0]
    return { ...chat, message: await persistedMessages(assertion, chat.id) }
  }

  function transcriptReplacementDatabase(withMemoryPrefetch = false): JsonRecord {
    const database = structuredClone(withMemoryPrefetch ? similarityMemoryDatabase() : fixtureDatabase) as JsonRecord
    const character = (database.characters as Array<JsonRecord>)[0]!
    const chat = (character.chats as Array<JsonRecord>)[0]!
    chat.message = [{ role: 'user', data: 'original row', chatId: 'existing-row' }]
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
                setChat(id, 0, 'assembly rewrite')
              end
            `,
          },
        ],
      },
    ]
    return database
  }

  it('replaces a transcript when the assembly-start baseline is unchanged', async () => {
    await restartHarness({ dispatchProvider: () => null })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, transcriptReplacementDatabase())

    const events = await sendBase(assertion)
    expect(events.find((event) => event.type === 'error')?.data.error).not.toContain(
      'Generation assembly transcript is stale',
    )
    expect((await persistedMessages(assertion)).map(({ data, chatId }) => ({ data, chatId }))).toEqual([
      { data: 'assembly rewrite', chatId: 'existing-row' },
      { data: 'hi', chatId: expect.any(String) },
    ])
  })

  it('rejects an append-only assembly after a concurrent same-length prefix edit', async () => {
    let releaseEmbedding!: () => void
    let markEmbeddingStarted!: () => void
    const embeddingStarted = new Promise<void>((resolve) => {
      markEmbeddingStarted = resolve
    })
    const embeddingGate = new Promise<void>((resolve) => {
      releaseEmbedding = resolve
    })
    await restartHarness({
      embedPromptMemoryQueryTexts: async ({ input }) => {
        markEmbeddingStarted()
        await embeddingGate
        return {
          model: 'custom',
          vectors: input.map(() => new Float32Array([1, 0])),
          dim: 2,
        }
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const database = structuredClone(similarityMemoryDatabase()) as JsonRecord
    const character = (database.characters as Array<JsonRecord>)[0]!
    const chat = (character.chats as Array<JsonRecord>)[0]!
    chat.message = [{ role: 'user', data: 'original row', chatId: 'existing-row' }]
    character.triggerscript = [
      {
        comment: '',
        type: 'input',
        conditions: [],
        effect: [
          {
            type: 'triggerlua',
            code: `
              function onInput(triggerId)
                addChat(triggerId, 'char', 'INPUT-LUA-ROW')
              end
            `,
          },
        ],
      },
    ]
    await seedDatabase(harness.app, assertion, database)
    seedSimilarMemoryRows()

    const generation = harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    await embeddingStarted

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const edit = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/existing-row',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: bootstrap.json().revision,
        patch: { data: 'concurrent edit' },
      },
    })
    expect(edit.statusCode).toBe(200)
    releaseEmbedding()

    const response = await generation
    const events = parseEvents(response.body)
    expect(events.find((event) => event.type === 'error')?.data.error).toContain(
      'Generation assembly transcript is stale for chat chat-1',
    )
    expect(await persistedMessages(assertion)).toEqual([
      expect.objectContaining({ data: 'concurrent edit', chatId: 'existing-row' }),
    ])
  })

  it.each(['append', 'edit'] as const)(
    'rejects a stale full-transcript replacement after a concurrent %s and preserves it',
    async (concurrentMutation) => {
      let releaseEmbedding!: () => void
      let markEmbeddingStarted!: () => void
      const embeddingStarted = new Promise<void>((resolve) => {
        markEmbeddingStarted = resolve
      })
      const embeddingGate = new Promise<void>((resolve) => {
        releaseEmbedding = resolve
      })
      await restartHarness({
        embedPromptMemoryQueryTexts: async ({ input }) => {
          markEmbeddingStarted()
          await embeddingGate
          return {
            model: 'custom',
            vectors: input.map(() => new Float32Array([1, 0])),
            dim: 2,
          }
        },
      })
      const { assertion } = await setupAuthedClient(harness.app)
      await seedDatabase(harness.app, assertion, transcriptReplacementDatabase(true))
      seedSimilarMemoryRows()

      const generation = harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: basePayload,
      })
      await embeddingStarted

      const bootstrap = await injectComposedResourceDatabase(harness.app, {
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': assertion },
      })
      const mutation =
        concurrentMutation === 'append'
          ? await harness.app.inject({
              method: 'POST',
              url: '/api/v1/commands/chats/chat-1/messages',
              headers: { 'risu-auth': assertion },
              payload: {
                baseRevision: bootstrap.json().revision,
                message: { role: 'char', data: 'concurrent append', chatId: 'concurrent-row' },
              },
            })
          : await harness.app.inject({
              method: 'PATCH',
              url: '/api/v1/commands/messages/existing-row',
              headers: { 'risu-auth': assertion },
              payload: {
                baseRevision: bootstrap.json().revision,
                patch: { data: 'concurrent edit' },
              },
            })
      expect(mutation.statusCode).toBe(200)
      releaseEmbedding()

      const response = await generation
      const events = parseEvents(response.body)
      expect(events.find((event) => event.type === 'error')?.data.error).toContain(
        'Generation assembly transcript is stale for chat chat-1',
      )
      const persisted = await persistedMessages(assertion)
      if (concurrentMutation === 'append') {
        expect(persisted).toEqual([
          expect.objectContaining({ data: 'original row', chatId: 'existing-row' }),
          expect.objectContaining({ data: 'concurrent append', chatId: 'concurrent-row' }),
        ])
      } else {
        expect(persisted).toEqual([expect.objectContaining({ data: 'concurrent edit', chatId: 'existing-row' })])
      }
    },
  )

  it('runs a Lua input trigger that rewrites the transcript and persists it', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    // `onInput` fires only during the submit-time input-trigger run (the start
    // trigger leaves `triggerlua` a no-op). It appends a char row to the
    // transcript (before the user message) and writes a chat var.
    await seedDatabase(
      harness.app,
      assertion,
      dbWithSubmitLua(`
        function onInput(triggerId)
          addChat(triggerId, 'char', 'INPUT-LUA-ROW')
          setState(triggerId, 'inputseen', 1)
        end
      `),
    )

    resetChatMessageDiffInstrumentation()
    const events = await sendBase(assertion)
    expect(getChatMessageDiffInstrumentation()).toMatchObject({
      stableEqualCalls: 0,
      stableEqualStringifies: 0,
      appendFastPathRows: 2,
    })

    // Assembled prompt: the input trigger's char row renders in the `chats` slot.
    const prompt = events.find((e) => e.type === 'prompt')!
    const messages = prompt.data.messages as Array<{ role: string; content: string }>
    expect(messages.some((m) => m.content === 'INPUT-LUA-ROW')).toBe(true)

    // Route owns the post-input-trigger transcript write: the persisted chat has
    // the added char row followed by the user message.
    const chat = await bootstrapChat(assertion)
    expect(chat.message.map((m) => ({ role: m.role, data: m.data }))).toEqual([
      { role: 'char', data: 'INPUT-LUA-ROW' },
      { role: 'user', data: 'hi' },
    ])
    // The trigger's `setState` write rode the same chat-var delta + revision bump.
    expect(chat.scriptstate).toEqual({ $__inputseen: '1' })
    const info = events.find((e) => e.type === 'info')
    expect(info?.data.revision).toBe(2)
  })

  it('durably persists a lore-only Lua input trigger and exposes its assembly mutation', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithSubmitLua(`
        function onInput(triggerId)
          upsertLocalLoreBook(triggerId, 'input-lore', 'INPUT LORE', { key = 'input-key' })
        end
      `),
    )

    const events = await sendBase(assertion)
    const patch = events.find((event) => event.type === 'message_patch')?.data.patch as
      | {
          localLoreMutation?: { before: unknown[]; after: Array<Record<string, unknown>> }
          messageMutations?: Array<{ source: string }>
        }
      | undefined
    expect(patch?.messageMutations?.map((mutation) => mutation.source)).toEqual(['user_message'])
    expect(patch?.localLoreMutation).toEqual({
      before: [],
      after: [
        expect.objectContaining({
          id: expect.any(String),
          comment: 'input-lore',
          content: 'INPUT LORE',
          key: 'input-key',
        }),
      ],
    })

    const character = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-1',
      headers: { 'risu-auth': assertion },
    })
    expect(character.statusCode).toBe(200)
    expect(character.json().character.chats[0].localLore).toEqual(patch?.localLoreMutation?.after)
  })

  it('runs a Lua editinput hook that rewrites the submitted user message', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    // `editInput` listeners transform the user text string. Render `lastChat` so
    // the rewritten user row also shows up in the assembled prompt.
    await seedDatabase(
      harness.app,
      assertion,
      dbWithSubmitLua(
        `
        listenEdit('editInput', function(id, data, meta)
          return data .. ' [EDITINPUT:' .. tostring(meta.index) .. ']'
        end)
      `,
        ['main', 'description', 'chats', 'lastChat'],
      ),
    )

    const events = await sendBase(assertion)

    // Assembled prompt: the transformed user message renders (lastChat slot).
    const prompt = events.find((e) => e.type === 'prompt')!
    const messages = prompt.data.messages as Array<{ role: string; content: string }>
    expect(messages.some((m) => m.content === 'hi [EDITINPUT:0]')).toBe(true)
    expect(messages.some((m) => m.content === 'hi')).toBe(false)

    // The message_patch carries the editinput replace_all and the persisted
    // transcript reflects the post-editinput rewrite.
    const patch = events.find((e) => e.type === 'message_patch')?.data.patch as {
      messageMutations?: Array<{
        type: string
        source: string
        messages?: Array<{ role: string; data: string }>
      }>
    }
    const editinputMutation = patch.messageMutations?.find((m) => m.source === 'editinput')
    expect(editinputMutation?.type).toBe('replace_all')
    expect(editinputMutation?.messages?.at(-1)).toMatchObject({
      role: 'user',
      data: 'hi [EDITINPUT:0]',
    })

    const chat = await bootstrapChat(assertion)
    expect(chat.message.map((m) => ({ role: m.role, data: m.data }))).toEqual([
      { role: 'user', data: 'hi [EDITINPUT:0]' },
    ])
  })

  it('no-var editinput transcript persistence emits a composite assembly event', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithSubmitLua(
        `
        listenEdit('editInput', function(id, data, meta)
          return data .. ' [EDITINPUT]'
        end)
      `,
        ['main', 'description', 'chats', 'lastChat'],
      ),
    )

    await sendBase(assertion)

    const db = openDatabase(harness.dataDir)
    try {
      const event = listPersistedCommandEventHistory(db).find(
        (candidate) => candidate.type === 'generation.assemblyPersisted',
      )
      expect(event).toMatchObject({
        type: 'generation.assemblyPersisted',
        resource: 'chatTranscript',
        id: 'chat-1',
        parentId: 'char-1',
      })
    } finally {
      db.close()
    }
  })

  it('runs a regex editinput script that rewrites the submitted user message', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    // The regex `editinput` path (no Lua) is already at parity; the route now runs
    // it over the submitted user text and persists the result.
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      characters: Array<(typeof fixtureDatabase.characters)[number] & { customscript?: unknown }>
    }
    db.characters[0].customscript = [{ in: 'hi', out: 'HELLO', type: 'editinput', flag: '', ableFlag: false }]
    await seedDatabase(harness.app, assertion, db)

    await sendBase(assertion)

    const chat = await bootstrapChat(assertion)
    expect(chat.message.map((m) => ({ role: m.role, data: m.data }))).toEqual([{ role: 'user', data: 'HELLO' }])
  })

  it('runs the regex from the chat-selected prompt preset, including legacy regex aliases', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      modelPresets: Array<Record<string, unknown>>
      modelPresetsId: number
      promptPresets: Array<Record<string, unknown>>
      promptPresetsId: number
      characters: Array<
        (typeof fixtureDatabase.characters)[number] & {
          chats: Array<(typeof fixtureDatabase.characters)[number]['chats'][number] & { generationSettings?: unknown }>
        }
      >
    }
    db.modelPresets = [
      {
        id: DEFAULT_TEST_MODEL_PRESET_ID,
        name: 'Default Model',
        maxContext: 100_000,
        maxResponse: 50,
      },
    ]
    db.modelPresetsId = 0
    db.promptPresets = [
      {
        id: 'global-prompt',
        name: 'Global Prompt',
        regex: [{ in: 'hi', out: 'GLOBAL', type: 'editinput', flag: '', ableFlag: false }],
      },
      {
        id: 'chat-prompt',
        name: 'Chat Prompt',
        regex: [{ in: 'hi', out: 'CHAT', type: 'editinput', flag: '', ableFlag: false }],
        presetRegex: [],
      },
    ]
    db.promptPresetsId = 0
    db.characters[0].chats[0].generationSettings = {
      configured: true,
      personaId: DEFAULT_TEST_PERSONA_ID,
      modelPresetId: DEFAULT_TEST_MODEL_PRESET_ID,
      promptPresetId: 'chat-prompt',
      jailbreakToggle: false,
      sidebarToggles: {},
    }
    await seedDatabase(harness.app, assertion, db)

    await sendBase(assertion)

    const chat = await bootstrapChat(assertion)
    expect(chat.message.map((m) => ({ role: m.role, data: m.data }))).toEqual([{ role: 'user', data: 'CHAT' }])
  })

  it('unsafe imported regex stops before provider dispatch and assistant persistence', async () => {
    let providerCalls = 0
    await restartHarness({
      dispatchProvider: () => {
        providerCalls++
        async function* source(): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'should not dispatch' }
          yield { kind: 'done', finishReason: 'stop' }
        }
        return source()
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      aiModel: string
      complexRegexCompatibilityMode: 'strict' | 'worker'
      characters: Array<
        (typeof fixtureDatabase.characters)[number] & {
          globalLore?: unknown
          chats: Array<(typeof fixtureDatabase.characters)[number]['chats'][number]>
        }
      >
    }
    db.aiModel = 'echo_model'
    // This case asserts the strict complexity-screen rejection. Database
    // normalization otherwise defaults legacy fixtures to worker compatibility,
    // which intentionally waits for the configured 15-second execution bound.
    db.complexRegexCompatibilityMode = 'strict'
    db.characters[0].globalLore = [
      {
        key: '/(a+)+$/',
        secondkey: '',
        insertorder: 100,
        comment: 'unsafe regex lore',
        content: 'Never dispatches.',
        mode: 'normal',
        alwaysActive: false,
        selective: false,
        useRegex: true,
      },
    ]
    db.characters[0].chats = [
      {
        ...db.characters[0].chats[0],
        message: [{ role: 'user', data: 'a'.repeat(32) + '!', chatId: 'seed-user' }] as never,
      },
    ]
    await seedDatabase(harness.app, assertion, db)

    const events = await sendBase(assertion)

    expect(events.map((e) => e.type)).toEqual(['stage', 'stage', 'stage', 'error', 'done'])
    expect(events.find((e) => e.type === 'prompt')).toBeUndefined()
    expect(events.find((e) => e.type === 'info')).toBeUndefined()
    expect(String(events.find((e) => e.type === 'error')?.data.error)).toMatch(
      /bounded regex rejected: lorebook useRegex key: complexity screen/,
    )
    expect(providerCalls).toBe(0)
    const persisted = await persistedMessages(assertion)
    expect(persisted.map((m) => ({ role: m.role, data: m.data }))).toEqual([
      { role: 'user', data: 'a'.repeat(32) + '!' },
    ])
  })

  it('valid imported lorebook and customscript regexes preserve generation output', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      aiModel: string
      echoMessage: string
      echoDelay: number
      characters: Array<
        (typeof fixtureDatabase.characters)[number] & {
          customscript?: unknown
          globalLore?: unknown
        }
      >
    }
    db.aiModel = 'echo_model'
    db.echoMessage = 'server echo reply'
    db.echoDelay = 0
    db.characters[0].customscript = [{ in: 'h(i)', out: 'H$1', type: 'editinput', flag: '', ableFlag: false }]
    db.characters[0].globalLore = [
      {
        key: '/^Hi$/i',
        secondkey: '',
        insertorder: 100,
        comment: 'valid regex lore',
        content: 'Bounded regex lore body.',
        mode: 'normal',
        alwaysActive: false,
        selective: false,
        useRegex: true,
      },
    ]
    await seedDatabase(harness.app, assertion, db)

    const events = await sendBase(assertion)

    const prompt = events.find((e) => e.type === 'prompt')!
    const activation = prompt.data.lorebookActivation as {
      actives?: Array<{ prompt: string; source: string }>
    }
    expect(activation.actives).toEqual([
      expect.objectContaining({
        prompt: 'Bounded regex lore body.',
        source: 'valid regex lore',
      }),
    ])
    expect(events.at(-2)).toEqual({ type: 'token', data: { content: 'server echo reply' } })
    expect(events.at(-1)?.data).toMatchObject({ result: 'server echo reply' })
    const persisted = await persistedMessages(assertion)
    expect(persisted.map((m) => ({ role: m.role, data: m.data }))).toEqual([
      { role: 'user', data: 'Hi' },
      { role: 'char', data: 'server echo reply' },
    ])
  })

  it('leaves a plain send transcript to the browser (no route message write)', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    // No input trigger / editinput → `submitTranscriptChanged` is false, so the
    // route writes no transcript (the browser persists the raw user row exactly
    // as before). The seeded empty transcript is therefore unchanged server-side.
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const events = await sendBase(assertion)

    // The browser-facing message_patch still carries the user-message append…
    const patch = events.find((e) => e.type === 'message_patch')?.data.patch as {
      messageMutations?: Array<{ source: string }>
    }
    expect(patch.messageMutations?.some((m) => m.source === 'user_message')).toBe(true)
    expect(patch.messageMutations?.some((m) => m.source === 'editinput' || m.source === 'input_trigger')).toBe(false)
    // …but the route persisted nothing (no revision bump, transcript untouched).
    const info = events.find((e) => e.type === 'info')
    expect(info?.data.revision).toBeUndefined()
    const chat = await bootstrapChat(assertion)
    expect(chat.message).toEqual([])
  })

  it('inlines server-owned inlay assets into the assembled prompt multimodals', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const bytes = Buffer.from('server-inlay-bytes')
    const upload = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'risu-auth': assertion, 'content-type': 'image/png' },
      payload: bytes,
    })
    expect(upload.statusCode).toBe(201)
    const assetId = upload.json().assetId as string
    await seedDatabase(harness.app, assertion, dbWithHistoryMessage(`look {{inlayeddata::${assetId}}}`))

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const prompt = parseEvents(res.body).find((e) => e.type === 'prompt')!
    const formated = prompt.data.formated as Array<{
      role: string
      content: unknown
      multimodals?: unknown
    }>
    const userRow = formated.find(
      (row) => row.role === 'user' && typeof row.content === 'string' && row.content.includes('look'),
    )
    // `processInlays` resolved the id from the server asset store and pushed bytes…
    expect(userRow?.multimodals).toEqual([
      { type: 'image', base64: `data:image/png;base64,${bytes.toString('base64')}` },
    ])
    // …and stripped the marker from the row text.
    expect(userRow?.content).not.toContain(`{{inlayeddata::${assetId}}}`)
  })

  it('maps legacy request inlayAssetRefs to server-owned bytes without base64 payloads', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const bytes = Buffer.from('legacy-inlay-bytes')
    const upload = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'risu-auth': assertion, 'content-type': 'image/png' },
      payload: bytes,
    })
    expect(upload.statusCode).toBe(201)
    const assetId = upload.json().assetId as string
    await seedDatabase(harness.app, assertion, dbWithHistoryMessage('look {{inlayeddata::abc}}'))

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        ...basePayload,
        inlayAssetRefs: [{ id: 'abc', assetId }],
      },
    })
    expect(res.statusCode).toBe(200)

    const prompt = parseEvents(res.body).find((e) => e.type === 'prompt')!
    const formated = prompt.data.formated as Array<{
      role: string
      content: unknown
      multimodals?: unknown
    }>
    const userRow = formated.find(
      (row) => row.role === 'user' && typeof row.content === 'string' && row.content.includes('look'),
    )
    expect(userRow?.multimodals).toEqual([
      { type: 'image', base64: `data:image/png;base64,${bytes.toString('base64')}` },
    ])
  })

  it('inlines a stored {{asset_prompt::}} asset into the prompt multimodals', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const assetBytes = Buffer.from('fixture-asset-bytes')
    const upload = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'risu-auth': assertion, 'content-type': 'image/png' },
      payload: assetBytes,
    })
    expect(upload.statusCode).toBe(201)
    const assetId = upload.json().assetId as string

    await seedDatabase(
      harness.app,
      assertion,
      dbWithHistoryMessage('show {{asset_prompt::hero}}', {
        additionalAssets: [['hero', assetId, '']],
      }),
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const prompt = parseEvents(res.body).find((e) => e.type === 'prompt')!
    const formated = prompt.data.formated as Array<{
      role: string
      content: unknown
      multimodals?: unknown
    }>
    const userRow = formated.find(
      (row) => row.role === 'user' && typeof row.content === 'string' && row.content.includes('show'),
    )
    // `processAssetPrompts` mapped the name → reference → store bytes, re-wrapped
    // as a png data URI (byte-parity with the browser's readImage path).
    expect(userRow?.multimodals).toEqual([
      { type: 'image', base64: `data:image/png;base64,${assetBytes.toString('base64')}` },
    ])
    expect(userRow?.content).not.toContain('{{asset_prompt::hero}}')
  })

  it('silently drops missing prompt-asset bytes and emits the established warning diagnostic', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const missingAssetId = 'c'.repeat(64)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithHistoryMessage('show {{asset_prompt::hero}}', {
        additionalAssets: [['hero', missingAssetId, 'image']],
      }),
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    const prompt = events.find((event) => event.type === 'prompt')!
    const formated = prompt.data.formated as Array<{
      role: string
      content: unknown
      multimodals?: unknown
    }>
    const userRow = formated.find(
      (row) => row.role === 'user' && typeof row.content === 'string' && row.content.includes('show'),
    )

    // Accepted divergence: baseline index.svelte.ts:947 rejected prompt
    // construction when the awaited asset read had no bytes.
    expect(userRow?.content).toBe('show')
    expect(userRow?.multimodals).toBeUndefined()
    expect(events.find((event) => event.type === 'warning')?.data).toEqual({
      message: 'Prompt asset was omitted because its metadata or stored bytes were unavailable.',
      context: {
        kind: 'prompt_asset_dropped',
        name: 'hero',
        reference: missingAssetId,
        reason: 'bytes_missing',
      },
    })
  })

  // `buildInlayViewInstruction` appends a static `system` row from `newGenData`
  // when `inlayViewScreen` is set. No request field is needed; the config is
  // already on the loaded character.
  function dbWithInlayView(view: 'emotion' | 'imggen', extra: Record<string, unknown>): unknown {
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      characters: Array<Record<string, unknown>>
    }
    Object.assign(db.characters[0], { inlayViewScreen: true, viewScreen: view, ...extra })
    return db
  }

  it('emits the emotion view instruction with {{slot}} → emotionImages', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithInlayView('emotion', {
        newGenData: {
          prompt: '',
          negative: '',
          instructions: '',
          emotionInstructions: 'Pick an emotion from: {{slot}}',
        },
        emotionImages: [
          ['happy', 'h.png'],
          ['sad', 's.png'],
        ],
      }),
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const prompt = parseEvents(res.body).find((e) => e.type === 'prompt')!
    const messages = prompt.data.messages as Array<{ role: string; content: string }>
    // The `{{slot}}` token was replaced by the comma-joined emotionImages names,
    // and the row rides as a system row (postEverything).
    expect(messages).toContainEqual({ role: 'system', content: 'Pick an emotion from: happy, sad' })
  })

  it('emits the imggen view instruction verbatim', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithInlayView('imggen', {
        newGenData: {
          prompt: '',
          negative: '',
          instructions: 'Generate an image of the current scene.',
          emotionInstructions: '',
        },
      }),
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const prompt = parseEvents(res.body).find((e) => e.type === 'prompt')!
    const messages = prompt.data.messages as Array<{ role: string; content: string }>
    expect(messages).toContainEqual({
      role: 'system',
      content: 'Generate an image of the current scene.',
    })
  })

  // With `inlayViewScreen` unset, no instruction row is appended.
  it('omits the view instruction when inlayViewScreen is unset', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const prompt = parseEvents(res.body).find((e) => e.type === 'prompt')!
    const messages = prompt.data.messages as Array<{ role: string; content: string }>
    expect(messages.some((m) => m.content.includes('emotion') || m.content.includes('Generate an image'))).toBe(false)
  })

  it('emits stop-trigger mutations and restoration before the terminal error', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      characters: Array<(typeof fixtureDatabase.characters)[number] & { triggerscript?: unknown }>
    }
    ;(db.characters[0].chats[0] as any).message = [{ role: 'user', data: 'before stop', chatId: 'msg-before-stop' }]
    ;(db.characters[0].chats[0] as any).scriptstate = { $score: '1' }
    db.characters[0].triggerscript = [
      {
        comment: '',
        type: 'start',
        conditions: [],
        effect: [
          { type: 'setvar', operator: '=', var: 'score', value: '9' },
          { type: 'impersonate', role: 'char', value: 'mutated before stop' },
          { type: 'stop' },
        ],
      },
    ]
    await seedDatabase(harness.app, assertion, db)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, clientCapabilities: { compactPromptEvent: true } },
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    expect(events.map((e) => e.type)).toEqual(['stage', 'stage', 'stage', 'message_patch', 'error', 'done'])
    const patch = events[3].data.patch as {
      varChanged?: boolean
      chatVarMutations?: unknown[]
      messageMutations?: Array<{ type?: string; source?: string; firstChangedIndex?: number; messages?: unknown[] }>
    }
    expect(patch.varChanged).toBe(true)
    expect(patch.chatVarMutations).toEqual([{ key: '$score', before: '1', after: '9' }])
    expect(patch.messageMutations?.map((m) => [m.type, m.source])).toEqual([
      ['append', 'user_message'],
      ['replace_all', 'start_trigger'],
    ])
    expect(patch.messageMutations?.at(-1)).toMatchObject({
      firstChangedIndex: 2,
      messages: [{ role: 'char', data: 'mutated before stop' }],
    })
    expect(events[4]).toEqual({
      type: 'error',
      data: {
        error: 'Generation was stopped by a start trigger.',
        reason: 'trigger_stop',
        restoration: {
          chatId: 'chat-1',
          characterId: 'char-1',
          selectedCharID: 0,
          chatPage: 0,
          messages: [{ role: 'user', data: 'before stop', chatId: 'msg-before-stop' }],
          scriptstate: { $score: '1' },
        },
      },
    })
  })

  it('emits a context-window error when history cannot fit after trimming', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      maxContext: 1,
      maxResponse: 50,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, clientCapabilities: { compactPromptEvent: true } },
    })
    expect(res.statusCode).toBe(200)

    const error = parseEvents(res.body).find((event) => event.type === 'error')
    expect(error?.data).toMatchObject({
      reason: 'history_context_overflow',
      error: expect.stringContaining(
        'Chat history could not fit within the model context window after trimming older messages',
      ),
    })
    expect(String(error?.data.error)).toContain('context limit 1')
  })

  it('persists the oldest surviving message id as the chat memory cutoff', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = structuredClone(fixtureDatabase)
    db.maxContext = 150
    db.maxResponse = 10
    ;(
      db.characters[0].chats[0] as unknown as {
        message: Array<{ role: 'user' | 'char'; data: string; chatId: string }>
      }
    ).message = [
      { role: 'user', data: 'oldest '.repeat(80), chatId: 'message-1' },
      { role: 'char', data: 'older '.repeat(80), chatId: 'message-2' },
      { role: 'user', data: 'recent '.repeat(80), chatId: 'message-3' },
      { role: 'char', data: 'newest '.repeat(20), chatId: 'message-4' },
    ]
    await seedDatabase(harness.app, assertion, db)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'continue',
        clientCapabilities: { compactPromptEvent: true },
      },
    })
    expect(response.statusCode).toBe(200)

    const events = parseEvents(response.body)
    const messageIds = new Set(['message-1', 'message-2', 'message-3', 'message-4'])
    const patch = events.find((event) => event.type === 'message_patch')?.data.patch as
      | { chatMetadataMutations?: Array<{ key: string; after: string | null }> }
      | undefined
    const firstSurvivingMessageId = patch?.chatMetadataMutations?.[0]?.after
    expect(typeof firstSurvivingMessageId === 'string' && messageIds.has(firstSurvivingMessageId)).toBe(true)
    expect(firstSurvivingMessageId).not.toBe('message-1')
    expect(patch?.chatMetadataMutations).toEqual([{ key: 'lastMemory', before: null, after: firstSurvivingMessageId }])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.resourceDatabase.characters[0].chats[0].lastMemory).toBe(firstSurvivingMessageId)
  })

  it('requires one per-chat confirmation before durable non-Hypa generation can trim history', async () => {
    const dispatchProvider = vi.fn(() =>
      (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'confirmed reply' }
        yield { kind: 'done', finishReason: 'stop' }
      })(),
    )
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    const db = structuredClone(fixtureDatabase)
    db.maxContext = 150
    db.maxResponse = 10
    ;(
      db.characters[0].chats[0] as unknown as {
        message: Array<{ role: 'user' | 'char'; data: string; chatId: string }>
      }
    ).message = [
      { role: 'user', data: 'oldest '.repeat(80), chatId: 'message-1' },
      { role: 'char', data: 'older '.repeat(80), chatId: 'message-2' },
      { role: 'user', data: 'recent '.repeat(80), chatId: 'message-3' },
      { role: 'char', data: 'newest '.repeat(20), chatId: 'message-4' },
    ]
    const revision = await seedDatabase(harness.app, assertion, db)
    const payload = {
      chatId: 'chat-1',
      characterId: 'char-1',
      mode: 'continue',
      durable: true,
      clientCapabilities: {
        compactPromptEvent: true,
        promptMetadataOnly: true,
        hypaContextTruncationConfirmation: true,
      },
    }

    const blocked = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload,
    })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.headers['content-type']).toMatch(/application\/json/)
    expect(blocked.body).not.toContain('job_accepted')
    expect(blocked.json()).toMatchObject({
      error: 'hypa_context_truncation_confirmation_required',
      chatId: 'chat-1',
    })
    expect(dispatchProvider).not.toHaveBeenCalled()

    const beforeConfirmation = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(beforeConfirmation.json().activeGenerationJobs).toEqual([])
    expect(beforeConfirmation.resourceDatabase.characters[0].chats[0]).not.toHaveProperty(
      'hypaContextTruncationAcknowledged',
    )

    const confirmation = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-1',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { hypaContextTruncationAcknowledged: true },
      },
    })
    expect(confirmation.statusCode).toBe(200)

    const accepted = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload,
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.body).toContain('job_accepted')
    expect(dispatchProvider).toHaveBeenCalledTimes(1)

    const afterConfirmation = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(afterConfirmation.resourceDatabase.characters[0].chats[0].hypaContextTruncationAcknowledged).toBe(true)
  })

  it('emits a final prompt overflow error when pinned rows exceed the context window', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = dbWithEditRequestLua(`
      listenEdit('editRequest', function(id, data, meta)
        for i = 1, #data do
          if data[i].role == 'system' then
            data[i].content = data[i].content .. string.rep(' overflow', 2000)
            break
          end
        end
        return data
      end)
    `) as typeof fixtureDatabase & { maxContext: number; maxResponse: number }
    db.maxContext = 200
    db.maxResponse = 1
    await seedDatabase(harness.app, assertion, db)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, clientCapabilities: { compactPromptEvent: true } },
    })
    expect(res.statusCode).toBe(200)

    const error = parseEvents(res.body).find((event) => event.type === 'error')
    expect(error?.data).toMatchObject({
      reason: 'overflow',
      error: expect.stringContaining(
        'Prompt is too large for the model context window after trimming removable history',
      ),
    })
    expect(String(error?.data.error)).toContain('context limit 200')
  })

  it('keeps preview-mode assembly read-only even when triggers set variables', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      characters: Array<(typeof fixtureDatabase.characters)[number] & { triggerscript?: unknown }>
    }
    db.characters[0].triggerscript = [
      {
        comment: '',
        type: 'start',
        conditions: [],
        effect: [{ type: 'setvar', operator: '=', var: 'score', value: '9' }],
      },
    ]
    await seedDatabase(harness.app, assertion, db)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'preview' },
    })
    expect(res.statusCode).toBe(200)
    expect(parseEvents(res.body).find((e) => e.type === 'prompt')).toBeDefined()

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toBeUndefined()
  })

  it('renders stable cards from post-start-trigger state in preview without persisting it', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      promptPresets: unknown[]
      promptPresetsId: number
      characters: Array<
        (typeof fixtureDatabase.characters)[number] & {
          triggerscript?: unknown
          chats: Array<(typeof fixtureDatabase.characters)[number]['chats'][number] & { scriptstate?: unknown }>
        }
      >
    }
    db.promptPresets = [
      {
        id: 'stable-preview-prompt',
        name: 'Stable preview prompt',
        promptTemplate: [{ type: 'plain', type2: 'main', text: 'Score={{getvar::score}}', role: 'system' }],
        promptSettings: db.promptSettings,
        customPromptTemplateToggle: '',
      },
    ]
    db.promptPresetsId = 0
    db.characters[0].chats[0].scriptstate = { $score: 'before' }
    db.characters[0].triggerscript = [
      {
        comment: '',
        type: 'start',
        conditions: [],
        effect: [{ type: 'setvar', operator: '=', var: 'score', value: 'after' }],
      },
    ]
    await seedDatabase(harness.app, assertion, db)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'preview' },
    })

    expect(response.statusCode).toBe(200)
    const prompt = parseEvents(response.body).find((event) => event.type === 'prompt')
    expect(prompt?.data.messages).toContainEqual({ role: 'system', content: 'Score=after' })
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toEqual({ $score: 'before' })
  })

  it('keeps preview-mode lorebook sticky writes read-only', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      characters: Array<
        (typeof fixtureDatabase.characters)[number] & {
          globalLore?: unknown[]
        }
      >
    }
    db.characters[0].globalLore = [
      {
        id: 'preview-lore-keep',
        key: 'cat',
        secondkey: '',
        insertorder: 100,
        comment: 'Preview sticky lore',
        content: '@@keep_activate_after_match\nPreview sticky lore.',
        mode: 'normal',
        alwaysActive: false,
        selective: false,
      },
    ]
    ;(db.characters[0].chats[0] as any).message = [
      { role: 'user', data: 'cat in preview transcript', chatId: 'preview-msg-1' },
    ]
    await seedDatabase(harness.app, assertion, db)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'preview' },
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    expect(events.find((e) => e.type === 'prompt')).toBeDefined()
    const patch = events.find((e) => e.type === 'message_patch')?.data.patch as
      | { chatVarMutations?: Array<{ key: string; before: unknown; after: unknown }> }
      | undefined
    expect(patch?.chatVarMutations).toEqual([{ key: '$__internal_ka_preview-lore-keep', before: null, after: 'true' }])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toBeUndefined()
  })

  it('does not persist when a non-active writer sends /chat (423 before the C-write)', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      characters: Array<(typeof fixtureDatabase.characters)[number] & { triggerscript?: unknown }>
    }
    db.characters[0].triggerscript = [
      {
        comment: '',
        type: 'start',
        conditions: [],
        effect: [{ type: 'setvar', operator: '=', var: 'score', value: '9' }],
      },
    ]
    await seedDatabase(harness.app, assertion, db)

    // A first browser session claims the active-writer role via bootstrap.
    const claim = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
    })
    expect(claim.statusCode).toBe(200)
    expect(claim.json().revision).toBe(1)

    // A stale session's send is rejected by the active-writer guard before
    // assembly runs, so no chat-var write is persisted.
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-b' },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(423)
    expect(res.json()).toMatchObject({ error: 'active_writer_stale' })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toBeUndefined()
  })

  it('emits an SSE error (not a 400) when the character is unknown', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, characterId: 'nope' },
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    const error = events.find((e) => e.type === 'error')
    expect(error).toBeDefined()
    expect(String(error!.data.error)).toMatch(/character not found/)
    expect(events.find((e) => e.type === 'prompt')).toBeUndefined()
    // Telemetry rides only on the success path.
    expect(events.find((e) => e.type === 'info')).toBeUndefined()
    expect(events.at(-1)?.type).toBe('done')
  })

  it('emits an SSE error when no database is persisted', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    const error = events.find((e) => e.type === 'error')
    expect(String(error!.data.error)).toMatch(/database not found/)
    expect(events.at(-1)?.type).toBe('done')
  })

  it('assembles a prompt for preview_prompt mode without userMessage', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'preview_prompt' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    const events = parseEvents(res.body)
    expect(events.find((e) => e.type === 'prompt')).toBeDefined()
  })

  it('streams provider tokens after prompt metadata through the chat SSE taxonomy', async () => {
    await restartHarness({
      dispatchProvider: ({ input, result, signal }) => {
        expect(input.mode).toBe('send')
        expect(result.prompt.messages?.length).toBeGreaterThan(0)
        expect(signal.aborted).toBe(false)
        async function* source(): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'Hel' }
          yield { kind: 'token', content: 'lo' }
          yield { kind: 'done', finishReason: 'stop' }
        }
        return source()
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    expect(events.map((e) => e.type)).toEqual([
      'stage',
      'stage',
      'stage',
      'prompt',
      'message_patch',
      'stage',
      'info',
      'token',
      'token',
      'done',
    ])
    expect(events.at(-3)?.type).toBe('token')
    expect(events.at(-2)?.type).toBe('token')
    expect(events.at(-1)?.type).toBe('done')
    expect(events.at(-1)?.data).toMatchObject({ result: 'Hello' })
    expect(typeof events.at(-1)?.data.generationId).toBe('string')
  })

  it.each([false, true])('reports half-streaming progress for stripped reasoning with durable=%s', async (durable) => {
    await restartHarness({
      dispatchProvider: () => {
        async function* source(): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: '', tokenCount: 5 }
          yield { kind: 'token', content: 'half', tokenCount: 2 }
          yield { kind: 'token', content: ' streamed', tokenCount: 3 }
          yield { kind: 'done', finishReason: 'stop' }
        }
        return source()
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      useStreaming: false,
      halfStreaming: true,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, durable },
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    expect(events.find((event) => event.type === 'info')?.data).toMatchObject({ halfStreaming: true })
    expect(events.filter((event) => event.type === 'token').map((event) => event.data.content)).toEqual([
      '',
      'half',
      ' streamed',
    ])
    const tokenEvents = events.filter((event) => event.type === 'token')
    expect(tokenEvents.map((event) => event.data.generatedTokens)).toEqual([5, 7, 10])
    expect(tokenEvents[0]?.data.elapsedMs).toBeGreaterThan(0)
    expect(tokenEvents[1]?.data.generatedTokens).toBeGreaterThan(tokenEvents[0]?.data.generatedTokens as number)
    expect(events.at(-1)?.data).toMatchObject({ result: 'half streamed' })
  })

  it('lets an imported incomplete chat be configured and then sent through server generation', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importRisuSaveDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'echo_model',
      echoMessage: 'configured import reply',
      echoDelay: 0,
      modelPresets: [{ id: 'model-import', name: 'Import Model', aiModel: 'echo_model' }],
      promptPresets: [{ id: 'prompt-import', name: 'Import Prompt' }],
      modelPresetsId: 0,
      promptPresetsId: 0,
      personas: [
        {
          id: 'persona-import',
          name: 'Import Persona',
          icon: '',
          personaPrompt: '',
          note: '',
        },
      ],
      selectedPersona: 0,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chaId: 'char-import',
          chats: [
            {
              id: 'chat-import',
              message: [],
              note: '',
              name: 'Imported Chat',
              localLore: [],
            },
          ],
        },
      ],
    })

    const importedBootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(importedBootstrap.statusCode).toBe(200)
    expect(importedBootstrap.resourceDatabase.characters[0].chats[0].generationSettings).toBeUndefined()

    const blocked = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        chatId: 'chat-import',
        characterId: 'char-import',
        mode: 'send',
        userMessage: 'hello imported chat',
      },
    })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error).toBe('chat_generation_settings_incomplete')

    const configuredSettings = {
      configured: true,
      personaId: 'persona-import',
      modelPresetId: 'model-import',
      promptPresetId: 'prompt-import',
      jailbreakToggle: false,
      sidebarToggles: {},
    }
    const configured = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-import/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationSettings: configuredSettings,
      },
    })
    expect(configured.statusCode).toBe(200)

    const sent = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        chatId: 'chat-import',
        characterId: 'char-import',
        mode: 'send',
        userMessage: 'hello imported chat',
      },
    })
    expect(sent.statusCode).toBe(200)
    const events = parseEvents(sent.body)
    expect(events.find((event) => event.type === 'prompt')).toBeDefined()
    expect(events.find((event) => event.type === 'info')).toBeDefined()
    expect(events.at(-2)).toEqual({ type: 'token', data: { content: 'configured import reply' } })
    expect(doneFrame(events).postGeneration?.revision).toBe(configured.json().revision + 1)
    await expect(persistedMessages(assertion, 'chat-import')).resolves.toEqual([
      expect.objectContaining({ role: 'char', data: 'configured import reply' }),
    ])
  })

  it('uses the production server dispatcher for generating modes', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'echo_model',
      echoMessage: 'server echo reply',
      echoDelay: 0,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    expect(events.map((e) => e.type)).toEqual([
      'stage',
      'stage',
      'stage',
      'prompt',
      'message_patch',
      'stage',
      'info',
      'token',
      'done',
    ])
    const info = events.find((e) => e.type === 'info')!
    expect(typeof info.data.generationId).toBe('string')
    expect(info.data.generationInfo).toMatchObject({
      model: 'echo_model',
      generationId: info.data.generationId,
      outputTokens: 50,
      maxContext: 100_000,
    })
    expect(events.at(-2)).toEqual({ type: 'token', data: { content: 'server echo reply' } })
    expect(events.at(-1)?.data).toMatchObject({
      result: 'server echo reply',
      generationId: info.data.generationId,
      generationInfo: {
        model: 'echo_model',
        generationId: info.data.generationId,
      },
    })
    // The inline path persists the assistant message server-side, so the `done`
    // frame carries the bumped revision and the chat shows the persisted reply.
    const done = events.at(-1)!.data as { postGeneration?: { revision?: number } }
    expect(done.postGeneration?.revision).toBe(2)

    const persisted = await persistedMessages(assertion)
    expect(persisted.at(-1)).toMatchObject({ role: 'char', data: 'server echo reply' })
  })

  it('omits the duplicate done result for a negotiated inline token stream', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'echo_model',
      echoMessage: 'server echo reply',
      echoDelay: 0,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        ...basePayload,
        durable: false,
        clientCapabilities: { omitDuplicateDoneResult: true },
      },
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    const streamedText = events
      .filter((event) => event.type === 'token')
      .map((event) => String(event.data.content ?? ''))
      .join('')
    expect(streamedText).toBe('server echo reply')
    const done = events.at(-1)
    expect(done?.type).toBe('done')
    expect(Object.hasOwn(done?.data ?? {}, 'result')).toBe(false)
    expect(done?.data).toMatchObject({
      generationId: expect.any(String),
      generationInfo: { model: 'echo_model' },
      postGeneration: { revision: 2 },
    })
    expect(res.body).not.toContain('"result":"server echo reply"')
  })

  // Server post-generation pass (output trigger + editoutput).
  //
  // After provider completion, the server runs the run-var pass, the `'output'`
  // trigger, and `editoutput` over the generated text. The chat-var delta is
  // persisted and surfaced, with final text / resend, on `done.postGeneration`.

  /** A server-dispatch echo db with char overrides. */
  function dbWithServerDispatch(charOverride: Record<string, unknown>): unknown {
    return {
      ...fixtureDatabase,
      aiModel: 'echo_model',
      echoMessage: 'server echo reply',
      echoDelay: 0,
      characters: [{ ...fixtureDatabase.characters[0], ...charOverride }],
    }
  }

  function doneFrame(events: PromptChatFrame[]): {
    result?: string
    alternates?: string[]
    postGeneration?: {
      messageId?: string
      finalText?: string
      revision?: number
      resendChat?: boolean
      agentPresetError?: {
        error: string
        message: string
        stepId?: string
      }
      messagePatch?: {
        varChanged?: boolean
        chatVarMutations?: Array<{ key: string; before: unknown; after: unknown }>
        characterFieldMutations?: Array<{ key: string; before: unknown; after: unknown }>
        localLoreMutation?: { before: unknown[]; after: unknown[] }
        messageMutations?: unknown[]
      }
      translation?: {
        status: 'succeeded' | 'failed' | 'running'
        jobId: string
        translation?: { text?: string }
        error?: string
      }
    }
  } {
    const done = events.at(-1)
    expect(done?.type).toBe('done')
    return done!.data as ReturnType<typeof doneFrame>
  }

  it('atomically persists output-trigger character and local-lore writes with the generated message', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithServerDispatch({
        chats: [
          {
            ...fixtureDatabase.characters[0].chats[0],
            localLore: [
              {
                id: 'output-lore-id',
                key: 'old',
                secondkey: '',
                insertorder: 10,
                comment: 'output-lore',
                content: 'old',
                mode: 'normal',
                alwaysActive: false,
                selective: false,
              },
            ],
          },
        ],
        triggerscript: [
          {
            id: 'durable-character-output',
            comment: '',
            type: 'output',
            conditions: [],
            effect: [
              {
                type: 'triggerlua',
                code: `
                  function onOutput(id)
                    setName(id, 'Output Tess')
                    setDescription(id, 'Output description')
                    setCharacterFirstMessage(id, 'Output greeting')
                    setBackgroundEmbedding(id, 'Output background')
                    upsertLocalLoreBook(id, 'output-lore', 'output replacement', { key = 'output-key' })
                  end
                `,
              },
            ],
          },
        ],
      }),
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, durable: true },
    })
    expect(res.statusCode).toBe(200)
    const done = doneFrame(parseEvents(res.body))
    expect(done.postGeneration?.messagePatch?.characterFieldMutations).toEqual([
      { key: 'name', before: 'Tess', after: 'Output Tess' },
      { key: 'firstMessage', before: 'Greetings.', after: 'Output greeting' },
      { key: 'backgroundHTML', before: null, after: 'Output background' },
      { key: 'desc', before: 'DESC', after: 'Output description' },
    ])
    expect(done.postGeneration?.messagePatch?.localLoreMutation?.after).toEqual([
      expect.objectContaining({
        id: 'output-lore-id',
        comment: 'output-lore',
        content: 'output replacement',
        key: 'output-key',
      }),
    ])

    const character = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-1',
      headers: { 'risu-auth': assertion },
    })
    expect(character.statusCode).toBe(200)
    expect(character.json().character).toMatchObject({
      name: 'Output Tess',
      desc: 'Output description',
      firstMessage: 'Output greeting',
      backgroundHTML: 'Output background',
      chats: [
        {
          localLore: [
            {
              id: 'output-lore-id',
              comment: 'output-lore',
              content: 'output replacement',
              key: 'output-key',
            },
          ],
        },
      ],
    })
    expect((await persistedMessages(assertion)).at(-1)).toMatchObject({
      role: 'char',
      data: 'server echo reply',
    })

    const db = openDatabase(harness.dataDir)
    try {
      expect(
        listPersistedCommandEventHistory(db)
          .filter((event) => event.type === 'generation.persisted')
          .at(-1),
      ).toMatchObject({
        type: 'generation.persisted',
        resource: 'chatTranscript',
        id: 'chat-1',
        parentId: 'char-1',
      })
    } finally {
      db.close()
    }
  })

  it.each([
    { scope: 'character_field', key: 'firstMessage' },
    { scope: 'local_lore', key: undefined },
    { scope: 'chat_variable', key: '$mood' },
  ] as const)(
    'inline finalization reconciles a concurrent $scope mutation without losing the generated message',
    async (testCase) => {
      let applyConcurrentEdit: () => Promise<void> = async () => {
        throw new Error('concurrent edit was not configured')
      }
      await restartHarness({
        dispatchProvider: () =>
          (async function* (): AsyncGenerator<CompletionStreamFrame> {
            yield { kind: 'token', content: 'conflict-safe reply' }
            await applyConcurrentEdit()
            yield { kind: 'done', finishReason: 'stop' }
          })(),
      })
      const { assertion } = await setupAuthedClient(harness.app)
      const outputEffect =
        testCase.scope === 'chat_variable'
          ? [{ type: 'setvar', operator: '=', var: 'mood', value: 'script-value' }]
          : [
              {
                type: 'triggerlua',
                code:
                  testCase.scope === 'character_field'
                    ? `
                        function onOutput(id)
                          setName(id, 'script name')
                          setDescription(id, 'script description')
                          setCharacterFirstMessage(id, 'script greeting')
                        end
                      `
                    : `function onOutput(id) upsertLocalLoreBook(id, 'script-lore', 'script lore') end`,
              },
            ]
      await seedDatabase(
        harness.app,
        assertion,
        dbWithServerDispatch({
          triggerscript: [
            {
              comment: '',
              type: 'output',
              conditions: [],
              effect: outputEffect,
            },
          ],
        }),
      )

      applyConcurrentEdit = async () => {
        const bootstrap = await injectComposedResourceDatabase(harness.app, {
          method: 'GET',
          url: '/api/v1/bootstrap',
          headers: { 'risu-auth': assertion },
        })
        const baseRevision = bootstrap.json().revision
        const edit =
          testCase.scope === 'character_field'
            ? await harness.app.inject({
                method: 'PATCH',
                url: '/api/v1/commands/characters/char-1',
                headers: { 'risu-auth': assertion },
                payload: { baseRevision, patch: { firstMessage: 'user greeting' } },
              })
            : testCase.scope === 'local_lore'
              ? await harness.app.inject({
                  method: 'PUT',
                  url: '/api/v1/commands/chats/chat-1/lorebooks',
                  headers: { 'risu-auth': assertion },
                  payload: {
                    baseRevision,
                    entries: [
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
                    ],
                  },
                })
              : await harness.app.inject({
                  method: 'PATCH',
                  url: '/api/v1/commands/chats/chat-1/scriptstate',
                  headers: { 'risu-auth': assertion },
                  payload: { baseRevision, patch: { $mood: 'user-value' } },
                })
        expect(edit.statusCode).toBe(200)
      }

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: basePayload,
      })
      expect(response.statusCode).toBe(200)
      const events = parseEvents(response.body)
      if (testCase.scope === 'local_lore') {
        expect(events.find((event) => event.type === 'warning')).toBeUndefined()
      } else {
        expect(events.find((event) => event.type === 'warning')?.data).toEqual({
          message: 'Some server script updates were skipped because their targets changed during generation.',
          context: {
            kind: 'stale_generation_script_mutations',
            droppedMutations: [{ scope: testCase.scope, key: testCase.key }],
          },
        })
      }
      const patch = doneFrame(events).postGeneration?.messagePatch
      if (testCase.scope === 'character_field') {
        expect(patch?.characterFieldMutations).toEqual([
          { key: 'name', before: 'Tess', after: 'script name' },
          { key: 'desc', before: 'DESC', after: 'script description' },
        ])
      }
      if (testCase.scope === 'local_lore') {
        expect(patch?.localLoreMutation?.after).toEqual([
          expect.objectContaining({ id: 'user-lore-id', content: 'user lore' }),
          expect.objectContaining({ comment: 'script-lore', content: 'script lore' }),
        ])
      }
      if (testCase.scope === 'chat_variable') expect(patch?.chatVarMutations ?? []).toEqual([])
      expect((await persistedMessages(assertion)).at(-1)).toMatchObject({
        role: 'char',
        data: 'conflict-safe reply',
      })

      const character = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/characters/char-1',
        headers: { 'risu-auth': assertion },
      })
      if (testCase.scope === 'character_field') {
        expect(character.json().character).toMatchObject({
          name: 'script name',
          desc: 'script description',
          firstMessage: 'user greeting',
        })
      } else if (testCase.scope === 'local_lore') {
        expect(character.json().character.chats[0].localLore).toEqual([
          expect.objectContaining({ id: 'user-lore-id', content: 'user lore' }),
          expect.objectContaining({ comment: 'script-lore', content: 'script lore' }),
        ])
      } else {
        expect(character.json().character.chats[0].scriptstate).toEqual({ $mood: 'user-value' })
      }
    },
  )

  it('drops only a truly conflicting scripted local-lore entry and keeps the concurrent user edit', async () => {
    let applyConcurrentEdit: () => Promise<void> = async () => {
      throw new Error('concurrent edit was not configured')
    }
    await restartHarness({
      dispatchProvider: () =>
        (async function* (): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'entry conflict reply' }
          await applyConcurrentEdit()
          yield { kind: 'done', finishReason: 'stop' }
        })(),
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const existingLore = {
      id: 'shared-lore-id',
      key: 'shared',
      secondkey: '',
      insertorder: 100,
      comment: 'shared-lore',
      content: 'original lore',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    await seedDatabase(
      harness.app,
      assertion,
      dbWithServerDispatch({
        chats: [{ ...fixtureDatabase.characters[0].chats[0], localLore: [existingLore] }],
        triggerscript: [
          {
            comment: '',
            type: 'output',
            conditions: [],
            effect: [
              {
                type: 'triggerlua',
                code: `
                  function onOutput(id)
                    upsertLocalLoreBook(id, 'shared-lore', 'script lore')
                    upsertLocalLoreBook(id, 'independent-script-lore', 'independent script lore')
                  end
                `,
              },
            ],
          },
        ],
      }),
    )
    applyConcurrentEdit = async () => {
      const bootstrap = await injectComposedResourceDatabase(harness.app, {
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': assertion },
      })
      const edit = await harness.app.inject({
        method: 'PUT',
        url: '/api/v1/commands/chats/chat-1/lorebooks',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: bootstrap.json().revision,
          entries: [{ ...existingLore, content: 'user lore' }],
        },
      })
      expect(edit.statusCode).toBe(200)
    }

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    const events = parseEvents(response.body)
    expect(events.find((event) => event.type === 'warning')?.data).toMatchObject({
      context: {
        kind: 'stale_generation_script_mutations',
        droppedMutations: [{ scope: 'local_lore' }],
      },
    })
    expect(doneFrame(events).postGeneration?.messagePatch?.localLoreMutation?.after).toEqual([
      expect.objectContaining({ id: 'shared-lore-id', content: 'user lore' }),
      expect.objectContaining({ comment: 'independent-script-lore', content: 'independent script lore' }),
    ])
    const character = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-1',
      headers: { 'risu-auth': assertion },
    })
    expect(character.json().character.chats[0].localLore).toEqual([
      expect.objectContaining({ id: 'shared-lore-id', content: 'user lore' }),
      expect.objectContaining({ comment: 'independent-script-lore', content: 'independent script lore' }),
    ])
  })

  it.each([
    {
      label: 'id-less',
      localLore: [
        {
          key: 'legacy-key',
          secondkey: '',
          insertorder: 10,
          comment: 'legacy-id-less',
          content: 'legacy id-less content',
          mode: 'normal',
          alwaysActive: false,
          selective: false,
        },
      ],
    },
    {
      label: 'duplicate-id',
      localLore: [
        {
          id: 'legacy-duplicate-id',
          key: 'legacy-one-key',
          secondkey: '',
          insertorder: 10,
          comment: 'legacy-duplicate-one',
          content: 'legacy duplicate one content',
          mode: 'normal',
          alwaysActive: false,
          selective: false,
        },
        {
          id: 'legacy-duplicate-id',
          key: 'legacy-two-key',
          secondkey: '',
          insertorder: 20,
          comment: 'legacy-duplicate-two',
          content: 'legacy duplicate two content',
          mode: 'normal',
          alwaysActive: false,
          selective: false,
        },
      ],
    },
  ])('repairs $label local lore ids without rolling back generation finalization', async (testCase) => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithServerDispatch({
        triggerscript: [
          {
            id: 'repair-lore-output',
            comment: '',
            type: 'output',
            conditions: [],
            effect: [
              {
                type: 'triggerlua',
                code: `
                  function onOutput(id)
                    upsertLocalLoreBook(id, 'trigger-added', 'trigger-added content', { key = 'trigger-key' })
                  end
                `,
              },
            ],
          },
        ],
      }),
    )
    overwritePersistedLocalLore(testCase.localLore)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const done = doneFrame(parseEvents(res.body))
    expect(done.postGeneration?.messagePatch?.localLoreMutation).toBeDefined()

    expect((await persistedMessages(assertion)).at(-1)).toMatchObject({
      role: 'char',
      data: 'server echo reply',
    })
    const character = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-1',
      headers: { 'risu-auth': assertion },
    })
    expect(character.statusCode).toBe(200)
    const persistedLore = character.json().character.chats[0].localLore as Array<Record<string, unknown>>
    expect(persistedLore).toHaveLength(testCase.localLore.length + 1)
    expect(persistedLore).toEqual(
      expect.arrayContaining([
        ...testCase.localLore.map((entry) =>
          expect.objectContaining({ comment: entry.comment, content: entry.content }),
        ),
        expect.objectContaining({
          comment: 'trigger-added',
          content: 'trigger-added content',
          key: 'trigger-key',
        }),
      ]),
    )
    const persistedIds = persistedLore.map((entry) => entry.id)
    expect(persistedIds.every((id) => typeof id === 'string' && id.trim().length > 0)).toBe(true)
    expect(new Set(persistedIds).size).toBe(persistedLore.length)
    const repairedLegacyComment = testCase.label === 'id-less' ? 'legacy-id-less' : 'legacy-duplicate-two'
    expect(persistedLore.find((entry) => entry.comment === repairedLegacyComment)?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    if (testCase.label === 'duplicate-id') {
      expect(persistedLore.find((entry) => entry.comment === 'legacy-duplicate-one')?.id).toBe('legacy-duplicate-id')
    }
  })

  it.each([
    {
      label: 'image',
      model: 'gemini-3-pro-image-preview',
      mimeType: 'image/png',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
      customFlags: undefined,
      modalities: ['TEXT', 'IMAGE'],
      catalogType: 'image',
    },
    {
      label: 'audio',
      model: 'gemini-2.5-flash',
      mimeType: 'audio/wav',
      bytes: Buffer.from('RIFF0000WAVEdata', 'ascii'),
      customFlags: [LLMFlags.hasAudioOutput],
      modalities: ['TEXT', 'AUDIO'],
      catalogType: 'audio',
    },
  ])(
    'forces buffered Gemini $label output, persists the native asset, and stores the marker-only message',
    async (testCase) => {
      const { assertion } = await setupAuthedClient(harness.app)
      await seedDatabase(harness.app, assertion, {
        ...fixtureDatabase,
        aiModel: testCase.model,
        google: { accessToken: 'gemini-test-key', projectId: 'test-project' },
        useStreaming: true,
        ...(testCase.customFlags ? { enableCustomFlags: true, customFlags: testCase.customFlags } : {}),
      })
      let capturedUrl = ''
      let capturedBody: Record<string, unknown> = {}
      vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url)
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: testCase.mimeType, data: testCase.bytes.toString('base64') } }],
                },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      })

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: basePayload,
      })
      expect(res.statusCode).toBe(200)
      expect(capturedUrl).toContain(':generateContent?key=gemini-test-key')
      expect(capturedUrl).not.toContain(':streamGenerateContent')
      expect((capturedBody.generationConfig as Record<string, unknown>).responseModalities).toEqual(testCase.modalities)

      const assetId = createHash('sha256').update(testCase.bytes).digest('hex')
      const marker = `{{inlay::${assetId}}}`
      expect(doneFrame(parseEvents(res.body)).result).toBe(marker)
      expect((await persistedMessages(assertion)).at(-1)).toMatchObject({ role: 'char', data: marker })

      const db = openDatabase(harness.dataDir)
      try {
        expect(assetById(db, assetId)).toMatchObject({
          id: assetId,
          contentType: testCase.mimeType,
          size: testCase.bytes.length,
        })
        expect(listInlayCatalogEntries(db)).toContainEqual(
          expect.objectContaining({ assetId, type: testCase.catalogType }),
        )
      } finally {
        db.close()
      }
    },
  )

  it('persists an output-trigger scriptstate delta server-side and surfaces it on done', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithServerDispatch({
        triggerscript: [
          {
            comment: '',
            type: 'output',
            conditions: [],
            effect: [{ type: 'setvar', operator: '=', var: 'mood', value: 'happy' }],
          },
        ],
      }),
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    const done = doneFrame(events)

    // The output trigger's `setvar` rode the post-gen message_patch + bumped the
    // revision. The completion text is unchanged (no editoutput), so no finalText.
    expect(done.postGeneration?.messagePatch?.varChanged).toBe(true)
    expect(done.postGeneration?.messagePatch?.chatVarMutations).toEqual([
      { key: '$mood', before: null, after: 'happy' },
    ])
    expect(done.postGeneration?.finalText).toBeUndefined()
    // Assembly had no chat-var write (no start trigger), so info.revision is unset;
    // the post-gen write is the first persist → revision 1 → 2.
    expect(events.find((e) => e.type === 'info')?.data.revision).toBeUndefined()
    expect(done.postGeneration?.revision).toBe(2)

    // Durable: bootstrap shows the post-gen scriptstate write + bumped revision.
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().revision).toBe(2)
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toEqual({ $mood: 'happy' })
  })

  it('notifies the push service after durable post-generation persistence', async () => {
    const sendChatCompletionNotification = vi.fn(async () => {})
    await restartHarness({
      pushNotifications: {
        publicKey: () => 'test-public-key',
        upsertSubscription: vi.fn(),
        deleteSubscription: vi.fn(),
        sendChatCompletionNotification,
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, { ...(dbWithServerDispatch({}) as object), notification: true })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, durable: true },
    })
    expect(res.statusCode).toBe(200)
    expect(doneFrame(parseEvents(res.body)).postGeneration?.revision).toBe(2)
    expect(sendChatCompletionNotification).toHaveBeenCalledWith({ characterId: 'char-1', chatId: 'chat-1' })
  })

  it('holds a connected done frame and notification until automatic translation succeeds', async () => {
    let releaseTranslation!: () => void
    const translationCanFinish = new Promise<void>((resolve) => {
      releaseTranslation = resolve
    })
    const sendChatCompletionNotification = vi.fn(async () => {})
    const runMessageTranslation = vi.fn(async (input: Parameters<ServerMessageTranslationRunner>[0]) => {
      expect(resolveActiveMessageLocationById(input.db, input.messageId).ok).toBe(true)
      await translationCanFinish
      return {
        revision: 3,
        event: {
          type: 'messageUpdated',
          revision: 3,
          resource: 'chatMessages',
          id: input.messageId,
          parentId: 'chat-1',
        },
        jobId: input.jobId,
        chatId: 'chat-1',
        messageId: input.messageId,
        translation: {
          source: 'raw' as const,
          text: 'translated generated reply',
          sourceHash: 'source-hash',
          targetLanguage: 'ko',
          inputLanguage: 'en',
          translatorType: 'google' as const,
          settingsHash: 'settings-hash',
          updatedAt: 123,
        },
      }
    })
    await restartHarness({
      pushNotifications: {
        publicKey: () => 'test-public-key',
        upsertSubscription: vi.fn(),
        deleteSubscription: vi.fn(),
        sendChatCompletionNotification,
      },
      runMessageTranslation,
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const database = dbWithServerDispatch({}) as Record<string, unknown>
    const characters = database.characters as Array<{ chats: Array<Record<string, unknown>> }>
    characters[0]!.chats[0]!.autoTranslate = true
    await seedDatabase(harness.app, assertion, {
      ...database,
      notification: true,
      translator: 'ko',
      translatorType: 'google',
      autoTranslateNotificationDeferCapSeconds: 30,
    })

    let responseSettled = false
    const responsePromise = harness.app
      .inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: basePayload,
      })
      .then((response) => {
        responseSettled = true
        return response
      })

    await vi.waitFor(() => expect(runMessageTranslation).toHaveBeenCalledTimes(1))
    expect(responseSettled).toBe(false)
    expect(sendChatCompletionNotification).not.toHaveBeenCalled()

    releaseTranslation()
    const response = await responsePromise
    const events = parseEvents(response.body)
    const progress = events.find(
      (event) => event.type === 'post_generation_progress' && event.data.phase === 'translation',
    )
    expect(progress?.data).toMatchObject({ status: 'translating', messageId: expect.any(String) })
    expect(doneFrame(events).postGeneration).toMatchObject({
      messageId: expect.any(String),
      translation: {
        status: 'succeeded',
        jobId: runMessageTranslation.mock.calls[0]![0].jobId,
        translation: { text: 'translated generated reply' },
      },
    })
    expect(sendChatCompletionNotification).toHaveBeenCalledTimes(1)
  })

  it('translates a durable completion after its last viewer disconnects and pushes after persistence', async () => {
    let releaseProvider!: () => void
    const providerCanFinish = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    const sendChatCompletionNotification = vi.fn(async () => {})
    const runMessageTranslation = vi.fn(runServerMessageTranslation)
    await restartHarness({
      dispatchProvider: () =>
        (async function* (): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'raw generated reply' }
          await providerCanFinish
          yield { kind: 'done', finishReason: 'stop' }
        })(),
      pushNotifications: {
        publicKey: () => 'test-public-key',
        upsertSubscription: vi.fn(),
        deleteSubscription: vi.fn(),
        sendChatCompletionNotification,
      },
      runMessageTranslation,
    })
    const { assertion } = await setupAuthedClient(harness.app)
    const database = dbWithServerDispatch({}) as Record<string, unknown>
    const characters = database.characters as Array<{ chats: Array<Record<string, unknown>> }>
    characters[0]!.chats[0]!.autoTranslate = true
    await seedDatabase(harness.app, assertion, {
      ...database,
      notification: true,
      translator: 'ko',
      translatorType: 'llm',
      translatorInputLanguage: 'en',
      translatorPrompt: 'Translate {{slot::content}} to {{slot}}',
      translatorMaxResponse: 128,
      autoTranslateNotificationDeferCapSeconds: 30,
      echoMessage: 'translated generated reply',
    })
    const before = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(before.resourceDatabase).toMatchObject({
      notification: true,
      translator: 'ko',
      translatorType: 'llm',
      characters: [{ chats: [{ id: 'chat-1', autoTranslate: true }] }],
    })
    const baseUrl = await listenHarness()
    const submitController = new AbortController()

    try {
      const res = await fetch(`${baseUrl}/api/v1/generate/chat`, {
        method: 'POST',
        headers: authHeaders(assertion, { 'content-type': 'application/json' }),
        body: JSON.stringify({ ...basePayload, durable: true }),
        signal: submitController.signal,
      })
      expect(res.status).toBe(200)
      const durableJobId = res.headers.get('x-risu-generation-job-id')
      expect(durableJobId).toBeTruthy()
      const initialEvents = await readStreamingEvents(res, (event) => event.type === 'token')
      expect(initialEvents.some((event) => event.type === 'token')).toBe(true)

      await res.body?.cancel()
      submitController.abort()
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      releaseProvider()

      await vi.waitFor(() => expect(runMessageTranslation).toHaveBeenCalledTimes(1))

      await vi.waitFor(
        async () => {
          const messages = (await readPersistedMessages(assertion)) as Array<{
            translation?: { text?: string }
          }>
          expect(messages.at(-1)?.translation?.text).toBe('translated generated reply')
        },
        { timeout: 3_000, interval: 25 },
      )
      expect(sendChatCompletionNotification).toHaveBeenCalledTimes(1)
      expect(sendChatCompletionNotification).toHaveBeenCalledWith({ characterId: 'char-1', chatId: 'chat-1' })

      const reattach = await fetch(`${baseUrl}/api/v1/generate/chat/${encodeURIComponent(durableJobId!)}/stream`, {
        headers: authHeaders(assertion),
      })
      expect(reattach.status).toBe(200)
      expect(doneFrame(parseEvents(await reattach.text())).postGeneration).toMatchObject({
        messageId: expect.any(String),
        translation: {
          status: 'succeeded',
          jobId: expect.any(String),
          translation: { text: 'translated generated reply' },
        },
      })
    } finally {
      submitController.abort()
      releaseProvider()
    }
  }, 8_000)

  it('surfaces low-level output-trigger resend on done without a post-generation patch', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithServerDispatch({
        lowLevelAccess: true,
        triggerscript: [
          {
            comment: '',
            type: 'output',
            conditions: [],
            effect: [{ type: 'sendAIprompt' }],
          },
        ],
      }),
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    const done = doneFrame(events)

    expect(done.postGeneration?.resendChat).toBe(true)
    expect(done.postGeneration?.messagePatch).toBeUndefined()
    expect(done.postGeneration?.finalText).toBeUndefined()
    expect(done.postGeneration?.revision).toBe(2)
  })

  it('durable DELETE cancel persists an editoutput-processed partial without completion-only effects', async () => {
    let providerSawAbort = false
    await restartHarness({
      dispatchProvider: ({ signal }) => {
        async function* source(): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'partial reply' }
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              providerSawAbort = true
              resolve()
              return
            }
            signal.addEventListener(
              'abort',
              () => {
                providerSawAbort = true
                resolve()
              },
              { once: true },
            )
          })
          if (signal.aborted) return
          yield { kind: 'done', finishReason: 'stop' }
        }
        return source()
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...(dbWithServerDispatch({
        customscript: [
          {
            in: 'partial reply',
            out: 'processed cancelled reply',
            type: 'editoutput',
            flag: '',
            ableFlag: false,
          },
        ],
        triggerscript: [
          {
            comment: '',
            type: 'output',
            conditions: [],
            effect: [{ type: 'setvar', operator: '=', var: 'mood', value: 'cancelled' }],
          },
        ],
      }) as Record<string, unknown>),
      ttsAutoSpeech: true,
    })
    const baseUrl = await listenHarness()
    const submitController = new AbortController()
    let observerController: AbortController | undefined

    try {
      const res = await fetch(`${baseUrl}/api/v1/generate/chat`, {
        method: 'POST',
        headers: authHeaders(assertion, { 'content-type': 'application/json' }),
        body: JSON.stringify({ ...basePayload, durable: true }),
        signal: submitController.signal,
      })
      expect(res.status).toBe(200)

      let jobId = ''
      const initialEvents = await readStreamingEvents(res, (event) => {
        if (event.type === 'job_accepted') jobId = String(event.data.jobId)
        return event.type === 'token'
      })
      expect(jobId).not.toBe('')
      expect(initialEvents.some((event) => event.type === 'token')).toBe(true)

      observerController = new AbortController()
      const observer = await fetch(`${baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}/stream`, {
        headers: authHeaders(assertion),
        signal: observerController.signal,
      })
      expect(observer.status).toBe(200)
      const observerEventsPromise = readStreamingEvents(observer, (event) => event.type === 'done')

      const del = await fetch(`${baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: authHeaders(assertion),
      })
      expect(del.status).toBe(202)
      expect(await del.json()).toMatchObject({ disposition: 'cancelling', jobId })

      const observerEvents = await observerEventsPromise
      const doneFrames = observerEvents.filter((event) => event.type === 'done')
      expect(doneFrames).toHaveLength(1)
      expect(doneFrames[0]?.data).toMatchObject({
        outcome: 'cancelled',
        result: 'partial reply',
        postGeneration: {
          revision: expect.any(Number),
          messageId: jobId,
          finalText: 'processed cancelled reply',
        },
      })
      expect(observerEvents.some((event) => event.type === 'side_effect')).toBe(false)
      expect(providerSawAbort).toBe(true)

      const replay = await fetch(`${baseUrl}/api/v1/generate/chat/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: authHeaders(assertion),
      })
      expect(replay.status).toBe(200)
      expect(await replay.json()).toMatchObject({ disposition: 'already_cancelled', jobId })

      const bootstrap = await injectComposedResourceDatabase(harness.app, {
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': assertion },
      })
      expect(bootstrap.statusCode).toBe(200)
      expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toBeUndefined()
      expect((await persistedMessages(assertion)).at(-1)).toMatchObject({
        role: 'char',
        data: 'processed cancelled reply',
        chatId: jobId,
      })
    } finally {
      submitController.abort()
      observerController?.abort()
    }
  }, 8000)

  it('message-only generation finalization is available through a ranged message read', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, dbWithServerDispatch({}))

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const db = openDatabase(harness.dataDir)
    let event: ReturnType<typeof listPersistedCommandEventHistory>[number] | undefined
    try {
      event = listPersistedCommandEventHistory(db)
        .filter((candidate) => candidate.type === 'generation.persisted')
        .at(-1)
    } finally {
      db.close()
    }
    expect(event).toMatchObject({
      type: 'generation.persisted',
      resource: 'generation',
      parentId: 'chat-1',
    })
    expect(event?.id).toEqual(expect.any(String))

    const messages = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/chats/chat-1/messages?start=0&limit=1',
      headers: { 'risu-auth': assertion },
    })
    expect(messages.statusCode).toBe(200)
    expect(messages.json()).toMatchObject({
      chatId: 'chat-1',
      messageStart: 0,
      messageTotal: 1,
    })
  })

  it('chat-variable generation finalization refreshes character metadata and messages', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithServerDispatch({
        triggerscript: [
          {
            comment: '',
            type: 'output',
            conditions: [],
            effect: [{ type: 'setvar', operator: '=', var: 'mood', value: 'happy' }],
          },
        ],
      }),
    )

    await withProtocolMetrics(async (metrics) => {
      const before = metrics.length
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: basePayload,
      })
      expect(res.statusCode).toBe(200)
      const done = doneFrame(parseEvents(res.body))
      expect(done.postGeneration?.messagePatch?.chatVarMutations).toEqual([
        { key: '$mood', before: null, after: 'happy' },
      ])
      expect(done.postGeneration?.revision).toBe(2)

      const commandMetric = metrics
        .slice(before)
        .find((entry) => entry.metric === 'command_mutation' && entry.type === 'generation.persisted')
      expect(commandMetric).toMatchObject({
        mutationPath: 'targeted-generation',
        dbJsonWriteMs: 0,
        writtenTables: ['chats', 'messages'],
      })
      assertCommandMetricGate(commandMetric as CommandMutationMetric)
      expect(commandMetric?.loadMs).toBeGreaterThanOrEqual(0)
      expect(commandMetric?.totalMs).toBeGreaterThanOrEqual(0)
    })

    const character = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-1',
      headers: { 'risu-auth': assertion },
    })
    expect(character.statusCode).toBe(200)
    expect(character.json().character.chats[0].scriptstate).toEqual({ $mood: 'happy' })

    const db = openDatabase(harness.dataDir)
    try {
      const event = listPersistedCommandEventHistory(db)
        .filter((candidate) => candidate.type === 'generation.persisted')
        .at(-1)
      expect(event).toMatchObject({
        type: 'generation.persisted',
        resource: 'chatTranscript',
        id: 'chat-1',
        parentId: 'char-1',
      })
    } finally {
      db.close()
    }
    const messages = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/chats/chat-1/messages',
      headers: { 'risu-auth': assertion },
    })
    expect(messages.statusCode).toBe(200)
    expect(messages.json()).toMatchObject({
      chatId: 'chat-1',
    })
    expect(messages.json().message).toHaveLength(1)
  })

  it('runs the pre-trigger run-var pass server-side over the completion text', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    // The echo completion carries a `{{setvar}}` the run-var pass evaluates + strips,
    // mirroring `applyOutputTrigger`'s pre-trigger run-var pass over the new turn.
    await seedDatabase(harness.app, assertion, {
      ...(dbWithServerDispatch({}) as Record<string, unknown>),
      echoMessage: 'reply {{setvar::seen::1}}done',
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const done = doneFrame(parseEvents(res.body))

    // The run-var pass stripped the `{{setvar}}` from the final text and persisted
    // the chat-var write.
    expect(done.postGeneration?.finalText).toBe('reply done')
    expect(done.postGeneration?.messagePatch?.chatVarMutations).toEqual([{ key: '$seen', before: null, after: '1' }])
    expect(done.postGeneration?.revision).toBe(2)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toEqual({ $seen: '1' })
  })

  it('runs a regex editoutput script server-side: the final text reflects the transform', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithServerDispatch({
        customscript: [{ comment: '', in: 'reply', out: 'REPLY', type: 'editoutput', flag: '', ableFlag: false }],
      }),
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    const done = doneFrame(events)

    // The raw streamed text is unchanged; server-owned `editoutput` rides on
    // `finalText`. The inline path persists the transformed message server-side,
    // so the revision bumps and bootstrap shows the editoutput-applied text.
    // No chat-var write, so no messagePatch.
    expect(done.result).toBe('server echo reply')
    expect(done.postGeneration?.finalText).toBe('server echo REPLY')
    expect(done.postGeneration?.revision).toBe(2)
    expect(done.postGeneration?.messagePatch).toBeUndefined()

    const persisted = await persistedMessages(assertion)
    expect(persisted.at(-1)).toMatchObject({ role: 'char', data: 'server echo REPLY' })
  })

  it('applies editoutput and incomplete-response trimming to every multi-generation choice', async () => {
    const dispatchProvider = vi.fn(() =>
      (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'primary reply. unfinished' }
        yield {
          kind: 'done',
          finishReason: 'stop',
          alternates: ['second reply. unfinished', 'third reply. unfinished'],
        }
      })(),
    )
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...(dbWithServerDispatch({
        customscript: [{ comment: '', in: 'reply', out: 'REPLY', type: 'editoutput', flag: '', ableFlag: false }],
      }) as Record<string, unknown>),
      removeIncompleteResponse: true,
      ttsAutoSpeech: true,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })

    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    const done = doneFrame(events)
    expect(done.postGeneration?.finalText).toBe('primary REPLY. ')
    expect(done.alternates).toEqual(['second REPLY. ', 'third REPLY. '])
    expect(
      events
        .filter((event) => event.type === 'side_effect' && event.data.kind === 'tts')
        .map((event) => (event.data.payload as { text?: unknown }).text),
    ).toEqual(['primary REPLY. ', 'second REPLY. ', 'third REPLY. '])

    const alternates = await persistedAlternates(assertion)
    expect(alternates.find((message) => message.chatId.endsWith(':alternate:1'))?.data).toBe('second REPLY. ')
    expect(alternates.find((message) => message.chatId.endsWith(':alternate:2'))?.data).toBe('third REPLY. ')
  })

  it('transforms alternates with the transformed primary present in chat context', async () => {
    const dispatchProvider = vi.fn(() =>
      (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'primary' }
        yield { kind: 'done', finishReason: 'stop', alternates: ['alternate'] }
      })(),
    )
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithServerDispatch({
        triggerscript: [
          {
            comment: '',
            type: 'output',
            conditions: [],
            effect: [
              {
                type: 'triggerlua',
                code: `
                  listenEdit('editOutput', function(id, data, meta)
                    return data .. ' [LEN:' .. tostring(getChatLength(id)) .. ']'
                  end)
                  function onOutput(id)
                    addChat(id, 'char', 'OUTPUT-MUTATION')
                  end
                `,
              },
            ],
          },
        ],
      }),
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })

    expect(res.statusCode).toBe(200)
    const done = doneFrame(parseEvents(res.body))
    const primaryLength = Number(/\[LEN:(\d+)\]/u.exec(done.postGeneration?.finalText ?? '')?.[1])
    const alternateLength = Number(/\[LEN:(\d+)\]/u.exec(done.alternates?.[0] ?? '')?.[1])
    expect(primaryLength).toBeGreaterThanOrEqual(0)
    expect(alternateLength).toBe(primaryLength + 1)
  })

  it('runs after-main Agent Preset modifiers before persisting the assistant row', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...(dbWithServerDispatch({
        customscript: [{ comment: '', in: 'reply', out: 'REPLY', type: 'editoutput', flag: '', ableFlag: false }],
        chats: [
          {
            id: 'chat-1',
            message: [],
            note: '',
            name: 'Chat',
            localLore: [],
            generationSettings: {
              configured: true,
              personaId: DEFAULT_TEST_PERSONA_ID,
              modelPresetId: DEFAULT_TEST_MODEL_PRESET_ID,
              promptPresetId: DEFAULT_TEST_PROMPT_PRESET_ID,
              agentPresetId: 'ap_after',
              jailbreakToggle: false,
              sidebarToggles: {},
            },
          },
        ],
      }) as Record<string, unknown>),
      modelProfiles: [
        {
          id: 'debug-after',
          name: 'Debug After',
          providerId: 'debug-echo',
          modelId: 'debug-echo',
          providerOptions: {
            baseUrl: 'debug://agent-after',
            requestModel: 'agent-after-model',
          },
        },
      ],
      agentPresets: [
        {
          id: 'ap_after',
          name: 'After Agent',
          enabled: true,
          version: 1,
          steps: [
            {
              id: 'aps_before',
              name: 'Before Research',
              enabled: true,
              phase: 'beforeMain',
              dependencies: [],
              instruction: 'Research context for the response.',
              model: { mode: 'modelProfile', profileId: 'debug-after' },
              runtime: { maxInputChars: 2_000, maxOutputChars: 500, timeoutMs: 5_000 },
              inputScopes: [],
              outputKey: 'research',
              outputFormat: 'text',
              destination: 'intermediate',
              failurePolicy: { mode: 'required' },
            },
            {
              id: 'aps_after',
              name: 'After Rewrite',
              enabled: true,
              phase: 'afterMain',
              dependencies: [],
              instruction: 'Rewrite the final answer.',
              model: { mode: 'modelProfile', profileId: 'debug-after' },
              runtime: { maxInputChars: 2_000, maxOutputChars: 500, timeoutMs: 5_000 },
              inputScopes: ['mainDraft'],
              outputKey: 'rewrite',
              outputFormat: 'text',
              destination: 'finalOutput',
              failurePolicy: { mode: 'required' },
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    const done = doneFrame(events)
    const agentProgress = events.filter((event) => event.type === 'agent_preset_progress')

    for (const phase of ['beforeMain', 'afterMain']) {
      const phaseProgress = agentProgress.filter((event) => event.data.phase === phase)
      expect(phaseProgress[0]?.data).toMatchObject({
        chatId: 'chat-1',
        presetId: 'ap_after',
        presetName: 'After Agent',
        phase,
        status: 'started',
        completedSteps: 0,
        totalSteps: 1,
      })
      expect(phaseProgress).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            phase,
            status: 'running',
            completedSteps: 0,
            activeSteps: [expect.objectContaining({ stepName: expect.any(String) })],
          }),
        }),
      )
      expect(phaseProgress.at(-1)?.data).toMatchObject({
        phase,
        status: 'finished',
        completedSteps: 1,
        totalSteps: 1,
        activeSteps: [],
      })
    }

    expect(done.result).toBe('server echo reply')
    expect(done.postGeneration?.finalText).toContain('"requestModel": "agent-after-model"')
    expect(done.postGeneration?.revision).toBe(2)

    const persisted = await persistedMessages(assertion)
    const assistant = persisted.at(-1)
    expect(assistant?.data).toContain('"requestModel": "agent-after-model"')
    const agentPresetInfo = assistant?.generationInfo as { agentPreset?: Record<string, unknown> } | undefined
    expect(agentPresetInfo?.agentPreset).toMatchObject({
      presetId: 'ap_after',
      finalTextModified: true,
      mainOutputPreview: 'server echo REPLY',
    })
  })

  it('uses and persists a before-main Agent Preset user-input modifier before main dispatch', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...(dbWithServerDispatch({
        chats: [
          {
            id: 'chat-1',
            message: [],
            note: '',
            name: 'Chat',
            localLore: [],
            generationSettings: {
              configured: true,
              personaId: DEFAULT_TEST_PERSONA_ID,
              modelPresetId: DEFAULT_TEST_MODEL_PRESET_ID,
              promptPresetId: DEFAULT_TEST_PROMPT_PRESET_ID,
              agentPresetId: 'ap_input',
              jailbreakToggle: false,
              sidebarToggles: {},
            },
          },
        ],
      }) as Record<string, unknown>),
      formatingOrder: ['main', 'description', 'chats', 'lastChat'],
      modelProfiles: [
        {
          id: 'debug-input',
          name: 'Debug Input',
          providerId: 'debug-echo',
          modelId: 'debug-echo',
          providerOptions: {
            baseUrl: 'debug://agent-input',
            requestModel: 'agent-input-model',
          },
        },
      ],
      agentPresets: [
        {
          id: 'ap_input',
          name: 'Input Agent',
          enabled: true,
          version: 1,
          steps: [
            {
              id: 'aps_input',
              name: 'Rewrite Input',
              enabled: true,
              phase: 'beforeMain',
              dependencies: [],
              instruction: 'Rewrite the current user message for the main model.',
              model: { mode: 'modelProfile', profileId: 'debug-input' },
              runtime: { maxInputChars: 2_000, maxOutputChars: 500, timeoutMs: 5_000 },
              inputScopes: ['currentUserMessage'],
              outputKey: 'input',
              outputFormat: 'text',
              destination: 'userInput',
              failurePolicy: { mode: 'required' },
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, userMessage: 'raw user input' },
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    const prompt = events.find((event) => event.type === 'prompt')
    expect(JSON.stringify(prompt?.data.messages)).toContain('agent-input-model')
    expect(doneFrame(events).postGeneration?.revision).toBe(3)

    const persisted = await persistedMessages(assertion)
    expect(persisted[0]).toMatchObject({ role: 'user' })
    expect(persisted[0]?.data).toContain('agent-input-model')
    const assistant = persisted.at(-1)
    const diagnostics = assistant?.generationInfo as { agentPreset?: Record<string, unknown> } | undefined
    expect(diagnostics?.agentPreset).toMatchObject({
      presetId: 'ap_input',
      userInputModifierStepId: 'aps_input',
      userInputModified: true,
    })
  })

  it('hydrates projected module stubs from the server module table before assembly runtime', async () => {
    await seedDatabase(harness.app, 'unused', {
      ...fixtureDatabase,
      modules: [
        {
          id: 'gigatrans-lite',
          name: 'GigaTrans Lite',
          description: '',
          trigger: [{ id: 'module-output', type: 'output', conditions: [], effect: [] }],
          regex: [{ id: 'module-regex', comment: '', in: 'foo', out: 'bar', type: 'editoutput' }],
          lorebook: [{ id: 'module-lore', key: 'foo', comment: 'Module Lore', content: 'body' }],
          assets: [['label', 'asset-id', 'png']],
        },
      ],
    })

    const db = openDatabase(harness.dataDir)
    try {
      const projected = {
        modules: [{ id: 'gigatrans-lite', name: 'GigaTrans Lite', description: '' }],
      }
      hydrateAssemblyModuleBodies(db, projected)

      expect(projected.modules[0]).toMatchObject({
        id: 'gigatrans-lite',
        trigger: [{ id: 'module-output' }],
        regex: [{ id: 'module-regex' }],
        lorebook: [{ id: 'module-lore' }],
        assets: [['label', 'asset-id', 'png']],
      })
    } finally {
      db.close()
    }
  })

  it('runs a chat-attached module output triggerlua over the generated assistant row', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...(dbWithServerDispatch({
        chats: [
          {
            ...fixtureDatabase.characters[0].chats[0],
            modules: ['gigatrans-lite'],
          },
        ],
      }) as Record<string, unknown>),
      modules: [
        {
          id: 'gigatrans-lite',
          name: 'GigaTrans Lite',
          description: '',
          trigger: [
            {
              id: 'module-output',
              comment: '',
              type: 'output',
              conditions: [],
              effect: [
                {
                  type: 'triggerlua',
                  code: `
                    function onOutput(id)
                      local index = getChatLength(id) - 1
                      local last = getChat(id, index)
                      setChat(id, index, last.data .. ' [GT]')
                    end
                  `,
                },
              ],
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const done = doneFrame(parseEvents(res.body))

    expect(done.result).toBe('server echo reply')
    expect(done.postGeneration?.finalText).toBe('server echo reply [GT]')
    expect(done.postGeneration?.revision).toBe(2)

    const persisted = await persistedMessages(assertion)
    expect(persisted.at(-1)).toMatchObject({ role: 'char', data: 'server echo reply [GT]' })
  })

  it('reports character-owned output Lua execution diagnostics', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const luaCode = `
      function onOutput(id)
        local index = getChatLength(id) - 1
        local last = getChat(id, index)
        setChat(id, index, last.data .. ' [CHAR]')
      end
    `
    await seedDatabase(
      harness.app,
      assertion,
      dbWithServerDispatch({
        triggerscript: [
          {
            id: 'character-output',
            comment: 'character output hook',
            type: 'output',
            conditions: [],
            effect: [{ type: 'triggerlua', code: luaCode }],
          },
        ],
      }),
    )

    await withProtocolMetrics(async (metrics, rawMetricLines) => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: basePayload,
      })
      expect(res.statusCode).toBe(200)
      const done = doneFrame(parseEvents(res.body))

      expect(done.result).toBe('server echo reply')
      expect(done.postGeneration?.finalText).toBe('server echo reply [CHAR]')

      const outputSelection = metrics.find(
        (entry) => entry.metric === 'generation_trigger_selection' && entry.mode === 'output',
      )
      expect(outputSelection).toMatchObject({
        triggerCount: 1,
        selectedTriggerCount: 1,
        triggerLuaEffectCount: 1,
        selectedTriggerLuaEffectCount: 1,
        characterTriggerCount: 1,
        selectedCharacterTriggerCount: 1,
        moduleTriggerCount: 0,
      })

      const ownerMetric = (metric: string, mode: string): ProtocolMetric | undefined =>
        metrics.find(
          (entry) =>
            entry.metric === metric &&
            entry.mode === mode &&
            (entry as unknown as Record<string, unknown>).ownerType === 'character',
        )
      const runtime = ownerMetric('generation_lua_runtime', 'output') as Record<string, unknown> | undefined
      expect(runtime).toMatchObject({
        mode: 'output',
        ownerType: 'character',
        ownerId: 'char-1',
        ownerName: 'Tess',
        triggerId: 'character-output',
        triggerIndex: 0,
        triggerComment: 'character output hook',
        triggerType: 'output',
        effectIndex: 0,
        effectType: 'triggerlua',
        handlerRegistered: true,
        resultShape: 'null',
      })
      expect(typeof runtime?.codeSha256).toBe('string')
      expect(runtime?.codeBytes).toBeGreaterThan(0)

      const effect = ownerMetric('generation_trigger_lua_effect', 'output') as Record<string, unknown> | undefined
      expect(effect).toMatchObject({
        status: 'ok',
        mode: 'output',
        luaMode: 'output',
        ownerType: 'character',
        ownerId: 'char-1',
        ownerName: 'Tess',
        triggerId: 'character-output',
        triggerIndex: 0,
        triggerComment: 'character output hook',
        triggerType: 'output',
        effectIndex: 0,
        effectType: 'triggerlua',
        messageCountBefore: 2,
        messageCountAfter: 2,
        messageCountDelta: 0,
        transcriptChanged: true,
        lastMessageChanged: true,
        lastMessageRoleBefore: 'char',
        lastMessageRoleAfter: 'char',
      })
      expect(typeof effect?.codeSha256).toBe('string')
      expect(effect?.codeBytes).toBeGreaterThan(0)
      expect(typeof effect?.transcriptSha256Before).toBe('string')
      expect(typeof effect?.transcriptSha256After).toBe('string')
      expect(effect?.transcriptSha256Before).not.toBe(effect?.transcriptSha256After)
      expect(typeof effect?.lastMessageSha256Before).toBe('string')
      expect(typeof effect?.lastMessageSha256After).toBe('string')
      expect(effect?.lastMessageSha256Before).not.toBe(effect?.lastMessageSha256After)

      const rawMetrics = rawMetricLines.join('\n')
      expect(rawMetrics).not.toContain('function onOutput')
      expect(rawMetrics).not.toContain('server echo reply [CHAR]')
    })
  })

  it('writes post-generation Lua flow metrics and body sidecar for editOutput/onOutput', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const luaCode = `
      listenEdit('editOutput', function(id, data, meta)
        log('editOutput sees: ' .. data)
        local ok, blocked = pcall(function()
          return LLM(id, {{ role = 'user', content = 'blocked prompt' }}, false)
        end)
        if ok and blocked ~= nil then
          return data .. ' [UNEXPECTED-LLM]'
        end
        return data .. ' [EDIT]'
      end)

      onOutput = async(function(id)
        log('onOutput start')
        local index = getChatLength(id) - 1
        local last = getChat(id, index)
        local result = axLLM(id, {{ role = 'user', content = 'aux prompt' }}, false)
        local aux = 'missing'
        if result and result.success then
          aux = result.result
        end
        setChat(id, index, last.data .. ' [OUT:' .. aux .. ']')
      end)
    `
    await seedDatabase(harness.app, assertion, {
      ...(dbWithServerDispatch({
        lowLevelAccess: true,
        triggerscript: [
          {
            id: 'character-postgen-trace',
            comment: 'post-generation trace hook',
            type: 'output',
            conditions: [],
            effect: [{ type: 'triggerlua', code: luaCode }],
          },
        ],
      }) as Record<string, unknown>),
      modelRoles: { scriptAux: 'echo_model' },
    })

    await withProtocolMetrics(async (metrics, rawMetricLines) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      let res: Awaited<ReturnType<typeof harness.app.inject>>
      try {
        res = await harness.app.inject({
          method: 'POST',
          url: '/api/v1/generate/chat',
          headers: { 'risu-auth': assertion },
          payload: basePayload,
        })
      } finally {
        logSpy.mockRestore()
      }
      expect(res.statusCode).toBe(200)
      const done = doneFrame(parseEvents(res.body))
      expect(done.postGeneration?.finalText).toBe('server echo reply [EDIT] [OUT:server echo reply]')

      const metric = metrics.find((entry) => entry.metric === 'generation_lua_post_generation_trace')
      expect(metric).toMatchObject({
        status: 'ok',
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'send',
        durable: false,
        runCount: 2,
        hostEventCount: 5,
        logCount: 2,
        llmAttemptCount: 1,
        llmBlockedCount: 1,
        axLlmAttemptCount: 1,
        axLlmCompletedCount: 1,
        setChatCount: 1,
        setChatChangedCount: 1,
        transcriptChanged: true,
        editOutputTextChanged: true,
      })
      expect(metric?.runs?.map((run) => run.phase)).toEqual(['editOutput', 'onOutput'])
      expect(metric?.runs?.[0]).toMatchObject({
        phase: 'editOutput',
        llmAttemptCount: 1,
        llmBlockedCount: 1,
        editOutputTextChanged: true,
        transcriptChanged: false,
      })
      expect(metric?.runs?.[1]).toMatchObject({
        phase: 'onOutput',
        axLlmAttemptCount: 1,
        axLlmCompletedCount: 1,
        setChatCount: 1,
        setChatChangedCount: 1,
        transcriptChanged: true,
      })

      const sidecar = readGenerationSidecar(harness.dataDir, metric?.bodySidecar) as {
        runs: Array<{
          phase: string
          editOutputTextBefore?: string
          editOutputTextAfter?: string
          chatBefore: Array<{ role: string; body: string }>
          chatAfter: Array<{ role: string; body: string }>
          hostEvents: Array<Record<string, unknown>>
        }>
      }
      expect(sidecar.runs[0]).toMatchObject({
        phase: 'editOutput',
        editOutputTextBefore: 'server echo reply',
        editOutputTextAfter: 'server echo reply [EDIT]',
      })
      expect(sidecar.runs[0].hostEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'log', fn: 'log', value: 'editOutput sees: server echo reply' }),
          expect.objectContaining({ type: 'llm', fn: 'LLM', status: 'blocked' }),
        ]),
      )
      expect(sidecar.runs[1].chatBefore.at(-1)).toMatchObject({
        role: 'char',
        body: 'server echo reply [EDIT]',
      })
      expect(sidecar.runs[1].chatAfter.at(-1)).toMatchObject({
        role: 'char',
        body: 'server echo reply [EDIT] [OUT:server echo reply]',
      })
      expect(sidecar.runs[1].hostEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'log', fn: 'log', value: 'onOutput start' }),
          expect.objectContaining({ type: 'llm', fn: 'axLLM', status: 'completed', success: true }),
          expect.objectContaining({ type: 'chat', fn: 'setChat', status: 'changed' }),
        ]),
      )

      const rawMetrics = rawMetricLines.join('\n')
      expect(rawMetrics).not.toContain('server echo reply [EDIT] [OUT:server echo reply]')
      expect(rawMetrics).not.toContain('blocked prompt')
      expect(rawMetrics).not.toContain('function(id, data, meta)')
    })
  })

  it('lets chat-attached module output Lua read module lorebooks before axLLM translation', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const legacyCharacter = {
      ...fixtureDatabase.characters[0],
      chats: [
        {
          ...fixtureDatabase.characters[0].chats[0],
          modules: ['gigatrans-lite'],
        },
      ],
    } as Record<string, unknown>
    delete legacyCharacter.type

    await seedDatabase(harness.app, assertion, {
      ...(dbWithServerDispatch({}) as Record<string, unknown>),
      characters: [legacyCharacter],
      modelRoles: { scriptAux: 'echo_model' },
      modules: [
        {
          id: 'gigatrans-lite',
          name: 'GigaTrans Lite',
          description: '',
          lowLevelAccess: true,
          lorebook: [
            {
              comment: 'translation-preset',
              key: '',
              secondkey: '',
              mode: 'normal',
              insertorder: 100,
              alwaysActive: false,
              selective: false,
              content: 'preset body',
            },
          ],
          trigger: [
            {
              id: 'module-output',
              comment: '',
              type: 'output',
              conditions: [],
              effect: [
                {
                  type: 'triggerlua',
                  code: `
                    onOutput = async(function(id)
                      local index = getChatLength(id) - 1
                      local books = getLoreBooks(id, 'translation-preset')
                      if not books or #books == 0 then
                        setChat(id, index, 'missing preset')
                        return
                      end
                      local result = axLLM(id, {{ role = 'user', content = books[1].content }}, false)
                      if not result or not result.success then
                        setChat(id, index, 'llm failed: ' .. tostring(result and result.result))
                        return
                      end
                      setChat(id, index, books[1].content .. ' -> ' .. result.result)
                    end)
                  `,
                },
              ],
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const done = doneFrame(parseEvents(res.body))

    expect(done.result).toBe('server echo reply')
    expect(done.postGeneration?.finalText).toBe('preset body -> server echo reply')
    expect(done.postGeneration?.revision).toBe(2)

    const persisted = await persistedMessages(assertion)
    expect(persisted.at(-1)).toMatchObject({ role: 'char', data: 'preset body -> server echo reply' })
  })

  // The inline continue / regenerate paths are server-persisted too; the browser
  // issues zero generation-result commands.
  function seedChatWithMessages(
    assertion: string,
    messages: Array<Record<string, unknown>>,
    echoMessage: string,
  ): Promise<number> {
    return seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      useSayNothing: false,
      aiModel: 'echo_model',
      echoMessage,
      echoDelay: 0,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [{ id: 'chat-1', message: messages, note: '', name: 'Chat', localLore: [] }],
        },
      ],
    })
  }

  it('persists a continue result server-side, extending the last row in place', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedChatWithMessages(
      assertion,
      [
        { role: 'user', data: 'tell me a story', chatId: 'msg-user-1' },
        { role: 'char', data: 'Once upon a time', chatId: 'msg-char-1', saying: 'char-1' },
      ],
      ' and they lived happily.',
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'continue' },
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    expect(events.find((event) => event.type === 'info')?.data).toMatchObject({
      continueDisposition: 'extend',
      continueBase: 'Once upon a time',
    })
    expect(doneFrame(events)).toMatchObject({
      continueDisposition: 'extend',
      continueBase: 'Once upon a time',
      postGeneration: { revision: 2 },
    })

    const persisted = await persistedMessages(assertion)
    // Extended the SAME assistant row (chatId preserved); no duplicate appended.
    expect(persisted).toHaveLength(2)
    expect(persisted[1].chatId).toBe('msg-char-1')
    expect(persisted[1].data).toContain('Once upon a time')
    expect(persisted[1].data).toContain('and they lived happily')
  })

  it('uses the original say-nothing boundary to append Continue output without exposing the prior assistant to module editoutput', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...(dbWithServerDispatch({
        chats: [
          {
            id: 'chat-1',
            message: [
              { role: 'user', data: 'tell me a story', chatId: 'msg-user-1' },
              {
                role: 'char',
                data: 'private reasoning\n### Chapter 1\nold chapter',
                chatId: 'msg-char-1',
                saying: 'char-1',
              },
            ],
            modules: ['cutedog'],
            note: '',
            name: 'Chat',
            localLore: [],
          },
        ],
      }) as Record<string, unknown>),
      useSayNothing: true,
      echoMessage: '\n### Chapter 2\nnew chapter',
      globalChatVariables: { toggle_showmethought: '0' },
      modules: [
        {
          id: 'cutedog',
          name: 'cutedog compatibility fixture',
          description: '',
          regex: [
            {
              comment: '앞부분 날리기',
              in: '([\\s\\S]*)#{1,4}\\s{0,1}Chapter([^\\n]+)\\n+([\\s\\S]*)',
              out: '{{#if_pure {{? {{getglobalvar::toggle_showmethought}}=0 }} }}\n## Response\n\n### Chapter$2\n\n$3{{/if}}{{#if_pure {{? {{getglobalvar::toggle_showmethought}}=1 }} }}\n$1\n\n## Response\n\n### Chapter$2\n\n$3{{/if}}',
              type: 'editoutput',
              ableFlag: true,
              flag: 'g<order 1>s',
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'continue' },
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    const info = events.find((event) => event.type === 'info')
    expect(info?.data.continueDisposition).toBe('append')
    expect(doneFrame(events).postGeneration?.finalText).toContain('new chapter')

    const persisted = await persistedMessages(assertion)
    expect(persisted).toHaveLength(3)
    expect(persisted[1]).toMatchObject({
      chatId: 'msg-char-1',
      data: 'private reasoning\n### Chapter 1\nold chapter',
    })
    expect(persisted[2]).toMatchObject({ role: 'char', chatId: expect.any(String) })
    expect(persisted[2].chatId).not.toBe('msg-char-1')
    expect(persisted[2].data).toContain('### Chapter 2')
    expect(persisted[2].data).toContain('new chapter')
    expect(persisted[2].data).not.toContain('old chapter')
    expect(persisted[2].data).not.toContain('*says nothing*')
  })

  it('keeps buffered Continue editoutput to one invocation (accepted divergence)', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...(dbWithServerDispatch({
        triggerscript: [
          {
            comment: '',
            type: 'output',
            conditions: [],
            effect: [
              {
                type: 'triggerlua',
                code: `
                  listenEdit('editOutput', function(id, data, meta)
                    local count = tonumber(getChatVar(id, 'editOutputCount')) or 0
                    setChatVar(id, 'editOutputCount', tostring(count + 1))
                    return data
                  end)
                `,
              },
            ],
          },
        ],
        chats: [
          {
            id: 'chat-1',
            message: [
              { role: 'user', data: 'continue this', chatId: 'msg-user-1' },
              { role: 'char', data: 'A', chatId: 'msg-char-1', saying: 'char-1' },
            ],
            note: '',
            name: 'Chat',
            localLore: [],
          },
        ],
      }) as Record<string, unknown>),
      echoMessage: ' +more',
      useStreaming: false,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'continue' },
    })

    expect(res.statusCode).toBe(200)
    const done = doneFrame(parseEvents(res.body))
    // Accepted divergence: baseline index.svelte.ts:1631 enters the buffered
    // loop whose Continue arm fires editoutput twice; Fastify intentionally does once.
    expect(done.postGeneration?.messagePatch?.chatVarMutations).toEqual([
      { key: '$editOutputCount', before: null, after: '1' },
    ])
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toEqual({ $editOutputCount: '1' })
  })

  it('excludes a Continue-displaced row and captures the extended row on a later regenerate', async () => {
    const replies = [' continued', 'replacement']
    let call = 0
    const dispatchProvider = vi.fn(() => {
      const reply = replies[call++]
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: reply }
        yield { kind: 'done', finishReason: 'stop' }
      })()
    })
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      useSayNothing: false,
      useStreaming: true,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [
            {
              id: 'chat-1',
              message: [
                { role: 'user', data: 'continue this', chatId: 'msg-user-1' },
                { role: 'char', data: 'A', chatId: 'msg-char-1', saying: 'char-1' },
              ],
              note: '',
              name: 'Chat',
              localLore: [],
            },
          ],
        },
      ],
    })

    const continued = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'continue' },
    })
    expect(continued.statusCode).toBe(200)

    // Hydration after Continue must expose the extended active row and no stale
    // pre-Continue candidate under its retained uid.
    const reloaded = await persistedMessages(assertion)
    const extended = reloaded.at(-1)!
    expect(extended).toMatchObject({ role: 'char', chatId: 'msg-char-1' })
    expect(extended.data).toContain('A')
    expect(extended.data).toContain('continued')
    expect(await persistedAlternates(assertion)).toEqual([])

    const regenerated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'regenerate',
        regenerateMessageId: extended.chatId,
      },
    })
    expect(regenerated.statusCode).toBe(200)
    expect(dispatchProvider).toHaveBeenCalledTimes(2)

    const alternates = await persistedAlternates(assertion)
    expect(alternates).toHaveLength(2)
    expect(alternates).toContainEqual(expect.objectContaining({ chatId: extended.chatId, data: extended.data }))
    expect(alternates.some((message) => message.data === 'A')).toBe(false)
  })

  it('persists a regenerate result server-side, replacing the target message', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedChatWithMessages(
      assertion,
      [
        { role: 'user', data: 'greet me', chatId: 'msg-user-1' },
        { role: 'char', data: 'old reply', chatId: 'msg-char-1', saying: 'char-1' },
      ],
      'a brand new reply',
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'regenerate',
        regenerateMessageId: 'msg-char-1',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(doneFrame(parseEvents(res.body)).postGeneration?.revision).toBe(2)

    const persisted = await persistedMessages(assertion)
    // The old target was REPLACED (not duplicated): the char row carries the new
    // text under a fresh generation id, and the old reply is gone.
    expect(persisted).toHaveLength(2)
    expect(persisted[0]).toMatchObject({ role: 'user', chatId: 'msg-user-1' })
    expect(persisted[1].role).toBe('char')
    expect(persisted[1].data).toContain('a brand new reply')
    expect(persisted[1].chatId).not.toBe('msg-char-1')
    expect(persisted.some((m) => m.data === 'old reply')).toBe(false)
  })

  it('rejects regenerate when the requested target is no longer authoritative', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedChatWithMessages(
      assertion,
      [{ role: 'user', data: 'greet me', chatId: 'msg-user-1' }],
      'a brand new reply',
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: {
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'regenerate',
        regenerateMessageId: 'stale-msg-char-1',
      },
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    expect(events.find((event) => event.type === 'prompt')).toBeUndefined()
    expect(String(events.find((event) => event.type === 'error')?.data.error)).toMatch(/regenerate message not found/)
    expect(events.at(-1)?.type).toBe('done')

    const persisted = await persistedMessages(assertion)
    expect(persisted).toEqual([expect.objectContaining({ role: 'user', chatId: 'msg-user-1' })])
    expect(await persistedAlternates(assertion)).toHaveLength(0)
  })

  // The reroll buffer preserves both the replaced candidate and the new one as
  // alternates, accumulates further regenerates by uid, and clears on send.
  it('preserves both the replaced and the new candidate as alternates, accumulates, and clears on send', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedChatWithMessages(
      assertion,
      [
        { role: 'user', data: 'greet me', chatId: 'msg-user-1' },
        { role: 'char', data: 'old reply', chatId: 'msg-char-1', saying: 'char-1' },
      ],
      'a brand new reply',
    )

    const regenerate = (targetId: string): Promise<{ statusCode: number }> =>
      harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: {
          chatId: 'chat-1',
          characterId: 'char-1',
          mode: 'regenerate',
          regenerateMessageId: targetId,
        },
      })

    // First regenerate: the displaced "old reply" AND the new active "a brand new
    // reply" are both preserved — swiping away from the new candidate must survive.
    expect((await regenerate('msg-char-1')).statusCode).toBe(200)
    let active = await persistedMessages(assertion)
    expect(active.at(-1)!.data).toContain('a brand new reply')
    let alternates = await persistedAlternates(assertion)
    expect(alternates).toHaveLength(2)
    expect(alternates.some((m) => m.data === 'old reply')).toBe(true)
    expect(alternates.some((m) => m.data.includes('a brand new reply'))).toBe(true)

    // Second regenerate (target = the now-active candidate): candidates accumulate —
    // the previously-active one is already buffered (deduped), the new one is added.
    expect((await regenerate(active.at(-1)!.chatId)).statusCode).toBe(200)
    alternates = await persistedAlternates(assertion)
    expect(alternates).toHaveLength(3)
    expect(alternates.filter((m) => m.data === 'old reply')).toHaveLength(1)
    expect(alternates.filter((m) => m.data.includes('a brand new reply'))).toHaveLength(2)
    // The active transcript stays a single char row (no duplication).
    active = await persistedMessages(assertion)
    expect(active.filter((m) => m.role === 'char')).toHaveLength(1)

    // A send confirms the turn → the reroll buffer is dropped.
    const send = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'send', userMessage: 'again' },
    })
    expect(send.statusCode).toBe(200)
    expect(await persistedAlternates(assertion)).toHaveLength(0)
  })

  it.each([
    { persistence: 'inline', durable: false },
    { persistence: 'durable', durable: true },
  ])(
    '$persistence finalization atomically confirms only the exact prior turn after a later successful send',
    async ({ durable }) => {
      const onBardWikiJobEnqueued = vi.fn()
      await restartHarness({ onBardWikiJobEnqueued })
      const { assertion } = await setupAuthedClient(harness.app)
      await seedDatabase(harness.app, assertion, {
        ...fixtureDatabase,
        useSayNothing: false,
        aiModel: 'echo_model',
        echoMessage: 'the new candidate reply',
        echoDelay: 0,
        bardWiki: {
          ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
          enabledByDefault: true,
          memoryMode: 'bardwiki',
          confirmationPolicy: 'automatic',
        },
        characters: [
          {
            ...fixtureDatabase.characters[0],
            chats: [
              {
                id: 'chat-1',
                message: [
                  { role: 'user', data: 'the prior user turn', chatId: 'prior-user' },
                  { role: 'char', data: 'the prior candidate', chatId: 'prior-assistant', saying: 'char-1' },
                  { role: 'user', data: 'the accepted next user', chatId: 'accepted-user' },
                ],
                note: '',
                name: 'Chat',
                localLore: [],
              },
            ],
          },
        ],
      })
      const settingsDb = openDatabase(harness.dataDir)
      try {
        const settings = settingsDb.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
          data_json: string
        }
        expect((JSON.parse(settings.data_json) as { bardWiki?: unknown }).bardWiki).toMatchObject({
          enabledByDefault: true,
          confirmationPolicy: 'automatic',
        })
      } finally {
        settingsDb.close()
      }

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: {
          chatId: 'chat-1',
          characterId: 'char-1',
          mode: 'send',
          userMessage: 'the accepted next user',
          durable,
        },
      })
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('the new candidate reply')
      expect(await persistedMessages(assertion)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'char', data: expect.stringContaining('the new candidate reply') }),
        ]),
      )
      const db = openDatabase(harness.dataDir)
      try {
        expect(
          db
            .prepare(
              `SELECT user_message_id, assistant_message_id, confirmation_mode, state
             FROM bardwiki_turn_receipts`,
            )
            .all(),
        ).toEqual([
          {
            user_message_id: 'prior-user',
            assistant_message_id: 'prior-assistant',
            confirmation_mode: 'automatic',
            state: 'queued',
          },
        ])
        expect(db.prepare('SELECT kind, status FROM bardwiki_jobs').all()).toEqual([
          { kind: 'apply_turn', status: 'pending' },
        ])
        expect(onBardWikiJobEnqueued).toHaveBeenCalledOnce()
        expect(onBardWikiJobEnqueued).toHaveBeenCalledWith(expect.objectContaining({ kind: 'apply_turn' }))
        expect(listPersistedCommandEventHistory(db).filter((event) => event.type.startsWith('bardwiki.'))).toEqual([])
      } finally {
        db.close()
      }
    },
  )

  it('does not automatically confirm on the first send, continue, or regenerate', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const automaticDatabase = (messages: Array<Record<string, unknown>>, echoMessage: string) => ({
      ...fixtureDatabase,
      useSayNothing: false,
      aiModel: 'echo_model',
      echoMessage,
      echoDelay: 0,
      bardWiki: {
        ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
        enabledByDefault: true,
        memoryMode: 'bardwiki',
        confirmationPolicy: 'automatic',
      },
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [{ id: 'chat-1', message: messages, note: '', name: 'Chat', localLore: [] }],
        },
      ],
    })
    const receiptCount = (): number => {
      const db = openDatabase(harness.dataDir)
      try {
        return Number(
          (db.prepare('SELECT COUNT(*) AS count FROM bardwiki_turn_receipts').get() as { count: number }).count,
        )
      } finally {
        db.close()
      }
    }

    await seedDatabase(
      harness.app,
      assertion,
      automaticDatabase([{ role: 'user', data: 'first user', chatId: 'first-user' }], 'first candidate'),
    )
    expect(
      (
        await harness.app.inject({
          method: 'POST',
          url: '/api/v1/generate/chat',
          headers: { 'risu-auth': assertion },
          payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'send', userMessage: 'first user' },
        })
      ).statusCode,
    ).toBe(200)
    expect(receiptCount()).toBe(0)

    const pair = [
      { role: 'user', data: 'prior user', chatId: 'prior-user' },
      { role: 'char', data: 'prior assistant', chatId: 'prior-assistant', saying: 'char-1' },
    ]
    await seedDatabase(harness.app, assertion, automaticDatabase(pair, ' continued'))
    expect(
      (
        await harness.app.inject({
          method: 'POST',
          url: '/api/v1/generate/chat',
          headers: { 'risu-auth': assertion },
          payload: { chatId: 'chat-1', characterId: 'char-1', mode: 'continue' },
        })
      ).statusCode,
    ).toBe(200)
    expect(receiptCount()).toBe(0)

    await seedDatabase(harness.app, assertion, automaticDatabase(pair, 'replacement candidate'))
    expect(
      (
        await harness.app.inject({
          method: 'POST',
          url: '/api/v1/generate/chat',
          headers: { 'risu-auth': assertion },
          payload: {
            chatId: 'chat-1',
            characterId: 'char-1',
            mode: 'regenerate',
            regenerateMessageId: 'prior-assistant',
          },
        })
      ).statusCode,
    ).toBe(200)
    expect(receiptCount()).toBe(0)
  })

  it('runs a Lua editOutput hook server-side over the completion', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithServerDispatch({
        triggerscript: [
          {
            comment: '',
            type: 'output',
            conditions: [],
            effect: [
              {
                type: 'triggerlua',
                code: `
                  listenEdit('editOutput', function(id, data, meta)
                    return data .. ' [LUA-OUT]'
                  end)
                `,
              },
            ],
          },
        ],
      }),
    )

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const done = doneFrame(parseEvents(res.body))
    // The Lua `editOutput` listener ran on the server VM over the completion text.
    expect(done.postGeneration?.finalText).toBe('server echo reply [LUA-OUT]')
  })

  it('warns and persists raw provider text when server Lua editOutput fails', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...(dbWithServerDispatch({
        triggerscript: [
          {
            comment: '',
            type: 'output',
            conditions: [],
            effect: [
              {
                type: 'triggerlua',
                code: `
                    listenEdit('editOutput', function(id, data, meta)
                      error('lua edit output failed')
                    end)
                  `,
              },
            ],
          },
        ],
      }) as Record<string, unknown>),
      echoMessage: 'Complete sentence. unfinished fragment',
      removeIncompleteResponse: true,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    const events = parseEvents(res.body)
    expect(events.find((event) => event.type === 'warning')?.data).toMatchObject({
      message: 'server post-generation derivation failed; persisted the raw provider text.',
    })
    const done = doneFrame(events)
    expect(done.postGeneration?.revision).toBe(2)
    expect(done.postGeneration?.finalText).toBeUndefined()

    const persisted = await persistedMessages(assertion)
    expect(persisted.at(-1)).toMatchObject({ role: 'char', data: 'Complete sentence. ' })
  })

  it('emits a metadata-only raw fallback metric when Lua onOutput fails', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(
      harness.app,
      assertion,
      dbWithServerDispatch({
        triggerscript: [
          {
            comment: '',
            type: 'output',
            conditions: [],
            effect: [
              {
                type: 'triggerlua',
                code: `
                  function onOutput(triggerId)
                    error('lua output trigger failed hard')
                  end
                `,
              },
            ],
          },
        ],
      }),
    )

    await withProtocolMetrics(async (metrics) => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: basePayload,
      })
      expect(res.statusCode).toBe(200)
      const events = parseEvents(res.body)
      expect(events.find((event) => event.type === 'warning')?.data).toMatchObject({
        message: 'server post-generation derivation failed; persisted the raw provider text.',
      })

      const fallback = metrics.find((entry) => entry.metric === 'generation_post_generation_fallback')
      expect(fallback).toMatchObject({
        fallbackType: 'raw_provider_text',
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'send',
        targetSnapshotKind: 'tail',
        targetSnapshotTranscriptLength: 0,
        completionLength: 'server echo reply'.length,
        completionBytes: Buffer.byteLength('server echo reply', 'utf8'),
        completionSha256: createHash('sha256').update('server echo reply', 'utf8').digest('hex'),
        source: 'lua_output_trigger',
      })
      expect(typeof fallback?.generationId).toBe('string')
      expect(String(fallback?.error)).toContain('Lua output trigger failed')
      expect(JSON.stringify(fallback)).not.toContain('server echo reply')
      expect(Object.hasOwn(fallback ?? {}, 'completionText')).toBe(false)
      expect(Object.hasOwn(fallback ?? {}, 'promptInfo')).toBe(false)
      expect(Object.hasOwn(fallback ?? {}, 'userMessage')).toBe(false)
    })
  })

  it('attributes module onOutput Lua fallback metrics without logging code or completion text', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const leakedCompletion = 'server echo reply'
    await seedDatabase(harness.app, assertion, {
      ...(dbWithServerDispatch({}) as Record<string, unknown>),
      enabledModules: ['mod-output-lua'],
      modules: [
        {
          id: 'mod-output-lua',
          name: 'Output Lua Module',
          description: '',
          lowLevelAccess: true,
          trigger: [
            {
              comment: 'module output hook',
              type: 'output',
              conditions: [],
              effect: [
                {
                  type: 'triggerlua',
                  code: `
                    function onOutput(triggerId)
                      local lastMessage = getChat(triggerId, -1)
                      error(lastMessage.data)
                    end
                  `,
                },
              ],
            },
          ],
        },
      ],
    })

    await withProtocolMetrics(async (metrics, rawMetricLines) => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: basePayload,
      })
      expect(res.statusCode).toBe(200)
      const events = parseEvents(res.body)
      expect(events.find((event) => event.type === 'warning')?.data).toMatchObject({
        message: 'server post-generation derivation failed; persisted the raw provider text.',
      })

      const fallback = metrics.find((entry) => entry.metric === 'generation_post_generation_fallback')
      const fallbackFields = fallback as Record<string, unknown> | undefined
      expect(fallback).toMatchObject({
        fallbackType: 'raw_provider_text',
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'send',
        source: 'lua_output_trigger',
        ownerType: 'module',
        ownerId: 'mod-output-lua',
        ownerName: 'Output Lua Module',
        triggerIndex: 0,
        triggerComment: 'module output hook',
        triggerType: 'output',
        effectIndex: 0,
        effectType: 'triggerlua',
        luaMode: 'output',
        luaLowLevelAccess: true,
      })
      expect(typeof fallbackFields?.luaCodeSha256).toBe('string')
      expect(fallbackFields?.luaCodeBytes).toBeGreaterThan(0)
      expect(String(fallback?.error)).toContain('Lua output trigger failed')
      expect(fallbackFields?.luaErrorKind).toBe('lua_error')
      expect(Object.hasOwn(fallback ?? {}, 'luaError')).toBe(false)
      expect(JSON.stringify(fallback)).not.toContain(leakedCompletion)
      expect(Object.hasOwn(fallback ?? {}, 'completionText')).toBe(false)
      expect(Object.hasOwn(fallback ?? {}, 'code')).toBe(false)
      expect(Object.hasOwn(fallback ?? {}, 'promptInfo')).toBe(false)

      const rawMetrics = rawMetricLines.join('\n')
      expect(rawMetrics).not.toContain(leakedCompletion)
      expect(rawMetrics).not.toContain('function onOutput')
      expect(rawMetrics).not.toContain('lastMessage.data')

      const runtime = metrics.find(
        (entry) =>
          entry.metric === 'generation_lua_runtime' &&
          entry.mode === 'output' &&
          (entry as unknown as Record<string, unknown>).ownerId === 'mod-output-lua',
      )
      expect(runtime).toMatchObject({
        mode: 'output',
        ownerType: 'module',
        ownerId: 'mod-output-lua',
        ownerName: 'Output Lua Module',
        triggerIndex: 0,
        triggerComment: 'module output hook',
        triggerType: 'output',
        effectIndex: 0,
        effectType: 'triggerlua',
        lowLevelAccess: true,
        errorKind: 'lua_error',
      })
      expect(Object.hasOwn(runtime ?? {}, 'error')).toBe(false)
      expect(JSON.stringify(runtime)).not.toContain(leakedCompletion)

      const persisted = await persistedMessages(assertion)
      expect(persisted.at(-1)).toMatchObject({ role: 'char', data: leakedCompletion })
    })
  })

  it.each([
    {
      label: 'NovelAI text',
      database: { aiModel: 'novelai' },
      error: 'unsupported /chat provider: NovelAI text generation must use local dispatch',
    },
    {
      label: 'NovelList',
      database: { aiModel: 'novellist' },
      error: 'unsupported /chat provider: NovelList must use local dispatch',
    },
    {
      label: 'plugin legacy',
      database: { aiModel: 'custom' },
      error: 'unsupported /chat provider: plugin providers must use local dispatch',
    },
    {
      label: 'plugin V3',
      database: { aiModel: 'pluginmodel:::provider-a' },
      error: 'unsupported /chat provider: plugin providers must use local dispatch',
    },
    {
      label: 'local WebLLM',
      database: { aiModel: 'hf:::Xenova/opt-350m' },
      error: 'unsupported /chat provider: local WebLLM models must use local dispatch',
    },
    {
      label: 'unknown OpenAI-compatible model',
      database: { aiModel: 'unregistered-local-model' },
      error:
        'unsupported /chat provider: unknown OpenAI-compatible model "unregistered-local-model" cannot be dispatched by the server',
    },
  ])('emits an explicit unsupported-provider error for $label without provider tokens', async ({ database, error }) => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      ...database,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    expect(events.map((e) => e.type)).toEqual([
      'stage',
      'stage',
      'stage',
      'prompt',
      'message_patch',
      'stage',
      'info',
      'error',
      'done',
    ])
    expect(events.some((e) => e.type === 'token')).toBe(false)
    expect(events.at(-2)).toEqual({
      type: 'error',
      data: {
        error,
        reason: 'provider_dispatch_exception',
        restoration: {
          chatId: 'chat-1',
          characterId: 'char-1',
          selectedCharID: 0,
          chatPage: 0,
          messages: [],
        },
      },
    })
    expect(typeof events.at(-1)?.data.generationId).toBe('string')
  })

  it('emits a typed tts side_effect before done when auto speech is enabled', async () => {
    await restartHarness({
      dispatchProvider: () => {
        async function* source(): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'spoken reply' }
          yield { kind: 'done', finishReason: 'stop' }
        }
        return source()
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      ttsAutoSpeech: true,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    expect(events.map((e) => e.type)).toEqual([
      'stage',
      'stage',
      'stage',
      'prompt',
      'message_patch',
      'stage',
      'info',
      'token',
      'side_effect',
      'done',
    ])
    expect(events.at(-2)).toEqual({
      type: 'side_effect',
      data: {
        kind: 'tts',
        payload: { text: 'spoken reply', characterId: 'char-1' },
      },
    })
  })

  it('maps provider transport failures to error then done after prompt metadata', async () => {
    await restartHarness({
      dispatchProvider: () => {
        async function* source(): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'partial' }
          throw new Error('provider exploded')
        }
        return source()
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    expect(events.map((e) => e.type)).toEqual([
      'stage',
      'stage',
      'stage',
      'prompt',
      'message_patch',
      'stage',
      'info',
      'token',
      'error',
      'done',
    ])
    expect(events.at(-2)).toMatchObject({
      type: 'error',
      data: {
        error: 'provider exploded',
        reason: 'provider_stream_exception',
        result: 'partial',
        postGeneration: {
          revision: expect.any(Number),
          messageId: expect.any(String),
          finalText: 'partial',
        },
        restoration: {
          chatId: 'chat-1',
          characterId: 'char-1',
          selectedCharID: 0,
          chatPage: 0,
          messages: [],
        },
      },
    })
    expect(events.at(-1)?.type).toBe('done')
    expect(typeof events.at(-1)?.data.generationId).toBe('string')
    expect(events.at(-1)?.data).toMatchObject({
      result: 'partial',
      postGeneration: { finalText: 'partial' },
    })
    expect((await readPersistedMessages(assertion)).filter((message) => message.role === 'char')).toEqual([
      expect.objectContaining({ data: 'partial' }),
    ])
  })

  it('keeps the transcript unchanged when a provider stream fails before its first token', async () => {
    await restartHarness({
      dispatchProvider: () => {
        async function* source(): AsyncGenerator<CompletionStreamFrame> {
          throw new Error('provider failed before tokens')
        }
        return source()
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const error = parseEvents(res.body).find((event) => event.type === 'error')
    expect(error?.data).toMatchObject({
      error: 'provider failed before tokens',
      reason: 'provider_dispatch_exception',
      restoration: { chatId: 'chat-1', characterId: 'char-1', messages: [] },
    })
    expect(error?.data).not.toHaveProperty('result')
    expect(error?.data).not.toHaveProperty('postGeneration')
    expect((await readPersistedMessages(assertion)).filter((message) => message.role === 'char')).toEqual([])
  })

  it('surfaces a provider error frame after streamed tokens without retrying and retains the failed partial', async () => {
    const dispatchProvider = vi.fn(() =>
      (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'partial' }
        yield { kind: 'error', error: 'Overloaded', code: 'overloaded_error' }
      })(),
    )
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...(dbWithServerDispatch({
        customscript: [
          {
            in: 'partial',
            out: 'processed failed partial',
            type: 'editoutput',
            flag: '',
            ableFlag: false,
          },
        ],
      }) as Record<string, unknown>),
      requestRetrys: 2,
      useStreaming: true,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    expect(dispatchProvider).toHaveBeenCalledTimes(1)

    const events = parseEvents(res.body)
    expect(events.filter((event) => event.type === 'token')).toEqual([{ type: 'token', data: { content: 'partial' } }])
    expect(events.find((event) => event.type === 'error')?.data).toMatchObject({
      error: 'Overloaded',
      reason: 'provider_stream_error_frame',
      code: 'overloaded_error',
      result: 'partial',
      postGeneration: {
        revision: expect.any(Number),
        messageId: expect.any(String),
        finalText: 'processed failed partial',
      },
      restoration: {
        chatId: 'chat-1',
        characterId: 'char-1',
        messages: [],
      },
    })
    expect(events.at(-1)?.type).toBe('done')
    expect((await readPersistedMessages(assertion)).filter((message) => message.role === 'char')).toEqual([
      expect.objectContaining({ data: 'processed failed partial' }),
    ])
  })
})

describe('POST /api/v1/generate/preview-prompt', () => {
  const previewPayload = { chatId: 'chat-1', characterId: 'char-1' }

  it('returns 401 without auth once a password is set', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/preview-prompt',
      payload: previewPayload,
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a body missing chatId with 400', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/preview-prompt',
      headers: { 'risu-auth': assertion },
      payload: { characterId: 'char-1' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'chatId is required' })
  })

  it('rejects a body missing characterId with 400', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/preview-prompt',
      headers: { 'risu-auth': assertion },
      payload: { chatId: 'chat-1' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'characterId is required' })
  })

  it('uses the configured tiktoken encoding for authoritative prompt counts', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const promptText = '你好世界 🚀🌕✨ '.repeat(40)

    async function previewTokens(customTokenizer: 'cl100k_base' | 'o200k_base'): Promise<number> {
      const database = structuredClone(fixtureDatabase)
      ;(database as typeof database & { customTokenizer: string }).customTokenizer = customTokenizer
      database.mainPrompt = promptText
      await seedDatabase(harness.app, assertion, database)
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/preview-prompt',
        headers: { 'risu-auth': assertion },
        payload: previewPayload,
      })
      expect(response.statusCode).toBe(200)
      const tokens = response.json().promptInfo?.inputTokens
      expect(typeof tokens).toBe('number')
      return tokens as number
    }

    const cl100kTokens = await previewTokens('cl100k_base')
    const o200kTokens = await previewTokens('o200k_base')
    expect(cl100kTokens).toBeGreaterThan(o200kTokens)
  })

  it('warms and accepts an imported portable tokenizer', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, { ...fixtureDatabase, customTokenizer: 'claude' })

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/preview-prompt',
      headers: { 'risu-auth': assertion },
      payload: previewPayload,
    })

    expect(response.statusCode).toBe(200)
    expect(typeof response.json().promptInfo?.inputTokens).toBe('number')
  })

  it('returns the assembled prompt as JSON for a seeded database', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/preview-prompt',
      headers: { 'risu-auth': assertion },
      payload: previewPayload,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    const body = res.json()
    expect(Array.isArray(body.messages)).toBe(true)
    expect(body.messages.length).toBeGreaterThan(0)
    expect(body.promptInfo).toBeDefined()
    // Full rows ride on the JSON payload too.
    expect(Array.isArray(body.formated)).toBe(true)
    expect(body.formated.length).toBe(body.messages.length)
    expect((body as Record<string, unknown>).biases).toEqual([])
  })

  it('keeps BardWiki preview, prompt event, metrics, and provider dispatch in parity', async () => {
    const providerRows: unknown[][] = []
    await restartHarness({
      dispatchProvider: (context) => {
        providerRows.push(structuredClone(context.result.formated ?? []))
        return (async function* (): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: 'provider reply' }
          yield { kind: 'done', finishReason: 'stop' }
        })()
      },
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      bardWiki: {
        ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
        enabledByDefault: true,
        memoryMode: 'bardwiki',
      },
    })
    seedBardWikiDocument()

    await withProtocolMetrics(async (metrics) => {
      const preview = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/preview-prompt',
        headers: { 'risu-auth': assertion },
        payload: { ...previewPayload, userMessage: 'Where is Alice?' },
      })
      expect(preview.statusCode).toBe(200)

      const generation = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: { ...basePayload, userMessage: 'Where is Alice?' },
      })
      expect(generation.statusCode).toBe(200)
      const prompt = parseEvents(generation.body).find((event) => event.type === 'prompt')

      const bardRows = (rows: unknown[]): unknown[] =>
        rows.filter((row) => isJsonRecord(row) && row.memo === 'bardWiki')
      const previewRows = bardRows(preview.json().formated)
      const eventRows = bardRows((prompt?.data.formated ?? []) as unknown[])
      const dispatchedRows = bardRows(providerRows[0] ?? [])
      expect(previewRows).toEqual(eventRows)
      expect(eventRows).toEqual(dispatchedRows)
      expect(eventRows).toEqual([
        expect.objectContaining({
          content: expect.stringContaining('BARDWIKI_PRIVATE_BODY'),
          memo: 'bardWiki',
        }),
      ])

      const assembly = metrics.find((entry) => entry.metric === 'generation_prompt_assembly' && entry.mode === 'send')
      expect(assembly).toMatchObject({
        bardWikiReason: 'selected',
        bardWikiCandidateCount: 1,
        bardWikiSelectedCount: 1,
        bardWikiRetainedCount: 1,
        bardWikiTrimmedCount: 0,
        bardWikiSelectedDocumentIds: ['bardwiki-alice'],
        bardWikiSelectedContentHashes: [expect.stringMatching(/^[a-f0-9]{64}$/)],
        bardWikiConsumedTokens: expect.any(Number),
        bardWikiFinalPromptRowCount: 1,
      })
      expect(JSON.stringify(metrics)).not.toContain('BARDWIKI_PRIVATE_BODY')
      expect(assembly?.bardWikiQueryHash).toMatch(/^[a-f0-9]{64}$/u)
    })
  })

  it('returns the stable pinned-budget error for preview and terminal generation', async () => {
    const dispatchProvider = vi.fn()
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      bardWiki: {
        ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
        enabledByDefault: true,
        memoryMode: 'bardwiki',
        totalTokenBudget: 16,
      },
    })
    seedBardWikiDocument({
      contextPolicy: 'pinned',
      markdown: `Pinned reference ${'that cannot be truncated '.repeat(20)}`,
    })

    const preview = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/preview-prompt',
      headers: { 'risu-auth': assertion },
      payload: previewPayload,
    })
    expect(preview.statusCode).toBe(409)
    expect(preview.json()).toMatchObject({
      stopSending: true,
      abortReason: 'bardwiki_pinned_budget_exceeded',
      message: expect.stringContaining('Pinned BardWiki references'),
    })

    const generation = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    const error = parseEvents(generation.body).find((event) => event.type === 'error')
    expect(error?.data).toMatchObject({
      reason: 'bardwiki_pinned_budget_exceeded',
      error: 'Pinned BardWiki references exceed the effective BardWiki prompt budget.',
    })
    expect(dispatchProvider).not.toHaveBeenCalled()
  })

  it('performs no Hypa query-embedding prefetch in BardWiki-only mode', async () => {
    const embedPromptMemoryQueryTexts = vi.fn(async () => ({
      model: 'unused',
      vectors: [new Float32Array([1, 0])],
      dim: 2,
    }))
    await restartHarness({ embedPromptMemoryQueryTexts })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...(similarityMemoryDatabase() as Record<string, unknown>),
      maxContext: 100_000,
      bardWiki: {
        ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
        enabledByDefault: true,
        memoryMode: 'bardwiki',
      },
    })
    seedSimilarMemoryRows()
    seedBardWikiDocument()

    const preview = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/preview-prompt',
      headers: { 'risu-auth': assertion },
      payload: { ...previewPayload, userMessage: 'Alice' },
    })

    expect(preview.statusCode).toBe(200)
    expect(embedPromptMemoryQueryTexts).not.toHaveBeenCalled()
    expect(preview.json().formated).toContainEqual(expect.objectContaining({ memo: 'bardWiki' }))
    expect(preview.json().formated).not.toContainEqual(expect.objectContaining({ memo: 'hypaMemory' }))
  })

  it('keeps @@inject transcript rewrites read-only while returning stripped preview rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const database = structuredClone(fixtureDatabase) as typeof fixtureDatabase & {
      characters: Array<
        (typeof fixtureDatabase.characters)[number] & {
          customscript?: unknown
          chats: Array<(typeof fixtureDatabase.characters)[number]['chats'][number]>
        }
      >
    }
    database.characters[0].customscript = [
      { in: 'SECRET', out: '@@inject', type: 'editprocess', flag: '', ableFlag: false },
    ]
    database.characters[0].chats[0].message = [
      { role: 'user', data: 'preview {{char}} SECRET', chatId: 'preview-inject-row' },
    ] as never
    database.formatingOrder = ['main', 'description', 'chats', 'lastChat']
    await seedDatabase(harness.app, assertion, database)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/preview-prompt',
      headers: { 'risu-auth': assertion },
      payload: previewPayload,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().messages).toContainEqual({ role: 'user', content: 'preview Tess' })
    expect(await readPersistedMessages(assertion)).toContainEqual(
      expect.objectContaining({
        chatId: 'preview-inject-row',
        data: 'preview {{char}} SECRET',
      }),
    )
  })

  it('returns only promptInfo.promptText from preview JSON for compact-capable clients', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/preview-prompt',
      headers: { 'risu-auth': assertion },
      payload: {
        ...previewPayload,
        clientCapabilities: { compactPromptEvent: true },
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Object.keys(body)).toEqual(['promptInfo'])
    expect(Object.keys(body.promptInfo)).toEqual(['promptText'])
    expect(typeof body.promptInfo.promptText).toBe('string')
    expect(JSON.parse(body.promptInfo.promptText)).toEqual(expect.any(Array))
    expect(JSON.parse(body.promptInfo.promptText).length).toBeGreaterThan(0)
    expect(Object.prototype.hasOwnProperty.call(body, 'messages')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(body, 'formated')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(body, 'lorebookActivation')).toBe(false)
  })

  it('returns a structured generation settings 409 body before opening SSE for durable chat', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [
            {
              ...fixtureDatabase.characters[0].chats[0],
              generationSettings: undefined,
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, durable: true },
    })
    expect(res.statusCode).toBe(409)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body).not.toContain('job_accepted')
    const body = res.json()
    expect(body).toMatchObject({
      statusCode: 409,
      error: 'chat_generation_settings_incomplete',
      message: 'Chat generation settings are incomplete',
      chatId: 'chat-1',
    })
    expect(body.missing.map((reason: { code: string }) => reason.code)).toContain('settings_missing')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().activeGenerationJobs).toEqual([])
  })

  it.each([
    {
      label: 'missing active durable profile',
      database: {
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'missing-profile' } },
      },
      reason: 'profile-not-found',
    },
    {
      label: 'model-less active durable profile',
      database: {
        modelProfiles: [{ id: 'empty-profile', name: 'Empty Profile' }],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'empty-profile' } },
      },
      reason: 'profile-model-missing',
    },
    {
      label: 'unsupported active durable profile',
      database: {
        modelProfiles: [
          {
            id: 'unsupported-profile',
            name: 'Unsupported Profile',
            providerId: 'not-a-provider',
            modelId: 'gpt-5',
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'unsupported-profile' } },
      },
      reason: 'unsupported-provider-id',
    },
    {
      label: 'incomplete first-class active durable profile',
      database: {
        modelProfiles: [
          {
            id: 'incomplete-profile',
            name: 'Incomplete Profile',
            providerId: 'openai',
            modelId: 'gpt-5',
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'incomplete-profile' } },
      },
      reason: 'api-key-missing',
    },
  ])('returns JSON before SSE/provider dispatch for $label', async (testCase) => {
    const dispatchProvider = vi.fn()
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      ...testCase.database,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })

    expect(res.statusCode).toBe(400)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body).not.toContain('event:')
    expect(res.json().error).toContain(testCase.reason)
    expect(res.json().error).toContain('Model profile')
    expect(dispatchProvider).not.toHaveBeenCalled()
  })

  it('rejects a bad active durable profile before durable job acceptance', async () => {
    const dispatchProvider = vi.fn()
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'missing-profile' } },
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, durable: true },
    })

    expect(res.statusCode).toBe(400)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body).not.toContain('job_accepted')
    expect(res.json().error).toContain('profile-not-found')
    expect(dispatchProvider).not.toHaveBeenCalled()

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().activeGenerationJobs).toEqual([])
  })

  it('allows durable compatibility profiles through chat generation', async () => {
    const dispatchProvider = vi.fn(() =>
      (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'compat ok' }
        yield { kind: 'done', finishReason: 'stop' }
      })(),
    )
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      modelProfiles: [{ id: 'compat-profile', name: 'Compat Profile', modelId: 'echo_model' }],
      modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'compat-profile' } },
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(dispatchProvider).toHaveBeenCalledTimes(1)
    expect(parseEvents(res.body).at(-1)?.data).toMatchObject({ result: 'compat ok' })
  })

  it("dispatches with the active chat's preset overlay instead of request or global preset", async () => {
    let providerBody: Record<string, unknown> | undefined
    let authorization: string | undefined
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      const headers = init?.headers as Record<string, string> | undefined
      authorization = headers?.authorization
      return new Response(
        JSON.stringify({
          model: 'gpt-5.4',
          choices: [{ message: { content: 'chat preset reply' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'echo_model',
      echoMessage: 'global echo reply',
      openAIKey: 'sk-global',
      temperature: 11,
      maxContext: 1111,
      maxResponse: 11,
      modelPresets: [
        {
          id: 'model-global',
          name: 'Global Model',
          aiModel: 'echo_model',
          echoMessage: 'global echo reply',
          openAIKey: 'sk-global',
          temperature: 11,
          maxContext: 1111,
          maxResponse: 11,
        },
        {
          id: 'model-chat',
          name: 'Chat Model',
          aiModel: 'gpt-5.4',
          openAIKey: 'sk-chat',
          temperature: 73,
          maxContext: 3737,
          maxResponse: 37,
        },
      ],
      promptPresets: [{ id: 'prompt-chat', name: 'Chat Prompt' }],
      modelPresetsId: 0,
      promptPresetsId: 0,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [
            {
              ...fixtureDatabase.characters[0].chats[0],
              generationSettings: {
                configured: true,
                personaId: DEFAULT_TEST_PERSONA_ID,
                modelPresetId: 'model-chat',
                promptPresetId: 'prompt-chat',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const events = parseEvents(res.body)
    const info = events.find((event) => event.type === 'info')
    expect(info?.data.generationInfo).toMatchObject({
      model: 'gpt-5.4',
      outputTokens: 37,
      maxContext: 3737,
    })
    expect(providerBody).toMatchObject({
      model: 'gpt-5.4',
      temperature: 0.73,
      max_completion_tokens: 37,
    })
    expect(authorization).toBe('Bearer sk-chat')
    expect(events.at(-1)?.data).toMatchObject({ result: 'chat preset reply' })
  })

  it('lets prompt presets override selected model preset parameters and Prompt Others fields', async () => {
    let providerBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(
        JSON.stringify({
          model: 'gpt-5.4',
          choices: [{ message: { content: 'prompt override reply' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      modelPresets: [
        {
          id: 'model-chat',
          name: 'Chat Model',
          aiModel: 'reverse_proxy',
          forceReplaceUrl: 'https://proxy.example/v1/chat/completions',
          proxyKey: 'sk-chat',
          customProxyRequestModel: 'model-from-model-preset',
          temperature: 11,
          maxContext: 1111,
          maxResponse: 11,
          additionalParams: [['top_p', '0.9']],
        },
      ],
      promptPresets: [
        {
          id: 'prompt-chat',
          name: 'Chat Prompt',
          overrideModelParameters: true,
          temperature: 44,
          maxContext: 4444,
          maxResponse: 44,
          additionalParams: [['top_p', '0.5']],
        },
      ],
      modelPresetsId: 0,
      promptPresetsId: 0,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [
            {
              ...fixtureDatabase.characters[0].chats[0],
              generationSettings: {
                configured: true,
                personaId: DEFAULT_TEST_PERSONA_ID,
                modelPresetId: 'model-chat',
                promptPresetId: 'prompt-chat',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const info = parseEvents(res.body).find((event) => event.type === 'info')
    expect(info?.data.generationInfo).toMatchObject({
      outputTokens: 44,
      maxContext: 4444,
    })
    expect(providerBody).toMatchObject({
      model: 'model-from-model-preset',
      temperature: 0.44,
      max_tokens: 44,
      top_p: 0.5,
    })
  })

  it('applies profile-bound runtime fields from the active chat model preset before assembly dispatch', async () => {
    let dispatchedDatabase: Record<string, unknown> | undefined
    const dispatchProvider = vi.fn(({ database }) => {
      dispatchedDatabase = structuredClone(database) as Record<string, unknown>
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'profile runtime reply' }
        yield { kind: 'done', finishReason: 'stop' }
      })()
    })
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'echo_model',
      maxContext: 1111,
      maxResponse: 11,
      temperature: 11,
      top_p: 0.9,
      useStreaming: true,
      modelPresets: [
        {
          id: 'model-profile-runtime',
          name: 'Profile Runtime Model',
          modelProfiles: [
            {
              id: 'profile-runtime',
              name: 'Profile Runtime',
              providerId: 'custom-api',
              modelId: 'custom-api',
              providerOptions: {
                baseUrl: 'https://profile-runtime.example.com/v1',
                requestModel: 'profile-runtime-wire-model',
                customApi: { tokenizer: LLMTokenizer.tiktokenO200Base },
              },
              runtimeOptions: {
                maxContext: 2222,
                maxResponse: 22,
                temperature: 66,
                topP: 0.42,
                useStreaming: false,
                extractJson: 'json',
                jsonSchemaEnabled: true,
                jsonSchema: '{"type":"object"}',
                strictJsonSchema: true,
                modelTools: ['search'],
                enableCustomFlags: true,
                customFlags: [LLMFlags.hasImageInput],
              },
            },
          ],
          modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'profile-runtime' } },
        },
      ],
      promptPresets: [{ id: 'prompt-chat', name: 'Chat Prompt' }],
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [
            {
              ...fixtureDatabase.characters[0].chats[0],
              generationSettings: {
                configured: true,
                personaId: DEFAULT_TEST_PERSONA_ID,
                modelPresetId: 'model-profile-runtime',
                promptPresetId: 'prompt-chat',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })

    expect(res.statusCode).toBe(200)
    expect(dispatchProvider).toHaveBeenCalledTimes(1)
    expect(dispatchedDatabase).toMatchObject({
      aiModel: 'custom-api',
      maxContext: 2222,
      maxResponse: 22,
      temperature: 66,
      top_p: 0.42,
      useStreaming: false,
      extractJson: 'json',
      jsonSchemaEnabled: true,
      jsonSchema: '{"type":"object"}',
      strictJsonSchema: true,
      modelTools: ['search'],
      enableCustomFlags: true,
      customFlags: [LLMFlags.hasImageInput],
      customTokenizer: String(LLMTokenizer.tiktokenO200Base),
    })
    const info = parseEvents(res.body).find((event) => event.type === 'info')
    expect(info?.data.generationInfo).toMatchObject({
      model: 'custom-api',
      outputTokens: 22,
      maxContext: 2222,
    })
  })

  it('lets prompt parameter overrides win over profile-bound runtime fields', async () => {
    let dispatchedDatabase: Record<string, unknown> | undefined
    const dispatchProvider = vi.fn(({ database }) => {
      dispatchedDatabase = structuredClone(database) as Record<string, unknown>
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'prompt profile override reply' }
        yield { kind: 'done', finishReason: 'stop' }
      })()
    })
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      maxContext: 1111,
      maxResponse: 11,
      temperature: 11,
      top_p: 0.9,
      modelPresets: [
        {
          id: 'model-profile-runtime',
          name: 'Profile Runtime Model',
          modelProfiles: [
            {
              id: 'profile-runtime',
              name: 'Profile Runtime',
              providerId: 'custom-api',
              modelId: 'custom-api',
              providerOptions: {
                baseUrl: 'https://profile-runtime.example.com/v1',
                requestModel: 'profile-runtime-wire-model',
              },
              runtimeOptions: {
                maxContext: 2222,
                maxResponse: 22,
                temperature: 66,
                topP: 0.42,
                useStreaming: false,
              },
            },
          ],
          modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'profile-runtime' } },
        },
      ],
      promptPresets: [
        {
          id: 'prompt-chat',
          name: 'Chat Prompt',
          overrideModelParameters: true,
          maxContext: 4444,
          maxResponse: 44,
          temperature: 33,
          top_p: 0.24,
        },
      ],
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [
            {
              ...fixtureDatabase.characters[0].chats[0],
              generationSettings: {
                configured: true,
                personaId: DEFAULT_TEST_PERSONA_ID,
                modelPresetId: 'model-profile-runtime',
                promptPresetId: 'prompt-chat',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })

    expect(res.statusCode).toBe(200)
    expect(dispatchProvider).toHaveBeenCalledTimes(1)
    expect(dispatchedDatabase).toMatchObject({
      aiModel: 'custom-api',
      maxContext: 4444,
      maxResponse: 44,
      temperature: 33,
      top_p: 0.24,
      useStreaming: false,
    })
    const info = parseEvents(res.body).find((event) => event.type === 'info')
    expect(info?.data.generationInfo).toMatchObject({
      model: 'custom-api',
      outputTokens: 44,
      maxContext: 4444,
    })
  })

  it('omits disabled temperature and sends expanded bias fields in default OpenAI dispatch', async () => {
    const captured: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      captured.push({
        url,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      })
      return new Response(
        JSON.stringify({
          model: 'gpt-5.4',
          choices: [{ message: { content: 'openai reply' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'gpt-5.4',
      openAIKey: 'sk-test',
      temperature: -1000,
      bias: [['forbidden', -100]],
      characters: [
        {
          ...fixtureDatabase.characters[0],
          bias: [['{{char}}', 50]],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)

    const providerBody = captured.find((call) => call.url.endsWith('/chat/completions'))?.body
    expect(providerBody).toBeDefined()
    expect(providerBody?.temperature).toBeUndefined()
    expect(providerBody?.logit_bias).toBeDefined()
    expect(providerBody?.biases).toBeUndefined()

    const prompt = parseEvents(res.body).find((e) => e.type === 'prompt')
    expect(prompt).toBeDefined()
    expect((prompt!.data as Record<string, unknown>).biases).toEqual([
      ['forbidden', -100],
      ['Tess', 50],
    ])
  })

  it('preserves active temperature in default OpenAI dispatch', async () => {
    let providerBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      providerBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'gpt-5.4',
      openAIKey: 'sk-test',
      temperature: 80,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    expect(providerBody?.temperature).toBe(0.8)
  })

  it('omits disabled Horde sampler fields and preserves active Horde sampler fields', async () => {
    const submitBodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/generate/text/async')) {
        submitBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return new Response(JSON.stringify({ id: `job-${submitBodies.length}` }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/generate/text/status/job-1')) {
        return new Response(JSON.stringify({ done: true, generations: [{ text: 'disabled response' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/generate/text/status/job-2')) {
        return new Response(JSON.stringify({ done: true, generations: [{ text: 'active response' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected Horde URL: ${url}`)
    })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'horde:::koboldcpp/Mistral-7B',
      instructChatTemplate: 'chatml',
      temperature: -1000,
      top_k: -1000,
      top_p: -1000,
    })

    const disabled = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(disabled.statusCode).toBe(200)
    const disabledParams = submitBodies[0]?.params as Record<string, unknown>
    expect(disabledParams.temperature).toBeUndefined()
    expect(disabledParams.top_k).toBeUndefined()
    expect(disabledParams.top_p).toBeUndefined()

    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'horde:::koboldcpp/Mistral-7B',
      instructChatTemplate: 'chatml',
      temperature: 80,
      top_k: 40,
      top_p: 0.9,
    })
    const active = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(active.statusCode).toBe(200)
    const activeParams = submitBodies[1]?.params as Record<string, unknown>
    expect(activeParams.temperature).toBe(0.8)
    expect(activeParams.top_k).toBe(40)
    expect(activeParams.top_p).toBe(0.9)
  })

  it('returns 404 (not an SSE error) when the character is unknown', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, fixtureDatabase)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/preview-prompt',
      headers: { 'risu-auth': assertion },
      payload: { chatId: 'chat-1', characterId: 'nope' },
    })
    expect(res.statusCode).toBe(404)
    expect(String(res.json().error)).toMatch(/character not found/)
  })

  it('returns the structured generation settings 409 body for preview-prompt', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [
            {
              ...fixtureDatabase.characters[0].chats[0],
              generationSettings: undefined,
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/preview-prompt',
      headers: { 'risu-auth': assertion },
      payload: previewPayload,
    })
    expect(res.statusCode).toBe(409)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.json()).toMatchObject({
      statusCode: 409,
      error: 'chat_generation_settings_incomplete',
      message: 'Chat generation settings are incomplete',
      chatId: 'chat-1',
      staleSidebarToggleKeys: [],
    })
    expect(res.json().missing.map((reason: { code: string }) => reason.code)).toContain('settings_missing')
  })

  it('atomically rehomes deleted persona, model, and prompt references to explicit replacements', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    let revision = await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      selectedPersona: 1,
      modelPresetsId: 1,
      promptPresetsId: 1,
      personas: [
        {
          id: 'persona-survivor',
          name: 'Survivor Persona',
          icon: '',
          personaPrompt: 'Survivor persona prompt',
          note: '',
        },
        {
          id: 'persona-deleted',
          name: 'Deleted Persona',
          icon: '',
          personaPrompt: 'Deleted persona prompt',
          note: '',
        },
      ],
      modelPresets: [
        {
          id: 'model-survivor',
          name: 'Survivor Model Preset',
          maxContext: 100_000,
          maxResponse: 50,
        },
        {
          id: 'model-deleted',
          name: 'Deleted Model Preset',
          maxContext: 100_000,
          maxResponse: 50,
        },
      ],
      promptPresets: [
        {
          id: 'prompt-survivor',
          name: 'Survivor Prompt Preset',
          mainPrompt: 'SURVIVOR MAIN',
          recommendedModelPresetId: 'model-deleted',
        },
        {
          id: 'prompt-deleted',
          name: 'Deleted Prompt Preset',
          mainPrompt: 'DELETED MAIN',
        },
      ],
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [
            configuredChat('chat-ok', {
              personaId: 'persona-survivor',
              modelPresetId: 'model-survivor',
              promptPresetId: 'prompt-survivor',
            }),
            configuredChat('chat-deleted-model', {
              personaId: 'persona-survivor',
              modelPresetId: 'model-deleted',
              promptPresetId: 'prompt-survivor',
            }),
            configuredChat('chat-deleted-prompt', {
              personaId: 'persona-survivor',
              modelPresetId: 'model-survivor',
              promptPresetId: 'prompt-deleted',
            }),
            configuredChat('chat-deleted-persona', {
              personaId: 'persona-deleted',
              modelPresetId: 'model-survivor',
              promptPresetId: 'prompt-survivor',
            }),
          ],
        },
      ],
      loadouts: [
        {
          id: 'loadout-deleted-references',
          name: 'Deleted references',
          lastUsed: 100,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          modelPresetId: 'model-deleted',
          modelPresetName: 'Deleted Model Preset',
          promptPresetId: 'prompt-deleted',
          promptPresetName: 'Deleted Prompt Preset',
          personaId: 'persona-deleted',
        },
        {
          id: 'loadout-survivor-references',
          name: 'Survivor references',
          lastUsed: 200,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          modelPresetId: 'model-survivor',
          modelPresetName: 'Survivor Model Preset',
          promptPresetId: 'prompt-survivor',
          promptPresetName: 'Survivor Prompt Preset',
          personaId: 'persona-survivor',
        },
      ],
    })

    const preview = (chatId: string) =>
      harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/preview-prompt',
        headers: { 'risu-auth': assertion },
        payload: { chatId, characterId: 'char-1' },
      })

    const deleteModel = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/model-presets/model-deleted',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, modelPresetId: 'model-survivor' },
    })
    expect(deleteModel.statusCode).toBe(200)
    expect(deleteModel.json()).toMatchObject({
      modelPresetId: 'model-deleted',
      selectedModelPresetId: 'model-survivor',
      cascadedChatCount: 1,
      cascadedLoadoutCount: 1,
      clearedPromptRecommendationCount: 1,
    })
    revision = deleteModel.json().revision as number
    expect((await preview('chat-deleted-model')).statusCode).toBe(200)

    const deletePrompt = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/prompt-presets/prompt-deleted',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, promptPresetId: 'prompt-survivor' },
    })
    expect(deletePrompt.statusCode).toBe(200)
    expect(deletePrompt.json()).toMatchObject({
      promptPresetId: 'prompt-deleted',
      selectedPromptPresetId: 'prompt-survivor',
      cascadedChatCount: 1,
      cascadedLoadoutCount: 1,
    })
    revision = deletePrompt.json().revision as number
    expect((await preview('chat-deleted-prompt')).statusCode).toBe(200)

    const deletePersona = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/personas/persona-deleted',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, selectPersonaId: 'persona-survivor' },
    })
    expect(deletePersona.statusCode).toBe(200)
    expect(deletePersona.json()).toMatchObject({
      personaId: 'persona-deleted',
      selectedPersonaId: 'persona-survivor',
      cascadedChatCount: 1,
      cascadedLoadoutCount: 1,
    })
    expect((await preview('chat-deleted-persona')).statusCode).toBe(200)
    expect((await preview('chat-ok')).statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    const chats = bootstrap.resourceDatabase.characters[0].chats as Array<{
      id: string
      generationSettings?: Record<string, unknown>
    }>
    for (const chatId of ['chat-ok', 'chat-deleted-model', 'chat-deleted-prompt', 'chat-deleted-persona']) {
      expect(chats.find((chat) => chat.id === chatId)?.generationSettings).toMatchObject({
        personaId: 'persona-survivor',
        modelPresetId: 'model-survivor',
        promptPresetId: 'prompt-survivor',
      })
    }

    expect(
      bootstrap.resourceDatabase.promptPresets.find((preset: { id: string }) => preset.id === 'prompt-survivor'),
    ).toMatchObject({ recommendedModelPresetId: null })

    const loadouts = bootstrap.resourceDatabase.loadouts as Array<Record<string, unknown>>
    expect(loadouts.find((loadout) => loadout.id === 'loadout-deleted-references')).toMatchObject({
      personaId: 'persona-survivor',
      modelPresetId: 'model-survivor',
      modelPresetName: 'Survivor Model Preset',
      promptPresetId: 'prompt-survivor',
      promptPresetName: 'Survivor Prompt Preset',
    })
    expect(loadouts.find((loadout) => loadout.id === 'loadout-survivor-references')).toMatchObject({
      personaId: 'persona-survivor',
      modelPresetId: 'model-survivor',
      modelPresetName: 'Survivor Model Preset',
      promptPresetId: 'prompt-survivor',
      promptPresetName: 'Survivor Prompt Preset',
    })
  })

  it('makes an otherwise configured chat incomplete when its selected preset displays a new required toggle', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }],
      personas: [
        {
          id: 'persona-a',
          name: 'Persona A',
          icon: '',
          personaPrompt: '',
          note: '',
        },
      ],
      characters: [
        {
          ...fixtureDatabase.characters[0],
          chats: [
            {
              ...fixtureDatabase.characters[0].chats[0],
              generationSettings: {
                configured: true,
                personaId: 'persona-a',
                modelPresetId: 'model-a',
                promptPresetId: 'prompt-a',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            },
          ],
        },
      ],
    })

    const before = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/preview-prompt',
      headers: { 'risu-auth': assertion },
      payload: previewPayload,
    })
    expect(before.statusCode).toBe(200)

    const patchedPreset = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-presets/prompt-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { customPromptTemplateToggle: 'mode=Mode' },
      },
    })
    expect(patchedPreset.statusCode).toBe(200)

    const after = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/preview-prompt',
      headers: { 'risu-auth': assertion },
      payload: previewPayload,
    })
    expect(after.statusCode).toBe(409)
    expect(after.json()).toMatchObject({
      statusCode: 409,
      error: 'chat_generation_settings_incomplete',
      chatId: 'chat-1',
      staleSidebarToggleKeys: [],
    })
    expect(after.json().missing).toContainEqual(
      expect.objectContaining({
        code: 'sidebar_toggle_missing',
        toggleKey: 'mode',
      }),
    )
  })

  it('resets request-trigger rows between same-model retries (accepted divergence)', async () => {
    const firstRows: string[] = []
    let call = 0
    const dispatchProvider = vi.fn((context: ChatProviderDispatchContext) => {
      call++
      firstRows.push(String(context.result.formated?.[0]?.content ?? ''))
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        if (call === 1) {
          yield { kind: 'error', error: 'retry me' }
          return
        }
        yield { kind: 'token', content: 'retry succeeded' }
        yield { kind: 'done', finishReason: 'stop' }
      })()
    })
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      requestRetrys: 1,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          triggerscript: [
            {
              type: 'request',
              comment: 'append once per attempt',
              conditions: [],
              effect: [
                { type: 'v2GetRequestState', indexType: 'value', index: '0', outputVar: 'requestRow', indent: 0 },
                {
                  type: 'v2ConcatString',
                  source1Type: 'var',
                  source1: 'requestRow',
                  source2Type: 'value',
                  source2: '[attempt]',
                  outputVar: 'requestRowWithAttempt',
                  indent: 0,
                },
                {
                  type: 'v2SetRequestState',
                  indexType: 'value',
                  index: '0',
                  valueType: 'var',
                  value: 'requestRowWithAttempt',
                  indent: 0,
                },
              ],
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })

    expect(res.statusCode).toBe(200)
    expect(dispatchProvider).toHaveBeenCalledTimes(2)
    // Accepted divergence: baseline request.ts:222 resets rows per fallback,
    // so its same-model retry accumulated this suffix. Fastify resets each attempt.
    expect(firstRows).toHaveLength(2)
    expect(firstRows[0]).toBe(firstRows[1])
    expect(firstRows[0]?.match(/\[attempt\]/gu)).toHaveLength(1)
  })

  it.each([
    { providerFailure: 'Kobold HTTP', buffered: false },
    { providerFailure: 'Horde impossible/empty', buffered: true },
  ])('stops retries and fallbacks for a non-retryable $providerFailure failure', async ({ buffered }) => {
    const seenProfiles: string[] = []
    const dispatchProvider = vi.fn((context: ChatProviderDispatchContext) => {
      seenProfiles.push(context.profile?.modelId ?? '')
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'error', error: 'terminal provider failure', nonRetryable: true }
      })()
    })
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'gpt-5',
      requestRetrys: 2,
      fallbackModels: { model: ['echo_model'] },
      characters: [
        {
          ...fixtureDatabase.characters[0],
          escapeOutput: buffered,
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })

    expect(res.statusCode).toBe(200)
    expect(dispatchProvider).toHaveBeenCalledTimes(1)
    expect(seenProfiles).toEqual(['gpt-5'])
    expect(parseEvents(res.body).find((event) => event.type === 'error')?.data.error).toBe('terminal provider failure')
    expect((await readPersistedMessages(assertion)).filter((message) => message.role === 'char')).toEqual([])
  })

  it('applies request triggers, retries, blank fallback, banned-script retry, and Escape Output', async () => {
    const seen: Array<{ modelId: string | undefined; firstContent: string | undefined }> = []
    let call = 0
    const dispatchProvider = vi.fn((context: ChatProviderDispatchContext) => {
      call++
      seen.push({
        modelId: context.profile?.modelId,
        firstContent: context.result.formated?.[0]?.content,
      })
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        if (call === 1) {
          yield { kind: 'error', error: 'transient provider failure', status: 503 }
          return
        }
        if (call === 2) {
          yield { kind: 'token', content: '' }
          yield { kind: 'done', finishReason: 'stop' }
          return
        }
        if (call === 3) {
          yield { kind: 'token', content: 'Ж banned' }
          yield { kind: 'done', finishReason: 'stop' }
          return
        }
        yield { kind: 'token', content: '{ok}' }
        yield { kind: 'done', finishReason: 'stop' }
      })()
    })
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'gpt-5',
      requestRetrys: 1,
      fallbackWhenBlankResponse: true,
      fallbackModels: { model: ['echo_model'] },
      banCharacterset: ['Cyrillic'],
      useStreaming: true,
      characters: [
        {
          ...fixtureDatabase.characters[0],
          escapeOutput: true,
          triggerscript: [
            {
              type: 'request',
              comment: 'rewrite request',
              conditions: [],
              effect: [
                {
                  type: 'v2SetRequestState',
                  indexType: 'value',
                  index: '0',
                  valueType: 'value',
                  value: 'request-trigger-rewrite',
                  indent: 0,
                },
              ],
            },
          ],
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: { ...basePayload, userMessage: '\uE9B8hello\uE9B9' },
    })

    expect(res.statusCode).toBe(200)
    expect(dispatchProvider).toHaveBeenCalledTimes(4)
    expect(seen.map((entry) => entry.modelId)).toEqual(['gpt-5', 'gpt-5', 'echo_model', 'echo_model'])
    expect(seen.every((entry) => entry.firstContent === 'request-trigger-rewrite')).toBe(true)
    const events = parseEvents(res.body)
    expect(events.filter((event) => event.type === 'token')).toEqual([
      { type: 'token', data: { content: '\uE9B8ok\uE9B9' } },
    ])
    expect(events.at(-1)?.data.result).toBe('\uE9B8ok\uE9B9')
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })

  it('never emits or persists a banned response when every retry and fallback is rejected', async () => {
    const dispatchProvider = vi.fn(() =>
      (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'Ж rejected' }
        yield { kind: 'done', finishReason: 'stop' }
      })(),
    )
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'gpt-5',
      requestRetrys: 1,
      fallbackModels: { model: ['echo_model'] },
      banCharacterset: ['Cyrillic'],
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })

    expect(res.statusCode).toBe(200)
    expect(dispatchProvider).toHaveBeenCalledTimes(4)
    const events = parseEvents(res.body)
    expect(events.filter((event) => event.type === 'token')).toEqual([])
    expect(events.find((event) => event.type === 'error')?.data).toMatchObject({
      reason: 'provider_output_banned',
    })
    expect(events.at(-1)?.type).toBe('done')
    expect((await readPersistedMessages(assertion)).filter((message) => message.role === 'char')).toEqual([])
  })

  it('retries an unbuffered provider iterator that throws before its first token', async () => {
    let call = 0
    const dispatchProvider = vi.fn(() =>
      (async function* (): AsyncGenerator<CompletionStreamFrame> {
        call++
        if (call === 1) throw new Error('connect stream failed')
        yield { kind: 'token', content: 'retry succeeded' }
        yield { kind: 'done', finishReason: 'stop' }
      })(),
    )
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      requestRetrys: 1,
      useStreaming: true,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })

    expect(res.statusCode).toBe(200)
    expect(dispatchProvider).toHaveBeenCalledTimes(2)
    const events = parseEvents(res.body)
    expect(events.filter((event) => event.type === 'token')).toEqual([
      { type: 'token', data: { content: 'retry succeeded' } },
    ])
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect((await readPersistedMessages(assertion)).at(-1)?.data).toBe('retry succeeded')
  })

  it('retries a provider error frame emitted before its first token', async () => {
    let call = 0
    const dispatchProvider = vi.fn(() =>
      (async function* (): AsyncGenerator<CompletionStreamFrame> {
        call++
        if (call === 1) {
          yield { kind: 'error', error: 'Overloaded', code: 'overloaded_error' }
          return
        }
        yield { kind: 'token', content: 'retry succeeded' }
        yield { kind: 'done', finishReason: 'stop' }
      })(),
    )
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      requestRetrys: 1,
      useStreaming: true,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })

    expect(res.statusCode).toBe(200)
    expect(dispatchProvider).toHaveBeenCalledTimes(2)
    const events = parseEvents(res.body)
    expect(events.filter((event) => event.type === 'token')).toEqual([
      { type: 'token', data: { content: 'retry succeeded' } },
    ])
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect((await readPersistedMessages(assertion)).at(-1)?.data).toBe('retry succeeded')
  })

  it.each([false, true])(
    'preserves retries after progress-only frames with output inspection=%s',
    async (inspectOutput) => {
      let call = 0
      const dispatchProvider = vi.fn(() =>
        (async function* (): AsyncGenerator<CompletionStreamFrame> {
          call += 1
          if (call === 1) {
            yield { kind: 'token', content: '', tokenCount: 6 }
            yield { kind: 'error', error: 'Overloaded' }
            return
          }
          yield { kind: 'token', content: 'retry succeeded', tokenCount: 3 }
          yield { kind: 'done', finishReason: 'stop' }
        })(),
      )
      await restartHarness({ dispatchProvider })
      const { assertion } = await setupAuthedClient(harness.app)
      await seedDatabase(harness.app, assertion, {
        ...fixtureDatabase,
        requestRetrys: 1,
        halfStreaming: true,
        banCharacterset: inspectOutput ? ['Hangul'] : [],
      })
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: basePayload,
      })
      expect(res.statusCode).toBe(200)
      expect(dispatchProvider).toHaveBeenCalledTimes(2)
      const events = parseEvents(res.body)
      const tokens = events.filter((event) => event.type === 'token')
      expect(tokens[0]?.data).toMatchObject({ content: '', generatedTokens: 6 })
      expect(tokens.at(-1)?.data).toMatchObject({ content: 'retry succeeded', generatedTokens: 9 })
      expect(events.some((event) => event.type === 'error')).toBe(false)
      expect((await readPersistedMessages(assertion)).at(-1)?.data).toBe('retry succeeded')
    },
  )

  it('falls back after a reasoning-only completion while retaining scalar progress', async () => {
    const seenModels: Array<string | undefined> = []
    const dispatchProvider = vi.fn((context: ChatProviderDispatchContext) =>
      (async function* (): AsyncGenerator<CompletionStreamFrame> {
        seenModels.push(context.profile?.modelId)
        if (seenModels.length === 1) {
          yield { kind: 'token', content: '', tokenCount: 6 }
        } else {
          yield { kind: 'token', content: 'fallback answer', tokenCount: 3 }
        }
        yield { kind: 'done', finishReason: 'stop' }
      })(),
    )
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      aiModel: 'gpt-5',
      halfStreaming: true,
      fallbackWhenBlankResponse: true,
      fallbackModels: { model: ['echo_model'] },
    })
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })
    expect(res.statusCode).toBe(200)
    expect(seenModels).toEqual(['gpt-5', 'echo_model'])
    const events = parseEvents(res.body)
    const tokens = events.filter((event) => event.type === 'token')
    expect(tokens[0]?.data).toMatchObject({ content: '', generatedTokens: 6 })
    expect(tokens.at(-1)?.data).toMatchObject({ content: 'fallback answer', generatedTokens: 9 })
    expect(events.at(-1)?.data).toMatchObject({ result: 'fallback answer' })
    expect((await readPersistedMessages(assertion)).at(-1)?.data).toBe('fallback answer')
  })

  it('clamps request retries to the UI maximum of 20', async () => {
    const dispatchProvider = vi.fn(() =>
      (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'error', error: 'retryable failure', status: 503 }
      })(),
    )
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      requestRetrys: 99,
      useStreaming: true,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })

    expect(res.statusCode).toBe(200)
    expect(dispatchProvider).toHaveBeenCalledTimes(21)
    expect(parseEvents(res.body).find((event) => event.type === 'error')?.data.error).toBe('retryable failure')
  })

  it('materializes fallback-profile runtime settings and records the successful fallback model', async () => {
    const attempts: Array<{ profileId?: string; database: Record<string, unknown>; outputTokens?: number }> = []
    let primaryDatabase: ChatProviderDispatchContext['database'] | undefined
    const dispatchProvider = vi.fn((context: ChatProviderDispatchContext) => {
      if (context.profile?.profileId === 'primary-profile') primaryDatabase = context.database
      else {
        expect(context.database.characters).toBe(primaryDatabase?.characters)
        expect(primaryDatabase?.temperature).toBe(10)
        expect(primaryDatabase?.modelRoleProfiles?.chatMain).toEqual({ mode: 'profile', profileId: 'primary-profile' })
      }
      attempts.push({
        profileId: context.profile?.profileId,
        database: structuredClone(context.database) as unknown as Record<string, unknown>,
        outputTokens: context.result.outputTokens,
      })
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        if (context.profile?.profileId === 'primary-profile') {
          yield { kind: 'error', error: 'primary unavailable', status: 503 }
          return
        }
        yield { kind: 'token', content: 'fallback reply' }
        yield { kind: 'done', finishReason: 'stop' }
      })()
    })
    await restartHarness({ dispatchProvider })
    const { assertion } = await setupAuthedClient(harness.app)
    await seedDatabase(harness.app, assertion, {
      ...fixtureDatabase,
      requestRetrys: 0,
      modelProfiles: [
        {
          id: 'primary-profile',
          name: 'Primary',
          providerId: 'custom-api',
          modelId: 'custom-api',
          providerOptions: { baseUrl: 'https://primary.example/v1', requestModel: 'primary-wire' },
          runtimeOptions: {
            temperature: 10,
            maxContext: 1111,
            maxResponse: 11,
            useStreaming: true,
            jsonSchemaEnabled: true,
            jsonSchema: '{"type":"object","title":"primary"}',
          },
          fallbacks: [{ mode: 'profile', profileId: 'fallback-profile' }],
        },
        {
          id: 'fallback-profile',
          name: 'Fallback',
          providerId: 'custom-api',
          modelId: 'custom-api',
          providerOptions: { baseUrl: 'https://fallback.example/v1', requestModel: 'fallback-wire' },
          runtimeOptions: {
            temperature: 90,
            maxContext: 9999,
            maxResponse: 99,
            useStreaming: false,
            jsonSchemaEnabled: true,
            jsonSchema: '{"type":"object","title":"fallback"}',
          },
        },
      ],
      modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'primary-profile' } },
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/chat',
      headers: { 'risu-auth': assertion },
      payload: basePayload,
    })

    expect(res.statusCode).toBe(200)
    expect(attempts.map((attempt) => attempt.profileId)).toEqual(['primary-profile', 'fallback-profile'])
    expect(attempts[0]).toMatchObject({
      database: {
        temperature: 10,
        maxContext: 1111,
        maxResponse: 11,
        useStreaming: true,
        jsonSchema: '{"type":"object","title":"primary"}',
      },
      outputTokens: 11,
    })
    expect(attempts[1]).toMatchObject({
      database: {
        temperature: 90,
        maxContext: 9999,
        maxResponse: 99,
        useStreaming: false,
        jsonSchema: '{"type":"object","title":"fallback"}',
      },
      outputTokens: 11,
    })
    const done = parseEvents(res.body).at(-1)?.data
    // Fixed divergence: the successful fallback may update model/context
    // labels, but it must not replace the assembler's clamped response budget.
    expect(done?.generationInfo).toMatchObject({ model: 'custom-api', maxContext: 9999, outputTokens: 11 })
    expect((await readPersistedMessages(assertion)).at(-1)?.generationInfo).toMatchObject({
      model: 'custom-api',
      maxContext: 9999,
      outputTokens: 11,
    })
  })

  it('returns 404 when no database is persisted', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/generate/preview-prompt',
      headers: { 'risu-auth': assertion },
      payload: previewPayload,
    })
    expect(res.statusCode).toBe(404)
    expect(String(res.json().error)).toMatch(/database not found/)
  })
})

function configuredChat(
  id: string,
  settings: { personaId: string; modelPresetId: string; promptPresetId: string },
): Record<string, unknown> {
  return {
    id,
    message: [],
    note: '',
    name: id,
    localLore: [],
    generationSettings: {
      configured: true,
      personaId: settings.personaId,
      modelPresetId: settings.modelPresetId,
      promptPresetId: settings.promptPresetId,
      jailbreakToggle: false,
      sidebarToggles: {},
    },
  }
}
