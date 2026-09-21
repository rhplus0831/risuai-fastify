import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../src/db.js'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import { type Harness, startHarness, stopHarness, importDatabase } from './helpers/commandHarness.js'

let harness: Harness

describe('translator preset commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('creates, updates, deletes, and selects translator presets by stable id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      translatorPresets: [
        {
          id: 'translator-a',
          name: 'A',
          prompt: 'translate to A',
          maxResponse: 100,
        },
      ],
      translatorPresetId: 0,
      translatorPrompt: 'translate to A',
      translatorMaxResponse: 100,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'Bound chat',
              note: '',
              message: [],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/translator-presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: {
          id: 'translator-b',
          name: 'B',
          prompt: 'translate to B',
          maxResponse: 200,
        },
        select: true,
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      revision: 2,
      event: {
        type: 'translatorPreset.created',
        revision: 2,
        resource: 'translatorPreset',
        id: 'translator-b',
      },
      presetId: 'translator-b',
    })
    const bindingDb = openDatabase(harness.dataDir)
    try {
      const row = bindingDb.prepare('SELECT data_json FROM chats WHERE id = ?').get('chat-a') as {
        data_json: string
      }
      const chat = JSON.parse(row.data_json)
      chat.translatorPresetId = 'translator-b'
      bindingDb.prepare('UPDATE chats SET data_json = ? WHERE id = ?').run(JSON.stringify(chat), 'chat-a')
    } finally {
      bindingDb.close()
    }

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/translator-presets/translator-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: {
          name: 'B renamed',
          prompt: 'translate to B updated',
          maxResponse: 250,
        },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({
      revision: 3,
      event: {
        type: 'translatorPreset.updated',
        revision: 3,
        resource: 'translatorPreset',
        id: 'translator-b',
      },
      presetId: 'translator-b',
      acknowledgedKeys: ['name', 'prompt', 'maxResponse'],
      selectedPresetId: 'translator-b',
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/translator-presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        presetId: 'translator-a',
      },
    })
    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toEqual({
      revision: 4,
      event: {
        type: 'translatorPreset.selected',
        revision: 4,
        resource: 'translatorPreset',
        id: 'translator-a',
      },
      presetId: 'translator-a',
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/translator-presets/translator-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: selected.json().revision,
        selectPresetId: 'translator-a',
      },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: 5,
      event: {
        type: 'translatorPreset.deleted',
        revision: 5,
        resource: 'state',
        id: 'translator-b',
      },
      presetId: 'translator-b',
      selectedPresetId: 'translator-a',
      cascadedChatIds: ['chat-a'],
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      translatorPresetId: 'translator-a',
      translatorPrompt: 'translate to A',
      translatorMaxResponse: 100,
    })
    expect(bootstrap.resourceDatabase.translatorPresets).toMatchObject([
      {
        id: 'translator-a',
        name: 'A',
        prompt: 'translate to A',
        maxResponse: 100,
      },
    ])
    expect(bootstrap.resourceDatabase.translatorPresets[0].steps).toMatchObject([
      {
        enabled: true,
        prompt: 'translate to A',
        maxResponse: 100,
        model: { mode: 'inheritTranslate' },
      },
    ])
    expect(bootstrap.resourceDatabase.characters[0].chats[0]).not.toHaveProperty('translatorPresetId')
  })

  it('leaves legacy translator fields unchanged when updating the selected preset', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      translatorPresets: [{ id: 'translator-a', name: 'A', prompt: 'old prompt', maxResponse: 100 }],
      translatorPresetId: 0,
      translatorPrompt: 'stale scalar prompt',
      translatorMaxResponse: 7,
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/translator-presets/translator-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          prompt: 'new prompt',
          maxResponse: 321,
        },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({
      revision: 2,
      event: {
        type: 'translatorPreset.updated',
        revision: 2,
        resource: 'translatorPreset',
        id: 'translator-a',
      },
      presetId: 'translator-a',
      acknowledgedKeys: ['prompt', 'maxResponse'],
      selectedPresetId: 'translator-a',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      translatorPrompt: 'stale scalar prompt',
      translatorMaxResponse: 7,
      translatorPresets: [expect.objectContaining({ id: 'translator-a', prompt: 'new prompt', maxResponse: 321 })],
    })
  })

  it('returns the stable selection when updating a non-selected preset without echoing preset data', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      translatorPresets: [
        { id: 'translator-a', name: 'A', prompt: 'a prompt', maxResponse: 100 },
        { id: 'translator-b', name: 'B', prompt: 'b prompt', maxResponse: 200 },
      ],
      translatorPresetId: 0,
      translatorPrompt: 'a prompt',
      translatorMaxResponse: 100,
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/translator-presets/translator-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { prompt: 'a deliberately large prompt is not echoed' },
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({
      revision: 2,
      event: {
        type: 'translatorPreset.updated',
        revision: 2,
        resource: 'translatorPreset',
        id: 'translator-b',
      },
      presetId: 'translator-b',
      acknowledgedKeys: ['prompt'],
      selectedPresetId: 'translator-a',
    })
  })

  it('keeps PATCH acknowledgement scoped when sibling state is already canonical', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      translatorPresets: [
        { id: 'translator-a', name: 'A', prompt: 'a prompt', maxResponse: 100 },
        { id: 'translator-b', name: 'B', prompt: 'b prompt', maxResponse: 200 },
      ],
      translatorPresetId: 0,
      translatorPrompt: 'a prompt',
      translatorMaxResponse: 100,
    })
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      db.prepare('UPDATE translator_presets SET data_json = ? WHERE position = 1').run(
        JSON.stringify({
          id: 'translator-b',
          name: '',
          prompt: 'b prompt',
          maxResponse: 200,
          droppedByNormalization: true,
        }),
      )
    } finally {
      db.close()
    }

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/translator-presets/translator-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { prompt: 'updated a prompt' },
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({
      revision: 2,
      event: {
        type: 'translatorPreset.updated',
        revision: 2,
        resource: 'translatorPreset',
        id: 'translator-a',
      },
      presetId: 'translator-a',
      acknowledgedKeys: ['prompt'],
      selectedPresetId: 'translator-a',
    })
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.translatorPresets[1]).toMatchObject({
      id: 'translator-b',
      name: '',
      prompt: 'b prompt',
      maxResponse: 200,
    })
  })

  it('rejects malformed translator preset commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      translatorPresets: [
        { id: 'translator-a', name: 'A', prompt: 'a prompt', maxResponse: 100 },
        { id: 'translator-b', name: 'B', prompt: 'b prompt', maxResponse: 200 },
      ],
      translatorPresetId: 0,
    })

    const update = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/translator-presets/translator-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { maxResponse: 'large' },
      },
    })
    expect(update.statusCode).toBe(400)
    expect(update.json().error).toBe('patch.maxResponse must be a finite number')

    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/translator-presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: {
          id: 'translator-a',
          name: 'Duplicate',
          prompt: '',
          maxResponse: 100,
        },
      },
    })
    expect(create.statusCode).toBe(400)
    expect(create.json().error).toBe('Duplicate translator preset id: translator-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.translatorPresets.map((preset: { id: string }) => preset.id)).toEqual([
      'translator-a',
      'translator-b',
    ])
  })

  it('returns 404 and 409 for missing translator presets and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      translatorPresets: [{ id: 'translator-a', name: 'A', prompt: 'a prompt', maxResponse: 100 }],
      translatorPresetId: 0,
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/translator-presets/missing',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { name: 'Nope' },
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Translator preset not found: missing')

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/translator-presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
        presetId: 'translator-a',
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})
