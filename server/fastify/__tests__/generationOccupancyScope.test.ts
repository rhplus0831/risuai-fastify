import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db.js'
import { getDatabaseLineage, registerDatabaseWriterSession } from '../src/databaseLineage.js'
import { ChatOccupancyService } from '../src/chatOccupancy.js'
import {
  CHAT_ONLY_GENERATION_ALLOWLIST,
  GenerationAdmissionError,
  admitAcceptedCompatibilityGenerationInTransaction,
  admitGenerationInTransaction,
  assertAcceptedCompatibilityGenerationAuthorityInTransaction,
  assertPersistedGenerationScopeInTransaction,
  listGenerationOccupancyPins,
} from '../src/generationScope.js'
import {
  createGenerationOperation,
  GENERATION_EFFECTIVE_CONFIGURATION_MAX_BYTES,
  GenerationEffectiveConfigurationTooLargeError,
  generationEffectiveConfigurationFingerprint,
  getGenerationOperationStoredRequest,
  reserveGenerationOperationAttempt,
  transitionGenerationOperation,
} from '../src/generationOperations.js'
import { ensureGenerationEffectLedger } from '../src/generationEffects.js'
import { enqueueGenerationFinalizationRetry } from '../src/generationFinalizationRetry.js'
import { enqueueMemoryJob } from '../src/memoryRepository.js'
import { enqueueBardWikiJob } from '../src/bardWikiJobs.js'
import { appendChatMessage } from '../src/messageStore.js'

const dataDirs: string[] = []

function harness() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-generation-occupancy-scope-'))
  dataDirs.push(dataDir)
  const db = openDatabase(dataDir)
  db.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, 0, ?)').run(
    'character-a',
    JSON.stringify({ chaId: 'character-a', chats: [] }),
  )
  for (const [position, chatId] of ['chat-a', 'chat-b'].entries()) {
    db.prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, ?, ?)').run(
      chatId,
      'character-a',
      position,
      JSON.stringify({ id: chatId }),
    )
  }
  registerDatabaseWriterSession(db, 'owner-a')
  const occupancy = new ChatOccupancyService(db, {
    now: () => 1_000,
    pinQuery: listGenerationOccupancyPins,
  })
  return { db, lineage: getDatabaseLineage(db), occupancy }
}

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
})

describe('generation occupancy scope', () => {
  it('requires v1 for a live self occupancy and retires expired unpinned rows before compatibility admission', () => {
    const { db, lineage, occupancy } = harness()
    try {
      const owner = occupancy.claim({
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: 'owner-a',
        claimClass: 'owner',
        expectedOccupancyEpoch: 0,
      })
      const reader = occupancy.claim({
        databaseLineage: lineage,
        chatId: 'chat-b',
        sessionId: 'reader-a',
        claimClass: 'chat_only',
        expectedOccupancyEpoch: 0,
      })

      expect(() =>
        admitGenerationInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-a',
          sessionId: 'owner-a',
          interaction: 'send',
          chatOnlyEnabled: true,
          nowMs: 1_000,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<GenerationAdmissionError>>({ code: 'chat_occupancy_protocol_required' }),
      )

      expect(
        admitGenerationInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-a',
          sessionId: 'owner-a',
          interaction: 'send',
          chatOnlyEnabled: true,
          nowMs: 100_000,
        }),
      ).toEqual({ admissionKind: 'legacy_owner' })

      expect(
        admitGenerationInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-b',
          sessionId: 'owner-a',
          interaction: 'send',
          chatOnlyEnabled: true,
          nowMs: 100_000,
        }),
      ).toEqual({ admissionKind: 'legacy_owner' })
      expect(occupancy.snapshot().occupancies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ chatId: 'chat-a', occupancyEpoch: owner.occupancyEpoch + 1, state: 'released' }),
          expect.objectContaining({ chatId: 'chat-b', occupancyEpoch: reader.occupancyEpoch + 1, state: 'released' }),
        ]),
      )
    } finally {
      db.close()
    }
  })

  it('blocks compatibility admission on durable recovery work even without an occupancy row', () => {
    const { db, lineage } = harness()
    try {
      enqueueMemoryJob(db, {
        id: 'legacy-recovery-pin',
        chatId: 'chat-a',
        kind: 'summarize',
        payload: {},
      })
      expect(() =>
        admitGenerationInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-a',
          sessionId: 'owner-a',
          interaction: 'send',
          chatOnlyEnabled: true,
          nowMs: 1_000,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<GenerationAdmissionError>>({ code: 'chat_occupancy_recovery_blocked' }),
      )
    } finally {
      db.close()
    }
  })

  it('lets accepted compatibility work cross its own pins but not an intervening occupancy epoch', () => {
    const { db, lineage, occupancy } = harness()
    try {
      enqueueMemoryJob(db, {
        id: 'accepted-compatibility-pin',
        chatId: 'chat-a',
        kind: 'summarize',
        payload: {},
      })
      expect(() =>
        assertAcceptedCompatibilityGenerationAuthorityInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-a',
          sessionId: 'owner-a',
          occupancyEpoch: 0,
          nowMs: 1_000,
        }),
      ).not.toThrow()

      db.prepare("UPDATE memory_jobs SET status = 'cancelled' WHERE id = 'accepted-compatibility-pin'").run()
      occupancy.claim({
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: 'owner-a',
        claimClass: 'owner',
        expectedOccupancyEpoch: 0,
      })
      expect(() =>
        assertAcceptedCompatibilityGenerationAuthorityInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-a',
          sessionId: 'owner-a',
          occupancyEpoch: 0,
          nowMs: 1_000,
        }),
      ).toThrowError(expect.objectContaining<Partial<GenerationAdmissionError>>({ code: 'chat_occupancy_stale' }))
      expect(() =>
        assertAcceptedCompatibilityGenerationAuthorityInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-a',
          sessionId: 'owner-a',
          occupancyEpoch: 0,
          nowMs: 100_000,
        }),
      ).toThrowError(expect.objectContaining<Partial<GenerationAdmissionError>>({ code: 'chat_occupancy_stale' }))
    } finally {
      db.close()
    }
  })

  it('permanently fences accepted compatibility work after a foreign claim is released', () => {
    const { db, lineage, occupancy } = harness()
    try {
      const accepted = admitAcceptedCompatibilityGenerationInTransaction(db, {
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: 'owner-a',
        interaction: 'continue',
        chatOnlyEnabled: true,
        nowMs: 1_000,
      })
      expect(accepted.occupancyEpoch).toBe(0)

      const foreign = occupancy.claim({
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: 'reader-a',
        claimClass: 'chat_only',
        expectedOccupancyEpoch: 0,
      })
      occupancy.release({
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: 'reader-a',
        occupancyEpoch: foreign.occupancyEpoch,
      })

      expect(occupancy.snapshot().occupancies).toContainEqual(
        expect.objectContaining({ chatId: 'chat-a', occupancyEpoch: 2, state: 'released' }),
      )
      expect(() => assertAcceptedCompatibilityGenerationAuthorityInTransaction(db, accepted)).toThrowError(
        expect.objectContaining<Partial<GenerationAdmissionError>>({
          code: 'chat_occupancy_stale',
          details: expect.objectContaining({ acceptedOccupancyEpoch: 0, currentOccupancyEpoch: 2 }),
        }),
      )
    } finally {
      db.close()
    }
  })

  it('does not pin a cleanup-only finalization journal after its exact result committed', () => {
    const { db, lineage } = harness()
    try {
      const result = { role: 'char' as const, data: 'committed result', chatId: 'cleanup-result' }
      appendChatMessage(db, 'chat-a', {
        ...result,
        generationInfo: { generationId: 'cleanup-generation' },
      })
      enqueueGenerationFinalizationRetry(db, {
        generationId: 'cleanup-generation',
        chatId: 'chat-a',
        mode: 'send',
        message: result,
        chatVarMutations: [],
      })

      expect(listGenerationOccupancyPins(db, 'chat-a')).not.toContainEqual({
        id: 'cleanup-generation',
        kind: 'generation_finalization',
      })
      expect(
        admitGenerationInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-a',
          sessionId: 'owner-a',
          interaction: 'send',
          chatOnlyEnabled: true,
          nowMs: 1_000,
        }),
      ).toEqual({ admissionKind: 'legacy_owner' })

      enqueueGenerationFinalizationRetry(db, {
        generationId: 'malformed-generation',
        chatId: 'chat-a',
        mode: 'send',
        message: { role: 'char', data: 'malformed result', chatId: 'malformed-result' },
        chatVarMutations: [],
      })
      db.prepare(
        "UPDATE generation_finalization_retries SET message_json = 'null' WHERE generation_id = 'malformed-generation'",
      ).run()
      expect(listGenerationOccupancyPins(db, 'chat-a')).toContainEqual({
        id: 'malformed-generation',
        kind: 'generation_finalization',
      })
      db.prepare(
        "UPDATE generation_finalization_retries SET database_lineage = 'stale-lineage' WHERE generation_id = 'malformed-generation'",
      ).run()
      expect(listGenerationOccupancyPins(db, 'chat-a')).not.toContainEqual({
        id: 'malformed-generation',
        kind: 'generation_finalization',
      })
    } finally {
      db.close()
    }
  })

  it('blocks fresh compatibility admission on an existing unoccupied generation operation', () => {
    const { db, lineage } = harness()
    try {
      createGenerationOperation(db, {
        databaseLineage: lineage,
        operationId: 'legacy-operation-pin',
        protocolVersion: 1,
        requestOrigin: 'accepted_send',
        creatorWriterSessionId: 'owner-a',
        creatorWriterEpoch: 1,
        generationScope: { admissionKind: 'legacy_owner' },
        bindingServerInstanceId: 'server-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        mode: 'send',
        acceptedMessageId: 'legacy-accepted-message',
        requestFingerprint: 'd'.repeat(64),
        intent: { mode: 'send' },
        acceptedRevision: 0,
        state: 'accepted',
      })

      expect(() =>
        admitGenerationInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-a',
          sessionId: 'owner-a',
          interaction: 'send',
          chatOnlyEnabled: true,
          nowMs: 1_000,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<GenerationAdmissionError>>({ code: 'chat_occupancy_recovery_blocked' }),
      )

      enqueueMemoryJob(db, {
        id: 'legacy-operation-child-pin',
        chatId: 'chat-a',
        kind: 'summarize',
        payload: {},
        operationId: 'legacy-operation-pin',
        operationAttemptNo: 1,
        generationScope: { admissionKind: 'legacy_owner' },
      })
      expect(() =>
        admitGenerationInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-a',
          sessionId: 'owner-a',
          interaction: 'send',
          chatOnlyEnabled: true,
          allowedRecoveryPin: { id: 'legacy-operation-pin', kind: 'generation_operation' },
          nowMs: 1_000,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<GenerationAdmissionError>>({ code: 'chat_occupancy_recovery_blocked' }),
      )
      expect(
        admitGenerationInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-a',
          sessionId: 'owner-a',
          interaction: 'send',
          chatOnlyEnabled: true,
          allowedRecoveryOperationId: 'legacy-operation-pin',
          nowMs: 1_000,
        }),
      ).toEqual({ admissionKind: 'legacy_owner' })

      enqueueMemoryJob(db, {
        id: 'unrelated-child-pin',
        chatId: 'chat-a',
        kind: 'summarize',
        payload: {},
      })
      expect(() =>
        admitGenerationInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-a',
          sessionId: 'owner-a',
          interaction: 'send',
          chatOnlyEnabled: true,
          allowedRecoveryOperationId: 'legacy-operation-pin',
          nowMs: 1_000,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<GenerationAdmissionError>>({ code: 'chat_occupancy_recovery_blocked' }),
      )
    } finally {
      db.close()
    }
  })

  it('requires full normalization before demoted fresh work while retaining accepted owner authority', () => {
    const { db, lineage, occupancy } = harness()
    try {
      const claimA = occupancy.claim({
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: 'owner-a',
        claimClass: 'owner',
        expectedOccupancyEpoch: 0,
      })
      const claimB = occupancy.claim({
        databaseLineage: lineage,
        chatId: 'chat-b',
        sessionId: 'owner-a',
        claimClass: 'owner',
        expectedOccupancyEpoch: 0,
      })
      const scope = admitGenerationInTransaction(db, {
        databaseLineage: lineage,
        chatId: 'chat-b',
        sessionId: 'owner-a',
        occupancyProtocolVersion: 1,
        occupancyEpoch: claimB.occupancyEpoch,
        interaction: 'send',
        chatOnlyEnabled: true,
        nowMs: 1_000,
      })
      createGenerationOperation(db, {
        databaseLineage: lineage,
        operationId: 'operation-before-demotion',
        protocolVersion: 1,
        requestOrigin: 'accepted_send',
        creatorWriterSessionId: 'owner-a',
        creatorWriterEpoch: 1,
        generationScope: scope,
        bindingServerInstanceId: 'server-a',
        characterId: 'character-a',
        chatId: 'chat-b',
        mode: 'send',
        acceptedMessageId: 'message-user',
        requestFingerprint: 'c'.repeat(64),
        intent: { mode: 'send' },
        acceptedRevision: 0,
        state: 'accepted',
      })

      registerDatabaseWriterSession(db, 'owner-b')
      for (const [chatId, occupancyEpoch] of [
        ['chat-a', claimA.occupancyEpoch],
        ['chat-b', claimB.occupancyEpoch],
      ] as const) {
        expect(() =>
          admitGenerationInTransaction(db, {
            databaseLineage: lineage,
            chatId,
            sessionId: 'owner-a',
            occupancyProtocolVersion: 1,
            occupancyEpoch,
            interaction: 'send',
            chatOnlyEnabled: true,
            nowMs: 1_000,
          }),
        ).toThrowError(
          expect.objectContaining<Partial<GenerationAdmissionError>>({
            code: 'chat_occupancy_normalization_required',
          }),
        )
      }
      const normalized = occupancy.normalize({
        databaseLineage: lineage,
        chatId: 'chat-b',
        sessionId: 'owner-a',
        occupancyEpoch: claimB.occupancyEpoch,
      })
      expect(normalized).toMatchObject({ claimClass: 'chat_only', occupancyEpoch: claimB.occupancyEpoch })
      expect(occupancy.snapshot().occupancies.find((row) => row.chatId === 'chat-a')).toMatchObject({
        state: 'released',
        occupancyEpoch: claimA.occupancyEpoch + 1,
      })
      expect(
        admitGenerationInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-b',
          sessionId: 'owner-a',
          occupancyProtocolVersion: 1,
          occupancyEpoch: claimB.occupancyEpoch,
          interaction: 'send',
          chatOnlyEnabled: true,
          nowMs: 1_000,
        }),
      ).toMatchObject({ admissionKind: 'chat_only', occupancyClaimClass: 'chat_only' })
      expect(() =>
        assertPersistedGenerationScopeInTransaction(db, {
          ...scope,
          databaseLineage: lineage,
          chatId: 'chat-b',
          sessionId: 'owner-a',
        }),
      ).not.toThrow()
      expect(() =>
        assertPersistedGenerationScopeInTransaction(db, {
          ...scope,
          occupancyClaimClass: 'chat_only',
          databaseLineage: lineage,
          chatId: 'chat-b',
          sessionId: 'owner-a',
        }),
      ).toThrowError(expect.objectContaining<Partial<GenerationAdmissionError>>({ code: 'generation_scope_invalid' }))
    } finally {
      db.close()
    }
  })

  it('admits exact distinct-chat authority and rejects a foreign owner on the occupied target', () => {
    const { db, lineage, occupancy } = harness()
    try {
      const reader = occupancy.claim({
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: 'reader-a',
        claimClass: 'chat_only',
        expectedOccupancyEpoch: 0,
      })
      const owner = occupancy.claim({
        databaseLineage: lineage,
        chatId: 'chat-b',
        sessionId: 'owner-a',
        claimClass: 'owner',
        expectedOccupancyEpoch: 0,
      })

      const readerScope = admitGenerationInTransaction(db, {
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: 'reader-a',
        occupancyProtocolVersion: 1,
        occupancyEpoch: reader.occupancyEpoch,
        interaction: 'send',
        chatOnlyEnabled: true,
        nowMs: 1_000,
      })
      const ownerScope = admitGenerationInTransaction(db, {
        databaseLineage: lineage,
        chatId: 'chat-b',
        sessionId: 'owner-a',
        occupancyProtocolVersion: 1,
        occupancyEpoch: owner.occupancyEpoch,
        interaction: 'send',
        chatOnlyEnabled: true,
        nowMs: 1_000,
      })
      expect(readerScope).toMatchObject({ admissionKind: 'chat_only', permissionScopeVersion: 1 })
      expect(readerScope.permissionScope).toEqual(CHAT_ONLY_GENERATION_ALLOWLIST)
      expect(ownerScope.admissionKind).toBe('owner_occupancy')
      expect(() =>
        admitGenerationInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-a',
          sessionId: 'owner-a',
          interaction: 'send',
          chatOnlyEnabled: true,
          nowMs: 1_000,
        }),
      ).toThrowError(expect.objectContaining<Partial<GenerationAdmissionError>>({ code: 'chat_occupied' }))
      expect(() =>
        admitGenerationInTransaction(db, {
          databaseLineage: lineage,
          chatId: 'chat-a',
          sessionId: 'reader-a',
          occupancyProtocolVersion: 1,
          occupancyEpoch: reader.occupancyEpoch,
          interaction: 'continue',
          chatOnlyEnabled: true,
          nowMs: 1_000,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<GenerationAdmissionError>>({ code: 'chat_only_interaction_unsupported' }),
      )
    } finally {
      db.close()
    }
  })

  it('persists immutable authority through attempts, finalization, effects, and automatic jobs', () => {
    const { db, lineage, occupancy } = harness()
    try {
      const claim = occupancy.claim({
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: 'reader-a',
        claimClass: 'chat_only',
        expectedOccupancyEpoch: 0,
      })
      const scope = admitGenerationInTransaction(db, {
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId: 'reader-a',
        occupancyProtocolVersion: 1,
        occupancyEpoch: claim.occupancyEpoch,
        interaction: 'send',
        chatOnlyEnabled: true,
        nowMs: 1_000,
      })
      const operation = createGenerationOperation(db, {
        databaseLineage: lineage,
        operationId: 'operation-a',
        protocolVersion: 1,
        requestOrigin: 'accepted_send',
        creatorWriterSessionId: 'reader-a',
        creatorWriterEpoch: 1,
        generationScope: scope,
        bindingServerInstanceId: 'server-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        mode: 'send',
        acceptedMessageId: 'message-user',
        requestFingerprint: 'a'.repeat(64),
        intent: { mode: 'send' },
        acceptedRevision: 0,
        state: 'accepted',
      })
      reserveGenerationOperationAttempt(db, {
        databaseLineage: lineage,
        operationId: operation.operationId,
        expectedState: 'accepted',
        expectedStateVersion: operation.stateVersion,
        retryRequestId: 'retry-a',
        jobId: 'generation-a',
        serverInstanceId: 'server-a',
        actorWriterSessionId: 'reader-a',
        actorWriterEpoch: 1,
        launchRevision: 0,
      })
      enqueueGenerationFinalizationRetry(db, {
        generationId: 'generation-a',
        databaseLineage: lineage,
        operationId: 'operation-a',
        operationAttemptNo: 1,
        actorWriterSessionId: 'reader-a',
        actorWriterEpoch: 1,
        terminalOutcome: 'completed',
        generationScope: scope,
        chatId: 'chat-a',
        mode: 'send',
        message: { role: 'char', data: 'reply', chatId: 'message-assistant' },
        chatVarMutations: [],
      })
      ensureGenerationEffectLedger(db, {
        databaseLineage: lineage,
        operationId: 'operation-a',
        operationAttemptNo: 1,
        operationProtocolVersion: 1,
        generationId: 'generation-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        messageId: 'message-assistant',
        generationScope: scope,
      })
      enqueueMemoryJob(db, {
        id: 'memory-a',
        chatId: 'chat-a',
        kind: 'embed',
        payload: {},
        operationId: 'operation-a',
        operationAttemptNo: 1,
        generationScope: scope,
      })
      enqueueBardWikiJob(db, {
        id: 'bard-a',
        chatId: 'chat-a',
        kind: 'rebuild_chat',
        payload: {
          chatId: 'chat-a',
          generation: 1,
          sourceCursor: 0,
          sourceTotal: 0,
          policy: 'missing',
          stagingManifestId: 'manifest-a',
        },
        operationId: 'operation-a',
        operationAttemptNo: 1,
        generationScope: scope,
      })

      expect(
        db.prepare('SELECT accepted_admission_kind, accepted_occupancy_epoch FROM generation_operation_attempts').get(),
      ).toEqual({ accepted_admission_kind: 'chat_only', accepted_occupancy_epoch: claim.occupancyEpoch })
      expect(db.prepare('SELECT admission_kind, occupancy_epoch FROM generation_finalization_retries').get()).toEqual({
        admission_kind: 'chat_only',
        occupancy_epoch: claim.occupancyEpoch,
      })
      expect(
        db.prepare("SELECT status, reason FROM generation_effects WHERE effect_kind = 'plugin_output'").get(),
      ).toEqual({ status: 'skipped', reason: 'unsupported_chat_only_scope' })
      expect(db.prepare('SELECT admission_kind FROM memory_jobs WHERE id = ?').get('memory-a')).toEqual({
        admission_kind: 'chat_only',
      })
      expect(db.prepare('SELECT admission_kind FROM bardwiki_jobs WHERE id = ?').get('bard-a')).toEqual({
        admission_kind: 'chat_only',
      })
      expect(listGenerationOccupancyPins(db, 'chat-a').map((pin) => pin.kind)).toEqual(
        expect.arrayContaining([
          'generation_operation',
          'generation_finalization',
          'generation_effect',
          'memory_job',
          'bardwiki_job',
        ]),
      )

      expect(() =>
        assertPersistedGenerationScopeInTransaction(db, {
          ...scope,
          permissionScope: [...CHAT_ONLY_GENERATION_ALLOWLIST, 'character_fields' as never],
          databaseLineage: lineage,
          chatId: 'chat-a',
          sessionId: 'reader-a',
        }),
      ).toThrowError(expect.objectContaining<Partial<GenerationAdmissionError>>({ code: 'generation_scope_invalid' }))
    } finally {
      db.close()
    }
  })

  it('pins one bounded effective configuration fingerprint across explicit retries', () => {
    const { db, lineage } = harness()
    try {
      const configuration = {
        version: 1,
        database: { selectedModel: 'accepted-model', temperature: 0.25 },
        promptInfo: { marker: 'accepted-prompt' },
        resolvedMainProfile: { source: { kind: 'legacy' } },
      }
      const fingerprint = generationEffectiveConfigurationFingerprint(configuration)
      const accepted = createGenerationOperation(db, {
        databaseLineage: lineage,
        operationId: 'operation-config',
        protocolVersion: 1,
        requestOrigin: 'accepted_send',
        creatorWriterSessionId: 'owner-a',
        creatorWriterEpoch: 1,
        effectiveConfiguration: configuration,
        effectiveConfigurationFingerprint: fingerprint,
        bindingServerInstanceId: 'server-a',
        characterId: 'character-a',
        chatId: 'chat-a',
        mode: 'send',
        acceptedMessageId: 'message-user',
        requestFingerprint: 'b'.repeat(64),
        intent: { mode: 'send' },
        acceptedRevision: 0,
        state: 'accepted',
      })
      configuration.database.selectedModel = 'mutated-after-acceptance'
      const first = reserveGenerationOperationAttempt(db, {
        databaseLineage: lineage,
        operationId: accepted.operationId,
        expectedState: 'accepted',
        expectedStateVersion: accepted.stateVersion,
        retryRequestId: 'retry-config-1',
        jobId: 'generation-config-1',
        serverInstanceId: 'server-a',
        actorWriterSessionId: 'owner-a',
        actorWriterEpoch: 1,
        launchRevision: 0,
      })
      if (first.status === 'stale' || !first.operation) throw new Error('first attempt reservation did not apply')
      expect(first.operation.currentAttempt?.acceptedEffectiveConfigurationFingerprint).toBe(fingerprint)
      const retryable = transitionGenerationOperation(db, {
        databaseLineage: lineage,
        operationId: accepted.operationId,
        expectedState: 'launching',
        expectedStateVersion: first.operation.stateVersion,
        nextState: 'retryable',
      })
      expect(retryable.status).toBe('applied')
      if (retryable.status !== 'applied') throw new Error('retryable transition did not apply')
      const second = reserveGenerationOperationAttempt(db, {
        databaseLineage: lineage,
        operationId: accepted.operationId,
        expectedState: 'retryable',
        expectedStateVersion: retryable.operation.stateVersion,
        retryRequestId: 'retry-config-2',
        jobId: 'generation-config-2',
        serverInstanceId: 'server-a',
        actorWriterSessionId: 'owner-a',
        actorWriterEpoch: 1,
        launchRevision: 1,
      })
      if (second.status === 'stale' || !second.operation) throw new Error('second attempt reservation did not apply')
      expect(second.operation.currentAttempt?.acceptedEffectiveConfigurationFingerprint).toBe(fingerprint)
      expect(getGenerationOperationStoredRequest(db, lineage, accepted.operationId)).toMatchObject({
        effectiveConfiguration: {
          database: { selectedModel: 'accepted-model', temperature: 0.25 },
        },
        effectiveConfigurationFingerprint: fingerprint,
      })
    } finally {
      db.close()
    }
  })

  it('rejects an oversized effective configuration with stable 413 diagnostics', () => {
    expect(() =>
      generationEffectiveConfigurationFingerprint({
        value: 'x'.repeat(GENERATION_EFFECTIVE_CONFIGURATION_MAX_BYTES),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<GenerationEffectiveConfigurationTooLargeError>>({
        statusCode: 413,
        code: 'generation_effective_configuration_too_large',
        maxBytes: GENERATION_EFFECTIVE_CONFIGURATION_MAX_BYTES,
      }),
    )
  })
})
