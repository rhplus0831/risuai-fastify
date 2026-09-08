import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isDiagnosticEventV2,
  isRemoteDiagnosticsResponse,
  type DiagnosticEventV2,
} from '@risuai/protocol/remote-diagnostics'
import { buildApp } from '../src/app.js'
import { getSchemaState, openDatabase } from '../src/db.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import { subscribeProtocolMetrics } from '../src/protocolMetrics.js'
import { applyImport } from '../src/repository.js'
import { normalizeRisuSaveSnapshotDatabase } from '../src/risuSave/importSnapshot.js'
import type { ChatProviderDispatcher } from '../src/routes/generationChat.js'
import type { CompletionStreamFrame } from '../src/generation/frames.js'
import { setupAuthedClient } from './helpers/auth.js'

const content = 'PRIVATE_CHAT_AND_PROMPT_CANARY'
const responseText = 'PRIVATE_PROVIDER_RESPONSE_CANARY'
const failureText = 'PRIVATE_FAILURE_AND_PATH_CANARY'
const token = '7f'.repeat(32)
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function fixtureDatabase() {
  const promptSettings = {
    assistantPrefill: '',
    postEndInnerFormat: '',
    sendChatAsSystem: false,
    sendName: false,
    utilOverride: false,
  }
  return {
    currentChar: 0,
    characters: [
      {
        type: 'character',
        chaId: 'private-character-id',
        name: content,
        utilityBot: false,
        chatPage: 0,
        desc: content,
        firstMessage: '',
        chats: [
          {
            id: 'private-chat-id',
            name: content,
            note: '',
            message: [],
            localLore: [],
            generationSettings: {
              configured: true,
              personaId: 'private-persona-id',
              modelPresetId: 'private-model-preset',
              promptPresetId: 'private-prompt-preset',
              jailbreakToggle: false,
              sidebarToggles: {},
            },
          },
        ],
      },
    ],
    selectedPersona: 0,
    personas: [{ id: 'private-persona-id', name: content, personaPrompt: content, icon: '', note: '' }],
    modelPresetsId: 0,
    promptPresetsId: 0,
    botPresets: [],
    modelPresets: [{ id: 'private-model-preset', name: content, maxContext: 100_000, maxResponse: 50 }],
    promptPresets: [
      {
        id: 'private-prompt-preset',
        name: content,
        mainPrompt: content,
        formatingOrder: ['main', 'description', 'chats'],
        promptSettings,
        customPromptTemplateToggle: '',
      },
    ],
    modules: [],
    enabledModules: [],
    formatingOrder: ['main', 'description', 'chats'],
    promptSettings,
    mainPrompt: content,
    maxContext: 100_000,
    maxResponse: 50,
  }
}

async function harness(dispatchProvider: ChatProviderDispatcher) {
  vi.stubEnv('LOG_LEVEL', 'silent')
  const root = mkdtempSync(path.join(tmpdir(), 'risu-diagnostic-generation-'))
  const dataDir = path.join(root, 'data')
  const privateDir = path.join(root, 'private')
  mkdirSync(privateDir, { mode: 0o700 })
  const verifierFile = path.join(privateDir, 'verifier.json')
  writeFileSync(
    verifierFile,
    JSON.stringify({
      version: 1,
      credentials: [
        {
          id: 'a7'.repeat(16),
          digest: createHash('sha256').update(token).digest('hex'),
          createdAt: Date.now() - 1000,
          expiresAt: Date.now() + 86_400_000,
          revokedAt: null,
        },
      ],
    }),
    { mode: 0o600 },
  )
  const db = openDatabase(dataDir)
  await applyImport(db, dataDir, normalizeRisuSaveSnapshotDatabase(fixtureDatabase()))
  const start = (retry = false) =>
    buildApp({
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir,
        bodyLimit: 1024 * 1024,
        importMaxBytes: Infinity,
        trustProxy: false,
        hubUrl: 'https://sv.risuai.xyz',
        staticRoot: null,
        clientDiagnostics: true,
        supportDiagnostics: { enabled: true, verifierFile },
      },
      generationChat: {
        dispatchProvider,
        finalizationRetry: retry ? { intervalMs: 60_000, baseDelayMs: 1, maxDelayMs: 1 } : false,
      },
      memoryWorker: false,
      bardWikiWorker: false,
      assetGc: false,
    })
  let current = await start()
  await current.diagnostics.ready
  const { assertion } = await setupAuthedClient(current.app)
  cleanup.push(async () => {
    await current.app.close()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    db,
    dataDir,
    async generate() {
      const response = await current.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: { 'risu-auth': assertion },
        payload: {
          chatId: 'private-chat-id',
          characterId: 'private-character-id',
          mode: 'send',
          userMessage: content,
          durable: true,
        },
      })
      await current.generationJobs.settleRunners()
      expect(response.statusCode, response.body).toBe(200)
      return response
    },
    async generateOperation(expectedStatus = 201) {
      const writerHeaders = { 'risu-auth': assertion, 'risu-writer-session': 'diagnostic-test-writer' }
      const bootstrap = await current.app.inject({ url: '/api/v1/bootstrap', headers: writerHeaders })
      expect(bootstrap.statusCode, bootstrap.body).toBe(200)
      const acceptedMessageId = randomUUID()
      const response = await current.app.inject({
        method: 'POST',
        url: '/api/v1/generation-operations',
        headers: { ...writerHeaders, 'risu-database-lineage': getDatabaseLineage(db) },
        payload: {
          protocolVersion: 1,
          operationId: randomUUID(),
          baseRevision: getSchemaState(db).revision,
          characterId: 'private-character-id',
          chatId: 'private-chat-id',
          mode: 'send',
          acceptedMessageId,
          message: { role: 'user', data: content, chatId: acceptedMessageId },
          draftGeneration: 1,
          generation: {
            syntheticSayNothing: false,
            resetMessages: false,
            inlayAssetRefs: [],
            clientContext: {},
            clientCapabilities: {},
          },
        },
      })
      expect(response.statusCode, response.body).toBe(expectedStatus)
      await current.generationJobs.settleRunners()
      return response
    },
    async read() {
      await vi.waitFor(() => expect(current.diagnostics.journal?.read().pending).toBe(0))
      const response = await current.app.inject({
        url: '/api/v1/support/diagnostics?version=2&limit=200',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.statusCode, response.body).toBe(200)
      const body: unknown = response.json()
      expect(isRemoteDiagnosticsResponse(body)).toBe(true)
      if (!isRemoteDiagnosticsResponse(body) || body.version !== 2) throw new Error('expected v2 diagnostic response')
      for (const record of body.entries) expect(isDiagnosticEventV2(record.entry)).toBe(true)
      for (const canary of [
        content,
        responseText,
        failureText,
        token,
        'private-character-id',
        'private-chat-id',
        'private-persona-id',
        'private-model-preset',
        'private-prompt-preset',
      ]) {
        expect(response.body).not.toContain(canary)
      }
      expect(response.body).not.toMatch(/promptHash|sha256|bodySidecar|fullPromptSidecar/)
      return body.entries.map((record) => record.entry)
    },
    async restart() {
      await current.app.close()
      current = await start(true)
      await current.diagnostics.ready
    },
  }
}

function completeProvider(): AsyncGenerator<CompletionStreamFrame> {
  return (async function* () {
    yield { kind: 'token', content: responseText }
    yield { kind: 'done', finishReason: 'stop' }
  })()
}

describe('safe generation evidence', () => {
  it('identifies an admission rejection as occurring before provider dispatch', async () => {
    vi.stubEnv('RISU_PROTOCOL_METRICS', '0')
    const dispatch = vi.fn(completeProvider)
    const h = await harness(dispatch)
    const row = h.db.prepare('SELECT data_json FROM chats WHERE id = ?').get('private-chat-id') as { data_json: string }
    const chat = JSON.parse(row.data_json)
    chat.generationSettings.configured = false
    h.db.prepare('UPDATE chats SET data_json = ? WHERE id = ?').run(JSON.stringify(chat), 'private-chat-id')
    await h.generateOperation(409)
    expect(dispatch).not.toHaveBeenCalled()
    const evidence = await h.read()
    expect(evidence.find((entry) => entry.category === 'generation' && entry.outcome === 'rejected')).toMatchObject({
      stage: 'accepted',
      providerMayHaveRun: false,
      correlation: 'request',
    })
  })

  it('retains the durable operation request UID and measures assembly with raw metrics disabled', async () => {
    vi.stubEnv('RISU_PROTOCOL_METRICS', '0')
    const h = await harness(completeProvider)
    const metrics: Array<{ requestUid: unknown; durationMs: unknown }> = []
    const unsubscribe = subscribeProtocolMetrics(
      (metric) => {
        if (metric.metric === 'generation_prompt_assembly')
          metrics.push({ requestUid: metric.requestUid, durationMs: metric.durationMs })
      },
      { namesWhenDisabled: ['generation_prompt_assembly'] },
    )
    try {
      const startedAt = performance.now()
      const response = await h.generateOperation()
      const elapsedMs = performance.now() - startedAt
      expect(metrics).toHaveLength(1)
      expect(response.headers['x-request-uid']).toMatch(/^[a-f0-9]{64}$/)
      expect(metrics[0].requestUid).toBe(response.headers['x-request-uid'])
      expect(metrics[0].durationMs).toBeGreaterThanOrEqual(0)
      expect(metrics[0].durationMs).toBeLessThanOrEqual(elapsedMs + 10)
      const evidence = await h.read()
      expect(evidence.find((entry) => entry.category === 'generation' && entry.stage === 'complete')).toMatchObject({
        outcome: 'completed',
        providerMayHaveRun: true,
        requestUid: response.headers['x-request-uid'],
        operationRef: expect.stringMatching(/^[a-f0-9]{32}$/),
      })
    } finally {
      unsubscribe()
    }
  })

  it.each(['0', '1'])('diagnoses a real failed commit and restart recovery with raw metrics=%s', async (rawMetrics) => {
    vi.stubEnv('RISU_PROTOCOL_METRICS', rawMetrics)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const h = await harness(completeProvider)
    h.db.exec(`CREATE TRIGGER fail_diagnostic_generation_commit BEFORE INSERT ON messages
      WHEN NEW.role = 'char' BEGIN SELECT RAISE(FAIL, '${failureText}'); END`)
    await h.generate()
    const failed = await h.read()
    const persistence = failed.find((entry) => entry.category === 'persistence' && entry.disposition === 'retryable')
    expect(persistence).toMatchObject({
      phase: 'authoritative_commit',
      journalConfirmed: true,
      authoritativeCommitted: false,
      cleanupComplete: false,
      correlation: 'operation',
      operationRef: expect.stringMatching(/^[a-f0-9]{32}$/),
      requestUid: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(failed.find((entry) => entry.category === 'prompt')).toMatchObject({
      outcome: 'ok',
      truncation: 'none',
      rows: expect.any(Number),
      inputTokens: expect.any(Number),
      budgetTokens: 100_000,
      roles: { system: expect.any(Number), user: expect.any(Number), assistant: expect.any(Number), tool: 0, other: 0 },
      media: { image: 0, audio: 0, video: 0, other: 0 },
    })
    const beforeRecovery = getSchemaState(h.db).revision
    h.db.exec('DROP TRIGGER fail_diagnostic_generation_commit')
    await h.restart()
    const recovered = await h.read()
    expect(
      recovered.find((entry) => entry.category === 'persistence' && entry.disposition === 'recovered'),
    ).toMatchObject({
      authoritativeCommitted: true,
      cleanupComplete: true,
      operationRef: persistence?.operationRef,
    })
    expect(
      recovered.some(
        (entry) =>
          entry.category === 'persistence' &&
          entry.queueDepth === 1 &&
          entry.queueAgeMs !== undefined &&
          entry.retryCount === 1,
      ),
    ).toBe(true)
    expect(getSchemaState(h.db).revision).toBe(beforeRecovery + 1)
    const rows = h.db.prepare("SELECT json FROM messages WHERE role = 'char'").all() as { json: string }[]
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].json).data).toBe(responseText)
    const afterRecovery = getSchemaState(h.db).revision
    await h.read()
    expect(getSchemaState(h.db).revision).toBe(afterRecovery)
    if (rawMetrics === '0') expect(existsSync(path.join(h.dataDir, 'trace'))).toBe(false)
  })

  it.each(['generate', 'generateOperation'] as const)(
    'retains the original operation when a failed partial from %s is recovered after restart',
    async (submit) => {
      vi.stubEnv('RISU_PROTOCOL_METRICS', '0')
      const dispatch = vi.fn(() =>
        (async function* (): AsyncGenerator<CompletionStreamFrame> {
          yield { kind: 'token', content: responseText }
          throw new Error(failureText)
        })(),
      )
      const h = await harness(dispatch)
      h.db.exec(`CREATE TRIGGER fail_partial_commit BEFORE INSERT ON messages
        WHEN NEW.role = 'char' BEGIN SELECT RAISE(FAIL, '${failureText}'); END`)
      await h[submit]()
      const failed = await h.read()
      const persistence = failed.find((entry) => entry.category === 'persistence' && entry.disposition === 'retryable')
      expect(persistence?.operationRef).toMatch(/^[a-f0-9]{32}$/)
      const readOperationState = () =>
        (h.db.prepare('SELECT state FROM generation_operations').get() as { state: string }).state
      const operationState = readOperationState()
      expect(operationState).toBe('retryable')
      h.db.exec('DROP TRIGGER fail_partial_commit')
      await h.restart()
      const recovered = await h.read()
      expect(
        recovered.find((entry) => entry.category === 'persistence' && entry.disposition === 'recovered'),
      ).toMatchObject({
        operationRef: persistence?.operationRef,
        attemptRef: persistence?.attemptRef,
        authoritativeCommitted: true,
        cleanupComplete: true,
      })
      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(readOperationState()).toBe(operationState)
    },
  )

  it('distinguishes assembly before dispatch from an ambiguous provider failure after partial output', async () => {
    vi.stubEnv('RISU_PROTOCOL_METRICS', '0')
    const h = await harness(() =>
      (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: responseText }
        throw new DOMException(failureText, 'TimeoutError')
      })(),
    )
    await h.generate()
    const entries = await h.read()
    const generation = entries.filter(
      (entry): entry is Extract<DiagnosticEventV2, { category: 'generation' }> => entry.category === 'generation',
    )
    expect(generation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'assembly', providerMayHaveRun: false }),
        expect.objectContaining({ stage: 'dispatch', providerMayHaveRun: true }),
        expect.objectContaining({ stage: 'complete', outcome: 'ambiguous', providerMayHaveRun: true }),
      ]),
    )
    expect(new Set(generation.map((entry) => entry.operationRef)).size).toBe(1)
    expect(entries.some((entry) => entry.category === 'persistence' && entry.authoritativeCommitted === true)).toBe(
      true,
    )
  })
})
