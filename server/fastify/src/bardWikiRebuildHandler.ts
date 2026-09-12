import { assertDatabaseLineage, getDatabaseLineage } from './databaseLineage.js'
import { decodeProviderGenerationSettings } from './prompt/generationInputDecoder.js'
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  COMMAND_EVENT_CATALOG,
  persistCommandEvent,
  type CommandEvent,
  type CommandEventSink,
} from './commands/events.js'
import { bumpRevision, getSchemaState } from './db.js'
import {
  createBardWikiDocument,
  BardWikiValidationError,
  deleteBardWikiDocument,
  getBardWikiDocument,
  getBardWikiReceiptSummary,
  listBardWikiDocumentVersions,
  listBardWikiDocuments,
  normalizeBardWikiPath,
  updateBardWikiDocument,
  type BardWikiDocument,
} from './bardWikiRepository.js'
import {
  BARDWIKI_EVENT_PROMPT_VERSION,
  listBardWikiRebuildSourcePairs,
  resolveBardWikiReceiptSourcePair,
  resolveEffectiveBardWikiSettingsForChat,
  type BardWikiRebuildPolicy,
  type BardWikiSourcePair,
} from './bardWikiReceipts.js'
import {
  enqueueBardWikiJob,
  getBardWikiJob,
  rescheduleRunningBardWikiJob,
  type BardWikiJob,
  type BardWikiRebuildChatJobPayload,
} from './bardWikiJobs.js'
import {
  analyzeBardWikiEvent,
  BARDWIKI_EVENT_MODEL_OUTPUT_MAX_BYTES,
  validateBardWikiEventDraft,
  type BardWikiEventAnalyzer,
  type BardWikiEventDraft,
} from './bardWikiEventModel.js'
import {
  BardWikiJobHandlerError,
  type BardWikiJobHandlerContext,
  type BardWikiJobHandlerResult,
} from './bardWikiWorker.js'
import { loadPersistedDatabaseForMemoryJob } from './repository.js'
import type { BardWikiGenerationDatabase } from './bardWikiTypes.js'

export const BARDWIKI_REBUILD_BATCH_SIZE = 8

export interface BardWikiRebuildPreview {
  chatId: string
  policy: BardWikiRebuildPolicy
  sourceCount: number
  replaceDerivedDocumentCount: number
  preserveUserDocumentCount: number
  activeJobId: string | null
}

export interface EnqueueBardWikiRebuildInput {
  chatId: string
  policy: BardWikiRebuildPolicy
  expectedSourceCount: number
}

export interface BardWikiRebuildHandlerOptions {
  db: DatabaseSync
  dataDir: string
  eventSink?: CommandEventSink
  analyze?: BardWikiEventAnalyzer
  loadDatabase?: (chatId: string) => unknown
  providerFetchDeadlineMs?: number
  batchSize?: number
  hooks?: {
    afterProvider?: (sourceCursor: number) => void
    beforeCheckpoint?: (sourceCursor: number) => void
    beforePublish?: () => void
    afterPublish?: () => void
  }
}

interface StagedRebuildChange {
  sourceOrdinal: number
  source: Omit<BardWikiSourcePair, 'chatId' | 'userContent' | 'assistantContent'>
  draft: BardWikiEventDraft
}

export function previewBardWikiRebuild(
  db: DatabaseSync,
  chatId: string,
  policy: BardWikiRebuildPolicy,
): BardWikiRebuildPreview {
  const sourceCount = listBardWikiRebuildSourcePairs(db, chatId, policy).length
  const actorCounts = countCurrentDocumentActors(db, chatId)
  const active = db
    .prepare(
      `SELECT id FROM bardwiki_jobs
       WHERE chat_id = ? AND kind = 'rebuild_chat' AND status IN ('pending', 'running')
       ORDER BY created_at, id LIMIT 1`,
    )
    .get(chatId) as { id: string } | undefined
  return {
    chatId,
    policy,
    sourceCount,
    replaceDerivedDocumentCount: policy === 'full' ? actorCounts.model + actorCounts.system : 0,
    preserveUserDocumentCount: actorCounts.user,
    activeJobId: active?.id ?? null,
  }
}

export function enqueueBardWikiRebuild(db: DatabaseSync, input: EnqueueBardWikiRebuildInput): BardWikiJob {
  const preview = previewBardWikiRebuild(db, input.chatId, input.policy)
  if (preview.activeJobId) {
    throw new BardWikiValidationError('bardwiki_rebuild_active', 'A BardWiki rebuild is already active')
  }
  if (preview.sourceCount !== input.expectedSourceCount) {
    throw new BardWikiValidationError('bardwiki_rebuild_preview_stale', 'The BardWiki rebuild preview is stale')
  }
  const settings = resolveEffectiveBardWikiSettingsForChat(db, input.chatId)
  if (!settings.enabledByDefault) {
    throw new BardWikiValidationError('bardwiki_disabled', 'BardWiki is disabled for this chat')
  }
  if (input.policy === 'full') cancelSupersededIncrementalJobs(db, input.chatId)
  const generationRow = db
    .prepare(
      `SELECT COALESCE(MAX(CAST(json_extract(payload_json, '$.generation') AS INTEGER)), 0) AS generation
       FROM bardwiki_jobs WHERE chat_id = ? AND kind = 'rebuild_chat'`,
    )
    .get(input.chatId) as { generation: number }
  return enqueueBardWikiJob(db, {
    chatId: input.chatId,
    kind: 'rebuild_chat',
    maxAttempts: 5,
    payload: {
      chatId: input.chatId,
      generation: generationRow.generation + 1,
      sourceCursor: 0,
      sourceTotal: preview.sourceCount,
      policy: input.policy,
      stagingManifestId: randomUUID(),
    },
  })
}

export function createBardWikiRebuildHandler(options: BardWikiRebuildHandlerOptions) {
  const analyze = options.analyze ?? analyzeBardWikiEvent
  const batchSize = Math.max(
    1,
    Math.min(BARDWIKI_REBUILD_BATCH_SIZE, Math.trunc(options.batchSize ?? BARDWIKI_REBUILD_BATCH_SIZE)),
  )
  return async (job: BardWikiJob, context: BardWikiJobHandlerContext): Promise<BardWikiJobHandlerResult> => {
    const lineage = getDatabaseLineage(options.db)
    if (job.kind !== 'rebuild_chat') throw invalidJob('Expected rebuild_chat job')
    const payload = job.payload as BardWikiRebuildChatJobPayload
    if (payload.chatId !== job.chatId) throw invalidJob('Rebuild chat id does not match its job')
    if (hasPersistedCompletion(options.db, job.id)) return
    const sources = requireStableSources(options.db, payload)
    if (payload.sourceCursor > payload.sourceTotal) throw invalidJob('Rebuild source cursor exceeds total')
    if (payload.sourceCursor === payload.sourceTotal) {
      return publishCompletedStaging(options, job, payload, sources)
    }

    const database = loadAnalysisDatabase(options, job.chatId)
    const settings = resolveEffectiveBardWikiSettingsForChat(options.db, job.chatId)
    if (!settings.enabledByDefault) {
      throw new BardWikiJobHandlerError('bardwiki_disabled', 'BardWiki is disabled for this chat', {
        retryable: false,
      })
    }
    const batch = sources.slice(payload.sourceCursor, payload.sourceCursor + batchSize)
    const staged: StagedRebuildChange[] = []
    for (let index = 0; index < batch.length; index += 1) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error('BardWiki rebuild cancelled')
      const sourceOrdinal = payload.sourceCursor + index
      const source = batch[index]
      const draft = await analyzeSource(options, analyze, database, settings, job, source, context)
      assertDatabaseLineage(options.db, lineage)
      options.hooks?.afterProvider?.(sourceOrdinal)
      staged.push({ sourceOrdinal, source: stageSource(source), draft })
    }
    options.hooks?.beforeCheckpoint?.(payload.sourceCursor)
    assertDatabaseLineage(options.db, lineage)
    return checkpointBatch(options, job, payload, staged)
  }
}

async function analyzeSource(
  options: BardWikiRebuildHandlerOptions,
  analyze: BardWikiEventAnalyzer,
  database: BardWikiGenerationDatabase,
  settings: ReturnType<typeof resolveEffectiveBardWikiSettingsForChat>,
  job: BardWikiJob,
  source: BardWikiSourcePair,
  context: BardWikiJobHandlerContext,
): Promise<BardWikiEventDraft> {
  let output: string
  try {
    output = await analyze({
      db: options.db,
      database,
      settings,
      source,
      jobId: job.id,
      receiptId: `rebuild-${job.id}`,
      promptVersion: BARDWIKI_EVENT_PROMPT_VERSION,
      signal: context.signal,
      providerFetchDeadlineMs: options.providerFetchDeadlineMs,
    })
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason ?? error
    throw new BardWikiJobHandlerError('bardwiki_model_unavailable', errorMessage(error))
  }
  try {
    return validateBardWikiEventDraft(output)
  } catch (validationError) {
    let repaired: string
    try {
      repaired = await analyze({
        db: options.db,
        database,
        settings,
        source,
        jobId: job.id,
        receiptId: `rebuild-${job.id}`,
        promptVersion: BARDWIKI_EVENT_PROMPT_VERSION,
        repair: {
          originalOutput: truncateUtf8(output, BARDWIKI_EVENT_MODEL_OUTPUT_MAX_BYTES),
          validationErrors: [errorMessage(validationError)],
        },
        signal: context.signal,
        providerFetchDeadlineMs: options.providerFetchDeadlineMs,
      })
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason ?? error
      throw new BardWikiJobHandlerError('bardwiki_model_unavailable', errorMessage(error))
    }
    try {
      return validateBardWikiEventDraft(repaired)
    } catch (error) {
      throw new BardWikiJobHandlerError('bardwiki_model_output_invalid', errorMessage(error))
    }
  }
}

function checkpointBatch(
  options: BardWikiRebuildHandlerOptions,
  job: BardWikiJob,
  payload: BardWikiRebuildChatJobPayload,
  staged: readonly StagedRebuildChange[],
): BardWikiJobHandlerResult {
  const db = options.db
  db.exec('BEGIN IMMEDIATE')
  let transactionOpen = true
  try {
    const current = getBardWikiJob(db, job.id)
    if (!current || current.status !== 'running') {
      db.exec('COMMIT')
      transactionOpen = false
      return
    }
    const currentPayload = current.payload as BardWikiRebuildChatJobPayload
    if (!sameCheckpoint(currentPayload, payload)) throw invalidJob('Rebuild checkpoint changed concurrently')
    const sources = requireStableSources(db, currentPayload)
    for (const change of staged) {
      if (!sameSourceIdentity(change.source, sources[change.sourceOrdinal])) {
        throw sourceChanged()
      }
      db.prepare(
        `INSERT INTO bardwiki_rebuild_staging (rebuild_job_id, ordinal, change_json)
         VALUES (?, ?, ?)`,
      ).run(job.id, change.sourceOrdinal, JSON.stringify(change))
    }
    const sourceCursor = payload.sourceCursor + staged.length
    const nextPayload = { ...payload, sourceCursor }
    if (sourceCursor < payload.sourceTotal) {
      const rescheduled = rescheduleRunningBardWikiJob(db, job.id, nextPayload)
      if (!rescheduled) throw invalidJob('Could not checkpoint BardWiki rebuild')
      db.exec('COMMIT')
      transactionOpen = false
      return { outcome: 'rescheduled', job: rescheduled }
    }
    updateRunningPayload(db, job.id, nextPayload)
    const event = publishStagingInOpenTransaction(options, job, nextPayload, sources)
    db.exec('COMMIT')
    transactionOpen = false
    emitEvent(options, event)
    options.hooks?.afterPublish?.()
    return
  } catch (error) {
    if (transactionOpen) db.exec('ROLLBACK')
    throw error
  }
}

function publishCompletedStaging(
  options: BardWikiRebuildHandlerOptions,
  job: BardWikiJob,
  payload: BardWikiRebuildChatJobPayload,
  sources: readonly BardWikiSourcePair[],
): BardWikiJobHandlerResult {
  const db = options.db
  db.exec('BEGIN IMMEDIATE')
  let transactionOpen = true
  try {
    const current = getBardWikiJob(db, job.id)
    if (!current || current.status !== 'running' || hasPersistedCompletion(db, job.id)) {
      db.exec('COMMIT')
      transactionOpen = false
      return
    }
    const event = publishStagingInOpenTransaction(options, current, payload, sources)
    db.exec('COMMIT')
    transactionOpen = false
    emitEvent(options, event)
    options.hooks?.afterPublish?.()
    return
  } catch (error) {
    if (transactionOpen) db.exec('ROLLBACK')
    throw error
  }
}

function publishStagingInOpenTransaction(
  options: BardWikiRebuildHandlerOptions,
  job: BardWikiJob,
  payload: BardWikiRebuildChatJobPayload,
  sources: readonly BardWikiSourcePair[],
): CommandEvent {
  const db = options.db
  const staged = readStaging(db, job.id)
  if (staged.length !== payload.sourceTotal) throw invalidJob('BardWiki rebuild staging is incomplete')
  for (let ordinal = 0; ordinal < staged.length; ordinal += 1) {
    if (staged[ordinal].sourceOrdinal !== ordinal || !sameSourceIdentity(staged[ordinal].source, sources[ordinal])) {
      throw sourceChanged()
    }
    resolveBardWikiReceiptSourcePair(db, { chatId: job.chatId, ...staged[ordinal].source })
  }

  const nextRevision = getSchemaState(db).revision + 1
  const reusable = new Map<number, { receiptId: string; document: BardWikiDocument }>()
  for (const change of staged) {
    const receipt = findExactReceipt(db, job.chatId, change.source)
    const document = receipt?.eventDocumentId ? getBardWikiDocument(db, job.chatId, receipt.eventDocumentId) : null
    const latest = document ? listBardWikiDocumentVersions(db, document.id, 1)[0] : undefined
    if (receipt && document && document.reviewState !== 'needs_review' && latest && latest.actor !== 'user') {
      reusable.set(change.sourceOrdinal, { receiptId: receipt.id, document })
    }
  }
  if (payload.policy === 'full') {
    const reuseIds = new Set([...reusable.values()].map(({ document }) => document.id))
    for (const document of listBardWikiDocuments(db, job.chatId)) {
      const latest = listBardWikiDocumentVersions(db, document.id, 1)[0]
      if (document.reviewState !== 'needs_review' && latest && latest.actor !== 'user' && !reuseIds.has(document.id)) {
        deleteBardWikiDocument(db, job.chatId, document.id, {
          expectedVersion: document.version,
          expectedContentHash: document.contentHash,
          actor: 'system',
          reason: 'rebuild',
          jobId: job.id,
          commandRevision: nextRevision,
        })
      }
    }
  }

  for (const change of staged) {
    const currentSource = sources[change.sourceOrdinal]
    const reusableTarget = reusable.get(change.sourceOrdinal)
    const baseDocumentId = eventDocumentId(change.source)
    // A user-edited or deleted prior document keeps its identity and history.
    // Publish a separate derived document when that identity is already owned.
    const documentId =
      reusableTarget?.document.id ??
      (db.prepare('SELECT 1 FROM bardwiki_documents WHERE id = ?').get(baseDocumentId)
        ? `event-rebuild-${randomUUID()}`
        : baseDocumentId)
    const logicalPath = resolveEventLogicalPath(
      db,
      job.chatId,
      change.draft.logicalPath,
      documentId,
      reusableTarget?.document.id,
    )
    const receiptId = upsertRebuildReceipt(db, job, change.source)
    const document = reusableTarget
      ? updateBardWikiDocument(db, job.chatId, reusableTarget.document.id, {
          expectedVersion: reusableTarget.document.version,
          expectedContentHash: reusableTarget.document.contentHash,
          kind: 'event',
          title: change.draft.title,
          logicalPath,
          aliases: change.draft.aliases,
          contextPolicy: 'relevant',
          reviewState: 'active',
          markdown: change.draft.markdown,
          actor: 'model',
          reason: 'rebuild',
          receiptId,
          jobId: job.id,
          commandRevision: nextRevision,
        })
      : createBardWikiDocument(db, {
          id: documentId,
          chatId: job.chatId,
          kind: 'event',
          title: change.draft.title,
          logicalPath,
          aliases: change.draft.aliases,
          contextPolicy: 'relevant',
          reviewState: 'active',
          markdown: change.draft.markdown,
          actor: 'model',
          reason: 'rebuild',
          receiptId,
          jobId: job.id,
          commandRevision: nextRevision,
        })
    insertSources(db, document, receiptId, currentSource)
    db.prepare('DELETE FROM bardwiki_change_manifest WHERE receipt_id = ?').run(receiptId)
    db.prepare(
      `INSERT INTO bardwiki_change_manifest (
        receipt_id, document_id, before_version, before_hash, after_version, after_hash
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      receiptId,
      document.id,
      reusableTarget?.document.version ?? null,
      reusableTarget?.document.contentHash ?? null,
      document.version,
      document.contentHash,
    )
    db.prepare(
      `UPDATE bardwiki_turn_receipts
       SET event_document_id = ?, state = 'applied', confirmation_mode = 'rebuild', job_id = ?,
           error_code = NULL, error_summary = NULL,
           applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    ).run(document.id, job.id, receiptId)
  }

  options.hooks?.beforePublish?.()
  const revision = bumpRevision(db)
  if (revision !== nextRevision) throw new Error('BardWiki rebuild revision changed during publish')
  const event: CommandEvent = {
    ...COMMAND_EVENT_CATALOG.bardWikiRebuildCompleted,
    revision,
    id: job.chatId,
    jobId: job.id,
  }
  persistCommandEvent(db, event)
  return event
}

function upsertRebuildReceipt(db: DatabaseSync, job: BardWikiJob, source: StagedRebuildChange['source']): string {
  const existing = findExactReceipt(db, job.chatId, source)
  if (existing) return existing.id
  const receiptId = rebuildReceiptId(source)
  db.prepare(
    `INSERT INTO bardwiki_turn_receipts (
      id, chat_id, user_message_id, user_content_hash, assistant_message_id,
      assistant_content_hash, confirmation_mode, state, change_set_id, event_document_id, job_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'rebuild', 'processing', ?, NULL, ?)`,
  ).run(
    receiptId,
    job.chatId,
    source.userMessageId,
    source.userContentHash,
    source.assistantMessageId,
    source.assistantContentHash,
    randomUUID(),
    job.id,
  )
  return receiptId
}

function findExactReceipt(
  db: DatabaseSync,
  chatId: string,
  source: StagedRebuildChange['source'],
): ReturnType<typeof getBardWikiReceiptSummary> {
  const row = db
    .prepare(
      `SELECT id FROM bardwiki_turn_receipts
       WHERE chat_id = ? AND user_message_id = ? AND user_content_hash = ?
         AND assistant_message_id = ? AND assistant_content_hash = ?`,
    )
    .get(
      chatId,
      source.userMessageId,
      source.userContentHash,
      source.assistantMessageId,
      source.assistantContentHash,
    ) as { id: string } | undefined
  return row ? getBardWikiReceiptSummary(db, row.id) : null
}

function insertSources(
  db: DatabaseSync,
  document: BardWikiDocument,
  receiptId: string,
  source: BardWikiSourcePair,
): void {
  const insert = db.prepare(
    `INSERT INTO bardwiki_document_sources (
      document_id, document_version, receipt_id, message_id, role, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  )
  insert.run(document.id, document.version, receiptId, source.userMessageId, 'user', source.userContentHash)
  insert.run(
    document.id,
    document.version,
    receiptId,
    source.assistantMessageId,
    'assistant',
    source.assistantContentHash,
  )
}

function requireStableSources(db: DatabaseSync, payload: BardWikiRebuildChatJobPayload): BardWikiSourcePair[] {
  const sources = listBardWikiRebuildSourcePairs(db, payload.chatId, payload.policy)
  if (sources.length !== payload.sourceTotal) throw sourceChanged()
  return sources
}

function readStaging(db: DatabaseSync, jobId: string): StagedRebuildChange[] {
  const rows = db
    .prepare(
      `SELECT ordinal, change_json FROM bardwiki_rebuild_staging
       WHERE rebuild_job_id = ? ORDER BY ordinal`,
    )
    .all(jobId) as Array<{ ordinal: number; change_json: string }>
  return rows.map((row) => {
    const parsed = JSON.parse(row.change_json) as StagedRebuildChange
    if (parsed.sourceOrdinal !== row.ordinal) throw invalidJob('BardWiki rebuild staging ordinal mismatch')
    validateStagedChange(parsed)
    return parsed
  })
}

function validateStagedChange(value: StagedRebuildChange): void {
  if (
    !value ||
    !Number.isSafeInteger(value.sourceOrdinal) ||
    value.sourceOrdinal < 0 ||
    !value.source ||
    !value.draft ||
    typeof value.source.userMessageId !== 'string' ||
    typeof value.source.assistantMessageId !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.source.userContentHash) ||
    !/^[a-f0-9]{64}$/u.test(value.source.assistantContentHash)
  ) {
    throw invalidJob('BardWiki rebuild staging is malformed')
  }
  validateBardWikiEventDraft(JSON.stringify(value.draft))
}

function stageSource(source: BardWikiSourcePair): StagedRebuildChange['source'] {
  return {
    userMessageId: source.userMessageId,
    userContentHash: source.userContentHash,
    assistantMessageId: source.assistantMessageId,
    assistantContentHash: source.assistantContentHash,
  }
}

function sameSourceIdentity(
  expected: StagedRebuildChange['source'] | undefined,
  actual: BardWikiSourcePair | undefined,
): boolean {
  return (
    !!expected &&
    !!actual &&
    expected.userMessageId === actual.userMessageId &&
    expected.userContentHash === actual.userContentHash &&
    expected.assistantMessageId === actual.assistantMessageId &&
    expected.assistantContentHash === actual.assistantContentHash
  )
}

function sameCheckpoint(left: BardWikiRebuildChatJobPayload, right: BardWikiRebuildChatJobPayload): boolean {
  return (
    left.chatId === right.chatId &&
    left.generation === right.generation &&
    left.sourceCursor === right.sourceCursor &&
    left.sourceTotal === right.sourceTotal &&
    left.policy === right.policy &&
    left.stagingManifestId === right.stagingManifestId
  )
}

function updateRunningPayload(db: DatabaseSync, jobId: string, payload: BardWikiRebuildChatJobPayload): void {
  const result = db
    .prepare(
      `UPDATE bardwiki_jobs SET payload_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'running'`,
    )
    .run(JSON.stringify(payload), jobId)
  if (result.changes !== 1) throw invalidJob('Could not advance BardWiki rebuild publish cursor')
}

function countCurrentDocumentActors(db: DatabaseSync, chatId: string): Record<'user' | 'model' | 'system', number> {
  const counts = { user: 0, model: 0, system: 0 }
  const rows = db
    .prepare(
      `SELECT versions.actor, COUNT(*) AS count
       FROM bardwiki_documents AS documents
       JOIN bardwiki_document_versions AS versions
         ON versions.document_id = documents.id AND versions.version = documents.version
       WHERE documents.chat_id = ? AND documents.deleted_at IS NULL
       GROUP BY versions.actor`,
    )
    .all(chatId) as Array<{ actor: keyof typeof counts; count: number }>
  for (const row of rows) counts[row.actor] = row.count
  return counts
}

function cancelSupersededIncrementalJobs(db: DatabaseSync, chatId: string): void {
  db.prepare(
    `UPDATE bardwiki_jobs
     SET status = 'cancelled', error_code = 'bardwiki_rebuild_superseded',
         error_summary = 'Superseded by a full BardWiki rebuild',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE chat_id = ? AND kind IN ('apply_turn', 'reconcile_receipt') AND status IN ('pending', 'running')`,
  ).run(chatId)
  db.prepare(
    `UPDATE bardwiki_turn_receipts
     SET state = 'obsolete', error_code = 'bardwiki_rebuild_superseded',
         error_summary = 'Superseded by a full BardWiki rebuild',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE chat_id = ? AND state IN ('queued', 'processing')`,
  ).run(chatId)
}

function hasPersistedCompletion(db: DatabaseSync, jobId: string): boolean {
  return (
    db.prepare("SELECT 1 FROM command_events WHERE type = 'bardwiki.rebuild.completed' AND job_id = ?").get(jobId) !==
    undefined
  )
}

function eventDocumentId(source: StagedRebuildChange['source']): string {
  return `event-rebuild-${identityHash(source).slice(0, 32)}`
}

function rebuildReceiptId(source: StagedRebuildChange['source']): string {
  return `rebuild-receipt-${identityHash(source).slice(0, 32)}`
}

function identityHash(source: StagedRebuildChange['source']): string {
  return createHash('sha256')
    .update(
      `${source.userMessageId}\0${source.userContentHash}\0${source.assistantMessageId}\0${source.assistantContentHash}`,
    )
    .digest('hex')
}

function resolveEventLogicalPath(
  db: DatabaseSync,
  chatId: string,
  requestedPath: string,
  documentId: string,
  ignoreDocumentId?: string,
): string {
  const normalized = normalizeBardWikiPath(requestedPath)
  const collision = db
    .prepare(
      `SELECT id FROM bardwiki_documents
       WHERE chat_id = ? AND normalized_path = ? AND deleted_at IS NULL AND (? IS NULL OR id <> ?)`,
    )
    .get(chatId, normalized.normalizedPath, ignoreDocumentId ?? null, ignoreDocumentId ?? null)
  if (!collision) return normalized.logicalPath
  const suffix = `~${documentId.slice(-8)}`
  const slash = normalized.logicalPath.lastIndexOf('/')
  const directory = slash < 0 ? '' : normalized.logicalPath.slice(0, slash + 1)
  const basename = slash < 0 ? normalized.logicalPath : normalized.logicalPath.slice(slash + 1)
  const extension = basename.toLowerCase().endsWith('.md') ? basename.slice(-3) : ''
  const stem = extension ? basename.slice(0, -3) : basename
  const candidate = `${directory}${[...stem].slice(0, Math.max(1, 100 - suffix.length - extension.length)).join('')}${suffix}${extension}`
  try {
    return normalizeBardWikiPath(candidate).logicalPath
  } catch {
    return normalizeBardWikiPath(`Events/${documentId}${extension}`).logicalPath
  }
}

function loadAnalysisDatabase(options: BardWikiRebuildHandlerOptions, chatId: string): BardWikiGenerationDatabase {
  const loaded = options.loadDatabase
    ? options.loadDatabase(chatId)
    : loadPersistedDatabaseForMemoryJob(options.db, options.dataDir, chatId)
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new BardWikiJobHandlerError('bardwiki_model_unavailable', 'BardWiki model settings are unavailable')
  }
  return decodeProviderGenerationSettings(loaded)
}

function sourceChanged(): BardWikiJobHandlerError {
  return new BardWikiJobHandlerError(
    'bardwiki_source_changed',
    'The active transcript changed during BardWiki rebuild',
    { retryable: false },
  )
}

function invalidJob(message: string): BardWikiJobHandlerError {
  return new BardWikiJobHandlerError('bardwiki_invalid_job', message, { retryable: false })
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let output = ''
  let bytes = 0
  for (const point of value) {
    const width = Buffer.byteLength(point, 'utf8')
    if (bytes + width > maxBytes) break
    output += point
    bytes += width
  }
  return output
}

function emitEvent(options: BardWikiRebuildHandlerOptions, event: CommandEvent): void {
  try {
    options.eventSink?.emit(event)
  } catch {
    // Persisted command events and targeted reads remain authoritative.
  }
}
