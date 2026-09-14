import type { DatabaseSync } from 'node:sqlite'
import { getDatabaseOwnershipSnapshot } from './databaseLineage.js'

export const CHAT_ONLY_GENERATION_SCOPE_VERSION = 1 as const

export const CHAT_ONLY_GENERATION_ALLOWLIST = [
  'accepted_user_message',
  'assistant_result',
  'cancelled_partial_result',
  'reroll_alternate_selection',
  'message_id_repair',
  'chat_transcript_injection',
  'chat_script_variables',
  'chat_last_memory',
  'chat_memory_rows',
  'chat_memory_jobs',
  'generated_message_igp',
  'generated_message_translation',
] as const

export type ChatOnlyGenerationPermission = (typeof CHAT_ONLY_GENERATION_ALLOWLIST)[number]
export type GenerationAdmissionKind = 'legacy_owner' | 'owner_occupancy' | 'chat_only'

export interface PersistedGenerationScope {
  admissionKind: GenerationAdmissionKind
  occupancyDatabaseLineage?: string
  occupancySessionId?: string
  occupancyEpoch?: number
  occupancyClaimClass?: 'owner' | 'chat_only'
  permissionScopeVersion?: 1
  permissionScope?: readonly ChatOnlyGenerationPermission[]
}

export interface GenerationScopeColumns {
  admission_kind?: GenerationAdmissionKind | null
  occupancy_database_lineage?: string | null
  occupancy_session_id?: string | null
  occupancy_epoch?: number | null
  occupancy_claim_class?: 'owner' | 'chat_only' | null
  permission_scope_version?: number | null
  permission_scope_json?: string | null
}

interface OccupancyRow {
  chat_id: string
  database_lineage: string
  occupant_session_id: string | null
  occupancy_epoch: number
  claim_class: 'owner' | 'chat_only' | null
  lease_expires_at_ms: number | null
}

export class GenerationAdmissionError extends Error {
  constructor(
    readonly statusCode: 409 | 423 | 426,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code)
    this.name = 'GenerationAdmissionError'
  }
}

export interface AdmitGenerationInput {
  databaseLineage: string
  chatId: string
  sessionId: string
  occupancyProtocolVersion?: number
  occupancyEpoch?: number
  interaction: 'send' | 'reroll' | 'continue' | 'regenerate'
  chatOnlyEnabled: boolean
  nowMs?: number
}

/**
 * Resolve generation admission while the caller owns the SQLite write
 * transaction. Protocol-v1 authority is the exact durable occupancy tuple;
 * compatibility authority remains the current general owner and never crosses
 * a foreign occupancy or a recovery pin.
 */
export function admitGenerationInTransaction(db: DatabaseSync, input: AdmitGenerationInput): PersistedGenerationScope {
  const ownership = getDatabaseOwnershipSnapshot(db)
  if (ownership.databaseLineage !== input.databaseLineage) {
    throw new GenerationAdmissionError(409, 'database_lineage_conflict', {
      databaseLineage: ownership.databaseLineage,
    })
  }
  const occupancy = readOccupancy(db, input.chatId, ownership.databaseLineage)
  const now = input.nowMs ?? Date.now()
  const requestedProtocol = input.occupancyProtocolVersion !== undefined || input.occupancyEpoch !== undefined

  if (!requestedProtocol) {
    if (ownership.writer.sessionId !== null && ownership.writer.sessionId !== input.sessionId) {
      throw new GenerationAdmissionError(423, 'active_writer_stale', {
        reason: 'Compatibility generation requires the active general owner.',
      })
    }
    assertNoForeignOccupancyOrPins(db, input.chatId, input.sessionId, occupancy, now)
    return { admissionKind: 'legacy_owner' }
  }

  if (input.occupancyProtocolVersion !== 1 || !input.chatOnlyEnabled) {
    throw new GenerationAdmissionError(426, 'chat_occupancy_protocol_required', {
      supportedVersion: 1,
      enabled: input.chatOnlyEnabled,
    })
  }
  if (!Number.isSafeInteger(input.occupancyEpoch) || input.occupancyEpoch! < 1) {
    throw new GenerationAdmissionError(409, 'chat_occupancy_stale')
  }
  if (
    !occupancy ||
    occupancy.database_lineage !== input.databaseLineage ||
    occupancy.occupant_session_id !== input.sessionId ||
    occupancy.occupancy_epoch !== input.occupancyEpoch ||
    occupancy.claim_class === null ||
    occupancy.lease_expires_at_ms === null ||
    occupancy.lease_expires_at_ms <= now
  ) {
    throw new GenerationAdmissionError(409, 'chat_occupancy_stale', {
      chatId: input.chatId,
      currentOccupancyEpoch: occupancy?.occupancy_epoch,
    })
  }

  const isCurrentOwner = ownership.writer.sessionId === input.sessionId
  if (occupancy.claim_class === 'owner' && !isCurrentOwner) {
    throw normalizationRequired(input.chatId)
  }
  if (!isCurrentOwner) {
    const sessionRows = readSessionOccupancies(db, input.sessionId, ownership.databaseLineage)
    if (
      sessionRows.length !== 1 ||
      sessionRows[0]?.chat_id !== input.chatId ||
      sessionRows[0].claim_class !== 'chat_only'
    ) {
      throw normalizationRequired(input.chatId)
    }
  }

  const admissionKind: GenerationAdmissionKind = occupancy.claim_class === 'chat_only' ? 'chat_only' : 'owner_occupancy'
  if (admissionKind === 'chat_only' && input.interaction !== 'send' && input.interaction !== 'reroll') {
    throw new GenerationAdmissionError(409, 'chat_only_interaction_unsupported', {
      interaction: input.interaction,
    })
  }
  return {
    admissionKind,
    occupancyDatabaseLineage: occupancy.database_lineage,
    occupancySessionId: occupancy.occupant_session_id,
    occupancyEpoch: occupancy.occupancy_epoch,
    occupancyClaimClass: occupancy.claim_class,
    permissionScopeVersion: CHAT_ONLY_GENERATION_SCOPE_VERSION,
    permissionScope: [...CHAT_ONLY_GENERATION_ALLOWLIST],
  }
}

/** Revalidate persisted authority immediately before an asynchronous write. */
export function assertPersistedGenerationScopeInTransaction(
  db: DatabaseSync,
  input: PersistedGenerationScope & { databaseLineage: string; chatId: string; sessionId: string },
): void {
  const ownership = getDatabaseOwnershipSnapshot(db)
  if (ownership.databaseLineage !== input.databaseLineage) {
    throw new GenerationAdmissionError(409, 'database_lineage_conflict', {
      databaseLineage: ownership.databaseLineage,
    })
  }
  if (input.admissionKind === 'legacy_owner') {
    // Compatibility work that was already accepted has no occupancy tuple to
    // revalidate. Its immutable authority is the persisted database/chat/
    // operation lineage; requiring the current owner here would discard a
    // legitimate result after an owner handoff. Interactive control routes do
    // a fresh compatibility admission instead.
    return
  }
  if (
    input.occupancyDatabaseLineage !== input.databaseLineage ||
    input.occupancySessionId !== input.sessionId ||
    !Number.isSafeInteger(input.occupancyEpoch) ||
    (input.occupancyClaimClass !== 'owner' && input.occupancyClaimClass !== 'chat_only') ||
    (input.admissionKind === 'owner_occupancy' && input.occupancyClaimClass !== 'owner') ||
    (input.admissionKind === 'chat_only' && input.occupancyClaimClass !== 'chat_only') ||
    input.permissionScopeVersion !== CHAT_ONLY_GENERATION_SCOPE_VERSION ||
    !scopeEqualsV1(input.permissionScope)
  ) {
    throw new GenerationAdmissionError(409, 'generation_scope_invalid')
  }
  const occupancy = readOccupancy(db, input.chatId, ownership.databaseLineage)
  if (
    !occupancy ||
    occupancy.database_lineage !== input.occupancyDatabaseLineage ||
    occupancy.occupant_session_id !== input.occupancySessionId ||
    occupancy.occupancy_epoch !== input.occupancyEpoch
  ) {
    throw new GenerationAdmissionError(409, 'chat_occupancy_stale', { chatId: input.chatId })
  }
}

export function scopeFromColumns(row: GenerationScopeColumns): PersistedGenerationScope | undefined {
  if (row.admission_kind == null) return undefined
  if (row.admission_kind === 'legacy_owner') return { admissionKind: 'legacy_owner' }
  const permissionScope =
    row.permission_scope_json == null ? undefined : parsePermissionScope(row.permission_scope_json)
  return {
    admissionKind: row.admission_kind,
    ...(row.occupancy_database_lineage != null ? { occupancyDatabaseLineage: row.occupancy_database_lineage } : {}),
    ...(row.occupancy_session_id != null ? { occupancySessionId: row.occupancy_session_id } : {}),
    ...(row.occupancy_epoch != null ? { occupancyEpoch: row.occupancy_epoch } : {}),
    ...(row.occupancy_claim_class != null ? { occupancyClaimClass: row.occupancy_claim_class } : {}),
    ...(row.permission_scope_version === CHAT_ONLY_GENERATION_SCOPE_VERSION
      ? { permissionScopeVersion: CHAT_ONLY_GENERATION_SCOPE_VERSION }
      : {}),
    ...(permissionScope ? { permissionScope } : {}),
  }
}

export function scopeSqlValues(scope: PersistedGenerationScope | undefined): readonly (string | number | null)[] {
  if (!scope) return [null, null, null, null, null, null, null]
  return [
    scope.admissionKind,
    scope.occupancyDatabaseLineage ?? null,
    scope.occupancySessionId ?? null,
    scope.occupancyEpoch ?? null,
    scope.occupancyClaimClass ?? null,
    scope.permissionScopeVersion ?? null,
    scope.permissionScope ? JSON.stringify(scope.permissionScope) : null,
  ]
}

export function generationScopeIsChatOnly(scope: PersistedGenerationScope | undefined): boolean {
  return scope?.admissionKind === 'chat_only'
}

export function listGenerationOccupancyPins(db: DatabaseSync, chatId: string): Array<{ id: string; kind: string }> {
  const pins: Array<{ id: string; kind: string }> = []
  const databaseLineage = getDatabaseOwnershipSnapshot(db).databaseLineage
  const collect = (sql: string, params: readonly string[], kind: string): void => {
    for (const row of db.prepare(sql).all(...params) as Array<{ id: string }>) pins.push({ id: row.id, kind })
  }
  collect(
    `SELECT operation_id AS id FROM generation_operations
     WHERE chat_id = ? AND database_lineage = ?
       AND state NOT IN ('completed', 'cancelled', 'terminal_failed', 'invalidated')`,
    [chatId, databaseLineage],
    'generation_operation',
  )
  collect(
    `SELECT generation_id AS id FROM generation_finalization_retries
     WHERE chat_id = ? AND (database_lineage = ? OR database_lineage IS NULL) AND status = 'pending'`,
    [chatId, databaseLineage],
    'generation_finalization',
  )
  collect(
    `SELECT generation_id || ':' || effect_kind AS id FROM generation_effects
     WHERE chat_id = ? AND database_lineage = ?
       AND effect_kind IN ('igp', 'generated_translation') AND status IN ('pending', 'claimed')`,
    [chatId, databaseLineage],
    'generation_effect',
  )
  collect(
    `SELECT job.id FROM memory_jobs AS job
     WHERE job.chat_id = ? AND job.status IN ('pending', 'running')
       AND (job.operation_id IS NULL OR EXISTS (
         SELECT 1 FROM generation_operations AS operation
         WHERE operation.database_lineage = ? AND operation.operation_id = job.operation_id
       ))`,
    [chatId, databaseLineage],
    'memory_job',
  )
  collect(
    `SELECT job.id FROM bardwiki_jobs AS job
     WHERE job.chat_id = ? AND job.status IN ('pending', 'running')
       AND (job.operation_id IS NULL OR EXISTS (
         SELECT 1 FROM generation_operations AS operation
         WHERE operation.database_lineage = ? AND operation.operation_id = job.operation_id
       ))`,
    [chatId, databaseLineage],
    'bardwiki_job',
  )
  return pins
}

function readOccupancy(db: DatabaseSync, chatId: string, databaseLineage: string): OccupancyRow | undefined {
  return db
    .prepare(
      `SELECT chat_id, database_lineage, occupant_session_id, occupancy_epoch, claim_class, lease_expires_at_ms
       FROM chat_occupancies WHERE chat_id = ? AND database_lineage = ?`,
    )
    .get(chatId, databaseLineage) as unknown as OccupancyRow | undefined
}

function readSessionOccupancies(db: DatabaseSync, sessionId: string, databaseLineage: string): OccupancyRow[] {
  return db
    .prepare(
      `SELECT chat_id, database_lineage, occupant_session_id, occupancy_epoch, claim_class, lease_expires_at_ms
       FROM chat_occupancies
       WHERE occupant_session_id = ? AND database_lineage = ?
       ORDER BY chat_id`,
    )
    .all(sessionId, databaseLineage) as unknown as OccupancyRow[]
}

function normalizationRequired(chatId: string): GenerationAdmissionError {
  return new GenerationAdmissionError(409, 'chat_occupancy_normalization_required', {
    chatId,
    reason:
      'This demoted session must atomically normalize its complete occupancy set before admitting fresh conversational work.',
  })
}

function assertNoForeignOccupancyOrPins(
  db: DatabaseSync,
  chatId: string,
  sessionId: string,
  occupancy: OccupancyRow | undefined,
  now: number,
): void {
  if (!occupancy?.occupant_session_id || occupancy.occupant_session_id === sessionId) return
  if (occupancy.lease_expires_at_ms !== null && occupancy.lease_expires_at_ms > now) {
    throw new GenerationAdmissionError(423, 'chat_occupied', {
      chatId,
      safeRelease:
        'Use the current occupant session and exact lineage/chat/epoch tuple to release this chat; stale or foreign release is not permitted.',
    })
  }
  const pins = listGenerationOccupancyPins(db, chatId)
  if (pins.length > 0) {
    throw new GenerationAdmissionError(409, 'chat_occupancy_recovery_blocked', { chatId, blocking: pins })
  }
}

function parsePermissionScope(value: string): readonly ChatOnlyGenerationPermission[] | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return scopeEqualsV1(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function scopeEqualsV1(value: unknown): value is readonly ChatOnlyGenerationPermission[] {
  return (
    Array.isArray(value) &&
    value.length === CHAT_ONLY_GENERATION_ALLOWLIST.length &&
    value.every((entry, index) => entry === CHAT_ONLY_GENERATION_ALLOWLIST[index])
  )
}
