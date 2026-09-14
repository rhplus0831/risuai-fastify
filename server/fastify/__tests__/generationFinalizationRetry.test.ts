import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../src/db.js'
import { appendChatMessage } from '../src/messageStore.js'
import {
  GENERATION_FINALIZATION_RETRY_MAX_DELAY_MS,
  GENERATION_FINALIZATION_STALLED_FAILURE_THRESHOLD,
  enqueueGenerationFinalizationRetry,
  findUncommittedGenerationFinalizationForChat,
  generationFinalizationRetryBackoffMs,
  listGenerationFinalizationRetryProjections,
  listPendingGenerationFinalizationRetries,
  markGenerationFinalizationRetryFailure,
} from '../src/generationFinalizationRetry.js'

let dataDir: string
let db: DatabaseSync

function enqueueSend(generationId: string): void {
  enqueueGenerationFinalizationRetry(db, {
    generationId,
    chatId: 'chat-a',
    mode: 'send',
    message: {
      role: 'char',
      data: `reply ${generationId}`,
      chatId: generationId,
      generationInfo: { generationId },
    },
    chatVarMutations: [],
    targetSnapshot: { mode: 'send', kind: 'tail', transcriptLength: 0 },
  })
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'risu-finalization-retry-'))
  db = openDatabase(dataDir)
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('generation finalization retry scheduling', () => {
  it('uses capped exponential backoff without an automatic give-up count', () => {
    expect(generationFinalizationRetryBackoffMs(0)).toBe(0)
    expect(generationFinalizationRetryBackoffMs(1)).toBe(5_000)
    expect(generationFinalizationRetryBackoffMs(2)).toBe(10_000)
    expect(generationFinalizationRetryBackoffMs(3)).toBe(20_000)
    expect(generationFinalizationRetryBackoffMs(100)).toBe(GENERATION_FINALIZATION_RETRY_MAX_DELAY_MS)
  })

  it('round-trips description mutations through the retained finalization envelope', () => {
    enqueueGenerationFinalizationRetry(db, {
      generationId: 'generation-desc',
      chatId: 'chat-a',
      mode: 'send',
      message: { role: 'char', data: 'reply', chatId: 'generation-desc' },
      chatVarMutations: [],
      characterFieldMutations: [{ key: 'desc', before: 'old description', after: 'new description' }],
      targetSnapshot: { mode: 'send', kind: 'tail', transcriptLength: 0 },
    })

    expect(listPendingGenerationFinalizationRetries(db)[0]?.attempt.characterFieldMutations).toEqual([
      { key: 'desc', before: 'old description', after: 'new description' },
    ])
  })

  it('round-trips legacy compatibility authority for queued publication recovery', () => {
    enqueueGenerationFinalizationRetry(db, {
      generationId: 'generation-compatibility',
      compatibilityAuthority: { databaseLineage: 'lineage-a', sessionId: 'owner-a' },
      chatId: 'chat-a',
      mode: 'send',
      message: { role: 'char', data: 'compatibility partial', chatId: 'generation-compatibility' },
      chatVarMutations: [],
      targetSnapshot: { mode: 'send', kind: 'tail', transcriptLength: 0 },
    })

    expect(listPendingGenerationFinalizationRetries(db)[0]?.attempt.compatibilityAuthority).toEqual({
      databaseLineage: 'lineage-a',
      sessionId: 'owner-a',
    })
  })

  it('fails closed when a retained compatibility authority pair is incomplete or mixed', () => {
    enqueueSend('generation-incomplete-compatibility')
    db.prepare(
      `UPDATE generation_finalization_retries
       SET compatibility_database_lineage = 'lineage-a'
       WHERE generation_id = 'generation-incomplete-compatibility'`,
    ).run()
    expect(() => listPendingGenerationFinalizationRetries(db)).toThrow('incomplete compatibility authority')

    db.prepare(
      `UPDATE generation_finalization_retries
       SET compatibility_session_id = 'owner-a', database_lineage = 'operation-lineage'
       WHERE generation_id = 'generation-incomplete-compatibility'`,
    ).run()
    expect(() => listPendingGenerationFinalizationRetries(db)).toThrow('mixes compatibility and operation authority')

    db.prepare(
      `UPDATE generation_finalization_retries
       SET database_lineage = NULL, admission_kind = 'legacy_owner'
       WHERE generation_id = 'generation-incomplete-compatibility'`,
    ).run()
    expect(() => listPendingGenerationFinalizationRetries(db)).toThrow('mixes compatibility and operation authority')
  })

  it('keeps a failed row out of replay selection until its calculated due time', () => {
    enqueueSend('generation-a')
    markGenerationFinalizationRetryFailure(db, 'generation-a', 'temporary failure', false)
    db.prepare('UPDATE generation_finalization_retries SET updated_at = ? WHERE generation_id = ?').run(
      '2026-08-11T00:00:00.000Z',
      'generation-a',
    )

    expect(listPendingGenerationFinalizationRetries(db, { now: '2026-08-11T00:00:04.999Z' })).toEqual([])
    expect(listPendingGenerationFinalizationRetries(db, { now: '2026-08-11T00:00:05.000Z' })).toEqual([
      expect.objectContaining({
        failureCount: 1,
        nextAttemptAt: '2026-08-11T00:00:05.000Z',
      }),
    ])
  })

  it('projects threshold failures as transiently stalled while retaining them as pending', () => {
    enqueueSend('generation-stalled')
    for (let failure = 0; failure < GENERATION_FINALIZATION_STALLED_FAILURE_THRESHOLD; failure += 1) {
      markGenerationFinalizationRetryFailure(db, 'generation-stalled', `temporary failure ${failure}`, false)
    }

    expect(listGenerationFinalizationRetryProjections(db)).toEqual([
      expect.objectContaining({
        generationId: 'generation-stalled',
        state: 'stalled',
        failureCount: GENERATION_FINALIZATION_STALLED_FAILURE_THRESHOLD,
        provisionalMessage: expect.objectContaining({ data: 'reply generation-stalled' }),
      }),
    ])
    expect(findUncommittedGenerationFinalizationForChat(db, 'chat-a')).toEqual({
      generationId: 'generation-stalled',
    })
    expect(
      db
        .prepare('SELECT status FROM generation_finalization_retries WHERE generation_id = ?')
        .get('generation-stalled'),
    ).toEqual({ status: 'pending' })
  })

  it('projects stalled_legacy as terminal and never schedules it for replay', () => {
    enqueueSend('generation-legacy')
    db.prepare(
      `
        UPDATE generation_finalization_retries
        SET mode = 'continue', target_message_id = 'message-a', target_snapshot_json = NULL
        WHERE generation_id = ?
      `,
    ).run('generation-legacy')
    markGenerationFinalizationRetryFailure(db, 'generation-legacy', 'stalled_legacy', true)

    expect(listPendingGenerationFinalizationRetries(db, { now: '2100-01-01T00:00:00.000Z' })).toEqual([])
    expect(findUncommittedGenerationFinalizationForChat(db, 'chat-a')).toBeUndefined()
    expect(listGenerationFinalizationRetryProjections(db)).toEqual([
      expect.objectContaining({
        generationId: 'generation-legacy',
        messageId: 'message-a',
        state: 'stalled_legacy',
      }),
    ])
  })

  it('does not mislabel an authoritative message with cleanup remaining as provisional', () => {
    enqueueSend('generation-committed')
    appendChatMessage(db, 'chat-a', {
      role: 'char',
      data: 'reply generation-committed',
      chatId: 'generation-committed',
      generationInfo: { generationId: 'generation-committed' },
    })

    expect(listGenerationFinalizationRetryProjections(db)).toEqual([
      expect.objectContaining({
        generationId: 'generation-committed',
        state: 'committed_cleanup_pending',
      }),
    ])
    expect(listGenerationFinalizationRetryProjections(db)[0]).not.toHaveProperty('provisionalMessage')
    expect(findUncommittedGenerationFinalizationForChat(db, 'chat-a')).toBeUndefined()
  })
})
