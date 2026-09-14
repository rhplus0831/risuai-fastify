import type { DatabaseSync } from 'node:sqlite'
import { enqueueBardWikiJob } from './bardWikiJobs.js'
import { resolveBardWikiReceiptSourcePair } from './bardWikiReceipts.js'

interface ReceiptSourceRow {
  id: string
  chat_id: string
  user_message_id: string
  user_content_hash: string
  assistant_message_id: string
  assistant_content_hash: string
  state: 'queued' | 'processing' | 'applied' | 'failed' | 'obsolete' | 'stale' | 'needs_review'
  change_set_id: string
}

export interface BardWikiTranscriptInvalidationResult {
  obsoleteReceiptIds: string[]
  staleReceiptIds: string[]
  reconcileJobIds: string[]
}

export function invalidateBardWikiReceiptsForTranscriptMutation(
  db: DatabaseSync,
  chatId: string,
): BardWikiTranscriptInvalidationResult {
  const result: BardWikiTranscriptInvalidationResult = {
    obsoleteReceiptIds: [],
    staleReceiptIds: [],
    reconcileJobIds: [],
  }
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bardwiki_turn_receipts'").get()) {
    return result
  }
  const receipts = db
    .prepare(
      `SELECT id, chat_id, user_message_id, user_content_hash, assistant_message_id,
              assistant_content_hash, state, change_set_id
       FROM bardwiki_turn_receipts
       WHERE chat_id = ? AND state IN ('queued', 'processing', 'failed', 'applied')
       ORDER BY created_at, id`,
    )
    .all(chatId) as unknown as ReceiptSourceRow[]
  for (const receipt of receipts) {
    if (receiptSourceStillActive(db, receipt)) continue
    if (receipt.state === 'applied') {
      const changed = db
        .prepare(
          `UPDATE bardwiki_turn_receipts
           SET state = 'stale', error_code = 'bardwiki_source_changed',
               error_summary = 'Applied source messages changed or are no longer active',
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ? AND state = 'applied'`,
        )
        .run(receipt.id)
      if (changed.changes !== 1) continue
      // Reconciliation is exact-fence server maintenance created by the
      // already-authorized transcript mutation. Copying the obsolete source
      // generation tuple would make this cleanup stale after a release and
      // re-claim, leaving the cleanup job itself as a permanent occupancy pin.
      const job = enqueueBardWikiJob(db, {
        chatId,
        receiptId: receipt.id,
        kind: 'reconcile_receipt',
        payload: { receiptId: receipt.id, changeSetId: receipt.change_set_id },
      })
      db.prepare(
        `UPDATE bardwiki_turn_receipts
         SET job_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND state = 'stale'`,
      ).run(job.id, receipt.id)
      result.staleReceiptIds.push(receipt.id)
      result.reconcileJobIds.push(job.id)
      continue
    }
    db.prepare(
      `UPDATE bardwiki_jobs
       SET status = 'cancelled', error_code = 'bardwiki_source_changed',
           error_summary = 'Confirmed source messages changed or are no longer active',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE receipt_id = ? AND status IN ('pending', 'running')`,
    ).run(receipt.id)
    const changed = db
      .prepare(
        `UPDATE bardwiki_turn_receipts
         SET state = 'obsolete', error_code = 'bardwiki_source_changed',
             error_summary = 'Confirmed source messages changed or are no longer active',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND state IN ('queued', 'processing', 'failed')`,
      )
      .run(receipt.id)
    if (changed.changes === 1) result.obsoleteReceiptIds.push(receipt.id)
  }
  return result
}

function receiptSourceStillActive(db: DatabaseSync, receipt: ReceiptSourceRow): boolean {
  try {
    resolveBardWikiReceiptSourcePair(db, {
      chatId: receipt.chat_id,
      userMessageId: receipt.user_message_id,
      userContentHash: receipt.user_content_hash,
      assistantMessageId: receipt.assistant_message_id,
      assistantContentHash: receipt.assistant_content_hash,
    })
    return true
  } catch {
    return false
  }
}
