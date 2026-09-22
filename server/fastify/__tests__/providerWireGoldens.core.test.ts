/** @module-tag core */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { openDatabase } from '../src/db.js'
import { applyImport } from '../src/repository.js'
import { normalizeRisuSaveSnapshotDatabase } from '../src/risuSave/importSnapshot.js'
import { saveSelectedPersonaSnapshot } from '../src/commands/personas.js'
import { extractModelPresetFields, extractPromptPresetFields } from '@risuai/shared-core/preset-split'
import { setupAuthedClient } from './helpers/auth.js'
import { expectTerminalDone, parseEvents, type PromptChatFrame } from './helpers/terminalFrameAssertions.js'

interface Harness {
  app: FastifyInstance
  dataDir: string
}

interface ProviderProfile {
  id: string
  name: string
  providerId?: string
  modelId: string
  providerOptions: Record<string, unknown>
  runtimeOptions?: Record<string, unknown>
}

interface WireCapture {
  normalization: { replaced: string[] }
  request: {
    method: string
    url: string
    headers: Record<string, string>
    body: unknown
  }
}

type JsonRecord = Record<string, unknown>

const GOLDEN_DIR = fileURLToPath(new URL('./goldens/provider-wire/', import.meta.url))
const PERSONA_ID = 'provider-wire-persona'
const MODEL_PRESET_ID = 'provider-wire-model-preset'
const PROMPT_PRESET_ID = 'provider-wire-prompt-preset'
const CHAT_ID = 'provider-wire-chat'
const CHARACTER_ID = 'provider-wire-character'

let harness: Harness

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-provider-wire-'))
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
    bardWikiWorker: false,
    memoryWorker: false,
    assetGc: false,
  })
  return { app, dataDir }
}

beforeEach(async () => {
  harness = await startHarness()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
})

function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function firstId(collection: unknown, fallback: string): string {
  if (!Array.isArray(collection)) return fallback
  const first = collection.find((item) => isJsonRecord(item) && typeof item.id === 'string')
  return isJsonRecord(first) && typeof first.id === 'string' ? first.id : fallback
}

function normalizeGenerationFixture(database: unknown): unknown {
  const normalized = structuredClone(database)
  if (!isJsonRecord(normalized)) return normalized

  if (!Array.isArray(normalized.personas) || normalized.personas.length === 0) {
    const personas: Parameters<typeof saveSelectedPersonaSnapshot>[1] = [
      { id: PERSONA_ID, name: 'Golden User', icon: '', personaPrompt: '', note: '' },
    ]
    normalized.personas = personas
    normalized.selectedPersona = 0
    normalized.selectedPersonaId = PERSONA_ID
    saveSelectedPersonaSnapshot(normalized, personas)
  }

  if (!Array.isArray(normalized.modelPresets) || normalized.modelPresets.length === 0) {
    const modelFields = extractModelPresetFields(normalized)
    normalized.modelPresets = [
      {
        ...modelFields,
        id: MODEL_PRESET_ID,
        name: 'Provider Wire Model',
        maxContext: normalized.maxContext ?? 100_000,
        maxResponse: normalized.maxResponse ?? 37,
      },
    ]
    normalized.modelPresetsId = 0
  }

  if (!Array.isArray(normalized.promptPresets) || normalized.promptPresets.length === 0) {
    normalized.promptPresets = [
      {
        ...extractPromptPresetFields(normalized),
        id: PROMPT_PRESET_ID,
        name: 'Provider Wire Prompt',
        mainPrompt: normalized.mainPrompt ?? 'GOLDEN SYSTEM RULES',
        formatingOrder: normalized.formatingOrder ?? ['main', 'description', 'chats', 'lastChat'],
        promptSettings: normalized.promptSettings,
        customPromptTemplateToggle: '',
      },
    ]
    normalized.promptPresetsId = 0
  }

  const personaId = firstId(normalized.personas, PERSONA_ID)
  const modelPresetId = firstId(normalized.modelPresets, MODEL_PRESET_ID)
  const promptPresetId = firstId(normalized.promptPresets, PROMPT_PRESET_ID)
  const characters = Array.isArray(normalized.characters) ? normalized.characters : []
  for (const character of characters) {
    if (!isJsonRecord(character) || !Array.isArray(character.chats)) continue
    for (const chat of character.chats) {
      if (!isJsonRecord(chat)) continue
      chat.generationSettings = {
        configured: true,
        personaId,
        modelPresetId,
        promptPresetId,
        jailbreakToggle: false,
        sidebarToggles: {},
      }
    }
  }
  return normalized
}

function providerDatabase(input: {
  profile: ProviderProfile
  credential: { id: string; name: string; apiKey: string }
  settings?: Record<string, unknown>
}): unknown {
  return {
    currentChar: 0,
    aiModel: input.profile.modelId,
    useStreaming: input.profile.runtimeOptions?.useStreaming === true,
    maxContext: 100_000,
    maxResponse: 37,
    temperature: 42,
    top_p: 0.73,
    top_k: 11,
    mainPrompt: 'GOLDEN SYSTEM RULES',
    formatingOrder: ['main', 'description', 'chats', 'lastChat'],
    promptSettings: {
      assistantPrefill: '',
      postEndInnerFormat: '',
      sendChatAsSystem: false,
      sendName: false,
      utilOverride: false,
    },
    characters: [
      {
        type: 'character',
        name: 'Golden Character',
        chaId: CHARACTER_ID,
        utilityBot: false,
        chatPage: 0,
        desc: 'GOLDEN CHARACTER DESCRIPTION',
        firstMessage: 'Golden greeting.',
        chats: [
          {
            id: CHAT_ID,
            name: 'Provider Wire Chat',
            note: '',
            localLore: [],
            message: [
              { role: 'user', data: 'Golden prior user turn.', chatId: 'provider-wire-prior-user' },
              {
                role: 'char',
                data: 'Golden prior assistant turn.',
                chatId: 'provider-wire-prior-assistant',
                saying: CHARACTER_ID,
              },
            ],
          },
        ],
      },
    ],
    providerCredentials: [{ ...input.credential, type: 'apiKey' }],
    modelProfiles: [input.profile],
    modelRoleProfiles: { chatMain: { mode: 'profile', profileId: input.profile.id } },
    ...input.settings,
  }
}

async function seedDatabase(database: unknown): Promise<void> {
  const db = openDatabase(harness.dataDir)
  try {
    await applyImport(db, harness.dataDir, normalizeRisuSaveSnapshotDatabase(normalizeGenerationFixture(database)))
  } finally {
    db.close()
  }
}

function sortedHeaders(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries([...new Headers(headers).entries()].sort(([left], [right]) => left.localeCompare(right)))
}

function normalizeCapture(url: string, init: RequestInit | undefined): WireCapture {
  const headers = sortedHeaders(init?.headers)
  const replaced: string[] = []
  if (headers['x-amz-date']) {
    headers['x-amz-date'] = '<x-amz-date>'
    replaced.push('request.headers.x-amz-date')
  }
  if (headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')) {
    headers.authorization = headers.authorization
      .replace(/Credential=([^/]+)\/\d{8}\//u, 'Credential=$1/<date>/')
      .replace(/Signature=[0-9a-f]+/u, 'Signature=<signature>')
    replaced.push('request.headers.authorization.credential-date', 'request.headers.authorization.signature')
  }
  return {
    normalization: { replaced },
    request: {
      method: init?.method ?? 'GET',
      url,
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    },
  }
}

function stubProviderFetch(input: { expectedHost: string; response: () => Response }): WireCapture[] {
  const captures: WireCapture[] = []
  vi.stubGlobal('fetch', async (request: string | URL | Request, init?: RequestInit) => {
    const url = request instanceof Request ? request.url : String(request)
    captures.push(normalizeCapture(url, init))
    if (new URL(url).host !== input.expectedHost) {
      throw new Error(`unexpected provider host: ${new URL(url).host}`)
    }
    return input.response()
  })
  return captures
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function ndjsonResponse(lines: unknown[]): Response {
  return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

function expectGolden(cell: string, capture: WireCapture): void {
  const goldenPath = path.join(GOLDEN_DIR, `${cell}.json`)
  if (process.env.RISU_UPDATE_PROVIDER_GOLDENS === '1') {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(goldenPath, `${JSON.stringify(capture, null, 2)}\n`)
    throw new Error(`Provider wire golden ${cell} was rewritten and must be reviewed`)
  }
  const expected = JSON.parse(readFileSync(goldenPath, 'utf8')) as WireCapture
  expect(capture).toEqual(expected)
}

async function sendChat(assertion: string, userMessage: string): Promise<PromptChatFrame[]> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/generate/chat',
    headers: { 'risu-auth': assertion },
    payload: {
      chatId: CHAT_ID,
      characterId: CHARACTER_ID,
      mode: 'send',
      userMessage,
    },
  })
  expect(response.statusCode).toBe(200)
  return parseEvents(response.body)
}

function expectSuccessfulSend(events: PromptChatFrame[]): void {
  expect(events.filter((event) => event.type === 'error')).toEqual([])
  expectTerminalDone(events)
}

async function persistedMessages(assertion: string): Promise<Array<{ role: string; data: string }>> {
  const response = await harness.app.inject({
    method: 'GET',
    url: `/api/v1/chats/${CHAT_ID}/messages`,
    headers: { 'risu-auth': assertion },
  })
  expect(response.statusCode).toBe(200)
  return response.json().message
}

describe('provider wire goldens', () => {
  it('anthropic-messages', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const profile: ProviderProfile = {
      id: 'profile-anthropic-golden',
      name: 'Anthropic Golden',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet-latest',
      providerOptions: {
        credentialId: 'credential-anthropic-golden',
        requestModel: 'claude-golden-wire-model',
      },
      runtimeOptions: { useStreaming: false, maxResponse: 37 },
    }
    await seedDatabase(
      providerDatabase({
        profile,
        credential: {
          id: 'credential-anthropic-golden',
          name: 'Anthropic Golden',
          apiKey: 'golden-anthropic-key-7f3a',
        },
      }),
    )
    const captures = stubProviderFetch({
      expectedHost: 'api.anthropic.com',
      response: () =>
        jsonResponse({
          model: 'claude-golden-wire-model',
          content: [{ type: 'text', text: 'Golden Anthropic reply.' }],
          stop_reason: 'end_turn',
        }),
    })
    const events = await sendChat(assertion, 'Golden Anthropic current user turn.')

    expect(captures).toHaveLength(1)
    expectGolden('anthropic-messages', captures[0])
    expectSuccessfulSend(events)
    expect((await persistedMessages(assertion)).at(-1)).toMatchObject({
      role: 'char',
      data: 'Golden Anthropic reply.',
    })
  })

  it('gemini-generate-content', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const profile: ProviderProfile = {
      id: 'profile-gemini-golden',
      name: 'Gemini Golden',
      providerId: 'google',
      modelId: 'gemini-2.5-flash',
      providerOptions: {
        credentialId: 'credential-gemini-golden',
        requestModel: 'gemini-golden-wire-model',
      },
      runtimeOptions: { useStreaming: false, maxResponse: 37 },
    }
    await seedDatabase(
      providerDatabase({
        profile,
        credential: {
          id: 'credential-gemini-golden',
          name: 'Gemini Golden',
          apiKey: 'golden-gemini-key-a32c',
        },
      }),
    )
    const captures = stubProviderFetch({
      expectedHost: 'generativelanguage.googleapis.com',
      response: () =>
        jsonResponse({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'Golden Gemini reply.' }] },
              finishReason: 'STOP',
            },
          ],
        }),
    })
    const events = await sendChat(assertion, 'Golden Gemini current user turn.')

    expect(captures).toHaveLength(1)
    expectGolden('gemini-generate-content', captures[0])
    expectSuccessfulSend(events)
    expect((await persistedMessages(assertion)).at(-1)).toMatchObject({
      role: 'char',
      data: 'Golden Gemini reply.',
    })
  })

  it('ollama-chat-ndjson', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const profile: ProviderProfile = {
      id: 'profile-ollama-golden',
      name: 'Ollama Golden',
      providerId: 'ollama',
      modelId: 'ollama-hosted',
      providerOptions: {
        credentialId: 'credential-ollama-golden',
        requestModel: 'golden-ollama-model',
        baseUrl: 'https://ollama.golden.test',
        ollama: {
          url: 'https://ollama.golden.test',
          modelSource: 'local',
          thinkingMode: 'off',
        },
      },
      runtimeOptions: {
        useStreaming: true,
        maxResponse: 37,
        temperature: 42,
        topP: 0.73,
        topK: 11,
      },
    }
    await seedDatabase(
      providerDatabase({
        profile,
        credential: {
          id: 'credential-ollama-golden',
          name: 'Ollama Golden',
          apiKey: 'golden-ollama-key-91de',
        },
      }),
    )
    const captures = stubProviderFetch({
      expectedHost: 'ollama.golden.test',
      response: () =>
        ndjsonResponse([
          { model: 'golden-ollama-model', message: { role: 'assistant', content: 'Golden Ollama ' }, done: false },
          { model: 'golden-ollama-model', message: { role: 'assistant', content: 'reply.' }, done: false },
          {
            model: 'golden-ollama-model',
            message: { role: 'assistant', content: '' },
            done: true,
            done_reason: 'stop',
          },
        ]),
    })
    const events = await sendChat(assertion, 'Golden Ollama current user turn.')

    expect(captures).toHaveLength(1)
    expectGolden('ollama-chat-ndjson', captures[0])
    expectSuccessfulSend(events)
    expect((await persistedMessages(assertion)).at(-1)).toMatchObject({
      role: 'char',
      data: 'Golden Ollama reply.',
    })
  })

  it('bedrock-converse-sigv4', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const profile: ProviderProfile = {
      id: 'profile-bedrock-golden',
      name: 'Bedrock Golden',
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      providerOptions: {
        credentialId: 'credential-bedrock-golden',
        requestModel: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      },
      runtimeOptions: { useStreaming: false, maxResponse: 37 },
    }
    await seedDatabase(
      providerDatabase({
        profile,
        credential: {
          id: 'credential-bedrock-golden',
          name: 'Bedrock Golden',
          apiKey: 'GOLDENAKID7F3A:golden-bedrock-secret-31be:ap-southeast-2',
        },
      }),
    )
    const captures = stubProviderFetch({
      expectedHost: 'bedrock-runtime.ap-southeast-2.amazonaws.com',
      response: () =>
        jsonResponse({
          content: [{ type: 'text', text: 'Golden Bedrock reply.' }],
          stop_reason: 'end_turn',
        }),
    })
    const events = await sendChat(assertion, 'Golden Bedrock current user turn.')

    expect(captures).toHaveLength(1)
    expectGolden('bedrock-converse-sigv4', captures[0])
    expectSuccessfulSend(events)
    expect((await persistedMessages(assertion)).at(-1)).toMatchObject({
      role: 'char',
      data: 'Golden Bedrock reply.',
    })
  })

  it('profile-ignores-attacker-baseurl', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const profile: ProviderProfile = {
      id: 'profile-openai-golden',
      name: 'OpenAI Golden',
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      providerOptions: {
        credentialId: 'credential-openai-golden',
        requestModel: 'gpt-4o-mini',
        baseUrl: 'https://attacker.test/v1',
      },
      runtimeOptions: { useStreaming: false, maxResponse: 37 },
    }
    await seedDatabase(
      providerDatabase({
        profile,
        credential: {
          id: 'credential-openai-golden',
          name: 'OpenAI Golden',
          apiKey: 'golden-profile-openai-key-4bd2',
        },
        settings: { openAIKey: 'golden-conflicting-flat-openai-key-99aa' },
      }),
    )
    const captures = stubProviderFetch({
      expectedHost: 'api.openai.com',
      response: () =>
        jsonResponse({
          model: 'gpt-4o-mini',
          choices: [{ message: { role: 'assistant', content: 'Golden OpenAI reply.' }, finish_reason: 'stop' }],
        }),
    })
    const events = await sendChat(assertion, 'Golden OpenAI current user turn.')

    expect(captures[0]).toBeDefined()
    expectGolden('profile-ignores-attacker-baseurl', captures[0]!)
    expect(captures).toHaveLength(1)
    expectSuccessfulSend(events)
    expect((await persistedMessages(assertion)).at(-1)).toMatchObject({
      role: 'char',
      data: 'Golden OpenAI reply.',
    })
  })
})
