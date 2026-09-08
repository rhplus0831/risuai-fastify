import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { getChatMessages } from './messageStore.js'
import type { AssembleMutationPayload } from './prompt/assemble.js'
import type { GenerationFinalizationTargetSnapshot } from './routes/generationChat.js'

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

interface GenerationFinalizationRetryRow {
  generation_id: string
  database_lineage: string | null
  operation_id: string | null
  operation_attempt_no: number | null
  actor_writer_session_id: string | null
  actor_writer_epoch: number | null
  accepted_message_id: string | null
  terminal_outcome: 'completed' | 'cancelled' | null
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
    attempt.terminalOutcome,
  ]
  const hasOperationLineage =
    operationLineageValues.some((value) => value !== undefined) || attempt.acceptedMessageId !== undefined
  if (hasOperationLineage && operationLineageValues.some((value) => value === undefined)) {
    throw new Error('Protocol generation finalization attempts require complete operation lineage')
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(generation_id) DO UPDATE SET
        database_lineage = excluded.database_lineage,
        operation_id = excluded.operation_id,
        operation_attempt_no = excluded.operation_attempt_no,
        actor_writer_session_id = excluded.actor_writer_session_id,
        actor_writer_epoch = excluded.actor_writer_epoch,
        accepted_message_id = excluded.accepted_message_id,
        terminal_outcome = excluded.terminal_outcome,
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
): PendingGenerationFinalizationRetry[] {
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

  return rows
    .flatMap((row) => {
      const nextAttemptAt = retryNextAttemptAt(row.updated_at, row.failure_count, options)
      if (Date.parse(nextAttemptAt) > nowMs) return []
      const alternateMessages = JSON.parse(row.alternate_messages_json) as GenerationFinalizationMessage[]
      const mutations = parseGenerationFinalizationMutations(row.chat_var_mutations_json)
      const legacySnapshotMissing =
        (row.mode === 'continue' || row.mode === 'regenerate') && row.target_snapshot_json === null
      return {
        attempt: {
          generationId: row.generation_id,
          ...(row.database_lineage !== null ? { databaseLineage: row.database_lineage } : {}),
          ...(row.operation_id !== null ? { operationId: row.operation_id } : {}),
          ...(row.operation_attempt_no !== null ? { operationAttemptNo: row.operation_attempt_no } : {}),
          ...(row.actor_writer_session_id !== null ? { actorWriterSessionId: row.actor_writer_session_id } : {}),
          ...(row.actor_writer_epoch !== null ? { actorWriterEpoch: row.actor_writer_epoch } : {}),
          ...(row.accepted_message_id !== null ? { acceptedMessageId: row.accepted_message_id } : {}),
          ...(row.terminal_outcome !== null ? { terminalOutcome: row.terminal_outcome } : {}),
          chatId: row.chat_id,
          mode: row.mode,
          ...(row.target_message_id !== null ? { targetMessageId: row.target_message_id } : {}),
          message: JSON.parse(row.message_json) as GenerationFinalizationMessage,
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
            ? { targetSnapshot: JSON.parse(row.target_snapshot_json) as GenerationFinalizationTargetSnapshot }
            : {}),
        },
        replayability: legacySnapshotMissing ? ('legacy_snapshot_missing' as const) : ('replayable' as const),
        createdAt: row.created_at,
        failureCount: row.failure_count,
        nextAttemptAt,
      }
    })
    .slice(0, boundedLimit)
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

function parseGenerationFinalizationAttempt(row: GenerationFinalizationRetryRow): GenerationFinalizationAttempt {
  const alternateMessages = JSON.parse(row.alternate_messages_json) as GenerationFinalizationMessage[]
  const mutations = parseGenerationFinalizationMutations(row.chat_var_mutations_json)
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
    mode: row.mode,
    ...(row.target_message_id !== null ? { targetMessageId: row.target_message_id } : {}),
    message: JSON.parse(row.message_json) as GenerationFinalizationMessage,
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
      ? { targetSnapshot: JSON.parse(row.target_snapshot_json) as GenerationFinalizationTargetSnapshot }
      : {}),
  }
}

function rowMatchesMessage(row: unknown, message: GenerationFinalizationMessage): boolean {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  const record = row as Record<string, unknown>
  if (record.role !== message.role || record.data !== message.data) return false
  return message.chatId === undefined || record.chatId === message.chatId
}

function finalizationAlreadyCommitted(
  rows: readonly GenerationFinalizationMessage[],
  attempt: GenerationFinalizationAttempt,
): boolean {
  const snapshot = attempt.targetSnapshot
  if (!snapshot) {
    return rows.some(
      (row) =>
        row.generationInfo?.generationId === attempt.generationId ||
        (attempt.message.chatId !== undefined &&
          row.chatId === attempt.message.chatId &&
          rowMatchesMessage(row, attempt.message)),
    )
  }
  if (snapshot.kind === 'target-tail') {
    return (
      rows.length >= snapshot.transcriptLength &&
      rowMatchesMessage(rows[snapshot.transcriptLength - 1], attempt.message)
    )
  }
  return rows.length > snapshot.transcriptLength
    ? rowMatchesMessage(rows[snapshot.transcriptLength], attempt.message)
    : false
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
    const attempt = parseGenerationFinalizationAttempt(row)
    if (!finalizationAlreadyCommitted(rows, attempt)) {
      return { generationId: attempt.generationId }
    }
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
export function listGenerationFinalizationRetryProjections(db: DatabaseSync): GenerationFinalizationRetryProjection[] {
  const rowsByChat = new Map<string, GenerationFinalizationMessage[]>()
  return listGenerationFinalizationRetryRows(db).map((row) => {
    const attempt = parseGenerationFinalizationAttempt(row)
    let chatRows = rowsByChat.get(attempt.chatId)
    if (!chatRows) {
      chatRows = getChatMessages(db, attempt.chatId) as unknown as GenerationFinalizationMessage[]
      rowsByChat.set(attempt.chatId, chatRows)
    }
    const committed = finalizationAlreadyCommitted(chatRows, attempt)
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
