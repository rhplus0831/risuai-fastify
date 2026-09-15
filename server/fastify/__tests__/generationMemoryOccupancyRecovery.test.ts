import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_BARDWIKI_GLOBAL_SETTINGS } from '@risuai/protocol'
import { createBardWikiApplyTurnHandler } from '../src/bardWikiApplyTurnHandler.js'
import { getBardWikiJob, recoverRunningBardWikiJobs } from '../src/bardWikiJobs.js'
import { createOrReuseAutomaticBardWikiConfirmation, hashBardWikiMessageContent } from '../src/bardWikiReceipts.js'
import { getBardWikiDocument, getBardWikiReceiptSummary, listBardWikiDocuments } from '../src/bardWikiRepository.js'
import { BardWikiWorker } from '../src/bardWikiWorker.js'
import { ChatOccupancyService } from '../src/chatOccupancy.js'
import { createInitialDatabase } from '../src/databaseDefaults.js'
import { getSchemaState, openDatabase } from '../src/db.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import {
  CHAT_ONLY_GENERATION_ALLOWLIST,
  admitGenerationInTransaction,
  listGenerationOccupancyPins,
  scopeSqlValues,
} from '../src/generationScope.js'
import {
  createGenerationOperation,
  generationEffectiveConfigurationFingerprint,
  reserveGenerationOperationAttempt,
  transitionGenerationOperation,
} from '../src/generationOperations.js'
import { createSummarizeMemoryJobHandler } from '../src/memorySummarizeJobHandler.js'
import { createMemoryChunk, enqueueMemoryJob, getMemoryJob, recoverRunningMemoryJobs } from '../src/memoryRepository.js'
import { MemoryWorker } from '../src/memoryWorker.js'

const RECOVERY_NOW = '2099-01-01T00:00:00.000Z'
const SOURCE_USER = 'We enter the old tavern.'
const SOURCE_ASSISTANT = 'Mira lights a lantern beside the door.'
const BARDWIKI_EVENT = JSON.stringify({
  title: 'Lantern at the Old Tavern',
  logicalPath: 'Events/Lantern at the Old Tavern',
  aliases: ['Lantern Night'],
  markdown: 'Mira lights a lantern beside the door at the [[Old Tavern]].',
})
const BARDWIKI_CANONICAL = JSON.stringify([
  {
    op: 'create',
    kind: 'location',
    title: 'Old Tavern',
    logicalPath: 'Locations/Old Tavern',
    aliases: ['The Tavern'],
    sections: [{ heading: 'Overview', markdown: 'An old tavern with a lantern by the door.' }],
  },
])

const dataDirs: string[] = []

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
})

function providerCrashBarrier() {
  let started!: () => void
  let crash!: (error: Error) => void
  const blocked = new Promise<never>((_resolve, reject) => {
    crash = reject
  })
  // Cleanup may crash the barrier before a provider has begun awaiting it.
  // Attach a consumer up front while preserving the rejected promise for the
  // worker's real provider path.
  void blocked.catch(() => undefined)
  return {
    started: new Promise<void>((resolve) => {
      started = resolve
    }),
    blocked,
    markStarted: started,
    crash,
  }
}

function acceptedDatabase() {
  const database = createInitialDatabase()
  Object.assign(database, {
    subModel: 'gpt-4o-mini',
    openAIKey: 'sk-test',
    providerCredentials: [
      {
        id: 'credential-memory',
        name: 'Memory',
        type: 'apiKey',
        apiKey: 'sk-test',
      },
    ],
    modelProfiles: [
      {
        id: 'profile-memory',
        name: 'Memory',
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        providerOptions: { credentialId: 'credential-memory', requestModel: 'gpt-4o-mini' },
      },
    ],
    modelRoleProfiles: { memory: { mode: 'profile', profileId: 'profile-memory' } },
    selectedHypaV3PresetId: 'memory-default',
    hypaV3Presets: [
      {
        id: 'memory-default',
        name: 'Memory default',
        settings: {
          summarizationModel: 'subModel',
          summarizationPrompt: 'Summarize this: {{slot}}',
          reSummarizationPrompt: '',
          summarizationRequestsPerMinute: 60,
        },
      },
    ],
    characters: [
      {
        type: 'character',
        chaId: 'character-a',
        name: 'Mira',
        firstMessage: 'Hello',
        chatPage: 0,
        chats: [{ id: 'chat-a', name: 'Tavern', message: [] }],
      },
    ],
    characterOrder: ['character-a'],
  })
  return database
}

function insertMessage(
  db: ReturnType<typeof openDatabase>,
  seq: number,
  uid: string,
  role: 'user' | 'char',
  data: string,
): void {
  db.prepare(
    `INSERT INTO messages (chat_id, seq, uid, role, data, disabled, json, alternate)
     VALUES ('chat-a', ?, ?, ?, ?, NULL, ?, 0)`,
  ).run(seq, uid, role, data, JSON.stringify({ chatId: uid, role, data }))
}

function durableJobScopeRows(db: ReturnType<typeof openDatabase>) {
  const columns = `operation_id, operation_attempt_no, admission_kind,
                   occupancy_database_lineage, occupancy_session_id, occupancy_epoch,
                   occupancy_claim_class, permission_scope_version, permission_scope_json`
  return {
    memory: db.prepare(`SELECT ${columns} FROM memory_jobs`).all(),
    bardWiki: db.prepare(`SELECT ${columns} FROM bardwiki_jobs`).all(),
  }
}

describe('accepted generation memory occupancy recovery', () => {
  it('pins Hypa and BardWiki through provider interruption and restart until exact durable output settles', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-generation-memory-occupancy-'))
    dataDirs.push(dataDir)
    const db = openDatabase(dataDir)
    let now = 1_000
    const hypaBarrier = providerCrashBarrier()
    const bardWikiBarrier = providerCrashBarrier()
    let hypaCalls = 0
    let bardWikiCalls = 0
    let canonicalCalls = 0
    let firstHypaTick: Promise<boolean> | undefined
    let firstBardWikiTick: Promise<boolean> | undefined
    try {
      const bardWikiSettings = {
        ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
        enabledByDefault: true,
        memoryMode: 'hybrid' as const,
        confirmationPolicy: 'automatic' as const,
        canonicalUpdates: true,
      }
      const liveDatabase = createInitialDatabase() as unknown as Record<string, unknown>
      liveDatabase.bardWiki = bardWikiSettings
      db.prepare('INSERT INTO settings (id, data_json) VALUES (1, ?)').run(JSON.stringify(liveDatabase))
      db.prepare("INSERT INTO characters (id, position, data_json) VALUES ('character-a', 0, '{}')").run()
      db.prepare(
        "INSERT INTO chats (id, character_id, position, data_json) VALUES ('chat-a', 'character-a', 0, '{}'), ('chat-b', 'character-a', 1, '{}')",
      ).run()
      insertMessage(db, 0, 'source-user', 'user', SOURCE_USER)
      insertMessage(db, 1, 'source-assistant', 'char', SOURCE_ASSISTANT)
      insertMessage(db, 2, 'accepted-user', 'user', 'Tell me what happens next.')
      insertMessage(db, 3, 'result-assistant', 'char', 'The lantern reveals a hidden stairway.')

      const databaseLineage = getDatabaseLineage(db)
      const occupancyService = new ChatOccupancyService(db, {
        now: () => now,
        pinQuery: listGenerationOccupancyPins,
      })
      const occupancy = occupancyService.claim({
        databaseLineage,
        chatId: 'chat-a',
        sessionId: 'reader-a',
        claimClass: 'chat_only',
        expectedOccupancyEpoch: 0,
      })
      const generationScope = admitGenerationInTransaction(db, {
        databaseLineage,
        chatId: 'chat-a',
        sessionId: 'reader-a',
        occupancyProtocolVersion: 1,
        occupancyEpoch: occupancy.occupancyEpoch,
        interaction: 'send',
        chatOnlyEnabled: true,
        nowMs: now,
      })
      const effectiveConfiguration = {
        version: 1,
        database: acceptedDatabase(),
        promptInfo: {},
        resolvedMainProfile: {},
        acceptedBardWikiSettings: bardWikiSettings,
      }
      const operation = createGenerationOperation(db, {
        databaseLineage,
        operationId: 'accepted-operation',
        protocolVersion: 1,
        requestOrigin: 'accepted_send',
        creatorWriterSessionId: 'reader-a',
        creatorWriterEpoch: 0,
        generationScope,
        effectiveConfiguration,
        effectiveConfigurationFingerprint: generationEffectiveConfigurationFingerprint(effectiveConfiguration),
        bindingServerInstanceId: 'server-before-restart',
        characterId: 'character-a',
        chatId: 'chat-a',
        mode: 'send',
        acceptedMessageId: 'accepted-user',
        requestFingerprint: 'a'.repeat(64),
        intent: { mode: 'send' },
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
        serverInstanceId: 'server-before-restart',
        actorWriterSessionId: 'reader-a',
        actorWriterEpoch: 0,
        launchRevision: 0,
      })
      if (reservation.status !== 'applied' || !reservation.operation.currentAttempt) {
        throw new Error('failed to reserve accepted generation attempt')
      }
      const owned = transitionGenerationOperation(db, {
        databaseLineage,
        operationId: operation.operationId,
        expectedState: 'launching',
        expectedStateVersion: reservation.operation.stateVersion,
        nextState: 'owned_by_job',
      })
      if (owned.status !== 'applied') throw new Error('failed to own accepted generation attempt')
      const finalizing = transitionGenerationOperation(db, {
        databaseLineage,
        operationId: operation.operationId,
        expectedState: 'owned_by_job',
        expectedStateVersion: owned.operation.stateVersion,
        nextState: 'finalizing',
        desiredTerminalOutcome: 'completed',
      })
      if (finalizing.status !== 'applied') throw new Error('failed to finalize accepted generation attempt')
      const completed = transitionGenerationOperation(db, {
        databaseLineage,
        operationId: operation.operationId,
        expectedState: 'finalizing',
        expectedStateVersion: finalizing.operation.stateVersion,
        nextState: 'completed',
        resultMessageId: 'result-assistant',
      })
      if (completed.status !== 'applied') throw new Error('failed to complete accepted generation attempt')
      expect(
        db
          .prepare('SELECT state, result_message_id FROM generation_operations WHERE operation_id = ?')
          .get(operation.operationId),
      ).toEqual({ state: 'completed', result_message_id: 'result-assistant' })

      createMemoryChunk(db, {
        id: 'hypa-chunk',
        chatId: 'chat-a',
        messageId: 'source-assistant',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: `user: ${SOURCE_USER}\nassistant: ${SOURCE_ASSISTANT}`,
      })
      const memoryJob = enqueueMemoryJob(db, {
        id: 'hypa-job',
        chatId: 'chat-a',
        kind: 'summarize',
        payload: {
          schemaVersion: 1,
          chunkId: 'hypa-chunk',
          model: 'subModel',
          rangeStartSeq: 0,
          rangeEndSeq: 1,
          messageIndexes: [0, 1],
          chatMemos: ['source-user', 'source-assistant'],
        },
        operationId: operation.operationId,
        operationAttemptNo: reservation.operation.currentAttempt.attemptNo,
        generationScope,
      })
      const confirmation = createOrReuseAutomaticBardWikiConfirmation(db, {
        chatId: 'chat-a',
        acceptedUserMessageId: 'accepted-user',
        resultAssistantMessageId: 'result-assistant',
        acceptedSettings: bardWikiSettings,
      })
      if (!confirmation?.created) throw new Error('failed to create automatic BardWiki confirmation')
      db.prepare(
        `UPDATE bardwiki_jobs
         SET operation_id = ?, operation_attempt_no = ?, admission_kind = ?,
             occupancy_database_lineage = ?, occupancy_session_id = ?, occupancy_epoch = ?,
             occupancy_claim_class = ?, permission_scope_version = ?, permission_scope_json = ?
         WHERE id = ?`,
      ).run(
        operation.operationId,
        reservation.operation.currentAttempt.attemptNo,
        ...scopeSqlValues(generationScope),
        confirmation.job.id,
      )

      const acceptedScopeRows = durableJobScopeRows(db)
      expect(acceptedScopeRows).toEqual({
        memory: [
          {
            operation_id: operation.operationId,
            operation_attempt_no: 1,
            admission_kind: 'chat_only',
            occupancy_database_lineage: databaseLineage,
            occupancy_session_id: 'reader-a',
            occupancy_epoch: occupancy.occupancyEpoch,
            occupancy_claim_class: 'chat_only',
            permission_scope_version: 1,
            permission_scope_json: JSON.stringify(CHAT_ONLY_GENERATION_ALLOWLIST),
          },
        ],
        bardWiki: [
          {
            operation_id: operation.operationId,
            operation_attempt_no: 1,
            admission_kind: 'chat_only',
            occupancy_database_lineage: databaseLineage,
            occupancy_session_id: 'reader-a',
            occupancy_epoch: occupancy.occupancyEpoch,
            occupancy_claim_class: 'chat_only',
            permission_scope_version: 1,
            permission_scope_json: JSON.stringify(CHAT_ONLY_GENERATION_ALLOWLIST),
          },
        ],
      })
      expect(listGenerationOccupancyPins(db, 'chat-a')).toEqual([
        { id: memoryJob.id, kind: 'memory_job' },
        { id: confirmation.job.id, kind: 'bardwiki_job' },
      ])

      const summarize = vi.fn(async () => {
        hypaCalls += 1
        if (hypaCalls === 1) {
          hypaBarrier.markStarted()
          return hypaBarrier.blocked
        }
        return { text: 'Recovered Hypa summary.', tokens: 4 }
      })
      const analyze = vi.fn(async () => {
        bardWikiCalls += 1
        if (bardWikiCalls === 1) {
          bardWikiBarrier.markStarted()
          return bardWikiBarrier.blocked
        }
        return BARDWIKI_EVENT
      })
      const compileCanonical = vi.fn(async () => {
        canonicalCalls += 1
        return BARDWIKI_CANONICAL
      })
      const memoryWorkerOptions = {
        db,
        retry: { now: RECOVERY_NOW, backoffBaseMs: 0 },
        handlers: {
          summarize: createSummarizeMemoryJobHandler({ db, summarize, sleep: async () => {} }),
        },
      }
      const bardWikiWorkerOptions = {
        db,
        retry: { now: RECOVERY_NOW, backoffBaseMs: 0 },
        handlers: {
          apply_turn: createBardWikiApplyTurnHandler({
            db,
            dataDir,
            analyze,
            compileCanonical,
          }),
        },
      }
      const firstMemoryWorker = new MemoryWorker(memoryWorkerOptions)
      const firstBardWikiWorker = new BardWikiWorker(bardWikiWorkerOptions)
      firstHypaTick = firstMemoryWorker.tick()
      firstBardWikiTick = firstBardWikiWorker.tick()
      await Promise.all([hypaBarrier.started, bardWikiBarrier.started])

      expect(getMemoryJob(db, memoryJob.id)).toMatchObject({ status: 'running', attemptCount: 1 })
      expect(getBardWikiJob(db, confirmation.job.id)).toMatchObject({ status: 'running', attemptCount: 1 })
      expect(db.prepare('SELECT * FROM memory_summaries').all()).toEqual([])
      expect(listBardWikiDocuments(db, 'chat-a')).toEqual([])
      expect(() =>
        occupancyService.release({
          databaseLineage,
          chatId: 'chat-a',
          sessionId: 'reader-a',
          occupancyEpoch: occupancy.occupancyEpoch,
        }),
      ).toThrow(/chat_occupancy_recovery_blocked/u)

      if (occupancy.leaseExpiresAtMs === null) throw new Error('claimed occupancy is missing its lease deadline')
      now = occupancy.leaseExpiresAtMs
      expect(() =>
        occupancyService.claim({
          databaseLineage,
          chatId: 'chat-a',
          sessionId: 'reader-b',
          claimClass: 'chat_only',
          expectedOccupancyEpoch: occupancy.occupancyEpoch,
        }),
      ).toThrow(/chat_occupancy_recovery_blocked/u)
      expect(occupancyService.snapshot().occupancies).toContainEqual(
        expect.objectContaining({
          chatId: 'chat-a',
          occupantSessionId: 'reader-a',
          occupancyEpoch: occupancy.occupancyEpoch,
        }),
      )

      expect(recoverRunningMemoryJobs(db, { now: RECOVERY_NOW, backoffBaseMs: 0 })).toEqual([
        expect.objectContaining({ id: memoryJob.id, status: 'pending', attemptCount: 1 }),
      ])
      expect(recoverRunningBardWikiJobs(db, { now: RECOVERY_NOW, backoffBaseMs: 0 })).toEqual([
        expect.objectContaining({ id: confirmation.job.id, status: 'pending', attemptCount: 1 }),
      ])
      expect(durableJobScopeRows(db)).toEqual(acceptedScopeRows)
      expect(listGenerationOccupancyPins(db, 'chat-a')).toEqual([
        { id: memoryJob.id, kind: 'memory_job' },
        { id: confirmation.job.id, kind: 'bardwiki_job' },
      ])
      expect(() =>
        occupancyService.release({
          databaseLineage,
          chatId: 'chat-a',
          sessionId: 'reader-a',
          occupancyEpoch: occupancy.occupancyEpoch,
        }),
      ).toThrow(/chat_occupancy_recovery_blocked/u)

      hypaBarrier.crash(new Error('simulated Hypa provider process loss'))
      bardWikiBarrier.crash(new Error('simulated BardWiki provider process loss'))
      await Promise.all([firstHypaTick, firstBardWikiTick])
      expect(getMemoryJob(db, memoryJob.id)).toMatchObject({ status: 'pending', attemptCount: 1 })
      expect(getBardWikiJob(db, confirmation.job.id)).toMatchObject({ status: 'pending', attemptCount: 1 })
      expect(db.prepare('SELECT * FROM memory_summaries').all()).toEqual([])
      expect(listBardWikiDocuments(db, 'chat-a')).toEqual([])

      const replacementMemoryWorker = new MemoryWorker(memoryWorkerOptions)
      const replacementBardWikiWorker = new BardWikiWorker(bardWikiWorkerOptions)
      await Promise.all([replacementMemoryWorker.tick(), replacementBardWikiWorker.tick()])

      expect(summarize).toHaveBeenCalledTimes(2)
      expect(analyze).toHaveBeenCalledTimes(2)
      expect(compileCanonical).toHaveBeenCalledTimes(1)
      expect(durableJobScopeRows(db)).toEqual(acceptedScopeRows)
      expect(db.prepare('SELECT id, status, range_start_seq, range_end_seq FROM memory_chunks').all()).toEqual([
        { id: 'hypa-chunk', status: 'summarized', range_start_seq: 0, range_end_seq: 1 },
      ])
      expect(db.prepare('SELECT chat_id, chunk_id, model, text, tokens FROM memory_summaries').all()).toEqual([
        {
          chat_id: 'chat-a',
          chunk_id: 'hypa-chunk',
          model: 'subModel',
          text: 'Recovered Hypa summary.',
          tokens: 4,
        },
      ])
      expect(getMemoryJob(db, memoryJob.id)).toMatchObject({ status: 'completed', attemptCount: 2, error: null })

      expect(
        listBardWikiDocuments(db, 'chat-a').map(({ id, kind, logicalPath, version }) => ({
          id,
          kind,
          logicalPath,
          version,
        })),
      ).toEqual([
        {
          id: `event-${confirmation.receipt.id}`,
          kind: 'event',
          logicalPath: 'Events/Lantern at the Old Tavern',
          version: 1,
        },
        {
          id: expect.any(String),
          kind: 'location',
          logicalPath: 'Locations/Old Tavern',
          version: 1,
        },
      ])
      expect(getBardWikiDocument(db, 'chat-a', `event-${confirmation.receipt.id}`)).toMatchObject({
        markdown: 'Mira lights a lantern beside the door at the [[Old Tavern]].',
        reviewState: 'active',
      })
      const canonicalDocument = listBardWikiDocuments(db, 'chat-a').find((document) => document.kind === 'location')
      expect(canonicalDocument).toBeDefined()
      expect(getBardWikiDocument(db, 'chat-a', canonicalDocument!.id)).toMatchObject({
        title: 'Old Tavern',
        logicalPath: 'Locations/Old Tavern',
        aliases: ['The Tavern'],
        markdown: '### Overview\n\nAn old tavern with a lantern by the door.',
        reviewState: 'active',
        version: 1,
      })
      expect(getBardWikiReceiptSummary(db, confirmation.receipt.id)).toMatchObject({
        state: 'applied',
        eventDocumentId: `event-${confirmation.receipt.id}`,
      })
      expect(getBardWikiJob(db, confirmation.job.id)).toMatchObject({ status: 'completed', attemptCount: 2 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM bardwiki_document_versions').get()).toEqual({ count: 2 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM bardwiki_document_sources').get()).toEqual({ count: 4 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM bardwiki_change_manifest').get()).toEqual({ count: 2 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM command_events').get()).toEqual({ count: 1 })
      expect(getSchemaState(db).revision).toBe(1)
      expect(listGenerationOccupancyPins(db, 'chat-a')).toEqual([])

      const released = occupancyService.release({
        databaseLineage,
        chatId: 'chat-a',
        sessionId: 'reader-a',
        occupancyEpoch: occupancy.occupancyEpoch,
      })
      expect(released).toMatchObject({ state: 'released', occupancyEpoch: occupancy.occupancyEpoch + 1 })
      expect(
        occupancyService.claim({
          databaseLineage,
          chatId: 'chat-a',
          sessionId: 'reader-b',
          claimClass: 'chat_only',
          expectedOccupancyEpoch: released.occupancyEpoch,
        }),
      ).toMatchObject({ occupantSessionId: 'reader-b', occupancyEpoch: released.occupancyEpoch + 1 })
    } finally {
      hypaBarrier.crash(new Error('test cleanup'))
      bardWikiBarrier.crash(new Error('test cleanup'))
      await Promise.allSettled([firstHypaTick, firstBardWikiTick].filter((tick) => tick !== undefined))
      db.close()
    }
  })
})
