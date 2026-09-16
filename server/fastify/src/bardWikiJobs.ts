import { resolveGenerationConfiguration } from './generationConfiguration.js'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { isBardWikiGlobalSettings, type BardWikiGlobalSettings } from '@risuai/protocol'
import { BARDWIKI_JOB_KINDS, BARDWIKI_JOB_STATUSES, type BardWikiJobSummary } from './bardWikiRepository.js'
import {
  GenerationAdmissionError,
  assertPersistedGenerationScopeInTransaction,
  scopeFromColumns,
  scopeSqlValues,
  type GenerationScopeColumns,
  type PersistedGenerationScope,
} from './generationScope.js'
import { getDatabaseLineage } from './databaseLineage.js'
import { type GenerationOperationStoredRequest } from './generationOperations.js'

export const BARDWIKI_JOB_DEFAULT_MAX_ATTEMPTS = 3
export const BARDWIKI_JOB_DEFAULT_BACKOFF_BASE_MS = 1_000
export const BARDWIKI_JOB_DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const BARDWIKI_JOB_MAX_PAYLOAD_BYTES = 16 * 1024

const BARDWIKI_JOB_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const
const MAX_ERROR_CODE_CODE_POINTS = 100
const MAX_ERROR_SUMMARY_CODE_POINTS = 1_000

export type BardWikiJobKind = (typeof BARDWIKI_JOB_KINDS)[number]
export type BardWikiJobStatus = (typeof BARDWIKI_JOB_STATUSES)[number]

export interface BardWikiApplyTurnJobPayload {
  receiptId: string
  expectedUserContentHash: string
  expectedAssistantContentHash: string
  modelProfileId: string | null
  promptPresetId: string | null
  promptVersion: string
  canonicalEnabled: boolean
  repairAttemptCount: number
  /** Exact effective BardWiki settings captured when this work was accepted. */
  acceptedSettings?: BardWikiGlobalSettings
}

export interface BardWikiReconcileReceiptJobPayload {
  receiptId: string
  changeSetId: string
}

export interface BardWikiRebuildChatJobPayload {
  chatId: string
  generation: number
  sourceCursor: number
  sourceTotal: number
  policy: 'missing' | 'full'
  stagingManifestId: string
}

export type BardWikiJobPayload =
  | BardWikiApplyTurnJobPayload
  | BardWikiReconcileReceiptJobPayload
  | BardWikiRebuildChatJobPayload

export interface BardWikiJob extends BardWikiJobSummary {
  payload: BardWikiJobPayload
}

export interface EnqueueBardWikiJobInput {
  id?: string
  instanceId?: string
  chatId: string
  receiptId?: string | null
  kind: BardWikiJobKind
  payload: unknown
  maxAttempts?: number
  nextRunAt?: string | Date
  operationId?: string
  operationAttemptNo?: number
  generationScope?: PersistedGenerationScope
}

export interface BardWikiJobRetryOptions {
  now?: string | Date
  backoffBaseMs?: number
}

export interface PruneTerminalBardWikiJobsOptions {
  now?: string | Date
  retentionMs?: number
}

interface BardWikiJobRow extends GenerationScopeColumns {
  id: string
  instance_id: string
  chat_id: string
  receipt_id: string | null
  kind: BardWikiJobKind
  status: BardWikiJobStatus
  payload_json: string
  error_code: string | null
  error_summary: string | null
  attempt_count: number
  max_attempts: number
  next_run_at: string
  created_at: string
  updated_at: string
  operation_id: string | null
  operation_attempt_no: number | null
}

export class BardWikiJobValidationError extends Error {
  readonly code = 'bardwiki_invalid_job'

  constructor(message: string) {
    super(message)
    this.name = 'BardWikiJobValidationError'
  }
}

export function readBardWikiJobPayload(kind: BardWikiJobKind, value: unknown): BardWikiJobPayload {
  const payload = requireObject(value, 'BardWiki job payload')
  switch (kind) {
    case 'apply_turn': {
      const keys = [
        'receiptId',
        'expectedUserContentHash',
        'expectedAssistantContentHash',
        'modelProfileId',
        'promptPresetId',
        'promptVersion',
        'canonicalEnabled',
        'repairAttemptCount',
      ]
      if (Object.hasOwn(payload, 'acceptedSettings')) keys.push('acceptedSettings')
      requireExactKeys(payload, keys)
      const acceptedSettings = readAcceptedBardWikiSettings(payload.acceptedSettings)
      return {
        receiptId: requireBoundedString(payload.receiptId, 'receiptId'),
        expectedUserContentHash: requireContentHash(payload.expectedUserContentHash, 'expectedUserContentHash'),
        expectedAssistantContentHash: requireContentHash(
          payload.expectedAssistantContentHash,
          'expectedAssistantContentHash',
        ),
        modelProfileId: requireOptionalBoundedString(payload.modelProfileId, 'modelProfileId'),
        promptPresetId: requireOptionalBoundedString(payload.promptPresetId, 'promptPresetId'),
        promptVersion: requireBoundedString(payload.promptVersion, 'promptVersion'),
        canonicalEnabled: requireBoolean(payload.canonicalEnabled, 'canonicalEnabled'),
        repairAttemptCount: requireInteger(payload.repairAttemptCount, 'repairAttemptCount', 0, 1),
        ...(acceptedSettings ? { acceptedSettings } : {}),
      }
    }
    case 'reconcile_receipt': {
      requireExactKeys(payload, ['receiptId', 'changeSetId'])
      return {
        receiptId: requireBoundedString(payload.receiptId, 'receiptId'),
        changeSetId: requireBoundedString(payload.changeSetId, 'changeSetId'),
      }
    }
    case 'rebuild_chat': {
      requireExactKeys(payload, ['chatId', 'generation', 'sourceCursor', 'sourceTotal', 'policy', 'stagingManifestId'])
      const policy = payload.policy
      if (policy !== 'missing' && policy !== 'full') {
        throw new BardWikiJobValidationError('policy must be missing or full')
      }
      return {
        chatId: requireBoundedString(payload.chatId, 'chatId'),
        generation: requireInteger(payload.generation, 'generation', 0, Number.MAX_SAFE_INTEGER),
        sourceCursor: requireInteger(payload.sourceCursor, 'sourceCursor', 0, Number.MAX_SAFE_INTEGER),
        sourceTotal: requireInteger(payload.sourceTotal, 'sourceTotal', 0, Number.MAX_SAFE_INTEGER),
        policy,
        stagingManifestId: requireBoundedString(payload.stagingManifestId, 'stagingManifestId'),
      }
    }
  }
}

export function rescheduleRunningBardWikiJob(
  db: DatabaseSync,
  id: string,
  payload: BardWikiJobPayload,
  options: { now?: string | Date } = {},
): BardWikiJob | null {
  const current = getBardWikiJob(db, id)
  if (!current || current.status !== 'running') return null
  const normalized = readBardWikiJobPayload(current.kind, payload)
  const payloadJson = JSON.stringify(normalized)
  if (Buffer.byteLength(payloadJson, 'utf8') > BARDWIKI_JOB_MAX_PAYLOAD_BYTES) {
    throw new BardWikiJobValidationError('BardWiki job payload exceeds 16 KiB')
  }
  const now = normalizeTimestamp(options.now)
  const row = db
    .prepare(
      `UPDATE bardwiki_jobs
       SET status = 'pending', payload_json = ?, attempt_count = MAX(0, attempt_count - 1),
           error_code = NULL, error_summary = NULL, next_run_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running'
       RETURNING *`,
    )
    .get(payloadJson, now, now, id) as unknown as BardWikiJobRow | undefined
  return row ? mapBardWikiJobRow(row) : null
}

export function enqueueBardWikiJob(db: DatabaseSync, input: EnqueueBardWikiJobInput): BardWikiJob {
  const id = input.id ?? randomUUID()
  const instanceId = input.instanceId ?? randomUUID()
  const chatId = requireBoundedString(input.chatId, 'chatId')
  const receiptId = input.receiptId === undefined ? null : requireOptionalBoundedString(input.receiptId, 'receiptId')
  const kind = requireBardWikiJobKind(input.kind)
  if (
    kind === 'reconcile_receipt' &&
    (input.operationId !== undefined || input.operationAttemptNo !== undefined || input.generationScope !== undefined)
  ) {
    throw new BardWikiJobValidationError(
      'reconcile_receipt is exact-fence server maintenance and must not inherit source-generation authority',
    )
  }
  const payload = readBardWikiJobPayload(kind, input.payload)
  if (kind === 'rebuild_chat') {
    if ((payload as BardWikiRebuildChatJobPayload).chatId !== chatId) {
      throw new BardWikiJobValidationError('chatId must match the payload chatId')
    }
  } else if (receiptId !== (payload as BardWikiApplyTurnJobPayload | BardWikiReconcileReceiptJobPayload).receiptId) {
    throw new BardWikiJobValidationError('receiptId must match the payload receiptId')
  }
  const payloadJson = JSON.stringify(payload)
  if (Buffer.byteLength(payloadJson, 'utf8') > BARDWIKI_JOB_MAX_PAYLOAD_BYTES) {
    throw new BardWikiJobValidationError('BardWiki job payload exceeds 16 KiB')
  }
  const maxAttempts = requireInteger(input.maxAttempts ?? BARDWIKI_JOB_DEFAULT_MAX_ATTEMPTS, 'maxAttempts', 1, 100)
  const nextRunAt = normalizeTimestamp(input.nextRunAt)
  requireBoundedString(id, 'job id')
  requireBoundedString(instanceId, 'job instance id')
  db.prepare(
    `INSERT INTO bardwiki_jobs (
      id, instance_id, chat_id, receipt_id, kind, status, payload_json,
      error_code, error_summary, attempt_count, max_attempts, next_run_at,
      operation_id, operation_attempt_no, admission_kind, occupancy_database_lineage,
      occupancy_session_id, occupancy_epoch, occupancy_claim_class,
      permission_scope_version, permission_scope_json
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    instanceId,
    chatId,
    receiptId,
    kind,
    payloadJson,
    maxAttempts,
    nextRunAt,
    input.operationId ?? null,
    input.operationAttemptNo ?? null,
    ...scopeSqlValues(input.generationScope),
  )
  return getBardWikiJob(db, id) as BardWikiJob
}

export function getBardWikiJob(db: DatabaseSync, id: string): BardWikiJob | null {
  requireBoundedString(id, 'job id')
  const row = db.prepare('SELECT * FROM bardwiki_jobs WHERE id = ?').get(id) as unknown as BardWikiJobRow | undefined
  return row ? mapBardWikiJobRow(row) : null
}

export function assertBardWikiJobGenerationScope(db: DatabaseSync, job: BardWikiJob): void {
  if (job.kind === 'reconcile_receipt') {
    if (job.operationId !== undefined || job.operationAttemptNo !== undefined || job.generationScope !== undefined) {
      throw new GenerationAdmissionError(409, 'bardwiki_reconcile_authority_invalid')
    }
    return
  }
  if (!job.generationScope && job.operationId === undefined && job.operationAttemptNo === undefined) return
  const current = getBardWikiJob(db, job.id)
  if (
    !current ||
    current.chatId !== job.chatId ||
    current.operationId !== job.operationId ||
    current.operationAttemptNo !== job.operationAttemptNo ||
    JSON.stringify(current.generationScope) !== JSON.stringify(job.generationScope)
  ) {
    throw new GenerationAdmissionError(409, 'generation_job_target_stale')
  }
  if (!job.operationId || job.operationAttemptNo === undefined) {
    throw new GenerationAdmissionError(409, 'generation_job_lineage_missing')
  }
  const lineage = db
    .prepare(
      `SELECT o.chat_id AS chat_id
       FROM generation_operations AS o
       JOIN generation_operation_attempts AS a
         ON a.database_lineage = o.database_lineage
        AND a.operation_id = o.operation_id
        AND a.attempt_no = ?
       WHERE o.database_lineage = ? AND o.operation_id = ?`,
    )
    .get(job.operationAttemptNo, getDatabaseLineage(db), job.operationId) as { chat_id: string } | undefined
  if (!lineage || lineage.chat_id !== job.chatId) {
    throw new GenerationAdmissionError(409, 'generation_job_lineage_stale')
  }
  if (job.generationScope) {
    assertPersistedGenerationScopeInTransaction(db, {
      ...current.generationScope!,
      databaseLineage: getDatabaseLineage(db),
      chatId: job.chatId,
      sessionId: job.generationScope.occupancySessionId ?? '',
    })
  }
}

/**
 * Resolve the provider/configuration snapshot owned by the generation attempt
 * that accepted an automatic BardWiki job. Unlinked legacy/manual jobs return
 * undefined and retain their pre-migration live-database behavior.
 */
export function getBardWikiJobAcceptedEffectiveConfiguration(
  db: DatabaseSync,
  job: BardWikiJob,
): GenerationOperationStoredRequest['effectiveConfiguration'] | undefined {
  const operationId = job.operationId
  const operationAttemptNo = job.operationAttemptNo
  if (operationId === undefined && operationAttemptNo === undefined) return undefined
  if (operationId === undefined || operationAttemptNo === undefined) {
    throw new GenerationAdmissionError(409, 'generation_job_lineage_missing')
  }
  assertBardWikiJobGenerationScope(db, job)
  const row = db
    .prepare(
      `SELECT o.effective_configuration_json AS effective_configuration_json,
              o.effective_configuration_fingerprint AS effective_configuration_fingerprint,
              a.accepted_effective_configuration_fingerprint AS accepted_effective_configuration_fingerprint
       FROM generation_operations AS o
       JOIN generation_operation_attempts AS a
         ON a.database_lineage = o.database_lineage
        AND a.operation_id = o.operation_id
        AND a.attempt_no = ?
       WHERE o.database_lineage = ? AND o.operation_id = ? AND o.chat_id = ?`,
    )
    .get(operationAttemptNo, getDatabaseLineage(db), operationId, job.chatId) as
    | {
        effective_configuration_json: string | null
        effective_configuration_fingerprint: string | null
        accepted_effective_configuration_fingerprint: string | null
      }
    | undefined
  if (
    !row ||
    row.effective_configuration_json === null ||
    row.effective_configuration_fingerprint === null ||
    row.accepted_effective_configuration_fingerprint !== row.effective_configuration_fingerprint
  ) {
    throw new GenerationAdmissionError(409, 'generation_job_configuration_missing')
  }
  let configuration: unknown
  try {
    configuration = resolveGenerationConfiguration(
      db,
      JSON.parse(row.effective_configuration_json),
      row.effective_configuration_fingerprint,
    )
  } catch {
    throw new GenerationAdmissionError(409, 'generation_job_configuration_stale')
  }
  return configuration
}

export function listBardWikiJobs(
  db: DatabaseSync,
  filter: {
    chatId?: string
    kind?: BardWikiJobKind
    status?: BardWikiJobStatus
    statuses?: readonly BardWikiJobStatus[]
  } = {},
): BardWikiJob[] {
  const conditions: string[] = []
  const values: Array<string | number | null> = []
  if (filter.chatId !== undefined) {
    conditions.push('chat_id = ?')
    values.push(requireBoundedString(filter.chatId, 'chatId'))
  }
  if (filter.kind !== undefined) {
    conditions.push('kind = ?')
    values.push(requireBardWikiJobKind(filter.kind))
  }
  if (filter.status !== undefined) {
    conditions.push('status = ?')
    values.push(requireBardWikiJobStatus(filter.status))
  }
  if (filter.statuses !== undefined) {
    if (filter.statuses.length === 0) return []
    const statuses = filter.statuses.map(requireBardWikiJobStatus)
    conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`)
    values.push(...statuses)
  }
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
  const rows = db
    .prepare(`SELECT * FROM bardwiki_jobs ${where} ORDER BY created_at, id`)
    .all(...values) as unknown as BardWikiJobRow[]
  return rows.map(mapBardWikiJobRow)
}

export function listPendingBardWikiJobChatIds(db: DatabaseSync, options: { now?: string | Date } = {}): string[] {
  const rows = db
    .prepare(
      `SELECT chat_id, MIN(created_at) AS oldest_created_at
       FROM bardwiki_jobs
       WHERE status = 'pending' AND next_run_at <= ?
       GROUP BY chat_id
       ORDER BY oldest_created_at, chat_id`,
    )
    .all(normalizeTimestamp(options.now)) as Array<{ chat_id: string }>
  return rows.map((row) => row.chat_id)
}

export function claimNextBardWikiJob(
  db: DatabaseSync,
  filter: { chatId?: string; kind?: BardWikiJobKind; now?: string | Date } = {},
): BardWikiJob | null {
  const now = normalizeTimestamp(filter.now)
  const conditions = ["status = 'pending'", 'next_run_at <= ?']
  const values: Array<string | number | null> = [now]
  if (filter.chatId !== undefined) {
    conditions.push('chat_id = ?')
    values.push(requireBoundedString(filter.chatId, 'chatId'))
  }
  if (filter.kind !== undefined) {
    conditions.push('kind = ?')
    values.push(requireBardWikiJobKind(filter.kind))
  }
  const row = db
    .prepare(
      `UPDATE bardwiki_jobs
       SET status = 'running', attempt_count = attempt_count + 1,
           error_code = NULL, error_summary = NULL, updated_at = ?
       WHERE id = (
         SELECT id FROM bardwiki_jobs
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at, id LIMIT 1
       )
       RETURNING *`,
    )
    .get(now, ...values) as unknown as BardWikiJobRow | undefined
  if (!row) return null
  const job = mapBardWikiJobRow(row)
  updateReceiptForJob(db, job, 'processing', null, null, ['queued'])
  return job
}

export function completeBardWikiJob(db: DatabaseSync, id: string): BardWikiJob | null {
  return transitionBardWikiJob(db, id, ['running'], 'completed', null, null)
}

export function failBardWikiJob(
  db: DatabaseSync,
  id: string,
  errorCode: string,
  errorSummary: string,
): BardWikiJob | null {
  const job = transitionBardWikiJob(db, id, ['running'], 'failed', errorCode, errorSummary)
  if (job) updateReceiptForJob(db, job, 'failed', errorCode, errorSummary, ['processing', 'queued'])
  return job
}

export function retryOrFailBardWikiJob(
  db: DatabaseSync,
  id: string,
  errorCode: string,
  errorSummary: string,
  options: BardWikiJobRetryOptions = {},
): BardWikiJob | null {
  const job = getBardWikiJob(db, id)
  if (!job || job.status !== 'running') return null
  if (job.attemptCount >= job.maxAttempts) return failBardWikiJob(db, id, errorCode, errorSummary)
  const now = normalizeTimestamp(options.now)
  const nextRunAt = new Date(
    Date.parse(now) + calculateBardWikiJobRetryDelayMs(job.attemptCount, options.backoffBaseMs),
  ).toISOString()
  const row = db
    .prepare(
      `UPDATE bardwiki_jobs
       SET status = 'pending', error_code = ?, error_summary = ?, next_run_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running'
       RETURNING *`,
    )
    .get(normalizeErrorCode(errorCode), normalizeErrorSummary(errorSummary), nextRunAt, now, id) as unknown as
    | BardWikiJobRow
    | undefined
  if (!row) return null
  const retried = mapBardWikiJobRow(row)
  updateReceiptForJob(db, retried, 'queued', errorCode, errorSummary, ['processing'])
  return retried
}

export function retryFailedBardWikiJob(
  db: DatabaseSync,
  id: string,
  options: { now?: string | Date; instanceId?: string } = {},
): BardWikiJob | null {
  const now = normalizeTimestamp(options.now)
  const row = db
    .prepare(
      `UPDATE bardwiki_jobs
       SET status = 'pending', instance_id = ?, error_code = NULL, error_summary = NULL,
           attempt_count = 0, next_run_at = ?, updated_at = ?
       WHERE id = ? AND status = 'failed'
       RETURNING *`,
    )
    .get(options.instanceId ?? randomUUID(), now, now, requireBoundedString(id, 'job id')) as unknown as
    | BardWikiJobRow
    | undefined
  if (!row) return null
  const retried = mapBardWikiJobRow(row)
  updateReceiptForJob(db, retried, 'queued', null, null, ['failed'])
  return retried
}

export function cancelBardWikiJob(db: DatabaseSync, id: string): BardWikiJob | null {
  const job = transitionBardWikiJob(db, id, ['pending', 'running'], 'cancelled', 'cancelled', 'BardWiki job cancelled')
  if (job) {
    updateReceiptForJob(db, job, 'failed', 'cancelled', 'BardWiki job cancelled', ['queued', 'processing'])
  }
  return job
}

export function recoverRunningBardWikiJobs(db: DatabaseSync, options: BardWikiJobRetryOptions = {}): BardWikiJob[] {
  const running = listBardWikiJobs(db, { status: 'running' })
  const recovered: BardWikiJob[] = []
  for (const job of running) {
    const next = retryOrFailBardWikiJob(
      db,
      job.id,
      'bardwiki_worker_restarted',
      'BardWiki worker restarted while this job was running',
      options,
    )
    if (next) recovered.push(next)
  }
  return recovered
}

export function pruneTerminalBardWikiJobs(db: DatabaseSync, options: PruneTerminalBardWikiJobsOptions = {}): number {
  const retentionMs = options.retentionMs ?? BARDWIKI_JOB_DEFAULT_RETENTION_MS
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
    throw new BardWikiJobValidationError('retentionMs must be a non-negative integer')
  }
  const cutoff = new Date(Date.parse(normalizeTimestamp(options.now)) - retentionMs).toISOString()
  const result = db
    .prepare(
      `DELETE FROM bardwiki_jobs
       WHERE status IN (${BARDWIKI_JOB_TERMINAL_STATUSES.map(() => '?').join(', ')})
         AND updated_at < ?`,
    )
    .run(...BARDWIKI_JOB_TERMINAL_STATUSES, cutoff)
  return Number(result.changes)
}

export function calculateBardWikiJobRetryDelayMs(attemptCount: number, baseMs?: number): number {
  const base = baseMs ?? BARDWIKI_JOB_DEFAULT_BACKOFF_BASE_MS
  if (!Number.isSafeInteger(base) || base < 0) {
    throw new BardWikiJobValidationError('backoffBaseMs must be a non-negative integer')
  }
  return Math.min(base * 2 ** Math.max(0, attemptCount - 1), 24 * 60 * 60 * 1000)
}

function transitionBardWikiJob(
  db: DatabaseSync,
  id: string,
  fromStatuses: readonly BardWikiJobStatus[],
  toStatus: BardWikiJobStatus,
  errorCode: string | null,
  errorSummary: string | null,
): BardWikiJob | null {
  const statuses = fromStatuses.map(requireBardWikiJobStatus)
  const row = db
    .prepare(
      `UPDATE bardwiki_jobs
       SET status = ?, error_code = ?, error_summary = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status IN (${statuses.map(() => '?').join(', ')})
       RETURNING *`,
    )
    .get(
      requireBardWikiJobStatus(toStatus),
      errorCode === null ? null : normalizeErrorCode(errorCode),
      errorSummary === null ? null : normalizeErrorSummary(errorSummary),
      requireBoundedString(id, 'job id'),
      ...statuses,
    ) as unknown as BardWikiJobRow | undefined
  return row ? mapBardWikiJobRow(row) : null
}

function updateReceiptForJob(
  db: DatabaseSync,
  job: BardWikiJob,
  state: 'queued' | 'processing' | 'failed',
  errorCode: string | null,
  errorSummary: string | null,
  fromStates: readonly string[],
): void {
  if (job.kind !== 'apply_turn' || !job.receiptId) return
  db.prepare(
    `UPDATE bardwiki_turn_receipts
     SET state = ?, error_code = ?, error_summary = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND state IN (${fromStates.map(() => '?').join(', ')})`,
  ).run(
    state,
    errorCode === null ? null : normalizeErrorCode(errorCode),
    errorSummary === null ? null : normalizeErrorSummary(errorSummary),
    job.receiptId,
    ...fromStates,
  )
}

function mapBardWikiJobRow(row: BardWikiJobRow): BardWikiJob {
  const payload = readBardWikiJobPayload(row.kind, JSON.parse(row.payload_json) as unknown)
  const rebuildPayload = row.kind === 'rebuild_chat' ? (payload as BardWikiRebuildChatJobPayload) : null
  return {
    id: row.id,
    instanceId: row.instance_id,
    chatId: row.chat_id,
    receiptId: row.receipt_id,
    kind: row.kind,
    status: row.status,
    payload,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    progressCurrent: rebuildPayload?.sourceCursor ?? null,
    progressTotal: rebuildPayload?.sourceTotal ?? null,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.operation_id !== null ? { operationId: row.operation_id } : {}),
    ...(row.operation_attempt_no !== null ? { operationAttemptNo: row.operation_attempt_no } : {}),
    ...(scopeFromColumns(row) ? { generationScope: scopeFromColumns(row)! } : {}),
  }
}

function requireBardWikiJobKind(value: unknown): BardWikiJobKind {
  if (typeof value !== 'string' || !(BARDWIKI_JOB_KINDS as readonly string[]).includes(value)) {
    throw new BardWikiJobValidationError('Invalid BardWiki job kind')
  }
  return value as BardWikiJobKind
}

function requireBardWikiJobStatus(value: unknown): BardWikiJobStatus {
  if (typeof value !== 'string' || !(BARDWIKI_JOB_STATUSES as readonly string[]).includes(value)) {
    throw new BardWikiJobValidationError('Invalid BardWiki job status')
  }
  return value as BardWikiJobStatus
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BardWikiJobValidationError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const expectedSet = new Set(expected)
  const keys = Object.keys(value)
  if (keys.length !== expected.length || keys.some((key) => !expectedSet.has(key))) {
    throw new BardWikiJobValidationError(`BardWiki job payload fields must be exactly: ${expected.join(', ')}`)
  }
}

function requireBoundedString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    [...value].length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new BardWikiJobValidationError(`${label} must be a valid non-empty string`)
  }
  return value
}

function requireOptionalBoundedString(value: unknown, label: string): string | null {
  return value === null ? null : requireBoundedString(value, label)
}

function requireContentHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new BardWikiJobValidationError(`${label} must be a lowercase SHA-256 hash`)
  }
  return value
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new BardWikiJobValidationError(`${label} must be boolean`)
  return value
}

function readAcceptedBardWikiSettings(value: unknown): BardWikiGlobalSettings | undefined {
  if (value === undefined) return undefined
  if (!isBardWikiGlobalSettings(value)) {
    throw new BardWikiJobValidationError('acceptedSettings must match the BardWiki global settings contract')
  }
  return structuredClone(value)
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new BardWikiJobValidationError(`${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return value as number
}

function normalizeTimestamp(value: string | Date | undefined): string {
  if (value === undefined) return new Date().toISOString()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new BardWikiJobValidationError('Invalid BardWiki job timestamp')
  return date.toISOString()
}

function normalizeErrorCode(value: string): string {
  const normalized = value.trim()
  if (!normalized) return 'bardwiki_job_failed'
  return [...normalized].slice(0, MAX_ERROR_CODE_CODE_POINTS).join('')
}

function normalizeErrorSummary(value: string): string {
  const normalized = value.trim()
  if (!normalized) return 'BardWiki job failed'
  return [...normalized].slice(0, MAX_ERROR_SUMMARY_CODE_POINTS).join('')
}
