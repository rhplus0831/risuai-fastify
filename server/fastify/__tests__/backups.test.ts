import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, webcrypto } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { buildApp } from '../src/app.js'
import { createCommandEventSink, type CommandEventSink } from '../src/commands/events.js'
import { readDisplayModules, getDisplayModuleVersion } from '../src/displayModuleCache.js'
import { CURRENT_SCHEMA_VERSION } from '../src/db.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import { createBardWikiDocument, updateBardWikiChatSettings } from '../src/bardWikiRepository.js'
import { BackupCopyPool } from '../src/backupCopyPool.js'
import { GENERATION_FINALIZATION_LEGACY_SNAPSHOT_ERROR } from '../src/generationFinalizationRetry.js'
import { MessageTranslationJobRegistry } from '../src/messageTranslationJobs.js'
import { retryQueuedGenerationFinalizations } from '../src/routes/generationChat.js'
import {
  SQLITE_BACKUP_EXCLUDED_TABLES,
  SQLITE_BACKUP_TABLES,
  addAsset,
  assetsDir,
  getAllAssetMetadata,
  listBackups,
  loadPersistedWithMessages,
} from '../src/repository.js'
import type { FastifyInstance } from 'fastify'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import {
  createGenerationOperation,
  reserveGenerationOperationAttempt,
  transitionGenerationOperation,
} from '../src/generationOperations.js'
import {
  EXPECTED_CANONICAL_OWNER_PERSISTENCE_SNAPSHOT,
  canonicalOwnerPersistenceDatabase,
  canonicalOwnerPersistenceSnapshot,
} from './helpers/canonicalOwnerPersistence.js'

const subtle = webcrypto.subtle
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)
const PNG_SHA = createHash('sha256').update(PNG_BYTES).digest('hex')

function failCommandEventPersistence(dataDir: string): void {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    db.exec(`
      CREATE TRIGGER fail_command_event_insert
      BEFORE INSERT ON command_events
      BEGIN
        SELECT RAISE(FAIL, 'injected command event failure');
      END;
    `)
  } finally {
    db.close()
  }
}

interface Harness {
  app: FastifyInstance
  dataDir: string
  commandEvents: CommandEventSink
}

function harnessConfig(dataDir: string, automaticBackupRetention?: number) {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    bodyLimit: 1024 * 1024,
    importMaxBytes: Infinity,
    automaticBackupRetention,
    trustProxy: false,
    hubUrl: 'https://sv.risuai.xyz',
  }
}

async function startHarness(
  automaticBackupRetention?: number,
  configureApp?: (app: FastifyInstance) => void,
): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-'))
  const commandEvents = createCommandEventSink()
  const { app } = await buildApp({
    config: harnessConfig(dataDir, automaticBackupRetention),
    commandEvents,
    generationChat: { finalizationRetry: false },
  })
  configureApp?.(app)
  return { app, dataDir, commandEvents }
}

async function restartHarness(harness: Harness): Promise<void> {
  await harness.app.close()
  const commandEvents = createCommandEventSink()
  const { app } = await buildApp({
    config: harnessConfig(harness.dataDir),
    commandEvents,
    generationChat: { finalizationRetry: false },
  })
  harness.app = app
  harness.commandEvents = commandEvents
}

async function stopHarness(h: Harness): Promise<void> {
  await h.app.close()
  rmSync(h.dataDir, { recursive: true, force: true })
}

async function signAssertion(privateKey: CryptoKey, publicJwk: JsonWebKey, ttlSec = 60): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'ES256', typ: 'JWT' }
  const payload = { iat: now, exp: now + ttlSec, pub: publicJwk }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signingInput = `${headerB64}.${payloadB64}`
  const signature = await subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    Buffer.from(signingInput),
  )
  const sigB64 = Buffer.from(signature).toString('base64url')
  return `${signingInput}.${sigB64}`
}

async function setupAuthedClient(app: FastifyInstance): Promise<{ assertion: string }> {
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { password: 'hunter2' },
  })
  expect(setup.statusCode).toBe(200)

  const keypair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publicKey = await subtle.exportKey('jwk', keypair.publicKey)

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: 'hunter2', publicKey },
  })
  expect(login.statusCode).toBe(200)

  const assertion = await signAssertion(keypair.privateKey, publicKey)
  return { assertion }
}

async function importDb(app: FastifyInstance, assertion: string, database: unknown): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion },
    // Minimal fixtures need one recognized core key to pass the
    // risusave_empty_database import guard.
    payload: { database: { characters: [], ...(database as Record<string, unknown>) } },
  })
  expect(res.statusCode).toBe(200)
  return res.json().revision as number
}

function readBackupDatabase(dataDir: string, id: string): Record<string, unknown> {
  const backupRoot = path.join(dataDir, 'backups', id)
  const backupDb = new DatabaseSync(path.join(backupRoot, 'risu.db'), { readOnly: true })
  try {
    return loadPersistedWithMessages(backupDb, backupRoot).database as Record<string, unknown>
  } finally {
    backupDb.close()
  }
}

function insertFinalizationRetry(db: DatabaseSync, generationId: string, chatId: string): void {
  db.prepare(
    `INSERT INTO generation_finalization_retries (
       generation_id,
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
     ) VALUES (?, ?, 'send', NULL, ?, ?, ?, ?, 2, 'last failure', 'terminal failure', 'terminal', ?, ?)`,
  ).run(
    generationId,
    chatId,
    JSON.stringify({ role: 'char', data: `message-${generationId}`, chatId: `message-${generationId}` }),
    JSON.stringify([{ role: 'char', data: `alternate-${generationId}`, chatId: `alternate-${generationId}` }]),
    JSON.stringify([{ key: `key-${generationId}`, value: `value-${generationId}` }]),
    JSON.stringify({ chatId, targetMessageId: null, messageCount: 1 }),
    '2026-07-23T00:00:00.000Z',
    '2026-07-23T00:00:01.000Z',
  )
}

function insertPushSubscription(db: DatabaseSync, endpoint: string): void {
  db.prepare(
    `INSERT INTO push_subscriptions (
       endpoint, subscription_json, failure_count, last_error, created_at, updated_at
     ) VALUES (?, ?, 0, NULL, ?, ?)`,
  ).run(
    endpoint,
    JSON.stringify({ endpoint, keys: { p256dh: `p256dh-${endpoint}`, auth: `auth-${endpoint}` } }),
    '2026-07-23T00:00:00.000Z',
    '2026-07-23T00:00:01.000Z',
  )
}

function insertRequestHistory(db: DatabaseSync, id: string, prompt: string, response: string): void {
  db.prepare(
    `INSERT INTO request_history (
       id, started_at, completed_at, status, source, profile_json, prompt_json,
       response_text, metadata_json, api_metadata_json
     ) VALUES (?, 1, 2, 'success', 'backup-test', ?, ?, ?, '{}', '{}')`,
  ).run(
    id,
    JSON.stringify({
      id: 'backup-test-profile',
      role: 'primary',
      sourceKind: 'settings',
      modelId: 'backup-test-model',
      requestModel: 'backup-test-model',
    }),
    JSON.stringify([{ role: 'user', content: prompt }]),
    response,
  )
}

let harness: Harness

beforeEach(async () => {
  harness = await startHarness()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await stopHarness(harness)
})

describe('backups', () => {
  describe('SQLite backup table ownership policy', () => {
    it('classifies every production schema table as restored or deliberately device-local', () => {
      const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
      try {
        const liveTables = (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all() as Array<{ name: string }>
        ).map((row) => row.name)
        const backupTables = [...SQLITE_BACKUP_TABLES]
        const excludedEntries = Object.entries(SQLITE_BACKUP_EXCLUDED_TABLES)
        const excludedTables = excludedEntries.map(([table]) => table)
        const liveTableSet = new Set(liveTables)
        const backupTableSet = new Set<string>(backupTables)
        const excludedTableSet = new Set(excludedTables)
        const instructions =
          'Add a new durable table to SQLITE_BACKUP_TABLES so it round-trips with backups, or add it to ' +
          'SQLITE_BACKUP_EXCLUDED_TABLES with a rationale when it is deliberately device-local.'

        expect(
          liveTables.filter((table) => !backupTableSet.has(table) && !excludedTableSet.has(table)),
          `Every production SQLite table must have an explicit backup policy. ${instructions}`,
        ).toEqual([])
        expect(
          backupTables.filter((table) => excludedTableSet.has(table)).sort(),
          'SQLITE_BACKUP_TABLES and SQLITE_BACKUP_EXCLUDED_TABLES must be disjoint; choose exactly one policy.',
        ).toEqual([])
        expect(
          backupTables.filter((table) => !liveTableSet.has(table)).sort(),
          `SQLITE_BACKUP_TABLES contains tables absent from the production schema. Remove renamed/dead entries, or update their schema creation. ${instructions}`,
        ).toEqual([])
        expect(
          excludedTables.filter((table) => !liveTableSet.has(table)).sort(),
          `SQLITE_BACKUP_EXCLUDED_TABLES contains tables absent from the production schema. Remove renamed/dead entries, or update their schema creation. ${instructions}`,
        ).toEqual([])
        expect(
          excludedEntries.filter(([, reason]) => reason.trim().length === 0).map(([table]) => table),
          'Every SQLITE_BACKUP_EXCLUDED_TABLES entry must document why the table is deliberately device-local.',
        ).toEqual([])
      } finally {
        db.close()
      }
    })
  })

  it('rejects all four routes without auth when password is set', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })
    for (const op of [
      { method: 'POST' as const, url: '/api/v1/backups' },
      { method: 'GET' as const, url: '/api/v1/backups' },
      { method: 'POST' as const, url: '/api/v1/backups/2026-05-20-12-00-00-abc123/restore' },
      { method: 'DELETE' as const, url: '/api/v1/backups/2026-05-20-12-00-00-abc123' },
    ]) {
      const res = await harness.app.inject(op)
      expect(res.statusCode, `${op.method} ${op.url}`).toBe(401)
    }
  })

  it('creates a backup on a fresh data dir', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    const manifest = res.json()
    expect(manifest).toMatchObject({
      _version: 1,
      label: null,
      kind: 'manual',
      revision: 0,
      assetCount: 0,
    })
    expect(manifest.id).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]{6}$/)
    expect(existsSync(path.join(harness.dataDir, 'backups', manifest.id, 'manifest.json'))).toBe(true)
  })

  it('persists an explicit label', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'before refactor' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().label).toBe('before refactor')
  })

  it('rejects a non-string label', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 42 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('captures the live revision and asset count', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { v: 1 })
    await importDb(harness.app, assertion, { v: 2 })
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: {},
    })
    expect(res.json().revision).toBe(2)
    expect(res.json().assetCount).toBe(0)
  })

  it('fails a manual backup clearly when a reader keeps the WAL checkpoint busy', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'checkpoint-source' })
    const backupsBefore = listBackups(harness.dataDir).map((backup) => backup.id)
    const liveDbPath = path.join(harness.dataDir, 'risu.db')
    const reader = new DatabaseSync(liveDbPath)
    const writer = new DatabaseSync(liveDbPath)
    try {
      reader.exec('BEGIN')
      reader.prepare('SELECT revision FROM schema_version WHERE id = 1').get()
      writer.exec('UPDATE schema_version SET revision = revision + 1 WHERE id = 1')

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/backups',
        headers: { 'risu-auth': assertion },
        payload: { label: 'must fail busy' },
      })

      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({ error: 'backup_wal_checkpoint_failed' })
      expect(response.json().detail).toContain('remained busy')
      expect(listBackups(harness.dataDir).map((backup) => backup.id)).toEqual(backupsBefore)
    } finally {
      reader.exec('ROLLBACK')
      reader.close()
      writer.close()
    }
  })

  it('routes a busy safety-snapshot checkpoint through AutomaticBackupError and leaves the import unapplied', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'before-busy-safety-snapshot' })
    const automaticBefore = listBackups(harness.dataDir).filter((backup) => backup.kind === 'automatic')
    const liveDbPath = path.join(harness.dataDir, 'risu.db')
    const reader = new DatabaseSync(liveDbPath)
    const writer = new DatabaseSync(liveDbPath)
    try {
      reader.exec('BEGIN')
      reader.prepare('SELECT revision FROM schema_version WHERE id = 1').get()
      writer.exec('UPDATE schema_version SET revision = revision + 1 WHERE id = 1')

      const imported = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/import/risusave',
        headers: { 'risu-auth': assertion },
        payload: { database: { characters: [], tag: 'must-not-import' } },
      })

      expect(imported.statusCode).toBe(500)
      expect(imported.json()).toEqual({ error: 'automatic_backup_failed' })
      const bootstrap = await injectComposedResourceDatabase(harness.app, {
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': assertion },
      })
      expect(bootstrap.resourceDatabase).toMatchObject({ tag: 'before-busy-safety-snapshot' })
      expect(listBackups(harness.dataDir).filter((backup) => backup.kind === 'automatic')).toEqual(automaticBefore)
    } finally {
      reader.exec('ROLLBACK')
      reader.close()
      writer.close()
    }
  })

  it('lists backups newest-first', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const a = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'a' },
    })
    await new Promise((r) => setTimeout(r, 15))
    const b = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'b' },
    })
    const list = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
    })
    expect(list.statusCode).toBe(200)
    const ids = list.json().backups.map((m: { id: string }) => m.id)
    expect(ids).toEqual([b.json().id, a.json().id])
  })

  it('lists empty on a fresh data dir', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
    })
    expect(res.json()).toEqual({ backups: [] })
  })

  it('round-trips: import A, backup, import B, restore, bootstrap returns A', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, {
      tag: 'A',
      modules: [{ id: 'module-a', namespace: 'test' }],
      loadouts: [
        { id: 'loadout-a', name: 'Shared name' },
        { id: 'loadout-b', name: 'Shared name' },
      ],
      lastLoadedLoadoutName: 'Shared name',
    })
    const cacheDb = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      const [moduleA] = readDisplayModules(cacheDb, ['test'])
      const versionA = getDisplayModuleVersion(cacheDb)
      const backup = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/backups',
        headers: { 'risu-auth': assertion },
        payload: { label: 'snapshot of A' },
      })
      expect(backup.statusCode).toBe(201)
      const backupId = backup.json().id

      await importDb(harness.app, assertion, { tag: 'B' })
      expect(readDisplayModules(cacheDb, ['test'])).toEqual([])
      expect(getDisplayModuleVersion(cacheDb)).not.toBe(versionA)
      const beforeRestore = await injectComposedResourceDatabase(harness.app, {
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': assertion },
      })
      expect(beforeRestore.resourceDatabase).toMatchObject({
        tag: 'B',
        characters: [],
        botPresets: [],
        modules: [],
        loadouts: [],
        plugins: [],
        pluginCustomStorage: {},
      })

      const restored = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/backups/${backupId}/restore`,
        headers: { 'risu-auth': assertion },
      })
      expect(restored.statusCode).toBe(200)
      const revisionAfter = restored.json().revision
      expect(restored.json().event).toEqual({
        type: 'state.restored',
        resource: 'state',
        revision: revisionAfter,
      })
      expect(harness.commandEvents.list()).toContainEqual({
        type: 'state.restored',
        resource: 'state',
        revision: revisionAfter,
      })

      const afterRestore = await injectComposedResourceDatabase(harness.app, {
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': assertion },
      })
      const [restoredModule] = readDisplayModules(cacheDb, ['test'])
      expect(restoredModule).toEqual(moduleA)
      expect(restoredModule).not.toBe(moduleA)
      expect(getDisplayModuleVersion(cacheDb)).not.toBe(versionA)
      expect(afterRestore.resourceDatabase).toMatchObject({
        tag: 'A',
        characters: [],
        botPresets: [],
        modules: [{ id: 'module-a', namespace: 'test' }],
        loadouts: [
          { id: 'loadout-a', name: 'Shared name' },
          { id: 'loadout-b', name: 'Shared name' },
        ],
        lastLoadedLoadoutName: 'Shared name',
        plugins: [],
        pluginCustomStorage: {},
      })
      expect(afterRestore.json().revision).toBe(revisionAfter)
    } finally {
      cacheDb.close()
    }
  })

  it('restores canonical owner identities and cache inputs across a server restart', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, canonicalOwnerPersistenceDatabase())
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'canonical owner snapshot' },
    })
    expect(backup.statusCode).toBe(201)

    await importDb(harness.app, assertion, { tag: 'replacement state' })
    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    await restartHarness(harness)
    const reopened = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    try {
      expect(canonicalOwnerPersistenceSnapshot(loadPersistedWithMessages(reopened, harness.dataDir).database)).toEqual(
        EXPECTED_CANONICAL_OWNER_PERSISTENCE_SNAPSHOT,
      )
    } finally {
      reopened.close()
    }
  })

  it('round-trips every BardWiki-owned table and rebuilds excluded search and link resolution', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const livePath = path.join(harness.dataDir, 'risu.db')
    const seed = new DatabaseSync(livePath)
    let targetId: string
    let sourceId: string
    try {
      seed.prepare("INSERT INTO characters (id, position, data_json) VALUES ('character-wiki', 0, '{}')").run()
      seed
        .prepare(
          "INSERT INTO chats (id, character_id, position, data_json) VALUES ('chat-wiki', 'character-wiki', 0, '{}')",
        )
        .run()
      updateBardWikiChatSettings(seed, 'chat-wiki', { enabledOverride: true, maxDocumentsOverride: 5 })
      const target = createBardWikiDocument(seed, {
        id: 'document-target',
        chatId: 'chat-wiki',
        kind: 'location',
        title: 'Old Tavern',
        logicalPath: 'Places/Old Tavern',
        aliases: ['The Inn'],
        markdown: '## Old Tavern\nA quiet inn.',
        commandRevision: 1,
      })
      const source = createBardWikiDocument(seed, {
        id: 'document-source',
        chatId: 'chat-wiki',
        kind: 'event',
        title: 'Arrival',
        logicalPath: 'Events/Arrival',
        markdown: 'They met at [[Places/Old Tavern]].',
        commandRevision: 1,
      })
      targetId = target.id
      sourceId = source.id
      seed
        .prepare(
          `INSERT INTO bardwiki_turn_receipts (
          id, chat_id, user_message_id, user_content_hash, assistant_message_id,
          assistant_content_hash, confirmation_mode, state, change_set_id, event_document_id
        ) VALUES ('receipt-wiki', 'chat-wiki', 'user-wiki', 'hash-user', 'assistant-wiki',
          'hash-assistant', 'explicit', 'applied', 'change-wiki', ?)`,
        )
        .run(source.id)
      seed
        .prepare(
          `INSERT INTO bardwiki_jobs (
          id, instance_id, chat_id, receipt_id, kind, status, payload_json
        ) VALUES ('job-wiki', 'instance-wiki', 'chat-wiki', 'receipt-wiki', 'apply_turn', 'completed', '{}')`,
        )
        .run()
      seed
        .prepare(
          `INSERT INTO bardwiki_document_sources (
          document_id, document_version, receipt_id, message_id, role, content_hash
        ) VALUES (?, 1, 'receipt-wiki', 'assistant-wiki', 'assistant', 'hash-assistant')`,
        )
        .run(source.id)
      seed
        .prepare(
          `INSERT INTO bardwiki_change_manifest (
          receipt_id, document_id, after_version, after_hash
        ) VALUES ('receipt-wiki', ?, 1, ?)`,
        )
        .run(source.id, source.contentHash)
      seed
        .prepare(
          `INSERT INTO bardwiki_rebuild_staging (rebuild_job_id, ordinal, change_json)
         VALUES ('job-wiki', 0, '{"operation":"create"}')`,
        )
        .run()
    } finally {
      seed.close()
    }

    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'BardWiki ownership' },
    })
    expect(backup.statusCode).toBe(201)

    const backupDb = new DatabaseSync(path.join(harness.dataDir, 'backups', backup.json().id as string, 'risu.db'))
    try {
      backupDb.prepare("UPDATE bardwiki_document_search SET title_terms = 'poisoned-derived-state'").run()
      backupDb.prepare('UPDATE bardwiki_links SET resolved_document_id = NULL').run()
    } finally {
      backupDb.close()
    }

    const mutate = new DatabaseSync(livePath)
    try {
      mutate.exec('PRAGMA foreign_keys = ON')
      mutate.prepare("DELETE FROM chats WHERE id = 'chat-wiki'").run()
      expect(mutate.prepare('SELECT COUNT(*) AS count FROM bardwiki_documents').get()).toEqual({ count: 0 })
    } finally {
      mutate.close()
    }

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const verify = new DatabaseSync(livePath, { readOnly: true })
    try {
      expect(
        verify.prepare('SELECT enabled_override, max_documents_override FROM bardwiki_chat_settings').get(),
      ).toEqual({ enabled_override: 1, max_documents_override: 5 })
      expect(verify.prepare('SELECT id FROM bardwiki_documents ORDER BY id').all()).toEqual([
        { id: sourceId },
        { id: targetId },
      ])
      expect(
        verify.prepare('SELECT document_id, version FROM bardwiki_document_versions ORDER BY document_id').all(),
      ).toEqual([
        { document_id: sourceId, version: 1 },
        { document_id: targetId, version: 1 },
      ])
      expect(verify.prepare('SELECT id, state FROM bardwiki_turn_receipts').all()).toEqual([
        { id: 'receipt-wiki', state: 'applied' },
      ])
      expect(verify.prepare('SELECT id, status FROM bardwiki_jobs').all()).toEqual([
        { id: 'job-wiki', status: 'completed' },
      ])
      expect(verify.prepare('SELECT document_id, receipt_id FROM bardwiki_document_sources').all()).toEqual([
        { document_id: sourceId, receipt_id: 'receipt-wiki' },
      ])
      expect(verify.prepare('SELECT receipt_id, document_id FROM bardwiki_change_manifest').all()).toEqual([
        { receipt_id: 'receipt-wiki', document_id: sourceId },
      ])
      expect(verify.prepare('SELECT rebuild_job_id, change_json FROM bardwiki_rebuild_staging').all()).toEqual([
        { rebuild_job_id: 'job-wiki', change_json: '{"operation":"create"}' },
      ])
      expect(verify.prepare('SELECT raw_target, resolved_document_id FROM bardwiki_links').all()).toEqual([
        { raw_target: 'Places/Old Tavern', resolved_document_id: targetId },
      ])
      expect(
        verify
          .prepare('SELECT title_terms, alias_terms, heading_terms FROM bardwiki_document_search WHERE document_id = ?')
          .get(targetId),
      ).toEqual({ title_terms: 'old tavern', alias_terms: 'the inn', heading_terms: 'old tavern' })
    } finally {
      verify.close()
    }
  })

  it.each(['restore', 'import'] as const)(
    'rejects an old-lineage command held across a whole-database %s boundary',
    async (replacementKind) => {
      await stopHarness(harness)
      let holdCommand = false
      let markCommandHeld!: () => void
      let releaseCommand!: () => void
      const commandHeld = new Promise<void>((resolve) => {
        markCommandHeld = resolve
      })
      const commandRelease = new Promise<void>((resolve) => {
        releaseCommand = resolve
      })
      harness = await startHarness(undefined, (app) => {
        app.addHook('preHandler', async (req) => {
          if (!holdCommand || req.url.split('?')[0] !== '/api/v1/commands/settings/display') return
          markCommandHeld()
          await commandRelease
        })
      })

      const { assertion } = await setupAuthedClient(harness.app)
      await importDb(harness.app, assertion, { tag: 'replacement-A', theme: 'dark' })
      const backup = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/backups',
        headers: { 'risu-auth': assertion },
        payload: { label: 'held-command restore target' },
      })
      expect(backup.statusCode).toBe(201)
      await importDb(harness.app, assertion, { tag: 'live-B', theme: 'dark' })

      const writerSession = 'tier4-held-command-writer'
      const beforeReplacement = await injectComposedResourceDatabase(harness.app, {
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': assertion, 'risu-writer-session': writerSession },
      })
      expect(beforeReplacement.statusCode).toBe(200)
      const oldLineage = beforeReplacement.json().databaseLineage as string
      holdCommand = true
      const heldCommand = harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/settings/display',
        headers: {
          'risu-auth': assertion,
          'risu-writer-session': writerSession,
          'risu-mutation-id': `held-across-${replacementKind}`,
          'risu-database-lineage': oldLineage,
        },
        payload: {
          baseRevision: beforeReplacement.json().revision,
          patch: { theme: 'light' },
        },
      })
      await commandHeld

      const replacement =
        replacementKind === 'restore'
          ? await harness.app.inject({
              method: 'POST',
              url: `/api/v1/backups/${backup.json().id}/restore`,
              headers: { 'risu-auth': assertion, 'risu-writer-session': writerSession },
            })
          : await harness.app.inject({
              method: 'POST',
              url: '/api/v1/import/risusave',
              headers: { 'risu-auth': assertion, 'risu-writer-session': writerSession },
              payload: { database: { characters: [], tag: 'replacement-A', theme: 'dark' } },
            })
      releaseCommand()

      expect(replacement.statusCode).toBe(200)
      expect(replacement.json().databaseLineage).not.toBe(oldLineage)
      const rejected = await heldCommand
      expect(rejected.statusCode).toBe(409)
      expect(rejected.json()).toEqual({
        error: 'database_lineage_conflict',
        databaseLineage: replacement.json().databaseLineage,
      })

      const afterReplacement = await injectComposedResourceDatabase(harness.app, {
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': assertion, 'risu-writer-session': writerSession },
      })
      expect(afterReplacement.resourceDatabase).toMatchObject({ tag: 'replacement-A', theme: 'dark' })
    },
  )

  it('clears device-local request history when restoring a SQLite backup', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const liveDbPath = path.join(harness.dataDir, 'risu.db')
    const snapshotDb = new DatabaseSync(liveDbPath)
    try {
      insertRequestHistory(snapshotDb, 'snapshot-history', 'snapshot prompt', 'snapshot response')
    } finally {
      snapshotDb.close()
    }

    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'request history exclusion snapshot' },
    })
    expect(backup.statusCode).toBe(201)

    const backupDb = new DatabaseSync(path.join(harness.dataDir, 'backups', backup.json().id, 'risu.db'), {
      readOnly: true,
    })
    try {
      expect(backupDb.prepare('SELECT id FROM request_history').all()).toEqual([{ id: 'snapshot-history' }])
    } finally {
      backupDb.close()
    }

    const liveDb = new DatabaseSync(liveDbPath)
    try {
      liveDb.exec('DELETE FROM request_history')
      insertRequestHistory(liveDb, 'live-history', 'live prompt', 'live response')
    } finally {
      liveDb.close()
    }

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const verify = new DatabaseSync(liveDbPath, { readOnly: true })
    try {
      expect(verify.prepare('SELECT id FROM request_history').all()).toEqual([])
    } finally {
      verify.close()
    }
  })

  it('restores retry and tombstone snapshot state while preserving live push subscriptions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, {
      characters: [
        {
          chaId: 'durability-character',
          name: 'Durability Character',
          chats: [
            {
              id: 'durability-chat',
              name: 'Durability Chat',
              note: '',
              localLore: [],
              message: [{ role: 'user', data: 'remember this', chatId: 'durability-message' }],
              hypaV3Data: {
                summaries: [{ text: 'Snapshot A legacy summary', chatMemos: ['durability-message'] }],
              },
            },
          ],
        },
      ],
    })

    const liveDbPath = path.join(harness.dataDir, 'risu.db')
    const seedSnapshotA = new DatabaseSync(liveDbPath)
    let tombstoneA: { summary_id: string; chat_id: string; deleted_at: string }
    let retryA: Record<string, unknown>
    try {
      const legacySummary = seedSnapshotA
        .prepare("SELECT id FROM memory_summaries WHERE text = 'Snapshot A legacy summary'")
        .get() as { id: string }
      seedSnapshotA.prepare('DELETE FROM memory_summaries WHERE id = ?').run(legacySummary.id)
      insertFinalizationRetry(seedSnapshotA, 'generation-A', 'durability-chat')
      insertPushSubscription(seedSnapshotA, 'https://push.example/snapshot-A')
      tombstoneA = seedSnapshotA
        .prepare(
          `SELECT summary_id, chat_id, deleted_at
           FROM memory_legacy_summary_tombstones
           WHERE summary_id = ?`,
        )
        .get(legacySummary.id) as typeof tombstoneA
      retryA = seedSnapshotA
        .prepare('SELECT * FROM generation_finalization_retries WHERE generation_id = ?')
        .get('generation-A') as Record<string, unknown>
    } finally {
      seedSnapshotA.close()
    }

    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'durability ownership snapshot A' },
    })
    expect(backup.statusCode).toBe(201)

    const seedLiveB = new DatabaseSync(liveDbPath)
    try {
      seedLiveB.exec(`
        DELETE FROM generation_finalization_retries;
        DELETE FROM memory_legacy_summary_tombstones;
        DELETE FROM push_subscriptions;
      `)
      insertFinalizationRetry(seedLiveB, 'generation-B', 'live-chat-B')
      seedLiveB
        .prepare(
          `INSERT INTO memory_legacy_summary_tombstones (summary_id, chat_id, deleted_at)
           VALUES (?, ?, ?)`,
        )
        .run('summary-B', 'live-chat-B', '2026-07-23T01:00:00.000Z')
      insertPushSubscription(seedLiveB, 'https://push.example/live-B')
    } finally {
      seedLiveB.close()
    }

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const verify = new DatabaseSync(liveDbPath)
    try {
      expect(verify.prepare('SELECT * FROM generation_finalization_retries').all()).toEqual([retryA])
      expect(
        verify.prepare('SELECT summary_id, chat_id, deleted_at FROM memory_legacy_summary_tombstones').all(),
      ).toEqual([tombstoneA])
      expect(verify.prepare('SELECT endpoint, subscription_json FROM push_subscriptions').all()).toEqual([
        {
          endpoint: 'https://push.example/live-B',
          subscription_json: JSON.stringify({
            endpoint: 'https://push.example/live-B',
            keys: {
              p256dh: 'p256dh-https://push.example/live-B',
              auth: 'auth-https://push.example/live-B',
            },
          }),
        },
      ])
    } finally {
      verify.close()
    }

    await restartHarness(harness)
    const afterRestart = new DatabaseSync(liveDbPath)
    try {
      expect(
        afterRestart.prepare("SELECT id FROM memory_summaries WHERE text = 'Snapshot A legacy summary'").all(),
      ).toEqual([])
      expect(
        afterRestart.prepare('SELECT summary_id, chat_id, deleted_at FROM memory_legacy_summary_tombstones').all(),
      ).toEqual([tombstoneA])
    } finally {
      afterRestart.close()
    }
  })

  it('round-trips the operation ledger and rewrites every protocol lineage before boot reconciliation', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, {
      characters: [
        {
          chaId: 'operation-character',
          name: 'Operation Character',
          chats: [
            {
              id: 'operation-chat',
              name: 'Operation Chat',
              note: '',
              localLore: [],
              message: [
                { role: 'user', data: 'accepted', chatId: 'operation-user' },
                { role: 'char', data: 'persisted result', chatId: 'operation-result' },
              ],
            },
          ],
        },
      ],
    })

    const liveDbPath = path.join(harness.dataDir, 'risu.db')
    const seed = new DatabaseSync(liveDbPath)
    let originalLineage: string
    let originalProjectionEpoch: number
    try {
      seed.exec('PRAGMA foreign_keys = ON')
      originalLineage = getDatabaseLineage(seed)
      createGenerationOperation(seed, {
        databaseLineage: originalLineage,
        operationId: 'operation-round-trip',
        protocolVersion: 1,
        requestOrigin: 'accepted_send',
        creatorWriterSessionId: 'writer-round-trip',
        creatorWriterEpoch: 3,
        bindingServerInstanceId: 'server-before-backup',
        characterId: 'operation-character',
        chatId: 'operation-chat',
        mode: 'send',
        acceptedMessageId: 'operation-user',
        requestFingerprint: 'b'.repeat(64),
        intent: { mode: 'send' },
        acceptedRevision: 1,
        state: 'accepted',
      })
      reserveGenerationOperationAttempt(seed, {
        databaseLineage: originalLineage,
        operationId: 'operation-round-trip',
        expectedState: 'accepted',
        expectedStateVersion: 1,
        retryRequestId: 'operation-round-trip',
        jobId: 'job-round-trip',
        serverInstanceId: 'server-before-backup',
        actorWriterSessionId: 'writer-round-trip',
        actorWriterEpoch: 3,
        launchRevision: 1,
      })
      transitionGenerationOperation(seed, {
        databaseLineage: originalLineage,
        operationId: 'operation-round-trip',
        expectedState: 'launching',
        expectedStateVersion: 2,
        nextState: 'owned_by_job',
      })
      seed
        .prepare(
          `
          UPDATE messages
          SET json = json_set(
            json,
            '$.generationInfo',
            json(?)
          )
          WHERE uid = 'operation-result'
        `,
        )
        .run(JSON.stringify({ databaseLineage: originalLineage, operationId: 'operation-round-trip' }))
      insertFinalizationRetry(seed, 'job-round-trip', 'operation-chat')
      seed
        .prepare(
          `
          UPDATE generation_finalization_retries
          SET database_lineage = ?, operation_id = 'operation-round-trip', operation_attempt_no = 1,
              actor_writer_session_id = 'writer-round-trip', actor_writer_epoch = 3,
              accepted_message_id = 'operation-user', terminal_outcome = 'completed'
          WHERE generation_id = 'job-round-trip'
        `,
        )
        .run(originalLineage)
      seed
        .prepare(
          `
          UPDATE command_events
          SET database_lineage = ?, operation_id = 'operation-round-trip',
              source_message_id = 'operation-user', job_id = 'job-round-trip'
          WHERE revision = 1
        `,
        )
        .run(originalLineage)
      originalProjectionEpoch = (
        seed.prepare('SELECT epoch FROM generation_operation_projection_state WHERE id = 1').get() as { epoch: number }
      ).epoch
    } finally {
      seed.close()
    }

    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'operation ledger round trip' },
    })
    expect(backup.statusCode).toBe(201)

    const replaceLive = new DatabaseSync(liveDbPath)
    try {
      replaceLive.exec(`
        DELETE FROM generation_operation_attempts;
        DELETE FROM generation_operations;
        DELETE FROM generation_finalization_retries;
      `)
    } finally {
      replaceLive.close()
    }

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)
    const restoredLineage = restored.json().databaseLineage as string
    expect(restoredLineage).not.toBe(originalLineage)

    const verify = new DatabaseSync(liveDbPath, { readOnly: true })
    try {
      expect(
        verify
          .prepare(
            `SELECT database_lineage, state, state_version, projection_epoch, result_message_id
             FROM generation_operations WHERE operation_id = 'operation-round-trip'`,
          )
          .get(),
      ).toEqual({
        database_lineage: restoredLineage,
        state: 'completed',
        state_version: 4,
        projection_epoch: expect.any(Number),
        result_message_id: 'operation-result',
      })
      const projectionEpoch = (
        verify.prepare('SELECT epoch FROM generation_operation_projection_state WHERE id = 1').get() as {
          epoch: number
        }
      ).epoch
      expect(projectionEpoch).toBeGreaterThan(originalProjectionEpoch)
      expect(
        verify
          .prepare(
            `SELECT database_lineage, status FROM generation_operation_attempts
             WHERE operation_id = 'operation-round-trip'`,
          )
          .get(),
      ).toEqual({ database_lineage: restoredLineage, status: 'completed' })
      expect(
        verify
          .prepare(
            `SELECT database_lineage, operation_id, operation_attempt_no, terminal_outcome
             FROM generation_finalization_retries WHERE generation_id = 'job-round-trip'`,
          )
          .get(),
      ).toEqual({
        database_lineage: restoredLineage,
        operation_id: 'operation-round-trip',
        operation_attempt_no: 1,
        terminal_outcome: 'completed',
      })
      expect(
        verify
          .prepare(
            `SELECT database_lineage, operation_id, source_message_id, job_id
             FROM command_events WHERE operation_id = 'operation-round-trip'`,
          )
          .get(),
      ).toEqual({
        database_lineage: restoredLineage,
        operation_id: 'operation-round-trip',
        source_message_id: 'operation-user',
        job_id: 'job-round-trip',
      })
      const restoredMessage = verify.prepare("SELECT json FROM messages WHERE uid = 'operation-result'").get() as {
        json: string
      }
      expect(JSON.parse(restoredMessage.json)).toMatchObject({
        generationInfo: {
          databaseLineage: restoredLineage,
          operationId: 'operation-round-trip',
        },
      })
    } finally {
      verify.close()
    }
  })

  it('restores historical retry tables with schema-aware defaults', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'historical-queue-backup' })
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'historical queue shape' },
    })
    expect(backup.statusCode).toBe(201)

    const backupDb = new DatabaseSync(path.join(harness.dataDir, 'backups', backup.json().id, 'risu.db'))
    try {
      backupDb.exec(`
        DROP TABLE generation_finalization_retries;
        CREATE TABLE generation_finalization_retries (
          generation_id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          target_message_id TEXT,
          message_json TEXT NOT NULL,
          chat_var_mutations_json TEXT NOT NULL,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          terminal_error TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO generation_finalization_retries (
          generation_id,
          chat_id,
          mode,
          target_message_id,
          message_json,
          chat_var_mutations_json,
          failure_count,
          last_error,
          terminal_error,
          status,
          created_at,
          updated_at
        ) VALUES (
          'generation-old',
          'chat-old',
          'continue',
          'target-old',
          '{"role":"char","data":"historical payload","chatId":"message-old"}',
          '[{"key":"historical","value":"retained"}]',
          3,
          'historical failure',
          'historical terminal failure',
          'terminal',
          '2026-07-20T00:00:00.000Z',
          '2026-07-20T00:00:01.000Z'
        );
      `)
    } finally {
      backupDb.close()
    }

    const live = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      insertFinalizationRetry(live, 'generation-live', 'chat-live')
    } finally {
      live.close()
    }

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const verify = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(
        verify
          .prepare(
            `SELECT generation_id, chat_id, mode, target_message_id, message_json,
                    alternate_messages_json, chat_var_mutations_json, target_snapshot_json,
                    failure_count, last_error, terminal_error, status, created_at, updated_at
             FROM generation_finalization_retries`,
          )
          .all(),
      ).toEqual([
        {
          generation_id: 'generation-old',
          chat_id: 'chat-old',
          mode: 'continue',
          target_message_id: 'target-old',
          message_json: '{"role":"char","data":"historical payload","chatId":"message-old"}',
          alternate_messages_json: '[]',
          chat_var_mutations_json: '[{"key":"historical","value":"retained"}]',
          target_snapshot_json: null,
          failure_count: 3,
          last_error: 'historical failure',
          terminal_error: 'historical terminal failure',
          status: 'terminal',
          created_at: '2026-07-20T00:00:00.000Z',
          updated_at: '2026-07-20T00:00:01.000Z',
        },
      ])
    } finally {
      verify.close()
    }
  })

  it('quarantines a restored unfenced continue retry after the target is edited without replaying or pruning it', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          type: 'character',
          chaId: 'legacy-character',
          name: 'Legacy Character',
          chatPage: 0,
          chats: [
            {
              id: 'legacy-chat',
              name: 'Legacy Chat',
              note: '',
              localLore: [],
              message: [
                { role: 'user', data: 'story', chatId: 'legacy-user' },
                { role: 'char', data: 'original target', chatId: 'legacy-target' },
              ],
            },
          ],
        },
      ],
    })
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'legacy unfenced continue retry' },
    })
    expect(backup.statusCode).toBe(201)

    const backupDb = new DatabaseSync(path.join(harness.dataDir, 'backups', backup.json().id, 'risu.db'))
    try {
      backupDb.exec(`
        DROP TABLE generation_finalization_retries;
        CREATE TABLE generation_finalization_retries (
          generation_id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          target_message_id TEXT,
          message_json TEXT NOT NULL,
          chat_var_mutations_json TEXT NOT NULL,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          terminal_error TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO generation_finalization_retries (
          generation_id,
          chat_id,
          mode,
          target_message_id,
          message_json,
          chat_var_mutations_json,
          status,
          created_at,
          updated_at
        ) VALUES (
          'legacy-continue-generation',
          'legacy-chat',
          'continue',
          'legacy-target',
          '{"role":"char","data":"unsafe restored replacement","chatId":"legacy-target"}',
          '[]',
          'pending',
          '2026-07-20T00:00:00.000Z',
          '2026-07-20T00:00:01.000Z'
        );
      `)
    } finally {
      backupDb.close()
    }

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    const edited = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/legacy-target',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: bootstrap.json().revision,
        patch: { data: 'newer edit after restore' },
      },
    })
    expect(edited.statusCode).toBe(200)

    const liveDbPath = path.join(harness.dataDir, 'risu.db')
    const liveDb = new DatabaseSync(liveDbPath)
    try {
      expect(
        retryQueuedGenerationFinalizations({
          db: liveDb,
          dataDir: harness.dataDir,
          eventSink: harness.commandEvents,
          messageTranslationJobs: new MessageTranslationJobRegistry(),
        }),
      ).toEqual({ attempted: 1, persisted: 0, terminal: 1, retryable: 0 })

      expect(
        liveDb
          .prepare(
            `SELECT status, failure_count, last_error, terminal_error, target_snapshot_json
             FROM generation_finalization_retries
             WHERE generation_id = 'legacy-continue-generation'`,
          )
          .get(),
      ).toEqual({
        status: 'terminal',
        failure_count: 1,
        last_error: GENERATION_FINALIZATION_LEGACY_SNAPSHOT_ERROR,
        terminal_error: GENERATION_FINALIZATION_LEGACY_SNAPSHOT_ERROR,
        target_snapshot_json: null,
      })
      expect(liveDb.prepare("SELECT data FROM messages WHERE uid = 'legacy-target'").get()).toEqual({
        data: 'newer edit after restore',
      })
      expect(
        liveDb.prepare("SELECT COUNT(*) AS count FROM messages WHERE data = 'unsafe restored replacement'").get(),
      ).toEqual({ count: 0 })

      expect(
        liveDb
          .prepare(
            "SELECT generation_id FROM generation_finalization_retries WHERE generation_id = 'legacy-continue-generation'",
          )
          .get(),
      ).toEqual({ generation_id: 'legacy-continue-generation' })
    } finally {
      liveDb.close()
    }
  })

  it('clears snapshot-owned rows when an older backup lacks durability or greeting tables', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'pre-durability-tables' })
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'backup before durability tables' },
    })
    expect(backup.statusCode).toBe(201)

    const backupDb = new DatabaseSync(path.join(harness.dataDir, 'backups', backup.json().id, 'risu.db'))
    try {
      backupDb.exec(`
        DROP TABLE generation_finalization_retries;
        DROP TRIGGER tombstone_deleted_legacy_memory_summary;
        DROP TABLE memory_legacy_summary_tombstones;
        DROP TABLE greeting_translations;
      `)
    } finally {
      backupDb.close()
    }

    const live = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      insertFinalizationRetry(live, 'generation-live', 'chat-live')
      live
        .prepare(
          `INSERT INTO memory_legacy_summary_tombstones (summary_id, chat_id, deleted_at)
           VALUES ('summary-live', 'chat-live', '2026-07-23T02:00:00.000Z')`,
        )
        .run()
    } finally {
      live.close()
    }

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const verify = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(verify.prepare('SELECT * FROM generation_finalization_retries').all()).toEqual([])
      expect(verify.prepare('SELECT * FROM memory_legacy_summary_tombstones').all()).toEqual([])
      expect(verify.prepare('SELECT * FROM greeting_translations').all()).toEqual([])
    } finally {
      verify.close()
    }
  })

  it('snapshots pre-restore state and also protects restores of automatic snapshots', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'A' })
    await importDb(harness.app, assertion, { tag: 'B' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await importDb(harness.app, assertion, { tag: 'C' })

    const beforeRestore = listBackups(harness.dataDir).filter((backup) => backup.kind === 'automatic')
    const automaticA = beforeRestore.find((backup) => readBackupDatabase(harness.dataDir, backup.id).tag === 'A')
    expect(automaticA).toMatchObject({
      kind: 'automatic',
      label: 'Automatic safety snapshot',
    })

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${automaticA!.id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const afterRestore = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(afterRestore.resourceDatabase).toMatchObject({ tag: 'A' })

    const automaticAfter = listBackups(harness.dataDir).filter((backup) => backup.kind === 'automatic')
    expect(automaticAfter.some((backup) => backup.id === automaticA!.id)).toBe(true)
    expect(automaticAfter.some((backup) => readBackupDatabase(harness.dataDir, backup.id).tag === 'C')).toBe(true)
  })

  it('prunes only the oldest automatic snapshots beyond the configured cap', async () => {
    const capped = await startHarness(2)
    try {
      const { assertion } = await setupAuthedClient(capped.app)
      await importDb(capped.app, assertion, { tag: 'A' })
      const manual = await capped.app.inject({
        method: 'POST',
        url: '/api/v1/backups',
        headers: { 'risu-auth': assertion },
        payload: { label: 'manual A' },
      })
      expect(manual.statusCode).toBe(201)

      await new Promise((resolve) => setTimeout(resolve, 5))
      await importDb(capped.app, assertion, { tag: 'B' })
      await new Promise((resolve) => setTimeout(resolve, 5))
      await importDb(capped.app, assertion, { tag: 'C' })
      await new Promise((resolve) => setTimeout(resolve, 5))
      await importDb(capped.app, assertion, { tag: 'D' })

      const backups = listBackups(capped.dataDir)
      expect(backups.find((backup) => backup.id === manual.json().id)).toMatchObject({
        kind: 'manual',
        label: 'manual A',
      })
      const automatic = backups.filter((backup) => backup.kind === 'automatic')
      expect(automatic).toHaveLength(2)
      expect(automatic.map((backup) => readBackupDatabase(capped.dataDir, backup.id).tag).sort()).toEqual(['B', 'C'])
    } finally {
      await stopHarness(capped)
    }
  })

  it('fails restore closed when its safety snapshot cannot be created', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'A' })
    const manual = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'restore target A' },
    })
    expect(manual.statusCode).toBe(201)
    await importDb(harness.app, assertion, { tag: 'B' })

    const originalWriteFile = fs.promises.writeFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      if (
        String(file).endsWith(`${path.sep}.manifest.json`) &&
        String(file).includes(`${path.sep}backups${path.sep}`) &&
        String(data).includes('"kind":"automatic"')
      ) {
        throw new Error('injected automatic backup manifest failure')
      }
      return originalWriteFile(file, data, options)
    })

    const automaticBefore = listBackups(harness.dataDir).filter((backup) => backup.kind === 'automatic')
    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${manual.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(500)
    expect(restored.json()).toEqual({ error: 'automatic_backup_failed' })

    const after = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(after.resourceDatabase).toMatchObject({ tag: 'B' })
    expect(listBackups(harness.dataDir).filter((backup) => backup.kind === 'automatic')).toEqual(automaticBefore)
  })

  it.each([
    {
      name: 'manifest-only backup',
      id: '2026-07-21-01-02-03-a0a0a0',
      expectedError: 'backup_database_missing',
      prepareDatabasePayload: (_backupRoot: string) => {},
    },
    {
      name: 'zero-byte SQLite backup',
      id: '2026-07-21-01-02-04-b0b0b0',
      expectedError: 'backup_database_invalid',
      prepareDatabasePayload: (backupRoot: string) => {
        writeFileSync(path.join(backupRoot, 'risu.db'), '')
      },
    },
    {
      name: 'SQLite backup without core tables',
      id: '2026-07-21-01-02-05-c0c0c0',
      expectedError: 'backup_database_invalid',
      prepareDatabasePayload: (backupRoot: string) => {
        const guttedDb = new DatabaseSync(path.join(backupRoot, 'risu.db'))
        try {
          guttedDb.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)')
        } finally {
          guttedDb.close()
        }
      },
    },
    {
      name: 'legacy backup whose database is not an object',
      id: '2026-07-21-01-02-06-d0d0d0',
      expectedError: 'backup_database_invalid',
      prepareDatabasePayload: (backupRoot: string) => {
        writeFileSync(path.join(backupRoot, 'db.json'), JSON.stringify({ database: [] }))
      },
    },
  ])('rejects a $name before touching live data or restore staging', async (testCase) => {
    const { assertion } = await setupAuthedClient(harness.app)
    const liveTag = `live-before-${testCase.id}`
    await importDb(harness.app, assertion, { tag: liveTag })

    const liveAssetFile = path.join(assetsDir(harness.dataDir), 'live-sentinel.bin')
    const liveSaveFile = path.join(harness.dataDir, 'save', 'live-sentinel')
    mkdirSync(path.dirname(liveAssetFile), { recursive: true })
    mkdirSync(path.dirname(liveSaveFile), { recursive: true })
    writeFileSync(liveAssetFile, 'live-asset')
    writeFileSync(liveSaveFile, 'live-save')

    const backupRoot = path.join(harness.dataDir, 'backups', testCase.id)
    mkdirSync(backupRoot, { recursive: true })
    writeFileSync(
      path.join(backupRoot, 'manifest.json'),
      JSON.stringify({ id: testCase.id, createdAt: '2026-07-21T01:02:03.000Z' }),
    )
    testCase.prepareDatabasePayload(backupRoot)

    const restoreScratchDirs = [
      path.join(harness.dataDir, `.assets-${testCase.id}.tmp`),
      path.join(harness.dataDir, `.assets-${testCase.id}.old`),
      path.join(harness.dataDir, `.save-${testCase.id}.tmp`),
      path.join(harness.dataDir, `.save-${testCase.id}.old`),
    ]
    for (const scratchDir of restoreScratchDirs) {
      mkdirSync(scratchDir, { recursive: true })
      writeFileSync(path.join(scratchDir, 'untouched'), 'sentinel')
    }

    const before = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const revisionBefore = before.json().revision as number
    harness.commandEvents.clear()

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${testCase.id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(400)
    expect(restored.json()).toEqual({ error: testCase.expectedError })
    expect(listBackups(harness.dataDir).filter((backup) => backup.kind === 'automatic')).toEqual([])

    const after = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(after.json().revision).toBe(revisionBefore)
    expect(after.resourceDatabase).toMatchObject({ tag: liveTag })
    expect(readFileSync(liveAssetFile, 'utf8')).toBe('live-asset')
    expect(readFileSync(liveSaveFile, 'utf8')).toBe('live-save')
    for (const scratchDir of restoreScratchDirs) {
      expect(readFileSync(path.join(scratchDir, 'untouched'), 'utf8')).toBe('sentinel')
    }
    expect(harness.commandEvents.list()).toEqual([])
  })

  it('refuses to overwrite an unjournaled parked directory from an earlier restore attempt', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'restore-source-A' })
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'unjournaled scratch target' },
    })
    const backupId = backup.json().id as string
    await importDb(harness.app, assertion, { tag: 'live-B' })

    const parkedAssets = path.join(harness.dataDir, `.assets-${backupId}.old`)
    mkdirSync(parkedAssets, { recursive: true })
    writeFileSync(path.join(parkedAssets, 'only-surviving-copy'), 'preserve-me')

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })

    expect(restored.statusCode).toBe(500)
    expect(readFileSync(path.join(parkedAssets, 'only-surviving-copy'), 'utf8')).toBe('preserve-me')
    expect(existsSync(path.join(harness.dataDir, `.restore-journal-${backupId}.json`))).toBe(false)
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({ tag: 'live-B' })
  })

  it('repairs stable lorebook ids while restoring a pre-v23 SQLite backup', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const legacyEntry = {
      id: 'entry-before-backup',
      key: 'legacy',
      secondkey: '',
      insertorder: 100,
      comment: 'Legacy entry',
      content: 'before backup',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    await importDb(harness.app, assertion, {
      tag: 'pre-v23',
      loreBook: [{ id: 'book-before-backup', name: 'Legacy book', data: [legacyEntry] }],
    })
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'pre-v23 lorebook' },
    })
    expect(backup.statusCode).toBe(201)

    const backupDb = new DatabaseSync(path.join(harness.dataDir, 'backups', backup.json().id, 'risu.db'))
    try {
      const row = backupDb.prepare('SELECT data_json FROM lore_books WHERE position = 0').get() as {
        data_json: string
      }
      const idlessLorebook = JSON.parse(row.data_json) as {
        id?: string
        data: Array<{ id?: string }>
      }
      delete idlessLorebook.id
      delete idlessLorebook.data[0].id
      backupDb.prepare('UPDATE lore_books SET data_json = ? WHERE position = 0').run(JSON.stringify(idlessLorebook))
      backupDb.prepare('UPDATE schema_version SET version = 22 WHERE id = 1').run()
    } finally {
      backupDb.close()
    }

    await importDb(harness.app, assertion, { tag: 'live-after-backup' })
    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const restoredLorebook = bootstrap.resourceDatabase.loreBook[0] as {
      id: string
      data: Array<{ id: string }>
    }
    expect(restoredLorebook.id).toEqual(expect.any(String))
    expect(restoredLorebook.data[0].id).toEqual(expect.any(String))

    const liveDb = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(
        (liveDb.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number }).version,
      ).toBe(CURRENT_SCHEMA_VERSION)
    } finally {
      liveDb.close()
    }

    const addedEntry = { ...legacyEntry, id: 'entry-after-restore', content: 'after restore' }
    const added = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/commands/lorebooks/${encodeURIComponent(restoredLorebook.id)}/entries/${addedEntry.id}`,
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: bootstrap.json().revision, entry: addedEntry },
    })
    expect(added.statusCode).toBe(200)

    const reloaded = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(reloaded.resourceDatabase.loreBook[0]).toMatchObject({
      id: restoredLorebook.id,
      data: [
        expect.objectContaining({ id: restoredLorebook.data[0].id }),
        expect.objectContaining({ id: addedEntry.id }),
      ],
    })
  })

  it('repairs durable persona selection identity while restoring a pre-v35 SQLite backup', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, {
      tag: 'pre-v35-persona',
      selectedPersonaId: 'persona-before-backup',
      selectedPersona: 0,
      personas: [{ id: 'persona-before-backup', name: 'Before backup' }],
    })
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'pre-v35 persona identity' },
    })
    expect(backup.statusCode).toBe(201)

    const backupDb = new DatabaseSync(path.join(harness.dataDir, 'backups', backup.json().id, 'risu.db'))
    try {
      const settingsRow = backupDb.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
        data_json: string
      }
      const settings = JSON.parse(settingsRow.data_json) as Record<string, unknown>
      settings.selectedPersona = 2
      settings.selectedPersonaId = 'duplicate-persona'
      backupDb.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
      backupDb.exec('DELETE FROM personas')
      const insertPersona = backupDb.prepare('INSERT INTO personas (position, data_json) VALUES (?, ?)')
      insertPersona.run(0, JSON.stringify({ id: 'duplicate-persona', name: 'First' }))
      insertPersona.run(1, JSON.stringify({ id: 'duplicate-persona', name: 'Second' }))
      insertPersona.run(2, JSON.stringify({ name: 'Selected' }))
      backupDb.prepare('UPDATE schema_version SET version = 34 WHERE id = 1').run()
    } finally {
      backupDb.close()
    }

    await importDb(harness.app, assertion, { tag: 'live-after-persona-backup' })
    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      selectedPersona: 2,
      selectedPersonaId: 'persona-3',
      personas: [
        { id: 'duplicate-persona', name: 'First' },
        { id: 'persona-2', name: 'Second' },
        { id: 'persona-3', name: 'Selected' },
      ],
    })
  })

  it('repairs wrapped undefined stop strings even when restoring a current-version SQLite backup', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'stop-string-backup' })
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'stop strings' },
    })
    expect(backup.statusCode).toBe(201)
    const marker = { type: 0, data: { type: 'Buffer', data: [0] } }
    const tables = ['bot_presets', 'model_presets', 'prompt_presets']
    const backupDb = new DatabaseSync(path.join(harness.dataDir, 'backups', backup.json().id, 'risu.db'))
    try {
      const row = backupDb.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
      const settings = { ...JSON.parse(row.data_json), localStopStrings: marker, unrelated: marker }
      backupDb.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
      for (const table of tables) {
        backupDb
          .prepare(`INSERT OR REPLACE INTO ${table} (position, data_json) VALUES (0, ?)`)
          .run(JSON.stringify({ id: `${table}-restored`, localStopStrings: { ext: 0, data: [0] }, unrelated: marker }))
      }
    } finally {
      backupDb.close()
    }
    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode, restored.body).toBe(200)
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    try {
      const settings = JSON.parse(
        (db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }).data_json,
      )
      expect(settings).not.toHaveProperty('localStopStrings')
      expect(settings.unrelated).toEqual(marker)
      for (const table of tables) {
        const preset = JSON.parse(
          (db.prepare(`SELECT data_json FROM ${table} WHERE position = 0`).get() as { data_json: string }).data_json,
        )
        expect(preset).toEqual({ id: `${table}-restored`, unrelated: marker })
      }
    } finally {
      db.close()
    }
  })

  it('repairs a legacy numeric translator selection when restoring a SQLite backup', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, {
      tag: 'legacy-translator-selection',
      translatorPresetId: 'translator-b',
      translatorPresets: [
        { id: 'translator-a', name: 'First', prompt: 'First prompt', maxResponse: 500 },
        { id: 'translator-b', name: 'Second', prompt: 'Second prompt', maxResponse: 700 },
      ],
    })
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'legacy translator selection' },
    })
    expect(backup.statusCode).toBe(201)
    const backupDb = new DatabaseSync(path.join(harness.dataDir, 'backups', backup.json().id, 'risu.db'))
    try {
      const row = backupDb.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
      const settings = { ...JSON.parse(row.data_json), translatorPresetId: 1 }
      backupDb.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
      backupDb.exec('UPDATE schema_version SET version = 36 WHERE id = 1')
    } finally {
      backupDb.close()
    }
    await importDb(harness.app, assertion, { tag: 'after-translator-backup' })
    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      translatorPresetId: 'translator-b',
      translatorPrompt: 'Second prompt',
      translatorMaxResponse: 700,
      translatorPresets: [
        { id: 'translator-a', prompt: 'First prompt' },
        { id: 'translator-b', prompt: 'Second prompt' },
      ],
    })
  })

  it('repairs durable Hypa V3 preset identity while restoring a pre-v36 SQLite backup', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, {
      tag: 'pre-v36-hypa',
      hypaV3PresetId: 0,
      selectedHypaV3PresetId: 'memory-before-backup',
      hypaV3Presets: [{ id: 'memory-before-backup', name: 'Before backup', settings: {} }],
    })
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'pre-v36 Hypa V3 preset identity' },
    })
    expect(backup.statusCode).toBe(201)

    const backupDb = new DatabaseSync(path.join(harness.dataDir, 'backups', backup.json().id, 'risu.db'))
    try {
      const settingsRow = backupDb.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
        data_json: string
      }
      const settings = JSON.parse(settingsRow.data_json) as Record<string, unknown>
      settings.hypaV3PresetId = 2
      settings.selectedHypaV3PresetId = 'duplicate-memory'
      backupDb.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
      backupDb.exec('DELETE FROM hypa_v3_presets')
      const insertPreset = backupDb.prepare('INSERT INTO hypa_v3_presets (position, data_json) VALUES (?, ?)')
      insertPreset.run(0, JSON.stringify({ id: 'duplicate-memory', name: 'First', settings: {} }))
      insertPreset.run(1, JSON.stringify({ id: 'duplicate-memory', name: 'Second', settings: {} }))
      insertPreset.run(2, JSON.stringify({ name: 'Selected', settings: {} }))
      backupDb.prepare('UPDATE schema_version SET version = 35 WHERE id = 1').run()
    } finally {
      backupDb.close()
    }

    await importDb(harness.app, assertion, { tag: 'live-after-hypa-backup' })
    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      hypaV3PresetId: 2,
      selectedHypaV3PresetId: 'hypa-v3-preset-3',
      hypaV3Presets: [
        { id: 'duplicate-memory', name: 'First' },
        { id: 'hypa-v3-preset-2', name: 'Second' },
        { id: 'hypa-v3-preset-3', name: 'Selected' },
      ],
    })
  })

  it('round-trips split model and prompt preset tables with backup/restore', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, {
      tag: 'preset-A',
      modelPresetsId: 0,
      modelPresets: [{ id: 'model-A', name: 'Model A', aiModel: 'model-before-backup' }],
      promptPresetsId: 0,
      promptPresets: [{ id: 'prompt-A', name: 'Prompt A', promptTemplate: [{ role: 'system', content: 'A' }] }],
    })
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'preset snapshot A' },
    })
    expect(backup.statusCode).toBe(201)
    const backupId = backup.json().id

    await importDb(harness.app, assertion, {
      tag: 'preset-B',
      modelPresetsId: 0,
      modelPresets: [{ id: 'model-B', name: 'Model B', aiModel: 'model-after-backup' }],
      promptPresetsId: 0,
      promptPresets: [{ id: 'prompt-B', name: 'Prompt B', promptTemplate: [{ role: 'system', content: 'B' }] }],
    })
    const beforeRestore = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(beforeRestore.resourceDatabase).toMatchObject({
      tag: 'preset-B',
      modelPresets: [{ id: 'model-B', name: 'Model B', aiModel: 'model-after-backup' }],
      promptPresets: [{ id: 'prompt-B', name: 'Prompt B' }],
    })

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const afterRestore = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(afterRestore.resourceDatabase).toMatchObject({
      tag: 'preset-A',
      modelPresetsId: 0,
      modelPresets: [{ id: 'model-A', name: 'Model A', aiModel: 'model-before-backup' }],
      promptPresetsId: 0,
      promptPresets: [{ id: 'prompt-A', name: 'Prompt A' }],
    })
  })

  it('keeps pre-restore state when restore event persistence fails', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'A' })
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'snapshot of A' },
    })
    expect(backup.statusCode).toBe(201)
    const backupId = backup.json().id
    await importDb(harness.app, assertion, { tag: 'B' })
    harness.commandEvents.clear()
    failCommandEventPersistence(harness.dataDir)

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })

    expect(restored.statusCode).toBe(500)
    expect(harness.commandEvents.list()).toEqual([])
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(2)
    expect(bootstrap.resourceDatabase).toMatchObject({
      tag: 'B',
      characters: [],
      botPresets: [],
      modules: [],
      loadouts: [],
      plugins: [],
      pluginCustomStorage: {},
    })
  })

  it('recovers backward on boot after a crash between the live-directory renames', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'restore-source-A' })
    const liveAssetFile = path.join(harness.dataDir, 'assets', 'swap-sentinel')
    const liveSaveFile = path.join(harness.dataDir, 'save', 'swap-sentinel')
    mkdirSync(path.dirname(liveAssetFile), { recursive: true })
    mkdirSync(path.dirname(liveSaveFile), { recursive: true })
    writeFileSync(liveAssetFile, 'asset-A')
    writeFileSync(liveSaveFile, 'save-A')
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'directory swap A' },
    })
    const backupId = backup.json().id as string

    await importDb(harness.app, assertion, { tag: 'live-B' })
    writeFileSync(liveAssetFile, 'asset-B')
    writeFileSync(liveSaveFile, 'save-B')
    const oldAssets = path.join(harness.dataDir, `.assets-${backupId}.old`)
    const oldSave = path.join(harness.dataDir, `.save-${backupId}.old`)
    const originalRenameSync = fs.renameSync.bind(fs)
    const originalCpSync = fs.cpSync.bind(fs)
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(source) === path.dirname(liveSaveFile) && String(destination) === oldSave) {
        throw new Error('injected crash between live-directory renames')
      }
      return originalRenameSync(source, destination)
    })
    const cpSpy = vi.spyOn(fs, 'cpSync').mockImplementation((source, destination, options) => {
      if (String(source) === oldAssets && String(destination) === path.dirname(liveAssetFile)) {
        throw new Error('injected interrupted rollback')
      }
      return originalCpSync(source, destination, options)
    })

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(500)
    expect(existsSync(path.join(harness.dataDir, `.restore-journal-${backupId}.json`))).toBe(true)
    expect(existsSync(oldAssets)).toBe(true)

    renameSpy.mockRestore()
    cpSpy.mockRestore()
    await restartHarness(harness)

    const afterBoot = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(afterBoot.resourceDatabase).toMatchObject({ tag: 'live-B' })
    expect(readFileSync(liveAssetFile, 'utf8')).toBe('asset-B')
    expect(readFileSync(liveSaveFile, 'utf8')).toBe('save-B')
    expect(existsSync(path.join(harness.dataDir, `.restore-journal-${backupId}.json`))).toBe(false)
    expect(existsSync(oldAssets)).toBe(false)
    expect(existsSync(oldSave)).toBe(false)
  })

  it('recovers forward on boot after the database commits but old-directory cleanup crashes', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'restore-source-A' })
    const liveAssetFile = path.join(harness.dataDir, 'assets', 'forward-sentinel')
    const liveSaveFile = path.join(harness.dataDir, 'save', 'forward-sentinel')
    mkdirSync(path.dirname(liveAssetFile), { recursive: true })
    mkdirSync(path.dirname(liveSaveFile), { recursive: true })
    writeFileSync(liveAssetFile, 'asset-A')
    writeFileSync(liveSaveFile, 'save-A')
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'committed swap A' },
    })
    const backupId = backup.json().id as string

    await importDb(harness.app, assertion, { tag: 'live-B' })
    writeFileSync(liveAssetFile, 'asset-B')
    writeFileSync(liveSaveFile, 'save-B')
    const oldAssets = path.join(harness.dataDir, `.assets-${backupId}.old`)
    const originalRmSync = fs.rmSync.bind(fs)
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === oldAssets) throw new Error('injected crash after SQLite commit')
      return originalRmSync(target, options)
    })

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(500)
    expect(existsSync(path.join(harness.dataDir, `.restore-journal-${backupId}.json`))).toBe(true)
    expect(readFileSync(liveAssetFile, 'utf8')).toBe('asset-A')
    expect(readFileSync(liveSaveFile, 'utf8')).toBe('save-A')

    rmSpy.mockRestore()
    await restartHarness(harness)

    const afterBoot = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(afterBoot.resourceDatabase).toMatchObject({ tag: 'restore-source-A' })
    expect(readFileSync(liveAssetFile, 'utf8')).toBe('asset-A')
    expect(readFileSync(liveSaveFile, 'utf8')).toBe('save-A')
    expect(existsSync(path.join(harness.dataDir, `.restore-journal-${backupId}.json`))).toBe(false)
    expect(existsSync(oldAssets)).toBe(false)
  })

  it('uses the committed lineage on boot when the post-COMMIT journal marker was not written', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'lineage-source-A' })
    const liveAssetFile = path.join(harness.dataDir, 'assets', 'lineage-sentinel')
    const liveSaveFile = path.join(harness.dataDir, 'save', 'lineage-sentinel')
    mkdirSync(path.dirname(liveAssetFile), { recursive: true })
    mkdirSync(path.dirname(liveSaveFile), { recursive: true })
    writeFileSync(liveAssetFile, 'asset-A')
    writeFileSync(liveSaveFile, 'save-A')
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'lineage marker A' },
    })
    const backupId = backup.json().id as string
    await importDb(harness.app, assertion, { tag: 'live-B' })
    writeFileSync(liveAssetFile, 'asset-B')
    writeFileSync(liveSaveFile, 'save-B')

    const journalFile = path.join(harness.dataDir, `.restore-journal-${backupId}.json`)
    const journalWritingFile = `${journalFile}.writing`
    const originalRenameSync = fs.renameSync.bind(fs)
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(source) === journalWritingFile && String(destination) === journalFile) {
        const pending = JSON.parse(readFileSync(journalWritingFile, 'utf8')) as { phase?: string }
        if (pending.phase === 'committed') throw new Error('injected crash before post-COMMIT journal marker')
      }
      return originalRenameSync(source, destination)
    })

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(500)
    expect(JSON.parse(readFileSync(journalFile, 'utf8'))).toMatchObject({
      phase: 'committing',
      expectedDatabaseLineage: expect.any(String),
    })

    renameSpy.mockRestore()
    await restartHarness(harness)

    const afterBoot = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(afterBoot.resourceDatabase).toMatchObject({ tag: 'lineage-source-A' })
    expect(readFileSync(liveAssetFile, 'utf8')).toBe('asset-A')
    expect(readFileSync(liveSaveFile, 'utf8')).toBe('save-A')
    expect(existsSync(journalFile)).toBe(false)
    expect(existsSync(journalWritingFile)).toBe(false)
  })

  it('keeps the committed database and new directories when DETACH reports a post-commit failure', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'restore-source-A' })
    const liveAssetFile = path.join(harness.dataDir, 'assets', 'detach-sentinel')
    const liveSaveFile = path.join(harness.dataDir, 'save', 'detach-sentinel')
    mkdirSync(path.dirname(liveAssetFile), { recursive: true })
    mkdirSync(path.dirname(liveSaveFile), { recursive: true })
    writeFileSync(liveAssetFile, 'asset-A')
    writeFileSync(liveSaveFile, 'save-A')
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'detach A' },
    })
    const backupId = backup.json().id as string
    await importDb(harness.app, assertion, { tag: 'live-B' })
    writeFileSync(liveAssetFile, 'asset-B')
    writeFileSync(liveSaveFile, 'save-B')

    const originalExec = DatabaseSync.prototype.exec
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      const result = originalExec.call(this, sql)
      if (sql === 'DETACH DATABASE bak') throw new Error('injected post-commit DETACH failure')
      return result
    })
    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })
    execSpy.mockRestore()
    consoleError.mockRestore()

    expect(restored.statusCode).toBe(200)
    const after = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(after.resourceDatabase).toMatchObject({ tag: 'restore-source-A' })
    expect(readFileSync(liveAssetFile, 'utf8')).toBe('asset-A')
    expect(readFileSync(liveSaveFile, 'utf8')).toBe('save-A')
    expect(existsSync(path.join(harness.dataDir, `.restore-journal-${backupId}.json`))).toBe(false)
  })

  it('round-trips chat messages and per-chat hypaV3Data (SQLite tables) with backup/restore', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, {
      characters: [
        {
          chaId: 'c',
          name: 'C',
          chats: [
            {
              id: 'chat-1',
              name: 'Chat',
              note: '',
              localLore: [],
              hypaV3Data: { marker: 'hypa-A' },
              message: [{ role: 'user', data: 'message-A', chatId: 'mA' }],
            },
          ],
        },
      ],
    })
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'msgs A' },
    })
    expect(backup.statusCode).toBe(201)
    const backupId = backup.json().id

    // Replace with a different chat/message so the messages table now holds B.
    await importDb(harness.app, assertion, {
      characters: [
        {
          chaId: 'c',
          name: 'C',
          chats: [
            {
              id: 'chat-2',
              name: 'Chat 2',
              note: '',
              localLore: [],
              hypaV3Data: { marker: 'hypa-B' },
              message: [{ role: 'user', data: 'message-B', chatId: 'mB' }],
            },
          ],
        },
      ],
    })

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const afterRestore = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const chats = afterRestore.resourceDatabase.characters[0].chats
    expect(chats).toHaveLength(1)
    expect(chats[0].id).toBe('chat-1')
    expect(chats[0].message).toEqual([]) // stub — messages hydrate on open

    // The restored chat hydrates A's message — not B's, and not empty.
    const hydration = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/chats/chat-1/messages',
      headers: { 'risu-auth': assertion },
    })
    expect(hydration.statusCode).toBe(200)
    expect(hydration.json().message).toEqual([{ role: 'user', data: 'message-A', chatId: 'mA' }])
    expect(hydration.json().hypaV3Data).toEqual({ marker: 'hypa-A' })
  })

  it('round-trips asset bytes with the backup snapshot', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const upload = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    expect(upload.statusCode).toBe(201)

    await importDb(harness.app, assertion, { userIcon: PNG_SHA })
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'asset snapshot' },
    })
    expect(backup.statusCode).toBe(201)
    const backupId = backup.json().id
    expect(readFileSync(path.join(harness.dataDir, 'backups', backupId, 'assets', `${PNG_SHA}.png`))).toEqual(PNG_BYTES)

    rmSync(assetsDir(harness.dataDir), { recursive: true, force: true })

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const asset = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${PNG_SHA}`,
    })
    expect(asset.statusCode).toBe(200)
    expect(Buffer.from(asset.rawPayload)).toEqual(PNG_BYTES)
  })

  it('keeps every snapshotted asset reference readable when an upload lands between SQLite and file copies', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const initialUpload = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { 'content-type': 'image/png', 'risu-auth': assertion },
      payload: PNG_BYTES,
    })
    expect(initialUpload.statusCode).toBe(201)

    const concurrentBytes = Buffer.from('/* tier-4 concurrent backup asset */')
    let concurrentAssetId = ''
    let injected = false
    const liveAssets = assetsDir(harness.dataDir)
    const originalCopyBatch = BackupCopyPool.prototype.runBatch
    const copySpy = vi.spyOn(BackupCopyPool.prototype, 'runBatch').mockImplementation(async function (
      this: BackupCopyPool,
      entries,
    ) {
      if (
        !injected &&
        entries.some(
          (entry) =>
            entry.from.startsWith(`${liveAssets}${path.sep}`) && entry.to.includes(`${path.sep}backups${path.sep}`),
        )
      ) {
        injected = true
        const concurrentDb = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
        try {
          concurrentAssetId = addAsset(concurrentDb, harness.dataDir, {
            bytes: concurrentBytes,
            contentType: 'text/css',
          }).entry.id
        } finally {
          concurrentDb.close()
        }
      }
      return originalCopyBatch.call(this, entries)
    })

    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'concurrent asset boundary' },
    })
    copySpy.mockRestore()
    expect(backup.statusCode).toBe(201)
    expect(injected).toBe(true)
    expect(backup.json().assetCount).toBe(1)

    const backupRoot = path.join(harness.dataDir, 'backups', backup.json().id)
    const backupDb = new DatabaseSync(path.join(backupRoot, 'risu.db'), { readOnly: true })
    try {
      const snapshottedAssets = getAllAssetMetadata(backupDb)
      expect(snapshottedAssets.map((asset) => asset.id)).toEqual([PNG_SHA])
      for (const asset of snapshottedAssets) {
        expect(existsSync(path.join(backupRoot, 'assets', `${asset.id}.${asset.ext}`))).toBe(true)
      }
    } finally {
      backupDb.close()
    }

    // The directory copy can include a T2 upload that the T1 SQLite snapshot
    // does not index. It is a harmless extra on restore: authoritative metadata
    // never points at missing bytes, and the later file remains unreachable.
    expect(readFileSync(path.join(backupRoot, 'assets', `${concurrentAssetId}.css`))).toEqual(concurrentBytes)
    rmSync(liveAssets, { recursive: true, force: true })
    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const snapshottedAsset = await harness.app.inject({ method: 'GET', url: `/api/v1/assets/${PNG_SHA}` })
    expect(snapshottedAsset.statusCode).toBe(200)
    expect(Buffer.from(snapshottedAsset.rawPayload)).toEqual(PNG_BYTES)
    const unindexedExtra = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${concurrentAssetId}`,
    })
    expect(unindexedExtra.statusCode).toBe(404)
  })

  it('clears device-local request history when restoring a legacy JSON backup', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const liveDbPath = path.join(harness.dataDir, 'risu.db')
    const liveDb = new DatabaseSync(liveDbPath)
    try {
      insertRequestHistory(liveDb, 'live-legacy-history', 'legacy live prompt', 'legacy live response')
    } finally {
      liveDb.close()
    }

    const backupId = '2026-06-03-00-00-00-aabbcc'
    const backupRoot = path.join(harness.dataDir, 'backups', backupId)
    mkdirSync(backupRoot, { recursive: true })
    writeFileSync(
      path.join(backupRoot, 'db.json'),
      JSON.stringify({ _version: 1, database: { characters: [] }, assets: [] }),
    )

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    const verify = new DatabaseSync(liveDbPath, { readOnly: true })
    try {
      expect(verify.prepare('SELECT id FROM request_history').all()).toEqual([])
    } finally {
      verify.close()
    }
  })

  it('restores a legacy db.json backup into SQLite tables', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'live-before-legacy-restore' })

    const backupId = '2026-06-03-01-02-03-abcdef'
    const backupRoot = path.join(harness.dataDir, 'backups', backupId)
    mkdirSync(path.join(backupRoot, 'assets'), { recursive: true })
    writeFileSync(path.join(backupRoot, 'assets', `${PNG_SHA}.png`), PNG_BYTES)

    const legacyAsset = {
      id: PNG_SHA,
      ext: 'png',
      size: PNG_BYTES.length,
      contentType: 'image/png',
    }
    const legacyDatabase = {
      tag: 'legacy-db-json',
      selectedPersona: 2,
      selectedPersonaId: 'duplicate-persona',
      personas: [
        { id: 'duplicate-persona', name: 'First legacy persona' },
        { id: 'duplicate-persona', name: 'Second legacy persona' },
        { name: 'Selected legacy persona' },
      ],
      modules: [{ id: 'module-a', name: 'Legacy module', assets: [['icon.png', PNG_SHA, 'png']] }],
      pluginCustomStorage: { 'plugin-a': { enabled: true } },
      characters: [
        {
          chaId: 'legacy-char',
          name: 'Legacy',
          chats: [
            {
              id: 'legacy-chat',
              name: 'Legacy chat',
              note: '',
              localLore: [],
              message: [{ role: 'user', data: 'from legacy', chatId: 'legacy-msg' }],
            },
          ],
        },
      ],
    }
    const legacySnapshotPath = path.join(backupRoot, 'db.json')
    const legacySnapshotRaw = JSON.stringify({ _version: 1, database: legacyDatabase, assets: [legacyAsset] })
    writeFileSync(legacySnapshotPath, legacySnapshotRaw)
    const copyFileSpy = vi.spyOn(fs, 'copyFileSync')

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)
    expect(existsSync(path.join(harness.dataDir, 'db.json'))).toBe(false)
    expect(existsSync(path.join(harness.dataDir, 'db.json.migrated'))).toBe(false)
    expect(readFileSync(legacySnapshotPath, 'utf8')).toBe(legacySnapshotRaw)
    expect(
      copyFileSpy.mock.calls.some(([, destination]) => String(destination) === path.join(harness.dataDir, 'db.json')),
    ).toBe(false)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.resourceDatabase).toMatchObject({
      tag: 'legacy-db-json',
      selectedPersona: 2,
      selectedPersonaId: 'persona-3',
      personas: [
        { id: 'duplicate-persona', name: 'First legacy persona' },
        { id: 'persona-2', name: 'Second legacy persona' },
        { id: 'persona-3', name: 'Selected legacy persona' },
      ],
      modules: [{ id: 'module-a', name: 'Legacy module' }],
      pluginCustomStorage: { 'plugin-a': { enabled: true } },
      characters: [{ chaId: 'legacy-char', chats: [{ id: 'legacy-chat', message: [] }] }],
    })

    const hydration = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/chats/legacy-chat/messages',
      headers: { 'risu-auth': assertion },
    })
    expect(hydration.statusCode).toBe(200)
    expect(hydration.json().message).toEqual([{ role: 'user', data: 'from legacy', chatId: 'legacy-msg' }])

    const asset = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${PNG_SHA}`,
    })
    expect(asset.statusCode).toBe(200)
    expect(Buffer.from(asset.rawPayload)).toEqual(PNG_BYTES)

    const verify = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(getAllAssetMetadata(verify)).toEqual([legacyAsset])
      expect(loadPersistedWithMessages(verify, harness.dataDir).assets).toEqual([legacyAsset])
    } finally {
      verify.close()
    }
  })

  it('rolls back a transient legacy import failure without staging a live db.json or poisoning the next boot', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'live-before-failed-legacy-restore' })

    const backupId = '2026-06-03-02-03-04-fedcba'
    const backupRoot = path.join(harness.dataDir, 'backups', backupId)
    mkdirSync(backupRoot, { recursive: true })
    const legacySnapshotPath = path.join(backupRoot, 'db.json')
    const failingAssetId = 'c'.repeat(64)
    writeFileSync(
      legacySnapshotPath,
      JSON.stringify({
        _version: 1,
        database: {
          tag: 'stale-legacy-restore',
          characters: [],
        },
        assets: [{ id: failingAssetId, ext: 'png', size: 1, contentType: 'image/png' }],
      }),
    )

    const liveDbPath = path.join(harness.dataDir, 'risu.db')
    const injectFailure = new DatabaseSync(liveDbPath)
    try {
      injectFailure.exec(`
        CREATE TRIGGER fail_legacy_restore_asset_import
        BEFORE INSERT ON assets
        WHEN NEW.id = '${failingAssetId}'
        BEGIN
          SELECT RAISE(FAIL, 'injected transient legacy restore import failure');
        END;
      `)
    } finally {
      injectFailure.close()
    }

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(500)
    expect(existsSync(path.join(harness.dataDir, 'db.json'))).toBe(false)
    expect(existsSync(path.join(harness.dataDir, 'db.json.migrated'))).toBe(false)
    expect(existsSync(legacySnapshotPath)).toBe(true)

    const afterFailure = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(afterFailure.resourceDatabase).toMatchObject({ tag: 'live-before-failed-legacy-restore' })

    const removeFailure = new DatabaseSync(liveDbPath)
    try {
      removeFailure.exec('DROP TRIGGER fail_legacy_restore_asset_import')
    } finally {
      removeFailure.close()
    }
    await importDb(harness.app, assertion, { tag: 'newer-write-after-failed-restore' })

    await restartHarness(harness)
    const afterRestart = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(afterRestart.statusCode).toBe(200)
    expect(afterRestart.resourceDatabase).toMatchObject({ tag: 'newer-write-after-failed-restore' })
    expect(existsSync(path.join(harness.dataDir, 'db.json'))).toBe(false)
  })

  it('skips a corrupt manifest instead of failing the whole backups list', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const a = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'healthy' },
    })
    expect(a.statusCode).toBe(201)

    // One corrupt (unparsable) and one misshapen (no createdAt) manifest.
    const corruptId = '2026-06-05-01-02-03-c0ffee'
    mkdirSync(path.join(harness.dataDir, 'backups', corruptId), { recursive: true })
    writeFileSync(path.join(harness.dataDir, 'backups', corruptId, 'manifest.json'), '{not valid json')
    const misshapenId = '2026-06-05-01-02-04-c0ffee'
    mkdirSync(path.join(harness.dataDir, 'backups', misshapenId), { recursive: true })
    writeFileSync(
      path.join(harness.dataDir, 'backups', misshapenId, 'manifest.json'),
      JSON.stringify({ id: misshapenId }),
    )

    const list = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().backups.map((m: { id: string }) => m.id)).toEqual([a.json().id])
  })

  it('rejects an unreadable legacy db.json before restore staging, with no restore event', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'live-before-broken-legacy' })
    const before = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const revisionBefore = before.json().revision as number
    harness.commandEvents.clear()

    // A legacy-only backup (db.json, no risu.db) whose snapshot is unreadable.
    const backupId = '2026-06-05-02-03-04-abcdef'
    const backupRoot = path.join(harness.dataDir, 'backups', backupId)
    mkdirSync(backupRoot, { recursive: true })
    writeFileSync(path.join(backupRoot, 'db.json'), '{broken legacy snapshot')

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(400)
    expect(restored.json()).toEqual({ error: 'backup_database_invalid' })

    // Validation happens before the table clear and no restore event is emitted
    // or persisted.
    expect(harness.commandEvents.list()).toEqual([])
    const after = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(after.json().revision).toBe(revisionBefore)
    expect(after.resourceDatabase).toMatchObject({ tag: 'live-before-broken-legacy' })
  })

  it('restore of an unknown id returns 404', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups/2026-05-20-12-00-00-aaaaaa/restore',
      headers: { 'risu-auth': assertion },
    })
    expect(res.statusCode).toBe(404)
  })

  it('delete removes the backup directory', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: {},
    })
    const id = created.json().id
    expect(existsSync(path.join(harness.dataDir, 'backups', id))).toBe(true)

    const del = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/backups/${id}`,
      headers: { 'risu-auth': assertion },
    })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ id })
    expect(existsSync(path.join(harness.dataDir, 'backups', id))).toBe(false)

    const list = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
    })
    expect(list.json().backups).toEqual([])
  })

  it('delete of unknown id returns 404', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const res = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/backups/2026-05-20-12-00-00-aaaaaa',
      headers: { 'risu-auth': assertion },
    })
    expect(res.statusCode).toBe(404)
  })

  it('rejects path-traversal attempts via the id parameter', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    for (const malformed of ['..', '../foo', 'not-a-valid-id', '2026-05-20']) {
      const restore = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/backups/${encodeURIComponent(malformed)}/restore`,
        headers: { 'risu-auth': assertion },
      })
      expect(restore.statusCode).toBe(404)

      const del = await harness.app.inject({
        method: 'DELETE',
        url: `/api/v1/backups/${encodeURIComponent(malformed)}`,
        headers: { 'risu-auth': assertion },
      })
      expect(del.statusCode).toBe(404)
    }
  })

  it('round-trips SQLite memory tables across backup and restore', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'pre-mem' })

    // Open the live SQLite db directly to seed a memory_chunks row that the
    // backup must preserve. We use the same Node sqlite binding.
    const { DatabaseSync } = await import('node:sqlite')
    const liveDbPath = path.join(harness.dataDir, 'risu.db')
    const seed = new DatabaseSync(liveDbPath)
    try {
      seed.exec(
        `INSERT INTO memory_chunks (id, chat_id, range_start_seq, range_end_seq, text, status)
         VALUES ('chunk-pre', 'chat-a', 0, 1, 'pre', 'pending')`,
      )
    } finally {
      seed.close()
    }

    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'mem snapshot' },
    })
    expect(backup.statusCode).toBe(201)
    const backupId = backup.json().id
    expect(existsSync(path.join(harness.dataDir, 'backups', backupId, 'risu.db'))).toBe(true)

    // Mutate the memory table post-backup; restore must revert it.
    const mutate = new DatabaseSync(liveDbPath)
    try {
      mutate.exec(
        `INSERT INTO memory_chunks (id, chat_id, range_start_seq, range_end_seq, text, status)
         VALUES ('chunk-post', 'chat-b', 0, 1, 'post', 'pending')`,
      )
      mutate.exec(`DELETE FROM memory_chunks WHERE id = 'chunk-pre'`)
    } finally {
      mutate.close()
    }

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    // The memory table must now match the snapshot.
    const verify = new DatabaseSync(liveDbPath)
    try {
      const rows = verify.prepare(`SELECT id FROM memory_chunks ORDER BY id ASC`).all() as {
        id: string
      }[]
      expect(rows.map((r) => r.id)).toEqual(['chunk-pre'])
    } finally {
      verify.close()
    }
  })

  it('round-trips data/save directory across backup and restore', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDb(harness.app, assertion, { tag: 'pre-save' })

    // Write a legacy storage entry through the /storage/write route, then
    // backup, mutate, restore, and verify the file content round-trips.
    const filePath = Buffer.from('remotes/preserved.local.bin').toString('hex')
    const initial = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/storage/write',
      headers: {
        'risu-auth': assertion,
        'content-type': 'application/octet-stream',
        'file-path': filePath,
      },
      payload: Buffer.from('preserved-bytes'),
    })
    expect(initial.statusCode).toBe(200)
    const savedFile = path.join(harness.dataDir, 'save', filePath)
    expect(existsSync(savedFile)).toBe(true)

    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: { 'risu-auth': assertion },
      payload: { label: 'save snapshot' },
    })
    expect(backup.statusCode).toBe(201)
    const backupId = backup.json().id
    expect(existsSync(path.join(harness.dataDir, 'backups', backupId, 'save', filePath))).toBe(true)

    // Overwrite and add a different file, then restore.
    writeFileSync(savedFile, 'tampered-bytes')
    const addedHex = Buffer.from('remotes/after.local.bin').toString('hex')
    const addedFile = path.join(harness.dataDir, 'save', addedHex)
    writeFileSync(addedFile, 'after-restore-must-disappear')

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backupId}/restore`,
      headers: { 'risu-auth': assertion },
    })
    expect(restored.statusCode).toBe(200)

    expect(readFileSync(savedFile, 'utf-8')).toBe('preserved-bytes')
    expect(existsSync(addedFile)).toBe(false)
  })
})
