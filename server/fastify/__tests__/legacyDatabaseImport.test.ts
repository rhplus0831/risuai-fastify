import { afterEach, describe, expect, it, vi } from 'vitest'
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../src/db.js'
import {
  ensureDbJsonImported,
  insertAssetMetadataBatch,
  loadPersistedWithMessages,
  writePersistedWithMessages,
  type LegacyDatabaseImportLogger,
  type Persisted,
} from '../src/repository.js'

const dataDirs: string[] = []
const dbs = new Set<DatabaseSync>()

function makeDataDir(): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-legacy-import-'))
  dataDirs.push(dataDir)
  return dataDir
}

function makeDb(dataDir: string): DatabaseSync {
  const db = openDatabase(dataDir)
  dbs.add(db)
  return db
}

function closeDb(db: DatabaseSync): void {
  db.close()
  dbs.delete(db)
}

function makeLogger(): LegacyDatabaseImportLogger {
  return { warn: vi.fn(), error: vi.fn() }
}

function snapshot(tag: string, chatId: string, messageText: string, assetId?: string): Persisted {
  return {
    _version: 1,
    database: {
      tag,
      modules: [{ id: `${tag}-module`, name: `${tag} module` }],
      characters: [
        {
          chaId: `${tag}-character`,
          chats: [
            {
              id: chatId,
              message: [{ role: 'user', data: messageText, chatId: `${chatId}-message` }],
            },
          ],
        },
      ],
    },
    assets: assetId
      ? [
          {
            id: assetId,
            ext: 'png',
            size: 1,
            contentType: 'image/png',
          },
        ]
      : [],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of dbs) db.close()
  dbs.clear()
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
})

describe('legacy db.json boot import', () => {
  it('rolls back every table change after a late import failure and leaves db.json for retry', () => {
    const dataDir = makeDataDir()
    const db = makeDb(dataDir)
    const liveAssetId = 'a'.repeat(64)
    const legacyAssetId = 'b'.repeat(64)
    const live = snapshot('live', 'live-chat', 'live message', liveAssetId)
    writePersistedWithMessages(db, dataDir, structuredClone(live))
    insertAssetMetadataBatch(db, live.assets)
    const before = loadPersistedWithMessages(db, dataDir)

    db.exec(`
      CREATE TRIGGER fail_legacy_asset_import
      BEFORE INSERT ON assets
      WHEN NEW.id = '${legacyAssetId}'
      BEGIN
        SELECT RAISE(FAIL, 'injected transient legacy import failure');
      END;
    `)
    const filePath = path.join(dataDir, 'db.json')
    writeFileSync(filePath, JSON.stringify(snapshot('legacy', 'legacy-chat', 'legacy message', legacyAssetId)))

    expect(() => ensureDbJsonImported(db, dataDir, makeLogger())).toThrow(/injected transient legacy import failure/)

    expect(loadPersistedWithMessages(db, dataDir)).toEqual(before)
    expect(existsSync(filePath)).toBe(true)
    expect(existsSync(`${filePath}.migrated`)).toBe(false)

    db.exec('DROP TRIGGER fail_legacy_asset_import')
    ensureDbJsonImported(db, dataDir, makeLogger())
    expect(existsSync(filePath)).toBe(false)
    expect(existsSync(`${filePath}.migrated`)).toBe(true)
    expect(loadPersistedWithMessages(db, dataDir).database).toMatchObject({ tag: 'legacy' })
  })

  it('checkpoints and retires a successful migration, then a second boot is a no-op', { tags: 'core' }, () => {
    const dataDir = makeDataDir()
    const filePath = path.join(dataDir, 'db.json')
    const raw = JSON.stringify(snapshot('legacy', 'legacy-chat', 'legacy message'))
    writeFileSync(filePath, raw)

    const firstDb = makeDb(dataDir)
    const originalRenameSync = fs.renameSync.bind(fs)
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(source) === filePath) {
        const observer = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
        try {
          // The source is retired only after COMMIT is visible outside the
          // importing connection and the live database WAL has been drained.
          const settings = observer.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
            data_json: string
          }
          expect(JSON.parse(settings.data_json)).toMatchObject({ tag: 'legacy' })
          const walPath = path.join(dataDir, 'risu.db-wal')
          expect(!existsSync(walPath) || statSync(walPath).size === 0).toBe(true)
        } finally {
          observer.close()
        }
      }
      originalRenameSync(source, destination)
    })
    ensureDbJsonImported(firstDb, dataDir, makeLogger())
    const afterFirstBoot = loadPersistedWithMessages(firstDb, dataDir)
    closeDb(firstDb)

    expect(renameSpy).toHaveBeenCalledWith(filePath, `${filePath}.migrated`)
    expect(existsSync(filePath)).toBe(false)
    expect(readFileSync(`${filePath}.migrated`, 'utf8')).toBe(raw)

    const secondDb = makeDb(dataDir)
    ensureDbJsonImported(secondDb, dataDir, makeLogger())
    expect(loadPersistedWithMessages(secondDb, dataDir)).toEqual(afterFirstBoot)
    expect(readFileSync(`${filePath}.migrated`, 'utf8')).toBe(raw)
  })

  it('repairs missing and duplicate chat ids before extracting transcript and Hypa rows', { tags: 'core' }, () => {
    const dataDir = makeDataDir()
    const filePath = path.join(dataDir, 'db.json')
    const legacy: Persisted = {
      _version: 1,
      database: {
        characters: [
          {
            chaId: 'legacy-character',
            chats: [
              {
                id: 'duplicate-chat',
                name: 'First',
                message: [{ role: 'user', data: 'first transcript', chatId: 'message-first' }],
                hypaV3Data: { summaries: [{ text: 'first memory' }] },
              },
              {
                id: 'duplicate-chat',
                name: 'Second',
                message: [{ role: 'char', data: 'second transcript', chatId: 'message-second' }],
                hypaV3Data: { summaries: [{ text: 'second memory' }] },
              },
              {
                name: 'Missing',
                message: [{ role: 'user', data: 'missing-id transcript', chatId: 'message-missing' }],
                hypaV3Data: { summaries: [{ text: 'missing-id memory' }] },
              },
            ],
          },
        ],
      },
      assets: [],
    }
    writeFileSync(filePath, JSON.stringify(legacy))

    const firstDb = makeDb(dataDir)
    expect(() => ensureDbJsonImported(firstDb, dataDir, makeLogger())).not.toThrow()
    const afterFirstBoot = loadPersistedWithMessages(firstDb, dataDir)
    closeDb(firstDb)

    const importedDatabase = afterFirstBoot.database as {
      characters: Array<{ chats: Array<Record<string, unknown>> }>
    }
    const chats = importedDatabase.characters[0].chats
    const ids = chats.map((chat) => chat.id)
    expect(ids).toHaveLength(3)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(3)
    expect(chats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'First',
          message: [expect.objectContaining({ data: 'first transcript' })],
          hypaV3Data: { summaries: [{ text: 'first memory' }] },
        }),
        expect.objectContaining({
          name: 'Second',
          message: [expect.objectContaining({ data: 'second transcript' })],
          hypaV3Data: { summaries: [{ text: 'second memory' }] },
        }),
        expect.objectContaining({
          name: 'Missing',
          message: [expect.objectContaining({ data: 'missing-id transcript' })],
          hypaV3Data: { summaries: [{ text: 'missing-id memory' }] },
        }),
      ]),
    )

    const secondDb = makeDb(dataDir)
    ensureDbJsonImported(secondDb, dataDir, makeLogger())
    expect(loadPersistedWithMessages(secondDb, dataDir)).toEqual(afterFirstBoot)
  })

  it('repairs persona ids and persists stable selection before retiring a legacy snapshot', () => {
    const dataDir = makeDataDir()
    const filePath = path.join(dataDir, 'db.json')
    const legacy = snapshot('legacy-persona', 'legacy-chat', 'legacy message')
    ;(legacy.database as Record<string, unknown>).selectedPersona = 2
    ;(legacy.database as Record<string, unknown>).selectedPersonaId = 'duplicate'
    ;(legacy.database as Record<string, unknown>).personas = [
      { id: 'duplicate', name: 'First' },
      { id: 'duplicate', name: 'Second' },
      { name: 'Legacy selected' },
    ]
    writeFileSync(filePath, JSON.stringify(legacy))

    const firstDb = makeDb(dataDir)
    ensureDbJsonImported(firstDb, dataDir, makeLogger())
    const afterFirstBoot = loadPersistedWithMessages(firstDb, dataDir)
    expect(afterFirstBoot.database).toMatchObject({
      selectedPersona: 2,
      selectedPersonaId: 'persona-3',
      personas: [
        { id: 'duplicate', name: 'First' },
        { id: 'persona-2', name: 'Second' },
        { id: 'persona-3', name: 'Legacy selected' },
      ],
    })
    closeDb(firstDb)

    const secondDb = makeDb(dataDir)
    ensureDbJsonImported(secondDb, dataDir, makeLogger())
    expect(loadPersistedWithMessages(secondDb, dataDir)).toEqual(afterFirstBoot)
  })

  it('repairs Hypa V3 preset ids and persists stable selection before retiring a legacy snapshot', () => {
    const dataDir = makeDataDir()
    const filePath = path.join(dataDir, 'db.json')
    const legacy = snapshot('legacy-hypa', 'legacy-chat', 'legacy message')
    ;(legacy.database as Record<string, unknown>).hypaV3PresetId = 2
    ;(legacy.database as Record<string, unknown>).selectedHypaV3PresetId = 'duplicate'
    ;(legacy.database as Record<string, unknown>).hypaV3Presets = [
      { id: 'duplicate', name: 'First', settings: {} },
      { id: 'duplicate', name: 'Second', settings: {} },
      { name: 'Legacy selected', settings: {} },
    ]
    writeFileSync(filePath, JSON.stringify(legacy))

    const firstDb = makeDb(dataDir)
    ensureDbJsonImported(firstDb, dataDir, makeLogger())
    const afterFirstBoot = loadPersistedWithMessages(firstDb, dataDir)
    expect(afterFirstBoot.database).toMatchObject({
      hypaV3PresetId: 2,
      selectedHypaV3PresetId: 'hypa-v3-preset-3',
      hypaV3Presets: [
        { id: 'duplicate', name: 'First' },
        { id: 'hypa-v3-preset-2', name: 'Second' },
        { id: 'hypa-v3-preset-3', name: 'Legacy selected' },
      ],
    })
    closeDb(firstDb)

    const secondDb = makeDb(dataDir)
    ensureDbJsonImported(secondDb, dataDir, makeLogger())
    expect(loadPersistedWithMessages(secondDb, dataDir)).toEqual(afterFirstBoot)
  })

  it('quarantines an invalid envelope without clobbering an existing quarantine or touching tables', () => {
    const dataDir = makeDataDir()
    const db = makeDb(dataDir)
    const live = snapshot('live', 'live-chat', 'live message')
    writePersistedWithMessages(db, dataDir, structuredClone(live))
    const before = loadPersistedWithMessages(db, dataDir)
    const filePath = path.join(dataDir, 'db.json')
    const invalidRaw = JSON.stringify({ _version: 1, database: [] })
    writeFileSync(`${filePath}.invalid`, 'existing quarantine')
    writeFileSync(filePath, invalidRaw)
    const logger = makeLogger()

    expect(() => ensureDbJsonImported(db, dataDir, logger)).not.toThrow()

    expect(loadPersistedWithMessages(db, dataDir)).toEqual(before)
    expect(existsSync(filePath)).toBe(false)
    expect(readFileSync(`${filePath}.invalid`, 'utf8')).toBe('existing quarantine')
    expect(readFileSync(`${filePath}.invalid.1`, 'utf8')).toBe(invalidRaw)
    expect(existsSync(`${filePath}.migrated`)).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      { filePath, quarantinePath: `${filePath}.invalid.1` },
      expect.stringContaining('invalid envelope'),
    )
  })

  it('fails boot actionably on unparseable JSON while preserving the only source copy', () => {
    const dataDir = makeDataDir()
    const db = makeDb(dataDir)
    const live = snapshot('live', 'live-chat', 'live message')
    writePersistedWithMessages(db, dataDir, structuredClone(live))
    const before = loadPersistedWithMessages(db, dataDir)
    const filePath = path.join(dataDir, 'db.json')
    const broken = '{broken legacy json'
    writeFileSync(filePath, broken)
    const logger = makeLogger()

    expect(() => ensureDbJsonImported(db, dataDir, logger)).toThrow(
      `Legacy database snapshot at ${filePath} could not be parsed`,
    )

    expect(loadPersistedWithMessages(db, dataDir)).toEqual(before)
    expect(readFileSync(filePath, 'utf8')).toBe(broken)
    expect(existsSync(`${filePath}.invalid`)).toBe(false)
    expect(existsSync(`${filePath}.migrated`)).toBe(false)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ filePath, err: expect.any(SyntaxError) }),
      expect.stringMatching(/Repair or move.*left untouched/),
    )
  })
})
