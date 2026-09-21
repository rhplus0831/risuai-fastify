import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCommandEventSink } from '../src/commands/events.js'
import { applyJsonCommandMutation, applyMessageFreeJsonCommandMutation } from '../src/commands/mutations.js'
import { getSchemaState, openDatabase } from '../src/db.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import { loadPersisted, writePersistedWithMessages } from '../src/repository.js'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  readAllDatabaseRows,
  startHarness,
  stopHarness,
  importDatabase,
} from './helpers/commandHarness.js'

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

function databaseLineageFromDir(dataDir: string): string {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    return getDatabaseLineage(db)
  } finally {
    db.close()
  }
}

let harness: Harness

describe('command foundation', { tags: 'core' }, () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('rejects unauthenticated runtime settings commands once a password is set', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { password: 'hunter2' },
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      payload: { baseRevision: 0, patch: { streamGeminiThoughts: true } },
    })

    expect(res.statusCode).toBe(401)
  })

  it('rejects missing and invalid baseRevision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { patch: { streamGeminiThoughts: true } },
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toBe('baseRevision must be a non-negative integer')

    const invalid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: '0', patch: { streamGeminiThoughts: true } },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toBe('baseRevision must be a non-negative integer')
  })

  it('returns 409 with the current revision when baseRevision is stale', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDatabase(harness.app, assertion, { streamGeminiThoughts: false })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { streamGeminiThoughts: true } },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })

  it('emits no event and leaves revision + persisted state untouched on a stale (409) write', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDatabase(harness.app, assertion, { streamGeminiThoughts: false })
    // Drop the import's own event so we observe only what the stale write does.
    harness.commandEvents.clear()

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { streamGeminiThoughts: true } },
    })
    expect(res.statusCode).toBe(409)

    // The revision-mismatch guard throws BEFORE the mutate callback, so nothing
    // may have leaked: no event, no revision bump, no persisted write.
    expect(harness.commandEvents.list()).toEqual([])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase).toMatchObject({ streamGeminiThoughts: false })
  })

  it('applies the runtime settings harness command, emits an event, and appears in bootstrap', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      streamGeminiThoughts: false,
      greeting: 'hi',
    })
    harness.commandEvents.clear()

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { streamGeminiThoughts: true } },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      revision: 2,
      event: {
        type: 'settings.updated',
        revision: 2,
        resource: 'settings',
        id: 'runtime',
      },
      acknowledgedKeys: ['streamGeminiThoughts'],
      settings: {},
    })
    expect(harness.commandEvents.list()).toEqual([res.json().event])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().revision).toBe(2)
    expect(bootstrap.resourceDatabase).toMatchObject({
      streamGeminiThoughts: true,
      greeting: 'hi',
    })
  })

  it('serializes same-base ordinary command transactions to one winner', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      theme: 'dark',
      zoomsize: 100,
    })
    const databaseLineage = databaseLineageFromDir(harness.dataDir)
    harness.commandEvents.clear()
    const attempts = [
      {
        field: 'theme',
        initial: 'dark',
        next: 'light',
        mutationId: 'same-base-theme',
        patch: { theme: 'light' },
      },
      {
        field: 'zoomsize',
        initial: 100,
        next: 88,
        mutationId: 'same-base-zoom',
        patch: { zoomsize: 88 },
      },
    ] as const

    const responses = await Promise.all(
      attempts.map((attempt) =>
        harness.app.inject({
          method: 'PATCH',
          url: '/api/v1/commands/settings/display',
          headers: {
            'risu-auth': assertion,
            'risu-writer-session': 'writer-concurrency',
            'risu-mutation-id': attempt.mutationId,
            'risu-database-lineage': databaseLineage,
          },
          payload: { baseRevision: revision, patch: attempt.patch },
        }),
      ),
    )

    expect(responses.map((response) => response.statusCode).sort((left, right) => left - right)).toEqual([200, 409])
    const winnerIndex = responses.findIndex((response) => response.statusCode === 200)
    const loserIndex = responses.findIndex((response) => response.statusCode === 409)
    expect(winnerIndex).toBeGreaterThanOrEqual(0)
    expect(loserIndex).toBeGreaterThanOrEqual(0)
    const winner = attempts[winnerIndex]!
    const loser = attempts[loserIndex]!
    const winnerBody = responses[winnerIndex]!.json()
    expect(winnerBody).toEqual({
      revision: revision + 1,
      event: {
        type: 'settings.updated',
        revision: revision + 1,
        resource: 'settings',
        id: 'display',
      },
      acknowledgedKeys: [winner.field],
      settings: {},
    })
    expect(responses[loserIndex]!.json()).toEqual({
      error: 'revision_conflict',
      currentRevision: revision + 1,
    })
    expect(harness.commandEvents.list()).toEqual([
      {
        ...winnerBody.event,
        origin: { writerSessionId: 'writer-concurrency' },
      },
    ])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().revision).toBe(revision + 1)
    const persistedDatabase = bootstrap.resourceDatabase as Record<string, unknown>
    expect(persistedDatabase[winner.field]).toBe(winner.next)
    expect(persistedDatabase[loser.field]).toBe(loser.initial)

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(getSchemaState(db).revision).toBe(revision + 1)
      expect(
        db
          .prepare(
            `
              SELECT revision, type, resource, id
              FROM command_events
              WHERE revision > ?
              ORDER BY revision
            `,
          )
          .all(revision),
      ).toEqual([
        {
          revision: revision + 1,
          type: 'settings.updated',
          resource: 'settings',
          id: 'display',
        },
      ])
      const receipts = db
        .prepare(
          `
            SELECT mutation_id AS mutationId, response_json AS responseJson
            FROM command_mutation_receipts
            ORDER BY mutation_id
          `,
        )
        .all() as unknown as Array<{ mutationId: string; responseJson: string }>
      expect(receipts).toHaveLength(1)
      expect(receipts[0]!.mutationId).toBe(winner.mutationId)
      expect(JSON.parse(receipts[0]!.responseJson)).toEqual({
        revision: winnerBody.revision,
        event: winnerBody.event,
        extra: {
          acknowledgedKeys: [winner.field],
          settings: {},
        },
      })
    } finally {
      db.close()
    }
  })

  it('rolls back an ordinary command transaction when event persistence fails', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      streamGeminiThoughts: false,
    })
    const databaseLineage = databaseLineageFromDir(harness.dataDir)
    const before = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    let eventCountBeforeFailure: number
    try {
      eventCountBeforeFailure = (
        before.prepare('SELECT COUNT(*) AS count FROM command_events').get() as { count: number }
      ).count
    } finally {
      before.close()
    }
    harness.commandEvents.clear()
    failCommandEventPersistence(harness.dataDir)

    const failed = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-event-failure',
        'risu-mutation-id': 'event-persistence-failure',
        'risu-database-lineage': databaseLineage,
      },
      payload: { baseRevision: revision, patch: { streamGeminiThoughts: true } },
    })

    expect(failed.statusCode).toBe(500)
    expect(harness.commandEvents.list()).toEqual([])
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase).toMatchObject({ streamGeminiThoughts: false })

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(getSchemaState(db).revision).toBe(revision)
      expect(db.prepare('SELECT COUNT(*) AS count FROM command_events').get()).toEqual({
        count: eventCountBeforeFailure,
      })
      expect(db.prepare('SELECT COUNT(*) AS count FROM command_mutation_receipts').get()).toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('persists chain-of-thought exclusion as a boolean language setting', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      translatorSendTextAsIs: true,
      translatorExcludeThoughts: false,
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/language',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { translatorExcludeThoughts: true } },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      acknowledgedKeys: ['translatorExcludeThoughts'],
      event: { resource: 'settings', id: 'language' },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      translatorSendTextAsIs: true,
      translatorExcludeThoughts: true,
    })
  })

  it('does not bump revision or mutate persisted state on validation failure', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      streamGeminiThoughts: false,
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { streamGeminiThoughts: 'yes' } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('streamGeminiThoughts must be a boolean')

    const badAdditionalParamsOptIn = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { applyAdditionalParamsToAll: 'yes' } },
    })
    expect(badAdditionalParamsOptIn.statusCode).toBe(400)
    expect(badAdditionalParamsOptIn.json().error).toBe('applyAdditionalParamsToAll must be a boolean')

    const emptyMinP = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { min_p: null } },
    })
    expect(emptyMinP.statusCode).toBe(400)
    expect(emptyMinP.json().error).toBe('min_p must be a finite number')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase).toMatchObject({ streamGeminiThoughts: false })
  })
})

describe('JSON command mutation rollback', { tags: 'core' }, () => {
  it('rolls back a thrown JSON command mutation before bumping revision', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-command-helper-'))
    const db = openDatabase(dataDir)
    const commandEvents = createCommandEventSink()
    writePersistedWithMessages(db, dataDir, {
      _version: 1,
      database: { streamGeminiThoughts: false },
      assets: [],
    })

    try {
      expect(() =>
        applyJsonCommandMutation({
          db,
          dataDir,
          baseRevision: 0,
          eventSink: commandEvents,
          mutate(database) {
            const target = database as Record<string, unknown>
            target.streamGeminiThoughts = true
            throw new Error('boom')
          },
        }),
      ).toThrow('boom')

      expect(getSchemaState(db).revision).toBe(0)
      expect(loadPersisted(db, dataDir).database).toMatchObject({ streamGeminiThoughts: false, characters: [] })
      expect(commandEvents.list()).toEqual([])
    } finally {
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('rolls back a thrown message-free JSON command mutation before persisting', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-message-free-command-helper-'))
    const db = openDatabase(dataDir)
    const commandEvents = createCommandEventSink()
    writePersistedWithMessages(db, dataDir, {
      _version: 1,
      database: { streamGeminiThoughts: false },
      assets: [],
    })

    try {
      expect(() =>
        applyMessageFreeJsonCommandMutation({
          db,
          dataDir,
          baseRevision: 0,
          eventSink: commandEvents,
          mutate(database) {
            const target = database as Record<string, unknown>
            target.streamGeminiThoughts = true
            throw new Error('boom')
          },
        }),
      ).toThrow('boom')

      expect(getSchemaState(db).revision).toBe(0)
      expect(loadPersisted(db, dataDir).database).toMatchObject({ streamGeminiThoughts: false, characters: [] })
      expect(commandEvents.list()).toEqual([])
    } finally {
      db.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('first-run database seed', { tags: 'core' }, () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('rejects a settings command on a never-seeded (null database) server', async () => {
    // Regression: a fresh server ships database: null, and every command path
    // requires an existing object. The welcome screen's first action (set
    // username) is the first to hit it.
    const { assertion } = await setupAuthedClient(harness.app)

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/account',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { username: 'Test' } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('database must be an object before settings commands can run')
  })

  it('creates the server default database, emits an event, and unblocks settings commands', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    harness.commandEvents.clear()

    const seeded = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: {},
    })

    expect(seeded.statusCode).toBe(200)
    expect(seeded.json()).toEqual({
      revision: 1,
      initialized: true,
      event: {
        type: 'state.initialized',
        revision: 1,
        resource: 'state',
      },
    })
    expect(harness.commandEvents.list()).toEqual([seeded.json().event])

    // The previously-rejected settings command now succeeds against revision 1.
    const account = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/account',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 1, patch: { username: 'Test' } },
    })
    expect(account.statusCode).toBe(200)
    expect(account.json().revision).toBe(2)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(2)
    expect(bootstrap.resourceDatabase).toMatchObject({
      username: 'Test',
      theme: 'fastify',
      temperature: 80,
      botPresets: [],
      modelPresets: [expect.objectContaining({ id: 'default-model-preset' })],
      promptPresets: [expect.objectContaining({ id: 'default-prompt-preset' })],
      personas: [expect.objectContaining({ id: 'default-persona' })],
    })

    const defaultLorebookId = bootstrap.resourceDatabase.loreBook[0]?.id as string
    expect(defaultLorebookId).toBe('default-global-lorebook')
    const entry = {
      id: 'first-default-entry',
      key: 'first',
      secondkey: '',
      insertorder: 100,
      comment: 'First entry',
      content: 'Persisted content',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    const added = await harness.app.inject({
      method: 'PUT',
      url: `/api/v1/commands/lorebooks/${encodeURIComponent(defaultLorebookId)}/entries/${entry.id}`,
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, entry },
    })
    expect(added.statusCode).toBe(200)

    const reloaded = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(reloaded.resourceDatabase.loreBook).toEqual([
      expect.objectContaining({ id: defaultLorebookId, data: [expect.objectContaining({ id: entry.id })] }),
    ])
  })

  it('preserves the single-winner behavior when two clients initialize concurrently', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    harness.commandEvents.clear()

    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        harness.app.inject({
          method: 'POST',
          url: '/api/v1/commands/state/initialize',
          headers: { 'risu-auth': assertion },
          payload: {},
        }),
      ),
    )

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200])
    expect(responses.map((response) => response.json().initialized).sort()).toEqual([false, true])
    expect(responses.map((response) => response.json().revision)).toEqual([1, 1])
    expect(harness.commandEvents.list()).toHaveLength(1)
    expect(harness.commandEvents.list()[0]).toMatchObject({ type: 'state.initialized', revision: 1 })
  })

  it('reports a non-object settings row as uninitialized and safely replaces it when no user data exists', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      db.prepare("INSERT INTO settings (id, data_json) VALUES (1, '[]')").run()
    } finally {
      db.close()
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().initialized).toBe(false)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: {},
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ revision: 1, initialized: true })
  })

  it('returns initialize_conflict for characters without settings and reports bootstrap initialized', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      db.prepare(
        'INSERT INTO characters (id, position, data_json) VALUES (\'char-preserved\', 0, \'{"chaId":"char-preserved","name":"Preserved"}\')',
      ).run()
      db.prepare('INSERT INTO modules (position, data_json) VALUES (0, \'{"id":"module-preserved"}\')').run()
    } finally {
      db.close()
    }
    const before = readAllDatabaseRows(harness.dataDir)
    harness.commandEvents.clear()

    const bootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json().initialized).toBe(true)

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: {},
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'initialize_conflict' })
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(before)
    expect(harness.commandEvents.list()).toEqual([])
  })

  it('returns initialize_conflict for orphaned messages without touching any table', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      db.prepare(
        "INSERT INTO messages (chat_id, seq, uid, role, data, json) VALUES ('chat-lost', 0, 'message-preserved', 'user', 'hello', '{\"uid\":\"message-preserved\"}')",
      ).run()
    } finally {
      db.close()
    }
    const before = readAllDatabaseRows(harness.dataDir)
    harness.commandEvents.clear()

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: {},
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'initialize_conflict' })
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(before)
    expect(harness.commandEvents.list()).toEqual([])
  })

  it('does not seed database or bump revision when initialization event persistence fails', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    failCommandEventPersistence(harness.dataDir)

    const seeded = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: {},
    })

    expect(seeded.statusCode).toBe(500)
    expect(harness.commandEvents.list()).toEqual([])
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(getSchemaState(db).revision).toBe(0)
      expect(loadPersisted(db, harness.dataDir).database).toBeNull()
    } finally {
      db.close()
    }
  })

  it('is an idempotent no-op that never clobbers an existing database', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      username: 'Existing',
      characters: [{ chaId: 'char-a', name: 'Ada' }],
    })
    harness.commandEvents.clear()

    const seeded = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: {},
    })

    expect(seeded.statusCode).toBe(200)
    expect(seeded.json()).toEqual({ revision, initialized: false })
    // No write happened: no event, revision unchanged, data preserved.
    expect(harness.commandEvents.list()).toEqual([])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase).toMatchObject({ username: 'Existing' })
  })

  it('rejects request-shaped database seed payloads', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: { database: { username: 'client-shaped' } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('database payload is no longer accepted for state initialization')
  })

  it('rejects non-object initialize bodies', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': assertion },
      payload: ['array'],
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('request body must be an object')
  })
})
