import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { getChatMessages } from './messageStore.js'
import type { AssembleMutationPayload } from './prompt/assemble.js'
import type { GenerationFinalizationTargetSnapshot } from './routes/generationChat.js'
import {
  scopeFromColumns,
  scopeSqlValues,
  type GenerationScopeColumns,
  type PersistedGenerationScope,
} from './generationScope.js'
import { generationFinalizationAlreadyCommitted } from './generationFinalizationCommit.js'

export type GenerationFinalizationMode = 'send' | 'continue' | 'regenerate'

export const GENERATION_FINALIZATION_LEGACY_SNAPSHOT_ERROR = 'stalled_legacy'
export const GENERATION_FINALIZATION_RETRY_BASE_DELAY_MS = 5_000
export const GENERATION_FINALIZATION_RETRY_MAX_DELAY_MS = 5 * 60_000
export const GENERATION_FINALIZATION_STALLED_FAILURE_THRESHOLD = 3

export interface GenerationFinalizationMessage {
  role: 'user' | 'char'
  data: string
  chatId?: string
  generationInfo?: {
    generationId?: string
  }
}

export interface GenerationFinalizationAttempt {
  generationId: string
  databaseLineage?: string
  operationId?: string
  operationAttemptNo?: number
  actorWriterSessionId?: string
  actorWriterEpoch?: number
  acceptedMessageId?: string
  terminalOutcome?: 'completed' | 'cancelled'
  automaticConfirmationEligible?: boolean
  /** Original non-durable owner authority, rechecked at every publication attempt. */
  compatibilityAuthority?: { databaseLineage: string; sessionId: string; occupancyEpoch: number }
  generationScope?: PersistedGenerationScope
  /** Set only while finishing an operation marked by the v39-to-v40 migration. */
  preOccupancyAuthority?: true
  chatId: string
  mode: GenerationFinalizationMode
  targetMessageId?: string
  message: GenerationFinalizationMessage
  alternateMessages?: GenerationFinalizationMessage[]
  chatVarMutations: AssembleMutationPayload['chatVarMutations']
  characterFieldMutations?: AssembleMutationPayload['characterFieldMutations']
  localLoreMutation?: AssembleMutationPayload['localLoreMutation']
  targetSnapshot?: GenerationFinalizationTargetSnapshot
}

interface GenerationFinalizationRetryRow extends GenerationScopeColumns {
  generation_id: string
  database_lineage: string | null
  operation_id: string | null
  operation_attempt_no: number | null
  actor_writer_session_id: string | null
  actor_writer_epoch: number | null
  accepted_message_id: string | null
  terminal_outcome: 'completed' | 'cancelled' | null
  compatibility_database_lineage: string | null
  compatibility_session_id: string | null
  compatibility_occupancy_epoch: number | null
  chat_id: string
  mode: GenerationFinalizationMode
  target_message_id: string | null
  message_json: string
  alternate_messages_json: string
  chat_var_mutations_json: string
  target_snapshot_json: string | null
  failure_count: number
  last_error: string | null
  terminal_error: string | null
  status: 'pending' | 'terminal'
  created_at: string
  updated_at: string
}

export interface GenerationFinalizationRetryReceipt {
  generationId: string
}

export interface PendingGenerationFinalizationRetry {
  attempt: GenerationFinalizationAttempt
  replayability: 'replayable' | 'legacy_snapshot_missing'
  createdAt: string
  failureCount: number
  nextAttemptAt: string
}

export interface MalformedGenerationFinalizationRetry {
  generationId: string
  databaseLineage?: string
  operationId?: string
  operationAttemptNo?: number
  actorWriterSessionId?: string
  actorWriterEpoch?: number
  acceptedMessageId?: string
  chatId: string
  mode: GenerationFinalizationMode
  parseError: unknown
  createdAt: string
  failureCount: number
  nextAttemptAt: string
}

export type GenerationFinalizationRetryCandidate =
  | PendingGenerationFinalizationRetry
  | MalformedGenerationFinalizationRetry

export type GenerationFinalizationProjectionState =
  | 'queued'
  | 'stalled'
  | 'terminal'
  | 'stalled_legacy'
  | 'committed_cleanup_pending'

export interface GenerationFinalizationRetryProjection {
  generationId: string
  databaseLineage?: string
  operationId?: string
  operationAttemptNo?: number
  actorWriterSessionId?: string
  actorWriterEpoch?: number
  acceptedMessageId?: string
  terminalOutcome?: 'completed' | 'cancelled'
  chatId: string
  messageId: string
  mode: GenerationFinalizationMode
  state: GenerationFinalizationProjectionState
  failureCount: number
  nextAttemptAt?: string
  provisionalMessage?: GenerationFinalizationMessage
  projectionFence?: GenerationFinalizationTargetSnapshot
}

export interface ListPendingGenerationFinalizationRetriesOptions {
  limit?: number
  now?: string | Date
  baseDelayMs?: number
  maxDelayMs?: number
}

export interface ListGenerationFinalizationRetryProjectionsOptions {
  /** Authenticated page session that may recover its own accepted work. */
  sessionId?: string
  /** Keep pre-occupancy/legacy finalizations available to the general owner. */
  includeLegacyOwner?: boolean
}

interface GenerationFinalizationMutationEnvelope {
  chatVarMutations: AssembleMutationPayload['chatVarMutations']
  characterFieldMutations?: AssembleMutationPayload['characterFieldMutations']
  localLoreMutation?: AssembleMutationPayload['localLoreMutation']
  automaticConfirmationEligible?: boolean
}

function serializeGenerationFinalizationMutations(attempt: GenerationFinalizationAttempt): string {
  if (
    !attempt.characterFieldMutations?.length &&
    !attempt.localLoreMutation &&
    attempt.automaticConfirmationEligible === undefined
  ) {
    return JSON.stringify(attempt.chatVarMutations)
  }
  return JSON.stringify({
    chatVarMutations: attempt.chatVarMutations,
    ...(attempt.characterFieldMutations?.length ? { characterFieldMutations: attempt.characterFieldMutations } : {}),
    ...(attempt.localLoreMutation ? { localLoreMutation: attempt.localLoreMutation } : {}),
    ...(attempt.automaticConfirmationEligible !== undefined
      ? { automaticConfirmationEligible: attempt.automaticConfirmationEligible }
      : {}),
  } satisfies GenerationFinalizationMutationEnvelope)
}

function parseGenerationFinalizationMutations(value: string): GenerationFinalizationMutationEnvelope {
  const parsed = JSON.parse(value) as unknown
  if (Array.isArray(parsed)) {
    return { chatVarMutations: parsed as AssembleMutationPayload['chatVarMutations'] }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid generation finalization mutation payload')
  }
  const envelope = parsed as Partial<GenerationFinalizationMutationEnvelope>
  if (!Array.isArray(envelope.chatVarMutations)) {
    throw new Error('Invalid generation finalization chat variable mutations')
  }
  if (
    envelope.automaticConfirmationEligible !== undefined &&
    typeof envelope.automaticConfirmationEligible !== 'boolean'
  ) {
    throw new Error('Invalid generation finalization automatic confirmation eligibility')
  }
  return envelope as GenerationFinalizationMutationEnvelope
}

function normalizeTimestamp(value: string | Date | undefined): string {
  const iso = value instanceof Date ? value.toISOString() : (value ?? new Date().toISOString())
  if (Number.isNaN(Date.parse(iso))) {
    throw new Error('now must be a valid timestamp')
  }
  return iso
}

function normalizeNonNegativeInteger(value: number | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return value
}

function normalizePositiveInteger(value: number | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

export function generationFinalizationRetryBackoffMs(
  failureCount: number,
  options: { baseDelayMs?: number; maxDelayMs?: number } = {},
): number {
  const normalizedFailureCount = normalizeNonNegativeInteger(failureCount, 0, 'failureCount')
  if (normalizedFailureCount === 0) return 0
  const baseDelayMs = normalizePositiveInteger(
    options.baseDelayMs,
    GENERATION_FINALIZATION_RETRY_BASE_DELAY_MS,
    'baseDelayMs',
  )
  const maxDelayMs = normalizePositiveInteger(
    options.maxDelayMs,
    GENERATION_FINALIZATION_RETRY_MAX_DELAY_MS,
    'maxDelayMs',
  )
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(30, normalizedFailureCount - 1))
}

function retryNextAttemptAt(
  updatedAt: string,
  failureCount: number,
  options: { baseDelayMs?: number; maxDelayMs?: number } = {},
): string {
  return new Date(Date.parse(updatedAt) + generationFinalizationRetryBackoffMs(failureCount, options)).toISOString()
}

export function createGenerationFinalizationRetryTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS generation_finalization_retries (
      generation_id TEXT PRIMARY KEY,
      database_lineage TEXT,
      operation_id TEXT,
      operation_attempt_no INTEGER CHECK (operation_attempt_no IS NULL OR operation_attempt_no > 0),
      actor_writer_session_id TEXT,
      actor_writer_epoch INTEGER CHECK (actor_writer_epoch IS NULL OR actor_writer_epoch >= 0),
      accepted_message_id TEXT,
      terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('completed', 'cancelled')),
      compatibility_database_lineage TEXT,
      compatibility_session_id TEXT,
      compatibility_occupancy_epoch INTEGER CHECK (compatibility_occupancy_epoch IS NULL OR compatibility_occupancy_epoch >= 0),
      admission_kind TEXT CHECK (admission_kind IS NULL OR admission_kind IN ('legacy_owner', 'owner_occupancy', 'chat_only')),
      occupancy_database_lineage TEXT,
      occupancy_session_id TEXT,
      occupancy_epoch INTEGER CHECK (occupancy_epoch IS NULL OR occupancy_epoch >= 0),
      occupancy_claim_class TEXT CHECK (occupancy_claim_class IS NULL OR occupancy_claim_class IN ('owner', 'chat_only')),
      permission_scope_version INTEGER CHECK (permission_scope_version IS NULL OR permission_scope_version > 0),
      permission_scope_json TEXT CHECK (permission_scope_json IS NULL OR json_valid(permission_scope_json)),
      chat_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('send', 'continue', 'regenerate')),
      target_message_id TEXT,
      message_json TEXT NOT NULL CHECK (json_valid(message_json)),
      alternate_messages_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternate_messages_json)),
      chat_var_mutations_json TEXT NOT NULL CHECK (json_valid(chat_var_mutations_json)),
      target_snapshot_json TEXT CHECK (target_snapshot_json IS NULL OR json_valid(target_snapshot_json)),
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
      last_error TEXT,
      terminal_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'terminal')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_generation_finalization_retries_status
      ON generation_finalization_retries (status, updated_at);
  `)
  ensureGenerationFinalizationScopeColumns(db)
}

function ensureGenerationFinalizationScopeColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(generation_finalization_retries)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  )
  const columns: ReadonlyArray<readonly [string, string]> = [
    [
      'compatibility_database_lineage',
      'ALTER TABLE generation_finalization_retries ADD COLUMN compatibility_database_lineage TEXT',
    ],
    [
      'compatibility_session_id',
      'ALTER TABLE generation_finalization_retries ADD COLUMN compatibility_session_id TEXT',
    ],
    [
      'compatibility_occupancy_epoch',
      'ALTER TABLE generation_finalization_retries ADD COLUMN compatibility_occupancy_epoch INTEGER CHECK (compatibility_occupancy_epoch IS NULL OR compatibility_occupancy_epoch >= 0)',
    ],
    [
      'admission_kind',
      "ALTER TABLE generation_finalization_retries ADD COLUMN admission_kind TEXT CHECK (admission_kind IS NULL OR admission_kind IN ('legacy_owner', 'owner_occupancy', 'chat_only'))",
    ],
    [
      'occupancy_database_lineage',
      'ALTER TABLE generation_finalization_retries ADD COLUMN occupancy_database_lineage TEXT',
    ],
    ['occupancy_session_id', 'ALTER TABLE generation_finalization_retries ADD COLUMN occupancy_session_id TEXT'],
    [
      'occupancy_epoch',
      'ALTER TABLE generation_finalization_retries ADD COLUMN occupancy_epoch INTEGER CHECK (occupancy_epoch IS NULL OR occupancy_epoch >= 0)',
    ],
    [
      'occupancy_claim_class',
      "ALTER TABLE generation_finalization_retries ADD COLUMN occupancy_claim_class TEXT CHECK (occupancy_claim_class IS NULL OR occupancy_claim_class IN ('owner', 'chat_only'))",
    ],
    [
      'permission_scope_version',
      'ALTER TABLE generation_finalization_retries ADD COLUMN permission_scope_version INTEGER CHECK (permission_scope_version IS NULL OR permission_scope_version > 0)',
    ],
    [
      'permission_scope_json',
      'ALTER TABLE generation_finalization_retries ADD COLUMN permission_scope_json TEXT CHECK (permission_scope_json IS NULL OR json_valid(permission_scope_json))',
    ],
  ]
  for (const [name, sql] of columns) if (!existing.has(name)) db.exec(sql)
}

export function enqueueGenerationFinalizationRetry(
  db: DatabaseSync,
  attempt: GenerationFinalizationAttempt,
): GenerationFinalizationRetryReceipt {
  if ((attempt.mode === 'continue' || attempt.mode === 'regenerate') && !attempt.targetSnapshot) {
    throw new Error(`Generation finalization ${attempt.mode} attempts require a target snapshot`)
  }
  const operationLineageValues = [
    attempt.databaseLineage,
    attempt.operationId,
    attempt.operationAttemptNo,
    attempt.actorWriterSessionId,
    attempt.actorWriterEpoch,
  ]
  const hasOperationLineage =
    operationLineageValues.some((value) => value !== undefined) ||
    attempt.acceptedMessageId !== undefined ||
    attempt.terminalOutcome !== undefined ||
    attempt.generationScope !== undefined
  if (
    hasOperationLineage &&
    (operationLineageValues.some((value) => value === undefined) ||
      (attempt.terminalOutcome === undefined &&
        attempt.generationScope === undefined &&
        attempt.preOccupancyAuthority !== true))
  ) {
    throw new Error('Protocol generation finalization attempts require complete operation lineage')
  }
  if (hasOperationLineage && attempt.compatibilityAuthority) {
    throw new Error('Generation finalization attempts cannot mix operation and compatibility authority')
  }
  const result = db
    .prepare(
      `
      INSERT INTO generation_finalization_retries (
        generation_id,
        database_lineage,
        operation_id,
        operation_attempt_no,
        actor_writer_session_id,
        actor_writer_epoch,
        accepted_message_id,
        terminal_outcome,
        compatibility_database_lineage,
        compatibility_session_id,
        compatibility_occupancy_epoch,
        admission_kind,
        occupancy_database_lineage,
        occupancy_session_id,
        occupancy_epoch,
        occupancy_claim_class,
        permission_scope_version,
        permission_scope_json,
        chat_id,
        mode,
        target_message_id,
        message_json,
        alternate_messages_json,
        chat_var_mutations_json,
        target_snapshot_json,
        status,
        last_error,
        terminal_error,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(generation_id) DO UPDATE SET
        database_lineage = excluded.database_lineage,
        operation_id = excluded.operation_id,
        operation_attempt_no = excluded.operation_attempt_no,
        actor_writer_session_id = excluded.actor_writer_session_id,
        actor_writer_epoch = excluded.actor_writer_epoch,
        accepted_message_id = excluded.accepted_message_id,
        terminal_outcome = excluded.terminal_outcome,
        compatibility_database_lineage = excluded.compatibility_database_lineage,
        compatibility_session_id = excluded.compatibility_session_id,
        compatibility_occupancy_epoch = excluded.compatibility_occupancy_epoch,
        admission_kind = excluded.admission_kind,
        occupancy_database_lineage = excluded.occupancy_database_lineage,
        occupancy_session_id = excluded.occupancy_session_id,
        occupancy_epoch = excluded.occupancy_epoch,
        occupancy_claim_class = excluded.occupancy_claim_class,
        permission_scope_version = excluded.permission_scope_version,
        permission_scope_json = excluded.permission_scope_json,
        chat_id = excluded.chat_id,
        mode = excluded.mode,
        target_message_id = excluded.target_message_id,
        message_json = excluded.message_json,
        alternate_messages_json = excluded.alternate_messages_json,
        chat_var_mutations_json = excluded.chat_var_mutations_json,
        target_snapshot_json = excluded.target_snapshot_json,
        status = 'pending',
        last_error = NULL,
        terminal_error = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `,
    )
    .run(
      attempt.generationId,
      attempt.databaseLineage ?? null,
      attempt.operationId ?? null,
      attempt.operationAttemptNo ?? null,
      attempt.actorWriterSessionId ?? null,
      attempt.actorWriterEpoch ?? null,
      attempt.acceptedMessageId ?? null,
      attempt.terminalOutcome ?? null,
      attempt.compatibilityAuthority?.databaseLineage ?? null,
      attempt.compatibilityAuthority?.sessionId ?? null,
      attempt.compatibilityAuthority?.occupancyEpoch ?? null,
      ...scopeSqlValues(attempt.generationScope),
      attempt.chatId,
      attempt.mode,
      attempt.targetMessageId ?? null,
      JSON.stringify(attempt.message),
      JSON.stringify(attempt.alternateMessages ?? []),
      serializeGenerationFinalizationMutations(attempt),
      attempt.targetSnapshot ? JSON.stringify(attempt.targetSnapshot) : null,
    )
  if (result.changes !== 1) {
    throw new Error(`Generation finalization journal write was not confirmed for ${attempt.generationId}`)
  }
  return { generationId: attempt.generationId }
}

export function deleteGenerationFinalizationRetry(
  db: DatabaseSync,
  generationId: string,
): GenerationFinalizationRetryReceipt {
  const result = db.prepare('DELETE FROM generation_finalization_retries WHERE generation_id = ?').run(generationId)
  if (result.changes !== 1) {
    throw new Error(`Generation finalization journal cleanup was not confirmed for ${generationId}`)
  }
  return { generationId }
}

export function markGenerationFinalizationRetryFailure(
  db: DatabaseSync,
  generationId: string,
  error: string,
  terminal: boolean,
): GenerationFinalizationRetryReceipt {
  const result = db
    .prepare(
      `
      UPDATE generation_finalization_retries
      SET
        failure_count = failure_count + 1,
        last_error = ?,
        terminal_error = CASE WHEN ? THEN ? ELSE terminal_error END,
        status = CASE WHEN ? THEN 'terminal' ELSE 'pending' END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE generation_id = ?
    `,
    )
    .run(error, terminal ? 1 : 0, terminal ? error : null, terminal ? 1 : 0, generationId)
  if (result.changes !== 1) {
    throw new Error(`Generation finalization retry bookkeeping was not confirmed for ${generationId}`)
  }
  return { generationId }
}

export function listPendingGenerationFinalizationRetries(
  db: DatabaseSync,
  options: ListPendingGenerationFinalizationRetriesOptions = {},
): GenerationFinalizationRetryCandidate[] {
  const boundedLimit = normalizePositiveInteger(options.limit, 25, 'limit')
  const nowMs = Date.parse(normalizeTimestamp(options.now))
  const rows = db
    .prepare(
      `
        SELECT
          generation_id,
          database_lineage,
          operation_id,
          operation_attempt_no,
          actor_writer_session_id,
          actor_writer_epoch,
          accepted_message_id,
          terminal_outcome,
          compatibility_database_lineage,
          compatibility_session_id,
          compatibility_occupancy_epoch,
          admission_kind,
          occupancy_database_lineage,
          occupancy_session_id,
          occupancy_epoch,
          occupancy_claim_class,
          permission_scope_version,
          permission_scope_json,
          chat_id,
          mode,
          target_message_id,
          message_json,
          alternate_messages_json,
          chat_var_mutations_json,
          target_snapshot_json,
          failure_count,
          last_error,
          terminal_error,
          status,
          created_at,
          updated_at
        FROM generation_finalization_retries
        WHERE status = 'pending'
        ORDER BY updated_at ASC, created_at ASC
      `,
    )
    .all() as unknown as GenerationFinalizationRetryRow[]

  const candidates: GenerationFinalizationRetryCandidate[] = []
  for (const row of rows) {
    const nextAttemptAt = retryNextAttemptAt(row.updated_at, row.failure_count, options)
    if (Date.parse(nextAttemptAt) > nowMs) continue
    try {
      const attempt = parseGenerationFinalizationAttempt(row)
      const legacySnapshotMissing =
        (row.mode === 'continue' || row.mode === 'regenerate') && row.target_snapshot_json === null
      candidates.push({
        attempt,
        replayability: legacySnapshotMissing ? ('legacy_snapshot_missing' as const) : ('replayable' as const),
        createdAt: row.created_at,
        failureCount: row.failure_count,
        nextAttemptAt,
      })
    } catch (parseError) {
      candidates.push({
        generationId: row.generation_id,
        ...(row.database_lineage !== null ? { databaseLineage: row.database_lineage } : {}),
        ...(row.operation_id !== null ? { operationId: row.operation_id } : {}),
        ...(row.operation_attempt_no !== null ? { operationAttemptNo: row.operation_attempt_no } : {}),
        ...(row.actor_writer_session_id !== null ? { actorWriterSessionId: row.actor_writer_session_id } : {}),
        ...(row.actor_writer_epoch !== null ? { actorWriterEpoch: row.actor_writer_epoch } : {}),
        ...(row.accepted_message_id !== null ? { acceptedMessageId: row.accepted_message_id } : {}),
        chatId: row.chat_id,
        mode: row.mode,
        parseError,
        createdAt: row.created_at,
        failureCount: row.failure_count,
        nextAttemptAt,
      })
    }
    if (candidates.length >= boundedLimit) break
  }
  return candidates
}

function listGenerationFinalizationRetryRows(
  db: DatabaseSync,
  options: { pendingChatId?: string } = {},
): GenerationFinalizationRetryRow[] {
  const where = options.pendingChatId === undefined ? '' : "WHERE chat_id = ? AND status = 'pending'"
  return db
    .prepare(
      `
        SELECT
          generation_id,
          database_lineage,
          operation_id,
          operation_attempt_no,
          actor_writer_session_id,
          actor_writer_epoch,
          accepted_message_id,
          terminal_outcome,
          compatibility_database_lineage,
          compatibility_session_id,
          compatibility_occupancy_epoch,
          admission_kind,
          occupancy_database_lineage,
          occupancy_session_id,
          occupancy_epoch,
          occupancy_claim_class,
          permission_scope_version,
          permission_scope_json,
          chat_id,
          mode,
          target_message_id,
          message_json,
          alternate_messages_json,
          chat_var_mutations_json,
          target_snapshot_json,
          failure_count,
          last_error,
          terminal_error,
          status,
          created_at,
          updated_at
        FROM generation_finalization_retries
        ${where}
        ORDER BY created_at ASC, generation_id ASC
      `,
    )
    .all(
      ...(options.pendingChatId === undefined ? [] : [options.pendingChatId]),
    ) as unknown as GenerationFinalizationRetryRow[]
}

function compatibilityAuthorityFromRow(
  row: GenerationFinalizationRetryRow,
): GenerationFinalizationAttempt['compatibilityAuthority'] {
  const hasDatabaseLineage = row.compatibility_database_lineage !== null
  const hasSessionId = row.compatibility_session_id !== null
  const hasOccupancyEpoch = row.compatibility_occupancy_epoch !== null
  if (hasDatabaseLineage !== hasSessionId || hasDatabaseLineage !== hasOccupancyEpoch) {
    throw new Error(`Generation finalization retry ${row.generation_id} has incomplete compatibility authority`)
  }
  if (!hasDatabaseLineage || !hasSessionId) return undefined
  if (!Number.isSafeInteger(row.compatibility_occupancy_epoch) || row.compatibility_occupancy_epoch! < 0) {
    throw new Error(`Generation finalization retry ${row.generation_id} has invalid compatibility authority`)
  }

  const mixedAuthorityValues = [
    row.database_lineage,
    row.operation_id,
    row.operation_attempt_no,
    row.actor_writer_session_id,
    row.actor_writer_epoch,
    row.accepted_message_id,
    row.terminal_outcome,
    row.admission_kind,
    row.occupancy_database_lineage,
    row.occupancy_session_id,
    row.occupancy_epoch,
    row.occupancy_claim_class,
    row.permission_scope_version,
    row.permission_scope_json,
  ]
  if (mixedAuthorityValues.some((value) => value !== null)) {
    throw new Error(`Generation finalization retry ${row.generation_id} mixes compatibility and operation authority`)
  }
  return {
    databaseLineage: row.compatibility_database_lineage!,
    sessionId: row.compatibility_session_id!,
    occupancyEpoch: row.compatibility_occupancy_epoch!,
  }
}

function parseGenerationFinalizationMessage(value: string, label: string): GenerationFinalizationMessage {
  return validateGenerationFinalizationMessage(JSON.parse(value) as unknown, label)
}

function validateGenerationFinalizationMessage(value: unknown, label: string): GenerationFinalizationMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid generation finalization ${label}`)
  }
  const message = value as Record<string, unknown>
  if ((message.role !== 'user' && message.role !== 'char') || typeof message.data !== 'string') {
    throw new Error(`Invalid generation finalization ${label}`)
  }
  if (message.chatId !== undefined && typeof message.chatId !== 'string') {
    throw new Error(`Invalid generation finalization ${label} chatId`)
  }
  if (message.generationInfo !== undefined) {
    if (
      !message.generationInfo ||
      typeof message.generationInfo !== 'object' ||
      Array.isArray(message.generationInfo)
    ) {
      throw new Error(`Invalid generation finalization ${label} generationInfo`)
    }
    const generationId = (message.generationInfo as Record<string, unknown>).generationId
    if (generationId !== undefined && typeof generationId !== 'string') {
      throw new Error(`Invalid generation finalization ${label} generationId`)
    }
  }
  return value as GenerationFinalizationMessage
}

function parseGenerationFinalizationAlternateMessages(value: string): GenerationFinalizationMessage[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) throw new Error('Invalid generation finalization alternate messages')
  return parsed.map((message, index) =>
    validateGenerationFinalizationMessage(message, `alternate message at index ${index}`),
  )
}

function parseGenerationFinalizationTargetSnapshot(
  value: string,
  expectedMode: GenerationFinalizationMode,
): GenerationFinalizationTargetSnapshot {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid generation finalization target snapshot')
  }
  const snapshot = parsed as Record<string, unknown>
  if (
    snapshot.mode !== expectedMode ||
    (snapshot.kind !== 'tail' && snapshot.kind !== 'target-tail') ||
    !Number.isSafeInteger(snapshot.transcriptLength) ||
    (snapshot.transcriptLength as number) < 0
  ) {
    throw new Error('Invalid generation finalization target snapshot')
  }
  if (snapshot.kind === 'target-tail') {
    if (!snapshot.target || typeof snapshot.target !== 'object' || Array.isArray(snapshot.target)) {
      throw new Error('Invalid generation finalization target snapshot')
    }
    validateGenerationFinalizationMessage(
      (snapshot.target as Record<string, unknown>).message,
      'target snapshot message',
    )
  } else if (snapshot.tail !== undefined) {
    if (!snapshot.tail || typeof snapshot.tail !== 'object' || Array.isArray(snapshot.tail)) {
      throw new Error('Invalid generation finalization target snapshot')
    }
    validateGenerationFinalizationMessage((snapshot.tail as Record<string, unknown>).message, 'tail snapshot message')
  }
  return parsed as GenerationFinalizationTargetSnapshot
}

function parseGenerationFinalizationAttempt(row: GenerationFinalizationRetryRow): GenerationFinalizationAttempt {
  const alternateMessages = parseGenerationFinalizationAlternateMessages(row.alternate_messages_json)
  const mutations = parseGenerationFinalizationMutations(row.chat_var_mutations_json)
  const compatibilityAuthority = compatibilityAuthorityFromRow(row)
  const generationScope = scopeFromColumns(row)
  return {
    generationId: row.generation_id,
    ...(row.database_lineage !== null ? { databaseLineage: row.database_lineage } : {}),
    ...(row.operation_id !== null ? { operationId: row.operation_id } : {}),
    ...(row.operation_attempt_no !== null ? { operationAttemptNo: row.operation_attempt_no } : {}),
    ...(row.actor_writer_session_id !== null ? { actorWriterSessionId: row.actor_writer_session_id } : {}),
    ...(row.actor_writer_epoch !== null ? { actorWriterEpoch: row.actor_writer_epoch } : {}),
    ...(row.accepted_message_id !== null ? { acceptedMessageId: row.accepted_message_id } : {}),
    ...(row.terminal_outcome !== null ? { terminalOutcome: row.terminal_outcome } : {}),
    ...(compatibilityAuthority ? { compatibilityAuthority } : {}),
    ...(generationScope ? { generationScope } : {}),
    chatId: row.chat_id,
    mode: row.mode,
    ...(row.target_message_id !== null ? { targetMessageId: row.target_message_id } : {}),
    message: parseGenerationFinalizationMessage(row.message_json, 'message'),
    ...(alternateMessages.length > 0 ? { alternateMessages } : {}),
    chatVarMutations: mutations.chatVarMutations,
    ...(mutations.characterFieldMutations?.length
      ? { characterFieldMutations: mutations.characterFieldMutations }
      : {}),
    ...(mutations.localLoreMutation ? { localLoreMutation: mutations.localLoreMutation } : {}),
    ...(mutations.automaticConfirmationEligible !== undefined
      ? { automaticConfirmationEligible: mutations.automaticConfirmationEligible }
      : {}),
    ...(row.target_snapshot_json !== null
      ? { targetSnapshot: parseGenerationFinalizationTargetSnapshot(row.target_snapshot_json, row.mode) }
      : {}),
  }
}

function rowMatchesMessage(row: unknown, message: GenerationFinalizationMessage): boolean {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  const record = row as Record<string, unknown>
  if (record.role !== message.role || record.data !== message.data) return false
  return message.chatId === undefined || record.chatId === message.chatId
}

/**
 * Return unfinished authoritative finalization work that still owns the chat's
 * transcript tail. A journal retained only because cleanup failed after the
 * result committed does not fence a later generation.
 */
export function findUncommittedGenerationFinalizationForChat(
  db: DatabaseSync,
  chatId: string,
): { generationId: string } | undefined {
  const rows = getChatMessages(db, chatId) as unknown as GenerationFinalizationMessage[]
  for (const row of listGenerationFinalizationRetryRows(db, { pendingChatId: chatId })) {
    try {
      const attempt = parseGenerationFinalizationAttempt(row)
      if (generationFinalizationAlreadyCommitted(rows, attempt)) continue
    } catch {
      // A malformed pending journal remains a recovery pin until the retry
      // sweep quarantines it. Never let one corrupt row break admission checks.
    }
    return { generationId: row.generation_id }
  }
  return undefined
}

function finalizationTargetIsFresh(
  rows: readonly GenerationFinalizationMessage[],
  attempt: GenerationFinalizationAttempt,
): boolean {
  const snapshot = attempt.targetSnapshot
  if (!snapshot) return false
  if (rows.length !== snapshot.transcriptLength) return false
  const liveTail = rows.at(-1)
  if (snapshot.kind === 'target-tail') {
    return isDeepStrictEqual(liveTail, snapshot.target.message)
  }
  if (snapshot.tail) return isDeepStrictEqual(liveTail, snapshot.tail.message)
  return liveTail === undefined
}

/**
 * Authenticated runtime projection of retained journal state. Message content is
 * included only when replaying it over the authoritative transcript is still
 * protected by the same assembly-time snapshot fence used by persistence.
 */
export function listGenerationFinalizationRetryProjections(
  db: DatabaseSync,
  options?: ListGenerationFinalizationRetryProjectionsOptions,
): GenerationFinalizationRetryProjection[] {
  const rowsByChat = new Map<string, GenerationFinalizationMessage[]>()
  return listGenerationFinalizationRetryRows(db)
    .filter((row) => finalizationVisibleToRecoverySession(db, row, options))
    .map((row) => {
      let attempt: GenerationFinalizationAttempt
      try {
        attempt = parseGenerationFinalizationAttempt(row)
      } catch {
        const state: GenerationFinalizationProjectionState =
          row.status === 'terminal'
            ? 'terminal'
            : row.failure_count >= GENERATION_FINALIZATION_STALLED_FAILURE_THRESHOLD
              ? 'stalled'
              : 'queued'
        return {
          generationId: row.generation_id,
          ...(row.database_lineage !== null ? { databaseLineage: row.database_lineage } : {}),
          ...(row.operation_id !== null ? { operationId: row.operation_id } : {}),
          ...(row.operation_attempt_no !== null ? { operationAttemptNo: row.operation_attempt_no } : {}),
          ...(row.actor_writer_session_id !== null ? { actorWriterSessionId: row.actor_writer_session_id } : {}),
          ...(row.actor_writer_epoch !== null ? { actorWriterEpoch: row.actor_writer_epoch } : {}),
          ...(row.accepted_message_id !== null ? { acceptedMessageId: row.accepted_message_id } : {}),
          ...(row.terminal_outcome !== null ? { terminalOutcome: row.terminal_outcome } : {}),
          chatId: row.chat_id,
          messageId: row.target_message_id ?? row.generation_id,
          mode: row.mode,
          state,
          failureCount: row.failure_count,
          ...(row.status === 'pending' ? { nextAttemptAt: retryNextAttemptAt(row.updated_at, row.failure_count) } : {}),
        }
      }
      let chatRows = rowsByChat.get(attempt.chatId)
      if (!chatRows) {
        chatRows = getChatMessages(db, attempt.chatId) as unknown as GenerationFinalizationMessage[]
        rowsByChat.set(attempt.chatId, chatRows)
      }
      const committed = generationFinalizationAlreadyCommitted(chatRows, attempt)
      const state: GenerationFinalizationProjectionState = committed
        ? 'committed_cleanup_pending'
        : row.status === 'terminal'
          ? row.terminal_error === GENERATION_FINALIZATION_LEGACY_SNAPSHOT_ERROR
            ? 'stalled_legacy'
            : 'terminal'
          : row.failure_count >= GENERATION_FINALIZATION_STALLED_FAILURE_THRESHOLD
            ? 'stalled'
            : 'queued'
      const messageId = attempt.targetMessageId ?? attempt.message.chatId ?? attempt.generationId
      return {
        generationId: attempt.generationId,
        ...(attempt.databaseLineage ? { databaseLineage: attempt.databaseLineage } : {}),
        ...(attempt.operationId ? { operationId: attempt.operationId } : {}),
        ...(attempt.operationAttemptNo !== undefined ? { operationAttemptNo: attempt.operationAttemptNo } : {}),
        ...(attempt.actorWriterSessionId ? { actorWriterSessionId: attempt.actorWriterSessionId } : {}),
        ...(attempt.actorWriterEpoch !== undefined ? { actorWriterEpoch: attempt.actorWriterEpoch } : {}),
        ...(attempt.acceptedMessageId ? { acceptedMessageId: attempt.acceptedMessageId } : {}),
        ...(attempt.terminalOutcome ? { terminalOutcome: attempt.terminalOutcome } : {}),
        chatId: attempt.chatId,
        messageId,
        mode: attempt.mode,
        state,
        failureCount: row.failure_count,
        ...(row.status === 'pending' ? { nextAttemptAt: retryNextAttemptAt(row.updated_at, row.failure_count) } : {}),
        ...(!committed && finalizationTargetIsFresh(chatRows, attempt)
          ? {
              provisionalMessage: structuredClone(attempt.message),
              projectionFence: structuredClone(attempt.targetSnapshot),
            }
          : {}),
      }
    })
}

function finalizationVisibleToRecoverySession(
  db: DatabaseSync,
  row: GenerationFinalizationRetryRow,
  options: ListGenerationFinalizationRetryProjectionsOptions | undefined,
): boolean {
  if (options === undefined) return true
  let scope: PersistedGenerationScope | undefined
  try {
    scope = scopeFromColumns(row)
  } catch {
    return false
  }
  if (!scope || scope.admissionKind === 'legacy_owner') return options.includeLegacyOwner === true
  if (
    typeof options.sessionId !== 'string' ||
    options.sessionId.length === 0 ||
    scope.occupancySessionId !== options.sessionId
  ) {
    return false
  }
  try {
    return finalizationHasExactAcceptedOperationBinding(db, parseGenerationFinalizationAttempt(row))
  } catch {
    return false
  }
}

function finalizationHasExactAcceptedOperationBinding(
  db: DatabaseSync,
  attempt: GenerationFinalizationAttempt,
): boolean {
  const scope = attempt.generationScope
  if (
    !scope ||
    scope.admissionKind === 'legacy_owner' ||
    attempt.databaseLineage === undefined ||
    attempt.operationId === undefined ||
    attempt.operationAttemptNo === undefined ||
    attempt.actorWriterSessionId === undefined ||
    attempt.actorWriterEpoch === undefined
  ) {
    return false
  }
  const row = db
    .prepare(
      `SELECT o.protocol_version AS protocolVersion,
              o.chat_id AS chatId, o.creator_writer_session_id AS creatorSessionId,
              o.accepted_message_id AS acceptedMessageId,
              o.admission_kind, o.occupancy_database_lineage,
              o.occupancy_session_id, o.occupancy_epoch, o.occupancy_claim_class,
              o.permission_scope_version, o.permission_scope_json,
              a.job_id AS jobId,
              a.finalization_generation_id AS finalizationGenerationId,
              a.actor_writer_session_id AS attemptActorSessionId,
              a.actor_writer_epoch AS attemptActorEpoch,
              a.accepted_admission_kind AS attempt_admission_kind,
              a.accepted_occupancy_database_lineage AS attempt_occupancy_database_lineage,
              a.accepted_occupancy_session_id AS attempt_occupancy_session_id,
              a.accepted_occupancy_epoch AS attempt_occupancy_epoch,
              a.accepted_occupancy_claim_class AS attempt_occupancy_claim_class,
              a.accepted_permission_scope_version AS attempt_permission_scope_version,
              a.accepted_permission_scope_json AS attempt_permission_scope_json
       FROM generation_operations AS o
       JOIN generation_operation_attempts AS a
         ON a.database_lineage = o.database_lineage
        AND a.operation_id = o.operation_id
        AND a.attempt_no = ?
       WHERE o.database_lineage = ? AND o.operation_id = ?`,
    )
    .get(attempt.operationAttemptNo, attempt.databaseLineage, attempt.operationId) as unknown as
    | (GenerationScopeColumns & {
        protocolVersion: number
        chatId: string | null
        creatorSessionId: string
        acceptedMessageId: string | null
        jobId: string
        finalizationGenerationId: string | null
        attemptActorSessionId: string
        attemptActorEpoch: number
        attempt_admission_kind: GenerationScopeColumns['admission_kind']
        attempt_occupancy_database_lineage: string | null
        attempt_occupancy_session_id: string | null
        attempt_occupancy_epoch: number | null
        attempt_occupancy_claim_class: GenerationScopeColumns['occupancy_claim_class']
        attempt_permission_scope_version: number | null
        attempt_permission_scope_json: string | null
      })
    | undefined
  if (!row) return false
  const acceptedAttemptScope = scopeFromColumns({
    admission_kind: row.attempt_admission_kind,
    occupancy_database_lineage: row.attempt_occupancy_database_lineage,
    occupancy_session_id: row.attempt_occupancy_session_id,
    occupancy_epoch: row.attempt_occupancy_epoch,
    occupancy_claim_class: row.attempt_occupancy_claim_class,
    permission_scope_version: row.attempt_permission_scope_version,
    permission_scope_json: row.attempt_permission_scope_json,
  })
  return (
    row.protocolVersion >= 1 &&
    row.chatId === attempt.chatId &&
    scope.occupancyDatabaseLineage === attempt.databaseLineage &&
    row.creatorSessionId === scope.occupancySessionId &&
    row.attemptActorSessionId === scope.occupancySessionId &&
    row.attemptActorSessionId === attempt.actorWriterSessionId &&
    row.attemptActorEpoch === attempt.actorWriterEpoch &&
    row.acceptedMessageId === (attempt.acceptedMessageId ?? null) &&
    (row.finalizationGenerationId === attempt.generationId ||
      (row.finalizationGenerationId === null && row.jobId === attempt.generationId)) &&
    generationScopesEqual(scopeFromColumns(row), scope) &&
    generationScopesEqual(acceptedAttemptScope, scope)
  )
}

function generationScopesEqual(
  left: PersistedGenerationScope | undefined,
  right: PersistedGenerationScope | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
