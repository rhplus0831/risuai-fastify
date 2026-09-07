import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  closeFastBootstrapHarness,
  importFastBootstrapDatabase,
  smallFastBootstrapFixture,
  startFastBootstrapHarness,
  type FastBootstrapHarness,
} from '../browser-smoke/fastBootstrapHarness.js'

const harnesses: FastBootstrapHarness[] = []

async function start(options: Parameters<typeof startFastBootstrapHarness>[1] = {}) {
  const harness = await startFastBootstrapHarness(smallFastBootstrapFixture(), options)
  harnesses.push(harness)
  return harness
}

function sql(harness: FastBootstrapHarness) {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  try {
    return {
      ownership: db.prepare('SELECT active_writer_session_id, writer_epoch FROM database_metadata WHERE id = 1').get(),
      lineage: db.prepare('SELECT lineage FROM database_metadata WHERE id = 1').get(),
      revision: db.prepare('SELECT revision FROM schema_version WHERE id = 1').get(),
      settings: db.prepare('SELECT data_json FROM settings WHERE id = 1').get(),
      characters: db.prepare('SELECT id, data_json FROM characters ORDER BY position').all(),
      imports: db
        .prepare("SELECT revision, type FROM command_events WHERE type = 'state.imported' ORDER BY revision")
        .all(),
    }
  } finally {
    db.close()
  }
}

async function bootstrap(harness: FastBootstrapHarness) {
  const response = await harness.app.inject({
    method: 'GET',
    url: '/api/v1/bootstrap',
    headers: { 'risu-auth': harness.assertion },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await closeFastBootstrapHarness(harness)
})

describe('browser fixture ownership', () => {
  it('defaults to an initialized, unowned API-import producer before the browser acquires its first writer', async () => {
    const harness = await start()
    const before = sql(harness)
    expect(before.ownership).toMatchObject({ active_writer_session_id: null, writer_epoch: 0 })
    expect(before.settings).toBeDefined()
    expect(before.characters).toHaveLength(1)
    expect(before.imports).toHaveLength(1)
    expect(existsSync(path.join(harness.dataDir, 'db.json.migrated'))).toBe(false)
    const discovered = await bootstrap(harness)
    expect(discovered).toMatchObject({ initialized: true, writer: { sessionId: null, epoch: 0 } })
    expect(sql(harness)).toEqual(before)

    const acquired = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: {
        'risu-auth': harness.assertion,
        'risu-writer-session': 'first-browser-writer',
        'risu-expected-writer-epoch': '0',
        'risu-expected-database-lineage': discovered.databaseLineage,
      },
    })
    expect(acquired.statusCode, acquired.body).toBe(200)
    expect(acquired.json().writer).toEqual({ sessionId: 'first-browser-writer', epoch: 1 })
    expect(sql(harness).ownership).toMatchObject({ active_writer_session_id: 'first-browser-writer', writer_epoch: 1 })
    expect(sql(harness).revision).toEqual(before.revision)
  })

  it('keeps repeated pre-navigation API imports unowned without resetting server ownership', async () => {
    const harness = await start()
    const before = sql(harness)
    const replacement = smallFastBootstrapFixture()
    replacement.username = 'Replacement fixture user'
    await importFastBootstrapDatabase(harness.app, harness.assertion, replacement, { dataDir: harness.dataDir })
    const after = sql(harness)
    expect(after.ownership).toEqual(before.ownership)
    expect(after.lineage).not.toEqual(before.lineage)
    expect(after.settings).toMatchObject({ data_json: expect.stringContaining('Replacement fixture user') })
    expect(after.imports).toHaveLength(2)
    expect(await bootstrap(harness)).toMatchObject({ initialized: true, writer: { sessionId: null, epoch: 0 } })
  })

  it('rejects fixture reseeding after acquisition and leaves the production import guard strict', async () => {
    const harness = await start()
    const acquired = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': harness.assertion, 'risu-writer-session': 'actual-browser-writer' },
    })
    expect(acquired.statusCode, acquired.body).toBe(200)
    const before = sql(harness)
    await expect(
      importFastBootstrapDatabase(harness.app, harness.assertion, smallFastBootstrapFixture(), {
        dataDir: harness.dataDir,
      }),
    ).rejects.toThrow('unowned fixture imports')
    expect(sql(harness)).toEqual(before)
    const direct = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: { 'risu-auth': harness.assertion },
      payload: { database: smallFastBootstrapFixture() },
    })
    expect(direct.statusCode, direct.body).toBe(423)
    expect(direct.json()).toMatchObject({ error: 'active_writer_stale' })
    expect(sql(harness)).toEqual(before)
  })

  it('retains the explicit owned API-import fixture for conservative-owner cases', async () => {
    const harness = await start({ databaseSeedMode: 'writer-import' })
    const before = sql(harness)
    expect(before.ownership).toMatchObject({
      active_writer_session_id: expect.stringMatching(/^fast-bootstrap-import-/),
      writer_epoch: 1,
    })
    expect(before.imports).toHaveLength(1)
    expect((await bootstrap(harness)).writer).toEqual({
      sessionId: (before.ownership as { active_writer_session_id: string }).active_writer_session_id,
      epoch: 1,
    })
    expect(sql(harness)).toEqual(before)
  })

  it('retains normalized unowned migration as a distinct seed producer', async () => {
    const harness = await start({ databaseSeedMode: 'unowned-migration' })
    expect(sql(harness).ownership).toMatchObject({ active_writer_session_id: null, writer_epoch: 0 })
    expect(sql(harness).imports).toHaveLength(0)
    expect(existsSync(path.join(harness.dataDir, 'db.json.migrated'))).toBe(true)
    expect(await bootstrap(harness)).toMatchObject({ initialized: true, writer: { sessionId: null, epoch: 0 } })
  })

  it('keeps first-run fixtures truly empty and unowned', async () => {
    const harness = await start({ databaseSeedMode: 'empty' })
    const before = sql(harness)
    expect(before.ownership).toMatchObject({ active_writer_session_id: null, writer_epoch: 0 })
    expect(before.settings).toBeUndefined()
    expect(before.revision).toMatchObject({ revision: 0 })
    expect(before.characters).toHaveLength(0)
    expect(before.imports).toHaveLength(0)
    expect(await bootstrap(harness)).toMatchObject({ initialized: false, writer: { sessionId: null, epoch: 0 } })
    expect(sql(harness)).toEqual(before)
  })
})
