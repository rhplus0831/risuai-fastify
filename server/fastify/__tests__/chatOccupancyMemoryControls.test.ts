import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { enqueueBardWikiJob, getBardWikiJob } from '../src/bardWikiJobs.js'
import { getDatabaseOwnershipSnapshot } from '../src/databaseLineage.js'
import { admitGenerationInTransaction, type PersistedGenerationScope } from '../src/generationScope.js'
import { createGenerationOperation, reserveGenerationOperationAttempt } from '../src/generationOperations.js'
import {
  createMemoryChunk,
  createMemorySummary,
  enqueueMemoryJob,
  getMemoryJob,
  getMemorySummary,
} from '../src/memoryRepository.js'
import { setupAuthedClient } from './helpers/auth.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

interface Harness {
  app: FastifyInstance
  dataDir: string
  db: DatabaseSync
  assertion: string
  lineage: string
  claim: (sessionId: string, claimClass: 'owner' | 'chat_only') => void
}

let harness: Harness

beforeEach(async () => {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-chat-occupancy-memory-controls-'))
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
  const { assertion } = await setupAuthedClient(built.app)
  const db = built.chatOccupancy.db
  db.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, 0, ?)').run('character-a', '{}')
  db.prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, 0, ?)').run(
    'chat-a',
    'character-a',
    '{}',
  )
  const bootstrap = await built.app.inject({
    method: 'GET',
    url: '/api/v1/bootstrap',
    headers: { 'risu-auth': assertion, 'risu-writer-session': 'owner-a' },
  })
  expect(bootstrap.statusCode).toBe(200)
  const lineage = bootstrap.json().databaseLineage as string
  harness = {
    app: built.app,
    dataDir,
    db,
    assertion,
    lineage,
    claim(sessionId, claimClass) {
      built.chatOccupancy.claim({
        databaseLineage: lineage,
        chatId: 'chat-a',
        sessionId,
        claimClass,
        expectedOccupancyEpoch: 0,
      })
    },
  }
})

afterEach(async () => {
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
})

function ownerHeaders(sessionId = 'owner-a'): Record<string, string> {
  return { 'risu-auth': harness.assertion, 'risu-writer-session': sessionId }
}

function seedManualMemoryControls(): void {
  createMemoryChunk(harness.db, {
    id: 'chunk-a',
    chatId: 'chat-a',
    rangeStartSeq: 0,
    rangeEndSeq: 0,
    text: 'source',
    status: 'summarized',
  })
  createMemorySummary(harness.db, {
    id: 'summary-update',
    chatId: 'chat-a',
    chunkId: 'chunk-a',
    model: 'model-a',
    text: 'before update',
    tokens: 2,
  })
  createMemorySummary(harness.db, {
    id: 'summary-delete',
    chatId: 'chat-a',
    chunkId: 'chunk-a',
    model: 'model-b',
    text: 'before delete',
    tokens: 2,
  })
  enqueueMemoryJob(harness.db, {
    id: 'memory-cancel',
    chatId: 'chat-a',
    kind: 'embed',
    payload: { chunkId: 'chunk-a' },
  })
  enqueueBardWikiJob(harness.db, {
    id: 'bard-cancel',
    chatId: 'chat-a',
    kind: 'rebuild_chat',
    payload: rebuildPayload('cancel'),
  })
  enqueueBardWikiJob(harness.db, {
    id: 'bard-retry',
    chatId: 'chat-a',
    kind: 'rebuild_chat',
    payload: rebuildPayload('retry'),
  })
  harness.db
    .prepare(
      `UPDATE bardwiki_jobs
       SET status = 'failed', error_code = 'provider_failed', error_summary = 'failed before retry'
       WHERE id = 'bard-retry'`,
    )
    .run()
}

function rebuildPayload(suffix: string) {
  return {
    chatId: 'chat-a',
    generation: 1,
    sourceCursor: 0,
    sourceTotal: 0,
    policy: 'missing' as const,
    stagingManifestId: `manifest-${suffix}`,
  }
}

describe('chat occupancy memory controls', () => {
  it('rejects every foreign-occupied manual mutation and rolls back job and summary state', async () => {
    harness.claim('reader-a', 'chat_only')
    seedManualMemoryControls()

    const requests = [
      {
        method: 'POST' as const,
        url: '/api/v1/memory/jobs',
        payload: { chatId: 'chat-a', kind: 'summarize', payload: { chunkId: 'chunk-a' } },
      },
      { method: 'DELETE' as const, url: '/api/v1/memory/jobs/memory-cancel' },
      {
        method: 'PATCH' as const,
        url: '/api/v1/memory/summaries/summary-update',
        payload: { text: 'forged update' },
      },
      { method: 'DELETE' as const, url: '/api/v1/memory/summaries/summary-delete' },
      { method: 'DELETE' as const, url: '/api/v1/bardwiki/jobs/bard-cancel' },
      { method: 'POST' as const, url: '/api/v1/bardwiki/jobs/bard-retry/retry' },
    ]

    for (const request of requests) {
      const response = await harness.app.inject({ ...request, headers: ownerHeaders() })
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(423)
      expect(response.json()).toMatchObject({
        error: 'chat_occupied',
        chatId: 'chat-a',
        conflictingChatIds: ['chat-a'],
        safeRelease: expect.any(String),
      })
    }

    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM memory_jobs WHERE id <> 'memory-cancel'").get()).toEqual({
      count: 0,
    })
    expect(getMemoryJob(harness.db, 'memory-cancel')?.status).toBe('pending')
    expect(getMemorySummary(harness.db, 'summary-update')?.text).toBe('before update')
    expect(getMemorySummary(harness.db, 'summary-delete')?.text).toBe('before delete')
    expect(getBardWikiJob(harness.db, 'bard-cancel')?.status).toBe('pending')
    expect(getBardWikiJob(harness.db, 'bard-retry')).toMatchObject({
      status: 'failed',
      errorCode: 'provider_failed',
      errorSummary: 'failed before retry',
    })
  })

  it('preserves manual owner controls for an owner-occupied chat', async () => {
    harness.claim('owner-a', 'owner')
    seedManualMemoryControls()

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/memory/jobs',
      headers: ownerHeaders(),
      payload: { chatId: 'chat-a', kind: 'summarize', payload: { chunkId: 'chunk-a' } },
    })
    expect(created.statusCode).toBe(201)

    const cancelledMemory = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/memory/jobs/memory-cancel',
      headers: ownerHeaders(),
    })
    expect(cancelledMemory.statusCode).toBe(200)
    expect(getMemoryJob(harness.db, 'memory-cancel')?.status).toBe('cancelled')

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/memory/summaries/summary-update',
      headers: ownerHeaders(),
      payload: { text: 'after update', isImportant: true },
    })
    expect(updated.statusCode).toBe(200)
    expect(getMemorySummary(harness.db, 'summary-update')).toMatchObject({
      text: 'after update',
      metadata: { isImportant: true },
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/memory/summaries/summary-delete',
      headers: ownerHeaders(),
    })
    expect(deleted.statusCode).toBe(200)
    expect(getMemorySummary(harness.db, 'summary-delete')).toBeNull()

    const cancelledBardWiki = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/bardwiki/jobs/bard-cancel',
      headers: ownerHeaders(),
    })
    expect(cancelledBardWiki.statusCode).toBe(200)
    expect(getBardWikiJob(harness.db, 'bard-cancel')?.status).toBe('cancelled')

    const retriedBardWiki = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/bardwiki/jobs/bard-retry/retry',
      headers: ownerHeaders(),
    })
    expect(retriedBardWiki.statusCode).toBe(200)
    expect(getBardWikiJob(harness.db, 'bard-retry')?.status).toBe('pending')
  })

  it('does not transfer automatic job control to a later general owner', async () => {
    harness.claim('owner-a', 'owner')
    const scope = seedScopedGenerationOperation()
    for (const memoryJobId of ['scoped-memory-owner', 'scoped-memory-foreign']) {
      enqueueMemoryJob(harness.db, {
        id: memoryJobId,
        chatId: 'chat-a',
        kind: 'embed',
        payload: { chunkId: 'chunk-a' },
        operationId: 'operation-a',
        operationAttemptNo: 1,
        generationScope: scope,
      })
    }
    for (const [jobId, receiptId] of [
      ['scoped-bard-owner', 'receipt-owner'],
      ['scoped-bard-foreign', 'receipt-foreign'],
    ] as const) {
      seedBardWikiReceipt(receiptId)
      enqueueBardWikiJob(harness.db, {
        id: jobId,
        chatId: 'chat-a',
        receiptId,
        kind: 'apply_turn',
        payload: applyTurnPayload(receiptId),
        operationId: 'operation-a',
        operationAttemptNo: 1,
        generationScope: scope,
      })
      harness.db
        .prepare(
          `UPDATE bardwiki_jobs
           SET status = 'failed', error_code = 'provider_failed', error_summary = 'retry me'
           WHERE id = ?`,
        )
        .run(jobId)
      harness.db.prepare("UPDATE bardwiki_turn_receipts SET state = 'failed' WHERE id = ?").run(receiptId)
    }

    const ownerCancel = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/memory/jobs/scoped-memory-owner',
      headers: ownerHeaders(),
    })
    expect(ownerCancel.statusCode).toBe(200)
    const ownerRetry = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/bardwiki/jobs/scoped-bard-owner/retry',
      headers: ownerHeaders(),
    })
    expect(ownerRetry.statusCode).toBe(200)

    const handoff = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: ownerHeaders('owner-b'),
    })
    expect(handoff.statusCode).toBe(200)
    expect(handoff.json().writer.sessionId).toBe('owner-b')

    for (const request of [
      { method: 'DELETE' as const, url: '/api/v1/memory/jobs/scoped-memory-foreign' },
      { method: 'POST' as const, url: '/api/v1/bardwiki/jobs/scoped-bard-foreign/retry' },
    ]) {
      const response = await harness.app.inject({ ...request, headers: ownerHeaders('owner-b') })
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(423)
      expect(response.json()).toEqual({ error: 'generation_job_foreign_session' })
    }

    expect(getMemoryJob(harness.db, 'scoped-memory-owner')?.status).toBe('cancelled')
    expect(getBardWikiJob(harness.db, 'scoped-bard-owner')?.status).toBe('pending')
    expect(getMemoryJob(harness.db, 'scoped-memory-foreign')?.status).toBe('pending')
    expect(getBardWikiJob(harness.db, 'scoped-bard-foreign')?.status).toBe('failed')
    expect(harness.db.prepare("SELECT state FROM bardwiki_turn_receipts WHERE id = 'receipt-foreign'").get()).toEqual({
      state: 'failed',
    })
  })
})

function seedScopedGenerationOperation(): PersistedGenerationScope {
  const occupancy = harness.db
    .prepare('SELECT occupancy_epoch FROM chat_occupancies WHERE chat_id = ?')
    .get('chat-a') as {
    occupancy_epoch: number
  }
  const scope = admitGenerationInTransaction(harness.db, {
    databaseLineage: harness.lineage,
    chatId: 'chat-a',
    sessionId: 'owner-a',
    occupancyProtocolVersion: 1,
    occupancyEpoch: occupancy.occupancy_epoch,
    interaction: 'send',
    chatOnlyEnabled: true,
  })
  const writerEpoch = getDatabaseOwnershipSnapshot(harness.db).writer.epoch
  const operation = createGenerationOperation(harness.db, {
    databaseLineage: harness.lineage,
    operationId: 'operation-a',
    protocolVersion: 1,
    requestOrigin: 'accepted_send',
    creatorWriterSessionId: 'owner-a',
    creatorWriterEpoch: writerEpoch,
    generationScope: scope,
    bindingServerInstanceId: 'server-a',
    characterId: 'character-a',
    chatId: 'chat-a',
    mode: 'send',
    acceptedMessageId: 'message-user',
    requestFingerprint: 'c'.repeat(64),
    intent: { mode: 'send' },
    acceptedRevision: 0,
    state: 'accepted',
  })
  reserveGenerationOperationAttempt(harness.db, {
    databaseLineage: harness.lineage,
    operationId: operation.operationId,
    expectedState: 'accepted',
    expectedStateVersion: operation.stateVersion,
    retryRequestId: 'retry-a',
    jobId: 'generation-a',
    serverInstanceId: 'server-a',
    actorWriterSessionId: 'owner-a',
    actorWriterEpoch: writerEpoch,
    launchRevision: 0,
  })
  return scope
}

function seedBardWikiReceipt(id: string): void {
  harness.db
    .prepare(
      `INSERT INTO bardwiki_turn_receipts (
        id, chat_id, user_message_id, user_content_hash, assistant_message_id,
        assistant_content_hash, confirmation_mode, state, change_set_id
      ) VALUES (?, 'chat-a', ?, ?, ?, ?, 'automatic', 'queued', ?)`,
    )
    .run(id, `user-${id}`, HASH_A, `assistant-${id}`, HASH_B, `changes-${id}`)
}

function applyTurnPayload(receiptId: string) {
  return {
    receiptId,
    expectedUserContentHash: HASH_A,
    expectedAssistantContentHash: HASH_B,
    modelProfileId: null,
    promptPresetId: null,
    promptVersion: 'bardwiki-event-v1',
    canonicalEnabled: false,
    repairAttemptCount: 0,
  }
}
