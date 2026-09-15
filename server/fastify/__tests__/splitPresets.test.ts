import { normalizeRisuSaveSnapshotDatabase } from '../src/risuSave/importSnapshot.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import {
  applyModelPreset,
  applyPromptPreset,
  createModelPresetRecord,
  createPromptPresetRecord,
  readModelPresetPatch,
  readPromptPresetPatch,
  resolveModelPresetMaskedSecrets,
} from '../src/commands/splitPresets.js'
import { MASKED_PROVIDER_SECRET } from '../src/providerSecrets.js'
import { MODEL_ROLES } from '@risuai/shared-core/model-roles'
import { LLMFlags } from '@risuai/shared-core/model-types'
import { setupAuthedClient } from './helpers/auth.js'
import { createPresetRecord, readPresetPatch } from '../src/commands/presets.js'

const normalizedModelRoles = (overrides: Record<string, string> = {}) => ({
  chatMain: '',
  chatAux: '',
  memory: '',
  emotion: '',
  translate: '',
  otherAx: '',
  scriptMain: '',
  scriptAux: '',
  ...overrides,
})

const normalizedSeperateModels = (overrides: Record<string, string> = {}) => ({
  memory: '',
  emotion: '',
  translate: '',
  otherAx: '',
  scriptMain: '',
  scriptAux: '',
  ...overrides,
})

const normalizedFallbackModels = (overrides: Record<string, string[]> = {}) => ({
  model: [],
  memory: [],
  emotion: [],
  translate: [],
  otherAx: [],
  scriptMain: [],
  scriptAux: [],
  ...overrides,
})

const normalizedSeperateParameters = (overrides: Record<string, Record<string, unknown>> = {}) => ({
  memory: {},
  emotion: {},
  translate: {},
  otherAx: {},
  scriptMain: {},
  scriptAux: {},
  overrides: {},
  ...overrides,
})

const normalizedModelRoleProfiles = (overrides: Record<string, Record<string, unknown>> = {}) => ({
  ...Object.fromEntries(MODEL_ROLES.map((role) => [role, { mode: 'legacy' }])),
  ...overrides,
})

describe('split preset command normalization', () => {
  it('repairs original editor overrides in preset writes and full-save imports', () => {
    const model = { thinking_type: 'budget', thinking_tokens: 1000 }
    const source = {
      id: 'imported',
      name: 'Imported',
      seperateParameters: {
        overrides: { thinking_type: 'off', 'real-model': model },
      },
    }
    for (const normalize of [
      createModelPresetRecord,
      createPromptPresetRecord,
      createPresetRecord,
      readModelPresetPatch,
      readPromptPresetPatch,
      readPresetPatch,
    ]) {
      expect(normalize(source).seperateParameters).toMatchObject({ overrides: { 'real-model': model } })
      expect((normalize(source).seperateParameters as { overrides: object }).overrides).not.toHaveProperty(
        'thinking_type',
      )
    }
    const imported = normalizeRisuSaveSnapshotDatabase({
      seperateParameters: source.seperateParameters,
      botPresets: [source],
      modelPresets: [source],
      promptPresets: [source],
    })
    for (const owner of [
      imported,
      ...(imported.botPresets as (typeof source)[]),
      ...(imported.modelPresets as (typeof source)[]),
      ...(imported.promptPresets as (typeof source)[]),
    ]) {
      expect((owner.seperateParameters as { overrides: object }).overrides).toEqual({ 'real-model': model })
    }
    expect(source.seperateParameters.overrides.thinking_type).toBe('off')
  })

  it.each([
    { ext: 0, data: [0] },
    { type: 0, data: { type: 'Buffer', data: [0] } },
  ])('repairs wrapped undefined stop strings at every preset write boundary: %j', (marker) => {
    const input = { id: 'preset', name: 'Preset', localStopStrings: marker }
    for (const read of [
      createModelPresetRecord,
      createPromptPresetRecord,
      readModelPresetPatch,
      readPromptPresetPatch,
      createPresetRecord,
      readPresetPatch,
    ]) {
      expect(read(input)).not.toHaveProperty('localStopStrings')
    }
    expect(input.localStopStrings).toBe(marker)
  })

  it.each([null, [], ['STOP']])('preserves supported stop strings at preset write boundaries: %j', (value) => {
    const input = { id: 'preset', localStopStrings: value }
    for (const read of [
      createModelPresetRecord,
      createPromptPresetRecord,
      readModelPresetPatch,
      readPromptPresetPatch,
      createPresetRecord,
      readPresetPatch,
    ]) {
      expect(read(input).localStopStrings).toEqual(value)
    }
  })

  it.each([{}, [null], [42], 'STOP', { ext: 1, data: [0] }])(
    'rejects malformed stop strings before saving presets: %j',
    (value) => {
      const input = { id: 'preset', localStopStrings: value }
      for (const read of [
        createModelPresetRecord,
        createPromptPresetRecord,
        readModelPresetPatch,
        readPromptPresetPatch,
        createPresetRecord,
        readPresetPatch,
      ]) {
        expect(() => read(input)).toThrow('localStopStrings must be an array of strings or null')
      }
    },
  )

  it('normalizes model preset role-adjacent fields on create and apply', () => {
    const preset = createModelPresetRecord({
      id: 'model-a',
      name: 'Model A',
      modelRoles: { chatMain: ' main-model ', memory: ' memory-model ', missing: 'ignored' },
      modelProfiles: [
        {
          id: ' profile-a ',
          name: ' Primary ',
          modelId: ' gpt-5 ',
          providerOptions: {
            credentialId: ' credential-a ',
            requestModel: ' wire-model ',
            apiKey: ' profile-secret ',
            openAIKey: 'must-drop',
          },
        },
        { id: 'profile-a', name: 'Duplicate' },
        { id: 'profile-b', name: 'Secondary', modelId: '   ' },
      ],
      modelRoleProfiles: {
        memory: { mode: 'profile', profileId: ' profile-a ' },
        translate: { mode: 'legacy' },
        unknown: { mode: 'profile', profileId: 'ignored' },
      },
      modelRuntimeDefaults: {
        maxContext: 8192,
        modelTools: [' tool-a ', ''],
        customFlags: [LLMFlags.hasImageInput, 999],
      },
      seperateModels: { memory: ' memory-aux ', translate: 42, scriptAux: ' script-aux ' },
      fallbackModels: { model: ['primary-fallback', '', 7], scriptMain: ['script-fallback'] },
      seperateParameters: {
        memory: { temperature: 0.6 },
        translate: 'ignored',
        scriptMain: { top_p: 0.7 },
        overrides: { 'model-a': { top_k: 42 } },
      },
    })

    expect(preset).toMatchObject({
      modelRoles: normalizedModelRoles({ chatMain: 'main-model', memory: 'memory-model' }),
      modelProfiles: [
        {
          id: 'profile-a',
          name: 'Primary',
          modelId: 'gpt-5',
          providerOptions: { credentialId: 'credential-a', requestModel: 'wire-model' },
        },
        { id: 'profile-b', name: 'Secondary' },
      ],
      modelRoleProfiles: normalizedModelRoleProfiles({
        memory: { mode: 'profile', profileId: 'profile-a' },
      }),
      modelRuntimeDefaults: {
        maxContext: 8192,
        modelTools: ['tool-a'],
        customFlags: [LLMFlags.hasImageInput],
      },
      seperateModels: normalizedSeperateModels({ memory: 'memory-aux', scriptAux: 'script-aux' }),
      fallbackModels: normalizedFallbackModels({
        model: ['primary-fallback'],
        scriptMain: ['script-fallback'],
      }),
      seperateParameters: normalizedSeperateParameters({
        memory: { temperature: 0.6 },
        scriptMain: { top_p: 0.7 },
        overrides: { 'model-a': { top_k: 42 } },
      }),
    })

    const database: Record<string, unknown> = {}
    applyModelPreset(database, {
      id: 'dirty-model',
      modelRoles: { scriptMain: ' dirty-script ' },
      modelProfiles: [
        {
          id: ' dirty-profile ',
          name: ' Dirty Profile ',
          modelId: ' dirty-model ',
          providerOptions: {
            credentialId: ' dirty-credential ',
            requestModel: ' dirty-wire ',
            apiKey: ' dirty-secret ',
            openAIKey: 'must-drop',
          },
        },
      ],
      modelRoleProfiles: { scriptMain: { mode: 'profile', profileId: ' dirty-profile ' } },
      modelRuntimeDefaults: {
        temperature: 66,
        modelTools: [' dirty-tool ', ''],
      },
      seperateModels: { otherAx: ' dirty-aux ' },
      fallbackModels: { memory: ['dirty-memory', ''] },
      seperateParameters: { scriptAux: { min_p: 0.2 } },
    })

    expect(database).toMatchObject({
      modelRoles: normalizedModelRoles({ scriptMain: 'dirty-script' }),
      modelProfiles: [
        {
          id: 'dirty-profile',
          name: 'Dirty Profile',
          modelId: 'dirty-model',
          providerOptions: { credentialId: 'dirty-credential', requestModel: 'dirty-wire' },
        },
      ],
      modelRoleProfiles: normalizedModelRoleProfiles({
        scriptMain: { mode: 'profile', profileId: 'dirty-profile' },
      }),
      modelRuntimeDefaults: {
        temperature: 66,
        modelTools: ['dirty-tool'],
      },
      seperateModels: normalizedSeperateModels({ otherAx: 'dirty-aux' }),
      fallbackModels: normalizedFallbackModels({ memory: ['dirty-memory'] }),
      seperateParameters: normalizedSeperateParameters({ scriptAux: { min_p: 0.2 } }),
    })
  })

  it('normalizes model preset patches while preserving masked secret resolution', () => {
    const patch = readModelPresetPatch({
      openAIKey: MASKED_PROVIDER_SECRET,
      proxyKey: MASKED_PROVIDER_SECRET,
      modelRoles: { translate: ' translate-model ' },
      modelRuntimeDefaults: {
        maxResponse: 1024,
        modelTools: [' patch-tool ', ''],
      },
      seperateModels: null,
      fallbackModels: { otherAx: ['other-fallback', ''] },
      seperateParameters: { otherAx: { frequencyPenalty: 0.1 }, overrides: null },
    })

    const resolved = resolveModelPresetMaskedSecrets(
      {
        id: 'model-a',
        name: 'Model A',
        openAIKey: 'openai-secret',
        proxyKey: 'proxy-secret',
      },
      patch,
    )

    expect(resolved).toMatchObject({
      openAIKey: 'openai-secret',
      proxyKey: 'proxy-secret',
      modelRoles: normalizedModelRoles({ translate: 'translate-model' }),
      modelRuntimeDefaults: {
        maxResponse: 1024,
        modelTools: ['patch-tool'],
      },
      seperateModels: normalizedSeperateModels(),
      fallbackModels: normalizedFallbackModels({ otherAx: ['other-fallback'] }),
      seperateParameters: normalizedSeperateParameters({ otherAx: { frequencyPenalty: 0.1 } }),
    })
  })

  it('normalizes prompt preset model override fields on create, patch, and apply', () => {
    const preset = createPromptPresetRecord({
      id: 'prompt-a',
      name: 'Prompt A',
      modelRoles: { emotion: ' emotion-model ' },
      modelProfiles: [{ id: ' prompt-profile ', name: ' Prompt Profile ' }],
      modelRoleProfiles: { emotion: { mode: 'profile', profileId: ' prompt-profile ' } },
      modelRuntimeDefaults: { maxContext: 9999 },
      seperateModels: { scriptMain: ' script-main ' },
      fallbackModels: { translate: ['translate-fallback', ''] },
      seperateParameters: { translate: { temperature: 0.4 } },
    })

    expect(preset).toMatchObject({
      modelRoles: normalizedModelRoles({ emotion: 'emotion-model' }),
      modelProfiles: [{ id: 'prompt-profile', name: 'Prompt Profile' }],
      modelRoleProfiles: normalizedModelRoleProfiles({
        emotion: { mode: 'profile', profileId: 'prompt-profile' },
      }),
      modelRuntimeDefaults: { maxContext: 9999 },
      seperateModels: normalizedSeperateModels({ scriptMain: 'script-main' }),
      fallbackModels: normalizedFallbackModels({ translate: ['translate-fallback'] }),
      seperateParameters: normalizedSeperateParameters({ translate: { temperature: 0.4 } }),
    })

    const patch = readPromptPresetPatch({
      presetRegex: [{ id: 'regex-a', type: 'editinput', in: 'hello', out: 'hi' }],
      regex: [{ id: 'legacy-regex' }],
      modelRoles: { scriptAux: ' script-aux ' },
      modelProfiles: [{ id: ' patch-profile ', name: ' Patch Profile ' }],
      modelRoleProfiles: { scriptAux: { mode: 'profile', profileId: ' patch-profile ' } },
      modelRuntimeDefaults: { temperature: 44 },
      seperateModels: { emotion: ' emotion-aux ' },
      fallbackModels: { scriptAux: ['script-fallback', ''] },
      seperateParameters: { scriptAux: { top_p: 0.8 }, memory: [] },
    })

    expect(patch).toMatchObject({
      presetRegex: [{ id: 'regex-a', type: 'editinput', in: 'hello', out: 'hi' }],
      regex: [],
      modelRoles: normalizedModelRoles({ scriptAux: 'script-aux' }),
      modelProfiles: [{ id: 'patch-profile', name: 'Patch Profile' }],
      modelRoleProfiles: normalizedModelRoleProfiles({
        scriptAux: { mode: 'profile', profileId: 'patch-profile' },
      }),
      modelRuntimeDefaults: { temperature: 44 },
      seperateModels: normalizedSeperateModels({ emotion: 'emotion-aux' }),
      fallbackModels: normalizedFallbackModels({ scriptAux: ['script-fallback'] }),
      seperateParameters: normalizedSeperateParameters({ scriptAux: { top_p: 0.8 } }),
    })

    const database: Record<string, unknown> = {
      modelProfiles: [{ id: 'base-profile', name: 'Base Profile' }],
      modelRuntimeDefaults: { maxContext: 1111 },
    }
    applyPromptPreset(database, {
      id: 'dirty-prompt',
      overrideModelParameters: true,
      modelRoles: { memory: ' dirty-memory ' },
      modelProfiles: [{ id: 'ignored-profile', name: 'Ignored Profile' }],
      modelRoleProfiles: { memory: { mode: 'profile', profileId: ' dirty-profile ' } },
      modelRuntimeDefaults: { maxContext: 2222 },
      seperateModels: { memory: ' dirty-memory-aux ' },
      fallbackModels: { model: ['dirty-fallback', ''] },
      seperateParameters: { memory: { temperature: 0.3 } },
      presetRegex: [{ id: 'regex-b' }],
    })

    expect(database).toMatchObject({
      presetRegex: [{ id: 'regex-b' }],
      modelRoles: normalizedModelRoles({ memory: 'dirty-memory' }),
      modelProfiles: [{ id: 'base-profile', name: 'Base Profile' }],
      modelRoleProfiles: normalizedModelRoleProfiles({
        memory: { mode: 'profile', profileId: 'dirty-profile' },
      }),
      modelRuntimeDefaults: { maxContext: 1111 },
      seperateModels: normalizedSeperateModels({ memory: 'dirty-memory-aux' }),
      fallbackModels: normalizedFallbackModels({ model: ['dirty-fallback'] }),
      seperateParameters: normalizedSeperateParameters({ memory: { temperature: 0.3 } }),
    })
  })

  it('normalizes nested prompt preset template item ids on create, patch, and apply', () => {
    const preset = createPromptPresetRecord({
      id: 'prompt-template-a',
      name: 'Prompt Template A',
      promptTemplate: [
        { type: 'plain', text: 'missing id', role: 'assistant' },
        { id: 'duplicate-row', type: 'plain', text: 'first duplicate' },
        { id: 'duplicate-row', type: 'description', text: 'second duplicate', role2: 'char' },
      ],
    })

    const presetIds = (preset.promptTemplate as Array<{ id?: string }>).map((item) => item.id)
    expect(presetIds[0]).toEqual(expect.any(String))
    expect(presetIds[1]).toBe('duplicate-row')
    expect(presetIds[2]).toEqual(expect.any(String))
    expect(new Set(presetIds).size).toBe(3)
    expect((preset.promptTemplate as Array<Record<string, unknown>>)[0].role).toBe('bot')
    expect((preset.promptTemplate as Array<Record<string, unknown>>)[2].role2).toBe('bot')

    const patch = readPromptPresetPatch({
      promptTemplate: [{ type: 'memory', text: 'patched missing id', role2: 'assistant' }],
    })
    expect((patch.promptTemplate as Array<{ id?: string }>)[0].id).toEqual(expect.any(String))
    expect((patch.promptTemplate as Array<Record<string, unknown>>)[0].role2).toBe('bot')

    const database: Record<string, unknown> = {}
    applyPromptPreset(database, {
      id: 'dirty-prompt-template',
      promptTemplate: [{ type: 'authornote', text: 'applied missing id', role2: 'char' }],
    })
    expect((database.promptTemplate as Array<{ id?: string }>)[0].id).toEqual(expect.any(String))
    expect((database.promptTemplate as Array<Record<string, unknown>>)[0].role2).toBe('bot')
  })

  it('preserves boolean prompt preset archive metadata and rejects invalid values', () => {
    expect(
      createPromptPresetRecord({
        id: 'prompt-archived',
        name: 'Archived Prompt',
        archived: true,
      }),
    ).toMatchObject({ archived: true })
    expect(readPromptPresetPatch({ archived: false })).toEqual({ archived: false })

    expect(() =>
      createPromptPresetRecord({
        id: 'prompt-invalid-archive',
        archived: 'true',
      }),
    ).toThrow('promptPreset.archived must be a boolean')
    expect(() => readPromptPresetPatch({ archived: 1 })).toThrow('promptPreset.archived must be a boolean')
  })

  it('preserves null prompt templates through create, patch, and apply', () => {
    const preset = createPromptPresetRecord({
      id: 'prompt-template-disabled',
      name: 'Prompt Template Disabled',
      promptTemplate: null,
    })
    expect(preset.promptTemplate).toBeNull()

    const patch = readPromptPresetPatch({ promptTemplate: null })
    expect(patch.promptTemplate).toBeNull()

    const database: Record<string, unknown> = {
      promptTemplate: [{ id: 'existing', type: 'description' }],
    }
    applyPromptPreset(database, preset)
    expect(database.promptTemplate).toBeNull()
  })
})

describe('split preset command routes', () => {
  interface Harness {
    app: FastifyInstance
    dataDir: string
  }

  let harness: Harness
  let assertion: string

  beforeEach(async () => {
    process.env.LOG_LEVEL = 'silent'
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-split-preset-routes-'))
    const { app } = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir,
        bodyLimit: 1024 * 1024,
        importMaxBytes: Infinity,
        trustProxy: false,
        hubUrl: 'https://sv.risuai.xyz',
      },
      assetGc: false,
      memoryWorker: false,
    })
    harness = { app, dataDir }
    ;({ assertion } = await setupAuthedClient(app))
  })

  afterEach(async () => {
    await harness.app.close()
    rmSync(harness.dataDir, { recursive: true, force: true })
  })

  async function importPresets(database: Record<string, unknown>): Promise<number> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: { 'risu-auth': assertion },
      payload: { database },
    })
    expect(response.statusCode, response.payload).toBe(200)
    return response.json().revision as number
  }

  async function runCommand(
    url: string,
    baseRevision: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await harness.app.inject({
      method: 'POST',
      url,
      headers: { 'risu-auth': assertion },
      payload: { baseRevision, ...payload },
    })
    expect(response.statusCode, response.payload).toBe(200)
    return response.json() as Record<string, unknown>
  }

  async function readPersistedPresetState(): Promise<{
    revision: number
    modelPresets: Array<Record<string, unknown>>
    promptPresets: Array<Record<string, unknown>>
    settings: Record<string, unknown>
  }> {
    const [collections, settings] = await Promise.all([
      harness.app.inject({
        method: 'GET',
        url: '/api/v1/collections',
        headers: { 'risu-auth': assertion },
      }),
      harness.app.inject({
        method: 'GET',
        url: '/api/v1/settings',
        headers: { 'risu-auth': assertion },
      }),
    ])
    expect(collections.statusCode, collections.payload).toBe(200)
    expect(settings.statusCode, settings.payload).toBe(200)
    const collectionBody = collections.json() as {
      revision: number
      collections: {
        modelPresets: Array<Record<string, unknown>>
        promptPresets: Array<Record<string, unknown>>
      }
    }
    const settingsBody = settings.json() as { revision: number; settings: Record<string, unknown> }
    expect(settingsBody.revision).toBe(collectionBody.revision)
    return {
      revision: collectionBody.revision,
      modelPresets: collectionBody.collections.modelPresets,
      promptPresets: collectionBody.collections.promptPresets,
      settings: settingsBody.settings,
    }
  }

  it('persists model and prompt create/import/select/reorder as one coherent lifecycle', async () => {
    let revision = await importPresets({
      modelPresetsId: 0,
      promptPresetsId: 0,
      temperature: 0.1,
      mainPrompt: 'base prompt',
      modelPresets: [{ id: 'model-base', name: 'Model Base', temperature: 0.1 }],
      promptPresets: [{ id: 'prompt-base', name: 'Prompt Base', mainPrompt: 'base prompt' }],
    })

    const createdModel = await runCommand('/api/v1/commands/model-presets', revision, {
      preset: { id: 'model-created', name: 'Model Created', temperature: 0.4 },
    })
    expect(createdModel).toMatchObject({
      modelPresetId: 'model-created',
      event: { type: 'modelPreset.created', id: 'model-created' },
    })
    revision = createdModel.revision as number

    const importedModel = await runCommand('/api/v1/commands/model-presets/import', revision, {
      preset: { id: 'model-imported', name: 'Model Imported', temperature: 0.8 },
    })
    expect(importedModel).toMatchObject({
      modelPresetId: 'model-imported',
      event: { type: 'modelPreset.imported', id: 'model-imported' },
    })
    revision = importedModel.revision as number

    const selectedModel = await runCommand('/api/v1/commands/model-presets/select', revision, {
      modelPresetId: 'model-imported',
    })
    expect(selectedModel).toMatchObject({
      modelPresetId: 'model-imported',
      event: { type: 'modelPreset.selected', id: 'model-imported' },
    })
    revision = selectedModel.revision as number

    const reorderedModels = await runCommand('/api/v1/commands/model-presets/reorder', revision, {
      modelPresetIds: ['model-created', 'model-imported', 'model-base'],
    })
    expect(reorderedModels).toMatchObject({
      presetReorderCertificate: 'preset-reorder-v1',
      presetKind: 'model',
      presetIds: ['model-created', 'model-imported', 'model-base'],
      selectedModelPresetId: 'model-imported',
      settingsWritten: true,
      event: { type: 'modelPreset.reordered' },
    })
    revision = reorderedModels.revision as number

    const createdPrompt = await runCommand('/api/v1/commands/prompt-presets', revision, {
      preset: {
        id: 'prompt-created',
        name: 'Prompt Created',
        mainPrompt: 'created prompt',
        recommendedModelPresetId: 'model-created',
      },
    })
    expect(createdPrompt).toMatchObject({
      promptPresetId: 'prompt-created',
      event: { type: 'promptPreset.created', id: 'prompt-created' },
    })
    revision = createdPrompt.revision as number

    const importedPrompt = await runCommand('/api/v1/commands/prompt-presets/import', revision, {
      preset: {
        id: 'prompt-imported',
        name: 'Prompt Imported',
        mainPrompt: 'imported prompt',
        recommendedModelPresetId: 'model-imported',
      },
    })
    expect(importedPrompt).toMatchObject({
      promptPresetId: 'prompt-imported',
      event: { type: 'promptPreset.imported', id: 'prompt-imported' },
    })
    revision = importedPrompt.revision as number

    const selectedPrompt = await runCommand('/api/v1/commands/prompt-presets/select', revision, {
      promptPresetId: 'prompt-imported',
    })
    expect(selectedPrompt).toMatchObject({
      promptPresetId: 'prompt-imported',
      event: { type: 'promptPreset.selected', id: 'prompt-imported' },
    })
    revision = selectedPrompt.revision as number

    const reorderedPrompts = await runCommand('/api/v1/commands/prompt-presets/reorder', revision, {
      promptPresetIds: ['prompt-imported', 'prompt-base', 'prompt-created'],
    })
    expect(reorderedPrompts).toMatchObject({
      selectedPromptPresetId: 'prompt-imported',
      event: { type: 'promptPreset.reordered' },
    })

    const persisted = await readPersistedPresetState()
    expect(persisted.revision).toBe(reorderedPrompts.revision)
    expect(persisted.modelPresets.map((preset) => preset.id)).toEqual(['model-created', 'model-imported', 'model-base'])
    expect(persisted.promptPresets.map((preset) => preset.id)).toEqual([
      'prompt-imported',
      'prompt-base',
      'prompt-created',
    ])
    expect(persisted.promptPresets[0].recommendedModelPresetId).toBe('model-imported')
    expect(persisted.promptPresets[2].recommendedModelPresetId).toBe('model-created')
    expect(persisted.settings).not.toHaveProperty('recommendedModelPresetId')
    expect(persisted.settings).toMatchObject({
      modelPresetsId: 1,
      promptPresetsId: 0,
      temperature: 0.8,
      mainPrompt: 'imported prompt',
    })
    expect(persisted.modelPresets[persisted.settings.modelPresetsId as number].id).toBe('model-imported')
    expect(persisted.promptPresets[persisted.settings.promptPresetsId as number].id).toBe('prompt-imported')
  })

  it('validates and persists prompt recommendation patches as metadata', async () => {
    let revision = await importPresets({
      modelPresetsId: 0,
      promptPresetsId: 0,
      modelPresets: [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B' },
      ],
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A', mainPrompt: 'prompt' }],
      mainPrompt: 'prompt',
    })

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-presets/prompt-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { recommendedModelPresetId: 'model-b' } },
    })
    expect(patched.statusCode, patched.payload).toBe(200)
    expect(patched.json()).toMatchObject({
      promptPresetId: 'prompt-a',
      acknowledgedKeys: ['recommendedModelPresetId'],
      selectedProjectionApplied: false,
      ownerProjectionApplied: false,
    })
    revision = patched.json().revision

    const persisted = await readPersistedPresetState()
    expect(persisted.promptPresets[0].recommendedModelPresetId).toBe('model-b')
    expect(persisted.settings).not.toHaveProperty('recommendedModelPresetId')

    const invalid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-presets/prompt-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { recommendedModelPresetId: 'missing-model' } },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toContain('Unknown model preset id')
  })

  it('commits onboarding settings and both selected preset owners atomically', async () => {
    const revision = await importPresets({
      didFirstSetup: false,
      textTheme: 'default',
      modelPresetsId: 0,
      promptPresetsId: 0,
      apiType: 'old-api',
      aiModel: 'old-model',
      maxContext: 4096,
      mainPrompt: 'old prompt',
      modelPresets: [
        {
          id: 'model-owner',
          name: 'Model owner',
          apiType: 'old-api',
          aiModel: 'old-model',
          maxContext: 4096,
        },
      ],
      promptPresets: [{ id: 'prompt-owner', name: 'Prompt owner', mainPrompt: 'old prompt' }],
    })

    const completed = await runCommand('/api/v1/commands/onboarding', revision, {
      modelPresetId: 'model-owner',
      promptPresetId: 'prompt-owner',
      modelPatch: {
        apiType: 'openai',
        aiModel: 'gpt4o-chatgpt',
        maxContext: 12000,
      },
      promptPatch: {
        mainPrompt: 'onboarding prompt',
        jailbreak: 'onboarding jailbreak',
        promptTemplate: [{ type: 'plain', text: 'onboarding template' }],
      },
      settingsPatch: {
        textTheme: 'highcontrast',
        didFirstSetup: true,
      },
    })

    expect(completed).toMatchObject({
      modelPresetId: 'model-owner',
      promptPresetId: 'prompt-owner',
      event: { type: 'onboarding.completed', resource: 'legacyBotPreset' },
    })
    const persisted = await readPersistedPresetState()
    expect(persisted.revision).toBe(completed.revision)
    expect(persisted.modelPresets[0]).toMatchObject({
      id: 'model-owner',
      apiType: 'openai',
      aiModel: 'gpt4o-chatgpt',
      maxContext: 12000,
    })
    expect(persisted.promptPresets[0]).toMatchObject({
      id: 'prompt-owner',
      mainPrompt: 'onboarding prompt',
      jailbreak: 'onboarding jailbreak',
    })
    expect(persisted.settings).toMatchObject({
      didFirstSetup: true,
      textTheme: 'highcontrast',
      apiType: 'openai',
      aiModel: 'gpt4o-chatgpt',
      maxContext: 12000,
      mainPrompt: 'onboarding prompt',
      jailbreak: 'onboarding jailbreak',
    })
  })

  it('rolls back the model owner and completion flag when the prompt-owner write fails', async () => {
    const revision = await importPresets({
      didFirstSetup: false,
      modelPresetsId: 0,
      promptPresetsId: 0,
      aiModel: 'old-model',
      mainPrompt: 'old prompt',
      modelPresets: [{ id: 'model-owner', name: 'Model owner', aiModel: 'old-model' }],
      promptPresets: [{ id: 'prompt-owner', name: 'Prompt owner', mainPrompt: 'old prompt' }],
    })
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      db.exec(`
        CREATE TRIGGER fail_onboarding_prompt_owner
        BEFORE UPDATE ON prompt_presets
        BEGIN
          SELECT RAISE(FAIL, 'injected prompt owner failure');
        END;
      `)
    } finally {
      db.close()
    }

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/onboarding',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        modelPresetId: 'model-owner',
        promptPresetId: 'prompt-owner',
        modelPatch: { aiModel: 'new-model' },
        promptPatch: { mainPrompt: 'new prompt' },
        settingsPatch: { didFirstSetup: true },
      },
    })
    expect(response.statusCode).toBe(500)

    const persisted = await readPersistedPresetState()
    expect(persisted.revision).toBe(revision)
    expect(persisted.modelPresets[0]).toMatchObject({ id: 'model-owner', aiModel: 'old-model' })
    expect(persisted.promptPresets[0]).toMatchObject({ id: 'prompt-owner', mainPrompt: 'old prompt' })
    expect(persisted.settings).toMatchObject({
      didFirstSetup: false,
      aiModel: 'old-model',
      mainPrompt: 'old prompt',
    })
  })

  it('certifies a model preset reorder without repairing an optional missing name', async () => {
    const revision = await importPresets({
      modelPresetsId: 0,
      modelPresets: [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B' },
      ],
    })
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      const row = db.prepare('SELECT data_json FROM model_presets WHERE position = 0').get() as {
        data_json: string
      }
      const modelPreset = JSON.parse(row.data_json) as Record<string, unknown>
      delete modelPreset.name
      db.prepare('UPDATE model_presets SET data_json = ? WHERE position = 0').run(JSON.stringify(modelPreset))
    } finally {
      db.close()
    }

    const reordered = await runCommand('/api/v1/commands/model-presets/reorder', revision, {
      modelPresetIds: ['model-b', 'model-a'],
    })

    expect(reordered).toMatchObject({
      selectedModelPresetId: 'model-a',
      event: { type: 'modelPreset.reordered' },
    })
    expect(reordered).toMatchObject({
      presetReorderCertificate: 'preset-reorder-v1',
      presetKind: 'model',
      presetIds: ['model-b', 'model-a'],
      settingsWritten: true,
    })

    const persisted = await readPersistedPresetState()
    expect(persisted.modelPresets).toEqual([{ id: 'model-b', name: 'Model B' }, { id: 'model-a' }])
    expect(persisted.settings.modelPresetsId).toBe(1)
  })

  it('certifies a model preset reorder that does not write the selected pointer', async () => {
    const revision = await importPresets({
      modelPresetsId: 1,
      modelPresets: [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B' },
        { id: 'model-c', name: 'Model C' },
      ],
    })

    const reordered = await runCommand('/api/v1/commands/model-presets/reorder', revision, {
      modelPresetIds: ['model-c', 'model-b', 'model-a'],
    })

    expect(reordered).toMatchObject({
      presetReorderCertificate: 'preset-reorder-v1',
      presetKind: 'model',
      presetIds: ['model-c', 'model-b', 'model-a'],
      selectedModelPresetId: 'model-b',
      settingsWritten: false,
      event: { type: 'modelPreset.reordered', resource: 'modelPreset' },
    })
    const persisted = await readPersistedPresetState()
    expect(persisted.settings.modelPresetsId).toBe(1)
  })

  it('rejects duplicate, unknown, and stale reorders without changing either collection or selected id', async () => {
    const revision = await importPresets({
      modelPresetsId: 1,
      promptPresetsId: 1,
      modelPresets: [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B' },
      ],
      promptPresets: [
        { id: 'prompt-a', name: 'Prompt A' },
        { id: 'prompt-b', name: 'Prompt B' },
      ],
    })

    const duplicate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-presets/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, modelPresetIds: ['model-a', 'model-a'] },
    })
    expect(duplicate.statusCode).toBe(400)
    expect(duplicate.json()).toEqual({ error: 'Duplicate preset id: model-a' })

    const unknown = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-presets/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, promptPresetIds: ['prompt-a', 'prompt-missing'] },
    })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json()).toEqual({ error: 'Unknown preset id: prompt-missing' })

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-presets/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision - 1, modelPresetIds: ['model-b', 'model-a'] },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: revision })

    const persisted = await readPersistedPresetState()
    expect(persisted.revision).toBe(revision)
    expect(persisted.modelPresets.map((preset) => preset.id)).toEqual(['model-a', 'model-b'])
    expect(persisted.promptPresets.map((preset) => preset.id)).toEqual(['prompt-a', 'prompt-b'])
    expect(persisted.settings).toMatchObject({ modelPresetsId: 1, promptPresetsId: 1 })
    expect(persisted.modelPresets[persisted.settings.modelPresetsId as number].id).toBe('model-b')
    expect(persisted.promptPresets[persisted.settings.promptPresetsId as number].id).toBe('prompt-b')
  })
})
