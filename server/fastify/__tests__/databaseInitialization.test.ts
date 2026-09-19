/** @module-tag core */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assessDatabaseInitialization } from '../src/databaseInitialization.js'
import { openDatabase } from '../src/db.js'

const dataDirs: string[] = []

function makeDatabase() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-initialization-'))
  dataDirs.push(dataDir)
  return openDatabase(dataDir)
}

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

describe('database initialization assessment', () => {
  it('classifies an empty current schema with technical seed rows as uninitialized', () => {
    const db = makeDatabase()
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM schema_version').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM database_metadata').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM generation_operation_projection_state').get()).toEqual({
        count: 1,
      })
      expect(assessDatabaseInitialization(db)).toEqual({ state: 'uninitialized', evidence: [] })

      db.prepare(
        "UPDATE database_metadata SET active_writer_session_id = 'pre-init-writer', writer_epoch = 1 WHERE id = 1",
      ).run()
      expect(assessDatabaseInitialization(db)).toEqual({ state: 'uninitialized', evidence: [] })

      const { lineage } = db.prepare('SELECT lineage FROM database_metadata WHERE id = 1').get() as {
        lineage: string
      }
      db.prepare(
        `INSERT INTO chat_occupancies (
          chat_id, database_lineage, occupant_session_id, occupancy_epoch, claim_class,
          claimed_at_ms, lease_expires_at_ms, updated_at_ms, released_at_ms
        ) VALUES ('removed-chat', ?, NULL, 2, NULL, NULL, NULL, 1000, 1000)`,
      ).run(lineage)
      expect(assessDatabaseInitialization(db)).toEqual({ state: 'uninitialized', evidence: [] })

      db.exec('CREATE TABLE future_user_state (id TEXT PRIMARY KEY, data_json TEXT NOT NULL)')
      expect(assessDatabaseInitialization(db)).toEqual({ state: 'uninitialized', evidence: [] })
    } finally {
      db.close()
    }
  })

  it('classifies a settings object as initialized', () => {
    const db = makeDatabase()
    try {
      expect(assessDatabaseInitialization(db)).toEqual({ state: 'uninitialized', evidence: [] })

      db.prepare("INSERT INTO settings (id, data_json) VALUES (1, '{}')").run()
      expect(assessDatabaseInitialization(db)).toEqual({ state: 'initialized', evidence: [] })
    } finally {
      db.close()
    }
  })

  it('allows a malformed settings row to be replaced only when no protected data exists', () => {
    const db = makeDatabase()
    try {
      db.prepare("INSERT INTO settings (id, data_json) VALUES (1, '[]')").run()
      expect(assessDatabaseInitialization(db)).toEqual({ state: 'uninitialized', evidence: [] })
    } finally {
      db.close()
    }
  })

  it.each([
    {
      label: 'characters',
      seed: (db: ReturnType<typeof makeDatabase>) =>
        db
          .prepare('INSERT INTO characters (id, position, data_json) VALUES (\'char-a\', 0, \'{"chaId":"char-a"}\')')
          .run(),
      evidence: 'characters',
    },
    {
      label: 'chats',
      seed: (db: ReturnType<typeof makeDatabase>) => {
        db.prepare(
          'INSERT INTO characters (id, position, data_json) VALUES (\'char-a\', 0, \'{"chaId":"char-a"}\')',
        ).run()
        db.prepare(
          "INSERT INTO chats (id, character_id, position, data_json) VALUES ('chat-a', 'char-a', 0, '{\"id\":\"chat-a\"}')",
        ).run()
      },
      evidence: 'chats',
    },
    {
      label: 'messages',
      seed: (db: ReturnType<typeof makeDatabase>) =>
        db
          .prepare(
            "INSERT INTO messages (chat_id, seq, uid, role, data, json) VALUES ('chat-a', 0, 'message-a', 'user', 'hello', '{}')",
          )
          .run(),
      evidence: 'messages',
    },
    {
      label: 'a positive revision',
      seed: (db: ReturnType<typeof makeDatabase>) =>
        db.prepare('UPDATE schema_version SET revision = 4 WHERE id = 1').run(),
      evidence: 'revision=4',
    },
    {
      label: 'an advanced generation operation projection epoch',
      seed: (db: ReturnType<typeof makeDatabase>) =>
        db.prepare('UPDATE generation_operation_projection_state SET epoch = 3 WHERE id = 1').run(),
      evidence: 'generation_operation_projection_epoch=3',
    },
    {
      label: 'command event history',
      seed: (db: ReturnType<typeof makeDatabase>) =>
        db.prepare("INSERT INTO command_events (revision, type, resource) VALUES (0, 'test.event', 'state')").run(),
      evidence: 'command_events',
    },
  ])('classifies $label without settings as a conflict', ({ seed, evidence }) => {
    const db = makeDatabase()
    try {
      seed(db)
      const assessment = assessDatabaseInitialization(db)
      expect(assessment.state).toBe('conflict')
      expect(assessment.evidence).toContain(evidence)
    } finally {
      db.close()
    }
  })

  const durableTableCases = [
    {
      label: 'a collection row',
      table: 'modules',
      seed: (db: ReturnType<typeof makeDatabase>) =>
        db.prepare('INSERT INTO modules (position, data_json) VALUES (0, \'{"id":"module-a"}\')').run(),
    },
    {
      label: 'a plugin row',
      table: 'plugins',
      seed: (db: ReturnType<typeof makeDatabase>) =>
        db.prepare('INSERT INTO plugins (position, data_json) VALUES (0, \'{"id":"plugin-a"}\')').run(),
    },
    {
      label: 'plugin custom storage',
      table: 'plugin_custom_storage',
      seed: (db: ReturnType<typeof makeDatabase>) =>
        db
          .prepare("INSERT INTO plugin_custom_storage (key, value_json) VALUES ('plugin-a:key', '{\"kept\":true}')")
          .run(),
    },
    {
      label: 'asset metadata',
      table: 'assets',
      seed: (db: ReturnType<typeof makeDatabase>) =>
        db.prepare("INSERT INTO assets (id, ext, size, content_type) VALUES ('asset-a', 'png', 12, 'image/png')").run(),
    },
    {
      label: 'a future user-state table',
      table: 'future_user_state',
      seed: (db: ReturnType<typeof makeDatabase>) => {
        db.exec('CREATE TABLE future_user_state (id TEXT PRIMARY KEY, data_json TEXT NOT NULL)')
        db.prepare("INSERT INTO future_user_state (id, data_json) VALUES ('future-a', '{}')").run()
      },
    },
  ]

  it.each(
    durableTableCases.flatMap((entry) => [
      { ...entry, settingsState: 'missing' as const },
      { ...entry, settingsState: 'malformed' as const },
    ]),
  )('classifies $label with $settingsState settings as a conflict', ({ settingsState, seed, table }) => {
    const db = makeDatabase()
    try {
      if (settingsState === 'malformed') {
        db.prepare("INSERT INTO settings (id, data_json) VALUES (1, '[]')").run()
      }
      seed(db)

      expect(assessDatabaseInitialization(db)).toEqual({ state: 'conflict', evidence: [table] })
    } finally {
      db.close()
    }
  })
})
