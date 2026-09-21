import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MASKED_PROVIDER_SECRET } from '../src/providerSecrets.js'
import { MODEL_ROLES } from '@risuai/shared-core/model-roles'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  readAllDatabaseRows,
  startHarness,
  stopHarness,
  loadPersistedFromDir,
  importDatabase,
  updateSettingsRow,
  uploadAsset,
} from './helpers/commandHarness.js'

let harness: Harness

describe('bot preset commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('rejects missing durable ids on public root create commands', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [{ id: 'preset-a', name: 'A' }],
      personas: [{ id: 'persona-a', name: 'A', icon: '', personaPrompt: '', note: '' }],
      translatorPresets: [{ id: 'translator-a', name: 'A', prompt: '', maxResponse: 100 }],
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
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [],
          chatFolders: [],
          chatPage: 0,
          viewScreen: 'none',
          bias: [],
          emotionImages: [],
          globalLore: [],
          sdData: [],
          customscript: [],
          triggerscript: [],
        },
      ],
      characterOrder: ['char-a'],
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      modules: [{ id: 'mod-a', name: 'A', description: '' }],
    })

    const cases = [
      {
        url: '/api/v1/commands/presets',
        payload: { baseRevision: revision, preset: { name: 'Missing id' } },
        error: 'preset.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/personas',
        payload: { baseRevision: revision, persona: { name: 'Missing id' } },
        error: 'persona.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/translator-presets',
        payload: { baseRevision: revision, preset: { name: 'Missing id' } },
        error: 'translatorPreset.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/loadouts',
        payload: { baseRevision: revision, loadout: { name: 'Missing id' } },
        error: 'loadout.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/characters',
        payload: { baseRevision: revision, character: { name: 'Missing id' } },
        error: 'character.chaId must be a non-empty string',
      },
      {
        url: '/api/v1/commands/characters/char-a/chats',
        payload: { baseRevision: revision, chat: { name: 'Missing id' } },
        error: 'chat.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/characters/char-a/chat-folders',
        payload: { baseRevision: revision, folder: { name: 'Missing id' } },
        error: 'folder.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/lorebooks',
        payload: { baseRevision: revision, lorebook: { name: 'Missing id', data: [] } },
        error: 'lorebook.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/modules',
        payload: { baseRevision: revision, module: { name: 'Missing id' } },
        error: 'module.id must be a non-empty string',
      },
    ]

    for (const testCase of cases) {
      const res = await harness.app.inject({
        method: 'POST',
        url: testCase.url,
        headers: { 'risu-auth': assertion },
        payload: testCase.payload,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe(testCase.error)
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
  })

  it('creates and updates presets with command events', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [{ id: 'preset-a', name: 'A', mainPrompt: 'a prompt' }],
      botPresetsId: 0,
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: { id: 'preset-b', name: 'B', mainPrompt: 'b prompt' },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      revision: 2,
      event: {
        type: 'preset.created',
        revision: 2,
        resource: 'presetCollection',
        id: 'preset-b',
      },
      presetId: 'preset-b',
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: {
          name: 'B renamed',
          agentPresets: [{ id: 'agent-preset-b', name: 'Agent B', enabled: true, version: 1, steps: [] }],
          agentPresetDefaultId: 'agent-preset-b',
        },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().event).toMatchObject({
      type: 'preset.updated',
      resource: 'presetRow',
      id: 'preset-b',
    })
    expect(updated.json()).toMatchObject({
      presetId: 'preset-b',
      acknowledgedKeys: ['name', 'agentPresets', 'agentPresetDefaultId'],
      canonicalValues: {},
      canonicalDeletedKeys: [],
    })

    const updatedAgentList = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        patch: {
          agentPresets: [{ id: 'agent-preset-c', name: 'Agent C', enabled: true, version: 1, steps: [] }],
        },
      },
    })
    expect(updatedAgentList.statusCode).toBe(200)
    expect(updatedAgentList.json()).toMatchObject({
      presetId: 'preset-b',
      acknowledgedKeys: ['agentPresets'],
      canonicalValues: {},
      canonicalDeletedKeys: ['agentPresetDefaultId'],
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.botPresets).toMatchObject([
      { id: 'preset-a', name: 'A' },
      { id: 'preset-b', name: 'B renamed' },
    ])

    const storedPreset = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/legacy-presets/preset-b',
      headers: { 'risu-auth': assertion },
    })
    expect(storedPreset.statusCode).toBe(200)
    expect(storedPreset.json().preset).toMatchObject({
      id: 'preset-b',
      name: 'B renamed',
      agentPresets: [{ id: 'agent-preset-c', name: 'Agent C', enabled: true, version: 1, steps: [] }],
    })
    expect(storedPreset.json().preset).not.toHaveProperty('agentPresetDefaultId')
  })

  it('returns masked sparse canonical preset values after normalization', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [{ id: 'preset-a', name: 'A' }],
      botPresetsId: 0,
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          modelProfiles: [
            {
              id: ' profile-a ',
              name: ' Profile A ',
              providerId: ' openai ',
              modelId: ' gpt-5 ',
              providerOptions: { apiKey: 'receipt-must-not-leak' },
            },
          ],
        },
      },
    })

    expect(updated.statusCode, updated.body).toBe(200)
    expect(updated.json()).toMatchObject({
      presetId: 'preset-a',
      acknowledgedKeys: ['modelProfiles'],
      canonicalValues: {
        modelProfiles: [
          {
            id: 'profile-a',
            name: 'Profile A',
            providerId: 'openai',
            modelId: 'gpt-5',
          },
        ],
      },
      canonicalDeletedKeys: [],
    })
    expect(updated.body).not.toContain('receipt-must-not-leak')
  })

  it('resolves masked legacy scalar secrets in preset PATCHes before persisting them', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        {
          id: 'preset-a',
          name: 'A',
          openAIKey: 'stored-openai-secret',
          proxyKey: 'stored-proxy-secret',
        },
      ],
      botPresetsId: 0,
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          openAIKey: MASKED_PROVIDER_SECRET,
          proxyKey: MASKED_PROVIDER_SECRET,
        },
      },
    })

    expect(updated.statusCode, updated.body).toBe(200)
    expect(updated.body).not.toContain('stored-openai-secret')
    expect(updated.body).not.toContain('stored-proxy-secret')
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      botPresets: Array<Record<string, any>>
    }
    expect(persisted.botPresets[0]).toMatchObject({
      id: 'preset-a',
      openAIKey: 'stored-openai-secret',
      proxyKey: 'stored-proxy-secret',
    })
  })

  it('validates preset image asset references on create and patch', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const uploaded = await uploadAsset(harness.app, assertion, Buffer.from('preset-image'))
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [{ id: 'preset-a', name: 'A', image: '' }],
      botPresetsId: 0,
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: { id: 'preset-b', name: 'B', image: uploaded.assetId },
      },
    })
    expect(created.statusCode).toBe(200)

    const patchedValid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: { image: uploaded.assetId },
      },
    })
    expect(patchedValid.statusCode).toBe(200)

    const clearValues: unknown[] = [null, '', '-']
    let baseRevision = patchedValid.json().revision as number
    for (const image of clearValues) {
      const cleared = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/presets/preset-a',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision,
          patch: { image },
        },
      })
      expect(cleared.statusCode).toBe(200)
      baseRevision = cleared.json().revision as number
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.botPresets).toMatchObject([
      { id: 'preset-a', name: 'A', image: '-' },
      { id: 'preset-b', name: 'B', image: uploaded.assetId },
    ])
  })

  it('rejects malformed and missing preset image asset refs without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [{ id: 'preset-a', name: 'A', image: '' }],
      botPresetsId: 0,
    })
    const missingAssetId = '0'.repeat(64)

    const malformedCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: { id: 'preset-b', name: 'B', image: 'assets/not-server.png' },
      },
    })
    expect(malformedCreate.statusCode).toBe(400)
    expect(malformedCreate.json().error).toBe('preset.image must be a server asset id')

    const missingCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: { id: 'preset-b', name: 'B', image: missingAssetId },
      },
    })
    expect(missingCreate.statusCode).toBe(400)
    expect(missingCreate.json().error).toBe('preset.image references a missing server asset')

    const malformedImport = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/import',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: { id: 'preset-b', name: 'B', image: 'assets/not-server.png' },
      },
    })
    expect(malformedImport.statusCode).toBe(400)
    expect(malformedImport.json().error).toBe('preset.image must be a server asset id')

    const missingImport = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/import',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: { id: 'preset-b', name: 'B', image: missingAssetId },
      },
    })
    expect(missingImport.statusCode).toBe(400)
    expect(missingImport.json().error).toBe('preset.image references a missing server asset')

    const malformedPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { image: 'assets/not-server.png' },
      },
    })
    expect(malformedPatch.statusCode).toBe(400)
    expect(malformedPatch.json().error).toBe('patch.image must be a server asset id')

    const missingPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { image: missingAssetId },
      },
    })
    expect(missingPatch.statusCode).toBe(400)
    expect(missingPatch.json().error).toBe('patch.image references a missing server asset')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.botPresets).toMatchObject([{ id: 'preset-a', name: 'A', image: '' }])
  })

  it('selects and applies a preset while saving the previously selected snapshot', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A', mainPrompt: 'old saved', temperature: 50 },
        {
          id: 'preset-b',
          name: 'B',
          mainPrompt: 'target prompt',
          temperature: 90,
          modelRuntimeDefaults: { maxContext: 9000, modelTools: ['target-tool'] },
          modelProfiles: [
            { id: ' target-profile ', name: ' Target Profile ', modelId: ' target-model ' },
            { id: 'target-profile', name: 'Duplicate' },
          ],
          modelRoleProfiles: {
            memory: { mode: 'profile', profileId: ' target-profile ' },
          },
          agentPresets: [
            { id: ' agent-target ', name: ' Target Agent ', enabled: true, version: 1, steps: [] },
            { id: 'agent-target', name: 'Duplicate', enabled: true, version: 1, steps: [] },
          ],
          agentPresetDefaultId: ' agent-target ',
        },
      ],
      botPresetsId: 0,
      mainPrompt: 'current prompt',
      temperature: 72,
      modelRuntimeDefaults: { maxContext: 7200, modelTools: ['current-tool'] },
      modelProfiles: [{ id: 'current-profile', name: 'Current Profile', modelId: 'current-model' }],
      modelRoleProfiles: {
        memory: { mode: 'profile', profileId: 'current-profile' },
      },
      agentPresets: [{ id: 'current-agent', name: 'Current Agent', enabled: true, version: 1, steps: [] }],
      agentPresetDefaultId: 'current-agent',
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        presetId: 'preset-b',
        saveCurrent: true,
        apply: true,
      },
    })

    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toEqual({
      revision: 2,
      event: {
        type: 'preset.selected',
        revision: 2,
        resource: 'presetApplied',
        id: 'preset-b',
        parentId: 'preset-a',
      },
      presetId: 'preset-b',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      botPresetsId: 1,
      mainPrompt: 'target prompt',
      temperature: 90,
      modelRuntimeDefaults: { maxContext: 9000, modelTools: ['target-tool'] },
      modelProfiles: [{ id: 'target-profile', name: 'Target Profile', modelId: 'target-model' }],
      modelRoleProfiles: {
        ...Object.fromEntries(MODEL_ROLES.map((role) => [role, { mode: 'legacy' }])),
        memory: { mode: 'profile', profileId: 'target-profile' },
      },
      agentPresets: [{ id: 'agent-target', name: 'Target Agent', enabled: true, version: 1, steps: [] }],
      agentPresetDefaultId: 'agent-target',
    })
    expect(bootstrap.resourceDatabase.botPresets[0]).toMatchObject({ id: 'preset-a', name: 'A', image: '' })
    const savedPreset = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/legacy-presets/preset-a',
      headers: { 'risu-auth': assertion },
    })
    expect(savedPreset.statusCode).toBe(200)
    expect(savedPreset.json().preset).toMatchObject({
      id: 'preset-a',
      name: 'A',
      mainPrompt: 'current prompt',
      temperature: 72,
      modelRuntimeDefaults: { maxContext: 7200, modelTools: ['current-tool'] },
      modelProfiles: [{ id: 'current-profile', name: 'Current Profile', modelId: 'current-model' }],
      modelRoleProfiles: expect.objectContaining({
        memory: { mode: 'profile', profileId: 'current-profile' },
      }),
      agentPresets: [{ id: 'current-agent', name: 'Current Agent', enabled: true, version: 1, steps: [] }],
      agentPresetDefaultId: 'current-agent',
    })
  })

  it('saves and applies additionalParams when selecting a legacy preset', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A', additionalParams: [['stale', 'value']] },
        { id: 'preset-b', name: 'B', additionalParams: [['target', 'value']] },
      ],
      botPresetsId: 0,
      additionalParams: [['current', 'value']],
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        presetId: 'preset-b',
        saveCurrent: true,
        apply: true,
      },
    })

    expect(selected.statusCode, selected.body).toBe(200)
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      additionalParams: Array<[string, string]>
      botPresets: Array<{ id: string; additionalParams?: Array<[string, string]> }>
    }
    expect(persisted.additionalParams).toEqual([['target', 'value']])
    expect(persisted.botPresets[0]?.additionalParams).toEqual([['current', 'value']])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.additionalParams).toEqual([['target', 'value']])
    const savedPreset = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/legacy-presets/preset-a',
      headers: { 'risu-auth': assertion },
    })
    expect(savedPreset.statusCode).toBe(200)
    expect(savedPreset.json().preset.additionalParams).toEqual([['current', 'value']])
  })

  it.each([
    {
      name: 'absent field',
      target: {},
      expected: [['current', 'value']],
    },
    {
      name: 'explicit null',
      target: { additionalParams: null },
      expected: null,
    },
    {
      name: 'default empty array reset',
      target: { additionalParams: [] },
      expected: [],
    },
  ])('keeps the $name distinct when applying legacy preset additionalParams', async ({ target, expected }) => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A', additionalParams: [['stale', 'value']] },
        { id: 'preset-b', name: 'B', ...target },
      ],
      botPresetsId: 0,
      additionalParams: [['current', 'value']],
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        presetId: 'preset-b',
        saveCurrent: false,
        apply: true,
      },
    })

    expect(selected.statusCode, selected.body).toBe(200)
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      additionalParams: unknown
      botPresets: Array<Record<string, unknown>>
    }
    expect(persisted.additionalParams).toEqual(expected)
    expect(persisted.botPresets[1]).toEqual(expect.objectContaining({ id: 'preset-b', name: 'B', ...target }))
  })

  it('snapshots normalized default additionalParams before applying a non-default legacy preset', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A' },
        {
          id: 'preset-b',
          name: 'B',
          additionalParams: [
            ['body.option', 'true'],
            ['header::X-Target', 'target'],
          ],
        },
      ],
      botPresetsId: 0,
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        presetId: 'preset-b',
        saveCurrent: true,
        apply: true,
      },
    })

    expect(selected.statusCode, selected.body).toBe(200)
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      additionalParams: Array<[string, string]>
      botPresets: Array<{ id: string; additionalParams?: Array<[string, string]> }>
    }
    expect(persisted.additionalParams).toEqual([
      ['body.option', 'true'],
      ['header::X-Target', 'target'],
    ])
    expect(persisted.botPresets[0]?.additionalParams).toEqual([])
  })

  it('reports the exact resource shape for no-apply preset selection', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A', mainPrompt: 'a prompt' },
        { id: 'preset-b', name: 'B', mainPrompt: 'b prompt' },
      ],
      botPresetsId: 0,
    })

    const settingsOnly = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        presetId: 'preset-b',
        saveCurrent: false,
        apply: false,
      },
    })
    expect(settingsOnly.statusCode).toBe(200)
    expect(settingsOnly.json().event).toMatchObject({
      type: 'preset.selected',
      resource: 'presetPointer',
      id: 'preset-b',
    })

    const revisionOnly = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: settingsOnly.json().revision,
        presetId: 'preset-b',
        saveCurrent: false,
        apply: false,
      },
    })
    expect(revisionOnly.statusCode).toBe(200)
    expect(revisionOnly.json().event).toMatchObject({
      type: 'preset.selected',
      resource: 'revisionOnly',
      id: 'preset-b',
    })

    const collectionOnly = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revisionOnly.json().revision,
        presetId: 'preset-b',
        saveCurrent: true,
        apply: false,
      },
    })
    expect(collectionOnly.statusCode).toBe(200)
    expect(collectionOnly.json().event).toMatchObject({
      type: 'preset.selected',
      resource: 'presetCollection',
      id: 'preset-b',
    })

    const settingsAndCollection = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: collectionOnly.json().revision,
        presetId: 'preset-a',
        saveCurrent: true,
        apply: false,
      },
    })
    expect(settingsAndCollection.statusCode).toBe(200)
    expect(settingsAndCollection.json().event).toMatchObject({
      type: 'preset.selected',
      resource: 'presetCollectionWithPointer',
      id: 'preset-a',
    })
  })

  it('copies, deletes, and reorders presets by id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A', mainPrompt: 'a prompt' },
        { id: 'preset-b', name: 'B', mainPrompt: 'b prompt' },
      ],
      botPresetsId: 0,
    })

    const copied = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/preset-a/copy',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        newPresetId: 'preset-copy',
        name: 'A Copy',
      },
    })
    expect(copied.statusCode).toBe(200)
    const copiedPresetId = copied.json().presetId as string
    expect(copiedPresetId).toBe('preset-copy')
    expect(copied.json().event).toMatchObject({
      type: 'preset.copied',
      resource: 'presetCollection',
      id: copiedPresetId,
    })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: copied.json().revision,
        presetIds: ['preset-b', copiedPresetId, 'preset-a'],
      },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json()).toMatchObject({
      presetReorderCertificate: 'preset-reorder-v1',
      presetKind: 'legacy',
      presetIds: ['preset-b', copiedPresetId, 'preset-a'],
      selectedPresetId: 'preset-a',
      settingsWritten: true,
      event: {
        type: 'preset.reordered',
        resource: 'presetCollectionWithPointer',
      },
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/commands/presets/${copiedPresetId}`,
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: reordered.json().revision,
        presetId: 'preset-b',
        apply: false,
      },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: 4,
      event: {
        type: 'preset.deleted',
        revision: 4,
        resource: 'presetCollectionWithPointer',
        id: copiedPresetId,
      },
      presetId: copiedPresetId,
      selectedPresetId: 'preset-b',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.botPresets.map((preset: { id: string }) => preset.id)).toEqual([
      'preset-b',
      'preset-a',
    ])
    expect(bootstrap.resourceDatabase.botPresetsId).toBe(0)
  })

  it('rejects preset reorder when the persisted selected pointer requires repair', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A' },
        { id: 'preset-b', name: 'B' },
      ],
      botPresetsId: 0,
    })
    updateSettingsRow(harness.dataDir, (settings) => {
      settings.botPresetsId = 99
    })
    const damagedRows = readAllDatabaseRows(harness.dataDir)

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        presetIds: ['preset-b', 'preset-a'],
      },
    })

    expect(reordered.statusCode, reordered.body).toBe(400)
    expect(reordered.json().error).toBe('botPresetsId must select an existing record')
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(damagedRows)
  })

  it('rejects missing and duplicate preset ids on copy and import', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A' },
        { id: 'preset-b', name: 'B' },
      ],
      botPresetsId: 0,
    })

    const cases = [
      {
        url: '/api/v1/commands/presets/preset-a/copy',
        payload: { baseRevision: revision, name: 'Missing id' },
        error: 'newPresetId must be a non-empty string',
      },
      {
        url: '/api/v1/commands/presets/preset-a/copy',
        payload: { baseRevision: revision, newPresetId: 'preset-b', name: 'Duplicate' },
        error: 'Duplicate preset id: preset-b',
      },
      {
        url: '/api/v1/commands/presets/import',
        payload: { baseRevision: revision, preset: { name: 'Missing id' } },
        error: 'preset.id must be a non-empty string',
      },
      {
        url: '/api/v1/commands/presets/import',
        payload: { baseRevision: revision, preset: { id: 'preset-b', name: 'Duplicate' } },
        error: 'Duplicate preset id: preset-b',
      },
    ]

    for (const testCase of cases) {
      const res = await harness.app.inject({
        method: 'POST',
        url: testCase.url,
        headers: { 'risu-auth': assertion },
        payload: testCase.payload,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe(testCase.error)
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.botPresets.map((preset: { id: string }) => preset.id)).toEqual([
      'preset-a',
      'preset-b',
    ])
  })

  it('rejects malformed preset reorder without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [
        { id: 'preset-a', name: 'A' },
        { id: 'preset-b', name: 'B' },
      ],
      botPresetsId: 0,
    })

    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/presets/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        presetIds: ['preset-a', 'preset-a'],
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Duplicate preset id: preset-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.botPresets.map((preset: { id: string }) => preset.id)).toEqual([
      'preset-a',
      'preset-b',
    ])
  })

  it('returns 404 and 409 for missing presets and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [{ id: 'preset-a', name: 'A' }],
      botPresetsId: 0,
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/missing',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { name: 'Nope' },
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Preset not found: missing')

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/presets/preset-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
        patch: { name: 'stale' },
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})
