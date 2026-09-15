import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { openDatabase } from '../src/db.js'
import type { CompletionStreamFrame } from '../src/generation/frames.js'
import { createSummarizeMemoryJobHandler } from '../src/memorySummarizeJobHandler.js'
import { getMemoryJob, listMemoryJobs } from '../src/memoryRepository.js'
import { MemoryWorker } from '../src/memoryWorker.js'
import type { ChatProviderDispatcher } from '../src/routes/generationChat.js'
import {
  runServerMessageTranslation,
  type RunServerMessageTranslationInput,
} from '../src/translation/serverMessageTranslation.js'
import { setupAuthedClient } from './helpers/auth.js'
import { installHistoricalGenerationV39Schema } from './support/historicalGenerationV39.js'
import { hasPreOccupancyGeneratedTranslationAuthority } from '../src/generationOperations.js'

const PERSONA_ID = 'legacy-persona'
const MODEL_PRESET_ID = 'legacy-model-preset'
const PROMPT_PRESET_ID = 'legacy-prompt-preset'
const promptSettings = {
  assistantPrefill: '',
  postEndInnerFormat: '',
  sendChatAsSystem: false,
  sendName: false,
  utilOverride: false,
}

function fixtureDatabase(acceptedMessageId: string, autoTranslate = false) {
  return {
    currentChar: 0,
    characters: [
      {
        type: 'character',
        name: 'Historical character',
        chaId: 'char-1',
        supaMemory: true,
        chatPage: 0,
        desc: 'Description',
        firstMessage: 'Hello',
        chats: [
          {
            id: 'chat-1',
            name: 'Historical chat',
            note: '',
            localLore: [],
            autoTranslate,
            translatorPresetId: 'historical-translator-preset',
            message: [{ role: 'user', data: 'old accepted input', chatId: acceptedMessageId }],
            generationSettings: {
              configured: true,
              personaId: PERSONA_ID,
              modelPresetId: MODEL_PRESET_ID,
              promptPresetId: PROMPT_PRESET_ID,
              jailbreakToggle: false,
              sidebarToggles: {},
            },
          },
        ],
      },
    ],
    selectedPersona: 0,
    personas: [{ id: PERSONA_ID, name: 'User', personaPrompt: '', icon: '', note: '' }],
    modelPresetsId: 0,
    promptPresetsId: 0,
    botPresets: [],
    modelPresets: [{ id: MODEL_PRESET_ID, name: 'Model', maxContext: 100_000, maxResponse: 50 }],
    promptPresets: [
      {
        id: PROMPT_PRESET_ID,
        name: 'Prompt',
        mainPrompt: 'MAIN',
        formatingOrder: ['main', 'description', 'chats'],
        promptSettings,
        customPromptTemplateToggle: '',
      },
    ],
    modules: [],
    enabledModules: [],
    formatingOrder: ['main', 'description', 'chats'],
    promptSettings,
    mainPrompt: 'MAIN',
    maxContext: 100_000,
    maxResponse: 50,
    hypaV3: true,
    hypaModel: 'MiniLM',
    selectedHypaV3PresetId: 'historical-memory',
    hypaV3PresetId: 0,
    hypaV3Presets: [
      {
        id: 'historical-memory',
        name: 'Historical memory',
        settings: {
          summarizationModel: 'memory',
          summarizationPrompt: 'Summarize historical memory: {{slot}}',
          memoryTokensRatio: 0.2,
          recentMemoryRatio: 1,
          similarMemoryRatio: 0,
          queryChatCount: 1,
          maxChatsPerSummary: 20,
        },
      },
    ],
    translator: 'ko',
    translatorInputLanguage: 'en',
    translatorType: 'llm',
    translatorSendTextAsIs: true,
    translatorPresetId: 'historical-translator-preset',
    translatorPrompt: 'Translate {{slot::content}}',
    translatorMaxResponse: 111,
    translatorPresets: [
      {
        id: 'historical-translator-preset',
        name: 'Historical translator',
        prompt: 'Translate {{slot::content}}',
        maxResponse: 111,
      },
    ],
    providerCredentials: [
      {
        id: 'historical-memory-credential',
        name: 'Historical memory credential',
        type: 'apiKey',
        apiKey: 'historical-memory-key',
      },
    ],
    modelProfiles: [
      {
        id: 'historical-translation-profile',
        name: 'Historical translation provider',
        providerId: 'debug-echo',
        modelId: 'debug-echo',
        providerOptions: {
          baseUrl: 'debug://historical-translation',
          requestModel: 'historical-translation-model',
        },
      },
      {
        id: 'historical-memory-profile',
        name: 'Historical memory provider',
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        providerOptions: {
          credentialId: 'historical-memory-credential',
          requestModel: 'gpt-4o-mini',
        },
      },
    ],
    modelRoleProfiles: {
      translate: { mode: 'profile', profileId: 'historical-translation-profile' },
      memory: { mode: 'profile', profileId: 'historical-memory-profile' },
    },
  }
}

interface Authority {
  databaseLineage: string
  revision: number
}

let app: FastifyInstance
let dataDir: string
let assertion: string
let dispatchProvider: ChatProviderDispatcher
let runMessageTranslation:
  | ((input: RunServerMessageTranslationInput) => ReturnType<typeof runServerMessageTranslation>)
  | undefined

async function startApp(): Promise<void> {
  const built = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    chatOccupancy: { enabled: false },
    generationChat: {
      dispatchProvider: (context) => dispatchProvider(context),
      ...(runMessageTranslation ? { runMessageTranslation } : {}),
      finalizationRetry: { intervalMs: 10, baseDelayMs: 1, maxDelayMs: 10 },
    },
    memoryWorker: false,
  })
  app = built.app
}

async function seedHistoricalChat(acceptedMessageId: string, autoTranslate = false): Promise<Authority> {
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion },
    payload: { database: fixtureDatabase(acceptedMessageId, autoTranslate) },
  })
  expect(imported.statusCode).toBe(200)
  const configured = await app.inject({
    method: 'PUT',
    url: '/api/v1/commands/chats/chat-1/generation-settings',
    headers: { 'risu-auth': assertion },
    payload: {
      baseRevision: imported.json<{ revision: number }>().revision,
      generationSettings: {
        configured: true,
        personaId: PERSONA_ID,
        modelPresetId: MODEL_PRESET_ID,
        promptPresetId: PROMPT_PRESET_ID,
        jailbreakToggle: false,
        sidebarToggles: {},
      },
    },
  })
  expect(configured.statusCode).toBe(200)
  const bootstrap = await app.inject({
    method: 'GET',
    url: '/api/v1/bootstrap',
    headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
  })
  expect(bootstrap.statusCode).toBe(200)
  return bootstrap.json<Authority>()
}

function operationIntent(acceptedMessageId: string) {
  return {
    protocolVersion: 1,
    characterId: 'char-1',
    chatId: 'chat-1',
    mode: 'send',
    acceptedMessageId,
    message: { role: 'user', data: 'old accepted input', chatId: acceptedMessageId },
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

function insertHistoricalOperation(args: {
  db: DatabaseSync
  authority: Authority
  operationId: string
  acceptedMessageId: string
  state: 'accepted' | 'finalizing'
  jobId?: string
}): void {
  const writer = args.db.prepare('SELECT writer_epoch AS epoch FROM database_metadata WHERE id = 1').get() as {
    epoch: number
  }
  const now = '2026-09-01T00:00:00.000Z'
  args.db
    .prepare(
      `INSERT INTO generation_operations (
         database_lineage, operation_id, protocol_version, request_origin,
         creator_writer_session_id, creator_writer_epoch, binding_server_instance_id,
         character_id, chat_id, mode, accepted_message_id, client_draft_generation_json,
         request_fingerprint, intent_json, accepted_revision,
         state, state_version, projection_epoch, current_attempt_no,
         desired_terminal_outcome, provider_may_have_run, created_at, updated_at
       ) VALUES (?, ?, 1, 'accepted_send', 'writer-a', ?, 'historical-server',
                 'char-1', 'chat-1', 'send', ?, '1',
                 'historical-fingerprint', ?, ?,
                 ?, 1, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.authority.databaseLineage,
      args.operationId,
      writer.epoch,
      args.acceptedMessageId,
      JSON.stringify(operationIntent(args.acceptedMessageId)),
      args.authority.revision,
      args.state,
      args.state === 'finalizing' ? 1 : null,
      args.state === 'finalizing' ? 'completed' : null,
      args.state === 'finalizing' ? 1 : 0,
      now,
      now,
    )
  args.db.prepare('UPDATE generation_operation_projection_state SET epoch = 1 WHERE id = 1').run()
  if (args.state === 'finalizing') {
    if (!args.jobId) {
      throw new Error('Historical finalizing operations require a job id')
    }
    args.db
      .prepare(
        `INSERT INTO generation_operation_attempts (
           database_lineage, operation_id, attempt_no, retry_request_id, job_id,
           server_instance_id, actor_writer_session_id, actor_writer_epoch,
           status, launch_revision, provider_dispatch_started_at,
           provider_dispatch_finished_at, finalization_generation_id,
           created_at, updated_at
         ) VALUES (?, ?, 1, ?, ?, 'historical-server', 'writer-a', ?,
                   'finalizing', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.authority.databaseLineage,
        args.operationId,
        args.operationId,
        args.jobId,
        writer.epoch,
        args.authority.revision,
        now,
        now,
        args.jobId,
        now,
        now,
      )
  }
}

async function operationStatus(operationId: string) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/generation-operations/${operationId}`,
    headers: { 'risu-auth': assertion },
  })
  expect(response.statusCode).toBe(200)
  return response.json<{
    operation: {
      state: string
      stateVersion: number
      resultMessageId?: string
      currentAttempt?: { attemptNo: number; jobId: string }
    }
  }>().operation
}

async function waitForCompleted(operationId: string): Promise<void> {
  const startedAt = Date.now()
  let lastState = 'unknown'
  for (;;) {
    lastState = (await operationStatus(operationId)).state
    if (lastState === 'completed') return
    if (Date.now() - startedAt > 5_000) {
      const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
      const journal = db.prepare('SELECT status, failure_count, last_error FROM generation_finalization_retries').all()
      db.close()
      throw new Error(`legacy operation completion timed out in ${lastState}: ${JSON.stringify(journal)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitForOperationState(operationId: string, expectedState: string): Promise<void> {
  const startedAt = Date.now()
  let lastState = 'unknown'
  for (;;) {
    lastState = (await operationStatus(operationId)).state
    if (lastState === expectedState) return
    if (Date.now() - startedAt > 5_000) {
      throw new Error(`legacy operation state timed out in ${lastState}, expected ${expectedState}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitForGeneratedTranslation(generationId: string): Promise<void> {
  const startedAt = Date.now()
  for (;;) {
    const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
    const effect = db
      .prepare(
        `SELECT status, last_error AS lastError
         FROM generation_effects
         WHERE generation_id = ? AND effect_kind = 'generated_translation'`,
      )
      .get(generationId) as { status: string; lastError: string | null } | undefined
    db.close()
    if (effect?.status === 'completed') return
    if (effect?.status === 'failed') throw new Error(`historical translation failed: ${effect.lastError}`)
    if (Date.now() - startedAt > 5_000) {
      throw new Error(`historical translation timed out in ${effect?.status ?? 'missing'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function abortableGatedProvider(text: string): ChatProviderDispatcher {
  return ({ signal }) =>
    (async function* (): AsyncGenerator<CompletionStreamFrame> {
      yield { kind: 'token', content: text }
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'))
          return
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })()
}

async function launchMigratedHistoricalRetry(): Promise<{
  authority: Authority
  operationId: string
  jobId: string
}> {
  const acceptedMessageId = randomUUID()
  const operationId = randomUUID()
  const authority = await seedHistoricalChat(acceptedMessageId)
  await app.close()

  const historical = new DatabaseSync(path.join(dataDir, 'risu.db'))
  installHistoricalGenerationV39Schema(historical)
  insertHistoricalOperation({
    db: historical,
    authority,
    operationId,
    acceptedMessageId,
    state: 'accepted',
  })
  historical.close()

  dispatchProvider = abortableGatedProvider('historical cancellation partial')
  await startApp()
  const abandoned = await operationStatus(operationId)
  expect(abandoned.state).toBe('abandoned')
  const retry = await app.inject({
    method: 'POST',
    url: `/api/v1/generation-operations/${operationId}/retries`,
    headers: {
      'risu-auth': assertion,
      'risu-database-lineage': authority.databaseLineage,
      'risu-writer-session': 'writer-a',
    },
    payload: { retryRequestId: randomUUID(), expectedStateVersion: abandoned.stateVersion },
  })
  expect(retry.statusCode).toBe(202)
  await waitForOperationState(operationId, 'owned_by_job')
  const running = await operationStatus(operationId)
  expect(running.currentAttempt).toMatchObject({ attemptNo: 1, jobId: expect.any(String) })

  const migrated = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  expect(
    migrated
      .prepare(
        `SELECT pre_occupancy_authority AS preOccupancyAuthority,
                admission_kind AS admissionKind
         FROM generation_operations WHERE operation_id = ?`,
      )
      .get(operationId),
  ).toEqual({ preOccupancyAuthority: 1, admissionKind: null })
  migrated.close()

  return { authority, operationId, jobId: running.currentAttempt!.jobId }
}

async function takeOverGeneralWriter(sessionId: string): Promise<void> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/bootstrap',
    headers: { 'risu-auth': assertion, 'risu-writer-session': sessionId },
  })
  expect(response.statusCode).toBe(200)
}

beforeEach(async () => {
  process.env.LOG_LEVEL = 'silent'
  dataDir = mkdtempSync(path.join(tmpdir(), 'risu-legacy-generation-migration-'))
  dispatchProvider = () =>
    (async function* (): AsyncGenerator<CompletionStreamFrame> {
      yield { kind: 'done', finishReason: 'stop' }
    })()
  runMessageTranslation = undefined
  await startApp()
  ;({ assertion } = await setupAuthedClient(app))
})

afterEach(async () => {
  await app.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('legacy generation migration finalization', () => {
  it('requires low-level Stop request identity and lets the current owner cancel a migrated v39 retry', async () => {
    const { operationId, jobId } = await launchMigratedHistoricalRetry()
    await takeOverGeneralWriter('writer-b')

    const omittedStop = await app.inject({
      method: 'DELETE',
      url: `/api/v1/generate/chat/${jobId}`,
      headers: { 'risu-auth': assertion },
    })
    expect(omittedStop.statusCode).toBe(400)
    expect(omittedStop.json()).toEqual({ error: 'risu-writer-session header is required' })
    expect((await operationStatus(operationId)).state).toBe('owned_by_job')

    const foreignStop = await app.inject({
      method: 'DELETE',
      url: `/api/v1/generate/chat/${jobId}`,
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'reader-foreign' },
    })
    expect(foreignStop.statusCode).toBe(423)
    expect(foreignStop.json()).toEqual({ error: 'generation_operation_foreign_session' })
    expect((await operationStatus(operationId)).state).toBe('owned_by_job')

    const ownerStop = await app.inject({
      method: 'DELETE',
      url: `/api/v1/generate/chat/${jobId}`,
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-b' },
    })
    expect(ownerStop.statusCode).toBe(202)
    expect(ownerStop.json()).toMatchObject({
      disposition: 'cancelling',
      jobId,
      operation: { state: 'stopping' },
    })
    await waitForOperationState(operationId, 'cancelled')
  })

  it('lets the historical origin use low-level Stop after a migrated v39 retry owner handoff', async () => {
    const { operationId, jobId } = await launchMigratedHistoricalRetry()
    await takeOverGeneralWriter('writer-b')

    const originatingStop = await app.inject({
      method: 'DELETE',
      url: `/api/v1/generate/chat/${jobId}`,
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
    })
    expect(originatingStop.statusCode).toBe(202)
    expect(originatingStop.json()).toMatchObject({
      disposition: 'cancelling',
      jobId,
      operation: { state: 'stopping' },
    })
    await waitForOperationState(operationId, 'cancelled')
  })

  it('rejects an unrelated reader from operation Stop while allowing the historical origin after owner handoff', async () => {
    const { authority, operationId } = await launchMigratedHistoricalRetry()
    await takeOverGeneralWriter('writer-b')

    const foreignStop = await app.inject({
      method: 'PUT',
      url: `/api/v1/generation-operations/${operationId}/cancellation`,
      headers: {
        'risu-auth': assertion,
        'risu-database-lineage': authority.databaseLineage,
        'risu-writer-session': 'reader-foreign',
      },
      payload: { reason: 'user_stop' },
    })
    expect(foreignStop.statusCode).toBe(423)
    expect(foreignStop.json()).toEqual({ error: 'generation_operation_foreign_session' })
    expect((await operationStatus(operationId)).state).toBe('owned_by_job')

    const originatingStop = await app.inject({
      method: 'PUT',
      url: `/api/v1/generation-operations/${operationId}/cancellation`,
      headers: {
        'risu-auth': assertion,
        'risu-database-lineage': authority.databaseLineage,
        'risu-writer-session': 'writer-a',
      },
      payload: { reason: 'user_stop' },
    })
    expect(originatingStop.statusCode).toBe(202)
    expect(originatingStop.json()).toMatchObject({
      disposition: 'cancelling',
      operation: { state: 'stopping' },
    })
    await waitForOperationState(operationId, 'cancelled')
  })

  it('retries a pre-v40 accepted operation under its migration-marked authority exactly once', async () => {
    const acceptedMessageId = randomUUID()
    const operationId = randomUUID()
    const retryRequestId = randomUUID()
    const authority = await seedHistoricalChat(acceptedMessageId, true)
    await app.close()

    const historical = new DatabaseSync(path.join(dataDir, 'risu.db'))
    installHistoricalGenerationV39Schema(historical)
    insertHistoricalOperation({
      db: historical,
      authority,
      operationId,
      acceptedMessageId,
      state: 'accepted',
    })
    historical
      .prepare(
        `INSERT INTO memory_chunks (
           id, chat_id, message_id, range_start_seq, range_end_seq, text, status
         ) VALUES ('historical-memory-chunk', 'chat-1', ?, 0, 0, 'historical memory source', 'pending')`,
      )
      .run(acceptedMessageId)
    historical.close()

    let providerCalls = 0
    dispatchProvider = () => {
      providerCalls += 1
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'token', content: 'historical reply' }
        yield { kind: 'done', finishReason: 'stop' }
      })()
    }
    const translationRunner = vi.fn(runServerMessageTranslation)
    runMessageTranslation = translationRunner
    await startApp()
    const abandoned = await operationStatus(operationId)
    expect(abandoned.state).toBe('abandoned')

    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/generation-operations/${operationId}/retries`,
      headers: {
        'risu-auth': assertion,
        'risu-database-lineage': authority.databaseLineage,
        'risu-writer-session': 'writer-a',
      },
      payload: { retryRequestId, expectedStateVersion: abandoned.stateVersion },
    })
    expect(retry.statusCode).toBe(202)
    await waitForCompleted(operationId)
    const attemptDb = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
    const completedAttempt = attemptDb
      .prepare('SELECT job_id AS jobId FROM generation_operation_attempts WHERE operation_id = ?')
      .get(operationId) as { jobId: string }
    const effect = attemptDb
      .prepare(
        `SELECT key_type AS keyType, key_id AS keyId, operation_attempt_no AS operationAttemptNo,
                message_id AS messageId
         FROM generation_effects WHERE generation_id = ? AND effect_kind = 'generated_translation'`,
      )
      .get(completedAttempt.jobId) as {
      keyType: 'operation' | 'generation'
      keyId: string
      operationAttemptNo: number | null
      messageId: string
    }
    const hasTranslationAuthority = hasPreOccupancyGeneratedTranslationAuthority(attemptDb, {
      databaseLineage: authority.databaseLineage,
      operationId,
      generationId: completedAttempt.jobId,
      effectKeyType: effect.keyType,
      effectKeyId: effect.keyId,
      ...(effect.operationAttemptNo !== null ? { effectAttemptNo: effect.operationAttemptNo } : {}),
      chatId: 'chat-1',
      messageId: effect.messageId,
    })
    expect({
      effect,
      authority: hasTranslationAuthority,
    }).toEqual({ effect: expect.any(Object), authority: true })
    attemptDb.close()
    await waitForGeneratedTranslation(completedAttempt.jobId)

    await app.close()
    const memoryDb = openDatabase(dataDir)
    const memoryJobs = listMemoryJobs(memoryDb, { chatId: 'chat-1', kind: 'summarize' })
    expect(memoryJobs).toHaveLength(1)
    const historicalMemoryJob = getMemoryJob(memoryDb, memoryJobs[0].id)
    expect(historicalMemoryJob).toMatchObject({
      status: 'pending',
      operationId,
      operationAttemptNo: 1,
    })
    expect(historicalMemoryJob?.generationScope).toBeUndefined()
    expect(
      memoryDb
        .prepare(
          `SELECT o.state, o.current_attempt_no AS currentAttemptNo,
                  o.pre_occupancy_authority AS preOccupancyAuthority,
                  o.admission_kind AS operationAdmissionKind,
                  o.effective_configuration_json AS effectiveConfiguration,
                  a.status AS attemptStatus,
                  a.accepted_admission_kind AS attemptAdmissionKind,
                  a.accepted_effective_configuration_fingerprint AS acceptedFingerprint,
                  j.admission_kind AS jobAdmissionKind
           FROM memory_jobs AS j
           JOIN generation_operations AS o
             ON o.database_lineage = ? AND o.operation_id = j.operation_id AND o.chat_id = j.chat_id
           JOIN generation_operation_attempts AS a
             ON a.database_lineage = o.database_lineage AND a.operation_id = o.operation_id
            AND a.attempt_no = j.operation_attempt_no
           WHERE j.id = ?`,
        )
        .get(authority.databaseLineage, memoryJobs[0].id),
    ).toEqual({
      state: 'completed',
      currentAttemptNo: null,
      preOccupancyAuthority: 1,
      operationAdmissionKind: null,
      effectiveConfiguration: null,
      attemptStatus: 'completed',
      attemptAdmissionKind: null,
      acceptedFingerprint: null,
      jobAdmissionKind: null,
    })
    const summarize = vi.fn(async () => ({ text: 'historical memory summary', tokens: 3 }))
    const memoryWorker = new MemoryWorker({
      db: memoryDb,
      handlers: {
        summarize: createSummarizeMemoryJobHandler({
          db: memoryDb,
          loadDatabase: () => fixtureDatabase(acceptedMessageId, true),
          summarize,
        }),
      },
    })
    expect(await memoryWorker.tick()).toBe(true)
    expect(listMemoryJobs(memoryDb, { chatId: 'chat-1', kind: 'summarize' })).toEqual([
      expect.objectContaining({ status: 'completed', error: null }),
    ])
    expect(summarize).toHaveBeenCalledOnce()
    memoryDb.close()
    await startApp()

    const foreignReplay = await app.inject({
      method: 'POST',
      url: `/api/v1/generation-operations/${operationId}/retries`,
      headers: {
        'risu-auth': assertion,
        'risu-database-lineage': authority.databaseLineage,
        'risu-writer-session': 'reader-foreign',
      },
      payload: { retryRequestId, expectedStateVersion: abandoned.stateVersion },
    })
    expect(foreignReplay.statusCode).toBe(423)
    expect(foreignReplay.json()).toEqual({ error: 'generation_operation_foreign_session' })

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/generation-operations/${operationId}/retries`,
      headers: {
        'risu-auth': assertion,
        'risu-database-lineage': authority.databaseLineage,
        'risu-writer-session': 'writer-a',
      },
      payload: { retryRequestId, expectedStateVersion: abandoned.stateVersion },
    })
    expect(replay.statusCode).toBe(200)
    expect(providerCalls).toBe(1)
    expect(translationRunner).toHaveBeenCalledTimes(1)

    const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
    expect(
      db
        .prepare(
          `SELECT state, pre_occupancy_authority AS preOccupancyAuthority,
                  admission_kind AS admissionKind, result_message_id AS resultMessageId
           FROM generation_operations WHERE operation_id = ?`,
        )
        .get(operationId),
    ).toEqual({
      state: 'completed',
      preOccupancyAuthority: 1,
      admissionKind: null,
      resultMessageId: expect.any(String),
    })
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'char'").get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM generation_operation_attempts').get()).toEqual({ count: 1 })
    expect(
      db
        .prepare(
          `SELECT e.operation_attempt_no AS operationAttemptNo,
                  json_extract(m.json, '$.translation.targetLanguage') AS targetLanguage,
                  json_extract(m.json, '$.translation.text') AS translatedText
           FROM generation_effects AS e
           JOIN messages AS m ON m.chat_id = e.chat_id AND m.uid = e.message_id AND m.alternate = 0
           WHERE e.generation_id = ? AND e.effect_kind = 'generated_translation'`,
        )
        .get(completedAttempt.jobId),
    ).toMatchObject({
      operationAttemptNo: 1,
      targetLanguage: 'ko',
      translatedText: expect.stringContaining('debug://historical-translation'),
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM command_events WHERE operation_id = ?').get(operationId)).toEqual({
      count: 1,
    })
    db.close()
  })

  it('keeps a migrated retry follow-up authoritative after its generation attempt becomes retryable', async () => {
    const acceptedMessageId = randomUUID()
    const operationId = randomUUID()
    const retryRequestId = randomUUID()
    const authority = await seedHistoricalChat(acceptedMessageId)
    await app.close()

    const historical = new DatabaseSync(path.join(dataDir, 'risu.db'))
    installHistoricalGenerationV39Schema(historical)
    insertHistoricalOperation({
      db: historical,
      authority,
      operationId,
      acceptedMessageId,
      state: 'accepted',
    })
    historical
      .prepare(
        `INSERT INTO memory_chunks (
           id, chat_id, message_id, range_start_seq, range_end_seq, text, status
         ) VALUES ('failed-generation-memory-chunk', 'chat-1', ?, 0, 0,
                   'memory source accepted before provider failure', 'pending')`,
      )
      .run(acceptedMessageId)
    historical.close()

    let providerCalls = 0
    dispatchProvider = () => {
      providerCalls += 1
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        throw new Error('historical provider failure after memory enqueue')
      })()
    }
    await startApp()
    const abandoned = await operationStatus(operationId)
    expect(abandoned.state).toBe('abandoned')
    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/generation-operations/${operationId}/retries`,
      headers: {
        'risu-auth': assertion,
        'risu-database-lineage': authority.databaseLineage,
        'risu-writer-session': 'writer-a',
      },
      payload: { retryRequestId, expectedStateVersion: abandoned.stateVersion },
    })
    expect(retry.statusCode).toBe(202)
    await waitForOperationState(operationId, 'retryable')
    expect(providerCalls).toBeGreaterThan(0)

    await app.close()
    const memoryDb = openDatabase(dataDir)
    const memoryJobs = listMemoryJobs(memoryDb, { chatId: 'chat-1', kind: 'summarize' })
    expect(memoryJobs).toHaveLength(1)
    const memoryJob = getMemoryJob(memoryDb, memoryJobs[0].id)
    expect(memoryJob).toMatchObject({
      status: 'pending',
      operationId,
      operationAttemptNo: 1,
    })
    expect(memoryJob?.generationScope).toBeUndefined()
    expect(
      memoryDb
        .prepare(
          `SELECT o.state, o.current_attempt_no AS currentAttemptNo,
                  o.pre_occupancy_authority AS preOccupancyAuthority,
                  a.status AS attemptStatus
           FROM memory_jobs AS j
           JOIN generation_operations AS o
             ON o.database_lineage = ? AND o.operation_id = j.operation_id AND o.chat_id = j.chat_id
           JOIN generation_operation_attempts AS a
             ON a.database_lineage = o.database_lineage AND a.operation_id = o.operation_id
            AND a.attempt_no = j.operation_attempt_no
           WHERE j.id = ?`,
        )
        .get(authority.databaseLineage, memoryJobs[0].id),
    ).toEqual({
      state: 'retryable',
      currentAttemptNo: null,
      preOccupancyAuthority: 1,
      attemptStatus: 'retryable_failed',
    })

    const summarize = vi.fn(async () => ({ text: 'summary after generation failure', tokens: 4 }))
    const memoryWorker = new MemoryWorker({
      db: memoryDb,
      handlers: {
        summarize: createSummarizeMemoryJobHandler({
          db: memoryDb,
          loadDatabase: () => fixtureDatabase(acceptedMessageId),
          summarize,
        }),
      },
    })
    expect(await memoryWorker.tick()).toBe(true)
    expect(summarize).toHaveBeenCalledOnce()
    expect(getMemoryJob(memoryDb, memoryJobs[0].id)).toMatchObject({ status: 'completed', error: null })
    memoryDb.close()
  })

  it('recovers a pre-v40 pending finalization journal without provider redispatch or duplication', async () => {
    const acceptedMessageId = randomUUID()
    const operationId = randomUUID()
    const generationId = randomUUID()
    const authority = await seedHistoricalChat(acceptedMessageId, true)
    await app.close()

    const historical = new DatabaseSync(path.join(dataDir, 'risu.db'))
    installHistoricalGenerationV39Schema(historical)
    insertHistoricalOperation({
      db: historical,
      authority,
      operationId,
      acceptedMessageId,
      state: 'finalizing',
      jobId: generationId,
    })
    const writer = historical.prepare('SELECT writer_epoch AS epoch FROM database_metadata WHERE id = 1').get() as {
      epoch: number
    }
    historical
      .prepare(
        `INSERT INTO generation_finalization_retries (
           generation_id, database_lineage, operation_id, operation_attempt_no,
           actor_writer_session_id, actor_writer_epoch, accepted_message_id, terminal_outcome,
           chat_id, mode, message_json, chat_var_mutations_json, target_snapshot_json,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, 1, 'writer-a', ?, ?, 'completed',
                   'chat-1', 'send', ?, '[]', ?, 'pending', ?, ?)`,
      )
      .run(
        generationId,
        authority.databaseLineage,
        operationId,
        writer.epoch,
        acceptedMessageId,
        JSON.stringify({
          role: 'char',
          data: 'journaled historical reply',
          chatId: generationId,
          generationInfo: {
            generationId,
            databaseLineage: authority.databaseLineage,
            operationId,
            operationAttemptNo: 1,
          },
        }),
        JSON.stringify({
          mode: 'send',
          kind: 'tail',
          transcriptLength: 1,
          tail: {
            message: { role: 'user', data: 'old accepted input', chatId: acceptedMessageId },
          },
        }),
        '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z',
      )
    historical.close()

    let providerCalls = 0
    dispatchProvider = () => {
      providerCalls += 1
      return (async function* (): AsyncGenerator<CompletionStreamFrame> {
        yield { kind: 'done', finishReason: 'stop' }
      })()
    }
    const translationRunner = vi.fn(runServerMessageTranslation)
    runMessageTranslation = translationRunner
    await startApp()
    await waitForCompleted(operationId)
    await waitForGeneratedTranslation(generationId)
    expect(providerCalls).toBe(0)
    expect(translationRunner).toHaveBeenCalledTimes(1)

    let db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
    expect(db.prepare('SELECT COUNT(*) AS count FROM generation_finalization_retries').get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'char'").get()).toEqual({ count: 1 })
    expect(
      db
        .prepare(
          `SELECT e.operation_attempt_no AS operationAttemptNo,
                  json_extract(m.json, '$.translation.targetLanguage') AS targetLanguage,
                  json_extract(m.json, '$.translation.text') AS translatedText
           FROM generation_effects AS e
           JOIN messages AS m ON m.chat_id = e.chat_id AND m.uid = e.message_id AND m.alternate = 0
           WHERE e.generation_id = ? AND e.effect_kind = 'generated_translation'`,
        )
        .get(generationId),
    ).toMatchObject({
      operationAttemptNo: 1,
      targetLanguage: 'ko',
      translatedText: expect.stringContaining('debug://historical-translation'),
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM command_events WHERE operation_id = ?').get(operationId)).toEqual({
      count: 1,
    })
    db.close()

    await app.close()
    await startApp()
    await waitForCompleted(operationId)
    await waitForGeneratedTranslation(generationId)
    expect(providerCalls).toBe(0)
    expect(translationRunner).toHaveBeenCalledTimes(1)
    db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'char'").get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM command_events WHERE operation_id = ?').get(operationId)).toEqual({
      count: 1,
    })
    db.close()
  })

  it('recovers a genuine v39 pending translation through its historical exact-result authority once', async () => {
    const acceptedMessageId = randomUUID()
    const operationId = randomUUID()
    const generationId = randomUUID()
    const resultMessageId = randomUUID()
    const authority = await seedHistoricalChat(acceptedMessageId, true)
    await app.close()

    const historical = new DatabaseSync(path.join(dataDir, 'risu.db'))
    installHistoricalGenerationV39Schema(historical)
    insertHistoricalOperation({
      db: historical,
      authority,
      operationId,
      acceptedMessageId,
      state: 'finalizing',
      jobId: generationId,
    })
    const result = {
      role: 'char',
      data: 'historical generated reply',
      chatId: resultMessageId,
      generationInfo: {
        generationId,
        databaseLineage: authority.databaseLineage,
        operationId,
        operationAttemptNo: 1,
      },
    }
    historical
      .prepare(
        `INSERT INTO messages (chat_id, seq, uid, role, data, disabled, json, alternate)
         VALUES ('chat-1', 1, ?, 'char', ?, NULL, ?, 0)`,
      )
      .run(resultMessageId, result.data, JSON.stringify(result))
    const now = '2026-09-01T00:00:00.000Z'
    historical
      .prepare(
        `INSERT INTO generation_effects (
           database_lineage, key_type, key_id, effect_kind, effect_class,
           operation_id, generation_id, character_id, chat_id, message_id,
           status, created_at, updated_at
         ) VALUES (?, 'operation', ?, 'generated_translation', 'durable',
                   ?, ?, 'char-1', 'chat-1', ?, 'pending', ?, ?)`,
      )
      .run(authority.databaseLineage, operationId, operationId, generationId, resultMessageId, now, now)
    expect(
      (historical.prepare("PRAGMA table_info('generation_effects')").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    ).not.toContain('operation_attempt_no')
    historical.close()

    runMessageTranslation = vi.fn(runServerMessageTranslation)
    await startApp()
    await waitForGeneratedTranslation(generationId)
    expect(runMessageTranslation).toHaveBeenCalledTimes(1)

    let db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
    expect(
      db
        .prepare(
          `SELECT o.state, o.pre_occupancy_authority AS preOccupancyAuthority,
                  o.effective_configuration_json AS effectiveConfiguration,
                  a.accepted_effective_configuration_fingerprint AS acceptedFingerprint,
                  e.operation_attempt_no AS effectAttemptNo,
                  e.admission_kind AS effectAdmissionKind, e.status AS effectStatus
           FROM generation_operations AS o
           JOIN generation_operation_attempts AS a
             ON a.database_lineage = o.database_lineage AND a.operation_id = o.operation_id
           JOIN generation_effects AS e
             ON e.database_lineage = o.database_lineage AND e.operation_id = o.operation_id
            AND e.effect_kind = 'generated_translation'
           WHERE o.operation_id = ?`,
        )
        .get(operationId),
    ).toEqual({
      state: 'completed',
      preOccupancyAuthority: 1,
      effectiveConfiguration: null,
      acceptedFingerprint: null,
      effectAttemptNo: null,
      effectAdmissionKind: null,
      effectStatus: 'completed',
    })
    expect(
      db
        .prepare(
          `SELECT json_extract(json, '$.translation.targetLanguage') AS targetLanguage,
                  json_extract(json, '$.translation.text') AS translatedText
           FROM messages WHERE uid = ?`,
        )
        .get(resultMessageId),
    ).toMatchObject({
      targetLanguage: 'ko',
      translatedText: expect.stringContaining('debug://historical-translation'),
    })
    expect(
      db
        .prepare("SELECT json_extract(json, '$.translation') AS translation FROM messages WHERE uid = ?")
        .get(acceptedMessageId),
    ).toEqual({ translation: null })
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'char'").get()).toEqual({ count: 1 })
    db.close()

    await app.close()
    await startApp()
    await waitForGeneratedTranslation(generationId)
    expect(runMessageTranslation).toHaveBeenCalledTimes(1)
    db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'char'").get()).toEqual({ count: 1 })
    db.close()
  })
})
