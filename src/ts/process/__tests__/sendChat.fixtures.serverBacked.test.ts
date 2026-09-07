import { readFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

// Server-backed sendChat sweep. Unlike sendChat.fixtures.test.ts, this file does
// Supported Fastify sends go through `/api/v1/generate/chat`, so the
// browser-local assembler never consumes the request mock. The mock is kept for
// the browser-owned IGP call that intentionally runs after terminal replay.

vi.mock('../../platform', async (importActual) => {
  const actual = await importActual<typeof import('../../platform')>()
  return {
    ...actual,
    isFastifyServer: true,
  }
})

vi.mock('../../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'fixture-auth-token',
}))

vi.mock('../tts', () => import('../__fixtures__/mocks/tts'))
vi.mock('../inlayScreen', () => import('../__fixtures__/mocks/inlayScreen'))
vi.mock('../stableDiff', () => import('../__fixtures__/mocks/stableDiff'))
vi.mock('../prereroll', () => import('../__fixtures__/mocks/prereroll'))
vi.mock('../files/inlays', () => import('../__fixtures__/mocks/inlays'))
vi.mock('../request/request', () => import('../__fixtures__/mocks/request'))

const terminalEffectMocks = vi.hoisted(() => ({
  notify: vi.fn(async () => {}),
  embedding: vi.fn(async () => {}),
  completionSound: vi.fn(),
}))

vi.mock('../postGeneration/notification', async (importActual) => {
  const actual = await importActual<typeof import('../postGeneration/notification')>()
  return { ...actual, fireDesktopNotification: terminalEffectMocks.notify }
})

vi.mock('../postGeneration/emotionFallbackEmbedding', () => ({
  runEmotionEmbeddingFallback: terminalEffectMocks.embedding,
}))

vi.mock('../messageCompletionSound', () => ({
  playMessageCompletionSoundIfEnabled: terminalEffectMocks.completionSound,
}))

vi.mock('../memory/hypav3', async (importActual) => {
  const actual = await importActual<typeof import('../memory/hypav3')>()
  const fake = await import('../__fixtures__/mocks/hypav3')
  return { ...actual, hypaMemoryV3: fake.hypaMemoryV3 }
})

vi.mock('../scriptings', () => import('../__fixtures__/mocks/scriptings'))

vi.mock('../triggers', async (importActual) => {
  const actual = await importActual<typeof import('../triggers')>()
  return { ...actual }
})

vi.mock('../transformers', async (importActual) => {
  const actual = await importActual<typeof import('../transformers')>()
  return {
    ...actual,
    runImageEmbedding: async () => [{ generated_text: 'fake caption' }],
  }
})

const uuidState = { counter: 0 }
vi.mock('uuid', () => ({
  v4: () => `uuid-${uuidState.counter++}`,
}))

type InjectMethod = 'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT' | 'OPTIONS'

function toInjectMethod(method: string | undefined): InjectMethod {
  const normalized = (method ?? 'GET').toUpperCase()
  switch (normalized) {
    case 'DELETE':
    case 'GET':
    case 'HEAD':
    case 'PATCH':
    case 'POST':
    case 'PUT':
    case 'OPTIONS':
      return normalized
    default:
      return 'GET'
  }
}

vi.mock('@mlc-ai/web-tokenizers', () => ({
  Tokenizer: {
    fromJSON: async () => ({
      encode: (text: string) => (text.length === 0 ? [] : text.split(/\s+/)),
    }),
    fromSentencePiece: async () => ({
      encode: (text: string) => (text.length === 0 ? [] : text.split(/\s+/)),
    }),
  },
}))

import { loadFixture, markFixtureActiveChatGenerationSettingsReady } from '../__fixtures__/loadFixture'
import { getServerCompletionCalls, resetServerCompletionCalls } from '../__fixtures__/mocks/serverCompletionFetch'
import {
  getServerChatCalls,
  resetServerChatState,
  serverChatFetch,
  setServerChatDispatchError,
  setServerChatDispatchResult,
  setServerChatInfo,
  setServerChatMessagePatch,
  setServerChatPrompt,
  setServerChatSideEffects,
} from '../__fixtures__/mocks/serverChatFetch'
import { isTokenizerUrl, serveTokenizerFetch } from '../__fixtures__/mocks/tokenizerFetch'
import { getSideEffectCalls, resetSideEffectCalls } from '../__fixtures__/sideEffects'
import { getProviderCalls, installProviderScript, resetProviderState } from '../__fixtures__/providerFake'
import { type FixtureSnapshot, captureSnapshot, recordStages } from '../__fixtures__/snapshot'
import { replaceResourceDatabase } from '../../server/resourceState.svelte'
import type { Chat } from '../../storage/database.svelte'

import { defaultMainPrompt } from '../../storage/defaultPrompts'
import { abortChat, chatProcessStage, doingChat, previewBody, previewFormated, sendChat } from '../index.svelte'
import { addChatOutputListener, chatOutputListeners } from '../../plugins/chatOutputListeners'
import { _setPluginRuntimePhaseForTesting } from '../../plugins/plugins.svelte'
import { buildApp } from '../../../../server/fastify/src/app'
import { setupAuthedClient } from '../../../../server/fastify/__tests__/helpers/auth'
import type {
  ChatProviderDispatchContext,
  GenerationChatRouteOptions,
} from '../../../../server/fastify/src/routes/generationChat'
import {
  clearCachedServerCommandRevision,
  drainServerCommandExecutionForTests,
  getServerCommandBaseRevision,
  setCachedServerCommandRevision,
} from '../../server/commands'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

const testDatabaseState = {
  get db() {
    return getResourceDatabase()
  },
  set db(value: ReturnType<typeof getResourceDatabase>) {
    replaceResourceDatabase(value)
  },
}

const HERE = dirname(fileURLToPath(import.meta.url))

const ROUTE_BACKED_CHAT_FIXTURES = ['simple-send', 'continue', 'regenerate', 'preview', 'preview-prompt'] as const

async function loadExpected(name: string): Promise<FixtureSnapshot> {
  const path = resolve(HERE, '..', '__fixtures__', 'expected', `${name}.json`)
  return JSON.parse(await readFile(path, 'utf8')) as FixtureSnapshot
}

interface RouteBackedChatCall {
  url: string
  method: string
  authHeader: string | null
  body: Record<string, unknown>
}

// C-A1: records the browser's `/api/v1/commands/*` POSTs so a test can assert
// the assembly-time scriptstate write is no longer replayed as a command.
interface RouteBackedCommandCall {
  url: string
  method: string
  body: Record<string, unknown>
}

interface RouteBackedDispatchCall {
  inputMode: string
  formated: unknown
  generationInfo: Record<string, unknown>
}

interface RouteBackedHarness {
  app: FastifyInstance
  dataDir: string
  authAssertion: string
  chatCalls: RouteBackedChatCall[]
  commandCalls: RouteBackedCommandCall[]
  dispatchCalls: RouteBackedDispatchCall[]
  setDispatchText(text: string): void
  seed(database: unknown): Promise<void>
  close(): Promise<void>
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

// The bootstrap ships chat stubs (message-free); read persisted messages via the
// per-chat hydration endpoint.
async function persistedChatMessages(
  harness: RouteBackedHarness,
  chatId = 'chat-route-backed',
): Promise<Array<Record<string, unknown>>> {
  const res = await harness.app.inject({
    method: 'GET',
    url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    headers: { 'risu-auth': harness.authAssertion },
  })
  expect(res.statusCode).toBe(200)
  return res.json().message as Array<Record<string, unknown>>
}

async function persistedCharacterResources(harness: RouteBackedHarness): Promise<{
  revision: number
  characters: Array<{ chats: Array<Record<string, unknown>> }>
}> {
  const res = await harness.app.inject({
    method: 'GET',
    url: '/api/v1/characters/aggregate',
    headers: { 'risu-auth': harness.authAssertion },
  })
  expect(res.statusCode).toBe(200)
  return res.json()
}

function headersRecord(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return headers as Record<string, string>
}

async function createRouteBackedHarness(): Promise<RouteBackedHarness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(resolve(tmpdir(), 'risu-fastify-route-fixtures-'))
  let dispatchText = 'route-backed reply'
  const chatCalls: RouteBackedChatCall[] = []
  const commandCalls: RouteBackedCommandCall[] = []
  const dispatchCalls: RouteBackedDispatchCall[] = []
  let currentRevision = 0
  const generationChat: GenerationChatRouteOptions = {
    dispatchProvider(context: ChatProviderDispatchContext) {
      dispatchCalls.push({
        inputMode: context.input.mode,
        formated: context.result.formated ?? context.result.prompt.formated ?? [],
        generationInfo: context.generationInfo,
      })
      async function* frames() {
        yield { kind: 'token' as const, content: dispatchText }
        yield { kind: 'done' as const, finishReason: 'stop' as const }
      }
      return frames()
    },
  }
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Number.POSITIVE_INFINITY,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    generationChat,
    memoryWorker: false,
  })
  const { assertion: authAssertion } = await setupAuthedClient(app)

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (isTokenizerUrl(rawUrl)) return serveTokenizerFetch(rawUrl)
    const url = rawUrl.startsWith('http') ? new URL(rawUrl).pathname : rawUrl
    const method = toInjectMethod(init?.method)
    const headers = headersRecord(init?.headers)
    const injectHeaders = { ...headers }
    if (injectHeaders['risu-auth'] === 'fixture-auth-token') {
      injectHeaders['risu-auth'] = authAssertion
    }
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    if (url === '/api/v1/generate/chat') {
      chatCalls.push({
        url,
        method,
        authHeader: headers['risu-auth'] ?? null,
        body: (payload ?? {}) as Record<string, unknown>,
      })
    }
    if (url.startsWith('/api/v1/commands/')) {
      commandCalls.push({ url, method, body: (payload ?? {}) as Record<string, unknown> })
      const messageMatch = url.match(/^\/api\/v1\/commands\/messages\/([^/]+)$/)
      if (messageMatch && method === 'PATCH') {
        const messageId = decodeURIComponent(messageMatch[1])
        const baseRevision =
          payload && typeof payload === 'object' && typeof payload.baseRevision === 'number'
            ? payload.baseRevision
            : currentRevision
        const revision = baseRevision + 1
        return new Response(
          JSON.stringify({
            revision,
            event: {
              type: 'message.updated',
              revision,
              resource: 'message',
              id: messageId,
              parentId: 'chat-route-backed',
            },
            chatId: 'chat-route-backed',
            messageId,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({
          revision: 2,
          event: { type: 'fixture.command', revision: 2, resource: 'fixture' },
          chatId: 'chat-route-backed',
          messageId: 'route-backed-message',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const res = await app.inject({
      method,
      url,
      headers: injectHeaders,
      payload,
    })
    const responseHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(res.headers)) {
      if (typeof value === 'string') responseHeaders[key] = value
      else if (Array.isArray(value)) responseHeaders[key] = value.join(', ')
    }
    return new Response(res.body, {
      status: res.statusCode,
      headers: responseHeaders,
    })
  }

  return {
    app,
    dataDir,
    authAssertion,
    chatCalls,
    commandCalls,
    dispatchCalls,
    setDispatchText(text: string) {
      dispatchText = text
    },
    async seed(database: unknown) {
      const cloned = JSON.parse(JSON.stringify(database))
      const generationSettings = readSeedGenerationSettings(cloned)
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/import/risusave',
        headers: { 'risu-auth': authAssertion },
        payload: { database: cloned },
      })
      expect(res.statusCode).toBe(200)
      currentRevision = res.json().revision

      if (generationSettings) {
        const configure = await app.inject({
          method: 'PUT',
          url: '/api/v1/commands/chats/chat-route-backed/generation-settings',
          headers: { 'risu-auth': authAssertion },
          payload: {
            baseRevision: currentRevision,
            generationSettings,
          },
        })
        expect(configure.statusCode).toBe(200)
        currentRevision = configure.json().revision
      }
    },
    async close() {
      await app.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
    fetch,
  }
}

function readSeedGenerationSettings(database: unknown): unknown {
  if (!database || typeof database !== 'object' || Array.isArray(database)) return undefined
  const characters = (database as { characters?: unknown }).characters
  if (!Array.isArray(characters)) return undefined
  for (const character of characters) {
    if (!character || typeof character !== 'object' || Array.isArray(character)) continue
    const chats = (character as { chats?: unknown }).chats
    if (!Array.isArray(chats)) continue
    const chat = chats.find(
      (candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate) &&
        (candidate as { id?: unknown }).id === 'chat-route-backed',
    )
    if (chat && typeof chat === 'object' && !Array.isArray(chat)) {
      return (chat as { generationSettings?: unknown }).generationSettings
    }
  }
  return undefined
}

function prepareRouteBackedFixture(name: (typeof ROUTE_BACKED_CHAT_FIXTURES)[number]): void {
  const char = testDatabaseState.db.characters[0]
  const chat = char.chats[char.chatPage ?? 0]
  chat.id = 'chat-route-backed'
  ;(testDatabaseState.db as typeof testDatabaseState.db & { currentChar: number }).currentChar = 0
  testDatabaseState.db.mainPrompt = defaultMainPrompt
  if (name === 'continue') testDatabaseState.db.useSayNothing = false
  testDatabaseState.db.formatingOrder = [
    'main',
    'description',
    'personaPrompt',
    'chats',
    'lastChat',
    'jailbreak',
    'lorebook',
    'globalNote',
    'authorNote',
  ]
  testDatabaseState.db.promptSettings = {
    assistantPrefill: '',
    postEndInnerFormat: '',
    sendChatAsSystem: false,
    sendName: false,
    utilOverride: false,
    ...(testDatabaseState.db.promptSettings ?? {}),
  }
  if (name === 'regenerate') {
    chat.message.push({
      role: 'char',
      data: 'old reply to replace',
      chatId: 'msg-char-1',
      saying: char.chaId,
    })
  }
  markFixtureActiveChatGenerationSettingsReady({ canonicalOpenAiProfile: true })
}

async function drainRouteBackedCommands(): Promise<void> {
  await drainServerCommandExecutionForTests()
}

function messageTexts(snapshot: FixtureSnapshot): Array<{ role: string; data: string; saying?: string }> {
  return snapshot.messages.map((message) => ({
    role: message.role,
    data: message.data,
    ...(message.saying ? { saying: message.saying } : {}),
  }))
}

function semanticPromptRows(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row
    const normalized = { ...(row as Record<string, unknown>) }
    if (Array.isArray(normalized.attr) && normalized.attr.length === 0) delete normalized.attr
    if (Array.isArray(normalized.thoughts) && normalized.thoughts.length === 0) delete normalized.thoughts
    return normalized
  })
}

function firstRerollText(snapshot: FixtureSnapshot): string | null {
  for (const sideEffect of snapshot.sideEffects) {
    if (sideEffect.fn !== 'addRerolls') continue
    const args = sideEffect.args as unknown[]
    const rerolls = args[1]
    if (Array.isArray(rerolls) && typeof rerolls[0] === 'string') return rerolls[0]
  }
  return null
}

describe('sendChat fixtures (/chat route-backed prompt assembly)', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterAll(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    _setPluginRuntimePhaseForTesting('ready')
    resetProviderState()
    resetSideEffectCalls()
    resetServerCompletionCalls()
    doingChat.set(false)
    abortChat.set(false)
    chatProcessStage.set(0)
    uuidState.counter = 0
  })

  let cleanups: (() => void)[] = []
  afterEach(() => {
    _setPluginRuntimePhaseForTesting('idle')
    while (cleanups.length > 0) cleanups.pop()!()
    vi.unstubAllGlobals()
  })

  it.each(ROUTE_BACKED_CHAT_FIXTURES)('%s', async (name) => {
    const harness = await createRouteBackedHarness()
    try {
      const loaded = await loadFixture(name)
      cleanups.push(loaded.cleanup)
      prepareRouteBackedFixture(name)
      await harness.seed(testDatabaseState.db)
      vi.stubGlobal('fetch', harness.fetch)

      const expected = await loadExpected(name)
      const expectedProviderCall = expected.providerCalls[0]
      const assistant = [...expected.messages].reverse().find((m) => m.role === 'char')
      harness.setDispatchText(
        name === 'continue'
          ? (firstRerollText(expected) ?? ' route-backed continuation')
          : (assistant?.data ?? 'route-backed reply'),
      )

      const args: Parameters<typeof sendChat>[1] = { ...(loaded.fixture.sendChatArgs ?? {}) }
      if (name === 'regenerate') {
        args.regenerateMessageId = 'msg-char-1'
      }

      const stageRecorder = recordStages()
      clearCachedServerCommandRevision()
      const ok = await sendChat(-1, args)
      const stages = stageRecorder.stop()
      const captured = captureSnapshot(stages)

      expect(ok).toBe(true)
      expect(messageTexts(captured)).toEqual(messageTexts(expected))
      expect(captured.stages).toEqual(name === 'preview' || name === 'preview-prompt' ? [1] : expected.stages)
      expect(captured.doingChat).toBe(false)
      expect(harness.chatCalls).toHaveLength(1)
      expect(harness.chatCalls[0]).toMatchObject({
        url: '/api/v1/generate/chat',
        method: 'POST',
        authHeader: 'fixture-auth-token',
      })

      if (name === 'preview') {
        expect(harness.chatCalls[0].body).toMatchObject({ mode: 'preview' })
        expect(Array.isArray(previewFormated)).toBe(true)
        expect(harness.dispatchCalls).toEqual([])
      } else if (name === 'preview-prompt') {
        expect(harness.chatCalls[0].body).toMatchObject({ mode: 'preview_prompt' })
        expect(typeof previewBody).toBe('string')
        expect(harness.dispatchCalls).toEqual([])
      } else {
        const expectedMode = name === 'continue' ? 'continue' : name === 'regenerate' ? 'regenerate' : 'send'
        expect(harness.chatCalls[0].body).toMatchObject({ mode: expectedMode })
        expect(harness.dispatchCalls).toHaveLength(1)
        expect(harness.dispatchCalls[0].inputMode).toBe(expectedMode)
        if (expectedProviderCall) {
          expect(semanticPromptRows(harness.dispatchCalls[0].formated)).toEqual(
            semanticPromptRows(expectedProviderCall.formated),
          )
        }
        expect(harness.dispatchCalls[0].generationInfo.model).toBe('gpt-4o')
        expect(getServerCompletionCalls()).toEqual([])
      }
    } finally {
      await drainRouteBackedCommands()
      await harness.close()
    }
  })

  it('persists an assembly-time chat-var write server-side with zero scriptstate re-POSTs', async () => {
    const harness = await createRouteBackedHarness()
    try {
      const loaded = await loadFixture('simple-send')
      cleanups.push(loaded.cleanup)
      prepareRouteBackedFixture('simple-send')
      // A start trigger sets `$score` during assembly. Before C-A1 the browser
      // replayed this delta as a `PATCH …/scriptstate` command; now the route
      // persists it directly, so no scriptstate command should go out.
      testDatabaseState.db.characters[0].triggerscript = [
        {
          comment: '',
          type: 'start',
          conditions: [],
          effect: [{ type: 'setvar', operator: '=', var: 'score', value: '9' }],
        },
      ]
      await harness.seed(testDatabaseState.db)
      vi.stubGlobal('fetch', harness.fetch)
      harness.setDispatchText('route-backed reply')

      // Simulate a browser that already cached the pre-persist revision (1).
      // The only way its cache reaches the bumped revision is the SSE reconcile,
      // so a later command POSTing baseRevision 2 proves the reconcile happened.
      clearCachedServerCommandRevision()
      setCachedServerCommandRevision(1)
      const ok = await sendChat(-1, { ...(loaded.fixture.sendChatArgs ?? {}) })
      await drainRouteBackedCommands()

      expect(ok).toBe(true)

      // C-A1 core: the browser issues zero outbound scriptstate commands.
      const scriptstatePosts = harness.commandCalls.filter((call) => call.url.includes('/scriptstate'))
      expect(scriptstatePosts).toEqual([])

      // The route persisted the assembly-time delta itself: the character resource shows the
      // written scriptstate. simple-send is durable, so the job also persists the
      // result message at completion — configure = rev 2, assembly write = rev 3,
      // result write = rev 4.
      const characterResources = await persistedCharacterResources(harness)
      const persistedChat = characterResources.characters[0].chats[0]
      expect(persistedChat.scriptstate).toEqual({ $score: '9' })
      expect(characterResources.revision).toBe(4)
      const persistedAssistant = [...(await persistedChatMessages(harness))]
        .reverse()
        .find((m: { role: string }) => m.role === 'char')
      expect(persistedAssistant?.data).toBe('route-backed reply')

      // EC-D4 (durable): the server owns the result persist, so the browser issues
      // zero generation-result POSTs and reconciles the terminal-frame revision (3).
      const generationResultPosts = harness.commandCalls.filter((call) => call.url.includes('/generation-result'))
      expect(generationResultPosts).toEqual([])
      expect(await getServerCommandBaseRevision()).toBe(4)
    } finally {
      await drainRouteBackedCommands()
      await harness.close()
    }
  })

  // The server owns post-generation derivation: the `'output'` trigger, run-var
  // pass, and `editoutput` over the just-generated text.
  // These route-backed tests prove the browser consumes the server's derivation
  // (the scriptstate patch + final text on the terminal `done` frame) and no longer
  // re-derives it (zero scriptstate re-POSTs; editoutput applied server-side).
  it('derives an output-trigger scriptstate delta server-side with zero browser re-POSTs', async () => {
    const harness = await createRouteBackedHarness()
    try {
      const loaded = await loadFixture('simple-send')
      cleanups.push(loaded.cleanup)
      prepareRouteBackedFixture('simple-send')
      // An OUTPUT trigger sets `$mood` AFTER generation — the durable derivation the
      // browser used to run in `applyOutputTrigger`. The server runs + persists it;
      // the browser must consume the terminal patch, not re-POST a scriptstate command.
      testDatabaseState.db.characters[0].triggerscript = [
        {
          comment: '',
          type: 'output',
          conditions: [],
          effect: [{ type: 'setvar', operator: '=', var: 'mood', value: 'happy' }],
        },
      ]
      await harness.seed(testDatabaseState.db)
      vi.stubGlobal('fetch', harness.fetch)
      harness.setDispatchText('route-backed reply')

      // Browser starts on the pre-persist revision; the only way it reaches the
      // bumped revision is the SSE reconcile on the post-gen `done` frame.
      clearCachedServerCommandRevision()
      setCachedServerCommandRevision(1)
      const ok = await sendChat(-1, { ...(loaded.fixture.sendChatArgs ?? {}) })
      await drainRouteBackedCommands()
      expect(ok).toBe(true)

      // Zero browser-side durable derivation: no scriptstate command POSTs.
      const scriptstatePosts = harness.commandCalls.filter((call) => call.url.includes('/scriptstate'))
      expect(scriptstatePosts).toEqual([])

      // The projection reflects the server-derived scriptstate, applied from the
      // terminal post-gen patch (not a browser `applyOutputTrigger`).
      expect(testDatabaseState.db.characters[0].chats[0].scriptstate).toMatchObject({ $mood: 'happy' })

      // Durable: the job persisted the post-gen scriptstate delta + the result
      // message in one bump at completion (configure = 2 → persist = 3).
      const characterResources = await persistedCharacterResources(harness)
      const persistedChat = characterResources.characters[0].chats[0]
      expect(persistedChat.scriptstate).toMatchObject({ $mood: 'happy' })
      expect(characterResources.revision).toBe(3)
      const persistedAssistant = [...(await persistedChatMessages(harness))]
        .reverse()
        .find((m: { role: string }) => m.role === 'char')
      expect(persistedAssistant?.data).toBe('route-backed reply')

      // EC-D4 (durable): zero generation-result POSTs — the server persisted the
      // result; the browser reconciled the post-gen revision the `done` frame carried.
      const generationResultPosts = harness.commandCalls.filter((call) => call.url.includes('/generation-result'))
      expect(generationResultPosts).toEqual([])
      expect(getServerCompletionCalls()).toEqual([])
    } finally {
      await drainRouteBackedCommands()
      await harness.close()
    }
  })

  it('applies the server-owned editoutput final text to the assistant message', async () => {
    const harness = await createRouteBackedHarness()
    try {
      const loaded = await loadFixture('simple-send')
      cleanups.push(loaded.cleanup)
      prepareRouteBackedFixture('simple-send')
      // A regex editoutput the SERVER (not the browser) applies post-generation:
      // 'route-backed reply' → 'route-backed REPLY'.
      testDatabaseState.db.characters[0].customscript = [
        { comment: '', in: 'reply', out: 'REPLY', type: 'editoutput', flag: '', ableFlag: false },
      ]
      await harness.seed(testDatabaseState.db)
      vi.stubGlobal('fetch', harness.fetch)
      harness.setDispatchText('route-backed reply')

      clearCachedServerCommandRevision()
      const ok = await sendChat(-1, { ...(loaded.fixture.sendChatArgs ?? {}) })
      await drainRouteBackedCommands()
      expect(ok).toBe(true)

      // The browser wrote the server-owned editoutput final text onto its projection
      // assistant message (it skipped `editoutput` itself on this path).
      const liveChat = testDatabaseState.db.characters[0].chats[0]
      const assistant = [...liveChat.message].reverse().find((m) => m.role === 'char')
      expect(assistant?.data).toBe('route-backed REPLY')

      // EC-D4 (durable): the server persisted the editoutput'd text; the browser
      // issues zero generation-result POSTs.
      const generationResultPosts = harness.commandCalls.filter((call) => call.url.includes('/generation-result'))
      expect(generationResultPosts).toEqual([])
      const bootstrap = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': harness.authAssertion },
      })
      const persistedAssistant = [...(await persistedChatMessages(harness))]
        .reverse()
        .find((m: { role: string }) => m.role === 'char')
      expect(persistedAssistant?.data).toBe('route-backed REPLY')
      expect(getServerCompletionCalls()).toEqual([])
    } finally {
      await drainRouteBackedCommands()
      await harness.close()
    }
  })

  it('appends IGP to the streamed server terminal derived text with row preconditions', async () => {
    const harness = await createRouteBackedHarness()
    try {
      const loaded = await loadFixture('simple-send')
      cleanups.push(loaded.cleanup)
      prepareRouteBackedFixture('simple-send')
      testDatabaseState.db.characters[0].customscript = [
        { comment: '', in: 'reply', out: 'REPLY', type: 'editoutput', flag: '', ableFlag: false },
      ]
      testDatabaseState.db.igpPrompt = '<|im_start|>system<|im_sep|>Append a marker.<|im_end|>'
      installProviderScript([{ type: 'success', result: '::IGP' }])
      await harness.seed(testDatabaseState.db)
      vi.stubGlobal('fetch', harness.fetch)
      harness.setDispatchText('route-backed reply')

      clearCachedServerCommandRevision()
      const ok = await sendChat(-1, { ...(loaded.fixture.sendChatArgs ?? {}) })
      await drainRouteBackedCommands()

      expect(ok).toBe(true)
      const assistant = [...testDatabaseState.db.characters[0].chats[0].message]
        .reverse()
        .find((message) => message.role === 'char')
      expect(assistant?.data).toBe('route-backed REPLY::IGP')
      expect(getProviderCalls()).toEqual([
        {
          arg: expect.objectContaining({
            formated: [expect.objectContaining({ role: 'system', content: 'Append a marker.' })],
          }),
          model: 'emotion',
        },
      ])

      const igpCommand = harness.commandCalls.find(
        (call) => call.method === 'PATCH' && /^\/api\/v1\/commands\/messages\/[^/]+$/.test(call.url),
      )
      expect(igpCommand?.body).toMatchObject({
        patch: { data: 'route-backed REPLY::IGP' },
        expectedData: 'route-backed REPLY',
        expectedChatId: 'chat-route-backed',
        expectedGenerationId: expect.any(String),
        igpEffect: { generationId: expect.any(String), claimId: expect.any(String) },
      })
    } finally {
      await drainRouteBackedCommands()
      await harness.close()
    }
  })

  it('assembles inlay multimodal bytes server-side with byte parity to the local golden', async () => {
    const harness = await createRouteBackedHarness()
    try {
      const loaded = await loadFixture('multimodal-image')
      cleanups.push(loaded.cleanup)

      // The multimodal-image fixture's vision model omits url/key because the
      // local sweep dispatches through the provider fake; add them so the send
      // is server-routable, then mirror prepareRouteBackedFixture's prompt setup
      // (this fixture is not in the parametrized ROUTE_BACKED_CHAT_FIXTURES set).
      const custom = (testDatabaseState.db.customModels as Array<Record<string, unknown>>)[0]
      custom.url = 'https://vision.example.com/v1/chat/completions'
      custom.key = 'sk-vision-fixture'
      const char = testDatabaseState.db.characters[0]
      char.chats[char.chatPage ?? 0].id = 'chat-route-backed'
      ;(testDatabaseState.db as typeof testDatabaseState.db & { currentChar: number }).currentChar = 0
      testDatabaseState.db.mainPrompt = defaultMainPrompt
      testDatabaseState.db.formatingOrder = [
        'main',
        'description',
        'personaPrompt',
        'chats',
        'lastChat',
        'jailbreak',
        'lorebook',
        'globalNote',
        'authorNote',
      ]
      testDatabaseState.db.promptSettings = {
        assistantPrefill: '',
        postEndInnerFormat: '',
        sendChatAsSystem: false,
        sendName: false,
        utilOverride: false,
        ...(testDatabaseState.db.promptSettings ?? {}),
      }
      // The fixture ships `promptTemplate: null`, which the risusave import
      // coerces to `[]` — and the server then treats an empty array as an
      // (empty) active template, assembling zero rows. That null-coercion is a
      // pre-existing multimodal concern; clear it to `undefined` so the
      // format-order path runs and a real prompt (with the inlay row) assembles.
      ;(testDatabaseState.db as unknown as { promptTemplate?: unknown }).promptTemplate = undefined
      markFixtureActiveChatGenerationSettingsReady({ canonicalOpenAiProfile: true })

      await harness.seed(testDatabaseState.db)
      const inlayUpload = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/assets',
        headers: { 'risu-auth': harness.authAssertion, 'content-type': 'image/png' },
        payload: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
          'base64',
        ),
      })
      expect(inlayUpload.statusCode).toBe(201)
      vi.stubGlobal('fetch', harness.fetch)
      harness.setDispatchText('I see a small image.')

      clearCachedServerCommandRevision()
      const ok = await sendChat(-1, { ...(loaded.fixture.sendChatArgs ?? {}) })
      expect(ok).toBe(true)

      // The browser resolved the legacy inlay id to a server asset id. Only the
      // reference rides the request; the server reads bytes from its asset store.
      expect(harness.chatCalls).toHaveLength(1)
      expect(harness.chatCalls[0].body.inlayAssets).toBeUndefined()
      expect(harness.chatCalls[0].body.inlayAssetRefs).toEqual([
        {
          id: 'test-image',
          assetId: '63ef318d96b5d0d0ceba6e04a4e622b1158335cdc67c49e27839132c6f655058',
          width: 1,
          height: 1,
        },
      ])

      // Byte-parity: the server-assembled formated user row carries the exact
      // inlay MultiModal the local golden's provider call does.
      expect(harness.dispatchCalls).toHaveLength(1)
      const formated = harness.dispatchCalls[0].formated as Array<Record<string, unknown>>
      const userRow = formated.find(
        (row) =>
          row.role === 'user' && typeof row.content === 'string' && (row.content as string).includes('Look at this'),
      )
      const golden = await loadExpected('multimodal-image')
      const goldenUserRow = (golden.providerCalls[0].formated as Array<Record<string, unknown>>).find(
        (row) => row.role === 'user',
      )
      expect(userRow?.multimodals).toEqual(goldenUserRow?.multimodals)
      // The browser never fell back to a local provider/completion dispatch.
      expect(getServerCompletionCalls()).toEqual([])
    } finally {
      await drainRouteBackedCommands()
      await harness.close()
    }
  })

  // The image-gen / emotion view instruction (`buildInlayViewInstruction`)
  // assembles server-side. These fixtures set `inlayViewScreen` (one `emotion`,
  // one `imggen`); the assertion pins that the server-assembled `system` instruction
  // row is byte-identical to the local golden, including the `{{slot}}` →
  // `emotionImages` substitution. The post-gen image generation / inlay rendering
  // stays a browser effect and is untouched here.
  const IMAGE_GEN_PARITY = [
    {
      name: 'image-gen-emotion',
      marker: 'Pick an emotion from:',
      expected: 'Pick an emotion from: happy, sad',
    },
    {
      name: 'image-gen-imggen',
      marker: 'Generate an image of the current scene.',
      expected: 'Generate an image of the current scene.',
    },
  ] as const

  it.each(IMAGE_GEN_PARITY)(
    'assembles the $name view instruction row server-side with byte parity to the local golden',
    async ({ name, marker, expected }) => {
      const harness = await createRouteBackedHarness()
      try {
        const loaded = await loadFixture(name)
        cleanups.push(loaded.cleanup)

        // Mirror prepareRouteBackedFixture's prompt setup (these fixtures are not
        // in the parametrized ROUTE_BACKED_CHAT_FIXTURES set). The
        // `promptTemplate: null` → `[]` import coercion is cleared to `undefined`
        // so the format-order path runs (same workaround as the multimodal test).
        const char = testDatabaseState.db.characters[0]
        char.chats[char.chatPage ?? 0].id = 'chat-route-backed'
        ;(testDatabaseState.db as typeof testDatabaseState.db & { currentChar: number }).currentChar = 0
        testDatabaseState.db.mainPrompt = defaultMainPrompt
        testDatabaseState.db.formatingOrder = [
          'main',
          'description',
          'personaPrompt',
          'chats',
          'lastChat',
          'jailbreak',
          'lorebook',
          'globalNote',
          'authorNote',
        ]
        testDatabaseState.db.promptSettings = {
          assistantPrefill: '',
          postEndInnerFormat: '',
          sendChatAsSystem: false,
          sendName: false,
          utilOverride: false,
          ...(testDatabaseState.db.promptSettings ?? {}),
        }
        ;(testDatabaseState.db as unknown as { promptTemplate?: unknown }).promptTemplate = undefined
        markFixtureActiveChatGenerationSettingsReady({ canonicalOpenAiProfile: true })

        await harness.seed(testDatabaseState.db)
        vi.stubGlobal('fetch', harness.fetch)
        harness.setDispatchText('Hello there!')

        clearCachedServerCommandRevision()
        const ok = await sendChat(-1, { ...(loaded.fixture.sendChatArgs ?? {}) })
        expect(ok).toBe(true)

        // The send routed server-side (classifier flip: image-gen → server), and
        // the assembled prompt carries the instruction row.
        expect(harness.dispatchCalls).toHaveLength(1)
        const serverFormated = harness.dispatchCalls[0].formated as Array<Record<string, unknown>>
        const serverRow = serverFormated.find(
          (row) => typeof row.content === 'string' && (row.content as string).includes(marker),
        )

        const golden = await loadExpected(name)
        const goldenFormated = golden.providerCalls[0].formated as Array<Record<string, unknown>>
        const goldenRow = goldenFormated.find(
          (row) => typeof row.content === 'string' && (row.content as string).includes(marker),
        )

        // The golden proves the local assembler substituted `{{slot}}`; the server
        // row proves the port reproduces it byte-for-byte.
        expect(goldenRow).toEqual({ role: 'system', content: expected })
        expect(serverRow).toEqual(goldenRow)
        // No local provider/completion fallback — the prompt was server-assembled.
        expect(getServerCompletionCalls()).toEqual([])
      } finally {
        await drainRouteBackedCommands()
        await harness.close()
      }
    },
  )

  // The submit-time `editinput` transform runs on the server route, not the
  // browser. This route-backed integration test proves the full path end-to-end:
  // the browser ships the *raw* user text, the real in-process server runs a
  // regex `editinput` script over it, owns the post-transform transcript write,
  // and the browser reconciles its projection from the route's `message_patch`.
  // (A *Lua* editinput char can't run here for
  // the same wasmoon-under-jsdom reason noted below; the Lua path is proven in
  // the server suite.)
  it('runs a regex editinput transform server-side and reconciles the projection', async () => {
    const harness = await createRouteBackedHarness()
    try {
      const loaded = await loadFixture('simple-send')
      cleanups.push(loaded.cleanup)
      prepareRouteBackedFixture('simple-send')
      // A regex editinput script the server (not the browser) applies to the
      // submitted user text: "Hi there" → "Hi THERE".
      testDatabaseState.db.characters[0].customscript = [
        { comment: '', in: 'there', out: 'THERE', type: 'editinput', flag: '', ableFlag: false },
      ]
      await harness.seed(testDatabaseState.db)
      vi.stubGlobal('fetch', harness.fetch)
      harness.setDispatchText('reply')

      clearCachedServerCommandRevision()
      const ok = await sendChat(-1, { ...(loaded.fixture.sendChatArgs ?? {}) })
      expect(ok).toBe(true)

      // The browser shipped the RAW user text; the server owns the editinput
      // transform (no double application).
      expect(harness.chatCalls).toHaveLength(1)
      expect(harness.chatCalls[0].body).toMatchObject({ mode: 'send', userMessage: 'Hi there' })

      // The reconciled projection (and the route-owned persisted transcript)
      // carry the server-transformed user message.
      const liveChat = testDatabaseState.db.characters[0].chats[0]
      const userRow = liveChat.message.find((m) => m.role === 'user')
      expect(userRow?.data).toBe('Hi THERE')

      const persistedUser = ((await persistedChatMessages(harness)) as Array<{ role: string; data: string }>).find(
        (m) => m.role === 'user',
      )
      expect(persistedUser?.data).toBe('Hi THERE')
      expect(getServerCompletionCalls()).toEqual([])
    } finally {
      await drainRouteBackedCommands()
      await harness.close()
    }
  })

  // Note: a route-backed parity test for a `triggerlua` char (editRequest,
  // editinput, or an input trigger) cannot run here. The route-backed harness
  // boots the real Fastify server in-process, and the server Lua VM uses
  // `wasmoon`, whose WASM init calls `createRequire(import.meta.url)` — which
  // throws under this suite's jsdom environment (the URL is
  // `http://localhost:3000/...`, not a file URL). That is the same reason
  // `__fixtures__/mocks/scriptings.ts` exists. The server-side editRequest /
  // editinput / input-trigger Lua proofs therefore live in the server suite
  // (`server/fastify/__tests__/generation.chat.test.ts`, node env), where wasmoon
  // initializes. A second reason `editinput` Lua parity can't be a "server ==
  // local golden" check anywhere: the local golden sweep drives `sendChat`
  // directly, bypassing the chat-screen submit handler where the browser runs
  // `editinput`, so the local golden never carries an editinput transform to
  // compare against — only the server runs it. The classifier flip (browser →
  // `server` for Lua) is proven in `request/tests/serverPromptAssembly.test.ts`.
})

describe('sendChat fixtures (/chat adapter replay)', () => {
  let contextCommandRevision = 1

  const serverChatFixtureFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const messageUpdate = url.match(/\/api\/v1\/commands\/messages\/([^/]+)$/)
    if (messageUpdate && (init?.method ?? 'GET') === 'PATCH') {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { baseRevision?: unknown }) : undefined
      const baseRevision = typeof body?.baseRevision === 'number' ? body.baseRevision : contextCommandRevision
      contextCommandRevision = Math.max(contextCommandRevision, baseRevision) + 1
      return new Response(
        JSON.stringify({
          revision: contextCommandRevision,
          event: {
            type: 'message.updated',
            revision: contextCommandRevision,
            resource: 'message',
            id: decodeURIComponent(messageUpdate[1]),
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (
      (/\/api\/v1\/commands\/characters\/[^/]+$/.test(url) && (init?.method ?? 'GET') === 'PATCH') ||
      (/\/api\/v1\/commands\/chats\/[^/]+\/messages\/tail$/.test(url) && (init?.method ?? 'GET') === 'POST')
    ) {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { baseRevision?: unknown }) : undefined
      const baseRevision = typeof body?.baseRevision === 'number' ? body.baseRevision : contextCommandRevision
      contextCommandRevision = Math.max(contextCommandRevision, baseRevision) + 1
      return new Response(
        JSON.stringify({
          revision: contextCommandRevision,
          event: {
            type: 'context.updated',
            revision: contextCommandRevision,
            resource: 'context',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return serverChatFetch(input, init)
  }

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    vi.stubGlobal('fetch', serverChatFixtureFetch)
  })

  afterAll(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    resetProviderState()
    resetSideEffectCalls()
    resetServerChatState()
    resetServerCompletionCalls()
    doingChat.set(false)
    abortChat.set(false)
    chatProcessStage.set(0)
    uuidState.counter = 0
    contextCommandRevision = 1
    _setPluginRuntimePhaseForTesting('ready')
    chatOutputListeners.clear()
    terminalEffectMocks.notify.mockClear()
    terminalEffectMocks.embedding.mockClear()
    terminalEffectMocks.completionSound.mockClear()
  })

  let cleanups: (() => void)[] = []
  afterEach(() => {
    _setPluginRuntimePhaseForTesting('idle')
    chatOutputListeners.clear()
    while (cleanups.length > 0) cleanups.pop()!()
  })

  it('pins hypav3-memory server-backed prompt rows and progress side effects', async () => {
    const loaded = await loadFixture('hypav3-memory')
    cleanups.push(loaded.cleanup)
    markFixtureActiveChatGenerationSettingsReady({ canonicalOpenAiProfile: true })
    const expected = await loadExpected('hypav3-memory')
    const providerCall = expected.providerCalls[0]
    expect(providerCall).toBeDefined()
    const formated = providerCall.formated as Array<Record<string, unknown>>
    const memoryRows = formated.filter((row) => row.memo === 'hypaMemory')
    expect(memoryRows).toEqual([
      {
        role: 'system',
        content:
          '<Previous Conversation>Summary: in a previous turn the user discussed gardening tips.</Previous Conversation>',
        memo: 'hypaMemory',
      },
    ])
    setServerChatPrompt(
      formated.map((row) => ({ role: String(row.role), content: row.content })),
      {},
      { formated },
    )

    const expectedGenerationInfo = expected.generationInfo as {
      generationId?: string
      inputTokens?: number
      outputTokens?: number
    }
    setServerChatInfo(
      expectedGenerationInfo.inputTokens ?? 0,
      expectedGenerationInfo.outputTokens ?? testDatabaseState.db.maxResponse,
    )
    const assistant = [...expected.messages].reverse().find((m) => m.role === 'char')
    expect(assistant).toBeDefined()
    setServerChatDispatchResult(
      assistant?.data ?? '',
      expected.generationInfo as Record<string, unknown>,
      expectedGenerationInfo.generationId ?? 'uuid-0',
    )
    setServerChatSideEffects([
      {
        kind: 'hypav3_progress',
        payload: {
          open: true,
          miniMsg: '2',
          msg: '[Hypa V3] Summarizing...',
          subMsg: '2 queued',
          status: 'running',
          queuedCount: 2,
        },
      },
    ])

    const stageRecorder = recordStages()
    await sendChat(-1, { ...(loaded.fixture.sendChatArgs ?? {}) })
    const stages = stageRecorder.stop()
    const captured = captureSnapshot(stages)

    expect(captured.messages).toEqual(expected.messages)
    expect(captured.generationInfo).toEqual(expected.generationInfo)
    expect(captured.stages).toEqual([1, 3, 4])
    expect(captured.doingChat).toBe(false)
    expect(captured.providerCalls).toEqual([])
    expect(getServerChatCalls()).toHaveLength(1)
    expect(getServerChatCalls()[0]).toMatchObject({
      url: '/api/v1/generate/chat',
      method: 'POST',
      authHeader: 'fixture-auth-token',
      mode: 'send',
    })
    expect(getServerCompletionCalls()).toEqual([])
  })

  it('rolls back server-applied chat mutations when /chat dispatch fails after streaming starts', async () => {
    const loaded = await loadFixture('simple-send')
    cleanups.push(loaded.cleanup)
    markFixtureActiveChatGenerationSettingsReady({ canonicalOpenAiProfile: true })
    const originalMessages = JSON.parse(
      JSON.stringify(testDatabaseState.db.characters[0].chats[0].message),
    ) as Chat['message']
    setServerChatPrompt(
      [{ role: 'user', content: 'Hi there' }],
      {},
      {
        formated: [{ role: 'user', content: 'Hi there' }],
      },
    )
    setServerChatMessagePatch({
      chatId: testDatabaseState.db.characters[0].chats[0].id ?? '',
      characterId: testDatabaseState.db.characters[0].chaId,
      selectedCharID: 0,
      chatPage: 0,
      varChanged: false,
      messageMutations: [
        {
          type: 'append',
          source: 'user_message',
          index: 0,
          message: originalMessages[0],
        },
      ],
      chatVarMutations: [],
      additionalSystemPrompt: [],
    })
    setServerChatDispatchError(
      'provider exploded',
      {
        model: 'gpt-4o',
        inputTokens: 233,
        outputTokens: 200,
        maxContext: 4000,
      },
      {
        chatId: testDatabaseState.db.characters[0].chats[0].id ?? '',
        characterId: testDatabaseState.db.characters[0].chaId,
        selectedCharID: 0,
        chatPage: 0,
        messages: originalMessages,
        scriptstate: {},
      },
      'uuid-0',
    )
    testDatabaseState.db.igpPrompt = '<|im_start|>system<|im_sep|>Append a marker.<|im_end|>'
    installProviderScript([{ type: 'success', result: '::SHOULD-NOT-RUN' }])
    const result = await sendChat(-1, {})

    expect(result).toBe(false)
    expect(testDatabaseState.db.characters[0].chats[0].message).toEqual(originalMessages)
    expect(testDatabaseState.db.characters[0].chats[0].isStreaming).toBe(false)
    expect(getSideEffectCalls()).not.toContainEqual({
      fn: 'sayTTS',
      args: expect.any(Array),
    })
    expect(getServerChatCalls()).toHaveLength(1)
    expect(getServerCompletionCalls()).toEqual([])
    expect(getProviderCalls()).toEqual([])
  })

  it('forwards the synthetic say-nothing marker on the server-backed send', async () => {
    const loaded = await loadFixture('simple-send')
    cleanups.push(loaded.cleanup)
    markFixtureActiveChatGenerationSettingsReady({ canonicalOpenAiProfile: true })
    testDatabaseState.db.characters[0].chats[0].message.at(-1)!.data = '*says nothing*'

    setServerChatDispatchResult('Hello there!', { model: 'gpt-4o' }, 'uuid-0')
    const result = await sendChat(-1, { syntheticSayNothing: true })

    expect(result).toBe(true)
    expect(getServerChatCalls()).toHaveLength(1)
    expect(getServerChatCalls()[0]).toMatchObject({
      mode: 'send',
      userMessage: '*says nothing*',
      syntheticSayNothing: true,
    })
  })

  it.each([
    { changed: false, finalText: 'evicted prefix retained suffix' },
    { changed: true, finalText: 'server-derived complete reply' },
  ])(
    'settles every terminal consumer from the complete replay result (post-generation changed: $changed)',
    async ({ changed, finalText }) => {
      const loaded = await loadFixture('simple-send')
      cleanups.push(loaded.cleanup)
      testDatabaseState.db.characters[0].chats[0].id = 'chat-canonical-replay'
      markFixtureActiveChatGenerationSettingsReady({ canonicalOpenAiProfile: true })
      testDatabaseState.db.notification = true
      testDatabaseState.db.emotionProcesser = 'embedding'
      testDatabaseState.db.igpPrompt = '<|im_start|>system<|im_sep|>Append a marker.<|im_end|>'
      const currentChar = testDatabaseState.db.characters[0]
      currentChar.viewScreen = 'emotion'
      currentChar.emotionImages = [['happy', 'happy.png']]
      installProviderScript([{ type: 'success', result: '::IGP' }])

      const listener = vi.fn()
      addChatOutputListener('output', listener)
      setServerChatDispatchResult('evicted prefix retained suffix', { model: 'gpt-4o' }, 'uuid-0', {
        streamedResult: 'retained suffix',
        ...(changed ? { postGeneration: { finalText } } : {}),
      })
      const result = await sendChat(-1, {})

      expect(result).toBe(true)
      expect(listener).toHaveBeenCalledOnce()
      const listenerChat = listener.mock.calls[0]?.[0].chat as Chat
      expect(listenerChat.message.find((message) => message.role === 'char')?.data).toBe(finalText)
      expect(getProviderCalls()).toHaveLength(1)
      const assistant = testDatabaseState.db.characters[0].chats[0].message.find((message) => message.role === 'char')
      expect(assistant?.data).toBe(`${finalText}::IGP`)
      expect(terminalEffectMocks.notify).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'evicted prefix retained suffix' }),
      )
      expect(terminalEffectMocks.embedding).toHaveBeenCalledWith(
        expect.objectContaining({ result: 'evicted prefix retained suffix' }),
      )
      expect(terminalEffectMocks.completionSound).toHaveBeenCalledOnce()
    },
  )

  it.each([
    {
      fixture: 'simple-send' as const,
      args: {},
      rawResult: 'complete send reply',
      suffix: 'send reply',
      changed: false,
      expected: 'complete send reply',
    },
    {
      fixture: 'simple-send' as const,
      args: {},
      rawResult: 'complete send reply',
      suffix: 'send reply',
      changed: true,
      expected: 'derived complete send reply',
    },
    {
      fixture: 'continue' as const,
      args: { continue: true },
      rawResult: ' and then complete',
      suffix: ' complete',
      changed: false,
      expected: 'Once upon a time and then complete',
    },
    {
      fixture: 'continue' as const,
      args: { continue: true },
      rawResult: ' and then complete',
      suffix: ' complete',
      changed: true,
      expected: 'Derived complete continued row.',
    },
    {
      fixture: 'regenerate' as const,
      args: { regenerateMessageId: 'msg-char-1' },
      rawResult: 'complete regenerated reply',
      suffix: 'regenerated reply',
      changed: false,
      expected: 'complete regenerated reply',
    },
    {
      fixture: 'regenerate' as const,
      args: { regenerateMessageId: 'msg-char-1' },
      rawResult: 'complete regenerated reply',
      suffix: 'regenerated reply',
      changed: true,
      expected: 'derived complete regenerated reply',
    },
  ])(
    'projects the complete $fixture terminal onto the owned row (post-generation changed: $changed)',
    async ({ fixture, args, rawResult, suffix, changed, expected }) => {
      const loaded = await loadFixture(fixture)
      cleanups.push(loaded.cleanup)
      prepareRouteBackedFixture(fixture)
      setServerChatDispatchResult(rawResult, { model: 'gpt-4o' }, 'uuid-0', {
        streamedResult: suffix,
        ...(changed
          ? {
              postGeneration: {
                messageId: fixture === 'simple-send' ? 'uuid-0' : 'msg-char-1',
                finalText: expected,
              },
            }
          : {}),
      })
      const result = await sendChat(-1, args)

      expect(result).toBe(true)
      const messages = testDatabaseState.db.characters[0].chats[0].message
      const assistants = messages.filter((message) => message.role === 'char')
      if (fixture !== 'regenerate') expect(assistants).toHaveLength(1)
      expect(assistants.at(-1)?.data).toBe(expected)
    },
  )

  it('reconciles a cancelled partial snapshot but suppresses every success-only terminal consumer', async () => {
    const loaded = await loadFixture('simple-send')
    cleanups.push(loaded.cleanup)
    testDatabaseState.db.characters[0].chats[0].id = 'chat-cancelled-replay'
    markFixtureActiveChatGenerationSettingsReady({ canonicalOpenAiProfile: true })
    testDatabaseState.db.notification = true
    testDatabaseState.db.emotionProcesser = 'embedding'
    testDatabaseState.db.igpPrompt = '<|im_start|>system<|im_sep|>Must not run.<|im_end|>'
    const currentChar = testDatabaseState.db.characters[0]
    currentChar.viewScreen = 'emotion'
    currentChar.emotionImages = [['happy', 'happy.png']]
    installProviderScript([{ type: 'success', result: '::MUST-NOT-RUN' }])

    const listener = vi.fn()
    addChatOutputListener('output', listener)
    setServerChatDispatchResult('complete partial reply', { model: 'gpt-4o' }, 'uuid-0', {
      streamedResult: 'partial reply',
      outcome: 'cancelled',
      emitTtsSideEffect: true,
      alternates: ['must not become a reroll'],
      postGeneration: {
        messageId: 'uuid-0',
        revision: 3,
        finalText: '*says nothing*complete partial reply',
      },
    })
    const onReattachOutcome = vi.fn()
    const result = await sendChat(-1, { reattachJobId: 'job-cancelled', onReattachOutcome })

    expect(result).toBe(false)
    expect(onReattachOutcome).toHaveBeenCalledWith({ status: 'cancelled' })
    const assistant = testDatabaseState.db.characters[0].chats[0].message.find((message) => message.role === 'char')
    expect(assistant?.data).toBe('*says nothing*complete partial reply')
    expect(listener).not.toHaveBeenCalled()
    expect(getProviderCalls()).toEqual([])
    expect(terminalEffectMocks.notify).not.toHaveBeenCalled()
    expect(terminalEffectMocks.embedding).not.toHaveBeenCalled()
    expect(terminalEffectMocks.completionSound).not.toHaveBeenCalled()
    expect(getSideEffectCalls().filter((call) => ['addRerolls', 'runInlayScreen', 'sayTTS'].includes(call.fn))).toEqual(
      [],
    )
  })

  it('evaluates IGP once after a reattached stream applies its terminal derived text', async () => {
    const loaded = await loadFixture('simple-send')
    cleanups.push(loaded.cleanup)
    testDatabaseState.db.characters[0].chats[0].id = 'chat-reattach'
    markFixtureActiveChatGenerationSettingsReady({ canonicalOpenAiProfile: true })
    testDatabaseState.db.igpPrompt = '<|im_start|>system<|im_sep|>Append a marker.<|im_end|>'
    let textAtIgpEvaluation = ''
    const requestModule = await import('../request/request')
    const igpRequest = vi.spyOn(requestModule, 'requestChatData').mockImplementationOnce(async () => {
      textAtIgpEvaluation =
        [...testDatabaseState.db.characters[0].chats[0].message].reverse().find((message) => message.role === 'char')
          ?.data ?? ''
      return { type: 'success', result: '::IGP' }
    })
    try {
      setServerChatDispatchResult(
        'raw reattached reply',
        { model: 'gpt-4o', generationId: 'reattached-generation' },
        'reattached-generation',
        { postGeneration: { finalText: 'derived reattached reply' } },
      )
      const result = await sendChat(-1, { reattachJobId: 'job-reattach' })

      expect(result).toBe(true)
      expect(igpRequest).toHaveBeenCalledTimes(1)
      expect(textAtIgpEvaluation).toBe('derived reattached reply')
      expect(igpRequest.mock.calls[0][1]).toBe('emotion')
      expect(getServerChatCalls()).toHaveLength(1)
      expect(getServerChatCalls()[0].url).toContain('/api/v1/generate/chat/job-reattach/stream')
    } finally {
      igpRequest.mockRestore()
    }
  })

  it('speaks every server-derived choice after browser-owned inlay processing', async () => {
    const loaded = await loadFixture('simple-send')
    cleanups.push(loaded.cleanup)
    markFixtureActiveChatGenerationSettingsReady({ canonicalOpenAiProfile: true })
    testDatabaseState.db.ttsAutoSpeech = true

    setServerChatPrompt(
      [{ role: 'user', content: 'Hi there' }],
      {},
      {
        formated: [{ role: 'user', content: 'Hi there' }],
      },
    )
    setServerChatInfo(233, 200)
    setServerChatDispatchResult(
      'raw primary',
      {
        model: 'gpt-4o',
        inputTokens: 233,
        outputTokens: 200,
        maxContext: 4000,
      },
      'uuid-0',
      { postGeneration: { finalText: 'derived primary' } },
    )
    setServerChatSideEffects([
      { kind: 'tts', payload: { text: 'derived primary', characterId: 'char-tess' } },
      { kind: 'tts', payload: { text: 'derived alternate', characterId: 'char-tess' } },
    ])
    const result = await sendChat(-1, {})

    expect(result).toBe(true)
    expect(getSideEffectCalls().filter((call) => call.fn === 'sayTTS')).toEqual([
      {
        fn: 'sayTTS',
        args: [{ chaId: 'char-tess', name: 'Tess' }, 'derived primary'],
      },
      {
        fn: 'sayTTS',
        args: [{ chaId: 'char-tess', name: 'Tess' }, 'derived alternate'],
      },
    ])
    expect(getSideEffectCalls().filter((call) => call.fn === 'runInlayScreen')).toEqual([
      {
        fn: 'runInlayScreen',
        args: [{ chaId: 'char-tess', name: 'Tess' }, 'derived primary'],
      },
      {
        fn: 'runInlayScreen',
        args: [{ chaId: 'char-tess', name: 'Tess' }, 'derived alternate'],
      },
    ])
  })
})
