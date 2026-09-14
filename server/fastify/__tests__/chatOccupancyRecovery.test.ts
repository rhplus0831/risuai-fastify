import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { ChatOccupancyService } from '../src/chatOccupancy.js'
import { createCommandEventSink } from '../src/commands/events.js'
import { createInitialDatabase } from '../src/databaseDefaults.js'
import { openDatabase } from '../src/db.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import { ensureGenerationEffectLedger, listGenerationEffects } from '../src/generationEffects.js'
import {
  createGenerationOperation,
  generationEffectiveConfigurationFingerprint,
  getGenerationOperationProjection,
  markGenerationOperationProviderDispatchStarted,
  reconcileExpiredGenerationOccupancyInTransaction,
  reconcileGenerationOperationsAtStartup,
  reserveGenerationOperationAttempt,
  transitionGenerationOperation,
} from '../src/generationOperations.js'
import { admitGenerationInTransaction, listGenerationOccupancyPins } from '../src/generationScope.js'
import { MessageTranslationJobRegistry } from '../src/messageTranslationJobs.js'
import type { MemoryEvent } from '../src/memoryEvents.js'
import { writePersistedWithMessages } from '../src/repository.js'
import { retryPendingGenerationCompletionEffects } from '../src/routes/generationChat.js'
import { runServerMessageTranslation } from '../src/translation/serverMessageTranslation.js'
import { setupAuthedClient } from './helpers/auth.js'

const dataDirs: string[] = []

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
})

function seedInterruptedGeneration(withResult: boolean): {
  dataDir: string
  databaseLineage: string
  occupancyEpoch: number
} {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-chat-occupancy-recovery-'))
  dataDirs.push(dataDir)
  const db = openDatabase(dataDir)
  const databaseLineage = getDatabaseLineage(db)
  db.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, 0, ?)').run(
    'character-a',
    JSON.stringify({ chaId: 'character-a', chats: [] }),
  )
  db.prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, 0, ?)').run(
    'chat-a',
    'character-a',
    JSON.stringify({ id: 'chat-a' }),
  )
  const occupancy = new ChatOccupancyService(db, { now: () => 1_000 })
  const claim = occupancy.claim({
    databaseLineage,
    chatId: 'chat-a',
    sessionId: 'reader-a',
    claimClass: 'chat_only',
    expectedOccupancyEpoch: 0,
  })
  const scope = admitGenerationInTransaction(db, {
    databaseLineage,
    chatId: 'chat-a',
    sessionId: 'reader-a',
    occupancyProtocolVersion: 1,
    occupancyEpoch: claim.occupancyEpoch,
    interaction: 'send',
    chatOnlyEnabled: true,
    nowMs: 1_000,
  })
  db.prepare(
    `INSERT INTO messages (chat_id, seq, uid, role, data, disabled, json, alternate)
     VALUES (?, 0, ?, 'user', 'accepted user', NULL, ?, 0)`,
  ).run('chat-a', 'message-user', JSON.stringify({ chatId: 'message-user', role: 'user', data: 'accepted user' }))
  const effectiveDatabase = createInitialDatabase()
  Object.assign(effectiveDatabase, {
    // Recovery fixtures intentionally need a real durable IGP pin. Blank IGP
    // is terminally classified as not configured when the ledger is created.
    igpPrompt: 'Configured recovery IGP',
    characters: [
      {
        chaId: 'character-a',
        name: 'Character',
        firstMessage: 'Hello',
        chatPage: 0,
        chats: [{ id: 'chat-a', name: 'Chat', autoTranslate: false, message: [] }],
      },
    ],
    characterOrder: ['character-a'],
  })
  const effectiveConfiguration = {
    version: 1,
    database: effectiveDatabase,
    translationSettings: {},
    promptInfo: {},
    resolvedMainProfile: {},
  }
  const accepted = createGenerationOperation(db, {
    databaseLineage,
    operationId: 'operation-a',
    protocolVersion: 1,
    requestOrigin: 'accepted_send',
    creatorWriterSessionId: 'reader-a',
    creatorWriterEpoch: 0,
    generationScope: scope,
    effectiveConfiguration,
    effectiveConfigurationFingerprint: generationEffectiveConfigurationFingerprint(effectiveConfiguration),
    bindingServerInstanceId: 'server-before-restart',
    characterId: 'character-a',
    chatId: 'chat-a',
    mode: 'send',
    acceptedMessageId: 'message-user',
    requestFingerprint: 'a'.repeat(64),
    intent: { mode: 'send' },
    acceptedRevision: 0,
    state: 'accepted',
  })
  const launching = reserveGenerationOperationAttempt(db, {
    databaseLineage,
    operationId: accepted.operationId,
    expectedState: 'accepted',
    expectedStateVersion: accepted.stateVersion,
    retryRequestId: 'retry-a',
    jobId: 'generation-a',
    serverInstanceId: 'server-before-restart',
    actorWriterSessionId: 'reader-a',
    actorWriterEpoch: 0,
    launchRevision: 0,
  })
  if (launching.status === 'stale') throw new Error('attempt reservation failed')
  const running = transitionGenerationOperation(db, {
    databaseLineage,
    operationId: accepted.operationId,
    expectedState: 'launching',
    expectedStateVersion: launching.operation.stateVersion,
    nextState: 'owned_by_job',
  })
  if (running.status === 'stale' || !running.operation.currentAttempt) throw new Error('attempt launch failed')
  markGenerationOperationProviderDispatchStarted(db, {
    databaseLineage,
    operationId: accepted.operationId,
    attemptNo: running.operation.currentAttempt.attemptNo,
    jobId: running.operation.currentAttempt.jobId,
  })
  if (withResult) {
    const result = {
      chatId: 'message-result',
      role: 'char',
      data: 'recoverable result',
      generationInfo: { databaseLineage, operationId: accepted.operationId },
    }
    db.prepare(
      `INSERT INTO messages (chat_id, seq, uid, role, data, disabled, json, alternate)
       VALUES (?, 1, ?, 'char', 'recoverable result', NULL, ?, 0)`,
    ).run('chat-a', 'message-result', JSON.stringify(result))
  }
  ensureGenerationEffectLedger(db, {
    databaseLineage,
    operationId: accepted.operationId,
    operationAttemptNo: running.operation.currentAttempt.attemptNo,
    operationProtocolVersion: 1,
    generationId: 'generation-a',
    characterId: 'character-a',
    chatId: 'chat-a',
    messageId: 'message-result',
    generationScope: scope,
  })
  db.close()
  return { dataDir, databaseLineage, occupancyEpoch: claim.occupancyEpoch }
}

function recoveringService(db: DatabaseSync, nowMs: number): ChatOccupancyService {
  return new ChatOccupancyService(db, {
    now: () => nowMs,
    pinQuery: listGenerationOccupancyPins,
    reconcileExpiredOccupancy: reconcileExpiredGenerationOccupancyInTransaction,
  })
}

describe('expired chat occupancy generation recovery', () => {
  it('keeps a capped server translation pinned across occupancy expiry until exact publication settles', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-chat-occupancy-held-translation-'))
    dataDirs.push(dataDir)
    const db = openDatabase(dataDir)
    let releaseTranslation!: () => void
    const translationGate = new Promise<void>((resolve) => {
      releaseTranslation = resolve
    })
    try {
      const database = createInitialDatabase()
      const translatorPresets = [
        {
          id: 'accepted-preset',
          name: 'Accepted preset',
          prompt: 'Translate {{slot::content}}',
          maxResponse: 111,
        },
      ]
      Object.assign(database, {
        translator: 'ko',
        translatorInputLanguage: 'en',
        translatorType: 'llm',
        translatorSendTextAsIs: true,
        translatorPresetId: 'accepted-preset',
        translatorPresets,
        modelProfiles: [
          {
            id: 'translate-profile',
            name: 'Translation provider',
            providerId: 'debug-echo',
            modelId: 'debug-echo',
            providerOptions: {
              baseUrl: 'debug://held-translation',
              requestModel: 'held-translation-model',
            },
          },
        ],
        modelRoleProfiles: { translate: { mode: 'profile', profileId: 'translate-profile' } },
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
                translatorPresetId: 'accepted-preset',
                message: [
                  {
                    role: 'char',
                    data: 'Generated reply',
                    chatId: 'message-result',
                    generationInfo: {
                      generationId: 'generation-a',
                      databaseLineage: getDatabaseLineage(db),
                      operationId: 'operation-a',
                      operationAttemptNo: 1,
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

      const databaseLineage = getDatabaseLineage(db)
      const occupancy = new ChatOccupancyService(db, { now: () => 1_000 }).claim({
        databaseLineage,
        chatId: 'chat-a',
        sessionId: 'reader-a',
        claimClass: 'chat_only',
        expectedOccupancyEpoch: 0,
      })
      const scope = admitGenerationInTransaction(db, {
        databaseLineage,
        chatId: 'chat-a',
        sessionId: 'reader-a',
        occupancyProtocolVersion: 1,
        occupancyEpoch: occupancy.occupancyEpoch,
        interaction: 'send',
        chatOnlyEnabled: true,
        nowMs: 1_000,
      })
      const acceptedConfiguration = {
        version: 1,
        database,
        translationSettings: { translatorPresets },
        promptInfo: {},
        resolvedMainProfile: {},
      }
      const operation = createGenerationOperation(db, {
        databaseLineage,
        operationId: 'operation-a',
        protocolVersion: 1,
        requestOrigin: 'accepted_send',
        creatorWriterSessionId: 'reader-a',
        creatorWriterEpoch: 0,
        generationScope: scope,
        effectiveConfiguration: acceptedConfiguration,
        effectiveConfigurationFingerprint: generationEffectiveConfigurationFingerprint(acceptedConfiguration),
        bindingServerInstanceId: 'server-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        mode: 'send',
        acceptedMessageId: 'message-user',
        requestFingerprint: 'request-a',
        intent: { message: 'accepted' },
        acceptedRevision: 0,
        state: 'accepted',
      })
      const reservation = reserveGenerationOperationAttempt(db, {
        databaseLineage,
        operationId: operation.operationId,
        expectedState: 'accepted',
        expectedStateVersion: operation.stateVersion,
        retryRequestId: 'retry-a',
        jobId: 'generation-a',
        serverInstanceId: 'server-a',
        actorWriterSessionId: 'reader-a',
        actorWriterEpoch: 0,
        launchRevision: 0,
      })
      if (reservation.status !== 'applied') throw new Error('attempt reservation failed')
      const owned = transitionGenerationOperation(db, {
        databaseLineage,
        operationId: operation.operationId,
        expectedState: 'launching',
        expectedStateVersion: reservation.operation.stateVersion,
        nextState: 'owned_by_job',
      })
      if (owned.status !== 'applied') throw new Error('attempt ownership failed')
      const finalizing = transitionGenerationOperation(db, {
        databaseLineage,
        operationId: operation.operationId,
        expectedState: 'owned_by_job',
        expectedStateVersion: owned.operation.stateVersion,
        nextState: 'finalizing',
        desiredTerminalOutcome: 'completed',
      })
      if (finalizing.status !== 'applied') throw new Error('attempt finalization failed')
      const completed = transitionGenerationOperation(db, {
        databaseLineage,
        operationId: operation.operationId,
        expectedState: 'finalizing',
        expectedStateVersion: finalizing.operation.stateVersion,
        nextState: 'completed',
        resultMessageId: 'message-result',
      })
      if (completed.status !== 'applied') throw new Error('operation completion failed')
      ensureGenerationEffectLedger(db, {
        databaseLineage,
        operationId: operation.operationId,
        operationAttemptNo: 1,
        operationProtocolVersion: 1,
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-result',
        generationScope: scope,
      })

      let markTranslationStarted!: () => void
      const translationStarted = new Promise<void>((resolve) => {
        markTranslationStarted = resolve
      })
      const runMessageTranslation = vi.fn(async (input: Parameters<typeof runServerMessageTranslation>[0]) => {
        markTranslationStarted()
        await translationGate
        return runServerMessageTranslation(input)
      })
      const retry = retryPendingGenerationCompletionEffects({
        db,
        dataDir,
        eventSink: createCommandEventSink(),
        messageTranslationJobs: new MessageTranslationJobRegistry(),
        runMessageTranslation,
      })
      await translationStarted
      await expect(retry).resolves.toBe(1)
      expect(listGenerationEffects(db, 'generation-a')).toContainEqual(
        expect.objectContaining({ kind: 'generated_translation', status: 'claimed', delivery: 'server' }),
      )

      const recovering = recoveringService(db, 100_000)
      expect(() =>
        recovering.claim({
          databaseLineage,
          chatId: 'chat-a',
          sessionId: 'reader-b',
          claimClass: 'chat_only',
          expectedOccupancyEpoch: occupancy.occupancyEpoch,
        }),
      ).toThrow('chat_occupancy_recovery_blocked')
      expect(recovering.snapshot().occupancies[0]).toMatchObject({
        occupantSessionId: 'reader-a',
        occupancyEpoch: occupancy.occupancyEpoch,
      })

      releaseTranslation()
      await vi.waitFor(
        () => {
          expect(listGenerationEffects(db, 'generation-a')).toContainEqual(
            expect.objectContaining({ kind: 'generated_translation', status: 'completed', delivery: 'server' }),
          )
          expect(
            db
              .prepare(
                "SELECT json_extract(json, '$.translation.targetLanguage') AS language FROM messages WHERE uid = ?",
              )
              .get('message-result'),
          ).toEqual({ language: 'ko' })
        },
        { timeout: 2_000 },
      )
      expect(runMessageTranslation).toHaveBeenCalledTimes(1)

      expect(
        recovering.claim({
          databaseLineage,
          chatId: 'chat-a',
          sessionId: 'reader-b',
          claimClass: 'chat_only',
          expectedOccupancyEpoch: occupancy.occupancyEpoch,
        }),
      ).toMatchObject({ occupantSessionId: 'reader-b', occupancyEpoch: occupancy.occupancyEpoch + 1 })
    } finally {
      releaseTranslation?.()
      db.close()
    }
  })

  it('keeps a real held provider pin fenced after expiry, then permits mutation only after completion', async () => {
    process.env.LOG_LEVEL = 'silent'
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-chat-occupancy-held-provider-'))
    dataDirs.push(dataDir)
    let now = 1_000
    let markProviderStarted!: () => void
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve
    })
    let releaseProvider!: () => void
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    const memoryEvents: MemoryEvent[] = []
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
      chatOccupancy: { enabled: true, now: () => now },
      memoryEvents: (event) => memoryEvents.push(event),
      memoryWorker: {
        pollIntervalMs: 10_000,
        handlers: {
          summarize: async () => {
            markProviderStarted()
            await providerGate
          },
        },
      },
      bardWikiWorker: false,
      assetGc: false,
      generationChat: { finalizationRetry: false },
    })
    try {
      const { assertion } = await setupAuthedClient(app)
      const imported = await app.inject({
        method: 'POST',
        url: '/api/v1/import/risusave',
        headers: { 'risu-auth': assertion },
        payload: {
          database: {
            characters: [
              {
                chaId: 'character-a',
                name: 'Ada',
                chats: [
                  {
                    id: 'chat-a',
                    modules: ['module-a'],
                    message: [{ role: 'user', data: 'before', chatId: 'message-a' }],
                  },
                ],
              },
            ],
            modules: [{ id: 'module-a', name: 'Module A', description: '' }],
          },
        },
      })
      expect(imported.statusCode).toBe(200)
      const owner = await app.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': assertion, 'risu-writer-session': 'owner-a' },
      })
      const { databaseLineage, revision } = owner.json()
      const occupied = await app.inject({
        method: 'POST',
        url: '/api/v1/chat-occupancies/chat-a/claim',
        headers: {
          'risu-auth': assertion,
          'risu-writer-session': 'owner-a',
          'risu-database-lineage': databaseLineage,
          'risu-chat-occupancy-epoch': '0',
        },
        payload: { version: 1, claimClass: 'owner' },
      })
      expect(occupied.statusCode).toBe(200)
      const firstJob = await app.inject({
        method: 'POST',
        url: '/api/v1/memory/jobs',
        headers: { 'risu-auth': assertion, 'risu-writer-session': 'owner-a' },
        payload: { chatId: 'chat-a', kind: 'summarize', payload: { held: true } },
      })
      expect(firstJob.statusCode).toBe(201)
      await providerStarted
      now = occupied.json().leaseExpiresAtMs
      const takeover = await app.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': assertion, 'risu-writer-session': 'owner-b' },
      })
      expect(takeover.statusCode).toBe(200)
      const ownerBHeaders = { 'risu-auth': assertion, 'risu-writer-session': 'owner-b' }
      const blockedRequests = [
        app.inject({
          method: 'PATCH',
          url: '/api/v1/commands/messages/message-a',
          headers: ownerBHeaders,
          payload: { baseRevision: revision, patch: { disabled: true } },
        }),
        app.inject({
          method: 'DELETE',
          url: '/api/v1/commands/characters/character-a',
          headers: ownerBHeaders,
          payload: { baseRevision: revision },
        }),
        app.inject({
          method: 'DELETE',
          url: '/api/v1/commands/modules/module-a',
          headers: ownerBHeaders,
          payload: { baseRevision: revision },
        }),
        app.inject({
          method: 'POST',
          url: '/api/v1/memory/jobs',
          headers: ownerBHeaders,
          payload: { chatId: 'chat-a', kind: 'summarize', payload: { forbidden: true } },
        }),
      ]
      for (const response of await Promise.all(blockedRequests)) {
        expect(response.statusCode).toBe(423)
        expect(response.json()).toMatchObject({ error: 'chat_occupied', safeRelease: expect.any(String) })
      }
      const during = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
      try {
        expect(during.prepare('SELECT revision FROM schema_version WHERE id = 1').get()).toEqual({ revision })
        expect(during.prepare('SELECT status FROM memory_jobs WHERE id = ?').get(firstJob.json().job.id)).toEqual({
          status: 'running',
        })
      } finally {
        during.close()
      }

      releaseProvider()
      await vi.waitFor(
        () => {
          const settled = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
          try {
            expect(settled.prepare('SELECT status FROM memory_jobs WHERE id = ?').get(firstJob.json().job.id)).toEqual({
              status: 'completed',
            })
          } finally {
            settled.close()
          }
        },
        { timeout: 2_000 },
      )
      expect(memoryEvents.map((event) => event.job.status)).toEqual(['pending', 'running', 'completed'])

      const allowed = await app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/messages/message-a',
        headers: ownerBHeaders,
        payload: { baseRevision: revision, patch: { disabled: true } },
      })
      expect(allowed.statusCode).toBe(200)
      expect(allowed.json().revision).toBe(revision + 1)
    } finally {
      releaseProvider?.()
      await app.close()
    }
  })

  it('terminalizes an abandoned uncertain attempt and pending IGP before atomically reclaiming', () => {
    const seeded = seedInterruptedGeneration(false)
    const db = openDatabase(seeded.dataDir)
    try {
      expect(reconcileGenerationOperationsAtStartup(db, 'server-after-restart')).toMatchObject({
        abandonedOperationCount: 1,
      })
      expect(getGenerationOperationProjection(db, seeded.databaseLineage, 'operation-a')).toMatchObject({
        state: 'abandoned',
        providerMayHaveRun: true,
      })
      expect(listGenerationOccupancyPins(db, 'chat-a').map((pin) => pin.kind)).toEqual(
        expect.arrayContaining(['generation_operation', 'generation_effect']),
      )

      const reclaimed = recoveringService(db, 100_000).claim({
        databaseLineage: seeded.databaseLineage,
        chatId: 'chat-a',
        sessionId: 'reader-b',
        claimClass: 'chat_only',
        expectedOccupancyEpoch: seeded.occupancyEpoch,
      })

      expect(reclaimed).toMatchObject({ occupantSessionId: 'reader-b', occupancyEpoch: seeded.occupancyEpoch + 1 })
      expect(getGenerationOperationProjection(db, seeded.databaseLineage, 'operation-a')).toMatchObject({
        state: 'terminal_failed',
        failureCode: 'occupancy_recovery_expired',
        providerMayHaveRun: true,
      })
      expect(getGenerationOperationProjection(db, seeded.databaseLineage, 'operation-a')).not.toHaveProperty(
        'currentAttempt',
      )
      expect(
        db
          .prepare(
            `SELECT status, failure_code FROM generation_operation_attempts
           WHERE database_lineage = ? AND operation_id = ?`,
          )
          .get(seeded.databaseLineage, 'operation-a'),
      ).toEqual({ status: 'terminal_failed', failure_code: 'occupancy_recovery_expired' })
      expect(listGenerationEffects(db, 'generation-a').find((effect) => effect.kind === 'igp')).toMatchObject({
        status: 'skipped',
        reason: 'occupancy_recovery_expired',
      })
      expect(db.prepare('SELECT uid, data FROM messages WHERE chat_id = ? ORDER BY seq').all('chat-a')).toEqual([
        { uid: 'message-user', data: 'accepted user' },
      ])
      expect(db.prepare('SELECT COUNT(*) AS count FROM generation_operation_attempts').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT revision FROM schema_version WHERE id = 1').get()).toEqual({ revision: 0 })
    } finally {
      db.close()
    }
  })

  it('retains an exact recovered result and lets the server dispose its pending translation before reclaim', async () => {
    const seeded = seedInterruptedGeneration(true)
    const db = openDatabase(seeded.dataDir)
    try {
      expect(reconcileGenerationOperationsAtStartup(db, 'server-after-restart')).toMatchObject({
        completedFromResultCount: 1,
      })
      const recovering = recoveringService(db, 100_000)
      expect(() =>
        recovering.claim({
          databaseLineage: seeded.databaseLineage,
          chatId: 'chat-a',
          sessionId: 'reader-b',
          claimClass: 'chat_only',
          expectedOccupancyEpoch: seeded.occupancyEpoch,
        }),
      ).toThrow('chat_occupancy_recovery_blocked')
      expect(listGenerationEffects(db, 'generation-a')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'igp', status: 'pending' }),
          expect.objectContaining({ kind: 'generated_translation', status: 'pending' }),
        ]),
      )

      const runMessageTranslation = vi.fn(runServerMessageTranslation)
      await expect(
        retryPendingGenerationCompletionEffects({
          db,
          dataDir: seeded.dataDir,
          eventSink: createCommandEventSink(),
          messageTranslationJobs: new MessageTranslationJobRegistry(),
          runMessageTranslation,
        }),
      ).resolves.toBe(1)
      expect(runMessageTranslation).not.toHaveBeenCalled()

      const reclaimed = recovering.claim({
        databaseLineage: seeded.databaseLineage,
        chatId: 'chat-a',
        sessionId: 'reader-b',
        claimClass: 'chat_only',
        expectedOccupancyEpoch: seeded.occupancyEpoch,
      })

      expect(reclaimed.occupancyEpoch).toBe(seeded.occupancyEpoch + 1)
      expect(getGenerationOperationProjection(db, seeded.databaseLineage, 'operation-a')).toMatchObject({
        state: 'completed',
        resultMessageId: 'message-result',
      })
      expect(db.prepare('SELECT uid, data FROM messages WHERE chat_id = ? ORDER BY seq').all('chat-a')).toEqual([
        { uid: 'message-user', data: 'accepted user' },
        { uid: 'message-result', data: 'recoverable result' },
      ])
      expect(
        listGenerationEffects(db, 'generation-a').filter(
          (effect) => effect.status === 'pending' || effect.status === 'claimed',
        ),
      ).toEqual([])
      expect(listGenerationEffects(db, 'generation-a')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'igp', status: 'skipped', reason: 'occupancy_recovery_expired' }),
          expect.objectContaining({ kind: 'generated_translation', status: 'skipped', reason: 'not_applicable' }),
        ]),
      )
    } finally {
      db.close()
    }
  })

  it.each([
    { targetState: 'missing', reason: 'target_missing' },
    { targetState: 'user', reason: 'target_not_assistant' },
  ] as const)(
    'terminally skips a $targetState recovered translation target before reclaim without provider dispatch',
    async ({ targetState, reason }) => {
      const seeded = seedInterruptedGeneration(true)
      const db = openDatabase(seeded.dataDir)
      try {
        expect(reconcileGenerationOperationsAtStartup(db, 'server-after-restart')).toMatchObject({
          completedFromResultCount: 1,
        })
        if (targetState === 'missing') {
          db.prepare('DELETE FROM messages WHERE uid = ?').run('message-result')
        } else {
          db.prepare("UPDATE messages SET role = 'user', json = json_set(json, '$.role', 'user') WHERE uid = ?").run(
            'message-result',
          )
        }
        const runMessageTranslation = vi.fn(runServerMessageTranslation)

        await expect(
          retryPendingGenerationCompletionEffects({
            db,
            dataDir: seeded.dataDir,
            eventSink: createCommandEventSink(),
            messageTranslationJobs: new MessageTranslationJobRegistry(),
            runMessageTranslation,
          }),
        ).resolves.toBe(1)
        expect(runMessageTranslation).not.toHaveBeenCalled()
        expect(listGenerationEffects(db, 'generation-a')).toContainEqual(
          expect.objectContaining({
            kind: 'generated_translation',
            status: 'skipped',
            delivery: 'server',
            reason,
          }),
        )

        expect(
          recoveringService(db, 100_000).claim({
            databaseLineage: seeded.databaseLineage,
            chatId: 'chat-a',
            sessionId: 'reader-b',
            claimClass: 'chat_only',
            expectedOccupancyEpoch: seeded.occupancyEpoch,
          }),
        ).toMatchObject({ occupantSessionId: 'reader-b', occupancyEpoch: seeded.occupancyEpoch + 1 })
        expect(
          db
            .prepare(
              `SELECT role, json_extract(json, '$.translation') AS translation
               FROM messages WHERE uid = 'message-result'`,
            )
            .get(),
        ).toEqual(targetState === 'missing' ? undefined : { role: 'user', translation: null })
      } finally {
        db.close()
      }
    },
  )
})
