import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { insertAssetMetadataBatch } from '../src/repository.js'
import {
  serializePersonaCollectionDigestInput,
  serializePersonaIdsDigestInput,
  serializePersonaProfileDigestInput,
  type PersonaProfileDigestValue,
} from '@risuai/shared-core/mutation-certificates'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  startHarness,
  stopHarness,
  loadPersistedFromDir,
  importDatabase,
} from './helpers/commandHarness.js'

function personaCollectionDigest(personas: readonly unknown[]): string {
  return createHash('sha256').update(serializePersonaCollectionDigestInput(personas), 'utf8').digest('hex')
}

function personaIdsDigest(personaIds: readonly string[]): string {
  return createHash('sha256').update(serializePersonaIdsDigestInput(personaIds), 'utf8').digest('hex')
}

function personaProfileDigest(profile: PersonaProfileDigestValue): string {
  return createHash('sha256').update(serializePersonaProfileDigestInput(profile), 'utf8').digest('hex')
}

function seedAssetMetadata(dataDir: string, assetId = 'a'.repeat(64)): string {
  const seedDb = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    insertAssetMetadataBatch(seedDb, [{ id: assetId, ext: 'png', size: 1, contentType: 'image/png' }])
  } finally {
    seedDb.close()
  }
  return assetId
}

let harness: Harness

describe('persona commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('rejects unknown, duplicate, and MCP Persona module links', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      personas: [{ id: 'persona-a', name: 'A', icon: '', personaPrompt: '', note: '' }],
      selectedPersona: 0,
      modules: [
        { id: 'module-a', name: 'Module A', description: '' },
        { id: 'mcp-a', name: 'MCP', description: '', mcp: { url: 'internal:risuai' } },
      ],
    })

    for (const [moduleIds, message] of [
      [['missing'], 'Unknown module id in persona.modules: missing'],
      [['module-a', 'module-a'], 'Duplicate module id in persona.modules: module-a'],
      [['mcp-a'], 'Unknown module id in persona.modules: mcp-a'],
    ] as const) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/commands/personas',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          persona: {
            id: `persona-${moduleIds[0]}`,
            name: 'Linked Persona',
            icon: '',
            personaPrompt: '',
            note: '',
            modules: moduleIds,
          },
        },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe(message)
    }
  })

  it('creates, updates, deletes, and reorders personas by stable id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const personaIconId = seedAssetMetadata(harness.dataDir)
    const revision = await importDatabase(harness.app, assertion, {
      username: 'Current',
      userIcon: 'assets/current.png',
      personaPrompt: 'Current prompt',
      userNote: 'Current note',
      modules: [{ id: 'module-a', name: 'Module A', description: '' }],
      personas: [
        {
          id: 'persona-a',
          name: 'A',
          icon: '',
          personaPrompt: 'a prompt',
          note: 'a note',
        },
      ],
      selectedPersona: 0,
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        persona: {
          id: 'persona-b',
          name: 'B',
          displayName: 'Bee',
          icon: personaIconId,
          personaPrompt: 'b prompt',
          note: 'b note',
          modules: ['module-a'],
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      revision: 2,
      event: {
        type: 'persona.created',
        revision: 2,
        resource: 'persona',
        id: 'persona-b',
      },
      personaId: 'persona-b',
      personaMutationCertificate: 'persona-mutation-v1',
      operation: 'create',
      personaProjectionDigest: personaCollectionDigest([
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'a prompt', note: 'a note' },
        {
          id: 'persona-b',
          name: 'B',
          displayName: 'Bee',
          icon: personaIconId,
          personaPrompt: 'b prompt',
          note: 'b note',
          modules: ['module-a'],
        },
      ]),
      selectedPersonaId: 'persona-b',
      collectionWritten: true,
      settingsWritten: true,
      legacyProfileProjectionApplied: false,
      legacyProfileDigest: null,
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/personas/persona-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: { name: 'B renamed', displayName: 'Localized B', largePortrait: true, modules: ['module-a'] },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({
      revision: 3,
      event: {
        type: 'persona.updated',
        revision: 3,
        resource: 'persona',
        id: 'persona-b',
      },
      personaId: 'persona-b',
      acknowledgedKeys: ['name', 'displayName', 'largePortrait', 'modules'],
      legacyProfileProjectionApplied: false,
    })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        personaIds: ['persona-b', 'persona-a'],
      },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json()).toEqual({
      revision: 4,
      event: {
        type: 'persona.reordered',
        revision: 4,
        resource: 'persona',
      },
      personaMutationCertificate: 'persona-mutation-v1',
      operation: 'reorder',
      personaProjectionDigest: personaCollectionDigest([
        {
          id: 'persona-b',
          name: 'B renamed',
          displayName: 'Localized B',
          icon: personaIconId,
          personaPrompt: 'b prompt',
          note: 'b note',
          largePortrait: true,
          modules: ['module-a'],
        },
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'a prompt', note: 'a note' },
      ]),
      selectedPersonaId: 'persona-b',
      collectionWritten: true,
      settingsWritten: true,
      legacyProfileProjectionApplied: false,
      legacyProfileDigest: null,
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/personas/persona-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: reordered.json().revision,
        selectPersonaId: 'persona-b',
        mirrorLegacyProfile: true,
      },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: 5,
      event: {
        type: 'persona.deleted',
        revision: 5,
        resource: 'persona',
        id: 'persona-a',
      },
      personaId: 'persona-a',
      personaMutationCertificate: 'persona-mutation-v1',
      operation: 'delete',
      personaProjectionDigest: personaCollectionDigest([
        {
          id: 'persona-b',
          name: 'B renamed',
          displayName: 'Localized B',
          icon: personaIconId,
          personaPrompt: 'b prompt',
          note: 'b note',
          largePortrait: true,
          modules: ['module-a'],
        },
      ]),
      selectedPersonaId: 'persona-b',
      collectionWritten: true,
      settingsWritten: true,
      legacyProfileProjectionApplied: true,
      legacyProfileDigest: personaProfileDigest({
        name: 'B renamed',
        icon: personaIconId,
        personaPrompt: 'b prompt',
        note: 'b note',
      }),
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      username: 'B renamed',
      userIcon: personaIconId,
      personaPrompt: 'b prompt',
      userNote: 'b note',
      selectedPersona: 0,
    })
    expect(bootstrap.resourceDatabase.personas).toEqual([
      {
        id: 'persona-b',
        name: 'B renamed',
        displayName: 'Localized B',
        icon: personaIconId,
        personaPrompt: 'b prompt',
        note: 'b note',
        largePortrait: true,
        modules: ['module-a'],
      },
    ])
  })

  it('selects a persona while saving the previous legacy profile mirror fields', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const personaIconId = seedAssetMetadata(harness.dataDir)
    const revision = await importDatabase(harness.app, assertion, {
      username: 'Edited A',
      userIcon: 'assets/edited-a.png',
      personaPrompt: 'edited a prompt',
      userNote: 'edited a note',
      personas: [
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'a prompt', note: '' },
        {
          id: 'persona-b',
          name: 'B',
          icon: personaIconId,
          personaPrompt: 'b prompt',
          note: 'b note',
        },
      ],
      selectedPersona: 0,
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        personaId: 'persona-b',
        saveCurrent: true,
        mirrorLegacyProfile: true,
      },
    })

    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toEqual({
      revision: 2,
      event: {
        type: 'persona.selected',
        revision: 2,
        resource: 'persona',
        id: 'persona-b',
      },
      personaId: 'persona-b',
      personaMutationCertificate: 'persona-mutation-v1',
      operation: 'select',
      personaProjectionDigest: personaCollectionDigest([
        {
          id: 'persona-a',
          name: 'Edited A',
          icon: 'assets/edited-a.png',
          personaPrompt: 'edited a prompt',
          note: 'edited a note',
        },
        {
          id: 'persona-b',
          name: 'B',
          icon: personaIconId,
          personaPrompt: 'b prompt',
          note: 'b note',
        },
      ]),
      selectedPersonaId: 'persona-b',
      collectionWritten: true,
      settingsWritten: true,
      legacyProfileProjectionApplied: true,
      legacyProfileDigest: personaProfileDigest({
        name: 'B',
        icon: personaIconId,
        personaPrompt: 'b prompt',
        note: 'b note',
      }),
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      selectedPersona: 1,
      username: 'B',
      userIcon: personaIconId,
      personaPrompt: 'b prompt',
      userNote: 'b note',
    })
    expect(bootstrap.resourceDatabase.personas[0]).toMatchObject({
      id: 'persona-a',
      name: 'Edited A',
      icon: 'assets/edited-a.png',
      personaPrompt: 'edited a prompt',
      note: 'edited a note',
    })
  })

  it('certifies a no-save persona selection with ordered IDs instead of hashing unrelated row bodies', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      username: 'A',
      userIcon: '',
      personaPrompt: 'A prompt',
      userNote: '',
      personas: [
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'A prompt', note: '' },
        { id: 'persona-b', name: 'B', icon: '', personaPrompt: 'B prompt', note: '' },
      ],
      selectedPersona: 0,
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        personaId: 'persona-b',
        saveCurrent: false,
        mirrorLegacyProfile: true,
      },
    })

    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toEqual({
      revision: 2,
      event: {
        type: 'persona.selected',
        revision: 2,
        resource: 'persona',
        id: 'persona-b',
      },
      personaId: 'persona-b',
      personaMutationCertificate: 'persona-mutation-v1',
      operation: 'select',
      personaProjectionDigest: personaIdsDigest(['persona-a', 'persona-b']),
      selectedPersonaId: 'persona-b',
      collectionWritten: false,
      settingsWritten: true,
      legacyProfileProjectionApplied: true,
      legacyProfileDigest: personaProfileDigest({
        name: 'B',
        icon: '',
        personaPrompt: 'B prompt',
        note: '',
      }),
    })
  })

  it('reports when a persona PATCH applies the selected legacy profile projection', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      username: 'A',
      userIcon: '',
      personaPrompt: 'Old prompt',
      userNote: 'Old note',
      personas: [{ id: 'persona-a', name: 'A', icon: '', personaPrompt: 'Old prompt', note: 'Old note' }],
      selectedPersona: 0,
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/personas/persona-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { personaPrompt: 'New prompt', note: 'New note' },
        mirrorLegacyProfile: true,
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      personaId: 'persona-a',
      acknowledgedKeys: ['personaPrompt', 'note'],
      legacyProfileProjectionApplied: true,
    })
    expect(updated.json()).not.toHaveProperty('persona')
    expect(updated.json()).not.toHaveProperty('settings')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      personaPrompt: 'New prompt',
      userNote: 'New note',
    })
  })

  it('rejects malformed persona commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      personas: [
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'a prompt', note: '' },
        { id: 'persona-b', name: 'B', icon: '', personaPrompt: 'b prompt', note: '' },
      ],
      selectedPersona: 0,
    })

    const update = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/personas/persona-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { largePortrait: 'yes' },
      },
    })
    expect(update.statusCode).toBe(400)
    expect(update.json().error).toBe('patch.largePortrait must be a boolean')

    const invalidDisplayName = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/personas/persona-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { displayName: 123 },
      },
    })
    expect(invalidDisplayName.statusCode).toBe(400)
    expect(invalidDisplayName.json().error).toBe('patch.displayName must be a string')

    const reorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        personaIds: ['persona-a', 'persona-a'],
      },
    })
    expect(reorder.statusCode).toBe(400)
    expect(reorder.json().error).toBe('Duplicate persona id: persona-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.personas.map((persona: { id: string }) => persona.id)).toEqual([
      'persona-a',
      'persona-b',
    ])
  })

  it('fails closed on missing or duplicate stable persona ownership without repairing persisted rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      personas: [
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'a prompt', note: '' },
        { id: 'persona-b', name: 'B', icon: '', personaPrompt: 'b prompt', note: '' },
      ],
      selectedPersonaId: 'persona-a',
      selectedPersona: 0,
    })
    const databasePath = path.join(harness.dataDir, 'risu.db')

    const corruptSettings = new DatabaseSync(databasePath)
    try {
      const row = corruptSettings.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
        data_json: string
      }
      const settings = JSON.parse(row.data_json) as Record<string, unknown>
      settings.selectedPersonaId = 'missing-persona'
      settings.selectedPersona = 0
      corruptSettings.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
    } finally {
      corruptSettings.close()
    }
    expect((loadPersistedFromDir(harness.dataDir).database as Record<string, unknown>).selectedPersona).toBe(-1)

    const missingSelection = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas/select',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, personaId: 'persona-b' },
    })
    expect(missingSelection.statusCode).toBe(400)
    expect(missingSelection.json().error).toBe('selectedPersonaId must reference exactly one existing persona')

    const duplicateRows = new DatabaseSync(databasePath)
    try {
      const settingsRow = duplicateRows.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
        data_json: string
      }
      const settings = JSON.parse(settingsRow.data_json) as Record<string, unknown>
      settings.selectedPersonaId = 'persona-a'
      duplicateRows.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))

      const personaRow = duplicateRows.prepare('SELECT data_json FROM personas WHERE position = 1').get() as {
        data_json: string
      }
      const persona = JSON.parse(personaRow.data_json) as Record<string, unknown>
      persona.id = 'persona-a'
      duplicateRows.prepare('UPDATE personas SET data_json = ? WHERE position = 1').run(JSON.stringify(persona))
    } finally {
      duplicateRows.close()
    }

    const duplicateSelection = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, personaIds: ['persona-a', 'persona-b'] },
    })
    expect(duplicateSelection.statusCode).toBe(400)
    expect(duplicateSelection.json().error).toBe('Duplicate persona id: persona-a')

    const persisted = new DatabaseSync(databasePath)
    try {
      const rows = persisted.prepare('SELECT data_json FROM personas ORDER BY position').all() as Array<{
        data_json: string
      }>
      expect(rows.map((row) => (JSON.parse(row.data_json) as { id: string }).id)).toEqual(['persona-a', 'persona-a'])
      const settingsRow = persisted.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
        data_json: string
      }
      expect(JSON.parse(settingsRow.data_json)).toMatchObject({ selectedPersonaId: 'persona-a', selectedPersona: 0 })
    } finally {
      persisted.close()
    }
  })

  it('returns 404 and 409 for missing personas and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      personas: [{ id: 'persona-a', name: 'A', icon: '', personaPrompt: 'a prompt', note: '' }],
      selectedPersona: 0,
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/personas/missing',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { name: 'Nope' },
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Persona not found: missing')

    const stale = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/personas/persona-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})
