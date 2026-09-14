import type { DatabaseSync } from 'node:sqlite'
import {
  COMMAND_EVENT_CATALOG,
  persistCommandEvent,
  type CommandEvent,
  type CommandEventSink,
} from './commands/events.js'
import { bumpRevision, getSchemaState } from './db.js'
import {
  deleteBardWikiDocument,
  getBardWikiDocument,
  getBardWikiDocumentVersion,
  getBardWikiReceiptSummary,
  updateBardWikiDocument,
} from './bardWikiRepository.js'
import {
  assertBardWikiJobGenerationScope,
  getBardWikiJob,
  type BardWikiJob,
  type BardWikiReconcileReceiptJobPayload,
} from './bardWikiJobs.js'
import { BardWikiJobHandlerError, type BardWikiJobHandlerContext } from './bardWikiWorker.js'

interface ChangeManifestRow {
  document_id: string
  before_version: number | null
  before_hash: string | null
  after_version: number
  after_hash: string
}

export interface BardWikiReconcileHandlerOptions {
  db: DatabaseSync
  eventSink?: CommandEventSink
}

export function createBardWikiReconcileReceiptHandler(options: BardWikiReconcileHandlerOptions) {
  return async (job: BardWikiJob, _context: BardWikiJobHandlerContext): Promise<void> => {
    if (job.kind !== 'reconcile_receipt') {
      throw new BardWikiJobHandlerError('bardwiki_invalid_job', 'Expected reconcile_receipt job')
    }
    const payload = job.payload as BardWikiReconcileReceiptJobPayload
    const event = reconcileReceipt(options.db, job, payload)
    if (!event) return
    try {
      options.eventSink?.emit(event)
    } catch {
      // Durable command-event replay and targeted reads remain authoritative.
    }
  }
}

function reconcileReceipt(
  db: DatabaseSync,
  job: BardWikiJob,
  payload: BardWikiReconcileReceiptJobPayload,
): CommandEvent | null {
  let transactionOpen = false
  db.exec('BEGIN IMMEDIATE')
  transactionOpen = true
  try {
    const currentJob = getBardWikiJob(db, job.id)
    const receipt = getBardWikiReceiptSummary(db, payload.receiptId)
    const receiptIdentity = db
      .prepare('SELECT change_set_id FROM bardwiki_turn_receipts WHERE id = ?')
      .get(payload.receiptId) as { change_set_id: string } | undefined
    if (
      !currentJob ||
      currentJob.status !== 'running' ||
      !receipt ||
      receipt.chatId !== job.chatId ||
      receipt.state !== 'stale' ||
      receiptIdentity?.change_set_id !== payload.changeSetId
    ) {
      db.exec('COMMIT')
      transactionOpen = false
      return null
    }
    assertBardWikiJobGenerationScope(db, currentJob)
    const manifest = db
      .prepare(
        `SELECT document_id, before_version, before_hash, after_version, after_hash
         FROM bardwiki_change_manifest WHERE receipt_id = ? ORDER BY document_id`,
      )
      .all(receipt.id) as unknown as ChangeManifestRow[]
    const safe =
      manifest.length > 0 &&
      manifest.every((entry) => {
        const current = getBardWikiDocument(db, job.chatId, entry.document_id, { includeDeleted: true })
        const beforeIsAvailable =
          entry.before_version === null && entry.before_hash === null
            ? true
            : entry.before_version !== null && entry.before_hash !== null
              ? (() => {
                  const before = getBardWikiDocumentVersion(db, entry.document_id, entry.before_version)
                  return before !== null && !before.deleted && before.contentHash === entry.before_hash
                })()
              : false
        return (
          beforeIsAvailable &&
          current !== null &&
          current.deletedAt === null &&
          current.version === entry.after_version &&
          current.contentHash === entry.after_hash
        )
      })
    const nextRevision = getSchemaState(db).revision + 1
    if (safe) {
      safelyInvertChangeSet(db, job, receipt.id, manifest, nextRevision)
      db.prepare(
        `UPDATE bardwiki_turn_receipts
         SET state = 'obsolete', error_code = 'bardwiki_source_changed',
             error_summary = 'Stale BardWiki effects were safely removed',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND state = 'stale'`,
      ).run(receipt.id)
    } else {
      markChangeSetNeedsReview(db, job, receipt.id, manifest, nextRevision)
      db.prepare(
        `UPDATE bardwiki_turn_receipts
         SET state = 'needs_review', error_code = 'bardwiki_reconcile_needs_review',
             error_summary = 'Later document changes prevent a safe automatic rollback',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND state = 'stale'`,
      ).run(receipt.id)
    }
    const revision = bumpRevision(db)
    if (revision !== nextRevision) throw new Error('BardWiki reconcile revision changed during commit')
    const event: CommandEvent = {
      ...COMMAND_EVENT_CATALOG.bardWikiReconciliationCompleted,
      revision,
      id: job.chatId,
      jobId: job.id,
      sourceMessageId: receipt.assistantMessageId,
    }
    persistCommandEvent(db, event)
    db.exec('COMMIT')
    transactionOpen = false
    return event
  } catch (error) {
    if (transactionOpen) db.exec('ROLLBACK')
    throw error
  }
}

function safelyInvertChangeSet(
  db: DatabaseSync,
  job: BardWikiJob,
  receiptId: string,
  manifest: readonly ChangeManifestRow[],
  commandRevision: number,
): void {
  for (const entry of manifest) {
    if (entry.before_version === null || entry.before_hash === null) {
      deleteBardWikiDocument(db, job.chatId, entry.document_id, {
        expectedVersion: entry.after_version,
        expectedContentHash: entry.after_hash,
        actor: 'system',
        reason: 'reconcile',
        receiptId,
        jobId: job.id,
        commandRevision,
      })
      continue
    }
    const before = getBardWikiDocumentVersion(db, entry.document_id, entry.before_version)
    if (!before || before.contentHash !== entry.before_hash || before.deleted) {
      throw new BardWikiJobHandlerError(
        'bardwiki_reconcile_needs_review',
        `BardWiki before snapshot is unavailable: ${entry.document_id}`,
        { retryable: false },
      )
    }
    updateBardWikiDocument(db, job.chatId, entry.document_id, {
      expectedVersion: entry.after_version,
      expectedContentHash: entry.after_hash,
      kind: before.kind,
      title: before.title,
      logicalPath: before.logicalPath,
      aliases: before.aliases,
      contextPolicy: before.contextPolicy,
      reviewState: before.reviewState,
      markdown: before.markdown,
      actor: 'system',
      reason: 'reconcile',
      receiptId,
      jobId: job.id,
      commandRevision,
    })
  }
}

function markChangeSetNeedsReview(
  db: DatabaseSync,
  job: BardWikiJob,
  receiptId: string,
  manifest: readonly ChangeManifestRow[],
  commandRevision: number,
): void {
  for (const entry of manifest) {
    const current = getBardWikiDocument(db, job.chatId, entry.document_id)
    if (!current || current.reviewState === 'needs_review') continue
    updateBardWikiDocument(db, job.chatId, current.id, {
      expectedVersion: current.version,
      expectedContentHash: current.contentHash,
      reviewState: 'needs_review',
      actor: 'system',
      reason: 'reconcile',
      receiptId,
      jobId: job.id,
      commandRevision,
    })
  }
}
