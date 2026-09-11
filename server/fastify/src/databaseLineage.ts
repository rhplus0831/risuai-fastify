import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const DATABASE_LINEAGE_HEADER = 'risu-database-lineage'

export interface DatabaseWriterMetadata {
  sessionId: string | null
  epoch: number
}

export interface DatabaseOwnershipSnapshot {
  databaseLineage: string
  writer: DatabaseWriterMetadata
}

export class DatabaseLineageConflictError extends Error {
  readonly databaseLineage: string

  constructor(databaseLineage: string) {
    super('Database lineage does not match the current database')
    this.name = 'DatabaseLineageConflictError'
    this.databaseLineage = databaseLineage
  }
}

export function createDatabaseMetadataTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS database_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      lineage TEXT NOT NULL,
      active_writer_session_id TEXT,
      writer_epoch INTEGER NOT NULL DEFAULT 0 CHECK (writer_epoch >= 0)
    )
  `)
  db.prepare(
    'INSERT OR IGNORE INTO database_metadata (id, lineage, active_writer_session_id, writer_epoch) VALUES (1, ?, NULL, 0)',
  ).run(randomUUID())
}

export function getDatabaseOwnershipSnapshot(db: DatabaseSync): DatabaseOwnershipSnapshot {
  const row = db
    .prepare(
      `
        SELECT lineage AS databaseLineage,
               active_writer_session_id AS sessionId,
               writer_epoch AS epoch
        FROM database_metadata
        WHERE id = 1
      `,
    )
    .get() as { databaseLineage: string; sessionId: string | null; epoch: number } | undefined
  if (
    !row ||
    typeof row.databaseLineage !== 'string' ||
    row.databaseLineage.length === 0 ||
    (row.sessionId !== null && typeof row.sessionId !== 'string') ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch < 0
  ) {
    throw new Error('database ownership metadata is missing or invalid')
  }
  return {
    databaseLineage: row.databaseLineage,
    writer: { sessionId: row.sessionId, epoch: row.epoch },
  }
}

export function getDatabaseWriterMetadata(db: DatabaseSync): DatabaseWriterMetadata {
  return getDatabaseOwnershipSnapshot(db).writer
}

/**
 * Registers the most recently bootstrapped writer durably. A changed owner
 * advances the epoch in the same statement, so restart cannot make a stale
 * tab appear to be the first writer and reclaim an old outbox silently.
 */
export function registerDatabaseWriterSession(db: DatabaseSync, sessionId: string): DatabaseOwnershipSnapshot {
  const row = db
    .prepare(
      `
        UPDATE database_metadata
        SET writer_epoch = CASE
              WHEN active_writer_session_id = ? THEN writer_epoch
              ELSE writer_epoch + 1
            END,
            active_writer_session_id = ?
        WHERE id = 1
        RETURNING lineage AS databaseLineage,
                  active_writer_session_id AS sessionId,
                  writer_epoch AS epoch
      `,
    )
    .get(sessionId, sessionId) as { databaseLineage: string; sessionId: string; epoch: number } | undefined
  if (
    !row ||
    typeof row.databaseLineage !== 'string' ||
    row.databaseLineage.length === 0 ||
    row.sessionId !== sessionId ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch < 0
  ) {
    throw new Error('database writer metadata row is missing or invalid')
  }
  return {
    databaseLineage: row.databaseLineage,
    writer: { sessionId: row.sessionId, epoch: row.epoch },
  }
}

export function getDatabaseLineage(db: DatabaseSync): string {
  return getDatabaseOwnershipSnapshot(db).databaseLineage
}

export function assertDatabaseLineage(db: DatabaseSync, requestedLineage: string): void {
  const databaseLineage = getDatabaseLineage(db)
  if (requestedLineage !== databaseLineage) {
    throw new DatabaseLineageConflictError(databaseLineage)
  }
}

/**
 * Destructive whole-database replacements start a fresh lineage. Receipts from
 * the replaced state are deleted in the same transaction: requests carrying
 * the old lineage are rejected before lookup, and retaining their ids would
 * only block unrelated intents in the new database.
 */
export function rotateDatabaseLineage(db: DatabaseSync): string {
  const databaseLineage = randomUUID()
  const updated = db.prepare('UPDATE database_metadata SET lineage = ? WHERE id = 1').run(databaseLineage)
  if (updated.changes !== 1) {
    throw new Error('database metadata lineage row is missing')
  }
  db.exec('DELETE FROM command_mutation_receipts')
  return databaseLineage
}
