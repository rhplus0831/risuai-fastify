/** @module-tag core */
import { IDBFactory } from 'fake-indexeddb'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../../../server/fastify/src/app'
import type { CompletionStreamFrame } from '../../../../server/fastify/src/generation/frames'
import type { ChatProviderDispatcher } from '../../../../server/fastify/src/routes/generationChat'
import type { StreamJob } from '../../../../server/fastify/src/streamJobs'
import {
  authorizeClientWriterRecovery,
  beginClientSession,
  completeClientWriterRecovery,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
} from '../../clientSession'
import { installConnectedWriterSessionId, resetWriterAccessLostForTests } from '../../server/activeWriterSession'
import { clearCachedServerCommandRevision, setCachedServerCommandRevision } from '../../server/commands'
import { requestServerChatGeneration } from '../request/serverChat'

const CHARACTER_ID = 'stream-gap-character'
const CHAT_ID = 'stream-gap-chat'
const WRITER_ID = 'stream-gap-writer'
const PERSONA_ID = 'stream-gap-persona'
const MODEL_PRESET_ID = 'stream-gap-model'
const PROMPT_PRESET_ID = 'stream-gap-prompt'
const USER_SENTINEL = 'STREAM_GAP_USER_SENTINEL'
const CHUNK_COUNT = 50
const CHUNK_BYTES = 200

interface Harness {
  app: FastifyInstance
  baseUrl: string
  dataDir: string
  latestJob: StreamJob | null
  releaseBulk: () => void
  bulkDelivered: Promise<void>
  releaseTerminal: () => void
  terminalText: string
}

let harness: Harness
let originalFetch: typeof globalThis.fetch

beforeEach(async () => {
  process.env.LOG_LEVEL = 'silent'
  process.env.RISU_WEB_PUSH_VAPID_PUBLIC_KEY = 'boundary-disabled'
  delete process.env.RISU_WEB_PUSH_VAPID_PRIVATE_KEY
  originalFetch = globalThis.fetch
  vi.stubGlobal('indexedDB', new IDBFactory())
  resetClientSessionForTests()
  resetWriterAccessLostForTests()
  clearCachedServerCommandRevision()
  harness = await startHarness()
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(harness.baseUrl)
  globalThis.fetch = routeFetchThroughHarness as typeof globalThis.fetch
  await seedHarness()
  await authorizeClientAgainstHarness()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  resetClientSessionForTests()
  resetWriterAccessLostForTests()
  clearCachedServerCommandRevision()
  harness.app.server.closeAllConnections()
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('durable stream replay gap boundary', () => {
  it('replaces a truncated replay suffix with the terminal snapshot and persists that exact text', async () => {
    const generation = await requestServerChatGeneration(
      {
        chatId: CHAT_ID,
        characterId: CHARACTER_ID,
        mode: 'send',
        userMessage: USER_SENTINEL,
        durable: true,
      },
      null,
    )
    expect(generation.status).toBe('ok')
    if (generation.status !== 'ok') {
      const detail = generation.status === 'error' ? generation.error : generation.status
      throw new Error(`Generation did not start: ${detail}`)
    }

    const reader = generation.req.result.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(Object.values(first.value ?? {})).toEqual([chunkText(0)])

    harness.releaseBulk()
    await harness.bulkDelivered
    expect(harness.latestJob?.replayTruncated).toBe(true)
    expect(harness.latestJob?.clients.size).toBeGreaterThanOrEqual(1)

    for (const client of [...(harness.latestJob?.clients ?? [])]) client.close()
    harness.releaseTerminal()

    const projected: string[] = [Object.values(first.value ?? {})[0] ?? '']
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      projected.push(Object.values(chunk.value)[0] ?? '')
    }
    const terminal = await generation.terminal

    expect(generation.req.replayGapTruncated).toBe(true)
    expect(terminal.status).toBe('done')
    expect(projected.at(-1)).toBe(harness.terminalText)
    expect(projected.at(-1)).not.toBe(`${chunkText(CHUNK_COUNT - 1)}${harness.terminalText}`)

    const persisted = await fetch(`/api/v1/chats/${CHAT_ID}/messages`, {
      headers: { 'risu-auth': 'boundary-auth' },
    })
    expect(persisted.status).toBe(200)
    const body = (await persisted.json()) as { message: Array<{ role: string; data: string }> }
    expect(body.message.map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'char', data: harness.terminalText },
    ])
  })
})

async function startHarness(): Promise<Harness> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-stream-gap-boundary-'))
  let latestJob: StreamJob | null = null
  let releaseBulk = () => undefined
  let releaseTerminal = () => undefined
  let resolveBulkDelivered = () => undefined
  const bulkGate = new Promise<void>((resolve) => {
    releaseBulk = resolve
  })
  const terminalGate = new Promise<void>((resolve) => {
    releaseTerminal = resolve
  })
  const bulkDelivered = new Promise<void>((resolve) => {
    resolveBulkDelivered = resolve
  })
  const chunks = Array.from({ length: CHUNK_COUNT }, (_, index) => chunkText(index))
  const terminalText = chunks.join('')
  const dispatchProvider: ChatProviderDispatcher = () => {
    async function* frames(): AsyncGenerator<CompletionStreamFrame> {
      yield { kind: 'token', content: chunks[0]! }
      await bulkGate
      for (const chunk of chunks.slice(1)) yield { kind: 'token', content: chunk }
      resolveBulkDelivered()
      await terminalGate
      yield { kind: 'done', finishReason: 'stop' }
    }
    return frames()
  }
  const built = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Number.POSITIVE_INFINITY,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      agentDevAuthBypass: true,
    },
    assetGc: false,
    bardWikiWorker: false,
    memoryWorker: false,
    generationChat: {
      dispatchProvider,
      finalizationRetry: false,
      viewerHeartbeatMs: 50,
      onDurableLifecycleTransition(transition, job) {
        if (transition === 'registered') latestJob = job
      },
    },
  })
  ;(built.generationJobs.registry as unknown as { replayMaxBytes: number }).replayMaxBytes = 4_096
  await built.app.listen({ host: '127.0.0.1', port: 0 })
  const address = built.app.server.address() as AddressInfo
  return {
    app: built.app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    get latestJob() {
      return latestJob
    },
    releaseBulk,
    bulkDelivered,
    releaseTerminal,
    terminalText,
  }
}

async function seedHarness(): Promise<void> {
  const imported = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': 'boundary-auth' },
    payload: { database: fixtureDatabase() },
  })
  expect(imported.statusCode).toBe(200)
  const configured = await harness.app.inject({
    method: 'PUT',
    url: `/api/v1/commands/chats/${CHAT_ID}/generation-settings`,
    headers: { 'risu-auth': 'boundary-auth' },
    payload: {
      baseRevision: imported.json<{ revision: number }>().revision,
      generationSettings: generationSettings(),
    },
  })
  expect(configured.statusCode).toBe(200)
  setCachedServerCommandRevision(configured.json<{ revision: number }>().revision)
}

async function authorizeClientAgainstHarness(): Promise<void> {
  installConnectedWriterSessionId(WRITER_ID)
  const bootstrap = await harness.app.inject({
    method: 'GET',
    url: '/api/v1/bootstrap',
    headers: { 'risu-auth': 'boundary-auth', 'risu-writer-session': WRITER_ID },
  })
  expect(bootstrap.statusCode).toBe(200)
  const runtime = bootstrap.json<{
    databaseLineage: string
    writer: { sessionId: string; epoch: number }
  }>()
  const operation = beginClientSession(WRITER_ID)
  expect(
    authorizeClientWriterRecovery(operation, {
      databaseLineage: runtime.databaseLineage,
      writer: runtime.writer,
    }),
  ).toBe(true)
  setClientProjectionReady(true, operation.generation)
  setClientConnectionState('live', operation.generation)
  expect(completeClientWriterRecovery(operation)).toBe(true)
}

async function routeFetchThroughHarness(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (/^https?:/u.test(rawUrl)) {
    if (!rawUrl.startsWith(harness.baseUrl)) throw new Error(`Unexpected outbound fetch: ${rawUrl}`)
    return originalFetch(input, init)
  }
  return originalFetch(`${harness.baseUrl}${rawUrl}`, init)
}

function chunkText(index: number): string {
  return `[STREAM_GAP_${index.toString().padStart(2, '0')}]${'x'.repeat(CHUNK_BYTES)}`
}

function generationSettings(): Record<string, unknown> {
  return {
    configured: true,
    personaId: PERSONA_ID,
    modelPresetId: MODEL_PRESET_ID,
    promptPresetId: PROMPT_PRESET_ID,
    jailbreakToggle: false,
    sidebarToggles: {},
  }
}

function fixtureDatabase(): Record<string, unknown> {
  return {
    currentChar: 0,
    characters: [
      {
        type: 'character',
        name: 'Stream Gap Character',
        chaId: CHARACTER_ID,
        utilityBot: false,
        chatPage: 0,
        desc: 'Boundary fixture',
        firstMessage: '',
        chats: [
          {
            id: CHAT_ID,
            message: [],
            note: '',
            name: 'Stream Gap Chat',
            localLore: [],
            generationSettings: generationSettings(),
          },
        ],
      },
    ],
    selectedPersona: 0,
    personas: [{ id: PERSONA_ID, name: 'Boundary User', personaPrompt: '', icon: '', note: '' }],
    modelPresetsId: 0,
    promptPresetsId: 0,
    botPresets: [],
    modelPresets: [{ id: MODEL_PRESET_ID, name: 'Boundary Model', maxContext: 100_000, maxResponse: 20_000 }],
    promptPresets: [
      {
        id: PROMPT_PRESET_ID,
        name: 'Boundary Prompt',
        mainPrompt: 'MAIN',
        formatingOrder: ['main', 'description', 'chats'],
        promptSettings: {
          assistantPrefill: '',
          postEndInnerFormat: '',
          sendChatAsSystem: false,
          sendName: false,
          utilOverride: false,
        },
        customPromptTemplateToggle: '',
      },
    ],
    modules: [],
    enabledModules: [],
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
    maxResponse: 20_000,
  }
}
