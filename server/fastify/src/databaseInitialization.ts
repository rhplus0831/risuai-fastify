import type { DatabaseSync } from 'node:sqlite'

export const INITIALIZE_CONFLICT_ERROR = 'initialize_conflict'

export type DatabaseInitializationState = 'uninitialized' | 'initialized' | 'conflict'

export interface DatabaseInitializationAssessment {
  state: DatabaseInitializationState
  evidence: readonly string[]
}

export class InitializeConflictError extends Error {
  readonly code = INITIALIZE_CONFLICT_ERROR

  constructor(readonly evidence: readonly string[]) {
    super(INITIALIZE_CONFLICT_ERROR)
    this.name = 'InitializeConflictError'
  }
}

function settingsRowIsObject(db: DatabaseSync): boolean {
  const row = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined
  if (!row) return false

  try {
    const parsed: unknown = JSON.parse(row.data_json)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

const NON_USER_STATE_TABLES = new Set([
  // A malformed settings row is replaceable only while every durable owner is
  // empty. The row itself therefore cannot be initialization evidence.
  'settings',
  // These rows are created when the SQLite schema opens, before the user has
  // initialized application state. Writer ownership may also advance while an
  // otherwise empty database is waiting for first-run initialization.
  'database_metadata',
  // Occupancy rows are live access-control metadata, not initialized user data.
  'chat_occupancies',
  'generation_operation_projection_state',
  'schema_version',
])

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function durableTableRows(db: DatabaseSync): string[] {
  const tables = db
    .prepare(
      `
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `,
    )
    .all() as Array<{ name: string }>

  const evidence: string[] = []
  for (const { name } of tables) {
    if (NON_USER_STATE_TABLES.has(name)) continue
    const row = db.prepare(`SELECT 1 AS found FROM ${quoteSqlIdentifier(name)} LIMIT 1`).get() as
      | { found: number }
      | undefined
    if (row) evidence.push(name)
  }
  return evidence
}

/**
 * Classify whether first-run initialization is safe.
 *
 * A valid settings object is the normal initialization authority. When that
 * row is missing or malformed, durable domain rows and revision history form a
 * second, fail-closed authority: they prove this is a damaged existing
 * database, not a fresh one that may be seeded.
 */
export function assessDatabaseInitialization(db: DatabaseSync): DatabaseInitializationAssessment {
  if (settingsRowIsObject(db)) {
    return { state: 'initialized', evidence: [] }
  }

  const revisionRow = db.prepare('SELECT revision FROM schema_version WHERE id = 1').get() as
    | { revision: number }
    | undefined
  const projectionRow = db.prepare('SELECT epoch FROM generation_operation_projection_state WHERE id = 1').get() as
    | { epoch: number }
    | undefined
  const evidence = durableTableRows(db)
  const revision = revisionRow?.revision ?? 0
  if (revision > 0) evidence.push(`revision=${revision}`)
  const generationOperationProjectionEpoch = projectionRow?.epoch ?? 0
  if (generationOperationProjectionEpoch > 0) {
    evidence.push(`generation_operation_projection_epoch=${generationOperationProjectionEpoch}`)
  }

  return evidence.length > 0 ? { state: 'conflict', evidence } : { state: 'uninitialized', evidence: [] }
}
