import { assertDatabaseLineage, getDatabaseLineage } from './databaseLineage.js'
import { decodeProviderGenerationSettings } from './prompt/generationInputDecoder.js'
import type { DatabaseSync } from 'node:sqlite'
import {
  COMMAND_EVENT_CATALOG,
  persistCommandEvent,
  type CommandEvent,
  type CommandEventSink,
} from './commands/events.js'
import { bumpRevision, getSchemaState } from './db.js'
import {
  BardWikiConflictError,
  createBardWikiDocument,
  getBardWikiDocument,
  getBardWikiReceiptSummary,
  normalizeBardWikiPath,
  updateBardWikiDocument,
  type BardWikiReceiptSummary,
} from './bardWikiRepository.js'
import {
  BARDWIKI_EVENT_PROMPT_VERSION,
  resolveBardWikiReceiptSourcePair,
  resolveEffectiveBardWikiSettingsForChat,
  type BardWikiSourcePair,
} from './bardWikiReceipts.js'
import { getBardWikiJob, type BardWikiApplyTurnJobPayload, type BardWikiJob } from './bardWikiJobs.js'
import {
  analyzeBardWikiEvent,
  BARDWIKI_EVENT_MODEL_OUTPUT_MAX_BYTES,
  validateBardWikiEventDraft,
  type BardWikiEventAnalyzer,
  type BardWikiEventDraft,
} from './bardWikiEventModel.js'
import {
  BARDWIKI_CANONICAL_MODEL_OUTPUT_MAX_BYTES,
  compileBardWikiCanonical,
  snapshotBardWikiCanonicalDocuments,
  stageBardWikiCanonicalChanges,
  validateBardWikiCanonicalOperations,
  type BardWikiCanonicalCompiler,
  type BardWikiCanonicalDocumentSnapshot,
  type BardWikiStagedCanonicalChange,
} from './bardWikiCanonicalModel.js'
import { BardWikiJobHandlerError, type BardWikiJobHandlerContext } from './bardWikiWorker.js'
import { loadPersistedDatabaseForMemoryJob } from './repository.js'
import type { BardWikiGenerationDatabase } from './bardWikiTypes.js'

export interface BardWikiApplyTurnHandlerOptions {
  db: DatabaseSync
  dataDir: string
  eventSink?: CommandEventSink
  analyze?: BardWikiEventAnalyzer
  compileCanonical?: BardWikiCanonicalCompiler
  loadDatabase?: (chatId: string) => unknown
  providerFetchDeadlineMs?: number
  hooks?: {
    afterProvider?: () => void
    beforeCommit?: () => void
    afterCommit?: () => void
  }
}

export function createBardWikiApplyTurnHandler(options: BardWikiApplyTurnHandlerOptions) {
  const analyze = options.analyze ?? analyzeBardWikiEvent
  const compileCanonical = options.compileCanonical ?? compileBardWikiCanonical
  return async (job: BardWikiJob, context: BardWikiJobHandlerContext): Promise<void> => {
    const lineage = getDatabaseLineage(options.db)
    if (job.kind !== 'apply_turn') throw new BardWikiJobHandlerError('bardwiki_invalid_job', 'Expected apply_turn job')
    const payload = job.payload as BardWikiApplyTurnJobPayload
    if (payload.promptVersion !== BARDWIKI_EVENT_PROMPT_VERSION) {
      throw new BardWikiJobHandlerError(
        'bardwiki_model_output_invalid',
        `Unsupported BardWiki event prompt version: ${payload.promptVersion}`,
        { retryable: false },
      )
    }
    const receipt = getBardWikiReceiptSummary(options.db, payload.receiptId)
    if (!receipt || receipt.chatId !== job.chatId || receipt.id !== job.receiptId) {
      throw new BardWikiJobHandlerError('bardwiki_source_changed', 'BardWiki receipt is missing', { retryable: false })
    }
    if (receipt.state === 'applied' && receipt.eventDocumentId) return
    if (receipt.state === 'obsolete') return

    const source = readCurrentSourceOrObsolete(options.db, receipt, payload)
    if (!source) return
    const settings = resolveEffectiveBardWikiSettingsForChat(options.db, job.chatId)
    if (!settings.enabledByDefault) {
      throw new BardWikiJobHandlerError('bardwiki_disabled', 'BardWiki is disabled for this chat', {
        retryable: false,
      })
    }
    const database = loadAnalysisDatabase(options, job.chatId)
    let originalOutput: string
    try {
      originalOutput = await analyze({
        db: options.db,
        database,
        settings,
        source,
        jobId: job.id,
        receiptId: receipt.id,
        promptVersion: payload.promptVersion,
        signal: context.signal,
        providerFetchDeadlineMs: options.providerFetchDeadlineMs,
      })
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason ?? error
      throw new BardWikiJobHandlerError(
        'bardwiki_model_unavailable',
        error instanceof Error ? error.message : String(error),
      )
    }

    assertDatabaseLineage(options.db, lineage)
    let draft: BardWikiEventDraft
    try {
      draft = validateBardWikiEventDraft(originalOutput)
    } catch (validationError) {
      const validationErrors = [validationError instanceof Error ? validationError.message : String(validationError)]
      let repairedOutput: string
      try {
        repairedOutput = await analyze({
          db: options.db,
          database,
          settings,
          source,
          jobId: job.id,
          receiptId: receipt.id,
          promptVersion: payload.promptVersion,
          repair: {
            originalOutput: truncateUtf8(originalOutput, BARDWIKI_EVENT_MODEL_OUTPUT_MAX_BYTES),
            validationErrors,
          },
          signal: context.signal,
          providerFetchDeadlineMs: options.providerFetchDeadlineMs,
        })
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason ?? error
        throw new BardWikiJobHandlerError(
          'bardwiki_model_unavailable',
          error instanceof Error ? error.message : String(error),
        )
      }
      try {
        draft = validateBardWikiEventDraft(repairedOutput)
      } catch (repairError) {
        throw new BardWikiJobHandlerError(
          'bardwiki_model_output_invalid',
          repairError instanceof Error ? repairError.message : String(repairError),
        )
      }
    }

    assertDatabaseLineage(options.db, lineage)
    let canonicalChanges =
      payload.canonicalEnabled && settings.canonicalUpdates
        ? await compileCanonicalChanges({
            options,
            compileCanonical,
            database,
            settings,
            job,
            receipt,
            payload,
            draft,
            context,
          })
        : []
    assertDatabaseLineage(options.db, lineage)
    options.hooks?.afterProvider?.()
    let committedEvent: CommandEvent | null
    try {
      committedEvent = commitChangeSet(options, job, receipt, payload, draft, canonicalChanges)
    } catch (error) {
      if (!(error instanceof BardWikiConflictError) || canonicalChanges.length === 0) throw error
      canonicalChanges = await compileCanonicalChanges({
        options,
        compileCanonical,
        database,
        settings,
        job,
        receipt,
        payload,
        draft,
        context,
        allowRepair: false,
      })
      assertDatabaseLineage(options.db, lineage)
      options.hooks?.afterProvider?.()
      committedEvent = commitChangeSet(options, job, receipt, payload, draft, canonicalChanges)
    }
    if (!committedEvent) return
    options.hooks?.afterCommit?.()
    try {
      options.eventSink?.emit(committedEvent)
    } catch {
      // The persisted command event and targeted read remain authoritative.
    }
  }
}

async function compileCanonicalChanges(args: {
  options: BardWikiApplyTurnHandlerOptions
  compileCanonical: BardWikiCanonicalCompiler
  database: BardWikiGenerationDatabase
  settings: ReturnType<typeof resolveEffectiveBardWikiSettingsForChat>
  job: BardWikiJob
  receipt: BardWikiReceiptSummary
  payload: BardWikiApplyTurnJobPayload
  draft: BardWikiEventDraft
  context: BardWikiJobHandlerContext
  allowRepair?: boolean
}): Promise<BardWikiStagedCanonicalChange[]> {
  const snapshot = snapshotBardWikiCanonicalDocuments(args.options.db, args.job.chatId)
  let originalOutput: string
  try {
    originalOutput = await args.compileCanonical({
      db: args.options.db,
      chatId: args.job.chatId,
      database: args.database,
      settings: args.settings,
      eventDraft: args.draft,
      documents: snapshot,
      jobId: args.job.id,
      receiptId: args.receipt.id,
      promptVersion: args.payload.promptVersion,
      signal: args.context.signal,
      providerFetchDeadlineMs: args.options.providerFetchDeadlineMs,
    })
  } catch (error) {
    if (args.context.signal.aborted) throw args.context.signal.reason ?? error
    throw new BardWikiJobHandlerError(
      'bardwiki_model_unavailable',
      error instanceof Error ? error.message : String(error),
    )
  }
  try {
    return validateAndStageCanonical(originalOutput, snapshot)
  } catch (validationError) {
    if (args.allowRepair === false) {
      throw new BardWikiJobHandlerError(
        'bardwiki_model_output_invalid',
        validationError instanceof Error ? validationError.message : String(validationError),
      )
    }
    const validationErrors = [validationError instanceof Error ? validationError.message : String(validationError)]
    let repairedOutput: string
    try {
      repairedOutput = await args.compileCanonical({
        db: args.options.db,
        chatId: args.job.chatId,
        database: args.database,
        settings: args.settings,
        eventDraft: args.draft,
        documents: snapshot,
        jobId: args.job.id,
        receiptId: args.receipt.id,
        promptVersion: args.payload.promptVersion,
        repair: {
          originalOutput: truncateUtf8(originalOutput, BARDWIKI_CANONICAL_MODEL_OUTPUT_MAX_BYTES),
          validationErrors,
        },
        signal: args.context.signal,
        providerFetchDeadlineMs: args.options.providerFetchDeadlineMs,
      })
    } catch (error) {
      if (args.context.signal.aborted) throw args.context.signal.reason ?? error
      throw new BardWikiJobHandlerError(
        'bardwiki_model_unavailable',
        error instanceof Error ? error.message : String(error),
      )
    }
    try {
      return validateAndStageCanonical(repairedOutput, snapshot)
    } catch (repairError) {
      throw new BardWikiJobHandlerError(
        'bardwiki_model_output_invalid',
        repairError instanceof Error ? repairError.message : String(repairError),
      )
    }
  }
}

function validateAndStageCanonical(
  output: string,
  snapshot: readonly BardWikiCanonicalDocumentSnapshot[],
): BardWikiStagedCanonicalChange[] {
  return stageBardWikiCanonicalChanges(validateBardWikiCanonicalOperations(output, snapshot), snapshot)
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let result = ''
  let bytes = 0
  for (const codePoint of value) {
    const width = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + width > maxBytes) break
    result += codePoint
    bytes += width
  }
  return result
}

function readCurrentSourceOrObsolete(
  db: DatabaseSync,
  receipt: BardWikiReceiptSummary,
  payload: BardWikiApplyTurnJobPayload,
): BardWikiSourcePair | null {
  if (
    payload.expectedUserContentHash !== receipt.userContentHash ||
    payload.expectedAssistantContentHash !== receipt.assistantContentHash
  ) {
    markReceiptObsolete(db, receipt.id)
    return null
  }
  try {
    return resolveBardWikiReceiptSourcePair(db, {
      chatId: receipt.chatId,
      userMessageId: receipt.userMessageId,
      userContentHash: receipt.userContentHash,
      assistantMessageId: receipt.assistantMessageId,
      assistantContentHash: receipt.assistantContentHash,
    })
  } catch {
    markReceiptObsolete(db, receipt.id)
    return null
  }
}

function markReceiptObsolete(db: DatabaseSync, receiptId: string): void {
  db.prepare(
    `UPDATE bardwiki_turn_receipts
     SET state = 'obsolete', error_code = 'bardwiki_source_changed',
         error_summary = 'Confirmed source messages changed or are no longer active',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND state IN ('queued', 'processing', 'failed')`,
  ).run(receiptId)
}

function loadAnalysisDatabase(options: BardWikiApplyTurnHandlerOptions, chatId: string): BardWikiGenerationDatabase {
  const loaded = options.loadDatabase
    ? options.loadDatabase(chatId)
    : loadPersistedDatabaseForMemoryJob(options.db, options.dataDir, chatId)
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new BardWikiJobHandlerError('bardwiki_model_unavailable', 'BardWiki model settings are unavailable')
  }
  return decodeProviderGenerationSettings(loaded)
}

function commitChangeSet(
  options: BardWikiApplyTurnHandlerOptions,
  job: BardWikiJob,
  receipt: BardWikiReceiptSummary,
  payload: BardWikiApplyTurnJobPayload,
  draft: BardWikiEventDraft,
  canonicalChanges: readonly BardWikiStagedCanonicalChange[],
): CommandEvent | null {
  const db = options.db
  let transactionOpen = false
  let event: CommandEvent | null = null
  db.exec('BEGIN IMMEDIATE')
  transactionOpen = true
  try {
    const currentJob = getBardWikiJob(db, job.id)
    const currentReceipt = getBardWikiReceiptSummary(db, receipt.id)
    if (!currentJob || currentJob.status !== 'running' || !currentReceipt) {
      db.exec('COMMIT')
      transactionOpen = false
      return null
    }
    if (currentReceipt.state === 'applied' && currentReceipt.eventDocumentId) {
      db.exec('COMMIT')
      transactionOpen = false
      return null
    }
    if (currentReceipt.state !== 'processing') {
      db.exec('COMMIT')
      transactionOpen = false
      return null
    }
    const source = readCurrentSourceOrObsolete(db, currentReceipt, payload)
    if (!source) {
      db.exec('COMMIT')
      transactionOpen = false
      return null
    }

    const documentId = `event-${currentReceipt.id}`
    if (getBardWikiDocument(db, job.chatId, documentId, { includeDeleted: true })) {
      throw new Error('BardWiki event document identity already exists without an applied receipt')
    }
    const logicalPath = resolveEventLogicalPath(db, job.chatId, draft.logicalPath, documentId)
    const nextRevision = getSchemaState(db).revision + 1
    const document = createBardWikiDocument(db, {
      id: documentId,
      chatId: job.chatId,
      kind: 'event',
      title: draft.title,
      logicalPath,
      aliases: draft.aliases,
      contextPolicy: 'relevant',
      reviewState: 'active',
      markdown: draft.markdown,
      actor: 'model',
      reason: 'analysis',
      receiptId: currentReceipt.id,
      jobId: job.id,
      commandRevision: nextRevision,
    })
    insertDocumentSources(db, document.id, document.version, currentReceipt.id, source)
    insertChangeManifest(db, currentReceipt.id, document.id, null, null, document.version, document.contentHash)
    for (const change of canonicalChanges) {
      if (change.type === 'create') {
        const created = createBardWikiDocument(db, {
          id: change.id,
          chatId: job.chatId,
          kind: change.kind,
          title: change.title,
          logicalPath: change.logicalPath,
          aliases: change.aliases,
          contextPolicy: 'relevant',
          reviewState: 'active',
          markdown: change.markdown,
          actor: 'model',
          reason: 'canonical',
          receiptId: currentReceipt.id,
          jobId: job.id,
          commandRevision: nextRevision,
        })
        insertDocumentSources(db, created.id, created.version, currentReceipt.id, source)
        insertChangeManifest(db, currentReceipt.id, created.id, null, null, created.version, created.contentHash)
        continue
      }
      const updated = updateBardWikiDocument(db, job.chatId, change.documentId, {
        expectedVersion: change.beforeVersion,
        expectedContentHash: change.beforeHash,
        markdown: change.markdown,
        actor: 'model',
        reason: 'canonical',
        receiptId: currentReceipt.id,
        jobId: job.id,
        commandRevision: nextRevision,
      })
      insertDocumentSources(db, updated.id, updated.version, currentReceipt.id, source)
      insertChangeManifest(
        db,
        currentReceipt.id,
        updated.id,
        change.beforeVersion,
        change.beforeHash,
        updated.version,
        updated.contentHash,
      )
    }
    db.prepare(
      `UPDATE bardwiki_turn_receipts
       SET state = 'applied', event_document_id = ?, error_code = NULL, error_summary = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND state = 'processing'`,
    ).run(document.id, currentReceipt.id)
    const revision = bumpRevision(db)
    if (revision !== nextRevision) throw new Error('BardWiki event revision changed during commit')
    event =
      canonicalChanges.length > 0
        ? {
            ...COMMAND_EVENT_CATALOG.bardWikiChangeSetApplied,
            revision,
            id: job.chatId,
            jobId: job.id,
            sourceMessageId: source.assistantMessageId,
          }
        : {
            ...COMMAND_EVENT_CATALOG.bardWikiDocumentCreated,
            revision,
            id: document.id,
            parentId: job.chatId,
            jobId: job.id,
            sourceMessageId: source.assistantMessageId,
          }
    persistCommandEvent(db, event)
    options.hooks?.beforeCommit?.()
    db.exec('COMMIT')
    transactionOpen = false
    return event
  } catch (error) {
    if (transactionOpen) db.exec('ROLLBACK')
    throw error
  }
}

function insertDocumentSources(
  db: DatabaseSync,
  documentId: string,
  documentVersion: number,
  receiptId: string,
  source: BardWikiSourcePair,
): void {
  const insert = db.prepare(
    `INSERT INTO bardwiki_document_sources (
      document_id, document_version, receipt_id, message_id, role, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  )
  insert.run(documentId, documentVersion, receiptId, source.userMessageId, 'user', source.userContentHash)
  insert.run(
    documentId,
    documentVersion,
    receiptId,
    source.assistantMessageId,
    'assistant',
    source.assistantContentHash,
  )
}

function insertChangeManifest(
  db: DatabaseSync,
  receiptId: string,
  documentId: string,
  beforeVersion: number | null,
  beforeHash: string | null,
  afterVersion: number,
  afterHash: string,
): void {
  db.prepare(
    `INSERT INTO bardwiki_change_manifest (
      receipt_id, document_id, before_version, before_hash, after_version, after_hash
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(receiptId, documentId, beforeVersion, beforeHash, afterVersion, afterHash)
}

function resolveEventLogicalPath(db: DatabaseSync, chatId: string, requestedPath: string, documentId: string): string {
  const normalized = normalizeBardWikiPath(requestedPath)
  const collision = db
    .prepare('SELECT 1 FROM bardwiki_documents WHERE chat_id = ? AND normalized_path = ? AND deleted_at IS NULL')
    .get(chatId, normalized.normalizedPath)
  if (!collision) return normalized.logicalPath
  const suffix = `~${documentId.slice(0, 8)}`
  const slash = normalized.logicalPath.lastIndexOf('/')
  const directory = slash < 0 ? '' : normalized.logicalPath.slice(0, slash + 1)
  const basename = slash < 0 ? normalized.logicalPath : normalized.logicalPath.slice(slash + 1)
  const hasMarkdownExtension = basename.toLocaleLowerCase('en-US').endsWith('.md')
  const extension = hasMarkdownExtension ? basename.slice(-3) : ''
  const stem = hasMarkdownExtension ? basename.slice(0, -3) : basename
  const maxStemCodePoints = Math.max(1, 100 - [...suffix].length - [...extension].length)
  const candidate = `${directory}${[...stem].slice(0, maxStemCodePoints).join('')}${suffix}${extension}`
  try {
    return normalizeBardWikiPath(candidate).logicalPath
  } catch {
    return normalizeBardWikiPath(`Events/${documentId}${extension}`).logicalPath
  }
}
