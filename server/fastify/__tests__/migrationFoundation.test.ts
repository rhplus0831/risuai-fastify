import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertMigrationCatalog,
  CURRENT_SCHEMA_VERSION,
  DamagedDatabaseRefusalError,
  getSchemaState,
  MIGRATIONS,
  openDatabase,
  type MigrationStep,
} from '../src/db.js'
import { ChatOccupancyService } from '../src/chatOccupancy.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import {
  installMigrationVersionCommitFailure,
  loadCompatibilityMigrationFixtureAdapters,
  removeMigrationVersionCommitFailure,
} from './support/migrationFoundationHarness.js'
import { installHistoricalGenerationV39Schema } from './support/historicalGenerationV39.js'

const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
const dataDirs: string[] = []

function makeDataDir(): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-migration-foundation-'))
  dataDirs.push(dataDir)
  return dataDir
}

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
})

describe('migration and recovery foundation', () => {
  it('keeps the production migration catalog named, unique, and contiguous', () => {
    expect(() => assertMigrationCatalog()).not.toThrow()
    expect(MIGRATIONS.map(({ version }) => version)).toEqual(
      Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1),
    )
    expect(new Set(MIGRATIONS.map(({ name }) => name)).size).toBe(CURRENT_SCHEMA_VERSION)

    const duplicateName: MigrationStep[] = [
      { version: 1, name: 'same-name', up: () => undefined },
      { version: 2, name: 'same-name', up: () => undefined },
    ]
    expect(() => assertMigrationCatalog(duplicateName, 2)).toThrow('Duplicate schema migration name: same-name')
    expect(() => assertMigrationCatalog([duplicateName[1]!], 1)).toThrow('Missing schema migration 1')
    expect(() => assertMigrationCatalog([{ version: 1, name: 'Not Named', up: () => undefined }], 1)).toThrow(
      'Invalid schema migration name',
    )
  })

  it('migrates v39 to durable chat occupancy authority without changing the domain revision', () => {
    const dataDir = makeDataDir()
    const legacy = new DatabaseSync(path.join(dataDir, 'risu.db'))
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO schema_version (id, version, revision) VALUES (1, 0, 41);
    `)
    for (const migration of MIGRATIONS.filter(({ version }) => version <= 39)) {
      legacy.exec('BEGIN IMMEDIATE')
      migration.up(legacy)
      legacy.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(migration.version)
      legacy.exec('COMMIT')
    }
    expect(getSchemaState(legacy)).toEqual({ version: 39, revision: 41 })
    expect(
      legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_occupancies'").get(),
    ).toBeUndefined()
    legacy.close()

    const migrated = openDatabase(dataDir)
    expect(getSchemaState(migrated)).toEqual({ version: 40, revision: 41 })
    expect(
      (migrated.prepare("PRAGMA table_info('chat_occupancies')").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    ).toEqual([
      'chat_id',
      'database_lineage',
      'occupant_session_id',
      'occupancy_epoch',
      'claim_class',
      'claimed_at_ms',
      'lease_expires_at_ms',
      'updated_at_ms',
      'released_at_ms',
    ])
    expect(
      (migrated.prepare("PRAGMA index_list('chat_occupancies')").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    ).toEqual(
      expect.arrayContaining([
        'idx_chat_occupancies_chat_only_session',
        'idx_chat_occupancies_session',
        'idx_chat_occupancies_lease',
        'idx_chat_occupancies_lineage',
      ]),
    )
    const expectColumns = (table: string, expected: readonly string[]) => {
      const actual = new Set(
        (migrated.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(({ name }) => name),
      )
      expect([...expected].filter((column) => !actual.has(column))).toEqual([])
    }
    const scopeColumns = [
      'admission_kind',
      'occupancy_database_lineage',
      'occupancy_session_id',
      'occupancy_epoch',
      'occupancy_claim_class',
      'permission_scope_version',
      'permission_scope_json',
    ]
    for (const table of [
      'generation_operations',
      'generation_finalization_retries',
      'generation_effects',
      'memory_jobs',
      'bardwiki_jobs',
    ]) {
      expectColumns(table, scopeColumns)
    }
    expectColumns('generation_finalization_retries', [
      'compatibility_database_lineage',
      'compatibility_session_id',
      'compatibility_occupancy_epoch',
    ])
    expectColumns('generation_operation_attempts', [
      'accepted_admission_kind',
      'accepted_occupancy_database_lineage',
      'accepted_occupancy_session_id',
      'accepted_occupancy_epoch',
      'accepted_occupancy_claim_class',
      'accepted_permission_scope_version',
      'accepted_permission_scope_json',
    ])
    migrated
      .prepare('INSERT INTO characters (id, position, data_json) VALUES (?, 0, ?)')
      .run('character-a', JSON.stringify({ chaId: 'character-a', name: 'Ada' }))
    migrated
      .prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, 0, ?)')
      .run('chat-a', 'character-a', JSON.stringify({ id: 'chat-a', message: [] }))
    const claimed = new ChatOccupancyService(migrated, { now: () => 1_000 }).claim({
      databaseLineage: getDatabaseLineage(migrated),
      chatId: 'chat-a',
      sessionId: 'reader-a',
      claimClass: 'chat_only',
      expectedOccupancyEpoch: 0,
    })
    migrated.close()

    const reopened = openDatabase(dataDir)
    expect(getSchemaState(reopened)).toEqual({ version: 40, revision: 41 })
    expect(new ChatOccupancyService(reopened, { now: () => 2_000 }).snapshot().occupancies).toEqual([claimed])
    reopened.close()
  })

  it('marks operations from the fixed historical v39 generation schema', () => {
    const dataDir = makeDataDir()
    const initialized = openDatabase(dataDir)
    const lineage = getDatabaseLineage(initialized)
    initialized.close()

    const historical = new DatabaseSync(path.join(dataDir, 'risu.db'))
    installHistoricalGenerationV39Schema(historical)
    expect(
      (historical.prepare("PRAGMA table_info('generation_operations')").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    ).not.toContain('pre_occupancy_authority')
    const insert = historical.prepare(
      `INSERT INTO generation_operations (
         database_lineage, operation_id, protocol_version, request_origin,
         creator_writer_session_id, creator_writer_epoch, binding_server_instance_id,
         character_id, chat_id, mode, accepted_message_id,
         request_fingerprint, intent_json, accepted_revision,
         state, state_version, projection_epoch, provider_may_have_run,
         created_at, updated_at
       ) VALUES (?, ?, 1, 'accepted_send', 'writer-a', 1, 'old-server',
                 'character-a', 'chat-a', 'send', 'message-a',
                 'old-fingerprint', '{}', 41, ?, 1, ?, 0,
                 '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    )
    insert.run(lineage, 'old-accepted', 'accepted', 1)
    insert.run(lineage, 'old-completed', 'completed', 2)
    historical.close()

    const migrated = openDatabase(dataDir)
    expect(getSchemaState(migrated)).toEqual({ version: 40, revision: 0 })
    expect(
      migrated
        .prepare(
          `SELECT operation_id AS operationId, pre_occupancy_authority AS preOccupancyAuthority,
                  admission_kind AS admissionKind
           FROM generation_operations ORDER BY operation_id`,
        )
        .all(),
    ).toEqual([
      { operationId: 'old-accepted', preOccupancyAuthority: 1, admissionKind: null },
      { operationId: 'old-completed', preOccupancyAuthority: 1, admissionKind: null },
    ])
    migrated.close()
  })

  it('rolls a failed named step and its version back, then retries and reopens idempotently', () => {
    const dataDir = makeDataDir()
    const fresh = openDatabase(dataDir)
    fresh.close()

    const seed = new DatabaseSync(path.join(dataDir, 'risu.db'))
    try {
      for (const table of [
        'bardwiki_document_search',
        'bardwiki_change_manifest',
        'bardwiki_document_sources',
        'bardwiki_document_versions',
        'bardwiki_links',
        'bardwiki_rebuild_staging',
        'bardwiki_turn_receipts',
        'bardwiki_documents',
        'bardwiki_jobs',
        'bardwiki_chat_settings',
      ]) {
        seed.exec(`DROP TABLE ${table}`)
      }
      seed.prepare('UPDATE schema_version SET version = 32, revision = 41 WHERE id = 1').run()
      seed.exec('CREATE TABLE migration_foundation_marker (value TEXT NOT NULL)')
      seed.prepare('INSERT INTO migration_foundation_marker (value) VALUES (?)').run('before')
      installMigrationVersionCommitFailure(seed, 33)
    } finally {
      seed.close()
    }

    expect(() => openDatabase(dataDir)).toThrow(
      'Failed to apply schema migration 33 (bardwiki-authoritative-storage): injected migration version commit failure',
    )

    const interrupted = new DatabaseSync(path.join(dataDir, 'risu.db'))
    try {
      expect(getSchemaState(interrupted)).toEqual({ version: 32, revision: 41 })
      expect(interrupted.prepare('SELECT value FROM migration_foundation_marker').get()).toEqual({ value: 'before' })
      expect(
        interrupted
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bardwiki_documents'")
          .get(),
      ).toBeUndefined()
      removeMigrationVersionCommitFailure(interrupted)
    } finally {
      interrupted.close()
    }

    const retried = openDatabase(dataDir)
    expect(getSchemaState(retried)).toEqual({ version: CURRENT_SCHEMA_VERSION, revision: 41 })
    expect(retried.prepare('SELECT value FROM migration_foundation_marker').get()).toEqual({ value: 'before' })
    expect(
      retried.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bardwiki_documents'").get(),
    ).toEqual({ name: 'bardwiki_documents' })
    retried.close()

    const reopened = openDatabase(dataDir)
    expect(getSchemaState(reopened)).toEqual({ version: CURRENT_SCHEMA_VERSION, revision: 41 })
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM bardwiki_documents').get()).toEqual({ count: 0 })
    reopened.close()
  })

  it('refuses existing databases outside the automatic migration envelope', () => {
    const noVersionTableDir = makeDataDir()
    const noVersionTable = new DatabaseSync(path.join(noVersionTableDir, 'risu.db'))
    noVersionTable.exec('CREATE TABLE user_state (value TEXT)')
    noVersionTable.close()

    expect(() => openDatabase(noVersionTableDir)).toThrow(DamagedDatabaseRefusalError)
    expect(() => openDatabase(noVersionTableDir)).toThrow('schema_version table is missing')

    const noVersionRowDir = makeDataDir()
    const noVersionRow = new DatabaseSync(path.join(noVersionRowDir, 'risu.db'))
    noVersionRow.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
      )
    `)
    noVersionRow.close()
    expect(() => openDatabase(noVersionRowDir)).toThrow('schema_version singleton row is missing or invalid')

    const incompleteCurrentDir = makeDataDir()
    const incompleteCurrent = new DatabaseSync(path.join(incompleteCurrentDir, 'risu.db'))
    incompleteCurrent.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO schema_version (id, version, revision) VALUES (1, ${CURRENT_SCHEMA_VERSION}, 0);
    `)
    incompleteCurrent.close()
    expect(() => openDatabase(incompleteCurrentDir)).toThrow('current schema is missing required tables')
  })

  it('adapts every Phase 0 historical fixture into an owning verification lane', () => {
    const adapters = loadCompatibilityMigrationFixtureAdapters(repositoryRoot)
    expect(adapters).toHaveLength(28)
    expect(new Set(adapters.map(({ surfaceId }) => surfaceId)).size).toBe(28)
    expect(
      Object.fromEntries(
        [
          'client-resource',
          'loadout',
          'memory',
          'model-configuration',
          'persona',
          'prompt-template',
          'translator',
          'repair',
          'interchange',
        ].map((family) => [family, adapters.filter((adapter) => adapter.family === family).length]),
      ),
    ).toEqual({
      'client-resource': 1,
      loadout: 2,
      memory: 3,
      'model-configuration': 4,
      persona: 3,
      'prompt-template': 5,
      translator: 4,
      repair: 3,
      interchange: 3,
    })

    for (const adapter of adapters) {
      expect(existsSync(path.join(repositoryRoot, adapter.fixturePath)), adapter.surfaceId).toBe(true)
      expect(adapter.command, adapter.surfaceId).toMatch(/^pnpm /)
    }
  })
})
