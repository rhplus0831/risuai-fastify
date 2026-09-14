import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_BARDWIKI_GLOBAL_SETTINGS } from '@risuai/protocol'
import { openDatabase } from '../src/db.js'
import {
  BardWikiJobValidationError,
  cancelBardWikiJob,
  claimNextBardWikiJob,
  completeBardWikiJob,
  enqueueBardWikiJob,
  getBardWikiJob,
  listBardWikiJobs,
  pruneTerminalBardWikiJobs,
  readBardWikiJobPayload,
  recoverRunningBardWikiJobs,
  retryFailedBardWikiJob,
  retryOrFailBardWikiJob,
} from '../src/bardWikiJobs.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
let dataDir: string
let db: DatabaseSync

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'risu-bardwiki-jobs-'))
  db = openDatabase(dataDir)
  seedChat('chat-a')
  seedChat('chat-b')
  seedReceipt('receipt-a', 'chat-a')
  seedReceipt('receipt-b', 'chat-b')
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function seedChat(chatId: string): void {
  const characterId = `character-${chatId}`
  db.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, 0, ?)').run(characterId, '{}')
  db.prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, 0, ?)').run(
    chatId,
    characterId,
    '{}',
  )
}

function seedReceipt(receiptId: string, chatId: string): void {
  db.prepare(
    `INSERT INTO bardwiki_turn_receipts (
      id, chat_id, user_message_id, user_content_hash, assistant_message_id,
      assistant_content_hash, confirmation_mode, state, change_set_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'explicit', 'queued', ?)`,
  ).run(receiptId, chatId, `${receiptId}-user`, HASH_A, `${receiptId}-assistant`, HASH_B, `${receiptId}-changes`)
}

function applyPayload(receiptId = 'receipt-a') {
  return {
    receiptId,
    expectedUserContentHash: HASH_A,
    expectedAssistantContentHash: HASH_B,
    modelProfileId: null,
    promptPresetId: null,
    promptVersion: 'bardwiki-event-v1',
    canonicalEnabled: false,
    repairAttemptCount: 0,
    acceptedSettings: { ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS, enabledByDefault: true },
  }
}

function enqueueApply(overrides: Partial<Parameters<typeof enqueueBardWikiJob>[1]> = {}) {
  return enqueueBardWikiJob(db, {
    id: 'job-a',
    instanceId: 'instance-a',
    chatId: 'chat-a',
    receiptId: 'receipt-a',
    kind: 'apply_turn',
    payload: applyPayload(),
    nextRunAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  })
}

describe('BardWiki job payload contract', () => {
  it('accepts each bounded identifier-only payload', () => {
    expect(readBardWikiJobPayload('apply_turn', applyPayload())).toEqual(applyPayload())
    expect(readBardWikiJobPayload('reconcile_receipt', { receiptId: 'receipt-a', changeSetId: 'change-a' })).toEqual({
      receiptId: 'receipt-a',
      changeSetId: 'change-a',
    })
    expect(
      readBardWikiJobPayload('rebuild_chat', {
        chatId: 'chat-a',
        generation: 2,
        sourceCursor: 10,
        sourceTotal: 12,
        policy: 'missing',
        stagingManifestId: 'manifest-a',
      }),
    ).toMatchObject({ chatId: 'chat-a', generation: 2, sourceCursor: 10, sourceTotal: 12, policy: 'missing' })
  })

  it('rejects unknown fields, transcript bodies, malformed hashes, and identity mismatch', () => {
    expect(() => readBardWikiJobPayload('apply_turn', { ...applyPayload(), transcript: 'secret' })).toThrow(
      BardWikiJobValidationError,
    )
    expect(() => readBardWikiJobPayload('apply_turn', { ...applyPayload(), expectedUserContentHash: 'wrong' })).toThrow(
      /SHA-256/u,
    )
    expect(() => enqueueApply({ receiptId: 'receipt-b' })).toThrow(/receiptId must match/u)
    expect(() =>
      enqueueBardWikiJob(db, {
        chatId: 'chat-a',
        receiptId: 'receipt-a',
        kind: 'reconcile_receipt',
        payload: { receiptId: 'receipt-a', changeSetId: 'change-a' },
        operationId: 'obsolete-operation',
        operationAttemptNo: 1,
        generationScope: { admissionKind: 'legacy_owner' },
      }),
    ).toThrow(/must not inherit source-generation authority/u)
  })
})

describe('BardWiki durable job repository', () => {
  it('claims due jobs atomically and permits only legal transitions', () => {
    const pending = enqueueApply()
    expect(pending).toMatchObject({ status: 'pending', attemptCount: 0, payload: applyPayload() })
    expect(claimNextBardWikiJob(db, { now: '2026-08-29T00:00:00.000Z' })).toMatchObject({
      id: pending.id,
      status: 'running',
      attemptCount: 1,
    })
    expect(claimNextBardWikiJob(db, { now: '2026-08-29T00:00:00.000Z' })).toBeNull()
    expect(completeBardWikiJob(db, pending.id)).toMatchObject({ status: 'completed' })
    expect(completeBardWikiJob(db, pending.id)).toBeNull()
  })

  it('retries with exponential backoff, exhausts attempts, and can explicitly retry a failure', () => {
    enqueueApply({ maxAttempts: 2 })
    claimNextBardWikiJob(db, { now: '2026-08-29T00:00:00.000Z' })
    expect(
      retryOrFailBardWikiJob(db, 'job-a', 'temporary', 'try again', {
        now: '2026-08-29T00:00:00.000Z',
        backoffBaseMs: 500,
      }),
    ).toMatchObject({ status: 'pending', nextRunAt: '2026-08-29T00:00:00.500Z' })
    claimNextBardWikiJob(db, { now: '2026-08-29T00:00:00.500Z' })
    expect(
      retryOrFailBardWikiJob(db, 'job-a', 'terminal', 'no more attempts', {
        now: '2026-08-29T00:00:00.500Z',
      }),
    ).toMatchObject({ status: 'failed', errorCode: 'terminal', errorSummary: 'no more attempts' })
    expect(retryFailedBardWikiJob(db, 'job-a', { now: '2026-08-29T00:00:01.000Z' })).toMatchObject({
      status: 'pending',
      attemptCount: 0,
      errorCode: null,
      nextRunAt: '2026-08-29T00:00:01.000Z',
    })
  })

  it('recovers abandoned jobs, cancels pending work, and prunes only old terminal rows', () => {
    enqueueApply({ maxAttempts: 2 })
    claimNextBardWikiJob(db, { now: '2026-08-29T00:00:00.000Z' })
    expect(recoverRunningBardWikiJobs(db, { now: '2026-08-29T00:00:00.000Z', backoffBaseMs: 0 })).toMatchObject([
      { id: 'job-a', status: 'pending', errorCode: 'bardwiki_worker_restarted' },
    ])
    expect(cancelBardWikiJob(db, 'job-a')).toMatchObject({ status: 'cancelled', errorCode: 'cancelled' })
    db.prepare("UPDATE bardwiki_jobs SET updated_at = '2026-08-20T00:00:00.000Z' WHERE id = 'job-a'").run()
    expect(pruneTerminalBardWikiJobs(db, { now: '2026-08-29T00:00:00.000Z', retentionMs: 86_400_000 })).toBe(1)
    expect(getBardWikiJob(db, 'job-a')).toBeNull()
    expect(listBardWikiJobs(db)).toEqual([])
  })
})
