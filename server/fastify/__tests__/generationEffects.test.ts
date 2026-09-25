import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { getSchemaState, openDatabase } from '../src/db.js'
import { createInitialDatabase } from '../src/databaseDefaults.js'
import { getDatabaseLineage, registerDatabaseWriterSession } from '../src/databaseLineage.js'
import { createCommandEventSink } from '../src/commands/events.js'
import { MessageTranslationJobRegistry } from '../src/messageTranslationJobs.js'
import {
  extractSettings,
  writePersistedWithMessages,
  writeSettingsOnly,
  writeSingleCollectionTable,
} from '../src/repository.js'
import { retryPendingGenerationCompletionEffects } from '../src/routes/generationChat.js'
import { admitGenerationInTransaction } from '../src/generationScope.js'
import { ChatOccupancyService } from '../src/chatOccupancy.js'
import {
  createGenerationOperation,
  generationEffectiveConfigurationFingerprint,
  reserveGenerationOperationAttempt,
} from '../src/generationOperations.js'
import { enqueueGenerationFinalizationRetry } from '../src/generationFinalizationRetry.js'
import {
  addAlternateMessage,
  appendChatMessage,
  getChatMessages,
  resolveActiveMessageLocationById,
  updateActiveMessageById,
  writeGenerationChatMessage,
} from '../src/messageStore.js'
import { runServerMessageTranslation } from '../src/translation/serverMessageTranslation.js'
import { resolveRawMessageTranslatorIdentity } from '../src/translation/rawMessageTranslation.js'
import { setupAuthedClient } from './helpers/auth.js'
import { assertCommandMetricGate, type CommandMutationMetric } from './helpers/commandMetricGates.js'
import {
  DEFERRED_GENERATION_INLAY_TARGET_STALE,
  automaticMessageTranslationIsServerOwned,
  claimGenerationEffect,
  commitAuthorizedGenerationInlayFinalizationInTransaction,
  commitDeferredGenerationInlayFinalizationInTransaction,
  deferredGenerationInlayFinalizationDisposition,
  ensureGenerationEffectLedger,
  generationEffectHasExactTerminalTranscriptBinding,
  listGenerationEffects,
  listPendingClientGenerationEffects,
  pruneSettledGenerationEffects,
  reconcileGenerationEffectsAtStartup,
  renewGenerationEffectClaim,
  settleExpiredNonDurableGenerationEffectClaims,
  settleGenerationEffect,
} from '../src/generationEffects.js'

const dataDirs: string[] = []
const apps: FastifyInstance[] = []

function openTestDatabase() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-generation-effects-'))
  dataDirs.push(dataDir)
  const db = openDatabase(dataDir)
  return { db, dataDir, lineage: getDatabaseLineage(db) }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(apps.splice(0).map((app) => app.close()))
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
})

async function openRouteHarness() {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-generation-effect-routes-'))
  dataDirs.push(dataDir)
  const commandEvents = createCommandEventSink()
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
    chatOccupancy: { enabled: true },
    memoryWorker: false,
    bardWikiWorker: false,
    assetGc: false,
    generationChat: { finalizationRetry: false },
    commandEvents,
  })
  apps.push(built.app)
  const { assertion } = await setupAuthedClient(built.app)
  const db = built.chatOccupancy.db
  db.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, 0, ?)').run(
    'character-a',
    JSON.stringify({ chaId: 'character-a', chats: [] }),
  )
  db.prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, 0, ?)').run(
    'chat-a',
    'character-a',
    JSON.stringify({ id: 'chat-a' }),
  )
  return { ...built, assertion, commandEvents, db, lineage: getDatabaseLineage(db) }
}

function seedChatOnlyCompletion(
  harness: Awaited<ReturnType<typeof openRouteHarness>>,
  input: {
    sessionId?: string
    operationId?: string
    generationId?: string
    messageId?: string
    targetMessageId?: string
    mode?: 'send' | 'regenerate'
    postAssemblyInputTrigger?: boolean
    terminalData?: string
    claimClass?: 'owner' | 'chat_only'
  } = {},
) {
  const sessionId = input.sessionId ?? 'reader-a'
  const operationId = input.operationId ?? 'operation-a'
  const generationId = input.generationId ?? 'generation-a'
  const messageId = input.messageId ?? 'message-a'
  const mode = input.mode ?? 'send'
  const targetMessageId = input.targetMessageId ?? 'displaced-message-a'
  const claimClass = input.claimClass ?? 'chat_only'
  const occupancy = harness.chatOccupancy.claim({
    databaseLineage: harness.lineage,
    chatId: 'chat-a',
    sessionId,
    claimClass,
    expectedOccupancyEpoch: 0,
  })
  const generationScope = admitGenerationInTransaction(harness.db, {
    databaseLineage: harness.lineage,
    chatId: 'chat-a',
    sessionId,
    occupancyProtocolVersion: 1,
    occupancyEpoch: occupancy.occupancyEpoch,
    interaction: mode === 'send' ? 'send' : 'reroll',
    chatOnlyEnabled: true,
  })
  const effectiveConfiguration = { version: 1, database: { igpPrompt: 'Apply IGP.' } }
  const operation = createGenerationOperation(harness.db, {
    databaseLineage: harness.lineage,
    operationId,
    protocolVersion: 1,
    requestOrigin: mode === 'send' ? 'accepted_send' : 'regenerate',
    creatorWriterSessionId: sessionId,
    creatorWriterEpoch: 0,
    generationScope,
    effectiveConfiguration,
    effectiveConfigurationFingerprint: generationEffectiveConfigurationFingerprint(effectiveConfiguration),
    bindingServerInstanceId: 'server-a',
    characterId: 'character-a',
    chatId: 'chat-a',
    mode,
    ...(mode === 'send' ? { acceptedMessageId: 'accepted-message-a' } : { targetMessageId }),
    requestFingerprint: 'request-a',
    intent: { message: 'accepted' },
    acceptedRevision: getSchemaState(harness.db).revision,
    state: 'accepted',
  })
  const attempt = reserveGenerationOperationAttempt(harness.db, {
    databaseLineage: harness.lineage,
    operationId,
    expectedState: 'accepted',
    expectedStateVersion: operation.stateVersion,
    retryRequestId: `retry-${operationId}`,
    jobId: generationId,
    serverInstanceId: 'server-a',
    actorWriterSessionId: sessionId,
    actorWriterEpoch: 0,
    launchRevision: getSchemaState(harness.db).revision,
  })
  if (attempt.status !== 'applied') throw new Error('expected reserved attempt')
  if (input.postAssemblyInputTrigger && mode === 'send') {
    appendChatMessage(harness.db, 'chat-a', {
      role: 'char',
      data: 'INPUT-LUA-ROW',
      chatId: 'input-trigger-message-a',
    })
  }
  appendChatMessage(harness.db, 'chat-a', {
    role: 'user',
    data: mode === 'send' ? 'Accepted user message' : 'Earlier user message',
    chatId: mode === 'send' ? 'accepted-message-a' : 'earlier-user-a',
  })
  const terminalMessage = {
    role: 'char',
    data: input.terminalData ?? 'Reply',
    chatId: messageId,
    generationInfo: {
      generationId,
      databaseLineage: harness.lineage,
      operationId,
      operationAttemptNo: 1,
      jobId: generationId,
      effectLedgerKeyType: 'operation',
      effectLedgerKeyId: operationId,
      effectLedgerCharacterId: 'character-a',
      effectLedgerChatId: 'chat-a',
    },
  }
  if (mode === 'regenerate') {
    const displaced = { role: 'char', data: 'Old assistant reply', chatId: targetMessageId }
    appendChatMessage(harness.db, 'chat-a', displaced)
    expect(writeGenerationChatMessage(harness.db, 'chat-a', terminalMessage, targetMessageId)).toMatchObject({
      ok: true,
      messageId,
      displaced,
    })
    addAlternateMessage(harness.db, 'chat-a', displaced)
    addAlternateMessage(harness.db, 'chat-a', terminalMessage)
  } else {
    appendChatMessage(harness.db, 'chat-a', terminalMessage)
  }
  harness.db
    .prepare(
      `UPDATE generation_operation_attempts
       SET status = 'completed', finalization_generation_id = ?
       WHERE database_lineage = ? AND operation_id = ? AND attempt_no = 1`,
    )
    .run(generationId, harness.lineage, operationId)
  harness.db
    .prepare(
      `UPDATE generation_operations
       SET state = 'completed', current_attempt_no = NULL, result_message_id = ?, terminal_at = ?
       WHERE database_lineage = ? AND operation_id = ?`,
    )
    .run(messageId, new Date().toISOString(), harness.lineage, operationId)
  ensureGenerationEffectLedger(harness.db, {
    databaseLineage: harness.lineage,
    operationId,
    operationAttemptNo: 1,
    operationProtocolVersion: 1,
    generationId,
    characterId: 'character-a',
    chatId: 'chat-a',
    messageId,
    generationScope,
  })
  return { sessionId, operationId, generationId, messageId, targetMessageId, generationScope }
}

function skipGeneratedTranslation(
  harness: Awaited<ReturnType<typeof openRouteHarness>>,
  seeded: ReturnType<typeof seedChatOnlyCompletion>,
): void {
  const claim = claimGenerationEffect(harness.db, {
    databaseLineage: harness.lineage,
    generationId: seeded.generationId,
    kind: 'generated_translation',
    delivery: 'server',
    messageId: seeded.messageId,
  })
  if (claim.status !== 'claimed') throw new Error('expected generated translation claim')
  expect(
    settleGenerationEffect(harness.db, {
      databaseLineage: harness.lineage,
      generationId: seeded.generationId,
      kind: 'generated_translation',
      claimId: claim.claimId,
      status: 'skipped',
      reason: 'not_applicable',
    }),
  ).toMatchObject({ status: 'skipped', reason: 'not_applicable' })
}

function installAcceptedIgpConfiguration(
  harness: Awaited<ReturnType<typeof openRouteHarness>>,
  seeded: ReturnType<typeof seedChatOnlyCompletion>,
  messages: Array<Record<string, unknown>>,
  options: {
    inlayMode?: 'emotion' | 'imggen'
    autoTranslate?: boolean
    translationDeferCapSeconds?: number
    persistLiveConfiguration?: boolean
  } = {},
): void {
  const acceptedDatabase = createInitialDatabase()
  Object.assign(acceptedDatabase, {
    providerCredentials: [
      {
        id: 'accepted-igp-credential',
        name: 'Accepted IGP credential',
        type: 'apiKey',
        apiKey: 'accepted-igp-key',
      },
    ],
    modelProfiles: [
      {
        id: 'accepted-igp-profile',
        name: 'Accepted IGP profile',
        providerId: 'custom-api',
        modelId: 'custom-api',
        providerOptions: {
          credentialId: 'accepted-igp-credential',
          baseUrl: 'https://accepted-igp.example/v1',
          requestModel: 'accepted-igp-model',
        },
      },
    ],
    modelRoleProfiles: {
      emotion: { mode: 'profile', profileId: 'accepted-igp-profile' },
      ...(options.autoTranslate ? { translate: { mode: 'profile', profileId: 'accepted-igp-profile' } } : {}),
    },
    ...(options.autoTranslate
      ? {
          translator: 'ko',
          translatorInputLanguage: 'en',
          translatorType: 'llm',
          translatorSendTextAsIs: true,
          translatorPrompt: 'Translate {{slot::content}}',
          translatorMaxResponse: 256,
          autoTranslateNotificationDeferCapSeconds: options.translationDeferCapSeconds ?? 1,
        }
      : {}),
    igpPrompt:
      '<|im_start|>system<|im_sep|>Last={{lastmessage}}; Char={{lastcharmessage}}; Index={{lastmessageid}}; Definition={{char}}.<|im_end|>',
    useStreaming: false,
    halfStreaming: false,
    characters: [
      {
        type: 'character',
        chaId: 'character-a',
        name: 'Accepted Character',
        utilityBot: false,
        desc: 'Accepted description',
        notes: '',
        firstMessage: 'Hello',
        viewScreen: options.inlayMode ?? 'none',
        ...(options.inlayMode ? { inlayViewScreen: true } : {}),
        bias: [],
        emotionImages: [],
        globalLore: [],
        sdData: [],
        customscript: [],
        exampleMessage: '',
        creatorNotes: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        alternateGreetings: [],
        tags: [],
        creator: '',
        characterVersion: '',
        personality: '',
        scenario: '',
        firstMsgIndex: -1,
        replaceGlobalNote: '',
        additionalText: '',
        triggerscript: [
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
        ],
        chatPage: 0,
        chatFolders: [],
        chats: [
          {
            id: 'chat-a',
            name: 'Accepted Chat',
            note: '',
            localLore: [],
            ...(options.autoTranslate ? { autoTranslate: true } : {}),
            message: messages,
          },
        ],
      },
    ],
    characterOrder: ['character-a'],
  })
  const acceptedConfiguration = {
    version: 1,
    database: acceptedDatabase,
    ...(options.autoTranslate
      ? {
          translationSettings: {
            translator: 'ko',
            translatorInputLanguage: 'en',
            translatorType: 'llm',
            translatorSendTextAsIs: true,
            translatorPrompt: 'Translate {{slot::content}}',
            translatorMaxResponse: 256,
          },
        }
      : {}),
    promptInfo: {},
    resolvedMainProfile: {},
  }
  const fingerprint = generationEffectiveConfigurationFingerprint(acceptedConfiguration)
  harness.db
    .prepare(
      `UPDATE generation_operations
       SET effective_configuration_json = ?, effective_configuration_fingerprint = ?
       WHERE database_lineage = ? AND operation_id = ?`,
    )
    .run(JSON.stringify(acceptedConfiguration), fingerprint, harness.lineage, seeded.operationId)
  harness.db
    .prepare(
      `UPDATE generation_operation_attempts SET accepted_effective_configuration_fingerprint = ?
       WHERE database_lineage = ? AND operation_id = ? AND attempt_no = 1`,
    )
    .run(fingerprint, harness.lineage, seeded.operationId)
  if (options.persistLiveConfiguration) {
    const persistedDatabase = structuredClone(acceptedDatabase)
    const persistedCharacters = (
      persistedDatabase as unknown as {
        characters: Array<{ chats: Array<{ message: Array<Record<string, unknown>> }> }>
      }
    ).characters
    persistedCharacters[0]!.chats[0]!.message = getChatMessages(harness.db, 'chat-a')
    writePersistedWithMessages(harness.db, harness.config.dataDir, {
      _version: 1,
      database: persistedDatabase,
      assets: [],
    })
  }
}

function captureIgpProviderRequests(): Array<{ url: string; headers: Headers; body: Record<string, unknown> }> {
  const captured: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'IGP-SNAPSHOT' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return captured
}

describe('generation effect ledger', () => {
  it('refuses to advance terminal authority for a chat-only inlay transformation', async () => {
    const harness = await openRouteHarness()
    const seeded = seedChatOnlyCompletion(harness, { terminalData: 'Reply <Emotion="happy">' })
    installAcceptedIgpConfiguration(
      harness,
      seeded,
      [{ role: 'user', data: 'Accepted user message', chatId: 'accepted-message-a' }],
      { inlayMode: 'emotion' },
    )
    const before = getChatMessages(harness.db, 'chat-a')

    harness.db.exec('BEGIN IMMEDIATE')
    try {
      expect(
        commitAuthorizedGenerationInlayFinalizationInTransaction(harness.db, {
          databaseLineage: harness.lineage,
          generationId: seeded.generationId,
          operationId: seeded.operationId,
          characterId: 'character-a',
          chatId: 'chat-a',
          messageId: seeded.messageId,
          expectedData: 'Reply <Emotion="happy">',
          finalData: 'Reply {{emotion::happy}}',
        }),
      ).toBeUndefined()
    } finally {
      harness.db.exec('ROLLBACK')
    }
    expect(getChatMessages(harness.db, 'chat-a')).toEqual(before)
  })

  it('accepts only server-owned image replacements for an owner imggen finalization', async () => {
    const harness = await openRouteHarness()
    const source = 'Before <ImgGen="cat"> after {{ImgGen="dog"}}.'
    registerDatabaseWriterSession(harness.db, 'owner-a')
    const seeded = seedChatOnlyCompletion(harness, {
      sessionId: 'owner-a',
      claimClass: 'owner',
      terminalData: source,
    })
    installAcceptedIgpConfiguration(
      harness,
      seeded,
      [{ role: 'user', data: 'Accepted user message', chatId: 'accepted-message-a' }],
      { inlayMode: 'imggen' },
    )
    skipGeneratedTranslation(harness, seeded)
    const imageAssetId = 'a'.repeat(64)
    harness.db
      .prepare('INSERT INTO assets (id, ext, size, content_type) VALUES (?, ?, ?, ?)')
      .run(imageAssetId, 'png', 1, 'image/png')

    const attempt = (finalData: string) => {
      harness.db.exec('BEGIN IMMEDIATE')
      try {
        const accepted = commitAuthorizedGenerationInlayFinalizationInTransaction(harness.db, {
          databaseLineage: harness.lineage,
          generationId: seeded.generationId,
          operationId: seeded.operationId,
          characterId: 'character-a',
          chatId: 'chat-a',
          messageId: seeded.messageId,
          expectedData: source,
          finalData,
        })
        harness.db.exec(accepted ? 'COMMIT' : 'ROLLBACK')
        return accepted
      } catch (error) {
        harness.db.exec('ROLLBACK')
        throw error
      }
    }

    expect(attempt('Before arbitrary after.')).toBeUndefined()
    expect(attempt(`Before {{inlay::${'b'.repeat(64)}}} after .`)).toBeUndefined()
    expect(attempt(`Before {{inlay::${imageAssetId}}} after .`)).toBeUndefined()
    const finalData = `Before {{inlay::${imageAssetId}}} after {{inlay::${imageAssetId}}}.`
    expect(attempt(finalData)).toBe('committed')
    expect(resolveActiveMessageLocationById(harness.db, seeded.messageId)).toMatchObject({
      ok: true,
      location: { message: { data: finalData } },
    })
    const effect = listGenerationEffects(harness.db, seeded.generationId, harness.lineage).find(
      (candidate) => candidate.kind === 'igp',
    )!
    expect(
      generationEffectHasExactTerminalTranscriptBinding(harness.db, effect, getChatMessages(harness.db, 'chat-a')),
    ).toBe(true)
  })

  it('keys protocol operations by operation and compatibility generations by generation', () => {
    const { db, lineage } = openTestDatabase()
    try {
      const operation = ensureGenerationEffectLedger(db, {
        databaseLineage: lineage,
        operationId: 'operation-a',
        operationProtocolVersion: 1,
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-a',
      })
      const compatibility = ensureGenerationEffectLedger(db, {
        databaseLineage: lineage,
        operationId: 'legacy-operation',
        operationProtocolVersion: 0,
        generationId: 'generation-b',
        characterId: 'character-a',
        chatId: 'chat-b',
        messageId: 'message-b',
      })

      expect(operation).toMatchObject({ keyType: 'operation', keyId: 'operation-a' })
      expect(compatibility).toMatchObject({ keyType: 'generation', keyId: 'generation-b' })
      expect(listGenerationEffects(db, 'generation-a')).toHaveLength(7)
      expect(listGenerationEffects(db, 'generation-a')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'igp', effectClass: 'durable', status: 'pending' }),
          expect.objectContaining({ kind: 'notification', effectClass: 'ephemeral', status: 'pending' }),
          expect.objectContaining({ kind: 'emotion_image_state', effectClass: 'recomputed', status: 'pending' }),
        ]),
      )
    } finally {
      db.close()
    }
  })

  it('grants one live dispatch for every durable effect and records terminal receipts', () => {
    const { db, lineage } = openTestDatabase()
    try {
      ensureGenerationEffectLedger(db, {
        databaseLineage: lineage,
        operationId: 'operation-a',
        operationProtocolVersion: 1,
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-a',
      })

      for (const kind of ['igp', 'plugin_output', 'generated_translation'] as const) {
        const delivery = kind === 'generated_translation' ? 'server' : 'live_terminal'
        const claim = claimGenerationEffect(db, {
          databaseLineage: lineage,
          generationId: 'generation-a',
          kind,
          delivery,
          messageId: 'message-a',
        })
        expect(claim).toMatchObject({ status: 'claimed', effect: { status: 'claimed' } })
        if (claim.status !== 'claimed') throw new Error('expected claim')
        expect(
          settleGenerationEffect(db, {
            databaseLineage: lineage,
            generationId: 'generation-a',
            kind,
            claimId: claim.claimId,
            status: 'completed',
          }),
        ).toMatchObject({ status: 'completed', delivery })

        expect(
          claimGenerationEffect(db, {
            databaseLineage: lineage,
            generationId: 'generation-a',
            kind,
            delivery: kind === 'generated_translation' ? 'server' : 'late_recovery',
          }),
        ).toMatchObject({ status: 'not_claimed', reason: 'already_receipted', effect: { status: 'completed' } })
      }
    } finally {
      db.close()
    }
  })

  it('reclaims an expired durable claim with one stable idempotency key and fences stale receipts', () => {
    const { db, lineage } = openTestDatabase()
    try {
      ensureGenerationEffectLedger(db, {
        databaseLineage: lineage,
        operationId: 'operation-a',
        operationProtocolVersion: 1,
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-a',
        createdAt: '2026-08-12T00:00:00.000Z',
      })
      const first = claimGenerationEffect(db, {
        databaseLineage: lineage,
        generationId: 'generation-a',
        kind: 'plugin_output',
        delivery: 'live_terminal',
        claimedAt: '2026-08-12T00:00:00.000Z',
        leaseMs: 1_000,
      })
      if (first.status !== 'claimed') throw new Error('expected first claim')

      expect(listPendingClientGenerationEffects(db, lineage, '2026-08-12T00:00:00.999Z')).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'plugin_output' })]),
      )
      expect(listPendingClientGenerationEffects(db, lineage, '2026-08-12T00:00:01.000Z')).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'plugin_output', status: 'claimed' })]),
      )
      expect(
        renewGenerationEffectClaim(db, {
          databaseLineage: lineage,
          generationId: 'generation-a',
          kind: 'plugin_output',
          claimId: first.claimId,
          renewedAt: '2026-08-12T00:00:01.000Z',
          leaseMs: 1_000,
        }),
      ).toBeUndefined()

      const reclaimed = claimGenerationEffect(db, {
        databaseLineage: lineage,
        generationId: 'generation-a',
        kind: 'plugin_output',
        delivery: 'late_recovery',
        claimedAt: '2026-08-12T00:00:01.000Z',
        leaseMs: 1_000,
      })
      if (reclaimed.status !== 'claimed') throw new Error('expected reclaimed claim')
      expect(reclaimed).toMatchObject({ reclaimed: true })
      expect(reclaimed.claimId).not.toBe(first.claimId)
      expect(reclaimed.idempotencyKey).toBe(first.idempotencyKey)
      expect(
        settleGenerationEffect(db, {
          databaseLineage: lineage,
          generationId: 'generation-a',
          kind: 'plugin_output',
          claimId: first.claimId,
          status: 'completed',
        }),
      ).toBeUndefined()
      expect(
        renewGenerationEffectClaim(db, {
          databaseLineage: lineage,
          generationId: 'generation-a',
          kind: 'plugin_output',
          claimId: reclaimed.claimId,
          renewedAt: '2026-08-12T00:00:01.500Z',
          leaseMs: 1_000,
        }),
      ).toMatchObject({ status: 'claimed', leaseExpiresAt: '2026-08-12T00:00:02.500Z' })
      expect(
        settleGenerationEffect(db, {
          databaseLineage: lineage,
          generationId: 'generation-a',
          kind: 'plugin_output',
          claimId: reclaimed.claimId,
          status: 'completed',
        }),
      ).toMatchObject({ status: 'completed' })
    } finally {
      db.close()
    }
  })

  it('permanently skips ephemeral work on late recovery without granting execution', () => {
    const { db, lineage } = openTestDatabase()
    try {
      ensureGenerationEffectLedger(db, {
        databaseLineage: lineage,
        operationId: 'operation-a',
        operationProtocolVersion: 1,
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-a',
      })

      for (const kind of ['notification', 'tts', 'completion_sound'] as const) {
        expect(
          claimGenerationEffect(db, {
            databaseLineage: lineage,
            generationId: 'generation-a',
            kind,
            delivery: 'late_recovery',
          }),
        ).toMatchObject({
          status: 'not_claimed',
          reason: 'late_recovery_skipped',
          effect: { status: 'skipped', delivery: 'late_recovery', reason: 'late_recovery' },
        })
      }
      expect(listPendingClientGenerationEffects(db).map((effect) => effect.kind)).not.toEqual(
        expect.arrayContaining(['notification', 'tts', 'completion_sound']),
      )
    } finally {
      db.close()
    }
  })

  it('lets only the originating session terminally skip nonpinning effects after a legal handoff', async () => {
    const harness = await openRouteHarness()
    const { app, assertion, db, lineage, chatOccupancy } = harness
    const originSession = 'reader-a'
    const foreignSession = 'reader-b'
    const seeded = seedChatOnlyCompletion(harness, { sessionId: originSession })
    const firstOccupancyEpoch = seeded.generationScope.occupancyEpoch!

    const durableClaimIds = new Map<string, string>()
    for (const [kind, delivery] of [
      ['generated_translation', 'server'],
      ['igp', 'live_terminal'],
    ] as const) {
      const claim = claimGenerationEffect(db, {
        databaseLineage: lineage,
        generationId: 'generation-a',
        kind,
        delivery,
        messageId: 'message-a',
      })
      if (claim.status !== 'claimed') throw new Error(`expected ${kind} claim`)
      durableClaimIds.set(kind, claim.claimId)
      expect(
        settleGenerationEffect(db, {
          databaseLineage: lineage,
          generationId: 'generation-a',
          kind,
          claimId: claim.claimId,
          status: 'skipped',
          reason: 'test_settled_before_handoff',
        }),
      ).toMatchObject({ status: 'skipped' })
    }

    const released = chatOccupancy.release({
      databaseLineage: lineage,
      chatId: 'chat-a',
      sessionId: originSession,
      occupancyEpoch: firstOccupancyEpoch,
    })
    const handedOff = chatOccupancy.claim({
      databaseLineage: lineage,
      chatId: 'chat-a',
      sessionId: foreignSession,
      claimClass: 'chat_only',
      expectedOccupancyEpoch: released.occupancyEpoch,
    })
    expect(handedOff.occupancyEpoch).toBeGreaterThan(firstOccupancyEpoch)

    const headers = (sessionId: string) => ({
      'risu-auth': assertion,
      'risu-writer-session': sessionId,
      'risu-database-lineage': lineage,
    })
    const wrongTarget = await app.inject({
      method: 'POST',
      url: '/api/v1/generation-effects/generation-a/notification/claims',
      headers: headers(originSession),
      payload: { delivery: 'late_recovery', messageId: 'wrong-message' },
    })
    expect(wrongTarget.statusCode, wrongTarget.body).toBe(200)
    expect(wrongTarget.json()).toMatchObject({
      status: 'not_claimed',
      reason: 'message_mismatch',
      effect: { operationId: 'operation-a', operationAttemptNo: 1, chatId: 'chat-a', status: 'pending' },
    })

    for (const kind of ['notification', 'tts', 'completion_sound'] as const) {
      const foreign = await app.inject({
        method: 'POST',
        url: `/api/v1/generation-effects/generation-a/${kind}/claims`,
        headers: headers(foreignSession),
        payload: { delivery: 'late_recovery', messageId: 'message-a' },
      })
      expect(foreign.statusCode, foreign.body).toBe(423)
      expect(foreign.json()).toEqual({ error: 'generation_effect_foreign_session' })

      const origin = await app.inject({
        method: 'POST',
        url: `/api/v1/generation-effects/generation-a/${kind}/claims`,
        headers: headers(originSession),
        payload: { delivery: 'late_recovery', messageId: 'message-a' },
      })
      expect(origin.statusCode, origin.body).toBe(200)
      expect(origin.json()).toMatchObject({
        status: 'not_claimed',
        reason: 'late_recovery_skipped',
        effect: {
          databaseLineage: lineage,
          operationId: 'operation-a',
          operationAttemptNo: 1,
          chatId: 'chat-a',
          messageId: 'message-a',
          status: 'skipped',
          delivery: 'late_recovery',
          reason: 'late_recovery',
        },
      })
    }

    const staleIgpControl = await app.inject({
      method: 'POST',
      url: '/api/v1/generation-effects/generation-a/igp/claims',
      headers: headers(originSession),
      payload: { delivery: 'late_recovery', messageId: 'message-a' },
    })
    expect(staleIgpControl.statusCode, staleIgpControl.body).toBe(409)
    expect(staleIgpControl.json()).toMatchObject({ error: 'chat_occupancy_stale', chatId: 'chat-a' })

    const staleGeneratedTranslationControl = await app.inject({
      method: 'PUT',
      url: '/api/v1/generation-effects/generation-a/generated_translation/receipt',
      headers: headers(originSession),
      payload: {
        claimId: durableClaimIds.get('generated_translation'),
        status: 'skipped',
      },
    })
    expect(staleGeneratedTranslationControl.statusCode, staleGeneratedTranslationControl.body).toBe(409)
    expect(staleGeneratedTranslationControl.json()).toMatchObject({ error: 'chat_occupancy_stale', chatId: 'chat-a' })

    expect(
      listGenerationEffects(db, 'generation-a', lineage)
        .filter((effect) => effect.effectClass === 'ephemeral')
        .map((effect) => ({ kind: effect.kind, status: effect.status, reason: effect.reason })),
    ).toEqual([
      { kind: 'completion_sound', status: 'skipped', reason: 'late_recovery' },
      { kind: 'notification', status: 'skipped', reason: 'late_recovery' },
      { kind: 'tts', status: 'skipped', reason: 'late_recovery' },
    ])
  })

  it('atomically commits configured chat-only IGP under the exact accepted operation scope', async () => {
    const harness = await openRouteHarness()
    const seeded = seedChatOnlyCompletion(harness)
    skipGeneratedTranslation(harness, seeded)
    const headers = (sessionId: string) => ({
      'risu-auth': harness.assertion,
      'risu-writer-session': sessionId,
      'risu-database-lineage': harness.lineage,
    })
    const claimed = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/claims`,
      headers: headers(seeded.sessionId),
      payload: { delivery: 'live_terminal', messageId: seeded.messageId },
    })
    expect(claimed.statusCode, claimed.body).toBe(201)
    const claimId = claimed.json().claimId as string
    const bypass = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/receipt`,
      headers: headers(seeded.sessionId),
      payload: { claimId, status: 'completed' },
    })
    expect(bypass.statusCode, bypass.body).toBe(409)
    expect(bypass.json()).toEqual({ error: 'generation_effect_atomic_commit_required' })
    expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toContainEqual(
      expect.objectContaining({ kind: 'igp', status: 'claimed', claimId }),
    )
    const baseRevision = getSchemaState(harness.db).revision
    const payload = {
      baseRevision,
      claimId,
      data: 'Reply[IGP]',
      expectedData: 'Reply',
      expectedGenerationId: seeded.generationId,
    }
    const previousMetrics = process.env.RISU_PROTOCOL_METRICS
    process.env.RISU_PROTOCOL_METRICS = '1'
    const metrics: Array<Record<string, unknown>> = []
    const infoSpy = vi.spyOn(console, 'info').mockImplementation((message: unknown) => {
      if (typeof message !== 'string' || !message.startsWith('[protocol-metric] ')) return
      metrics.push(JSON.parse(message.slice('[protocol-metric] '.length)) as Record<string, unknown>)
    })
    const committed = await (async () => {
      try {
        return await harness.app.inject({
          method: 'PUT',
          url: `/api/v1/generation-effects/${seeded.generationId}/igp/commit`,
          headers: headers(seeded.sessionId),
          payload,
        })
      } finally {
        infoSpy.mockRestore()
        if (previousMetrics === undefined) {
          delete process.env.RISU_PROTOCOL_METRICS
        } else {
          process.env.RISU_PROTOCOL_METRICS = previousMetrics
        }
      }
    })()
    expect(committed.statusCode, committed.body).toBe(200)
    expect(committed.json()).toMatchObject({
      revision: baseRevision + 1,
      chatId: 'chat-a',
      messageId: seeded.messageId,
      effect: { kind: 'igp', status: 'completed', claimId },
    })
    expect(resolveActiveMessageLocationById(harness.db, seeded.messageId)).toMatchObject({
      ok: true,
      location: { chatId: 'chat-a', message: { role: 'char', data: 'Reply[IGP]' } },
    })
    const commandMetric = metrics.find(
      (metric) => metric.metric === 'command_mutation' && metric.mutationPath === 'generation-effect-igp-commit',
    )
    expect(commandMetric).toMatchObject({
      type: 'message.updated',
      resource: 'message',
      dbJsonWriteMs: 0,
      writtenTables: ['generation_effects', 'messages'],
    })
    assertCommandMetricGate(commandMetric as CommandMutationMetric)

    const replayed = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/commit`,
      headers: headers(seeded.sessionId),
      payload: { ...payload, baseRevision: baseRevision + 99 },
    })
    expect(replayed.statusCode, replayed.body).toBe(200)
    expect(replayed.json()).toEqual(committed.json())
    expect(getSchemaState(harness.db).revision).toBe(baseRevision + 1)

    const acknowledged = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/receipt`,
      headers: headers(seeded.sessionId),
      payload: { claimId, status: 'completed' },
    })
    expect(acknowledged.statusCode, acknowledged.body).toBe(200)
    expect(acknowledged.json()).toMatchObject({ effect: { status: 'completed', claimId } })
  })

  it.each([
    {
      label: 'live Send',
      mode: 'send' as const,
      delivery: 'live_terminal' as const,
      acceptedMessages: [{ role: 'user', data: 'Accepted user message', chatId: 'accepted-message-a' }],
      staleAssistantText: 'Accepted user message',
      terminalIndex: '2',
    },
    {
      label: 'recovered Reroll',
      mode: 'regenerate' as const,
      delivery: 'late_recovery' as const,
      acceptedMessages: [
        { role: 'user', data: 'Earlier user message', chatId: 'earlier-user-a' },
        { role: 'char', data: 'Old assistant reply', chatId: 'displaced-message-a' },
      ],
      staleAssistantText: 'Old assistant reply',
      terminalIndex: '1',
    },
  ])(
    'executes $label IGP with accepted trigger/configuration and the exact post-assembly terminal transcript',
    async ({ mode, delivery, acceptedMessages, staleAssistantText, terminalIndex }) => {
      const harness = await openRouteHarness()
      const seeded = seedChatOnlyCompletion(harness, { mode, postAssemblyInputTrigger: true })
      if (mode === 'regenerate') expect(seeded.messageId).not.toBe(seeded.targetMessageId)
      installAcceptedIgpConfiguration(harness, seeded, acceptedMessages)
      const translation = {
        text: 'Translated reply',
        source: 'raw',
        sourceHash: createHash('sha256').update('Reply').digest('hex'),
        targetLanguage: 'ko',
        inputLanguage: 'en',
        translatorType: 'llm',
        settingsHash: 'accepted-settings-hash',
        updatedAt: 1_789_000_000_000,
      }
      const translationClaim = claimGenerationEffect(harness.db, {
        databaseLineage: harness.lineage,
        generationId: seeded.generationId,
        kind: 'generated_translation',
        delivery: 'server',
        messageId: seeded.messageId,
      })
      if (translationClaim.status !== 'claimed') throw new Error('expected generated translation claim')
      expect(updateActiveMessageById(harness.db, seeded.messageId, { translation })).toMatchObject({ ok: true })
      expect(
        settleGenerationEffect(harness.db, {
          databaseLineage: harness.lineage,
          generationId: seeded.generationId,
          kind: 'generated_translation',
          claimId: translationClaim.claimId,
          status: 'completed',
        }),
      ).toMatchObject({ status: 'completed', delivery: 'server' })
      expect(resolveActiveMessageLocationById(harness.db, seeded.messageId)).toMatchObject({
        ok: true,
        location: { message: { data: 'Reply', translation } },
      })
      const providerRequests = captureIgpProviderRequests()
      const headers = {
        'risu-auth': harness.assertion,
        'risu-writer-session': seeded.sessionId,
        'risu-database-lineage': harness.lineage,
      }
      const claimed = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/generation-effects/${seeded.generationId}/igp/claims`,
        headers,
        payload: { delivery, messageId: seeded.messageId },
      })
      expect(claimed.statusCode, claimed.body).toBe(201)
      const claimId = claimed.json().claimId as string
      const result = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/generation-effects/${seeded.generationId}/igp/completion`,
        headers,
        payload: { claimId },
      })

      expect(result.statusCode, result.body).toBe(200)
      expect(result.json()).toMatchObject({ type: 'success', result: 'IGP-SNAPSHOT' })
      expect(providerRequests).toHaveLength(1)
      expect(providerRequests[0].url).toBe('https://accepted-igp.example/v1/chat/completions')
      expect(providerRequests[0].headers.get('authorization')).toBe('Bearer accepted-igp-key')
      expect(providerRequests[0].body.model).toBe('accepted-igp-model')
      expect(providerRequests[0].body.messages).toEqual([
        {
          role: 'system',
          content: `Last=Reply; Char=Reply; Index=${terminalIndex}; Definition=Accepted Character.`,
        },
      ])
      expect(JSON.stringify(providerRequests[0].body)).not.toContain(staleAssistantText)
      const baseRevision = getSchemaState(harness.db).revision
      const committed = await harness.app.inject({
        method: 'PUT',
        url: `/api/v1/generation-effects/${seeded.generationId}/igp/commit`,
        headers,
        payload: {
          baseRevision,
          claimId,
          data: 'Reply[IGP-SNAPSHOT]',
          expectedData: 'Reply',
          expectedGenerationId: seeded.generationId,
        },
      })
      expect(committed.statusCode, committed.body).toBe(200)
      expect(committed.json()).toMatchObject({
        revision: baseRevision + 1,
        chatId: 'chat-a',
        messageId: seeded.messageId,
        effect: { kind: 'igp', status: 'completed', claimId },
      })
      const terminal = resolveActiveMessageLocationById(harness.db, seeded.messageId)
      expect(terminal).toMatchObject({
        ok: true,
        location: {
          message: { data: 'Reply[IGP-SNAPSHOT]', translation: null },
        },
      })
      const acknowledged = await harness.app.inject({
        method: 'PUT',
        url: `/api/v1/generation-effects/${seeded.generationId}/igp/receipt`,
        headers,
        payload: { claimId, status: 'completed' },
      })
      expect(acknowledged.statusCode, acknowledged.body).toBe(200)
      expect(acknowledged.json()).toMatchObject({ effect: { kind: 'igp', status: 'completed', claimId } })
      expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toContainEqual(
        expect.objectContaining({ kind: 'generated_translation', status: 'completed', delivery: 'server' }),
      )
    },
  )

  it('canonicalizes only the exact authorized generated translation and rejects all other transcript drift', async () => {
    const harness = await openRouteHarness()
    const seeded = seedChatOnlyCompletion(harness, { postAssemblyInputTrigger: true })
    const translation = {
      text: 'Translated reply',
      source: 'raw',
      sourceHash: createHash('sha256').update('Reply').digest('hex'),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: 'settings-hash',
      updatedAt: 1_789_000_000_000,
    }
    const translationClaim = claimGenerationEffect(harness.db, {
      databaseLineage: harness.lineage,
      generationId: seeded.generationId,
      kind: 'generated_translation',
      delivery: 'server',
      messageId: seeded.messageId,
    })
    if (translationClaim.status !== 'claimed') throw new Error('expected generated translation claim')
    expect(updateActiveMessageById(harness.db, seeded.messageId, { translation })).toMatchObject({ ok: true })
    expect(
      settleGenerationEffect(harness.db, {
        databaseLineage: harness.lineage,
        generationId: seeded.generationId,
        kind: 'generated_translation',
        claimId: translationClaim.claimId,
        status: 'completed',
      }),
    ).toMatchObject({ status: 'completed' })
    const effect = listGenerationEffects(harness.db, seeded.generationId, harness.lineage).find(
      (candidate) => candidate.kind === 'igp',
    )!
    const exact = getChatMessages(harness.db, 'chat-a')
    expect(generationEffectHasExactTerminalTranscriptBinding(harness.db, effect, exact)).toBe(true)

    const target = (messages: Array<Record<string, unknown>>): Record<string, unknown> =>
      messages.find((message) => message.chatId === seeded.messageId)!
    const generationInfo = (messages: Array<Record<string, unknown>>): Record<string, unknown> =>
      target(messages).generationInfo as Record<string, unknown>
    const mutations: Array<readonly [string, (messages: Array<Record<string, unknown>>) => void]> = [
      ['data', (messages) => void (target(messages).data = 'late text')],
      ['order', (messages) => void messages.reverse()],
      ['role', (messages) => void (target(messages).role = 'user')],
      ['message id', (messages) => void (target(messages).chatId = 'different-message')],
      ['saying/alternate display', (messages) => void (target(messages).saying = 'different alternate')],
      ['disabled', (messages) => void (target(messages).disabled = true)],
      ['generation id', (messages) => void (generationInfo(messages).generationId = 'different-generation')],
      ['operation id', (messages) => void (generationInfo(messages).operationId = 'different-operation')],
      ['attempt', (messages) => void (generationInfo(messages).operationAttemptNo = 2)],
      ['job', (messages) => void (generationInfo(messages).jobId = 'different-job')],
      ['ledger key', (messages) => void (generationInfo(messages).effectLedgerKeyId = 'different-ledger')],
      ['unrelated JSON', (messages) => void (target(messages).unrelated = { drift: true })],
      ['unrelated message translation', (messages) => void (messages[0]!.translation = structuredClone(translation))],
      [
        'authorized translation changed',
        (messages) => void ((target(messages).translation as Record<string, unknown>).text = 'later translation'),
      ],
      ['authorized translation removed', (messages) => void delete target(messages).translation],
    ]
    for (const [label, mutate] of mutations) {
      const changed = structuredClone(exact)
      mutate(changed)
      expect(generationEffectHasExactTerminalTranscriptBinding(harness.db, effect, changed), label).toBe(false)
    }

    addAlternateMessage(harness.db, 'chat-a', {
      role: 'char',
      data: 'late alternate',
      chatId: 'late-alternate',
    })
    expect(generationEffectHasExactTerminalTranscriptBinding(harness.db, effect, exact)).toBe(false)
  })

  it('rejects IGP when current history no longer matches the authorized post-assembly terminal transcript', async () => {
    const harness = await openRouteHarness()
    const seeded = seedChatOnlyCompletion(harness, { postAssemblyInputTrigger: true })
    skipGeneratedTranslation(harness, seeded)
    installAcceptedIgpConfiguration(harness, seeded, [
      { role: 'user', data: 'Accepted user message', chatId: 'accepted-message-a' },
    ])
    const providerRequests = captureIgpProviderRequests()
    const requestHeaders = {
      'risu-auth': harness.assertion,
      'risu-writer-session': seeded.sessionId,
      'risu-database-lineage': harness.lineage,
    }
    const claimed = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/claims`,
      headers: requestHeaders,
      payload: { delivery: 'late_recovery', messageId: seeded.messageId },
    })
    expect(claimed.statusCode, claimed.body).toBe(201)

    appendChatMessage(harness.db, 'chat-a', {
      role: 'char',
      data: 'UNAUTHORIZED-LATE-ROW',
      chatId: 'unrelated-message-a',
    })
    const result = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/completion`,
      headers: requestHeaders,
      payload: { claimId: claimed.json().claimId },
    })

    expect(result.statusCode, result.body).toBe(409)
    expect(result.json()).toMatchObject({ error: 'generation_effect_target_stale' })
    expect(providerRequests).toHaveLength(0)
  })

  it('backfills a completed operation after current-attempt cleanup with exact accepted scope', async () => {
    const harness = await openRouteHarness()
    const seeded = seedChatOnlyCompletion(harness)
    harness.db.prepare('DELETE FROM generation_effects WHERE generation_id = ?').run(seeded.generationId)
    expect(
      harness.db
        .prepare('SELECT current_attempt_no AS currentAttemptNo FROM generation_operations WHERE operation_id = ?')
        .get(seeded.operationId),
    ).toEqual({ currentAttemptNo: null })

    // App startup already ran the one-shot backfill for this lineage. A database
    // written before the marker existed has no marker and is walked exactly once.
    expect(reconcileGenerationEffectsAtStartup(harness.db)).toBe(0)
    harness.db.exec('UPDATE database_metadata SET generation_effects_backfill_lineage = NULL WHERE id = 1')
    expect(reconcileGenerationEffectsAtStartup(harness.db)).toBe(7)
    expect(reconcileGenerationEffectsAtStartup(harness.db)).toBe(0)
    const effects = listGenerationEffects(harness.db, seeded.generationId, harness.lineage)
    expect(effects).toHaveLength(7)
    expect(effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'igp',
          operationId: seeded.operationId,
          operationAttemptNo: 1,
          status: 'skipped',
          reason: 'pre_ledger_terminal',
          generationScope: seeded.generationScope,
        }),
      ]),
    )

    harness.db
      .prepare(
        `UPDATE generation_effects
         SET status = 'completed', reason = 'already_processed'
         WHERE generation_id = ? AND effect_kind = 'igp'`,
      )
      .run(seeded.generationId)
    harness.db
      .prepare("DELETE FROM generation_effects WHERE generation_id = ? AND effect_kind = 'generated_translation'")
      .run(seeded.generationId)
    // The marker now exists, so a later restart never recreates a deleted row.
    expect(reconcileGenerationEffectsAtStartup(harness.db)).toBe(0)
    const remaining = listGenerationEffects(harness.db, seeded.generationId, harness.lineage).map((effect) => ({
      kind: effect.kind,
      status: effect.status,
      reason: effect.reason,
    }))
    expect(remaining).toHaveLength(6)
    expect(remaining).toEqual(
      expect.arrayContaining([{ kind: 'igp', status: 'completed', reason: 'already_processed' }]),
    )
    expect(remaining).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'generated_translation' })]))
  })

  it('settles an abandoned non-durable claim after its lease and never delivers it again', () => {
    const { db, lineage } = openTestDatabase()
    try {
      ensureGenerationEffectLedger(db, {
        databaseLineage: lineage,
        operationId: 'operation-a',
        operationProtocolVersion: 1,
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-a',
        createdAt: '2026-08-12T00:00:00.000Z',
      })
      const claimAt = (kind: 'notification' | 'tts' | 'emotion_image_state', claimedAt: string) =>
        claimGenerationEffect(db, {
          databaseLineage: lineage,
          generationId: 'generation-a',
          kind,
          delivery: 'live_terminal',
          claimedAt,
          leaseMs: 1_000,
        })
      for (const kind of ['notification', 'tts', 'emotion_image_state'] as const) {
        expect(claimAt(kind, '2026-08-12T00:00:00.000Z')).toMatchObject({ status: 'claimed' })
      }

      // A second claim attempt after the lease settles the row instead of redelivering.
      expect(claimAt('notification', '2026-08-12T00:00:01.000Z')).toEqual({
        status: 'not_claimed',
        reason: 'already_receipted',
        effect: expect.objectContaining({
          kind: 'notification',
          status: 'skipped',
          reason: 'claim_lease_expired',
          delivery: 'live_terminal',
        }),
      })
      expect(claimAt('notification', '2026-08-12T00:00:02.000Z')).toMatchObject({
        status: 'not_claimed',
        reason: 'already_receipted',
      })

      // The sweep settles only leases that have actually expired, and is bounded.
      expect(settleExpiredNonDurableGenerationEffectClaims(db, { now: '2026-08-12T00:00:00.999Z' })).toBe(0)
      expect(
        settleExpiredNonDurableGenerationEffectClaims(db, { now: '2026-08-12T00:00:01.000Z', maxPerSweep: 1 }),
      ).toBe(1)
      expect(settleExpiredNonDurableGenerationEffectClaims(db, { now: '2026-08-12T00:00:01.000Z' })).toBe(1)
      expect(settleExpiredNonDurableGenerationEffectClaims(db, { now: '2026-08-12T00:00:01.000Z' })).toBe(0)
      const settled = listGenerationEffects(db, 'generation-a', lineage).map((effect) => ({
        kind: effect.kind,
        status: effect.status,
        reason: effect.reason,
      }))
      expect(settled).toEqual(
        expect.arrayContaining([
          { kind: 'notification', status: 'skipped', reason: 'claim_lease_expired' },
          { kind: 'tts', status: 'skipped', reason: 'claim_lease_expired' },
          { kind: 'emotion_image_state', status: 'skipped', reason: 'claim_lease_expired' },
        ]),
      )
      expect(claimAt('tts', '2026-08-12T00:00:05.000Z')).toMatchObject({
        status: 'not_claimed',
        reason: 'already_receipted',
        effect: { status: 'skipped', reason: 'claim_lease_expired' },
      })
      // Durable rows are untouched by the sweep: pending ones stay claimable.
      expect(settled).toEqual(
        expect.arrayContaining([
          { kind: 'igp', status: 'pending', reason: undefined },
          { kind: 'plugin_output', status: 'pending', reason: undefined },
          { kind: 'generated_translation', status: 'pending', reason: undefined },
        ]),
      )
    } finally {
      db.close()
    }
  })

  it('prunes settled effects after retention, keeps them pruned across restart, and acknowledges pruned claims', async () => {
    const harness = await openRouteHarness()
    const seeded = seedChatOnlyCompletion(harness)
    const settle = (kind: string, settledAt: string) =>
      harness.db
        .prepare(
          `UPDATE generation_effects
           SET status = 'skipped', claim_id = 'claim-' || effect_kind, delivery = 'server', reason = 'not_configured',
               claimed_at = ?, settled_at = ?, updated_at = ?
           WHERE database_lineage = ? AND generation_id = ? AND effect_kind = ?`,
        )
        .run(settledAt, settledAt, settledAt, harness.lineage, seeded.generationId, kind)
    const old = '2026-09-01T00:00:00.000Z'
    const now = '2026-09-25T00:00:00.000Z'
    for (const kind of ['igp', 'plugin_output', 'generated_translation', 'tts', 'completion_sound']) settle(kind, old)
    settle('emotion_image_state', now)

    // A pending sibling keeps every receipt of the generation.
    expect(pruneSettledGenerationEffects(harness.db, { now })).toBe(0)
    settle('notification', old)
    // Bounded, oldest first, and rows inside the window survive.
    expect(pruneSettledGenerationEffects(harness.db, { now, maxPerSweep: 2 })).toBe(2)
    expect(pruneSettledGenerationEffects(harness.db, { now })).toBe(4)
    expect(pruneSettledGenerationEffects(harness.db, { now })).toBe(0)
    expect(
      listGenerationEffects(harness.db, seeded.generationId, harness.lineage).map((effect) => effect.kind),
    ).toEqual(['emotion_image_state'])

    // A restart does not resurrect the pruned rows.
    expect(reconcileGenerationEffectsAtStartup(harness.db)).toBe(0)
    expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toHaveLength(1)

    // A pruned durable effect of a completed operation reads as receipted, not missing.
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/claims`,
      headers: {
        'risu-auth': harness.assertion,
        'risu-writer-session': seeded.sessionId,
        'risu-database-lineage': harness.lineage,
      },
      payload: { delivery: 'late_recovery', messageId: seeded.messageId },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toEqual({ status: 'not_claimed', reason: 'already_receipted' })
    expect(
      claimGenerationEffect(harness.db, {
        databaseLineage: harness.lineage,
        generationId: 'generation-unknown',
        kind: 'igp',
        delivery: 'late_recovery',
      }),
    ).toEqual({ status: 'not_claimed', reason: 'effect_not_found' })
  })

  async function attemptRejectedChatOnlyIgpCommit(testCase: 'foreign' | 'expired' | 'stale-target' | 'corrupt-scope') {
    const harness = await openRouteHarness()
    const suffix = testCase.replace('-', '_')
    const seeded = seedChatOnlyCompletion(harness, {
      operationId: `operation-${suffix}`,
      generationId: `generation-${suffix}`,
      messageId: `message-${suffix}`,
    })
    skipGeneratedTranslation(harness, seeded)
    const headers = (sessionId: string) => ({
      'risu-auth': harness.assertion,
      'risu-writer-session': sessionId,
      'risu-database-lineage': harness.lineage,
    })
    const claimed = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/claims`,
      headers: headers(seeded.sessionId),
      payload: { delivery: 'live_terminal', messageId: seeded.messageId },
    })
    expect(claimed.statusCode, claimed.body).toBe(201)
    const claimId = claimed.json().claimId as string
    if (testCase === 'expired') {
      harness.db
        .prepare(
          `UPDATE generation_effects SET lease_expires_at = '2000-01-01T00:00:00.000Z'
           WHERE generation_id = ? AND effect_kind = 'igp'`,
        )
        .run(seeded.generationId)
    } else if (testCase === 'stale-target') {
      harness.db
        .prepare("UPDATE messages SET data = 'Changed', json = json_set(json, '$.data', 'Changed') WHERE uid = ?")
        .run(seeded.messageId)
    } else if (testCase === 'corrupt-scope') {
      harness.db
        .prepare(
          `UPDATE generation_effects SET occupancy_epoch = occupancy_epoch + 1
           WHERE generation_id = ? AND effect_kind = 'igp'`,
        )
        .run(seeded.generationId)
    }
    const beforeRevision = getSchemaState(harness.db).revision
    const beforeMessage = resolveActiveMessageLocationById(harness.db, seeded.messageId)
    const result = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/commit`,
      headers: headers(testCase === 'foreign' ? 'reader-b' : seeded.sessionId),
      payload: {
        baseRevision: beforeRevision,
        claimId,
        data: 'Reply[IGP]',
        expectedData: 'Reply',
        expectedGenerationId: seeded.generationId,
      },
    })
    expect(getSchemaState(harness.db).revision).toBe(beforeRevision)
    expect(resolveActiveMessageLocationById(harness.db, seeded.messageId)).toEqual(beforeMessage)
    expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toContainEqual(
      expect.objectContaining({ kind: 'igp', status: 'claimed', claimId }),
    )
    await harness.app.close()
    apps.splice(apps.indexOf(harness.app), 1)
    return result
  }

  it('rejects a foreign-session chat-only IGP commit without mutation', { tags: 'core' }, async () => {
    const result = await attemptRejectedChatOnlyIgpCommit('foreign')
    expect(result.statusCode, result.body).toBe(423)
    expect(result.json()).toEqual({ error: 'generation_effect_foreign_session' })
  })

  it('rejects a stale-target chat-only IGP commit without mutation', { tags: 'core' }, async () => {
    const result = await attemptRejectedChatOnlyIgpCommit('stale-target')
    expect(result.statusCode, result.body).toBe(409)
    expect(result.json()).toEqual({ error: 'generation_effect_target_stale' })
  })

  it('rejects expired and corrupt-scope chat-only IGP commits without mutation', async () => {
    for (const testCase of ['expired', 'corrupt-scope'] as const) {
      const result = await attemptRejectedChatOnlyIgpCommit(testCase)
      expect(result.statusCode, `${testCase}: ${result.body}`).toBe(409)
    }
  })

  it('projects modern finalization/effect recovery only to the immutable originating session', async () => {
    const harness = await openRouteHarness()
    const seeded = seedChatOnlyCompletion(harness)
    enqueueGenerationFinalizationRetry(harness.db, {
      generationId: seeded.generationId,
      databaseLineage: harness.lineage,
      operationId: seeded.operationId,
      operationAttemptNo: 1,
      actorWriterSessionId: seeded.sessionId,
      actorWriterEpoch: 0,
      acceptedMessageId: 'accepted-message-a',
      terminalOutcome: 'completed',
      generationScope: seeded.generationScope,
      chatId: 'chat-a',
      mode: 'send',
      message: { role: 'char', data: 'Reply', chatId: seeded.messageId },
      chatVarMutations: [],
      targetSnapshot: { mode: 'send', kind: 'tail', transcriptLength: 0 },
    })
    const bootstrap = (sessionId: string) =>
      harness.app.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': harness.assertion, 'risu-writer-observer-session': sessionId },
      })

    const origin = await bootstrap(seeded.sessionId)
    expect(origin.statusCode, origin.body).toBe(200)
    expect(origin.json().generationFinalizations).toContainEqual(
      expect.objectContaining({
        generationId: seeded.generationId,
        operationId: seeded.operationId,
        operationAttemptNo: 1,
        chatId: 'chat-a',
      }),
    )
    expect(origin.json().pendingGenerationEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'igp', operationId: seeded.operationId, chatId: 'chat-a' }),
      ]),
    )

    const foreign = await bootstrap('reader-b')
    expect(foreign.statusCode, foreign.body).toBe(200)
    expect(foreign.json().generationFinalizations).toEqual([])
    expect(foreign.json().pendingGenerationEffects).toEqual([])

    skipGeneratedTranslation(harness, seeded)

    const headers = {
      'risu-auth': harness.assertion,
      'risu-writer-session': seeded.sessionId,
      'risu-database-lineage': harness.lineage,
    }
    const claimed = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/claims`,
      headers,
      payload: { delivery: 'live_terminal', messageId: seeded.messageId },
    })
    expect(claimed.statusCode, claimed.body).toBe(201)
    const claimId = claimed.json().claimId as string
    harness.db
      .prepare(
        `UPDATE generation_effects SET operation_attempt_no = 2
         WHERE generation_id = ? AND effect_kind = 'igp'`,
      )
      .run(seeded.generationId)
    const corrupt = await bootstrap(seeded.sessionId)
    expect(corrupt.json().pendingGenerationEffects).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'igp' })]),
    )
    for (const [suffix, payload] of [
      ['lease', { claimId }],
      ['receipt', { claimId, status: 'skipped' }],
    ] as const) {
      const controlled = await harness.app.inject({
        method: 'PUT',
        url: `/api/v1/generation-effects/${seeded.generationId}/igp/${suffix}`,
        headers,
        payload,
      })
      expect(controlled.statusCode, controlled.body).toBe(409)
      expect(controlled.json()).toEqual({ error: 'generation_scope_invalid' })
    }

    harness.db
      .prepare(
        `UPDATE generation_finalization_retries SET actor_writer_epoch = actor_writer_epoch + 1
         WHERE generation_id = ?`,
      )
      .run(seeded.generationId)
    const corruptFinalization = await bootstrap(seeded.sessionId)
    expect(corruptFinalization.json().generationFinalizations).toEqual([])
  })

  it('grants recent notification and sound recovery once while keeping stale alerts and TTS skipped', () => {
    const { db, lineage } = openTestDatabase()
    try {
      ensureGenerationEffectLedger(db, {
        databaseLineage: lineage,
        operationId: 'operation-recent',
        operationProtocolVersion: 1,
        generationId: 'generation-recent',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-recent',
        createdAt: '2026-09-12T00:00:00.000Z',
      })

      for (const kind of ['notification', 'completion_sound'] as const) {
        const claim = claimGenerationEffect(db, {
          databaseLineage: lineage,
          generationId: 'generation-recent',
          kind,
          delivery: 'late_recovery',
          claimedAt: '2026-09-12T00:01:00.000Z',
          recoverRecentCompletionAlert: true,
        })
        expect(claim).toMatchObject({ status: 'claimed', effect: { status: 'claimed', delivery: 'late_recovery' } })
        if (claim.status !== 'claimed') throw new Error('expected recent alert claim')
        for (const delivery of ['late_recovery', 'live_terminal'] as const) {
          expect(
            claimGenerationEffect(db, {
              databaseLineage: lineage,
              generationId: 'generation-recent',
              kind,
              delivery,
              claimedAt: '2026-09-12T00:01:00.000Z',
              recoverRecentCompletionAlert: true,
            }),
          ).toMatchObject({ status: 'not_claimed', reason: 'already_receipted' })
        }
        expect(
          settleGenerationEffect(db, {
            databaseLineage: lineage,
            generationId: 'generation-recent',
            kind,
            claimId: claim.claimId,
            status: 'completed',
          }),
        ).toMatchObject({ status: 'completed' })
        expect(
          claimGenerationEffect(db, {
            databaseLineage: lineage,
            generationId: 'generation-recent',
            kind,
            delivery: 'late_recovery',
            claimedAt: '2026-09-12T00:01:00.000Z',
            recoverRecentCompletionAlert: true,
          }),
        ).toMatchObject({ status: 'not_claimed', reason: 'already_receipted', effect: { status: 'completed' } })
      }
      expect(
        claimGenerationEffect(db, {
          databaseLineage: lineage,
          generationId: 'generation-recent',
          kind: 'tts',
          delivery: 'late_recovery',
          claimedAt: '2026-09-12T00:00:30.000Z',
          recoverRecentCompletionAlert: true,
        }),
      ).toMatchObject({ status: 'not_claimed', reason: 'late_recovery_skipped' })

      ensureGenerationEffectLedger(db, {
        databaseLineage: lineage,
        operationId: 'operation-stale',
        operationProtocolVersion: 1,
        generationId: 'generation-stale',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-stale',
        createdAt: '2026-09-12T00:00:00.000Z',
      })
      for (const kind of ['notification', 'completion_sound'] as const) {
        expect(
          claimGenerationEffect(db, {
            databaseLineage: lineage,
            generationId: 'generation-stale',
            kind,
            delivery: 'late_recovery',
            claimedAt: '2026-09-12T00:01:00.001Z',
            recoverRecentCompletionAlert: true,
          }),
        ).toMatchObject({ status: 'not_claimed', reason: 'late_recovery_skipped' })
      }
    } finally {
      db.close()
    }
  })

  it('reserves generated translation for the server owner', () => {
    const { db, lineage } = openTestDatabase()
    try {
      ensureGenerationEffectLedger(db, {
        databaseLineage: lineage,
        operationId: 'operation-a',
        operationProtocolVersion: 1,
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-a',
      })
      expect(
        claimGenerationEffect(db, {
          databaseLineage: lineage,
          generationId: 'generation-a',
          kind: 'generated_translation',
          delivery: 'late_recovery',
        }),
      ).toMatchObject({ status: 'not_claimed', reason: 'server_owned' })
      expect(
        claimGenerationEffect(db, {
          databaseLineage: lineage,
          generationId: 'generation-a',
          kind: 'generated_translation',
          delivery: 'server',
        }),
      ).toMatchObject({ status: 'claimed' })
    } finally {
      db.close()
    }
  })

  it('rejects an automatic message translation before it can supersede an exact durable server claim', async () => {
    const harness = await openRouteHarness()
    const seeded = seedChatOnlyCompletion(harness)
    const claim = claimGenerationEffect(harness.db, {
      databaseLineage: harness.lineage,
      generationId: seeded.generationId,
      kind: 'generated_translation',
      delivery: 'server',
      messageId: seeded.messageId,
    })
    expect(claim).toMatchObject({ status: 'claimed' })
    if (claim.status !== 'claimed') throw new Error('expected generated translation claim')
    expect(automaticMessageTranslationIsServerOwned(harness.db, seeded.messageId, harness.lineage)).toBe(true)
    const before = getChatMessages(harness.db, 'chat-a')

    const translated = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/commands/messages/${seeded.messageId}/translate`,
      headers: {
        'risu-auth': harness.assertion,
        'risu-writer-session': seeded.sessionId,
        'risu-database-lineage': harness.lineage,
      },
      payload: {
        baseRevision: getSchemaState(harness.db).revision,
        jobId: 'automatic-translation-a',
        automatic: true,
      },
    })

    expect(translated.statusCode, translated.body).toBe(409)
    expect(translated.json()).toEqual({ error: 'generated_translation_server_owned' })
    expect(getChatMessages(harness.db, 'chat-a')).toEqual(before)
    expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toContainEqual(
      expect.objectContaining({ kind: 'generated_translation', status: 'claimed', claimId: claim.claimId }),
    )
    const bootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': harness.assertion },
    })
    expect(bootstrap.statusCode, bootstrap.body).toBe(200)
    expect(bootstrap.json().activeMessageTranslations).toEqual([])
  })

  it('converges interrupted and uninterrupted jobs on the same durable receipts', () => {
    const { db, lineage } = openTestDatabase()
    try {
      for (const generationId of ['live-generation', 'recovered-generation']) {
        ensureGenerationEffectLedger(db, {
          databaseLineage: lineage,
          operationId: `${generationId}-operation`,
          operationProtocolVersion: 1,
          generationId,
          characterId: 'character-a',
          chatId: 'chat-a',
          messageId: `${generationId}-message`,
        })
      }

      for (const kind of ['igp', 'plugin_output', 'generated_translation'] as const) {
        for (const generationId of ['live-generation', 'recovered-generation']) {
          const claim = claimGenerationEffect(db, {
            databaseLineage: lineage,
            generationId,
            kind,
            delivery:
              kind === 'generated_translation'
                ? 'server'
                : generationId === 'live-generation'
                  ? 'live_terminal'
                  : 'late_recovery',
          })
          if (claim.status !== 'claimed') throw new Error('expected claim')
          settleGenerationEffect(db, {
            databaseLineage: lineage,
            generationId,
            kind,
            claimId: claim.claimId,
            status: 'completed',
          })
        }
      }

      const durableOutcome = (generationId: string) =>
        listGenerationEffects(db, generationId)
          .filter((effect) => effect.effectClass === 'durable')
          .map((effect) => ({ kind: effect.kind, status: effect.status }))
      expect(durableOutcome('recovered-generation')).toEqual(durableOutcome('live-generation'))
    } finally {
      db.close()
    }
  })

  it('keeps reload-recovered IGP pending until a capped live translation commits, then completes both once', async () => {
    const harness = await openRouteHarness()
    const seeded = seedChatOnlyCompletion(harness)
    installAcceptedIgpConfiguration(
      harness,
      seeded,
      [{ role: 'user', data: 'Accepted user message', chatId: 'accepted-message-a' }],
      { autoTranslate: true, translationDeferCapSeconds: 1 },
    )

    let announceTranslationStarted!: () => void
    const translationStarted = new Promise<void>((resolve) => {
      announceTranslationStarted = resolve
    })
    let releaseTranslation!: () => void
    const translationGate = new Promise<void>((resolve) => {
      releaseTranslation = resolve
    })
    const providerRequests: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        providerRequests.push(body)
        if (providerRequests.length === 1) {
          announceTranslationStarted()
          await translationGate
        }
        const content = providerRequests.length === 1 ? 'Translated reply' : 'IGP-SNAPSHOT'
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    const jobs = new MessageTranslationJobRegistry()
    const translationSweep = retryPendingGenerationCompletionEffects({
      db: harness.db,
      dataDir: harness.config.dataDir,
      eventSink: createCommandEventSink(),
      messageTranslationJobs: jobs,
      runMessageTranslation: runServerMessageTranslation,
    })
    await translationStarted
    await expect(translationSweep).resolves.toBe(1)

    const headers = {
      'risu-auth': harness.assertion,
      'risu-writer-session': seeded.sessionId,
      'risu-database-lineage': harness.lineage,
    }
    const reloadBootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': harness.assertion, 'risu-writer-observer-session': seeded.sessionId },
    })
    expect(reloadBootstrap.statusCode, reloadBootstrap.body).toBe(200)
    expect(reloadBootstrap.json().pendingGenerationEffects).toContainEqual(
      expect.objectContaining({
        generationId: seeded.generationId,
        kind: 'igp',
        status: 'pending',
      }),
    )
    harness.db
      .prepare(
        `UPDATE generation_effects SET lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'`,
      )
      .run(harness.lineage, seeded.generationId)

    const deferredIgp = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/claims`,
      headers,
      payload: { delivery: 'late_recovery', messageId: seeded.messageId },
    })
    expect(deferredIgp.statusCode, deferredIgp.body).toBe(200)
    expect(deferredIgp.json()).toMatchObject({
      status: 'not_claimed',
      reason: 'generated_translation_prerequisite_pending',
      effect: { kind: 'igp', status: 'pending' },
    })
    expect(providerRequests).toHaveLength(1)

    releaseTranslation()
    await vi.waitFor(() => {
      expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'generated_translation', status: 'completed', delivery: 'server' }),
          expect.objectContaining({ kind: 'igp', status: 'pending' }),
        ]),
      )
      expect(resolveActiveMessageLocationById(harness.db, seeded.messageId)).toMatchObject({
        ok: true,
        location: { message: { data: 'Reply', translation: { text: 'Translated reply' } } },
      })
    })

    const claimedIgp = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/claims`,
      headers,
      payload: { delivery: 'late_recovery', messageId: seeded.messageId },
    })
    expect(claimedIgp.statusCode, claimedIgp.body).toBe(201)
    const claimId = claimedIgp.json().claimId as string
    const completion = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/completion`,
      headers,
      payload: { claimId },
    })
    expect(completion.statusCode, completion.body).toBe(200)
    expect(completion.json()).toMatchObject({ type: 'success', result: 'IGP-SNAPSHOT' })

    const baseRevision = getSchemaState(harness.db).revision
    const committed = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/commit`,
      headers,
      payload: {
        baseRevision,
        claimId,
        data: 'Reply[IGP-SNAPSHOT]',
        expectedData: 'Reply',
        expectedGenerationId: seeded.generationId,
      },
    })
    expect(committed.statusCode, committed.body).toBe(200)
    expect(providerRequests).toHaveLength(2)
    expect(resolveActiveMessageLocationById(harness.db, seeded.messageId)).toMatchObject({
      ok: true,
      location: {
        message: {
          data: 'Reply[IGP-SNAPSHOT]',
          // IGP changes the source text after translation has durably settled,
          // so the ordinary message patch intentionally clears that now-stale
          // translation instead of letting IGP make the provider write fail.
          translation: null,
        },
      },
    })
    expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'generated_translation', status: 'completed' }),
        expect.objectContaining({ kind: 'igp', status: 'completed', claimId }),
      ]),
    )
  })

  it('keeps recovered IGP behind a durable image preparation after translation settles first', async () => {
    const harness = await openRouteHarness()
    registerDatabaseWriterSession(harness.db, 'owner-a')
    const seeded = seedChatOnlyCompletion(harness, {
      sessionId: 'owner-a',
      claimClass: 'owner',
      terminalData: 'Reply <ImgGen="happy cat">',
    })
    installAcceptedIgpConfiguration(
      harness,
      seeded,
      [{ role: 'user', data: 'Accepted user message', chatId: 'accepted-message-a' }],
      {
        autoTranslate: true,
        inlayMode: 'imggen',
        translationDeferCapSeconds: 1,
        persistLiveConfiguration: true,
      },
    )
    const imageAssetId = 'a'.repeat(64)
    harness.db
      .prepare('INSERT INTO assets (id, ext, size, content_type) VALUES (?, ?, ?, ?)')
      .run(imageAssetId, 'png', 1, 'image/png')

    let announceTranslationStarted!: () => void
    const translationStarted = new Promise<void>((resolve) => {
      announceTranslationStarted = resolve
    })
    let releaseTranslation!: () => void
    const translationGate = new Promise<void>((resolve) => {
      releaseTranslation = resolve
    })
    const providerRequests: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        providerRequests.push(body)
        if (providerRequests.length === 1) {
          announceTranslationStarted()
          await translationGate
        }
        const content = providerRequests.length === 1 ? 'Translated reply' : 'IGP-SNAPSHOT'
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    const jobs = new MessageTranslationJobRegistry()
    const translationSweep = retryPendingGenerationCompletionEffects({
      db: harness.db,
      dataDir: harness.config.dataDir,
      eventSink: harness.commandEvents,
      messageTranslationJobs: jobs,
      runMessageTranslation: runServerMessageTranslation,
    })
    await translationStarted
    await expect(translationSweep).resolves.toBe(1)
    expect(providerRequests).toHaveLength(1)

    const headers = {
      'risu-auth': harness.assertion,
      'risu-writer-session': seeded.sessionId,
      'risu-database-lineage': harness.lineage,
    }
    const preparationId = 'held-image-preparation-a'
    const preparationBaseRevision = getSchemaState(harness.db).revision
    const preparationPayload = {
      baseRevision: preparationBaseRevision,
      operationId: seeded.operationId,
      preparationId,
      expectedData: 'Reply <ImgGen="happy cat">',
    }
    const prepared = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/inlay-preparation`,
      headers,
      payload: preparationPayload,
    })
    expect(prepared.statusCode, prepared.body).toBe(200)
    expect(prepared.json()).toMatchObject({
      chatId: 'chat-a',
      messageId: seeded.messageId,
      preparationId,
      inlayPreparation: 'prepared',
    })
    const preparedReplay = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/inlay-preparation`,
      headers,
      payload: preparationPayload,
    })
    expect(preparedReplay.statusCode, preparedReplay.body).toBe(200)
    expect(preparedReplay.json()).toEqual(prepared.json())

    const reloadBootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': harness.assertion, 'risu-writer-observer-session': seeded.sessionId },
    })
    expect(reloadBootstrap.statusCode, reloadBootstrap.body).toBe(200)
    expect(reloadBootstrap.json().pendingGenerationEffects).toContainEqual(
      expect.objectContaining({
        generationId: seeded.generationId,
        kind: 'igp',
        status: 'pending',
        inlayPreparationId: preparationId,
      }),
    )
    const blockedIgp = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/claims`,
      headers,
      payload: { delivery: 'late_recovery', messageId: seeded.messageId },
    })
    expect(blockedIgp.statusCode, blockedIgp.body).toBe(200)
    expect(blockedIgp.json()).toMatchObject({
      status: 'not_claimed',
      reason: 'generation_inlay_prerequisite_pending',
    })

    releaseTranslation()
    await vi.waitFor(() => {
      expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'generated_translation', status: 'completed', delivery: 'server' }),
          expect.objectContaining({ kind: 'igp', status: 'pending' }),
        ]),
      )
    })
    expect(resolveActiveMessageLocationById(harness.db, seeded.messageId)).toMatchObject({
      ok: true,
      location: {
        message: {
          data: 'Reply <ImgGen="happy cat">',
          translation: {
            text: 'Translated reply',
            sourceHash: createHash('sha256').update('Reply <ImgGen="happy cat">').digest('hex'),
          },
        },
      },
    })

    const stillBlockedIgp = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/claims`,
      headers,
      payload: { delivery: 'late_recovery', messageId: seeded.messageId },
    })
    expect(stillBlockedIgp.statusCode, stillBlockedIgp.body).toBe(200)
    expect(stillBlockedIgp.json()).toMatchObject({
      status: 'not_claimed',
      reason: 'generation_inlay_prerequisite_pending',
    })
    expect(providerRequests).toHaveLength(1)

    const deletedSourceObligation = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/inlay-finalization`,
      headers,
      payload: {
        baseRevision: getSchemaState(harness.db).revision,
        operationId: seeded.operationId,
        preparationId,
        expectedData: 'Reply <ImgGen="happy cat">',
        finalData: 'Reply ',
      },
    })
    expect(deletedSourceObligation.statusCode, deletedSourceObligation.body).toBe(409)
    expect(resolveActiveMessageLocationById(harness.db, seeded.messageId)).toMatchObject({
      ok: true,
      location: { message: { data: 'Reply <ImgGen="happy cat">' } },
    })

    const finalizationPayload = {
      baseRevision: getSchemaState(harness.db).revision,
      operationId: seeded.operationId,
      preparationId,
      expectedData: 'Reply <ImgGen="happy cat">',
      finalData: `Reply {{inlay::${imageAssetId}}}`,
    }
    const finalized = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/inlay-finalization`,
      headers,
      payload: finalizationPayload,
    })
    expect(finalized.statusCode, finalized.body).toBe(200)
    expect(finalized.json()).toMatchObject({
      chatId: 'chat-a',
      messageId: seeded.messageId,
      preparationId,
      inlayFinalization: 'committed',
    })
    const finalizedReplay = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/inlay-finalization`,
      headers,
      payload: finalizationPayload,
    })
    expect(finalizedReplay.statusCode, finalizedReplay.body).toBe(200)
    expect(finalizedReplay.json()).toEqual(finalized.json())
    expect(resolveActiveMessageLocationById(harness.db, seeded.messageId)).toMatchObject({
      ok: true,
      location: {
        message: {
          data: `Reply {{inlay::${imageAssetId}}}`,
          translation: {
            text: 'Translated reply',
            sourceHash: createHash('sha256').update(`Reply {{inlay::${imageAssetId}}}`).digest('hex'),
          },
        },
      },
    })

    const claimedIgp = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/claims`,
      headers,
      payload: { delivery: 'late_recovery', messageId: seeded.messageId },
    })
    expect(claimedIgp.statusCode, claimedIgp.body).toBe(201)
    const claimId = claimedIgp.json().claimId as string
    const completion = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/completion`,
      headers,
      payload: { claimId },
    })
    expect(completion.statusCode, completion.body).toBe(200)
    expect(completion.json()).toMatchObject({ type: 'success', result: 'IGP-SNAPSHOT' })
    const committed = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/commit`,
      headers,
      payload: {
        baseRevision: getSchemaState(harness.db).revision,
        claimId,
        data: `Reply {{inlay::${imageAssetId}}}[IGP-SNAPSHOT]`,
        expectedData: `Reply {{inlay::${imageAssetId}}}`,
        expectedGenerationId: seeded.generationId,
      },
    })
    expect(committed.statusCode, committed.body).toBe(200)
    expect(providerRequests).toHaveLength(2)
    expect(resolveActiveMessageLocationById(harness.db, seeded.messageId)).toMatchObject({
      ok: true,
      location: {
        message: {
          data: `Reply {{inlay::${imageAssetId}}}[IGP-SNAPSHOT]`,
          translation: null,
        },
      },
    })
    expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'generated_translation', status: 'completed' }),
        expect.objectContaining({ kind: 'igp', status: 'completed', claimId }),
      ]),
    )
    const messageUpdateRevisions = harness.commandEvents
      .list()
      .filter((event) => event.type === 'message.updated' && event.id === seeded.messageId)
      .map((event) => event.revision)
    expect(messageUpdateRevisions).toHaveLength(4)
    expect(messageUpdateRevisions).toEqual([...messageUpdateRevisions].sort((a, b) => a - b))
  })

  it('abandons only the exact owner preparation after source drift and leaves no IGP occupancy pin', async () => {
    const harness = await openRouteHarness()
    registerDatabaseWriterSession(harness.db, 'owner-a')
    const seeded = seedChatOnlyCompletion(harness, {
      sessionId: 'owner-a',
      claimClass: 'owner',
      terminalData: 'Reply <Emotion="happy">',
    })
    installAcceptedIgpConfiguration(
      harness,
      seeded,
      [{ role: 'user', data: 'Accepted user message', chatId: 'accepted-message-a' }],
      { inlayMode: 'emotion' },
    )
    skipGeneratedTranslation(harness, seeded)
    const headers = {
      'risu-auth': harness.assertion,
      'risu-writer-session': seeded.sessionId,
      'risu-database-lineage': harness.lineage,
    }
    const preparationId = 'source-drift-preparation-a'
    const prepared = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/inlay-preparation`,
      headers,
      payload: {
        baseRevision: getSchemaState(harness.db).revision,
        operationId: seeded.operationId,
        preparationId,
        expectedData: 'Reply <Emotion="happy">',
      },
    })
    expect(prepared.statusCode, prepared.body).toBe(200)

    const wrongPreparation = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/inlay-finalization`,
      headers,
      payload: {
        baseRevision: getSchemaState(harness.db).revision,
        operationId: seeded.operationId,
        preparationId: 'different-preparation-a',
        expectedData: 'Reply <Emotion="happy">',
        finalData: 'Reply {{emotion::happy}}',
      },
    })
    expect(wrongPreparation.statusCode, wrongPreparation.body).toBe(409)

    expect(updateActiveMessageById(harness.db, seeded.messageId, { data: 'Owner edited newer reply' })).toMatchObject({
      ok: true,
    })
    const abandonmentPayload = {
      baseRevision: getSchemaState(harness.db).revision,
      operationId: seeded.operationId,
      preparationId,
    }
    const abandoned = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/inlay-abandonment`,
      headers,
      payload: abandonmentPayload,
    })
    expect(abandoned.statusCode, abandoned.body).toBe(200)
    expect(abandoned.json()).toMatchObject({
      chatId: 'chat-a',
      messageId: seeded.messageId,
      preparationId,
      inlayPreparation: 'abandoned',
    })
    const abandonedReplay = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/inlay-abandonment`,
      headers,
      payload: abandonmentPayload,
    })
    expect(abandonedReplay.statusCode, abandonedReplay.body).toBe(200)
    expect(abandonedReplay.json()).toEqual(abandoned.json())

    expect(
      listGenerationEffects(harness.db, seeded.generationId, harness.lineage).find((effect) => effect.kind === 'igp'),
    ).not.toHaveProperty('inlayPreparationId')
    const claimed = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/claims`,
      headers,
      payload: { delivery: 'late_recovery', messageId: seeded.messageId },
    })
    expect(claimed.statusCode, claimed.body).toBe(201)
    expect(claimed.json()).toMatchObject({ status: 'claimed' })
    expect(resolveActiveMessageLocationById(harness.db, seeded.messageId)).toMatchObject({
      ok: true,
      location: { message: { data: 'Owner edited newer reply' } },
    })
  })

  it('lets the originating owner abandon its exact preparation after a role transfer', async () => {
    const harness = await openRouteHarness()
    registerDatabaseWriterSession(harness.db, 'owner-a')
    const seeded = seedChatOnlyCompletion(harness, {
      sessionId: 'owner-a',
      claimClass: 'owner',
      terminalData: 'Reply <Emotion="happy">',
    })
    installAcceptedIgpConfiguration(
      harness,
      seeded,
      [{ role: 'user', data: 'Accepted user message', chatId: 'accepted-message-a' }],
      { inlayMode: 'emotion' },
    )
    skipGeneratedTranslation(harness, seeded)
    const oldHeaders = {
      'risu-auth': harness.assertion,
      'risu-writer-session': seeded.sessionId,
      'risu-database-lineage': harness.lineage,
    }
    const preparationId = 'transferred-preparation-a'
    const prepared = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/inlay-preparation`,
      headers: oldHeaders,
      payload: {
        baseRevision: getSchemaState(harness.db).revision,
        operationId: seeded.operationId,
        preparationId,
        expectedData: 'Reply <Emotion="happy">',
      },
    })
    expect(prepared.statusCode, prepared.body).toBe(200)

    registerDatabaseWriterSession(harness.db, 'owner-b')
    const normalized = harness.chatOccupancy.normalize({
      databaseLineage: harness.lineage,
      chatId: 'chat-a',
      sessionId: seeded.sessionId,
      occupancyEpoch: seeded.generationScope.occupancyEpoch!,
    })
    expect(normalized).toMatchObject({ occupantSessionId: seeded.sessionId, claimClass: 'chat_only' })
    const freshBootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: {
        'risu-auth': harness.assertion,
        'risu-writer-observer-session': seeded.sessionId,
      },
    })
    expect(freshBootstrap.statusCode, freshBootstrap.body).toBe(200)
    expect(freshBootstrap.json().pendingGenerationEffects).toContainEqual(
      expect.objectContaining({
        generationId: seeded.generationId,
        kind: 'igp',
        inlayPreparationId: preparationId,
      }),
    )

    const payload = {
      baseRevision: getSchemaState(harness.db).revision,
      operationId: seeded.operationId,
      preparationId,
    }
    const foreign = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/inlay-abandonment`,
      headers: { ...oldHeaders, 'risu-writer-session': 'owner-b' },
      payload,
    })
    expect(foreign.statusCode, foreign.body).toBe(423)
    expect(foreign.json()).toEqual({ error: 'generation_effect_foreign_session' })
    const abandoned = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/inlay-abandonment`,
      headers: oldHeaders,
      payload,
    })
    expect(abandoned.statusCode, abandoned.body).toBe(200)
    expect(abandoned.json()).toMatchObject({ inlayPreparation: 'abandoned', preparationId })
    const replay = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/inlay-abandonment`,
      headers: oldHeaders,
      payload,
    })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(abandoned.json())
    expect(
      listGenerationEffects(harness.db, seeded.generationId, harness.lineage).find((effect) => effect.kind === 'igp'),
    ).not.toHaveProperty('inlayPreparationId')
    const igpClaim = claimGenerationEffect(harness.db, {
      databaseLineage: harness.lineage,
      generationId: seeded.generationId,
      kind: 'igp',
      delivery: 'late_recovery',
      messageId: seeded.messageId,
    })
    if (igpClaim.status !== 'claimed') throw new Error('expected IGP recovery claim after abandonment')
    settleGenerationEffect(harness.db, {
      databaseLineage: harness.lineage,
      generationId: seeded.generationId,
      kind: 'igp',
      claimId: igpClaim.claimId,
      status: 'skipped',
      reason: 'test_recovery_settled',
    })
    expect(
      harness.chatOccupancy.release({
        databaseLineage: harness.lineage,
        chatId: 'chat-a',
        sessionId: seeded.sessionId,
        occupancyEpoch: normalized.occupancyEpoch,
      }),
    ).toMatchObject({ occupantSessionId: null })
  })

  it('fails IGP closed on a malformed durable preparation marker', async () => {
    const harness = await openRouteHarness()
    registerDatabaseWriterSession(harness.db, 'owner-a')
    const seeded = seedChatOnlyCompletion(harness, {
      sessionId: 'owner-a',
      claimClass: 'owner',
      terminalData: 'Reply <Emotion="happy">',
    })
    installAcceptedIgpConfiguration(
      harness,
      seeded,
      [{ role: 'user', data: 'Accepted user message', chatId: 'accepted-message-a' }],
      { inlayMode: 'emotion' },
    )
    skipGeneratedTranslation(harness, seeded)
    harness.db
      .prepare(
        `UPDATE generation_effects
         SET inlay_preparation_id = ?, inlay_preparation_expected_data = NULL
         WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'igp'`,
      )
      .run('malformed-preparation-a', harness.lineage, seeded.generationId)

    const blocked = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/claims`,
      headers: {
        'risu-auth': harness.assertion,
        'risu-writer-session': seeded.sessionId,
        'risu-database-lineage': harness.lineage,
      },
      payload: { delivery: 'late_recovery', messageId: seeded.messageId },
    })
    expect(blocked.statusCode, blocked.body).toBe(200)
    expect(blocked.json()).toMatchObject({
      status: 'not_claimed',
      reason: 'generation_inlay_preparation_invalid',
    })
    expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'igp', status: 'pending' })]),
    )
  })

  it('drains a deferred owner inlay through the failed translation terminal before allowing IGP', async () => {
    const harness = await openRouteHarness()
    registerDatabaseWriterSession(harness.db, 'owner-a')
    const seeded = seedChatOnlyCompletion(harness, {
      sessionId: 'owner-a',
      claimClass: 'owner',
      terminalData: 'Reply <Emotion="sad">',
    })
    installAcceptedIgpConfiguration(
      harness,
      seeded,
      [{ role: 'user', data: 'Accepted user message', chatId: 'accepted-message-a' }],
      {
        autoTranslate: true,
        inlayMode: 'emotion',
        translationDeferCapSeconds: 1,
        persistLiveConfiguration: true,
      },
    )

    let announceTranslationStarted!: () => void
    const translationStarted = new Promise<void>((resolve) => {
      announceTranslationStarted = resolve
    })
    let releaseTranslation!: () => void
    const translationGate = new Promise<void>((resolve) => {
      releaseTranslation = resolve
    })
    let providerCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        providerCount += 1
        if (providerCount === 1) {
          announceTranslationStarted()
          await translationGate
          throw new Error('synthetic held translation failure')
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'IGP-AFTER-FAILURE' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    const jobs = new MessageTranslationJobRegistry()
    const sweep = retryPendingGenerationCompletionEffects({
      db: harness.db,
      dataDir: harness.config.dataDir,
      eventSink: harness.commandEvents,
      messageTranslationJobs: jobs,
      runMessageTranslation: runServerMessageTranslation,
    })
    await translationStarted
    await expect(sweep).resolves.toBe(1)

    const headers = {
      'risu-auth': harness.assertion,
      'risu-writer-session': seeded.sessionId,
      'risu-database-lineage': harness.lineage,
    }
    const inlay = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/messages/${seeded.messageId}`,
      headers,
      payload: {
        baseRevision: getSchemaState(harness.db).revision,
        patch: { data: 'Reply {{emotion::sad}}' },
        expectedData: 'Reply <Emotion="sad">',
        expectedChatId: 'chat-a',
        generationInlayFinalization: {
          generationId: seeded.generationId,
          operationId: seeded.operationId,
        },
      },
    })
    expect(inlay.statusCode, inlay.body).toBe(200)
    expect(inlay.json()).toMatchObject({ inlayFinalization: 'deferred' })

    releaseTranslation()
    await vi.waitFor(() => {
      expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'generated_translation', status: 'failed' }),
          expect.objectContaining({ kind: 'igp', status: 'pending' }),
        ]),
      )
    })
    expect(resolveActiveMessageLocationById(harness.db, seeded.messageId)).toMatchObject({
      ok: true,
      location: { message: { data: 'Reply {{emotion::sad}}' } },
    })
    expect(
      harness.db
        .prepare(
          `SELECT deferred_inlay_expected_data AS expectedData, deferred_inlay_final_data AS finalData
           FROM generation_effects
           WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'`,
        )
        .get(harness.lineage, seeded.generationId),
    ).toEqual({ expectedData: null, finalData: null })

    const claimedIgp = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/claims`,
      headers,
      payload: { delivery: 'late_recovery', messageId: seeded.messageId },
    })
    expect(claimedIgp.statusCode, claimedIgp.body).toBe(201)
    const claimId = claimedIgp.json().claimId as string
    const completion = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/completion`,
      headers,
      payload: { claimId },
    })
    expect(completion.statusCode, completion.body).toBe(200)
    expect(completion.json()).toMatchObject({ type: 'success', result: 'IGP-AFTER-FAILURE' })
    const committed = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/generation-effects/${seeded.generationId}/igp/commit`,
      headers,
      payload: {
        baseRevision: getSchemaState(harness.db).revision,
        claimId,
        data: 'Reply {{emotion::sad}}[IGP-AFTER-FAILURE]',
        expectedData: 'Reply {{emotion::sad}}',
        expectedGenerationId: seeded.generationId,
      },
    })
    expect(committed.statusCode, committed.body).toBe(200)
    expect(providerCount).toBe(2)
    expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'generated_translation', status: 'failed' }),
        expect.objectContaining({ kind: 'igp', status: 'completed', claimId }),
      ]),
    )
  })

  it('terminalizes a held generated translation and deferred inlay after the owner edits its source', async () => {
    const harness = await openRouteHarness()
    registerDatabaseWriterSession(harness.db, 'owner-a')
    const seeded = seedChatOnlyCompletion(harness, {
      sessionId: 'owner-a',
      claimClass: 'owner',
      terminalData: 'Reply <Emotion="calm">',
    })
    installAcceptedIgpConfiguration(
      harness,
      seeded,
      [{ role: 'user', data: 'Accepted user message', chatId: 'accepted-message-a' }],
      {
        autoTranslate: true,
        inlayMode: 'emotion',
        translationDeferCapSeconds: 1,
        persistLiveConfiguration: true,
      },
    )

    let announceTranslationStarted!: () => void
    const translationStarted = new Promise<void>((resolve) => {
      announceTranslationStarted = resolve
    })
    let releaseTranslation!: () => void
    const translationGate = new Promise<void>((resolve) => {
      releaseTranslation = resolve
    })
    let providerCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        providerCount += 1
        announceTranslationStarted()
        await translationGate
        return new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Translated reply' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    const jobs = new MessageTranslationJobRegistry()
    const sweep = retryPendingGenerationCompletionEffects({
      db: harness.db,
      dataDir: harness.config.dataDir,
      eventSink: harness.commandEvents,
      messageTranslationJobs: jobs,
      runMessageTranslation: runServerMessageTranslation,
    })
    await translationStarted
    await expect(sweep).resolves.toBe(1)

    const headers = {
      'risu-auth': harness.assertion,
      'risu-writer-session': seeded.sessionId,
      'risu-database-lineage': harness.lineage,
    }
    const deferred = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/messages/${seeded.messageId}`,
      headers,
      payload: {
        baseRevision: getSchemaState(harness.db).revision,
        patch: { data: 'Reply {{emotion::calm}}' },
        expectedData: 'Reply <Emotion="calm">',
        expectedChatId: 'chat-a',
        generationInlayFinalization: {
          generationId: seeded.generationId,
          operationId: seeded.operationId,
        },
      },
    })
    expect(deferred.statusCode, deferred.body).toBe(200)
    expect(deferred.json()).toMatchObject({ inlayFinalization: 'deferred' })
    const edited = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/messages/${seeded.messageId}`,
      headers,
      payload: {
        baseRevision: getSchemaState(harness.db).revision,
        patch: { data: 'Owner edited while translation ran', translation: null },
      },
    })
    expect(edited.statusCode, edited.body).toBe(200)

    releaseTranslation()
    await vi.waitFor(() => {
      expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'generated_translation',
            status: 'failed',
            reason: DEFERRED_GENERATION_INLAY_TARGET_STALE,
            lastError: expect.stringContaining('Message changed before translation could be saved'),
          }),
          expect.objectContaining({
            kind: 'igp',
            status: 'skipped',
            reason: DEFERRED_GENERATION_INLAY_TARGET_STALE,
          }),
        ]),
      )
    })
    expect(providerCount).toBe(1)
    expect(resolveActiveMessageLocationById(harness.db, seeded.messageId)).toMatchObject({
      ok: true,
      location: { message: { data: 'Owner edited while translation ran', translation: null } },
    })
    expect(
      harness.chatOccupancy.release({
        databaseLineage: harness.lineage,
        chatId: 'chat-a',
        sessionId: seeded.sessionId,
        occupancyEpoch: seeded.generationScope.occupancyEpoch!,
      }),
    ).toMatchObject({ occupantSessionId: null })
  })

  it('distinguishes stale transcript drift from a corrupt deferred-inlay sibling binding', async () => {
    const harness = await openRouteHarness()
    registerDatabaseWriterSession(harness.db, 'owner-a')
    const seeded = seedChatOnlyCompletion(harness, {
      sessionId: 'owner-a',
      claimClass: 'owner',
      terminalData: 'Reply <Emotion="calm">',
    })
    installAcceptedIgpConfiguration(
      harness,
      seeded,
      [{ role: 'user', data: 'Accepted user message', chatId: 'accepted-message-a' }],
      { autoTranslate: true, inlayMode: 'emotion', persistLiveConfiguration: true },
    )
    const claim = claimGenerationEffect(harness.db, {
      databaseLineage: harness.lineage,
      generationId: seeded.generationId,
      kind: 'generated_translation',
      delivery: 'server',
      messageId: seeded.messageId,
    })
    if (claim.status !== 'claimed') throw new Error('expected generated translation claim')
    const headers = {
      'risu-auth': harness.assertion,
      'risu-writer-session': seeded.sessionId,
      'risu-database-lineage': harness.lineage,
    }
    const deferred = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/messages/${seeded.messageId}`,
      headers,
      payload: {
        baseRevision: getSchemaState(harness.db).revision,
        patch: { data: 'Reply {{emotion::calm}}' },
        expectedData: 'Reply <Emotion="calm">',
        expectedChatId: 'chat-a',
        generationInlayFinalization: {
          generationId: seeded.generationId,
          operationId: seeded.operationId,
        },
      },
    })
    expect(deferred.statusCode, deferred.body).toBe(200)

    const editedHistory = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/accepted-message-a',
      headers,
      payload: {
        baseRevision: getSchemaState(harness.db).revision,
        patch: { data: 'Owner revised the earlier prompt' },
      },
    })
    expect(editedHistory.statusCode, editedHistory.body).toBe(200)
    expect(
      deferredGenerationInlayFinalizationDisposition(harness.db, {
        databaseLineage: harness.lineage,
        generationId: seeded.generationId,
      }),
    ).toBe('stale')

    harness.db
      .prepare(
        `UPDATE generation_effects SET occupancy_epoch = occupancy_epoch + 1
         WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'`,
      )
      .run(harness.lineage, seeded.generationId)
    expect(
      deferredGenerationInlayFinalizationDisposition(harness.db, {
        databaseLineage: harness.lineage,
        generationId: seeded.generationId,
      }),
    ).toBe('invalid')
    expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'generated_translation', status: 'claimed' }),
        expect.objectContaining({ kind: 'igp', status: 'pending' }),
      ]),
    )

    harness.db
      .prepare(
        `UPDATE generation_effects SET occupancy_epoch = occupancy_epoch - 1
         WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'`,
      )
      .run(harness.lineage, seeded.generationId)
    expect(
      deferredGenerationInlayFinalizationDisposition(harness.db, {
        databaseLineage: harness.lineage,
        generationId: seeded.generationId,
      }),
    ).toBe('stale')

    const translated = {
      text: 'Translated reply',
      source: 'raw',
      sourceHash: createHash('sha256').update('Reply <Emotion="calm">').digest('hex'),
    }
    harness.db.exec('BEGIN IMMEDIATE')
    let committed = false
    try {
      expect(updateActiveMessageById(harness.db, seeded.messageId, { translation: translated })).toMatchObject({
        ok: true,
      })
      expect(
        settleGenerationEffect(harness.db, {
          databaseLineage: harness.lineage,
          generationId: seeded.generationId,
          kind: 'generated_translation',
          claimId: claim.claimId,
          status: 'completed',
        }),
      ).toMatchObject({ status: 'completed' })
      expect(
        commitDeferredGenerationInlayFinalizationInTransaction(harness.db, {
          databaseLineage: harness.lineage,
          generationId: seeded.generationId,
        }),
      ).toBe('stale')
      harness.db.exec('COMMIT')
      committed = true
    } finally {
      if (!committed) harness.db.exec('ROLLBACK')
    }
    expect(resolveActiveMessageLocationById(harness.db, 'accepted-message-a')).toMatchObject({
      ok: true,
      location: { message: { data: 'Owner revised the earlier prompt' } },
    })
    expect(resolveActiveMessageLocationById(harness.db, seeded.messageId)).toMatchObject({
      ok: true,
      location: { message: { data: 'Reply <Emotion="calm">', translation: translated } },
    })
    expect(listGenerationEffects(harness.db, seeded.generationId, harness.lineage)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'generated_translation',
          status: 'completed',
          reason: DEFERRED_GENERATION_INLAY_TARGET_STALE,
        }),
        expect.objectContaining({
          kind: 'igp',
          status: 'skipped',
          reason: DEFERRED_GENERATION_INLAY_TARGET_STALE,
        }),
      ]),
    )
  })

  it('retires stale deferred owner inlay and IGP before an expired translation claim can redispatch on reopen', async () => {
    const harness = await openRouteHarness()
    registerDatabaseWriterSession(harness.db, 'owner-a')
    const seeded = seedChatOnlyCompletion(harness, {
      sessionId: 'owner-a',
      claimClass: 'owner',
      terminalData: 'Reply <Emotion="calm">',
    })
    installAcceptedIgpConfiguration(
      harness,
      seeded,
      [{ role: 'user', data: 'Accepted user message', chatId: 'accepted-message-a' }],
      {
        autoTranslate: true,
        inlayMode: 'emotion',
        translationDeferCapSeconds: 1,
        persistLiveConfiguration: true,
      },
    )
    const translationClaim = claimGenerationEffect(harness.db, {
      databaseLineage: harness.lineage,
      generationId: seeded.generationId,
      kind: 'generated_translation',
      delivery: 'server',
      messageId: seeded.messageId,
    })
    if (translationClaim.status !== 'claimed') throw new Error('expected generated translation claim')

    const headers = {
      'risu-auth': harness.assertion,
      'risu-writer-session': seeded.sessionId,
      'risu-database-lineage': harness.lineage,
    }
    const deferred = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/messages/${seeded.messageId}`,
      headers,
      payload: {
        baseRevision: getSchemaState(harness.db).revision,
        patch: { data: 'Reply {{emotion::calm}}' },
        expectedData: 'Reply <Emotion="calm">',
        expectedChatId: 'chat-a',
        generationInlayFinalization: {
          generationId: seeded.generationId,
          operationId: seeded.operationId,
        },
      },
    })
    expect(deferred.statusCode, deferred.body).toBe(200)
    expect(deferred.json()).toMatchObject({ inlayFinalization: 'deferred' })
    expect(
      deferredGenerationInlayFinalizationDisposition(harness.db, {
        databaseLineage: harness.lineage,
        generationId: seeded.generationId,
      }),
    ).toBe('ready')

    const edited = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/messages/${seeded.messageId}`,
      headers,
      payload: {
        baseRevision: getSchemaState(harness.db).revision,
        patch: { data: 'Owner edited newer reply', translation: null },
      },
    })
    expect(edited.statusCode, edited.body).toBe(200)
    expect(
      deferredGenerationInlayFinalizationDisposition(harness.db, {
        databaseLineage: harness.lineage,
        generationId: seeded.generationId,
      }),
    ).toBe('stale')
    harness.db
      .prepare(
        `UPDATE generation_effects SET lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'`,
      )
      .run(harness.lineage, seeded.generationId)

    const dataDir = harness.config.dataDir
    const lineage = harness.lineage
    const occupancyEpoch = seeded.generationScope.occupancyEpoch!
    await harness.app.close()
    apps.splice(apps.indexOf(harness.app), 1)

    const runMessageTranslation = vi.fn(async () => {
      throw new Error('stale deferred translation must not redispatch')
    })
    const reopened = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir,
        bodyLimit: 1024 * 1024,
        importMaxBytes: Infinity,
        trustProxy: false,
        hubUrl: 'https://sv.risuai.xyz',
      },
      chatOccupancy: { enabled: true },
      memoryWorker: false,
      bardWikiWorker: false,
      assetGc: false,
      generationChat: { finalizationRetry: false, runMessageTranslation },
    })
    apps.push(reopened.app)
    await vi.waitFor(() => {
      expect(listGenerationEffects(reopened.chatOccupancy.db, seeded.generationId, lineage)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'generated_translation',
            status: 'failed',
            reason: DEFERRED_GENERATION_INLAY_TARGET_STALE,
            lastError: 'Deferred generation inlay target changed before translation recovery',
          }),
          expect.objectContaining({
            kind: 'igp',
            status: 'skipped',
            reason: DEFERRED_GENERATION_INLAY_TARGET_STALE,
          }),
        ]),
      )
    })
    expect(runMessageTranslation).not.toHaveBeenCalled()
    expect(resolveActiveMessageLocationById(reopened.chatOccupancy.db, seeded.messageId)).toMatchObject({
      ok: true,
      location: { message: { data: 'Owner edited newer reply', translation: null } },
    })
    expect(
      reopened.chatOccupancy.db
        .prepare(
          `SELECT deferred_inlay_expected_data AS expectedData, deferred_inlay_final_data AS finalData
           FROM generation_effects
           WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'`,
        )
        .get(lineage, seeded.generationId),
    ).toEqual({ expectedData: null, finalData: null })
    expect(
      reopened.chatOccupancy.release({
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: seeded.sessionId,
        occupancyEpoch,
      }),
    ).toMatchObject({ occupantSessionId: null, occupancyEpoch: occupancyEpoch + 1 })
  })

  it('replays one exact-message translation from the accepted attempt configuration after recovery', async () => {
    const { db, dataDir, lineage } = openTestDatabase()
    try {
      const acceptedDatabase = createInitialDatabase() as unknown as Record<string, unknown>
      Object.assign(acceptedDatabase, {
        translator: 'ko',
        translatorInputLanguage: 'en',
        translatorType: 'llm',
        translatorSendTextAsIs: true,
        translatorPresetId: 'accepted-preset',
        translatorPrompt: 'Accepted {{slot::content}}',
        translatorMaxResponse: 111,
        translatorPresets: [
          {
            id: 'accepted-preset',
            name: 'Accepted preset',
            prompt: 'Accepted {{slot::content}}',
            maxResponse: 111,
          },
        ],
        modelProfiles: [
          {
            id: 'translate-profile',
            name: 'Accepted translator',
            providerId: 'debug-echo',
            modelId: 'debug-echo',
            providerOptions: {
              baseUrl: 'debug://accepted-recovery',
              requestModel: 'accepted-recovery-model',
            },
          },
        ],
        modelRoleProfiles: { translate: { mode: 'profile', profileId: 'translate-profile' } },
        autoTranslateNotificationDeferCapSeconds: 0,
        characters: [
          {
            type: 'character',
            chaId: 'character-a',
            name: 'Character',
            utilityBot: false,
            desc: 'Description',
            notes: '',
            firstMessage: 'Greetings.',
            viewScreen: 'none',
            bias: [],
            emotionImages: [],
            globalLore: [],
            sdData: [],
            customscript: [],
            exampleMessage: '',
            creatorNotes: '',
            systemPrompt: '',
            postHistoryInstructions: '',
            alternateGreetings: [],
            tags: [],
            creator: '',
            characterVersion: '',
            personality: '',
            scenario: '',
            firstMsgIndex: -1,
            replaceGlobalNote: '',
            additionalText: '',
            triggerscript: [],
            chatPage: 0,
            chatFolders: [],
            chats: [
              {
                id: 'chat-a',
                name: 'Chat',
                note: '',
                localLore: [],
                autoTranslate: true,
                translatorPresetId: 'accepted-preset',
                message: [
                  {
                    role: 'char',
                    data: 'Generated reply',
                    chatId: 'message-a',
                    generationInfo: {
                      generationId: 'generation-a',
                      databaseLineage: lineage,
                      operationId: 'operation-a',
                      jobId: 'generation-a',
                      effectLedgerKeyType: 'operation',
                      effectLedgerKeyId: 'operation-a',
                      effectLedgerCharacterId: 'character-a',
                      effectLedgerChatId: 'chat-a',
                    },
                  },
                  { role: 'char', data: 'Unrelated reply', chatId: 'message-b' },
                ],
              },
            ],
          },
        ],
        characterOrder: ['character-a'],
      })
      writePersistedWithMessages(db, dataDir, {
        _version: 1,
        database: acceptedDatabase,
        assets: [],
      })
      const acceptedConfiguration = {
        version: 1,
        database: acceptedDatabase,
        translationSettings: { translatorPresets: acceptedDatabase.translatorPresets },
        promptInfo: {},
        resolvedMainProfile: {},
      }
      const effectiveConfigurationFingerprint = generationEffectiveConfigurationFingerprint(acceptedConfiguration)
      const occupancy = new ChatOccupancyService(db).claim({
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: 'session-a',
        claimClass: 'chat_only',
        expectedOccupancyEpoch: 0,
      })
      const generationScope = admitGenerationInTransaction(db, {
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: 'session-a',
        occupancyProtocolVersion: 1,
        occupancyEpoch: occupancy.occupancyEpoch,
        interaction: 'send',
        chatOnlyEnabled: true,
      })
      const operation = createGenerationOperation(db, {
        databaseLineage: lineage,
        operationId: 'operation-a',
        protocolVersion: 1,
        requestOrigin: 'accepted_send',
        creatorWriterSessionId: 'session-a',
        creatorWriterEpoch: 0,
        generationScope,
        effectiveConfiguration: acceptedConfiguration,
        effectiveConfigurationFingerprint,
        bindingServerInstanceId: 'server-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        mode: 'send',
        acceptedMessageId: 'accepted-message-a',
        requestFingerprint: 'request-a',
        intent: { message: 'accepted' },
        acceptedRevision: 0,
        state: 'accepted',
      })
      const attempt = reserveGenerationOperationAttempt(db, {
        databaseLineage: lineage,
        operationId: 'operation-a',
        expectedState: 'accepted',
        expectedStateVersion: operation.stateVersion,
        retryRequestId: 'retry-a',
        jobId: 'job-a',
        serverInstanceId: 'server-a',
        actorWriterSessionId: 'session-a',
        actorWriterEpoch: 0,
        launchRevision: 0,
      })
      expect(attempt.status).toBe('applied')
      db.prepare(
        `UPDATE generation_operation_attempts
         SET status = 'completed', finalization_generation_id = 'generation-a'
         WHERE database_lineage = ? AND operation_id = 'operation-a' AND attempt_no = 1`,
      ).run(lineage)
      db.prepare(
        `UPDATE generation_operations
         SET state = 'completed', current_attempt_no = NULL,
             result_message_id = 'message-a', terminal_at = ?
         WHERE database_lineage = ? AND operation_id = 'operation-a'`,
      ).run(new Date().toISOString(), lineage)
      ensureGenerationEffectLedger(db, {
        databaseLineage: lineage,
        operationId: 'operation-a',
        operationAttemptNo: 1,
        operationProtocolVersion: 1,
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-a',
        generationScope,
      })

      const liveDatabase = structuredClone(acceptedDatabase)
      liveDatabase.translator = 'ja'
      liveDatabase.translatorPrompt = 'Later {{slot::content}}'
      liveDatabase.translatorMaxResponse = 222
      liveDatabase.translatorPresets = [
        {
          id: 'accepted-preset',
          name: 'Later preset',
          prompt: 'Later {{slot::content}}',
          maxResponse: 222,
        },
      ]
      liveDatabase.modelProfiles = [
        {
          id: 'translate-profile',
          name: 'Later translator',
          providerId: 'debug-echo',
          modelId: 'debug-echo',
          providerOptions: {
            baseUrl: 'debug://later-recovery',
            requestModel: 'later-recovery-model',
          },
        },
      ]
      writeSettingsOnly(db, extractSettings(liveDatabase))
      writeSingleCollectionTable(db, 'translatorPresets', liveDatabase.translatorPresets as readonly unknown[])
      const runMessageTranslation = vi.fn(runServerMessageTranslation)
      const args = {
        db,
        dataDir,
        eventSink: createCommandEventSink(),
        messageTranslationJobs: new MessageTranslationJobRegistry(),
        runMessageTranslation,
      }

      await expect(retryPendingGenerationCompletionEffects(args)).resolves.toBe(1)
      await expect(retryPendingGenerationCompletionEffects(args)).resolves.toBe(0)

      expect(runMessageTranslation).toHaveBeenCalledTimes(1)
      expect(runMessageTranslation.mock.calls[0]![0]).toMatchObject({
        messageId: 'message-a',
        acceptedEffectiveConfiguration: {
          translationSettings: {
            translatorPresets: expect.arrayContaining([
              expect.objectContaining({ prompt: 'Accepted {{slot::content}}' }),
            ]),
          },
          database: {
            translator: 'ko',
            modelProfiles: expect.arrayContaining([
              expect.objectContaining({
                id: 'translate-profile',
                providerOptions: {
                  baseUrl: 'debug://accepted-recovery',
                  requestModel: 'accepted-recovery-model',
                },
              }),
            ]),
          },
        },
      })
      const acceptedCharacter = (acceptedDatabase.characters as Array<Record<string, unknown>>)[0]!
      const acceptedChat = (acceptedCharacter.chats as Array<Record<string, unknown>>)[0]!
      const liveCharacter = (liveDatabase.characters as Array<Record<string, unknown>>)[0]!
      const liveChat = (liveCharacter.chats as Array<Record<string, unknown>>)[0]!
      const acceptedSettingsHash = resolveRawMessageTranslatorIdentity({
        settings: acceptedDatabase,
        character: acceptedCharacter,
        chat: acceptedChat,
      }).settingsHash
      const liveSettingsHash = resolveRawMessageTranslatorIdentity({
        settings: liveDatabase,
        character: liveCharacter,
        chat: liveChat,
      }).settingsHash
      expect(acceptedSettingsHash).not.toBe(liveSettingsHash)
      const translated = resolveActiveMessageLocationById(db, 'message-a')
      expect(translated.ok).toBe(true)
      if (translated.ok) {
        expect(translated.location.message.translation).toMatchObject({
          targetLanguage: 'ko',
          settingsHash: acceptedSettingsHash,
        })
      }
      const unrelated = resolveActiveMessageLocationById(db, 'message-b')
      expect(unrelated.ok).toBe(true)
      if (unrelated.ok) expect(unrelated.location.message.translation).toBeUndefined()
      expect(listGenerationEffects(db, 'generation-a')).toContainEqual(
        expect.objectContaining({
          kind: 'generated_translation',
          status: 'completed',
          delivery: 'server',
        }),
      )
    } finally {
      db.close()
    }
  })

  it('drains a gated startup translation before database close and does not replay its terminal receipt', async () => {
    const harness = await openRouteHarness()
    const seeded = seedChatOnlyCompletion(harness)
    const acceptedDatabase = createInitialDatabase()
    Object.assign(acceptedDatabase, {
      igpPrompt: 'Apply IGP.',
      translator: 'ko',
      translatorType: 'google',
      autoTranslateNotificationDeferCapSeconds: 1,
      characters: [
        {
          type: 'character',
          chaId: 'character-a',
          name: 'Character',
          firstMessage: 'Hello',
          chatPage: 0,
          chatFolders: [],
          chats: [
            {
              id: 'chat-a',
              name: 'Chat',
              note: '',
              localLore: [],
              autoTranslate: true,
              message: [],
            },
          ],
        },
      ],
      characterOrder: ['character-a'],
    })
    const acceptedConfiguration = {
      version: 1,
      database: acceptedDatabase,
      translationSettings: { translator: 'ko', translatorType: 'google' },
      promptInfo: {},
      resolvedMainProfile: {},
    }
    const fingerprint = generationEffectiveConfigurationFingerprint(acceptedConfiguration)
    harness.db
      .prepare(
        `UPDATE generation_operations
         SET effective_configuration_json = ?, effective_configuration_fingerprint = ?
         WHERE database_lineage = ? AND operation_id = ?`,
      )
      .run(JSON.stringify(acceptedConfiguration), fingerprint, harness.lineage, seeded.operationId)
    harness.db
      .prepare(
        `UPDATE generation_operation_attempts SET accepted_effective_configuration_fingerprint = ?
         WHERE database_lineage = ? AND operation_id = ? AND attempt_no = 1`,
      )
      .run(fingerprint, harness.lineage, seeded.operationId)

    const dataDir = harness.config.dataDir
    const lineage = harness.lineage
    await harness.app.close()
    apps.splice(apps.indexOf(harness.app), 1)

    let announceStarted!: () => void
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve
    })
    let releaseTranslation!: () => void
    const translationGate = new Promise<void>((resolve) => {
      releaseTranslation = resolve
    })
    const runMessageTranslation = vi.fn(async () => {
      announceStarted()
      await translationGate
      throw new Error('translation stopped during shutdown')
    })
    const buildReopened = () =>
      buildApp({
        config: {
          host: '127.0.0.1',
          port: 0,
          dataDir,
          bodyLimit: 1024 * 1024,
          importMaxBytes: Infinity,
          trustProxy: false,
          hubUrl: 'https://sv.risuai.xyz',
        },
        chatOccupancy: { enabled: true },
        memoryWorker: false,
        bardWikiWorker: false,
        assetGc: false,
        generationChat: { finalizationRetry: false, runMessageTranslation },
      })
    const reopened = await buildReopened()
    apps.push(reopened.app)
    await started

    // Let the notification defer cap detach the still-running provider from
    // the startup sweep. Shutdown must continue to own the downstream receipt
    // settlement even after the sweep itself has returned.
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100))
    const claimed = openDatabase(dataDir)
    try {
      expect(listGenerationEffects(claimed, seeded.generationId, lineage)).toContainEqual(
        expect.objectContaining({
          kind: 'generated_translation',
          status: 'claimed',
          delivery: 'server',
        }),
      )
    } finally {
      claimed.close()
    }

    let closed = false
    const closing = reopened.app.close().then(() => {
      closed = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)
    releaseTranslation()
    await closing
    apps.splice(apps.indexOf(reopened.app), 1)

    const verify = openDatabase(dataDir)
    try {
      expect(listGenerationEffects(verify, seeded.generationId, lineage)).toContainEqual(
        expect.objectContaining({
          kind: 'generated_translation',
          status: 'failed',
          delivery: 'server',
          lastError: 'translation stopped during shutdown',
        }),
      )
    } finally {
      verify.close()
    }

    const finalReopen = await buildReopened()
    apps.push(finalReopen.app)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(runMessageTranslation).toHaveBeenCalledOnce()
  })

  it('fails a current malformed translation effect instead of using historical live-config compatibility', async () => {
    const { db, dataDir, lineage } = openTestDatabase()
    try {
      const database = createInitialDatabase()
      Object.assign(database, {
        translator: 'ko',
        translatorType: 'google',
        characters: [
          {
            type: 'character',
            chaId: 'character-a',
            name: 'Character',
            firstMessage: 'Hello',
            chatPage: 0,
            chatFolders: [],
            chats: [
              {
                id: 'chat-a',
                name: 'Chat',
                note: '',
                localLore: [],
                autoTranslate: true,
                message: [
                  {
                    role: 'char',
                    data: 'Generated reply',
                    chatId: 'message-a',
                    generationInfo: {
                      generationId: 'generation-a',
                      databaseLineage: lineage,
                      operationId: 'operation-a',
                    },
                  },
                ],
              },
            ],
          },
        ],
        characterOrder: ['character-a'],
      })
      writePersistedWithMessages(db, dataDir, { _version: 1, database, assets: [] })
      const occupancy = new ChatOccupancyService(db).claim({
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: 'session-a',
        claimClass: 'chat_only',
        expectedOccupancyEpoch: 0,
      })
      const generationScope = admitGenerationInTransaction(db, {
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: 'session-a',
        occupancyProtocolVersion: 1,
        occupancyEpoch: occupancy.occupancyEpoch,
        interaction: 'send',
        chatOnlyEnabled: true,
      })
      createGenerationOperation(db, {
        databaseLineage: lineage,
        operationId: 'operation-a',
        protocolVersion: 1,
        requestOrigin: 'accepted_send',
        creatorWriterSessionId: 'session-a',
        creatorWriterEpoch: 0,
        generationScope,
        bindingServerInstanceId: 'server-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        mode: 'send',
        acceptedMessageId: 'accepted-message-a',
        requestFingerprint: 'request-a',
        intent: { message: 'accepted' },
        acceptedRevision: 0,
        state: 'accepted',
      })
      // Manufacture the malformed terminal row directly: current protocol code
      // never completes an accepted operation without a reserved attempt.
      db.prepare(
        `UPDATE generation_operations
         SET state = 'completed', result_message_id = 'message-a'
         WHERE database_lineage = ? AND operation_id = 'operation-a'`,
      ).run(lineage)
      ensureGenerationEffectLedger(db, {
        databaseLineage: lineage,
        operationId: 'operation-a',
        operationProtocolVersion: 1,
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-a',
        generationScope,
      })
      db.prepare(
        `UPDATE generation_effects
         SET occupancy_epoch = occupancy_epoch + 1
         WHERE generation_id = 'generation-a' AND effect_kind = 'generated_translation'`,
      ).run()
      const runMessageTranslation = vi.fn(runServerMessageTranslation)

      await expect(
        retryPendingGenerationCompletionEffects({
          db,
          dataDir,
          eventSink: createCommandEventSink(),
          messageTranslationJobs: new MessageTranslationJobRegistry(),
          runMessageTranslation,
        }),
      ).rejects.toThrow('Generated translation effect operation binding is invalid')
      expect(runMessageTranslation).not.toHaveBeenCalled()
      expect(listGenerationEffects(db, 'generation-a')).toContainEqual(
        expect.objectContaining({
          kind: 'generated_translation',
          status: 'failed',
          delivery: 'server',
          lastError: 'Generated translation effect operation binding is invalid',
        }),
      )
    } finally {
      db.close()
    }
  })
})
