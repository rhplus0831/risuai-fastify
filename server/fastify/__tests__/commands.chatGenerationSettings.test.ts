import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readChatGenerationSettingsSave } from '../src/commands/chats.js'
import {
  serializeChatGenerationSettingsDigestInput,
  type ChatGenerationSettings,
} from '@risuai/shared-core/chat-generation-settings'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  readAllDatabaseRows,
  startHarness,
  stopHarness,
  importDatabase,
  readJsonRow,
  writeJsonRow,
} from './helpers/commandHarness.js'

function chatGenerationSettingsDigest(settings: ChatGenerationSettings | null | undefined): string {
  return createHash('sha256').update(serializeChatGenerationSettingsDigestInput(settings), 'utf8').digest('hex')
}

let harness: Harness

describe('chat generation settings prompt owner validation', () => {
  it.each(['missing', 'duplicate'])('rejects a %s prompt preset owner', (kind) => {
    const promptPresets = kind === 'missing' ? [{ id: 'other' }] : [{ id: 'prompt-a' }, { id: 'prompt-a' }]
    const context = {
      personas: [],
      modelPresets: [],
      promptPresets,
    }

    expect(() =>
      readChatGenerationSettingsSave({ promptPresetId: 'prompt-a', jailbreakToggle: false }, context),
    ).toThrow('Unknown prompt preset id in generationSettings.promptPresetId: prompt-a')
  })
})

describe('chat generation settings commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('keeps native create chats incomplete by default and persists explicit generation settings', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A', customPromptTemplateToggle: 'mode=Mode' }],
      personas: [{ id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' }],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const omitted = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-omitted',
          name: 'Omitted settings',
          note: '',
          message: [],
          localLore: [],
        },
      },
    })
    expect(omitted.statusCode).toBe(200)
    expect(omitted.json().event).toMatchObject({
      type: 'chat.created',
      resource: 'characterRow',
      id: 'chat-omitted',
      parentId: 'char-a',
    })
    expect(omitted.json().generationSettings).toBeNull()

    const explicitSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      jailbreakToggle: false,
      sidebarToggles: { mode: '1' },
    }
    const explicit = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: omitted.json().revision,
        chat: {
          id: 'chat-explicit',
          name: 'Explicit settings',
          note: '',
          message: [],
          localLore: [],
          generationSettings: explicitSettings,
        },
      },
    })
    expect(explicit.statusCode).toBe(200)
    expect(explicit.json().generationSettings).toEqual(explicitSettings)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const chats = bootstrap.resourceDatabase.characters[0].chats as Array<{
      id: string
      generationSettings?: Record<string, unknown>
    }>
    expect(chats.find((chat) => chat.id === 'chat-omitted')?.generationSettings).toBeUndefined()
    expect(chats.find((chat) => chat.id === 'chat-explicit')?.generationSettings).toEqual(explicitSettings)
  })

  it('persists chat generation settings with explicit off values and prunes stale toggles', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: ['mod-global'],
      agentPresets: [{ id: 'agent-preset-a', name: 'Agent Preset A', enabled: true, version: 1, steps: [] }],
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [
        {
          id: 'prompt-a',
          name: 'Prompt A',
          jailbreak: 'jailbreak text',
          customPromptTemplateToggle: 'mode=Mode\nnotes=Notes=text',
          moduleIntergration: 'preset-space',
        },
      ],
      personas: [{ id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' }],
      modules: [
        { id: 'mod-global', name: 'Global', description: '', customModuleToggle: 'global=Global' },
        {
          id: 'mod-chat',
          name: 'Chat',
          description: '',
          customModuleToggle: 'chatMode=Chat Mode=select=on,off',
        },
        {
          id: 'mod-character',
          name: 'Character',
          description: '',
          customModuleToggle: 'charText=Character Text=text',
        },
        {
          id: 'mod-integrated',
          namespace: 'preset-space',
          name: 'Integrated',
          description: '',
          customModuleToggle: 'integrated=Integrated=textarea',
        },
      ],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          modules: ['mod-character'],
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              modules: ['mod-chat'],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const saved = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationSettings: {
          configured: true,
          personaId: 'persona-a',
          modelPresetId: 'model-a',
          modelPresetSelectionSource: 'manual',
          promptPresetId: 'prompt-a',
          agentPresetId: 'agent-preset-a',
          togglePresetId: 'deleted-toggle-preset',
          jailbreakToggle: false,
          sidebarToggles: {
            mode: '0',
            notes: '',
            global: '1',
            chatMode: 'off',
            charText: '',
            integrated: '',
            deleted: '1',
          },
        },
      },
    })

    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({
      revision: revision + 1,
      chatId: 'chat-a',
      event: {
        type: 'chat.updated',
        resource: 'characterRow',
        id: 'chat-a',
        parentId: 'char-a',
      },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].chats[0].generationSettings).toEqual({
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      modelPresetSelectionSource: 'manual',
      promptPresetId: 'prompt-a',
      agentPresetId: 'agent-preset-a',
      togglePresetId: 'deleted-toggle-preset',
      jailbreakToggle: false,
      sidebarToggles: {
        mode: '0',
        notes: '',
        global: '1',
        chatMode: 'off',
        charText: '',
        integrated: '',
      },
    })
  })

  it('patches chat generation settings sparsely and returns only an exact application certificate', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentPresets: [{ id: 'agent-preset-a', name: 'Agent Preset A', enabled: true, version: 1, steps: [] }],
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [
        {
          id: 'prompt-a',
          name: 'Prompt A',
          customPromptTemplateToggle: 'mode=Mode\nnotes=Notes=text',
        },
        {
          id: 'prompt-b',
          name: 'Prompt B',
          customPromptTemplateToggle: 'mode=Mode',
        },
      ],
      personas: [{ id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' }],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              generationSettings: {
                configured: true,
                personaId: 'persona-a',
                modelPresetId: 'model-a',
                promptPresetId: 'prompt-a',
                agentPresetId: 'agent-preset-a',
                jailbreakToggle: false,
                sidebarToggles: { mode: 'warm', notes: 'keep me' },
              },
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const saved = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        baseGenerationSettingsDigest: chatGenerationSettingsDigest({
          configured: false,
          personaId: 'persona-a',
          modelPresetId: 'model-a',
          promptPresetId: 'prompt-a',
          agentPresetId: 'agent-preset-a',
          jailbreakToggle: false,
          sidebarToggles: { mode: 'warm', notes: 'keep me' },
        }),
        patch: {
          promptPresetId: 'prompt-b',
          sidebarToggles: { mode: 'cold', stale: '1' },
        },
        deleteKeys: ['agentPresetId'],
        sidebarToggleDeleteKeys: ['notes'],
      },
    })

    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toEqual({
      revision: revision + 1,
      event: {
        type: 'chat.updated',
        resource: 'characterRow',
        revision: revision + 1,
        id: 'chat-a',
        parentId: 'char-a',
      },
      chatId: 'chat-a',
      characterId: 'char-a',
      certificate: 'chat-generation-settings-sparse-v1',
      patchedKeys: ['promptPresetId', 'sidebarToggles'],
      deletedKeys: ['agentPresetId'],
      sidebarTogglePatchedKeys: ['mode', 'stale'],
      sidebarToggleDeletedKeys: ['notes'],
      prunedSidebarToggleKeys: ['stale'],
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].chats[0].generationSettings).toEqual({
      configured: false,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-b',
      jailbreakToggle: false,
      sidebarToggles: { mode: 'cold' },
    })

    const staleBase = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision + 1,
        baseGenerationSettingsDigest: '0'.repeat(64),
        patch: { configured: true },
      },
    })
    expect(staleBase.statusCode).toBe(200)
    expect(staleBase.json()).toMatchObject({
      revision: revision + 2,
      generationSettings: {
        configured: true,
        personaId: 'persona-a',
        modelPresetId: 'model-a',
        promptPresetId: 'prompt-b',
        jailbreakToggle: false,
        sidebarToggles: { mode: 'cold' },
      },
    })
    expect(staleBase.json()).not.toHaveProperty('certificate')
  })

  it('rejects removing a still-required Persona-module toggle value without advancing revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const generationSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      jailbreakToggle: false,
      sidebarToggles: { personaFlag: '1' },
    }
    const revision = await importDatabase(harness.app, assertion, {
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }],
      personas: [
        {
          id: 'persona-a',
          name: 'Persona A',
          icon: '',
          personaPrompt: '',
          note: '',
          modules: ['module-persona'],
        },
      ],
      modules: [
        {
          id: 'module-persona',
          name: 'Persona module',
          description: '',
          customModuleToggle: 'personaFlag=Persona flag',
        },
      ],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              generationSettings,
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const baseline = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const persistedGenerationSettings = baseline.resourceDatabase.characters[0].chats[0].generationSettings
    expect(persistedGenerationSettings.sidebarToggles).toEqual({ personaFlag: '1' })

    const sparseDelete = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        baseGenerationSettingsDigest: chatGenerationSettingsDigest(persistedGenerationSettings),
        patch: {},
        sidebarToggleDeleteKeys: ['personaFlag'],
      },
    })
    expect(sparseDelete.statusCode).toBe(400)

    const fullDelete = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationSettings: {
          ...persistedGenerationSettings,
          sidebarToggles: {},
        },
      },
    })
    expect(fullDelete.statusCode).toBe(400)

    const unchanged = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(unchanged.json().revision).toBe(revision)
    expect(unchanged.resourceDatabase.characters[0].chats[0].generationSettings).toEqual(persistedGenerationSettings)
  })

  it('rejects ambiguous sparse generation-settings updates without advancing the revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const initialSettings = {
      configured: false,
      jailbreakToggle: false,
      sidebarToggles: { mode: 'warm', notes: 'old' },
    }
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              generationSettings: initialSettings,
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const invalidPayloads = [
      { generationSettings: initialSettings, patch: { configured: false } },
      {},
      { patch: { unknown: true } },
      { patch: {}, deleteKeys: ['configured', 'configured'] },
      { patch: { configured: false }, deleteKeys: ['configured'] },
      { patch: {}, deleteKeys: ['jailbreakToggle'] },
      {
        patch: { sidebarToggles: { mode: 'cold' } },
        deleteKeys: ['sidebarToggles'],
      },
      {
        patch: { sidebarToggles: { mode: 'cold' } },
        sidebarToggleDeleteKeys: ['mode'],
      },
      { patch: { configured: false }, unexpected: true },
    ]

    for (const payload of invalidPayloads) {
      const response = await harness.app.inject({
        method: 'PUT',
        url: '/api/v1/commands/chats/chat-a/generation-settings',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, ...payload },
      })
      expect(response.statusCode, JSON.stringify(response.json())).toBe(400)
    }

    const unchanged = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(unchanged.json().revision).toBe(revision)
    expect(unchanged.resourceDatabase.characters[0].chats[0].generationSettings).toEqual(initialSettings)

    const valid = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        baseGenerationSettingsDigest: chatGenerationSettingsDigest(initialSettings),
        patch: { configured: false },
      },
    })
    expect(valid.statusCode).toBe(200)
    expect(valid.json().revision).toBe(revision + 1)
  })

  it('rejects invalid chat generation settings without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }],
      agentPresets: [{ id: 'agent-preset-a', name: 'Agent Preset A', enabled: true, version: 1, steps: [] }],
      personas: [{ id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' }],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const validBase = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      agentPresetId: 'agent-preset-a',
      jailbreakToggle: true,
      sidebarToggles: {},
    }
    const cases = [
      {
        generationSettings: { ...validBase, personaId: 'missing-persona' },
        error: 'Unknown persona id in generationSettings.personaId: missing-persona',
      },
      {
        generationSettings: { ...validBase, modelPresetId: 'missing-model-preset' },
        error: 'Unknown model preset id in generationSettings.modelPresetId: missing-model-preset',
      },
      {
        generationSettings: { ...validBase, modelPresetSelectionSource: 'automatic' },
        error: 'generationSettings.modelPresetSelectionSource must be manual or prompt-recommendation',
      },
      {
        generationSettings: { ...validBase, promptPresetId: 'missing-prompt-preset' },
        error: 'Unknown prompt preset id in generationSettings.promptPresetId: missing-prompt-preset',
      },
      {
        generationSettings: { ...validBase, agentPresetId: 'missing-agent-preset' },
        error: 'Unknown agent preset id in generationSettings.agentPresetId: missing-agent-preset',
      },
      {
        generationSettings: { ...validBase, agentPresetId: 123 },
        error: 'generationSettings.agentPresetId must be a string',
      },
      {
        generationSettings: { ...validBase, togglePresetId: 123 },
        error: 'generationSettings.togglePresetId must be a string',
      },
      {
        generationSettings: { ...validBase, sidebarToggles: { mode: 1 } },
        error: 'generationSettings.sidebarToggles.mode must be a string',
      },
      {
        generationSettings: {
          configured: true,
          personaId: 'persona-a',
          modelPresetId: 'model-a',
          promptPresetId: 'prompt-a',
          sidebarToggles: {},
        },
        error: 'generationSettings.jailbreakToggle must be present',
      },
    ]

    for (const testCase of cases) {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/v1/commands/chats/chat-a/generation-settings',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          generationSettings: testCase.generationSettings,
        },
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
    expect(bootstrap.resourceDatabase.characters[0].chats[0].generationSettings).toBeUndefined()
  })

  it('rejects generic chat patches that include generation settings', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      botPresets: [{ id: 'preset-a', name: 'Preset A' }],
      personas: [{ id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' }],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const patch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          generationSettings: {
            configured: true,
            personaId: 'persona-a',
            presetId: 'preset-a',
            jailbreakToggle: false,
            sidebarToggles: {},
          },
        },
      },
    })

    expect(patch.statusCode).toBe(400)
    expect(patch.json().error).toBe('patch.generationSettings is owned by a later command slice')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.characters[0].chats[0].generationSettings).toBeUndefined()
  })

  it('returns malformed stored chat generation settings without repairing persisted rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDatabase(harness.app, assertion, {
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }],
      personas: [{ id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' }],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            { id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] },
            { id: 'chat-b', name: 'B chat', note: '', message: [], localLore: [] },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    writeJsonRow(harness.dataDir, 'chats', 'chat-a', {
      ...readJsonRow(harness.dataDir, 'chats', 'chat-a'),
      generationSettings: {
        configured: true,
        personaId: 123,
        modelPresetId: 'model-a',
        promptPresetId: 'prompt-a',
        togglePresetId: 'missing-is-valid',
        jailbreakToggle: 'bad',
        sidebarToggles: {
          valid: 'on',
          invalid: 1,
          '': 'blank-key',
        },
        unsupported: 'drop-me',
      },
    })
    writeJsonRow(harness.dataDir, 'chats', 'chat-b', {
      ...readJsonRow(harness.dataDir, 'chats', 'chat-b'),
      generationSettings: {
        personaId: 123,
        jailbreakToggle: 'bad',
        sidebarToggles: { invalid: false },
        unsupported: 'drop-me',
      },
    })
    const damagedRows = readAllDatabaseRows(harness.dataDir)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })

    expect(bootstrap.statusCode).toBe(200)
    const chats = bootstrap.resourceDatabase.characters[0].chats as Array<{
      generationSettings?: Record<string, unknown>
    }>
    expect(chats[0].generationSettings).toEqual({
      configured: true,
      personaId: 123,
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      togglePresetId: 'missing-is-valid',
      jailbreakToggle: 'bad',
      sidebarToggles: { valid: 'on', invalid: 1, '': 'blank-key' },
      unsupported: 'drop-me',
    })
    expect(Object.keys(chats[0].generationSettings ?? {}).sort()).toEqual([
      'configured',
      'jailbreakToggle',
      'modelPresetId',
      'personaId',
      'promptPresetId',
      'sidebarToggles',
      'togglePresetId',
      'unsupported',
    ])
    expect(chats[1].generationSettings).toEqual({
      personaId: 123,
      jailbreakToggle: 'bad',
      sidebarToggles: { invalid: false },
      unsupported: 'drop-me',
    })
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(damagedRows)
  })

  it('leaves chat generation settings unchanged when global persona and preset selections move', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [
        { id: 'prompt-a', name: 'Prompt A', mainPrompt: 'a' },
        { id: 'prompt-b', name: 'Prompt B', mainPrompt: 'b' },
      ],
      promptPresetsId: 0,
      personas: [
        { id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: 'a', note: '' },
        { id: 'persona-b', name: 'Persona B', icon: '', personaPrompt: 'b', note: '' },
      ],
      selectedPersona: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
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
    const chatGenerationSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      jailbreakToggle: false,
      sidebarToggles: {},
    }

    const savedSettings = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationSettings: chatGenerationSettings,
      },
    })
    expect(savedSettings.statusCode).toBe(200)
    expect(savedSettings.json()).toMatchObject({
      chatId: 'chat-a',
      characterId: 'char-a',
      generationSettings: chatGenerationSettings,
      event: {
        type: 'chat.updated',
        resource: 'characterRow',
        id: 'chat-a',
        parentId: 'char-a',
      },
    })

    const persona = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas/select',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: savedSettings.json().revision, personaId: 'persona-b' },
    })
    expect(persona.statusCode).toBe(200)

    const preset = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-presets/select',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: persona.json().revision, promptPresetId: 'prompt-b' },
    })
    expect(preset.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].chats[0].generationSettings).toEqual(chatGenerationSettings)
  })

  it('inherits complete and incomplete source generation settings on fork unless the fork supplies an explicit override', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modelPresets: [{ id: 'model-a', name: 'Model A' }],
      promptPresets: [
        {
          id: 'prompt-a',
          name: 'Prompt A',
          customPromptTemplateToggle: 'mode=Mode',
        },
        {
          id: 'prompt-b',
          name: 'Prompt B',
          customPromptTemplateToggle: 'tone=Tone',
        },
      ],
      personas: [
        { id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' },
        { id: 'persona-b', name: 'Persona B', icon: '', personaPrompt: '', note: '' },
      ],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            { id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] },
            {
              id: 'chat-incomplete-source',
              name: 'Incomplete source',
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

    const sourceSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      jailbreakToggle: false,
      sidebarToggles: { mode: 'source' },
    }
    const saved = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationSettings: sourceSettings,
      },
    })
    expect(saved.statusCode).toBe(200)

    const inherited = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: saved.json().revision,
        chat: {
          id: 'chat-inherited',
          name: 'Inherited fork',
          note: '',
          message: [],
          localLore: [],
        },
      },
    })
    expect(inherited.statusCode).toBe(200)
    expect(inherited.json().generationSettings).toEqual(sourceSettings)

    const overrideSettings = {
      configured: true,
      personaId: 'persona-b',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-b',
      jailbreakToggle: true,
      sidebarToggles: { tone: 'warm' },
    }
    const overridden = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: inherited.json().revision,
        chat: {
          id: 'chat-overridden',
          name: 'Overridden fork',
          note: '',
          message: [],
          localLore: [],
          generationSettings: overrideSettings,
        },
      },
    })
    expect(overridden.statusCode).toBe(200)
    expect(overridden.json().generationSettings).toEqual(overrideSettings)

    const incompleteSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-a',
      promptPresetId: 'prompt-a',
      jailbreakToggle: false,
    }
    const savedIncomplete = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-incomplete-source/generation-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: overridden.json().revision,
        generationSettings: incompleteSettings,
      },
    })
    expect(savedIncomplete.statusCode).toBe(200)

    const incompleteInherited = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-incomplete-source/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: savedIncomplete.json().revision,
        chat: {
          id: 'chat-incomplete-fork',
          name: 'Incomplete fork',
          note: '',
          message: [],
          localLore: [],
        },
      },
    })
    expect(incompleteInherited.statusCode).toBe(200)
    expect(incompleteInherited.json().generationSettings).toEqual(incompleteSettings)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const chats = bootstrap.resourceDatabase.characters[0].chats as Array<{
      id: string
      generationSettings?: Record<string, unknown>
    }>
    const sourceChat = chats.find((chat) => chat.id === 'chat-a')
    const inheritedChat = chats.find((chat) => chat.id === 'chat-inherited')
    const overriddenChat = chats.find((chat) => chat.id === 'chat-overridden')
    const incompleteSourceChat = chats.find((chat) => chat.id === 'chat-incomplete-source')
    const incompleteForkChat = chats.find((chat) => chat.id === 'chat-incomplete-fork')

    expect(sourceChat?.generationSettings).toEqual(sourceSettings)
    expect(inheritedChat?.generationSettings).toEqual(sourceSettings)
    expect(inheritedChat?.generationSettings).not.toBe(sourceChat?.generationSettings)
    expect(overriddenChat?.generationSettings).toEqual(overrideSettings)
    expect(incompleteSourceChat?.generationSettings).toEqual(incompleteSettings)
    expect(incompleteForkChat?.generationSettings).toEqual(incompleteSettings)
    expect(incompleteForkChat?.generationSettings).not.toBe(incompleteSourceChat?.generationSettings)
  })
})
