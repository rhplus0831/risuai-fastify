import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import { type Harness, startHarness, stopHarness, importDatabase } from './helpers/commandHarness.js'

let harness: Harness

describe('loadout commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('creates, updates, favorites, touches, and deletes loadouts by stable id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loadouts: [
        {
          id: 'loadout-a',
          name: 'A',
          lastUsed: 100,
          favorite: false,
          characterIds: ['char-a'],
          modules: ['module-a'],
          globalVariables: { mood: 'calm' },
          presetName: 'Preset A',
          personaId: 'persona-a',
        },
      ],
      lastLoadedLoadoutName: '',
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        loadout: {
          id: 'loadout-b',
          name: 'B',
          lastUsed: 200,
          favorite: false,
          characterIds: [],
          modules: ['module-b'],
          globalVariables: { tone: 'warm' },
          presetName: 'Preset B',
          modelPresetId: 'model-b',
          modelPresetName: 'Model B',
          promptPresetId: 'prompt-b',
          promptPresetName: 'Prompt B',
          agentPresetId: 'agent-preset-b',
          agentPresetName: 'Agent Preset B',
          personaId: 'persona-b',
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      revision: 2,
      event: {
        type: 'loadout.created',
        revision: 2,
        resource: 'loadout',
        id: 'loadout-b',
      },
      loadoutId: 'loadout-b',
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/loadouts/loadout-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: {
          name: 'B renamed',
          globalVariables: { tone: 'bright' },
        },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().event).toMatchObject({
      type: 'loadout.updated',
      resource: 'loadout',
      id: 'loadout-b',
    })

    const favorited = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts/loadout-b/favorite',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        favorite: true,
      },
    })
    expect(favorited.statusCode).toBe(200)
    expect(favorited.json().event).toMatchObject({
      type: 'loadout.favorited',
      resource: 'loadout',
      id: 'loadout-b',
    })

    const touched = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts/loadout-b/touch',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: favorited.json().revision,
        lastUsed: 300,
        characterId: 'char-c',
      },
    })
    expect(touched.statusCode).toBe(200)
    expect(touched.json()).toEqual({
      revision: 5,
      event: {
        type: 'loadout.touched',
        revision: 5,
        resource: 'loadout',
        id: 'loadout-b',
      },
      loadoutId: 'loadout-b',
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/loadouts/loadout-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: touched.json().revision,
      },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({
      revision: 6,
      event: {
        type: 'loadout.deleted',
        revision: 6,
        resource: 'loadout',
        id: 'loadout-a',
      },
      loadoutId: 'loadout-a',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      lastLoadedLoadoutName: 'B renamed',
    })
    expect(bootstrap.resourceDatabase.loadouts).toEqual([
      {
        id: 'loadout-b',
        name: 'B renamed',
        lastUsed: 300,
        favorite: true,
        characterIds: ['char-c'],
        modules: ['module-b'],
        globalVariables: { tone: 'bright' },
        presetName: 'Preset B',
        modelPresetId: 'model-b',
        modelPresetName: 'Model B',
        promptPresetId: 'prompt-b',
        promptPresetName: 'Prompt B',
        agentPresetId: 'agent-preset-b',
        agentPresetName: 'Agent Preset B',
        personaId: 'persona-b',
      },
    ])
  })

  it('touches duplicate-named loadouts by stable id without inferring the last-touch name on rename or delete', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loadouts: [
        {
          id: 'loadout-a',
          name: 'Shared name',
          lastUsed: 100,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          personaId: '',
        },
        {
          id: 'loadout-b',
          name: 'Shared name',
          lastUsed: 200,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          personaId: '',
        },
      ],
      lastLoadedLoadoutName: 'Before touch',
    })

    const touched = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts/loadout-b/touch',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, lastUsed: 300 },
    })
    expect(touched.statusCode).toBe(200)

    const afterTouch = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(afterTouch.resourceDatabase.loadouts).toEqual([
      expect.objectContaining({ id: 'loadout-a', name: 'Shared name', lastUsed: 100 }),
      expect.objectContaining({ id: 'loadout-b', name: 'Shared name', lastUsed: 300 }),
    ])
    expect(afterTouch.resourceDatabase.lastLoadedLoadoutName).toBe('Shared name')

    const renamed = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/loadouts/loadout-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: touched.json().revision, patch: { name: 'Renamed B' } },
    })
    expect(renamed.statusCode).toBe(200)

    const afterRename = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(afterRename.resourceDatabase.loadouts[1]).toMatchObject({ id: 'loadout-b', name: 'Renamed B' })
    expect(afterRename.resourceDatabase.lastLoadedLoadoutName).toBe('Shared name')

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/loadouts/loadout-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: renamed.json().revision },
    })
    expect(deleted.statusCode).toBe(200)

    const afterDelete = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(afterDelete.resourceDatabase.loadouts).toEqual([
      expect.objectContaining({ id: 'loadout-a', name: 'Shared name', lastUsed: 100 }),
    ])
    expect(afterDelete.resourceDatabase.lastLoadedLoadoutName).toBe('Shared name')
  })

  it('fails closed on duplicate persisted loadout ids without repairing sibling rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loadouts: [
        { id: 'loadout-a', name: 'A' },
        { id: 'loadout-b', name: 'B' },
      ],
      lastLoadedLoadoutName: 'Before',
    })
    const databasePath = path.join(harness.dataDir, 'risu.db')
    const corrupt = new DatabaseSync(databasePath)
    try {
      const sibling = corrupt.prepare('SELECT data_json FROM loadouts WHERE position = 1').get() as {
        data_json: string
      }
      const row = JSON.parse(sibling.data_json) as Record<string, unknown>
      row.id = 'loadout-a'
      corrupt.prepare('UPDATE loadouts SET data_json = ? WHERE position = 1').run(JSON.stringify(row))
    } finally {
      corrupt.close()
    }

    const favorited = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts/loadout-a/favorite',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, favorite: true },
    })
    expect(favorited.statusCode).toBe(400)
    expect(favorited.json().error).toBe('Duplicate loadout id: loadout-a')

    const persisted = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const rows = persisted.prepare('SELECT data_json FROM loadouts ORDER BY position').all() as Array<{
        data_json: string
      }>
      expect(rows.map((row) => JSON.parse(row.data_json))).toEqual([
        expect.objectContaining({ id: 'loadout-a', favorite: false }),
        expect.objectContaining({ id: 'loadout-a', favorite: false }),
      ])
    } finally {
      persisted.close()
    }
  })

  it('does not duplicate an existing character membership when a loadout is touched', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loadouts: [
        {
          id: 'loadout-a',
          name: 'A',
          lastUsed: 100,
          favorite: false,
          characterIds: ['char-a'],
          modules: [],
          globalVariables: {},
          presetName: '',
          personaId: '',
        },
      ],
      lastLoadedLoadoutName: '',
    })

    const touched = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts/loadout-a/touch',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        lastUsed: 200,
        characterId: 'char-a',
      },
    })
    expect(touched.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.loadouts[0]).toMatchObject({
      lastUsed: 200,
      characterIds: ['char-a'],
    })
  })

  it('rejects malformed loadout commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loadouts: [
        {
          id: 'loadout-a',
          name: 'A',
          lastUsed: 100,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          personaId: '',
        },
      ],
    })

    const update = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/loadouts/loadout-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { lastUsed: 'recently' },
      },
    })
    expect(update.statusCode).toBe(400)
    expect(update.json().error).toBe('patch.lastUsed must be a finite number')

    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        loadout: {
          id: 'loadout-a',
          name: 'Duplicate',
          lastUsed: 200,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          personaId: '',
        },
      },
    })
    expect(create.statusCode).toBe(400)
    expect(create.json().error).toBe('Duplicate loadout id: loadout-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.loadouts).toEqual([
      {
        id: 'loadout-a',
        name: 'A',
        lastUsed: 100,
        favorite: false,
        characterIds: [],
        modules: [],
        globalVariables: {},
        presetName: '',
        modelPresetId: '',
        modelPresetName: '',
        promptPresetId: '',
        promptPresetName: '',
        personaId: '',
      },
    ])
  })

  it('returns 404 and 409 for missing loadouts and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loadouts: [
        {
          id: 'loadout-a',
          name: 'A',
          lastUsed: 100,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          personaId: '',
        },
      ],
    })

    const missing = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts/missing/favorite',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        favorite: true,
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Loadout not found: missing')

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/loadouts/loadout-a/touch',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
        lastUsed: 200,
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})
