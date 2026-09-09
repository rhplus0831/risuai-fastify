import { DatabaseSync } from 'node:sqlite'
import { createDisplayModuleVersioning } from './displayModuleCache.js'
import fs from 'node:fs'
import path from 'node:path'
import { createChatBlobTable, createMessageTable } from './messageStore.js'
import { createGenerationFinalizationRetryTable } from './generationFinalizationRetry.js'
import { createPushSubscriptionsTable } from './pushNotifications.js'
import {
  createCommandMutationReceiptTable,
  migrateCommandMutationReceiptsToDatabaseLineage,
} from './commandMutationReceipts.js'
import { createDatabaseMetadataTable } from './databaseLineage.js'
import { createGreetingTranslationTable } from './translation/greetingTranslationStore.js'
import { createRequestHistoryTable } from './requestHistory.js'
import { createGenerationOperationTables } from './generationOperations.js'
import { createGenerationEffectLedgerTable } from './generationEffects.js'
import { createBardWikiTables } from './bardWikiRepository.js'
import {
  createAssetMetadataTable,
  createInlayCatalogTable,
  createCharacterTables,
  createCollectionTables,
  createSettingsTable,
  migrateLegacyFlatModelConfigurationInSqlite,
  repairPersistedHypaV3PresetSelectionIdentityInSqlite,
  repairPersistedPersonaSelectionIdentityInSqlite,
  repairPersistedTranslatorPresetSelectionIdentityInSqlite,
  repairPersistedGlobalLorebookIdsInSqlite,
  repairPersistedLegacyLocalStopStringsInSqlite,
} from './repository.js'

export const CURRENT_SCHEMA_VERSION = 39

export const CURRENT_SCHEMA_TABLES = [
  'assets',
  'bardwiki_change_manifest',
  'bardwiki_chat_settings',
  'bardwiki_document_search',
  'bardwiki_document_sources',
  'bardwiki_document_versions',
  'bardwiki_documents',
  'bardwiki_jobs',
  'bardwiki_links',
  'bardwiki_rebuild_staging',
  'bardwiki_turn_receipts',
  'bot_presets',
  'characters',
  'chat_hypa_v3',
  'chats',
  'command_events',
  'command_mutation_receipts',
  'database_metadata',
  'generation_effects',
  'generation_finalization_retries',
  'generation_operation_attempts',
  'generation_operation_projection_state',
  'generation_operations',
  'greeting_translations',
  'hypa_v3_presets',
  'inlay_catalog',
  'loadouts',
  'lore_books',
  'memory_chunks',
  'memory_embeddings',
  'memory_jobs',
  'memory_legacy_summary_tombstones',
  'memory_summaries',
  'messages',
  'model_presets',
  'modules',
  'personas',
  'plugin_custom_storage',
  'plugins',
  'prompt_presets',
  'prompt_templates',
  'push_subscriptions',
  'request_history',
  'schema_version',
  'settings',
  'translator_presets',
] as const

export interface OpenDatabaseOptions {
  allowMissingDatabase?: boolean
}

export class MissingDatabaseRefusalError extends Error {
  constructor(
    readonly databasePath: string,
    readonly evidence: readonly string[],
  ) {
    super(
      `Refusing to create a new RisuAI database at "${databasePath}" because the data directory contains ` +
        `evidence of a prior installation: ${evidence.join(', ')}. Restore the expected risu.db file at ` +
        `"${databasePath}" or restore a database backup. If starting fresh is intentional, set ` +
        'RISU_API_ALLOW_MISSING_DATABASE=1.',
    )
    this.name = 'MissingDatabaseRefusalError'
  }
}

export class DamagedDatabaseRefusalError extends Error {
  constructor(
    readonly databasePath: string,
    readonly reason: string,
    options: ErrorOptions = {},
  ) {
    super(
      `Refusing automatic migration of the existing RisuAI database at "${databasePath}": ${reason}. ` +
        'Restore a known-good database backup or use an explicit damaged-database recovery workflow.',
      options,
    )
    this.name = 'DamagedDatabaseRefusalError'
  }
}

export interface MigrationStep {
  version: number
  name: string
  up: (db: DatabaseSync) => void
}

export const MIGRATIONS: readonly MigrationStep[] = [
  {
    version: 1,
    name: 'migration-runner-bootstrap',
    up: () => {
      // Version 1 establishes the migration runner. Memory tables start in v2.
    },
  },
  {
    version: 2,
    name: 'hypa-v3-memory-tables',
    up: (db) => {
      createMemoryTables(db)
    },
  },
  {
    version: 3,
    name: 'memory-job-retry-scheduling',
    up: (db) => {
      createMemoryTables(db)
    },
  },
  {
    version: 4,
    name: 'chat-messages-table',
    up: (db) => {
      // The migration only creates the table; boot-time `ensureDbJsonImported`
      // splits legacy `db.json` messages into SQLite after memory backfill has
      // read them.
      createMessageTable(db)
    },
  },
  {
    version: 5,
    name: 'chat-hypa-v3-table',
    up: (db) => {
      // Per-chat hypaV3Data gets the same boundary treatment as messages:
      // extracted from db.json on startup and stored in SQLite.
      createChatBlobTable(db)
    },
  },
  {
    version: 6,
    name: 'message-reroll-alternates',
    up: (db) => {
      // Add the reroll-buffer `alternate` flag to existing `messages` tables.
      // Fresh databases already get it from `createMessageTable`.
      if (!hasColumn(db, 'messages', 'alternate')) {
        db.exec('ALTER TABLE messages ADD COLUMN alternate INTEGER NOT NULL DEFAULT 0')
      }
    },
  },
  {
    version: 7,
    name: 'command-event-history',
    up: (db) => {
      createCommandEventTable(db)
    },
  },
  {
    version: 8,
    name: 'generation-finalization-retry-queue',
    up: (db) => {
      createGenerationFinalizationRetryTable(db)
    },
  },
  {
    version: 9,
    name: 'command-event-drop-legacy-payload',
    up: (db) => {
      // Reconcile databases whose `command_events` table predates the durable
      // replay table's final shape and still carries a removed
      // `payload_json TEXT NOT NULL` column. See the helper for details.
      reconcileLegacyCommandEventTable(db)
    },
  },
  {
    version: 10,
    name: 'asset-metadata-table',
    up: (db) => {
      createAssetMetadataTable(db)
    },
  },
  {
    version: 11,
    name: 'characters-table',
    up: (db) => {
      createCharacterTables(db)
    },
  },
  {
    version: 12,
    name: 'collections-tables',
    up: (db) => {
      createCollectionTables(db)
    },
  },
  {
    version: 13,
    name: 'settings-table',
    up: (db) => {
      createSettingsTable(db)
    },
  },
  {
    version: 14,
    name: 'remove-db-json',
    up: () => {
      // No table changes; the boot path (`ensureDbJsonImported`) handles file
      // removal. The version bump signals that db.json is no longer expected.
    },
  },
  {
    version: 15,
    name: 'command-event-origin',
    up: (db) => {
      // Persist the writer-session origin with each replayable command event
      // so an SSE reconnect replay carries the same own-echo
      // suppression metadata as the live event. Fresh databases get the column
      // from `createCommandEventTable`.
      ensureColumn(
        db,
        'command_events',
        'origin_writer_session_id',
        'ALTER TABLE command_events ADD COLUMN origin_writer_session_id TEXT',
      )
    },
  },
  {
    version: 16,
    name: 'projection-body-cache-revisions',
    up: () => {
      // Retained as a historical version marker. The projection body-cache
      // tables are obsolete and migration v22 removes them from older stores.
    },
  },
  {
    version: 17,
    name: 'split-model-prompt-presets',
    up: (db) => {
      createCollectionTables(db)
    },
  },
  {
    version: 18,
    name: 'generation-finalization-target-snapshot',
    up: (db) => {
      createGenerationFinalizationRetryTable(db)
      ensureColumn(
        db,
        'generation_finalization_retries',
        'target_snapshot_json',
        'ALTER TABLE generation_finalization_retries ADD COLUMN target_snapshot_json TEXT CHECK (target_snapshot_json IS NULL OR json_valid(target_snapshot_json))',
      )
    },
  },
  {
    version: 19,
    name: 'push-subscriptions',
    up: (db) => {
      createPushSubscriptionsTable(db)
    },
  },
  {
    version: 20,
    name: 'generation-finalization-alternates',
    up: (db) => {
      createGenerationFinalizationRetryTable(db)
      ensureColumn(
        db,
        'generation_finalization_retries',
        'alternate_messages_json',
        "ALTER TABLE generation_finalization_retries ADD COLUMN alternate_messages_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternate_messages_json))",
      )
    },
  },
  {
    version: 21,
    name: 'legacy-memory-summary-delete-tombstones',
    up: (db) => {
      createMemoryTables(db)
    },
  },
  {
    version: 22,
    name: 'drop-projection-body-cache',
    up: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS collection_body_revisions;
        DROP TABLE IF EXISTS projection_body_cache_state;
      `)
    },
  },
  {
    version: 23,
    name: 'stable-global-lorebook-ids',
    up: (db) => {
      createCollectionTables(db)
      createSettingsTable(db)
      repairPersistedGlobalLorebookIdsInSqlite(db)
    },
  },
  {
    version: 24,
    name: 'command-mutation-idempotency-receipts',
    up: (db) => {
      createCommandMutationReceiptTable(db)
    },
  },
  {
    version: 25,
    name: 'database-lineage-and-receipt-acknowledgements',
    up: (db) => {
      createDatabaseMetadataTable(db)
      migrateCommandMutationReceiptsToDatabaseLineage(db)
    },
  },
  {
    version: 26,
    name: 'inlay-catalog',
    up: (db) => {
      createInlayCatalogTable(db)
    },
  },
  {
    version: 27,
    name: 'greeting-translations',
    up: (db) => {
      createGreetingTranslationTable(db)
    },
  },
  {
    version: 28,
    name: 'request-history',
    up: (db) => {
      createRequestHistoryTable(db)
    },
  },
  {
    version: 29,
    name: 'generation-operation-ledger',
    up: (db) => {
      createGenerationOperationTables(db)
      createGenerationFinalizationRetryTable(db)
      ensureColumn(
        db,
        'generation_finalization_retries',
        'database_lineage',
        'ALTER TABLE generation_finalization_retries ADD COLUMN database_lineage TEXT',
      )
      ensureColumn(
        db,
        'generation_finalization_retries',
        'operation_id',
        'ALTER TABLE generation_finalization_retries ADD COLUMN operation_id TEXT',
      )
      ensureColumn(
        db,
        'generation_finalization_retries',
        'operation_attempt_no',
        'ALTER TABLE generation_finalization_retries ADD COLUMN operation_attempt_no INTEGER CHECK (operation_attempt_no IS NULL OR operation_attempt_no > 0)',
      )
      ensureColumn(
        db,
        'generation_finalization_retries',
        'actor_writer_session_id',
        'ALTER TABLE generation_finalization_retries ADD COLUMN actor_writer_session_id TEXT',
      )
      ensureColumn(
        db,
        'generation_finalization_retries',
        'actor_writer_epoch',
        'ALTER TABLE generation_finalization_retries ADD COLUMN actor_writer_epoch INTEGER CHECK (actor_writer_epoch IS NULL OR actor_writer_epoch >= 0)',
      )
      ensureColumn(
        db,
        'generation_finalization_retries',
        'accepted_message_id',
        'ALTER TABLE generation_finalization_retries ADD COLUMN accepted_message_id TEXT',
      )
      ensureColumn(
        db,
        'generation_finalization_retries',
        'terminal_outcome',
        "ALTER TABLE generation_finalization_retries ADD COLUMN terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('completed', 'cancelled'))",
      )
      createCommandEventTable(db)
      ensureColumn(
        db,
        'command_events',
        'database_lineage',
        'ALTER TABLE command_events ADD COLUMN database_lineage TEXT',
      )
      ensureColumn(db, 'command_events', 'operation_id', 'ALTER TABLE command_events ADD COLUMN operation_id TEXT')
      ensureColumn(
        db,
        'command_events',
        'source_message_id',
        'ALTER TABLE command_events ADD COLUMN source_message_id TEXT',
      )
      ensureColumn(db, 'command_events', 'job_id', 'ALTER TABLE command_events ADD COLUMN job_id TEXT')
    },
  },
  {
    version: 30,
    name: 'memory-job-instance-identity',
    up: (db) => {
      createMemoryTables(db)
      db.exec(`
        UPDATE memory_jobs
        SET instance_id = lower(hex(randomblob(16)))
        WHERE instance_id = ''
      `)
    },
  },
  {
    version: 31,
    name: 'generation-effect-ledger',
    up: (db) => {
      createGenerationEffectLedgerTable(db)
    },
  },
  {
    version: 32,
    name: 'generation-effect-claim-leases',
    up: (db) => {
      createGenerationEffectLedgerTable(db)
    },
  },
  {
    version: 33,
    name: 'bardwiki-authoritative-storage',
    up: (db) => {
      createBardWikiTables(db)
    },
  },
  {
    version: 34,
    name: 'durable-model-profile-ownership',
    up: (db) => {
      migrateLegacyFlatModelConfigurationInSqlite(db)
    },
  },
  {
    version: 35,
    name: 'durable-persona-selection-identity',
    up: (db) => {
      createCollectionTables(db)
      createSettingsTable(db)
      repairPersistedPersonaSelectionIdentityInSqlite(db)
    },
  },
  {
    version: 36,
    name: 'durable-hypa-v3-preset-identity',
    up: (db) => {
      createCollectionTables(db)
      createSettingsTable(db)
      repairPersistedHypaV3PresetSelectionIdentityInSqlite(db)
    },
  },
  {
    version: 37,
    name: 'durable-translator-preset-selection-identity',
    up: (db) => {
      createCollectionTables(db)
      createSettingsTable(db)
      repairPersistedTranslatorPresetSelectionIdentityInSqlite(db)
    },
  },
  {
    version: 38,
    name: 'repair-legacy-local-stop-strings',
    up: (db) => {
      createCollectionTables(db)
      createSettingsTable(db)
      repairPersistedLegacyLocalStopStringsInSqlite(db)
    },
  },
  {
    version: 39,
    name: 'display-module-content-version',
    up: (db) => {
      createDatabaseMetadataTable(db)
      createCollectionTables(db)
      createDisplayModuleVersioning(db)
    },
  },
]

export function assertMigrationCatalog(
  migrations: readonly MigrationStep[] = MIGRATIONS,
  currentVersion = CURRENT_SCHEMA_VERSION,
): void {
  if (!Number.isInteger(currentVersion) || currentVersion < 0) {
    throw new Error(`Invalid current schema version: ${currentVersion}`)
  }
  const names = new Set<string>()
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]!
    const expectedVersion = index + 1
    if (migration.version !== expectedVersion) {
      throw new Error(`Missing schema migration ${expectedVersion}; next registered migration is ${migration.version}`)
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(migration.name)) {
      throw new Error(`Invalid schema migration name at version ${migration.version}: ${migration.name}`)
    }
    if (names.has(migration.name)) {
      throw new Error(`Duplicate schema migration name: ${migration.name}`)
    }
    names.add(migration.name)
  }
  if (migrations.length !== currentVersion) {
    throw new Error(`Missing schema migration ${migrations.length + 1}; current schema version is ${currentVersion}`)
  }
}

/** Whether `table` already has a column named `column` (PRAGMA table_info). */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

function priorInstallEvidence(dataDir: string): string[] {
  if (!fs.existsSync(dataDir)) return []

  const entries = fs.readdirSync(dataDir).sort()
  const evidence = entries.filter(
    (entry) => entry === 'db.json.migrated' || /^db\.json(?:\.migrated)?\.invalid(?:\.\d+)?$/.test(entry),
  )

  for (const directory of ['backups', 'assets', 'save']) {
    const directoryPath = path.join(dataDir, directory)
    if (
      fs.existsSync(directoryPath) &&
      fs.statSync(directoryPath).isDirectory() &&
      fs.readdirSync(directoryPath).length
    ) {
      evidence.push(`${directory}/`)
    }
  }

  if (fs.existsSync(path.join(dataDir, '__password'))) evidence.push('__password')
  return evidence
}

export function openDatabase(dataDir: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  const databasePath = path.join(dataDir, 'risu.db')
  const databaseExisted = fs.existsSync(databasePath)
  if (!databaseExisted && !options.allowMissingDatabase) {
    const evidence = priorInstallEvidence(dataDir)
    if (evidence.length > 0) throw new MissingDatabaseRefusalError(databasePath, evidence)
  }

  fs.mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    // WAL with NORMAL keeps database consistency crash-safe while accepting
    // that the latest committed transactions may be lost on OS/power failure.
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    if (!databaseExisted) initializeFreshDatabase(db)
    const schemaState = existingSchemaState(db, databasePath)
    if (schemaState.version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${schemaState.version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
      )
    }
    if (schemaState.version === CURRENT_SCHEMA_VERSION) {
      assertCurrentSchemaTables(db, databasePath)
    }
    applyMigrations(db, schemaState.version)
  } catch (error) {
    db.close()
    throw error
  }
  return db
}

function initializeFreshDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO schema_version (id, version, revision) VALUES (1, ${CURRENT_SCHEMA_VERSION}, 0);
  `)
  createDatabaseMetadataTable(db)
  createMemoryTables(db)
  createMessageTable(db)
  createChatBlobTable(db)
  createCommandEventTable(db)
  createCommandMutationReceiptTable(db)
  createGenerationFinalizationRetryTable(db)
  createGenerationOperationTables(db)
  createGenerationEffectLedgerTable(db)
  createAssetMetadataTable(db)
  createInlayCatalogTable(db)
  createCharacterTables(db)
  createBardWikiTables(db)
  createGreetingTranslationTable(db)
  createRequestHistoryTable(db)
  createCollectionTables(db)
  createDisplayModuleVersioning(db)
  createSettingsTable(db)
  createPushSubscriptionsTable(db)
}

function existingSchemaState(db: DatabaseSync, databasePath: string): { version: number; revision: number } {
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get()
    if (!table) throw new Error('schema_version table is missing')
    const rows = db.prepare('SELECT id, version, revision FROM schema_version').all() as Array<{
      id: unknown
      version: unknown
      revision: unknown
    }>
    if (rows.length !== 1 || rows[0]?.id !== 1) throw new Error('schema_version singleton row is missing or invalid')
    const { version, revision } = rows[0]
    if (!Number.isInteger(version) || (version as number) < 0) throw new Error('schema version is invalid')
    if (!Number.isInteger(revision) || (revision as number) < 0) throw new Error('schema revision is invalid')
    return { version: version as number, revision: revision as number }
  } catch (error) {
    if (error instanceof DamagedDatabaseRefusalError) throw error
    throw new DamagedDatabaseRefusalError(databasePath, error instanceof Error ? error.message : String(error), {
      cause: error,
    })
  }
}

function assertCurrentSchemaTables(db: DatabaseSync, databasePath: string): void {
  const actual = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>
    ).map(({ name }) => name),
  )
  const missing = CURRENT_SCHEMA_TABLES.filter((table) => !actual.has(table))
  if (missing.length > 0) {
    throw new DamagedDatabaseRefusalError(
      databasePath,
      `current schema is missing required tables: ${missing.join(', ')}`,
    )
  }
}

export function applyMigrations(db: DatabaseSync, fromVersion: number): void {
  if (!Number.isInteger(fromVersion) || fromVersion < 0) {
    throw new Error(`Invalid schema version: ${fromVersion}`)
  }
  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Database schema version ${fromVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`)
  }
  assertMigrationCatalog()
  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    return
  }

  const pending = MIGRATIONS.filter((migration) => migration.version > fromVersion)
  assertContiguousMigrations(fromVersion, pending)

  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      const result = db.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(migration.version)
      if (result.changes !== 1) {
        throw new Error('schema_version row missing; database not initialized')
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(
        `Failed to apply schema migration ${migration.version} (${migration.name}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    }
  }
}

function assertContiguousMigrations(fromVersion: number, migrations: readonly MigrationStep[]): void {
  let expectedVersion = fromVersion + 1
  for (const migration of migrations) {
    if (migration.version !== expectedVersion) {
      throw new Error(`Missing schema migration ${expectedVersion}; next registered migration is ${migration.version}`)
    }
    expectedVersion += 1
  }
  if (expectedVersion - 1 !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Missing schema migration ${expectedVersion}; current schema version is ${CURRENT_SCHEMA_VERSION}`)
  }
}

export function getSchemaState(db: DatabaseSync): { version: number; revision: number } {
  const row = db.prepare('SELECT version, revision FROM schema_version WHERE id = 1').get() as
    | { version: number; revision: number }
    | undefined
  if (!row) {
    throw new Error('schema_version row missing; database not initialized')
  }
  return row
}

export function bumpRevision(db: DatabaseSync): number {
  const row = db.prepare('UPDATE schema_version SET revision = revision + 1 WHERE id = 1 RETURNING revision').get() as
    | { revision: number }
    | undefined
  if (!row) {
    throw new Error('schema_version row missing; database not initialized')
  }
  return row.revision
}

function createMemoryTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      message_id TEXT,
      range_start_seq INTEGER NOT NULL CHECK (range_start_seq >= 0),
      range_end_seq INTEGER NOT NULL CHECK (range_end_seq >= range_start_seq),
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'summarized', 'failed')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memory_chunks_chat_id
      ON memory_chunks (chat_id);
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_chat_status
      ON memory_chunks (chat_id, status);
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_chat_range
      ON memory_chunks (chat_id, range_start_seq, range_end_seq);

    CREATE TABLE IF NOT EXISTS memory_summaries (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
      tokens INTEGER NOT NULL CHECK (tokens >= 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (chunk_id) REFERENCES memory_chunks(id) ON DELETE CASCADE,
      UNIQUE (chunk_id, model)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_summaries_chat_id
      ON memory_summaries (chat_id);
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_chunk_id
      ON memory_summaries (chunk_id);
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_chat_model
      ON memory_summaries (chat_id, model);

    -- Legacy Hypa V3 rows are derived from the retained chat.hypaV3Data
    -- projection at startup. Remember explicit deletions so the repeatable
    -- backfill does not resurrect a row on the next process start.
    CREATE TABLE IF NOT EXISTS memory_legacy_summary_tombstones (
      summary_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TRIGGER IF NOT EXISTS tombstone_deleted_legacy_memory_summary
    AFTER DELETE ON memory_summaries
    WHEN OLD.model = 'legacy-hypav3'
    BEGIN
      INSERT OR IGNORE INTO memory_legacy_summary_tombstones (summary_id, chat_id)
      VALUES (OLD.id, OLD.chat_id);
    END;

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      model TEXT NOT NULL,
      vector_blob BLOB NOT NULL,
      dim INTEGER NOT NULL CHECK (dim > 0),
      group_id TEXT,
      group_index INTEGER CHECK (group_index IS NULL OR group_index >= 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (chunk_id) REFERENCES memory_chunks(id) ON DELETE CASCADE,
      UNIQUE (chunk_id, model)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_chat_id
      ON memory_embeddings (chat_id);
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_chunk_id
      ON memory_embeddings (chunk_id);
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_chat_model
      ON memory_embeddings (chat_id, model);
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_group
      ON memory_embeddings (group_id, group_index);

    CREATE TABLE IF NOT EXISTS memory_jobs (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('chunk', 'embed', 'summarize')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
      next_run_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memory_jobs_chat_id
      ON memory_jobs (chat_id);
    CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_created
      ON memory_jobs (status, created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_jobs_kind_status
      ON memory_jobs (kind, status);
    CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_next_run
      ON memory_jobs (status, next_run_at, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_memory_jobs_status_updated
      ON memory_jobs (status, updated_at, id);
  `)
  ensureColumn(
    db,
    'memory_summaries',
    'metadata_json',
    'ALTER TABLE memory_summaries ADD COLUMN metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json))',
  )
  ensureColumn(
    db,
    'memory_jobs',
    'attempt_count',
    'ALTER TABLE memory_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)',
  )
  ensureColumn(
    db,
    'memory_jobs',
    'max_attempts',
    'ALTER TABLE memory_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0)',
  )
  ensureColumn(
    db,
    'memory_jobs',
    'next_run_at',
    "ALTER TABLE memory_jobs ADD COLUMN next_run_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
  )
  ensureColumn(
    db,
    'memory_jobs',
    'instance_id',
    "ALTER TABLE memory_jobs ADD COLUMN instance_id TEXT NOT NULL DEFAULT ''",
  )
}

function createCommandEventTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS command_events (
      revision INTEGER PRIMARY KEY CHECK (revision >= 0),
      type TEXT NOT NULL,
      resource TEXT NOT NULL,
      id TEXT,
      parent_id TEXT,
      origin_writer_session_id TEXT,
      database_lineage TEXT,
      operation_id TEXT,
      source_message_id TEXT,
      job_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_command_events_created_at
      ON command_events (created_at);
  `)
}

/**
 * Some databases predate the durable-replay table's final shape and still carry
 * a `command_events` table created with a now-removed
 * `payload_json TEXT NOT NULL` column (and a `revision INTEGER PRIMARY KEY`
 * without the `revision >= 0` check). The canonical INSERT omits `payload_json`,
 * so every command-event write on such a database fails with "NOT NULL
 * constraint failed: command_events.payload_json" — surfacing, for example, on
 * the first asset batch of a device-backup import.
 *
 * Rebuild the table to the canonical shape, preserving the durable replay rows.
 * No table references `command_events` (no inbound foreign keys, triggers, or
 * views), so a create-copy-drop-rename rebuild is safe inside the migration's
 * transaction even with `PRAGMA foreign_keys = ON`. Idempotent: a no-op once the
 * table already matches the canonical schema.
 */
function reconcileLegacyCommandEventTable(db: DatabaseSync): void {
  if (!hasColumn(db, 'command_events', 'payload_json')) return
  db.exec(`
    CREATE TABLE command_events_canonical (
      revision INTEGER PRIMARY KEY CHECK (revision >= 0),
      type TEXT NOT NULL,
      resource TEXT NOT NULL,
      id TEXT,
      parent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO command_events_canonical (revision, type, resource, id, parent_id, created_at)
      SELECT revision, type, resource, id, parent_id, created_at FROM command_events;
    DROP TABLE command_events;
    ALTER TABLE command_events_canonical RENAME TO command_events;
    CREATE INDEX IF NOT EXISTS idx_command_events_created_at
      ON command_events (created_at);
  `)
}

function ensureColumn(db: DatabaseSync, tableName: string, columnName: string, alterSql: string): void {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[]
  if (!rows.some((row) => row.name === columnName)) {
    db.exec(alterSql)
  }
}
