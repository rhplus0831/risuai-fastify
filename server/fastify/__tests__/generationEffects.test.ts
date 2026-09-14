import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { openDatabase } from '../src/db.js'
import { createInitialDatabase } from '../src/databaseDefaults.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
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
import { runServerMessageTranslation } from '../src/translation/serverMessageTranslation.js'
import { resolveRawMessageTranslatorIdentity } from '../src/translation/rawMessageTranslation.js'
import { resolveActiveMessageLocationById } from '../src/messageStore.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  claimGenerationEffect,
  ensureGenerationEffectLedger,
  listGenerationEffects,
  listPendingClientGenerationEffects,
  renewGenerationEffectClaim,
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
  await Promise.all(apps.splice(0).map((app) => app.close()))
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
})

async function openRouteHarness() {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-generation-effect-routes-'))
  dataDirs.push(dataDir)
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
  return { ...built, assertion, db, lineage: getDatabaseLineage(db) }
}

describe('generation effect ledger', () => {
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
    const { app, assertion, db, lineage, chatOccupancy } = await openRouteHarness()
    const originSession = 'reader-a'
    const foreignSession = 'reader-b'
    const firstOccupancy = chatOccupancy.claim({
      databaseLineage: lineage,
      chatId: 'chat-a',
      sessionId: originSession,
      claimClass: 'chat_only',
      expectedOccupancyEpoch: 0,
    })
    const generationScope = admitGenerationInTransaction(db, {
      databaseLineage: lineage,
      chatId: 'chat-a',
      sessionId: originSession,
      occupancyProtocolVersion: 1,
      occupancyEpoch: firstOccupancy.occupancyEpoch,
      interaction: 'send',
      chatOnlyEnabled: true,
    })
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

    const durableClaimIds = new Map<string, string>()
    for (const [kind, delivery] of [
      ['igp', 'live_terminal'],
      ['generated_translation', 'server'],
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
      occupancyEpoch: firstOccupancy.occupancyEpoch,
    })
    const handedOff = chatOccupancy.claim({
      databaseLineage: lineage,
      chatId: 'chat-a',
      sessionId: foreignSession,
      claimClass: 'chat_only',
      expectedOccupancyEpoch: released.occupancyEpoch,
    })
    expect(handedOff.occupancyEpoch).toBeGreaterThan(firstOccupancy.occupancyEpoch)

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
                  { role: 'char', data: 'Generated reply', chatId: 'message-a' },
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
      const runMessageTranslation = vi.fn(runServerMessageTranslation)

      await expect(
        retryPendingGenerationCompletionEffects({
          db,
          dataDir,
          eventSink: createCommandEventSink(),
          messageTranslationJobs: new MessageTranslationJobRegistry(),
          runMessageTranslation,
        }),
      ).rejects.toThrow('Generated translation effect is missing its accepted operation attempt')
      expect(runMessageTranslation).not.toHaveBeenCalled()
      expect(listGenerationEffects(db, 'generation-a')).toContainEqual(
        expect.objectContaining({
          kind: 'generated_translation',
          status: 'failed',
          delivery: 'server',
          lastError: 'Generated translation effect is missing its accepted operation attempt',
        }),
      )
    } finally {
      db.close()
    }
  })
})
