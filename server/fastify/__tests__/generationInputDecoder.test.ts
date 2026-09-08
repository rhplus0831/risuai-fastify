import Ajv from 'ajv'
import { createHash } from 'node:crypto'
import * as standalone from '../src/prompt/generationInputValidators.js'
import { DatabaseSync } from 'node:sqlite'
import { createMessageTable, getChatMessages } from '../src/messageStore.js'
import { createMessageRecord } from '../src/commands/messages.js'
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  generateGenerationInputArtifacts,
  generationInputSchemaPath,
  generationInputValidatorsPath,
  generationInputValidatorTypesPath,
  generationInputValidationOptions,
  generationInputSchemaId,
  generationInputValidatorRoots,
} from '../../../util/generation-input-schema.js'
import {
  decodeGenerationSettings,
  decodeGenerationDatabase,
  decodeGenerationPreflightInputs,
  decodeProviderGenerationSettings,
  decodeMemoryGenerationSettings,
  GenerationInputValidationError,
} from '../src/prompt/generationInputDecoder.js'
import { normalizeRisuSaveSnapshotDatabase } from '../src/risuSave/importSnapshot.js'
import { createExtractedModelPreset, createExtractedPromptPreset } from '@risuai/shared-core/preset-split'
import { convertRealmCharacterCard } from '../src/realmImport/characterCard.js'

function selectedDatabaseWithMessage(message: unknown) {
  const base = decodeGenerationDatabase(
    normalizeRisuSaveSnapshotDatabase({
      characters: [{ chaId: 'character', name: 'Character', chats: [{ id: 'chat', message: [] }] }],
    }),
  )
  return {
    ...base,
    characters: [{ ...base.characters[0], chats: [{ ...base.characters[0].chats[0], message: [message] }] }],
  }
}

describe('selected generation persistence decoder', () => {
  it('keeps its standalone code, declaration and schema synchronized with the finite contract', async () => {
    const artifacts = await generateGenerationInputArtifacts()
    expect(JSON.parse(fs.readFileSync(generationInputSchemaPath, 'utf8'))).toEqual(artifacts.schema)
    expect(fs.readFileSync(generationInputValidatorsPath, 'utf8')).toBe(artifacts.javascript)
    expect(fs.readFileSync(generationInputValidatorTypesPath, 'utf8')).toBe(artifacts.declarations)
  }, 60_000)

  it('matches runtime Ajv acceptance and complete errors for all five roots', () => {
    const schema: Record<string, unknown> = JSON.parse(fs.readFileSync(generationInputSchemaPath, 'utf8'))
    const compiler = new Ajv(generationInputValidationOptions)
    compiler.addSchema({ $id: generationInputSchemaId, $defs: schema.$defs })
    const valid: Record<keyof typeof generationInputValidatorRoots, unknown> = {
      validateGenerationSettings: { temperature: 50, extension: { untouched: true } },
      validateFastifyDatabase: selectedDatabaseWithMessage({
        role: 'char',
        data: 'reply',
        name: null,
        time: null,
        translation: null,
      }),
      validateGenerationPreflightInputs: {
        database: { modules: [{ id: 'module' }] },
        currentChar: { chaId: 'character' },
        currentChat: { id: 'chat' },
      },
      validateProviderGenerationSettings: { characters: [{ name: 'Character' }], hordeConfig: { apiKey: 'key' } },
      validateMemoryGenerationSettings: {
        characters: [{ chaId: 'character', chats: [{ id: 'chat', generationSettings: { modelPresetId: 'model' } }] }],
      },
    }
    for (const name of Object.keys(generationInputValidatorRoots) as Array<
      keyof typeof generationInputValidatorRoots
    >) {
      const root = schema[generationInputValidatorRoots[name]]
      if (!root || typeof root !== 'object' || !('$ref' in root) || typeof root.$ref !== 'string')
        throw Error('Invalid root')
      const runtime = compiler.compile({ $ref: `${generationInputSchemaId}${root.$ref}` })
      const cases = [
        valid[name],
        null,
        [],
        { temperature: 'bad', characters: [] },
        { temperature: Infinity, characters: [] },
        { temperature: NaN, characters: [] },
      ]
      if (name === 'validateFastifyDatabase') cases.push(selectedDatabaseWithMessage({ role: 'char', data: 42 }))
      if (name === 'validateGenerationPreflightInputs')
        cases.push({
          database: { temperature: 'bad' },
          currentChar: { chaId: 'character' },
          currentChat: { id: 'chat' },
        })
      for (const input of cases) {
        const expected = runtime(input)
        const expectedErrors = structuredClone(runtime.errors)
        expect(standalone[name](input), name).toBe(expected)
        expect(standalone[name].errors, name).toEqual(expectedErrors)
      }
    }
  })

  it('preserves domain and instance-path errors for each public boundary', () => {
    expect(() => decodeGenerationSettings({ temperature: 'private-value' })).toThrow(
      'Invalid settings generation input at /temperature',
    )
    expect(() => decodeGenerationDatabase(selectedDatabaseWithMessage({ role: 'char', data: 42 }))).toThrow(
      'Invalid database generation input at /characters/0/chats/0/message/0/data',
    )
    expect(() =>
      decodeGenerationPreflightInputs({ database: {}, currentChar: { chaId: 42 }, currentChat: { id: 'chat' } }),
    ).toThrow('Invalid preflight generation input at /currentChar/chaId')
    expect(() => decodeProviderGenerationSettings({ characters: [{ name: 42 }] })).toThrow(
      'Invalid provider generation input at /characters/0/name',
    )
    expect(() =>
      decodeMemoryGenerationSettings({ characters: [{ chats: [{ generationSettings: { modelPresetId: 42 } }] }] }),
    ).toThrow('Invalid memory generation input at /characters/0/chats/0/generationSettings/modelPresetId')
  })

  it('retains content-free validator diagnostics without retaining the rejected value', () => {
    const privateValue = 'PRIVATE-GENERATION-INPUT-CANARY'
    try {
      decodeGenerationDatabase(selectedDatabaseWithMessage({ role: 'char', data: { privateValue }, chatId: 'message' }))
      throw new Error('Expected generation input validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationInputValidationError)
      expect(error).toMatchObject({
        domain: 'database',
        instancePath: '/characters/0/chats/0/message/0/data',
        validationOwner: 'message',
        validationFieldRef: createHash('sha256').update('generation-input-field:data').digest('hex').slice(0, 16),
        validationRule: 'type',
        valueKind: 'object',
      })
      expect(JSON.stringify(error)).not.toContain(privateValue)
      expect(String(error)).not.toContain(privateValue)
    }
  })

  it('preserves sparse supported settings, imported extensions, and source identity without defaults or copies', () => {
    const input = {
      temperature: 50,
      hypaV3Presets: [{ id: 'hypa', name: 'Memory', settings: { memoryTokensRatio: 0.3 } }],
      dynamicOutput: { dynamicMessages: true },
      extension: { future: ['untouched'] },
    }
    const bytes = JSON.stringify(input)
    const decoded = decodeGenerationSettings(input)
    expect(decoded).toBe(input)
    expect(decoded.hypaV3Presets).toBe(input.hypaV3Presets)
    expect(Object.getOwnPropertyDescriptor(decoded, 'extension')?.value).toBe(input.extension)
    expect(JSON.stringify(decoded)).toBe(bytes)
    expect(decodeGenerationSettings({})).toEqual({})
  })

  it('decodes metadata-only preflight without transcript or character body defaults', () => {
    const input = {
      database: {
        modules: [{ id: 'module', namespace: 'module-space', customModuleToggle: 'enabled=Module' }],
        modelPresets: [{ id: 'm', aiModel: 'echo_model' }],
        promptPresets: [{ id: 'p' }],
        personas: [{ id: 'u' }],
      },
      currentChar: { chaId: 'character', modules: [], supaMemory: true },
      currentChat: {
        id: 'chat',
        generationSettings: { modelPresetId: 'm', promptPresetId: 'p', personaId: 'u' },
        modules: [],
      },
    }
    const decoded = decodeGenerationPreflightInputs(input)
    expect(decoded).toBe(input)
    expect(Object.keys(decoded.currentChar)).toEqual(['chaId', 'modules', 'supaMemory'])
    expect(Object.hasOwn(decoded.database, 'characters')).toBe(false)
    expect(Object.hasOwn(decoded.currentChat, 'message')).toBe(false)
  })

  it('accepts preflight module metadata while requiring full execution module fields', () => {
    const database = { modules: [{ id: 'module', namespace: 'space', customModuleToggle: 'mode=Mode' }] }
    const input = { database, currentChar: { chaId: 'character' }, currentChat: { id: 'chat' } }
    expect(decodeGenerationPreflightInputs(input)).toBe(input)
    expect(() => decodeGenerationSettings(database)).toThrow(GenerationInputValidationError)
  })

  it.each([
    { temperature: '50' },
    { promptSettings: { sendName: 'yes' } },
    { modelPresets: [{ id: 'm', temperature: 'hot' }] },
    { modelProfiles: [{ id: 'profile', name: 'Main', runtimeOptions: { dynamicOutput: { dynamicMessages: 'yes' } } }] },
    {
      modules: [
        {
          id: 'module',
          name: 'Module',
          description: '',
          regex: [{ comment: 'r', in: 'a', out: 'b', type: 'editinput', ableFlag: 'yes' }],
        },
      ],
    },
  ])('rejects malformed known settings without exposing their values: %j', (input) => {
    expect(() => decodeGenerationSettings(input)).toThrow(GenerationInputValidationError)
    try {
      decodeGenerationSettings(input)
    } catch (error) {
      expect(String(error)).not.toContain('hot')
    }
  })

  it('preserves a plain prompt card with omitted legacy location without supplying a default', () => {
    const card = { type: 'plain', role: 'system', text: 'legacy prompt' }
    const input = { promptPresets: [{ id: 'preset', promptTemplate: [card] }] }
    const decoded = decodeGenerationSettings(input)
    expect(decoded).toBe(input)
    expect(decoded.promptPresets?.[0].promptTemplate?.[0]).toBe(card)
    expect(Object.hasOwn(card, 'type2')).toBe(false)
    expect(() => decodeGenerationSettings({ promptTemplate: [{ ...card, type2: 42 }] })).toThrow(
      GenerationInputValidationError,
    )
  })

  it.each([null, [], undefined])('preserves explicit template ownership value %j', (template) => {
    const input =
      template === undefined
        ? { promptPresets: [{ id: 'preset' }] }
        : { promptTemplate: template, promptPresets: [{ id: 'preset', promptTemplate: template }] }
    expect(decodeGenerationSettings(input)).toBe(input)
    expect(Object.hasOwn(input, 'promptTemplate')).toBe(template !== undefined)
  })

  it.each([
    { localStopStrings: null },
    { localStopStrings: [] },
    { localStopStrings: ['STOP\\nHERE'] },
    { localStopStrings: undefined },
  ])(
    'preserves custom stop strings $localStopStrings across generation boundaries and presets',
    ({ localStopStrings }) => {
      const setting = localStopStrings === undefined ? {} : { localStopStrings }
      const input = {
        ...setting,
        modelPresets: [{ id: 'model', ...setting }],
        promptPresets: [{ id: 'prompt', ...setting }],
      }
      const bytes = JSON.stringify(input)
      const database = { ...input, characters: [] }
      const preflight = { database: input, currentChar: { chaId: 'character' }, currentChat: { id: 'chat' } }

      expect(decodeGenerationSettings(input)).toBe(input)
      expect(decodeGenerationDatabase(database)).toBe(database)
      expect(decodeGenerationPreflightInputs(preflight)).toBe(preflight)
      expect(decodeProviderGenerationSettings(input)).toBe(input)
      expect(decodeMemoryGenerationSettings(input)).toBe(input)
      expect(JSON.stringify(input)).toBe(bytes)
      expect(database.localStopStrings).toBe(localStopStrings)
      expect(Object.hasOwn(input, 'localStopStrings')).toBe(localStopStrings !== undefined)
    },
  )

  it.each([
    [{ localStopStrings: 'STOP' }, '/database/localStopStrings'],
    [{ localStopStrings: [42] }, '/database/localStopStrings'],
    [{ modelPresets: [{ id: 'model', localStopStrings: 'STOP' }] }, '/database/modelPresets/0/localStopStrings'],
    [{ promptPresets: [{ id: 'prompt', localStopStrings: [42] }] }, '/database/promptPresets/0/localStopStrings'],
  ])('rejects malformed custom stop strings in %j', (database, field) => {
    expect(() =>
      decodeGenerationPreflightInputs({ database, currentChar: { chaId: 'character' }, currentChat: { id: 'chat' } }),
    ).toThrow(`Invalid preflight generation input at ${field}`)
  })

  it.each([undefined, null, {}, { dynamicMessages: true, showTypingEffect: false }])(
    'preserves supported dynamic output %j in settings, presets and profile runtime owners',
    (dynamicOutput) => {
      const setting = dynamicOutput === undefined ? {} : { dynamicOutput }
      const profile = { id: 'profile', name: 'Main', runtimeOptions: setting }
      const input = {
        ...setting,
        modelPresets: [{ id: 'model', ...setting, modelProfiles: [profile], modelRuntimeDefaults: setting }],
        promptPresets: [{ id: 'prompt', ...setting }],
        modelProfiles: [profile],
        modelRuntimeDefaults: setting,
      }
      const bytes = JSON.stringify(input)
      const database = { ...input, characters: [] }
      const preflight = { database: input, currentChar: { chaId: 'character' }, currentChat: { id: 'chat' } }

      expect(decodeGenerationSettings(input)).toBe(input)
      expect(decodeGenerationDatabase(database)).toBe(database)
      expect(decodeGenerationPreflightInputs(preflight)).toBe(preflight)
      expect(decodeProviderGenerationSettings(input)).toBe(input)
      expect(decodeMemoryGenerationSettings(input)).toBe(input)
      expect(JSON.stringify(input)).toBe(bytes)
      expect(database.dynamicOutput).toBe(dynamicOutput)
      expect(Object.hasOwn(input, 'dynamicOutput')).toBe(dynamicOutput !== undefined)
    },
  )

  it.each([false, 'disabled', [], { dynamicMessages: 'yes' }, { showTypingEffect: null }])(
    'rejects malformed dynamic output %j in every configuration owner',
    (dynamicOutput) => {
      const owners = [
        [{ dynamicOutput }, '/database/dynamicOutput'],
        [{ modelPresets: [{ id: 'model', dynamicOutput }] }, '/database/modelPresets/0/dynamicOutput'],
        [{ promptPresets: [{ id: 'prompt', dynamicOutput }] }, '/database/promptPresets/0/dynamicOutput'],
        [{ modelRuntimeDefaults: { dynamicOutput } }, '/database/modelRuntimeDefaults/dynamicOutput'],
        [
          { modelProfiles: [{ id: 'profile', name: 'Main', runtimeOptions: { dynamicOutput } }] },
          '/database/modelProfiles/0/runtimeOptions/dynamicOutput',
        ],
      ] as const
      for (const [database, field] of owners) {
        expect(() =>
          decodeGenerationPreflightInputs({
            database,
            currentChar: { chaId: 'character' },
            currentChat: { id: 'chat' },
          }),
        ).toThrow(`Invalid preflight generation input at ${field}`)
      }
    },
  )

  it.each(['thinkingTokens', 'promptSettings', 'reverseProxyOobaArgs', 'seperateModels'])(
    'preserves the legacy preset null for %s across generation boundaries and split extraction',
    (field) => {
      const setting = { [field]: null }
      const input = {
        ...setting,
        modelPresets: [createExtractedModelPreset(setting, { id: 'model' })],
        promptPresets: [createExtractedPromptPreset(setting, { id: 'prompt' })],
      }
      const bytes = JSON.stringify(input)
      const database = { ...input, characters: [] }
      const preflight = { database: input, currentChar: { chaId: 'character' }, currentChat: { id: 'chat' } }
      expect(decodeGenerationSettings(input)).toBe(input)
      expect(decodeGenerationDatabase(database)).toBe(database)
      expect(decodeGenerationPreflightInputs(preflight)).toBe(preflight)
      expect(decodeProviderGenerationSettings(input)).toBe(input)
      expect(decodeMemoryGenerationSettings(input)).toBe(input)
      expect(JSON.stringify(input)).toBe(bytes)

      // Root defaults may replace null, but selected preset records retain it.
      const imported = normalizeRisuSaveSnapshotDatabase(database)
      expect(decodeGenerationDatabase(imported)).toBe(imported)
    },
  )

  it('preserves null reverse-proxy arguments in durable profiles', () => {
    const input = {
      modelProfiles: [{ id: 'profile', name: 'Proxy', providerOptions: { reverseProxy: { oobaArgs: null } } }],
    }
    expect(decodeGenerationSettings(input)).toBe(input)
    expect(decodeProviderGenerationSettings(input)).toBe(input)
  })

  it.each([
    { thinkingTokens: '1000' },
    { thinkingTokens: {} },
    { promptSettings: false },
    { promptSettings: { sendName: 'yes' } },
    { reverseProxyOobaArgs: [] },
    { reverseProxyOobaArgs: { top_k: 'hot' } },
    { seperateModels: 'disabled' },
    { seperateModels: { memory: 42 } },
    { modelProfiles: [{ id: 'profile', name: 'Proxy', providerOptions: { reverseProxy: { oobaArgs: false } } }] },
  ])('still rejects malformed non-null legacy settings %j', (input) => {
    expect(() => decodeGenerationSettings(input)).toThrow(GenerationInputValidationError)
  })

  it.each(['chara_card_v2', 'chara_card_v3'])(
    'preserves boolean and legacy string asset-prompt toggles from %s cards',
    async (spec) => {
      for (const prebuiltAssetCommand of [undefined, '', 'legacy-enabled', false, true]) {
        const character = await convertRealmCharacterCard(
          { spec, data: { name: 'Imported', extensions: { risuai: { prebuiltAssetCommand } } } },
          {
            storeAsset: async () => {
              throw new Error('Fixture has no assets')
            },
          },
        )
        const input = normalizeRisuSaveSnapshotDatabase({ characters: [character] })
        const decoded = decodeGenerationDatabase(input)
        expect(decoded.characters[0].prebuiltAssetCommand).toBe(prebuiltAssetCommand ?? '')
        expect(decoded).toBe(input)
        expect(() =>
          decodeGenerationDatabase({
            ...input,
            characters: [{ ...decoded.characters[0], prebuiltAssetCommand: 42 }],
          }),
        ).toThrow('/characters/0/prebuiltAssetCommand')
      }
    },
  )

  it('decodes imported character-card lore caches and migrated probability markers', async () => {
    const character = await convertRealmCharacterCard(
      {
        spec: 'chara_card_v2',
        data: {
          name: 'Imported',
          character_book: {
            entries: [
              { keys: ['key'], content: 'Imported lore', extensions: {} },
              {
                keys: ['key'],
                content: '@@probability 50\nMigrated lore',
                extensions: { risu_activationPercent: null, risu_loreCache: null },
              },
            ],
          },
        },
      },
      {
        storeAsset: async () => {
          throw new Error('Fixture has no assets')
        },
      },
    )
    const input = normalizeRisuSaveSnapshotDatabase({ characters: [character] })
    const bytes = JSON.stringify(input)
    const decoded = decodeGenerationDatabase(input)
    expect(decoded).toBe(input)
    expect(decoded.characters[0].globalLore[0].loreCache).toBeNull()
    expect(decoded.characters[0].globalLore[1]).toMatchObject({ activationPercent: null, loreCache: null })
    const lore = decoded.characters[0].globalLore
    const moduleSettings = { modules: [{ id: 'module', name: 'Module', description: '', lorebook: lore }] }
    expect(decodeGenerationSettings(moduleSettings)).toBe(moduleSettings)
    decoded.characters[0].chats[0].localLore = lore
    expect(decodeGenerationDatabase(input)).toBe(input)
    decoded.characters[0].chats[0].localLore = []
    expect(JSON.stringify(input)).toBe(bytes)

    for (const invalid of [{ activationPercent: '50' }, { loreCache: [] }, { loreCache: { key: 'key', data: [42] } }]) {
      expect(() =>
        decodeGenerationSettings({
          modules: [{ ...moduleSettings.modules[0], lorebook: [{ ...lore[0], ...invalid }] }],
        }),
      ).toThrow(GenerationInputValidationError)
    }
  })

  it.each([null, 'folder'])('preserves supported chat folder ownership %j without copying', (folderId) => {
    const input = selectedDatabaseWithMessage({ role: 'user', data: 'accepted' })
    const chat = input.characters[0].chats[0]
    chat.folderId = folderId
    expect(decodeGenerationDatabase(input)).toBe(input)
    expect(decodeGenerationDatabase(input).characters[0].chats[0]).toBe(chat)
    expect(chat.folderId).toBe(folderId)
    expect(() =>
      decodeGenerationDatabase({
        ...input,
        characters: [{ ...input.characters[0], chats: [{ ...chat, folderId: 42 }] }],
      }),
    ).toThrow('Invalid database generation input at /characters/0/chats/0/folderId')
  })

  it('round-trips every nullable message metadata field accepted by commands and SQLite', () => {
    const db = new DatabaseSync(':memory:')
    try {
      createMessageTable(db)
      const row = createMessageRecord({
        chatId: 'message',
        role: 'user',
        data: 'accepted',
        name: null,
        time: null,
        translation: null,
        promptInfo: {},
        generationInfo: {},
        saying: 'speaker',
        otherUser: false,
        disabled: 'allBefore',
        isComment: false,
      })
      db.prepare('INSERT INTO messages (chat_id,seq,uid,role,data,json) VALUES (?,?,?,?,?,?)').run(
        'chat',
        0,
        row.chatId,
        row.role,
        row.data,
        JSON.stringify(row),
      )
      const [stored] = getChatMessages(db, 'chat')
      expect(decodeGenerationDatabase(selectedDatabaseWithMessage(stored)).characters[0].chats[0].message[0]).toBe(
        stored,
      )
      expect(stored).toEqual(row)
      expect(stored).toMatchObject({ name: null, time: null, translation: null, promptInfo: {}, generationInfo: {} })
    } finally {
      db.close()
    }
  })

  it('preserves omitted regex comments and supported legacy role aliases', () => {
    const raw = {
      globalscript: [{ in: 'a', out: 'b', type: 'editinput' }],
      promptTemplate: [
        { type: 'memory', role2: 'assistant' },
        { type: 'authornote', role2: null },
      ],
    }
    expect(decodeGenerationSettings(raw)).toBe(raw)
  })

  it.each([3, false, { id: 'old' }])(
    'keeps malformed stable Hypa selection on the established no-selection path: %j',
    (selected) => {
      const presets = [{ id: 'valid', name: 'Valid', settings: { memoryTokensRatio: 0.3 } }]
      const raw = { selectedHypaV3PresetId: selected, hypaV3Presets: presets, hypaV3PresetId: 0 }
      const decoded = decodeGenerationSettings(raw)
      expect(decoded.selectedHypaV3PresetId).toBeNull()
      expect(decoded.hypaV3Presets).toBe(presets)
      expect(raw.selectedHypaV3PresetId).toBe(selected)
      expect(Object.getOwnPropertyDescriptor(decoded, 'hypaV3PresetId')?.value).toBe(0)
    },
  )

  it('preserves custom model entries without optional request parameters', () => {
    const customModel = {
      id: 'xcustom:::vision',
      internalId: 'vision',
      name: 'Vision',
      url: 'https://vision.example/v1/chat/completions',
      key: 'fixture-key',
      format: 0,
      tokenizer: 0,
      flags: [0],
    }
    const input = { customModels: [customModel] }
    const preflight = { database: input, currentChar: { chaId: 'character' }, currentChat: { id: 'chat' } }
    expect(decodeGenerationSettings(input)).toBe(input)
    expect(decodeGenerationPreflightInputs(preflight)).toBe(preflight)
    expect(decodeProviderGenerationSettings(input)).toBe(input)
    expect(Object.hasOwn(customModel, 'params')).toBe(false)
    expect(() => decodeGenerationSettings({ customModels: [{ ...customModel, params: 42 }] })).toThrow(
      'Invalid settings generation input at /customModels/0/params',
    )
  })

  it('accepts sparse provider settings with existing per-provider defaults', () => {
    const raw = {
      hordeConfig: { apiKey: 'horde-key' },
      google: { projectId: 'project' },
      openrouterProvider: { only: ['provider'] },
    }
    expect(decodeGenerationSettings(raw)).toBe(raw)
  })

  it('checks selected character regex values while permitting absent comment metadata', () => {
    const base = selectedDatabaseWithMessage({ role: 'user', data: 'message' })
    const input = {
      ...base,
      characters: [{ ...base.characters[0], customscript: [{ in: 'a', out: 'b', type: 'editinput' }] }],
    }
    expect(decodeGenerationDatabase(input)).toBe(input)
    const invalid = {
      ...base,
      characters: [{ ...base.characters[0], customscript: [{ in: 'a', out: 5, type: 'editinput' }] }],
    }
    expect(() => decodeGenerationDatabase(invalid)).toThrow(GenerationInputValidationError)
  })

  it('checks message values while preserving round-trip extension data', () => {
    const message = { role: 'char', data: 'reply', saying: 'sibling', future: { count: 2 } }
    expect(decodeGenerationDatabase(selectedDatabaseWithMessage(message)).characters[0].chats[0].message[0]).toBe(
      message,
    )
    expect(() => decodeGenerationDatabase(selectedDatabaseWithMessage({ ...message, data: 5 }))).toThrow(
      GenerationInputValidationError,
    )
    expect(() => decodeGenerationDatabase(selectedDatabaseWithMessage({ ...message, role: 'system' }))).toThrow(
      GenerationInputValidationError,
    )
  })

  it('accepts the supported legacy-save normalization boundary without changing its output', () => {
    const normalized = normalizeRisuSaveSnapshotDatabase({
      characters: [
        { chaId: 'character', name: 'Legacy', chats: [{ id: 'chat', message: [{ role: 'user', data: 'Hello' }] }] },
      ],
      botPresets: [{ id: 'legacy', name: 'Legacy', mainPrompt: 'system' }],
      personas: [{ id: 'persona', name: 'User' }],
      hypaV3Presets: [{ id: 'memory', name: 'Memory', settings: { memoryTokensRatio: 0.3 } }],
      enabledModules: [],
      modules: [],
    })
    const bytes = JSON.stringify(normalized)
    expect(decodeGenerationDatabase(normalized)).toBe(normalized)
    expect(JSON.stringify(normalized)).toBe(bytes)
  })
})
