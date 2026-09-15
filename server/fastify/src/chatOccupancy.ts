import {
  CHAT_OCCUPANCY_LEASE_MS,
  CHAT_OCCUPANCY_PROTOCOL_VERSION,
  type ChatOccupancyClaimClass,
  type ChatOccupancyEvent,
  type ChatOccupancyProjection,
  type ChatOccupancySnapshot,
} from '@risuai/protocol/chat-occupancy'
import type { DatabaseSync } from 'node:sqlite'
import { getDatabaseOwnershipSnapshot } from './databaseLineage.js'

export interface ChatOccupancyPin {
  id: string
  kind: string
}

export type ChatOccupancyPinQuery = (db: DatabaseSync, chatId: string) => readonly ChatOccupancyPin[]

export interface ExpiredChatOccupancyRecoveryInput {
  databaseLineage: string
  chatId: string
  occupantSessionId: string
  occupancyEpoch: number
  nowMs: number
}

export type ExpiredChatOccupancyReconciler = (db: DatabaseSync, input: ExpiredChatOccupancyRecoveryInput) => void

export interface ChatOccupancyServiceOptions {
  now?: () => number
  pinQuery?: ChatOccupancyPinQuery
  reconcileExpiredOccupancy?: ExpiredChatOccupancyReconciler
}

export type ChatOccupancyEventListener = (event: ChatOccupancyEvent) => void

export interface ChatOccupancyEventSource {
  eventSnapshot(): ChatOccupancyEvent
  subscribe(listener: ChatOccupancyEventListener): () => void
}

export interface ChatOccupancyMutationGuardOptions extends ChatOccupancyServiceOptions {}

export interface ChatOccupancyMutationConflict {
  chatId: string
  occupancy: ChatOccupancyProjection | null
  blocking: readonly ChatOccupancyPin[]
}

export interface ChatOccupancyMutationGuardInput {
  chatIds: readonly string[]
  /**
   * The authenticated page session performing a normal chat-local owner
   * mutation. Its own active occupancy is allowed; omit this for destructive
   * operations that must reject every occupancy in the affected scope.
   */
  allowedSessionId?: string
  /** Durable pins matter for destructive/handoff-sensitive scopes. */
  includePins?: boolean
}

export interface ForeignOccupiedChatStateSnapshot {
  readonly actorSessionId: string | null
  readonly rows: ReadonlyArray<{ chatId: string; state: string }>
}

export type ChatOccupancyErrorCode =
  | 'active_writer_stale'
  | 'chat_occupied'
  | 'chat_occupancy_stale'
  | 'chat_occupancy_switch_required'
  | 'chat_occupancy_recovery_blocked'
  | 'chat_not_found'

export class ChatOccupancyError extends Error {
  constructor(
    readonly code: ChatOccupancyErrorCode,
    readonly statusCode: 404 | 409 | 423,
    readonly details: Record<string, unknown>,
  ) {
    super(code)
    this.name = 'ChatOccupancyError'
  }
}

interface OccupancyRow {
  chat_id: string
  database_lineage: string
  occupant_session_id: string | null
  occupancy_epoch: number
  claim_class: ChatOccupancyClaimClass | null
  claimed_at_ms: number | null
  lease_expires_at_ms: number | null
  updated_at_ms: number
  released_at_ms: number | null
}

interface BlockingOccupancyPin extends ChatOccupancyPin {
  chatId: string
}

export interface OccupancyTupleInput {
  databaseLineage: string
  chatId: string
  sessionId: string
  occupancyEpoch: number
}

export interface ClaimOccupancyInput {
  databaseLineage: string
  chatId: string
  sessionId: string
  claimClass: ChatOccupancyClaimClass
  expectedOccupancyEpoch: number
}

export interface SwitchOccupancyInput extends OccupancyTupleInput {
  targetChatId: string
}

export interface NormalizeOccupancyInput extends OccupancyTupleInput {}

/**
 * Resolve every persisted chat that owns an active message id. Callers use the
 * complete result instead of trusting a route/body chat id. Keeping this helper
 * transaction-free lets command and operation publication paths invoke it
 * inside their existing `BEGIN IMMEDIATE` transaction.
 */
export function resolveMessageChatIdsInTransaction(db: DatabaseSync, messageId: string): string[] {
  validateId(messageId, 'messageId', 512)
  return (
    db
      .prepare('SELECT DISTINCT chat_id FROM messages WHERE uid = ? AND alternate = 0 ORDER BY chat_id')
      .all(messageId) as unknown as Array<{ chat_id: string }>
  ).map((row) => row.chat_id)
}

/**
 * Return active-occupancy and durable-pin conflicts for an already-resolved
 * affected chat set. This helper deliberately does not begin or commit a
 * transaction: authority-sensitive callers must execute it in their own
 * publication transaction, after any asynchronous staging has completed.
 */
export function listChatOccupancyMutationConflictsInTransaction(
  db: DatabaseSync,
  input: ChatOccupancyMutationGuardInput,
  options: ChatOccupancyMutationGuardOptions = {},
): ChatOccupancyMutationConflict[] {
  const chatIds = normalizeChatIds(input.chatIds)
  if (input.allowedSessionId !== undefined) validateId(input.allowedSessionId, 'allowedSessionId', 128)
  const now = readGuardNow(options.now)
  const lineage = getDatabaseOwnershipSnapshot(db).databaseLineage
  const pinQuery = options.pinQuery ?? (() => [])
  const readOccupancy = sqliteTableExists(db, 'chat_occupancies')
    ? db.prepare('SELECT * FROM chat_occupancies WHERE chat_id = ? AND database_lineage = ?')
    : undefined

  return chatIds.flatMap((chatId): ChatOccupancyMutationConflict[] => {
    const row = readOccupancy?.get(chatId, lineage) as unknown as OccupancyRow | undefined
    const activeForeignOccupancy =
      row &&
      isUnexpired(row, now) &&
      (input.allowedSessionId === undefined || row.occupant_session_id !== input.allowedSessionId)
        ? projectRow(row, now)
        : null
    const expiredForeignOccupancy =
      row !== undefined &&
      row.occupant_session_id !== null &&
      !isUnexpired(row, now) &&
      (input.allowedSessionId === undefined || row.occupant_session_id !== input.allowedSessionId)
    const blocking =
      input.includePins === false && !expiredForeignOccupancy
        ? []
        : pinQuery(db, chatId).map((pin) => ({ id: pin.id, kind: pin.kind }))
    if (!activeForeignOccupancy && blocking.length === 0) return []
    return [{ chatId, occupancy: activeForeignOccupancy, blocking }]
  })
}

/**
 * Fail an owner/direct mutation when its authoritative target is occupied by a
 * different page session. The actor's own active occupancy remains writable.
 */
export function assertChatMutationAllowedInTransaction(
  db: DatabaseSync,
  chatId: string,
  actorSessionId: string,
  options: ChatOccupancyMutationGuardOptions = {},
): void {
  assertChatsAvailableForMutationInTransaction(
    db,
    { chatIds: [chatId], allowedSessionId: actorSessionId, includePins: false },
    options,
  )
}

/**
 * Fail a destructive or multi-chat mutation atomically when any authoritative
 * affected chat is occupied or pinned. Every conflicting id is returned so the
 * user can resolve the complete scope before retrying.
 */
export function assertChatsUnoccupiedInTransaction(
  db: DatabaseSync,
  chatIds: readonly string[],
  options: ChatOccupancyMutationGuardOptions = {},
): void {
  assertChatsAvailableForMutationInTransaction(db, { chatIds }, options)
}

/**
 * Guard whole-database publication while the old live graph and occupancy rows
 * are still visible in the caller's transaction.
 */
export function assertDatabaseReplacementAllowedInTransaction(
  db: DatabaseSync,
  options: ChatOccupancyMutationGuardOptions = {},
): void {
  const lineage = getDatabaseOwnershipSnapshot(db).databaseLineage
  const liveChatIds = sqliteTableExists(db, 'chats')
    ? ((db.prepare('SELECT id AS chat_id FROM chats').all() as unknown as Array<{ chat_id: string }>).map(
        (row) => row.chat_id,
      ) as string[])
    : []
  const occupancyChatIds = sqliteTableExists(db, 'chat_occupancies')
    ? ((
        db.prepare('SELECT chat_id FROM chat_occupancies WHERE database_lineage = ?').all(lineage) as unknown as Array<{
          chat_id: string
        }>
      ).map((row) => row.chat_id) as string[])
    : []
  const chatIds = [...new Set([...liveChatIds, ...occupancyChatIds])]
  assertChatsUnoccupiedInTransaction(db, chatIds, options)
}

export function assertChatsAvailableForMutationInTransaction(
  db: DatabaseSync,
  input: ChatOccupancyMutationGuardInput,
  options: ChatOccupancyMutationGuardOptions = {},
): void {
  const conflicts = listChatOccupancyMutationConflictsInTransaction(db, input, options)
  if (conflicts.length === 0) return
  const conflictingChatIds = conflicts.map((conflict) => conflict.chatId)
  throw new ChatOccupancyError('chat_occupied', 423, {
    chatId: conflictingChatIds[0],
    conflictingChatIds,
    conflicts,
    reason: 'Stop and reconcile any accepted work, then release every conflicting chat occupancy before retrying.',
    safeRelease:
      'Use the current occupant session and exact lineage/chat/epoch tuple to release each chat; stale or foreign release is not permitted.',
  })
}

/** Capture the logical chat rows protected from a legacy/general-owner write. */
export function captureForeignOccupiedChatStateInTransaction(
  db: DatabaseSync,
  actorSessionId: string | null,
  options: Pick<ChatOccupancyMutationGuardOptions, 'now' | 'pinQuery'> = {},
): ForeignOccupiedChatStateSnapshot {
  if (actorSessionId !== null) validateId(actorSessionId, 'actorSessionId', 128)
  const now = readGuardNow(options.now)
  if (!sqliteTableExists(db, 'chat_occupancies')) return { actorSessionId, rows: [] }
  const lineage = getDatabaseOwnershipSnapshot(db).databaseLineage
  const candidates = (actorSessionId === null
    ? db
        .prepare(
          `
        SELECT chat_id, lease_expires_at_ms
        FROM chat_occupancies
        WHERE database_lineage = ?
          AND occupant_session_id IS NOT NULL
        ORDER BY chat_id
      `,
        )
        .all(lineage)
    : db
        .prepare(
          `
        SELECT chat_id, lease_expires_at_ms
        FROM chat_occupancies
        WHERE database_lineage = ?
          AND occupant_session_id IS NOT NULL
          AND occupant_session_id <> ?
        ORDER BY chat_id
      `,
        )
        .all(lineage, actorSessionId)) as unknown as Array<{ chat_id: string; lease_expires_at_ms: number | null }>
  const pinQuery = options.pinQuery ?? (() => [])
  const rows = candidates.filter(
    (row) =>
      (row.lease_expires_at_ms !== null && row.lease_expires_at_ms > now) || pinQuery(db, row.chat_id).length > 0,
  )
  return {
    actorSessionId,
    rows: rows.map(({ chat_id: chatId }) => ({ chatId, state: readLogicalChatState(db, chatId) })),
  }
}

/**
 * Assert that a broad/indirect command preserved every foreign-occupied chat
 * byte-for-byte. Invoke immediately before revision/event publication.
 */
export function assertForeignOccupiedChatStatePreservedInTransaction(
  db: DatabaseSync,
  snapshot: ForeignOccupiedChatStateSnapshot,
  options: ChatOccupancyMutationGuardOptions = {},
): void {
  const changedChatIds = snapshot.rows
    .filter(({ chatId, state }) => readLogicalChatState(db, chatId) !== state)
    .map(({ chatId }) => chatId)
  if (changedChatIds.length === 0) return
  assertChatsAvailableForMutationInTransaction(
    db,
    {
      chatIds: changedChatIds,
      ...(snapshot.actorSessionId === null ? {} : { allowedSessionId: snapshot.actorSessionId }),
      includePins: false,
    },
    options,
  )
}

export function createChatOccupancyTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_occupancies (
      chat_id TEXT PRIMARY KEY,
      database_lineage TEXT NOT NULL,
      occupant_session_id TEXT,
      occupancy_epoch INTEGER NOT NULL CHECK (occupancy_epoch >= 0 AND occupancy_epoch <= 9007199254740991),
      claim_class TEXT CHECK (claim_class IS NULL OR claim_class IN ('owner', 'chat_only')),
      claimed_at_ms INTEGER CHECK (claimed_at_ms IS NULL OR claimed_at_ms >= 0),
      lease_expires_at_ms INTEGER CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      released_at_ms INTEGER CHECK (released_at_ms IS NULL OR released_at_ms >= 0),
      CHECK (
        (occupant_session_id IS NOT NULL AND claim_class IS NOT NULL AND claimed_at_ms IS NOT NULL
          AND lease_expires_at_ms IS NOT NULL AND released_at_ms IS NULL)
        OR
        (occupant_session_id IS NULL AND claim_class IS NULL AND claimed_at_ms IS NULL
          AND lease_expires_at_ms IS NULL AND released_at_ms IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_occupancies_chat_only_session
      ON chat_occupancies (occupant_session_id)
      WHERE occupant_session_id IS NOT NULL AND claim_class = 'chat_only';
    CREATE INDEX IF NOT EXISTS idx_chat_occupancies_session
      ON chat_occupancies (occupant_session_id);
    CREATE INDEX IF NOT EXISTS idx_chat_occupancies_lease
      ON chat_occupancies (lease_expires_at_ms)
      WHERE occupant_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_occupancies_lineage
      ON chat_occupancies (database_lineage);
  `)
}

export class ChatOccupancyService {
  readonly #now: () => number
  readonly #pinQuery: ChatOccupancyPinQuery
  readonly #reconcileExpiredOccupancy: ExpiredChatOccupancyReconciler
  readonly #eventListeners = new Set<ChatOccupancyEventListener>()

  constructor(
    readonly db: DatabaseSync,
    options: ChatOccupancyServiceOptions = {},
  ) {
    this.#now = options.now ?? Date.now
    this.#pinQuery = options.pinQuery ?? (() => [])
    this.#reconcileExpiredOccupancy = options.reconcileExpiredOccupancy ?? (() => undefined)
  }

  snapshot(): ChatOccupancySnapshot {
    const now = this.#readNow()
    const lineage = getDatabaseOwnershipSnapshot(this.db).databaseLineage
    const occupancies = this.#snapshotRows(lineage, now)
    return {
      version: CHAT_OCCUPANCY_PROTOCOL_VERSION,
      databaseLineage: lineage,
      occupancies,
    }
  }

  eventSnapshot(): ChatOccupancyEvent {
    const now = this.#readNow()
    const databaseLineage = getDatabaseOwnershipSnapshot(this.db).databaseLineage
    return {
      type: 'occupancy.snapshot',
      version: CHAT_OCCUPANCY_PROTOCOL_VERSION,
      databaseLineage,
      occupancies: this.#snapshotRows(databaseLineage, now),
    }
  }

  subscribe(listener: ChatOccupancyEventListener): () => void {
    this.#eventListeners.add(listener)
    return () => {
      this.#eventListeners.delete(listener)
    }
  }

  claim(input: ClaimOccupancyInput): ChatOccupancyProjection {
    validateClaimInput(input)
    const projection = this.#transaction(() => {
      const now = this.#readNow()
      const ownership = this.#assertLineage(input.databaseLineage)
      this.#purgeStaleLineageRows(ownership.databaseLineage)
      this.#assertChatExists(input.chatId)
      this.#assertClaimClassAllowed(input.claimClass, input.sessionId, ownership.writer.sessionId)

      const target = this.#row(input.chatId, ownership.databaseLineage)
      if ((target?.occupancy_epoch ?? 0) !== input.expectedOccupancyEpoch) {
        throw this.#stale(input.chatId, ownership.databaseLineage, now)
      }
      if (target?.occupant_session_id === input.sessionId && isUnexpired(target, now)) {
        if (target.claim_class === 'owner' && input.claimClass === 'chat_only') {
          throw this.#switchRequired([target], input.chatId, now)
        }
        if (input.claimClass === 'chat_only') {
          const otherRows = this.#sessionRows(input.sessionId, ownership.databaseLineage).filter(
            (row) => row.chat_id !== input.chatId,
          )
          if (otherRows.length > 0) throw this.#switchRequired(otherRows, input.chatId, now)
        }
        this.db
          .prepare(
            'UPDATE chat_occupancies SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE chat_id = ? AND database_lineage = ?',
          )
          .run(now + CHAT_OCCUPANCY_LEASE_MS, now, input.chatId, ownership.databaseLineage)
        return projectRow(this.#requiredRow(input.chatId, ownership.databaseLineage), now)
      }

      this.#assertTargetAvailable(input.chatId, target, input.sessionId, now)
      if (input.claimClass === 'chat_only') {
        this.#prepareChatOnlyAdmission(input.sessionId, input.chatId, ownership.databaseLineage, now)
      }

      const nextEpoch = (target?.occupancy_epoch ?? 0) + 1
      this.db
        .prepare(
          `
            INSERT INTO chat_occupancies (
              chat_id, database_lineage, occupant_session_id, occupancy_epoch, claim_class,
              claimed_at_ms, lease_expires_at_ms, updated_at_ms, released_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(chat_id) DO UPDATE SET
              database_lineage = excluded.database_lineage,
              occupant_session_id = excluded.occupant_session_id,
              occupancy_epoch = excluded.occupancy_epoch,
              claim_class = excluded.claim_class,
              claimed_at_ms = excluded.claimed_at_ms,
              lease_expires_at_ms = excluded.lease_expires_at_ms,
              updated_at_ms = excluded.updated_at_ms,
              released_at_ms = NULL
          `,
        )
        .run(
          input.chatId,
          input.databaseLineage,
          input.sessionId,
          nextEpoch,
          input.claimClass,
          now,
          now + CHAT_OCCUPANCY_LEASE_MS,
          now,
        )
      return projectRow(this.#requiredRow(input.chatId, ownership.databaseLineage), now)
    })
    this.#publishEventSnapshot()
    return projection
  }

  renew(input: OccupancyTupleInput): ChatOccupancyProjection {
    validateTupleInput(input)
    const projection = this.#transaction(() => {
      const now = this.#readNow()
      const ownership = this.#assertLineage(input.databaseLineage)
      this.#purgeStaleLineageRows(ownership.databaseLineage)
      const row = this.#assertExactTuple(input, now)
      if (!isUnexpired(row, now)) throw this.#stale(input.chatId, input.databaseLineage, now)
      this.db
        .prepare(
          'UPDATE chat_occupancies SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE chat_id = ? AND database_lineage = ?',
        )
        .run(now + CHAT_OCCUPANCY_LEASE_MS, now, input.chatId, input.databaseLineage)
      return projectRow(this.#requiredRow(input.chatId, input.databaseLineage), now)
    })
    this.#publishEventSnapshot()
    return projection
  }

  release(input: OccupancyTupleInput): ChatOccupancyProjection {
    validateTupleInput(input)
    const projection = this.#transaction(() => {
      const now = this.#readNow()
      const ownership = this.#assertLineage(input.databaseLineage)
      this.#purgeStaleLineageRows(ownership.databaseLineage)
      const row = this.#assertExactTuple(input, now)
      this.#reconcileExpiredRows([row], now)
      this.#assertExactTuple(input, now)
      this.#assertUnpinned([input.chatId])
      this.#writeTombstone(input.chatId, input.databaseLineage, now)
      return projectRow(this.#requiredRow(input.chatId, input.databaseLineage), now)
    })
    this.#publishEventSnapshot()
    return projection
  }

  switch(input: SwitchOccupancyInput): ChatOccupancyProjection {
    validateTupleInput(input)
    validateId(input.targetChatId, 'targetChatId', 512)
    const projection = this.#transaction(() => {
      const now = this.#readNow()
      const ownership = this.#assertLineage(input.databaseLineage)
      this.#purgeStaleLineageRows(ownership.databaseLineage)
      const source = this.#assertExactTuple(input, now)
      if (!isUnexpired(source, now)) throw this.#stale(input.chatId, input.databaseLineage, now)
      if (input.targetChatId === input.chatId) {
        this.db
          .prepare(
            'UPDATE chat_occupancies SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE chat_id = ? AND database_lineage = ?',
          )
          .run(now + CHAT_OCCUPANCY_LEASE_MS, now, input.chatId, input.databaseLineage)
        return projectRow(this.#requiredRow(input.chatId, input.databaseLineage), now)
      }
      this.#assertChatExists(input.targetChatId)
      if (source.claim_class === 'owner') {
        this.#assertClaimClassAllowed('owner', input.sessionId, ownership.writer.sessionId)
      } else if (ownership.writer.sessionId !== input.sessionId) {
        const otherRows = this.#sessionRows(input.sessionId, input.databaseLineage).filter(
          (row) => row.chat_id !== input.chatId,
        )
        if (otherRows.length > 0) throw this.#switchRequired(otherRows, input.targetChatId, now)
      }
      const target = this.#row(input.targetChatId, input.databaseLineage)
      this.#assertTargetAvailable(input.targetChatId, target, input.sessionId, now)
      this.#assertUnpinned([input.chatId])

      this.#writeTombstone(input.chatId, input.databaseLineage, now)
      const nextEpoch = (target?.occupancy_epoch ?? 0) + 1
      this.db
        .prepare(
          `
            INSERT INTO chat_occupancies (
              chat_id, database_lineage, occupant_session_id, occupancy_epoch, claim_class,
              claimed_at_ms, lease_expires_at_ms, updated_at_ms, released_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(chat_id) DO UPDATE SET
              database_lineage = excluded.database_lineage,
              occupant_session_id = excluded.occupant_session_id,
              occupancy_epoch = excluded.occupancy_epoch,
              claim_class = excluded.claim_class,
              claimed_at_ms = excluded.claimed_at_ms,
              lease_expires_at_ms = excluded.lease_expires_at_ms,
              updated_at_ms = excluded.updated_at_ms,
              released_at_ms = NULL
          `,
        )
        .run(
          input.targetChatId,
          input.databaseLineage,
          input.sessionId,
          nextEpoch,
          source.claim_class,
          now,
          now + CHAT_OCCUPANCY_LEASE_MS,
          now,
        )
      return projectRow(this.#requiredRow(input.targetChatId, input.databaseLineage), now)
    })
    this.#publishEventSnapshot()
    return projection
  }

  normalize(input: NormalizeOccupancyInput): ChatOccupancyProjection {
    validateTupleInput(input)
    const projection = this.#transaction(() => {
      const now = this.#readNow()
      const ownership = this.#assertLineage(input.databaseLineage)
      this.#purgeStaleLineageRows(ownership.databaseLineage)
      if (ownership.writer.sessionId === input.sessionId) {
        throw new ChatOccupancyError('chat_occupancy_stale', 409, {
          reason: 'The active owner cannot normalize its authority as a demoted chat-only session.',
        })
      }
      const selected = this.#assertExactTuple(input, now)
      if (!isUnexpired(selected, now)) throw this.#stale(input.chatId, input.databaseLineage, now)
      let nonselected = this.#sessionRows(input.sessionId, input.databaseLineage).filter(
        (row) => row.chat_id !== input.chatId,
      )
      this.#reconcileExpiredRows(nonselected, now)
      nonselected = this.#sessionRows(input.sessionId, input.databaseLineage).filter(
        (row) => row.chat_id !== input.chatId,
      )
      this.#assertUnpinned(nonselected.map((row) => row.chat_id))

      for (const row of nonselected) this.#writeTombstone(row.chat_id, input.databaseLineage, now)
      if (selected.claim_class === 'chat_only' && nonselected.length === 0) {
        this.db
          .prepare(
            'UPDATE chat_occupancies SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE chat_id = ? AND database_lineage = ?',
          )
          .run(now + CHAT_OCCUPANCY_LEASE_MS, now, input.chatId, input.databaseLineage)
      } else {
        this.db
          .prepare(
            `
              UPDATE chat_occupancies
              SET claim_class = 'chat_only', lease_expires_at_ms = ?, updated_at_ms = ?
              WHERE chat_id = ? AND database_lineage = ?
            `,
          )
          .run(now + CHAT_OCCUPANCY_LEASE_MS, now, input.chatId, input.databaseLineage)
      }
      return projectRow(this.#requiredRow(input.chatId, input.databaseLineage), now)
    })
    this.#publishEventSnapshot()
    return projection
  }

  #snapshotRows(databaseLineage: string, now: number): ChatOccupancyProjection[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_occupancies WHERE database_lineage = ? ORDER BY chat_id')
      .all(databaseLineage) as unknown as OccupancyRow[]
    return rows.map((row) => projectRow(row, now))
  }

  #publishEventSnapshot(): void {
    if (this.#eventListeners.size === 0) return
    let event: ChatOccupancyEvent
    try {
      event = this.eventSnapshot()
    } catch {
      // Snapshot discovery is best effort and may not turn a committed
      // mutation into an apparent failure.
      return
    }
    for (const listener of this.#eventListeners) {
      try {
        listener(event)
      } catch {
        // One broken SSE listener must not block other sessions or turn a
        // committed mutation into an apparent failure. The authenticated
        // snapshot route remains authoritative.
      }
    }
  }

  #prepareChatOnlyAdmission(sessionId: string, targetChatId: string, databaseLineage: string, now: number): void {
    let rows = this.#sessionRows(sessionId, databaseLineage).filter((row) => row.chat_id !== targetChatId)
    if (rows.length === 0) return
    this.#reconcileExpiredRows(rows, now)
    rows = this.#sessionRows(sessionId, databaseLineage).filter((row) => row.chat_id !== targetChatId)
    const pinnedExpired = rows.filter((row) => !isUnexpired(row, now)).flatMap((row) => this.#blockingPins(row.chat_id))
    if (pinnedExpired.length > 0) throw recoveryBlocked(pinnedExpired, targetChatId)
    const retained = rows.filter((row) => isUnexpired(row, now))
    if (retained.length > 0) throw this.#switchRequired(retained, targetChatId, now)
    for (const row of rows) this.#writeTombstone(row.chat_id, databaseLineage, now)
  }

  #reconcileExpiredRows(rows: readonly OccupancyRow[], now: number): void {
    for (const row of rows) {
      if (isUnexpired(row, now) || row.occupant_session_id === null) continue
      this.#reconcileExpiredOccupancy(this.db, {
        databaseLineage: row.database_lineage,
        chatId: row.chat_id,
        occupantSessionId: row.occupant_session_id,
        occupancyEpoch: row.occupancy_epoch,
        nowMs: now,
      })
    }
  }

  #assertTargetAvailable(chatId: string, row: OccupancyRow | undefined, sessionId: string, now: number): void {
    if (row?.occupant_session_id && isUnexpired(row, now)) {
      throw new ChatOccupancyError('chat_occupied', 423, {
        chatId: row.chat_id,
        occupancy: projectRow(row, now),
        reason: 'Stop or release the current occupant before claiming this chat.',
        safeRelease:
          'Use the current occupant session and exact lineage/chat/epoch tuple to release this chat; stale or foreign release is not permitted.',
      })
    }
    if (row?.occupant_session_id && !isUnexpired(row, now)) {
      this.#reconcileExpiredOccupancy(this.db, {
        databaseLineage: row.database_lineage,
        chatId: row.chat_id,
        occupantSessionId: row.occupant_session_id,
        occupancyEpoch: row.occupancy_epoch,
        nowMs: now,
      })
    }
    const pins = this.#blockingPins(chatId)
    if (pins.length > 0) throw recoveryBlocked(pins, chatId)
    if (!row?.occupant_session_id) return
    if (row.occupant_session_id === sessionId) return
  }

  #assertUnpinned(chatIds: readonly string[]): void {
    const pins = chatIds.flatMap((chatId) => this.#blockingPins(chatId))
    if (pins.length > 0) throw recoveryBlocked(pins)
  }

  #pins(chatId: string): ChatOccupancyPin[] {
    return this.#pinQuery(this.db, chatId).map((pin) => ({ id: pin.id, kind: pin.kind }))
  }

  #blockingPins(chatId: string): BlockingOccupancyPin[] {
    return this.#pins(chatId).map((pin) => ({ chatId, ...pin }))
  }

  #assertLineage(requested: string): ReturnType<typeof getDatabaseOwnershipSnapshot> {
    const ownership = getDatabaseOwnershipSnapshot(this.db)
    if (ownership.databaseLineage !== requested) {
      throw new ChatOccupancyError('chat_occupancy_stale', 409, {
        databaseLineage: ownership.databaseLineage,
        current: this.snapshot(),
        reason: 'The database lineage changed. Refresh occupancy before retrying.',
      })
    }
    return ownership
  }

  #assertClaimClassAllowed(
    claimClass: ChatOccupancyClaimClass,
    sessionId: string,
    activeWriterSessionId: string | null,
  ): void {
    const isOwner = activeWriterSessionId === sessionId
    if (claimClass === 'owner' && !isOwner) {
      throw new ChatOccupancyError('active_writer_stale', 423, {
        reason: 'An owner-class claim requires the durable active owner session.',
      })
    }
    if (claimClass === 'chat_only' && isOwner) {
      throw new ChatOccupancyError('chat_occupancy_stale', 409, {
        reason: 'The durable active owner must use an owner-class claim for new occupancy.',
      })
    }
  }

  #assertExactTuple(input: OccupancyTupleInput, now: number): OccupancyRow {
    const row = this.#row(input.chatId, input.databaseLineage)
    if (
      !row ||
      row.database_lineage !== input.databaseLineage ||
      row.occupant_session_id !== input.sessionId ||
      row.occupancy_epoch !== input.occupancyEpoch
    ) {
      throw this.#stale(input.chatId, input.databaseLineage, now)
    }
    return row
  }

  #stale(chatId: string, databaseLineage: string, now: number): ChatOccupancyError {
    const current = this.#row(chatId, databaseLineage)
    return new ChatOccupancyError('chat_occupancy_stale', 409, {
      chatId,
      current: current ? projectRow(current, now) : null,
      reason: 'Refresh occupancy and use the current lineage, session, and epoch tuple.',
    })
  }

  #switchRequired(rows: readonly OccupancyRow[], targetChatId: string, now: number): ChatOccupancyError {
    return new ChatOccupancyError('chat_occupancy_switch_required', 409, {
      currentChats: rows.map((row) => projectRow(row, now)),
      targetChatId,
      reason: 'Explicitly switch or normalize occupancy before mutating another chat.',
    })
  }

  #assertChatExists(chatId: string): void {
    const row = this.db.prepare('SELECT 1 AS found FROM chats WHERE id = ?').get(chatId)
    if (!row) throw new ChatOccupancyError('chat_not_found', 404, { chatId })
  }

  #sessionRows(sessionId: string, databaseLineage: string): OccupancyRow[] {
    return this.db
      .prepare('SELECT * FROM chat_occupancies WHERE occupant_session_id = ? AND database_lineage = ? ORDER BY chat_id')
      .all(sessionId, databaseLineage) as unknown as OccupancyRow[]
  }

  #row(chatId: string, databaseLineage: string): OccupancyRow | undefined {
    return this.db
      .prepare('SELECT * FROM chat_occupancies WHERE chat_id = ? AND database_lineage = ?')
      .get(chatId, databaseLineage) as unknown as OccupancyRow | undefined
  }

  #requiredRow(chatId: string, databaseLineage: string): OccupancyRow {
    const row = this.#row(chatId, databaseLineage)
    if (!row) throw new Error(`chat occupancy row disappeared: ${chatId}`)
    return row
  }

  #writeTombstone(chatId: string, databaseLineage: string, now: number): void {
    const result = this.db
      .prepare(
        `
          UPDATE chat_occupancies
          SET occupant_session_id = NULL, occupancy_epoch = occupancy_epoch + 1, claim_class = NULL,
              claimed_at_ms = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?, released_at_ms = ?
          WHERE chat_id = ? AND database_lineage = ? AND occupant_session_id IS NOT NULL
        `,
      )
      .run(now, now, chatId, databaseLineage)
    if (result.changes !== 1) throw new Error(`chat occupancy row disappeared before release: ${chatId}`)
  }

  #purgeStaleLineageRows(databaseLineage: string): void {
    this.db.prepare('DELETE FROM chat_occupancies WHERE database_lineage <> ?').run(databaseLineage)
  }

  #readNow(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('chat occupancy clock returned an invalid value')
    return value
  }

  #transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function projectRow(row: OccupancyRow, now: number): ChatOccupancyProjection {
  return {
    databaseLineage: row.database_lineage,
    chatId: row.chat_id,
    occupantSessionId: row.occupant_session_id,
    occupancyEpoch: row.occupancy_epoch,
    claimClass: row.claim_class,
    state: row.occupant_session_id === null ? 'released' : isUnexpired(row, now) ? 'occupied' : 'expired',
    claimedAtMs: row.claimed_at_ms,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    updatedAtMs: row.updated_at_ms,
    releasedAtMs: row.released_at_ms,
  }
}

function isUnexpired(row: OccupancyRow, now: number): boolean {
  return row.occupant_session_id !== null && row.lease_expires_at_ms !== null && row.lease_expires_at_ms > now
}

function recoveryBlocked(blocking: readonly BlockingOccupancyPin[], targetChatId?: string): ChatOccupancyError {
  const blockingChatIds = [...new Set(blocking.map((pin) => pin.chatId))]
  return new ChatOccupancyError('chat_occupancy_recovery_blocked', 409, {
    chatId: blockingChatIds[0],
    blockingChatIds,
    ...(targetChatId === undefined ? {} : { targetChatId }),
    blocking,
    reason: 'Stop and reconcile the blocking work before releasing or reassigning this chat.',
  })
}

function validateClaimInput(input: ClaimOccupancyInput): void {
  validateId(input.databaseLineage, 'databaseLineage', 128)
  validateId(input.chatId, 'chatId', 512)
  validateId(input.sessionId, 'sessionId', 128)
  if (!Number.isSafeInteger(input.expectedOccupancyEpoch) || input.expectedOccupancyEpoch < 0) {
    throw new Error('expectedOccupancyEpoch is invalid')
  }
  if (input.claimClass !== 'owner' && input.claimClass !== 'chat_only') throw new Error('claimClass is invalid')
}

function validateTupleInput(input: OccupancyTupleInput): void {
  validateId(input.databaseLineage, 'databaseLineage', 128)
  validateId(input.chatId, 'chatId', 512)
  validateId(input.sessionId, 'sessionId', 128)
  if (!Number.isSafeInteger(input.occupancyEpoch) || input.occupancyEpoch < 0) {
    throw new Error('occupancyEpoch is invalid')
  }
}

function validateId(value: string, label: string, maxLength: number): void {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} is invalid`)
  }
}

function normalizeChatIds(chatIds: readonly string[]): string[] {
  const unique = new Set<string>()
  for (const chatId of chatIds) {
    validateId(chatId, 'chatId', 512)
    unique.add(chatId)
  }
  return [...unique].sort()
}

function readGuardNow(now: (() => number) | undefined): number {
  const value = (now ?? Date.now)()
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('chat occupancy clock returned an invalid value')
  return value
}

function readLogicalChatState(db: DatabaseSync, chatId: string): string {
  const chat = sqliteTableExists(db, 'chats')
    ? (db.prepare('SELECT id, character_id, position, data_json FROM chats WHERE id = ?').get(chatId) as
        | Record<string, unknown>
        | undefined)
    : undefined
  const messages = sqliteTableExists(db, 'messages')
    ? db
        .prepare(
          `
            SELECT chat_id, seq, uid, role, data, disabled, json, alternate
            FROM messages
            WHERE chat_id = ?
            ORDER BY seq, alternate, uid
          `,
        )
        .all(chatId)
    : []
  const hypa = sqliteTableExists(db, 'chat_hypa_v3')
    ? db.prepare('SELECT chat_id, json FROM chat_hypa_v3 WHERE chat_id = ?').get(chatId)
    : undefined
  return JSON.stringify({ chat: chat ?? null, messages, hypa: hypa ?? null })
}

function sqliteTableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}
