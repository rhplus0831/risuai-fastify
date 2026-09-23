import { decodeGenerationSettings, decodeGenerationPreflightInputs } from '../src/prompt/generationInputDecoder.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveEffectivePromptTemplate,
  resolveUniquePromptPreset,
} from '@risuai/shared-core/effective-prompt-template'
import { resolveModuleActivationStates } from '@risuai/shared-core/module-activation'
import { getSchemaState, openDatabase } from '../src/db.js'
import {
  createCollectionTables,
  insertAssetMetadataBatch,
  loadPersistedForAssembly,
  loadPersistedForGenerationAssembly,
  loadPersistedForGenerationPreflight,
  repairPersistedHypaV3PresetSelectionIdentityInSqlite,
  writePersistedWithMessages,
  writeSingleCollectionTable,
} from '../src/repository.js'

type RecordValue = Record<string, unknown>
const target = { characterId: 'target-character', chatId: 'target-chat' }
const stores: Array<{ db: DatabaseSync; directory: string }> = []
const settings = {
  configured: true,
  personaId: 'selected-persona',
  modelPresetId: 'selected-model',
  promptPresetId: 'selected-prompt',
  jailbreakToggle: false,
  sidebarToggles: {},
}

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected record')
  return value as RecordValue
}

function records(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) throw new Error('Expected records')
  return value.map(record)
}

function fixture(unrelated = 0): RecordValue {
  const body = 'unrelated body '.repeat(300)
  return {
    aiModel: 'gpt-4o-mini',
    username: 'User',
    maxContext: 32000,
    maxResponse: 256,
    enabledModules: [],
    modelPresetsId: 0,
    promptPresetsId: 0,
    selectedPersonaId: 'selected-persona',
    selectedPersona: 0,
    modelPresets: [
      { id: 'selected-model', name: 'Model', aiModel: 'gpt-4o-mini' },
      ...Array.from({ length: unrelated }, (_, index) => ({ id: `model-${index}`, name: 'Unused', body })),
    ],
    promptPresets: [
      { id: 'selected-prompt', name: 'Prompt', mainPrompt: 'Hello' },
      ...Array.from({ length: unrelated }, (_, index) => ({ id: `prompt-${index}`, name: 'Unused', mainPrompt: body })),
    ],
    personas: [
      { id: 'selected-persona', name: 'User', personaPrompt: 'Persona', icon: '', note: '' },
      ...Array.from({ length: unrelated }, (_, index) => ({
        id: `persona-${index}`,
        name: 'Unused',
        personaPrompt: body,
      })),
    ],
    modules: Array.from({ length: unrelated }, (_, index) => ({
      id: `module-${index}`,
      name: 'Unused',
      description: body,
      lorebook: [{ content: body }],
    })),
    characters: [
      {
        chaId: target.characterId,
        name: 'Target',
        desc: 'Description',
        chatPage: 0,
        chats: [
          {
            id: target.chatId,
            name: 'Selected chat',
            note: '',
            localLore: [],
            generationSettings: settings,
            message: Array.from({ length: 4 }, (_, index) => ({
              role: index % 2 ? 'char' : 'user',
              data: `Message ${index}`,
              chatId: `message-${index}`,
            })),
          },
        ],
      },
      ...Array.from({ length: unrelated }, (_, index) => ({
        chaId: `character-${index}`,
        name: `Sibling ${index}`,
        desc: body,
        chatPage: 0,
        chats: Array.from({ length: 3 }, (_, chatIndex) => ({
          id: `chat-${index}-${chatIndex}`,
          name: body,
          note: body,
          localLore: [],
          generationSettings: settings,
          message: [{ role: 'user', data: body, chatId: `unrelated-message-${index}-${chatIndex}` }],
        })),
      })),
    ],
  }
}

function openFixture(database = fixture()) {
  const directory = mkdtempSync(path.join(tmpdir(), 'risu-generation-loader-'))
  const db = openDatabase(directory)
  stores.push({ db, directory })
  writePersistedWithMessages(db, directory, { _version: 1, database, assets: [] })
  return { db, directory }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) {
    store.db.close()
    rmSync(store.directory, { recursive: true, force: true })
  }
})

function observed<T>(db: DatabaseSync, run: () => T) {
  const calls: Array<{ sql: string; rows: number }> = []
  const prototype: StatementSync = Object.getPrototypeOf(db.prepare('SELECT 1'))
  const originalAll = prototype.all
  const originalGet = prototype.get
  const allSpy = vi.spyOn(prototype, 'all').mockImplementation(function (
    this: StatementSync,
    ...parameters: Array<SQLInputValue | Record<string, SQLInputValue>>
  ) {
    const result = Reflect.apply(originalAll, this, parameters)
    calls.push({ sql: this.sourceSQL, rows: result.length })
    return result
  })
  const getSpy = vi.spyOn(prototype, 'get').mockImplementation(function (
    this: StatementSync,
    ...parameters: Array<SQLInputValue | Record<string, SQLInputValue>>
  ) {
    const result = Reflect.apply(originalGet, this, parameters)
    calls.push({ sql: this.sourceSQL, rows: result ? 1 : 0 })
    return result
  })
  try {
    return { result: run(), calls, returnedRows: calls.reduce((sum, call) => sum + call.rows, 0) }
  } finally {
    allSpy.mockRestore()
    getSpy.mockRestore()
  }
}

describe('selected generation repository inputs', () => {
  it('validates chat preset overlays instead of shadowed global editor fields', () => {
    const input = fixture()
    // Deliberately invalid global mirrors; selected owners supply valid values.
    input.temperature = 'invalid-global-temperature'
    input.promptSettings = 'invalid-global-prompt-settings'
    input.seperateParameters = { overrides: { 'unused-model': 'invalid' } }
    records(input.modelPresets)[0].temperature = 70
    records(input.modelPresets)[0].seperateParameters = { overrides: {} }
    records(input.promptPresets)[0].promptSettings = { assistantPrefill: 'Selected' }
    const { db, directory } = openFixture(input)
    const before = db.prepare('SELECT data_json FROM settings WHERE id = 1').get()
    const preflight = decodeGenerationPreflightInputs(
      loadPersistedForGenerationPreflight(db, directory, target).preflightInputs,
    )
    const assembly = decodeGenerationSettings(loadPersistedForGenerationAssembly(db, directory, target).database)
    for (const database of [preflight.database, assembly]) {
      expect(database.temperature).toBe(70)
      expect(database.promptSettings).toEqual({ assistantPrefill: 'Selected' })
      expect(database.seperateParameters).toEqual({ overrides: {} })
    }
    expect(db.prepare('SELECT data_json FROM settings WHERE id = 1').get()).toEqual(before)
  })

  it('composes empty original-editor preset values as upstream defaults without rewriting the row', () => {
    const input = fixture()
    // The settings row holds explicit non-default values; the selected prompt
    // preset asserts '' for the same fields, as original RisuAI exports do.
    input.systemRoleReplacement = 'assistant'
    input.reasoningEffort = 2
    input.verbosity = 2
    Object.assign(records(input.promptPresets)[0], {
      overrideModelParameters: true,
      systemRoleReplacement: '',
      reasonEffort: '',
      verbosity: '',
      thinkingType: '',
    })
    const { db, directory } = openFixture(input)
    // Bypass import-time canonicalization: this row was persisted before the fix.
    db.prepare(
      "UPDATE prompt_presets SET data_json = json_set(data_json, '$.systemRoleReplacement', '', '$.reasonEffort', '', '$.verbosity', '', '$.thinkingType', '') WHERE json_extract(data_json, '$.id') = ?",
    ).run('selected-prompt')
    const before = db
      .prepare("SELECT data_json FROM prompt_presets WHERE json_extract(data_json, '$.id') = ?")
      .get('selected-prompt')
    expect(JSON.parse((before as { data_json: string }).data_json)).toMatchObject({ systemRoleReplacement: '' })

    const preflight = decodeGenerationPreflightInputs(
      loadPersistedForGenerationPreflight(db, directory, target).preflightInputs,
    )
    const assembly = decodeGenerationSettings(loadPersistedForGenerationAssembly(db, directory, target).database)
    for (const database of [preflight.database, assembly]) {
      expect(database.systemRoleReplacement).toBe('user')
      expect(database.reasoningEffort).toBe(1)
      expect(database.verbosity).toBe(1)
      expect(database.thinkingType).toBe('budget')
    }
    expect(
      db
        .prepare("SELECT data_json FROM prompt_presets WHERE json_extract(data_json, '$.id') = ?")
        .get('selected-prompt'),
    ).toEqual(before)
  })

  it('keeps prompt override precedence and rejects invalid selected values', () => {
    const input = fixture()
    input.temperature = 'invalid-global-temperature'
    records(input.modelPresets)[0].temperature = 70
    Object.assign(records(input.promptPresets)[0], { overrideModelParameters: true, temperature: 90 })
    const { db, directory } = openFixture(input)
    expect(
      decodeGenerationPreflightInputs(loadPersistedForGenerationPreflight(db, directory, target).preflightInputs)
        .database.temperature,
    ).toBe(90)
    db.prepare(
      "UPDATE prompt_presets SET data_json = json_set(data_json, '$.temperature', ?) WHERE json_extract(data_json, '$.id') = ?",
    ).run('invalid-selected-temperature', 'selected-prompt')
    expect(() =>
      decodeGenerationPreflightInputs(loadPersistedForGenerationPreflight(db, directory, target).preflightInputs),
    ).toThrow('Invalid preflight generation input')
  })

  it.each(['selected', 'embedded-characters'] as const)(
    'validates profile runtime and empty prompt regex before global mirrors (%s)',
    (storage) => {
      const input = fixture()
      input.temperature = 'invalid-global-temperature'
      input.presetRegex = 'invalid-global-regex'
      Object.assign(records(input.modelPresets)[0], {
        modelProfiles: [{ id: 'profile', name: 'Profile', modelId: 'echo_model', runtimeOptions: { temperature: 66 } }],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'profile' } },
      })
      const { db, directory } = openFixture(input)
      if (storage === 'embedded-characters') {
        db.exec('DELETE FROM characters')
        db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(input))
      }
      const before = db.prepare('SELECT data_json FROM settings WHERE id = 1').get()
      const preflight = decodeGenerationPreflightInputs(
        loadPersistedForGenerationPreflight(db, directory, target).preflightInputs,
      )
      const assembly = decodeGenerationSettings(loadPersistedForGenerationAssembly(db, directory, target).database)
      for (const database of [preflight.database, assembly]) {
        expect(database.temperature).toBe(66)
        expect(database.presetRegex).toEqual([])
      }
      expect(db.prepare('SELECT data_json FROM settings WHERE id = 1').get()).toEqual(before)
    },
  )

  it.each(['selected', 'embedded-characters'] as const)(
    'clears unrelated global module integration before validation (%s)',
    (storage) => {
      const input = fixture()
      input.moduleIntergration = 123
      const { db, directory } = openFixture(input)
      if (storage === 'embedded-characters') {
        db.exec('DELETE FROM characters')
        db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(input))
      }
      const before = db.prepare('SELECT data_json FROM settings WHERE id = 1').get()
      const preflight = decodeGenerationPreflightInputs(
        loadPersistedForGenerationPreflight(db, directory, target).preflightInputs,
      )
      const assembly = decodeGenerationSettings(loadPersistedForGenerationAssembly(db, directory, target).database)
      expect(preflight.database.moduleIntergration).toBe('')
      expect(assembly.moduleIntergration).toBe('')
      expect(db.prepare('SELECT data_json FROM settings WHERE id = 1').get()).toEqual(before)
    },
  )

  it.each(['default', 'chat', 'disabled'] as const)(
    'projects prompt and effective agent module integration (%s agent selection)',
    (selection) => {
      const input = fixture()
      input.moduleIntergration = 123
      records(input.promptPresets)[0].moduleIntergration = 'prompt-ns, shared-ns'
      input.agentPresetDefaultId = 'default-agent'
      input.agentPresets = [
        {
          id: 'default-agent',
          name: 'Default',
          enabled: true,
          version: 1,
          steps: [],
          moduleIntergration: 'default-ns, shared-ns',
          agentUses: [],
        },
        {
          id: 'chat-agent',
          name: 'Chat',
          enabled: true,
          version: 1,
          steps: [],
          moduleIntergration: 'chat-ns, shared-ns',
          agentUses: [],
        },
      ]
      if (selection !== 'default') {
        records(records(input.characters)[0].chats)[0].generationSettings = {
          ...settings,
          agentPresetId: selection === 'chat' ? 'chat-agent' : '',
        }
      }
      const { db, directory } = openFixture(input)
      const preflight = decodeGenerationPreflightInputs(
        loadPersistedForGenerationPreflight(db, directory, target).preflightInputs,
      )
      const assembly = decodeGenerationSettings(loadPersistedForGenerationAssembly(db, directory, target).database)
      const expected = selection === 'disabled' ? 'prompt-ns, shared-ns' : `prompt-ns, shared-ns, ${selection}-ns`
      expect(preflight.database.moduleIntergration).toBe(expected)
      expect(assembly.moduleIntergration).toBe(expected)
    },
  )

  it('keeps prompt parameter overrides above profile runtime during input validation', () => {
    const input = fixture()
    input.temperature = 'invalid-global-temperature'
    Object.assign(records(input.modelPresets)[0], {
      modelProfiles: [{ id: 'profile', name: 'Profile', modelId: 'echo_model', runtimeOptions: { temperature: 66 } }],
      modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'profile' } },
    })
    Object.assign(records(input.promptPresets)[0], { overrideModelParameters: true, temperature: 90 })
    const { db, directory } = openFixture(input)
    expect(
      decodeGenerationPreflightInputs(loadPersistedForGenerationPreflight(db, directory, target).preflightInputs)
        .database.temperature,
    ).toBe(90)
    expect(
      decodeGenerationSettings(loadPersistedForGenerationAssembly(db, directory, target).database).temperature,
    ).toBe(90)
  })

  it.each(['profile', 'prompt-regex', 'prompt-integration', 'legacy-fallback'] as const)(
    'still rejects invalid active configuration (%s)',
    (invalidOwner) => {
      const input = fixture()
      if (invalidOwner === 'profile') {
        Object.assign(records(input.modelPresets)[0], {
          modelProfiles: [
            { id: 'profile', name: 'Profile', modelId: 'echo_model', runtimeOptions: { temperature: 'bad' } },
          ],
          modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'profile' } },
        })
      } else if (invalidOwner === 'prompt-regex') {
        records(input.promptPresets)[0].presetRegex = 'bad'
      } else if (invalidOwner === 'prompt-integration') {
        records(input.promptPresets)[0].moduleIntergration = 123
      } else {
        input.temperature = 'bad'
      }
      const { db, directory } = openFixture(input)
      expect(() =>
        decodeGenerationPreflightInputs(loadPersistedForGenerationPreflight(db, directory, target).preflightInputs),
      ).toThrow('Invalid preflight generation input')
      expect(() =>
        decodeGenerationSettings(loadPersistedForGenerationAssembly(db, directory, target).database),
      ).toThrow('Invalid settings generation input')
    },
  )

  it('reuses fixed query programs while reading later writes and other connections independently', () => {
    const { db, directory } = openFixture(fixture())
    loadPersistedForGenerationAssembly(db, directory, target)
    const prepare = vi.spyOn(db, 'prepare')
    const repeated = observed(db, () => loadPersistedForGenerationAssembly(db, directory, target))
    expect(repeated.returnedRows).toBe(9)
    expect(prepare.mock.calls.map(([sql]) => sql)).toEqual(['SELECT 1'])
    prepare.mockRestore()

    db.prepare(
      "UPDATE prompt_presets SET data_json = json_set(data_json, '$.mainPrompt', ?) WHERE json_extract(data_json, '$.id') = ?",
    ).run('Changed after preparation', 'selected-prompt')
    db.prepare("UPDATE messages SET json = json_set(json, '$.data', ?) WHERE chat_id = ? AND seq = 0").run(
      'Changed stored history',
      target.chatId,
    )
    const changed = record(loadPersistedForGenerationAssembly(db, directory, target).database)
    expect(records(changed.promptPresets)[0].mainPrompt).toBe('Changed after preparation')
    expect(records(records(records(changed.characters)[0].chats)[0].message)[0].data).toBe('Changed stored history')
    const other = openFixture(fixture())
    const independent = record(loadPersistedForGenerationAssembly(other.db, other.directory, target).database)
    expect(records(independent.promptPresets)[0].mainPrompt).toBe('Hello')
  })

  it('does not retain oversized selector bindings in cached query programs', () => {
    const { db, directory } = openFixture(fixture())
    loadPersistedForGenerationPreflight(db, directory, target)
    const prepare = vi.spyOn(db, 'prepare')
    const oversized = { ...target, characterId: 'large-selector-'.repeat(400) }
    loadPersistedForGenerationPreflight(db, directory, oversized)
    loadPersistedForGenerationPreflight(db, directory, oversized)
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('FROM chats AS chat JOIN characters'))).toHaveLength(2)
    prepare.mockClear()
    loadPersistedForGenerationPreflight(db, directory, target)
    expect(prepare).not.toHaveBeenCalled()
  })

  it(
    'holds fixed selected read/output scope across unrelated characters, collections and assets',
    { tags: 'core' },
    () => {
      const databaseBytes: number[] = []
      const preflightBytes: number[] = []
      for (const unrelated of [0, 12, 48]) {
        const { db, directory } = openFixture(fixture(unrelated))
        insertAssetMetadataBatch(
          db,
          Array.from({ length: unrelated * 8 }, (_, index) => ({
            id: index.toString(16).padStart(64, '0'),
            ext: 'png',
            size: 4096,
            contentType: 'image/png',
          })),
        )
        const preflight = observed(db, () => loadPersistedForGenerationPreflight(db, directory, target))
        expect(preflight.result.generationScope).toBe('selected')
        expect(preflight.result).not.toHaveProperty('missingTarget')
        expect(preflight.calls.some(({ sql }) => sql.startsWith('SELECT 1 AS present FROM characters WHERE id'))).toBe(
          false,
        )
        expect(preflight.returnedRows).toBeLessThanOrEqual(6)
        expect(preflight.calls.some(({ sql }) => /\b(?:messages|chat_hypa_v3|assets)\b/i.test(sql))).toBe(false)
        expect(preflight.result.preflightInputs?.currentChar).toEqual({ chaId: target.characterId })
        expect(preflight.result.preflightInputs?.currentChat).toEqual({
          id: target.chatId,
          generationSettings: settings,
        })
        expect(record(preflight.result.preflightInputs?.database)).not.toHaveProperty('characters')
        preflightBytes.push(Buffer.byteLength(JSON.stringify(preflight.result.preflightInputs)))

        const assembly = observed(db, () => loadPersistedForGenerationAssembly(db, directory, target))
        const database = record(assembly.result.database)
        const character = records(database.characters)[0]
        const chat = records(character.chats)[0]
        expect(assembly.returnedRows).toBeLessThanOrEqual(10)
        expect(assembly.result.generationScope).toBe('selected')
        expect(assembly.result.assets).toEqual([])
        expect(assembly.calls.some(({ sql }) => /\bassets\b/i.test(sql))).toBe(false)
        expect(database.currentChar).toBe(0)
        expect(records(database.characters)).toHaveLength(1)
        expect(records(character.chats)).toHaveLength(1)
        expect(records(chat.message)).toHaveLength(4)
        expect(database.modules).toEqual([])
        expect(records(database.modelPresets).map((value) => value.id)).toEqual(['selected-model'])
        expect(records(database.promptPresets).map((value) => value.id)).toEqual(['selected-prompt'])
        expect(records(database.personas).map((value) => value.id)).toEqual(['selected-persona'])
        expect(JSON.stringify(database)).not.toContain('unrelated body')
        databaseBytes.push(Buffer.byteLength(JSON.stringify(database)))
      }
      expect(new Set(databaseBytes).size).toBe(1)
      expect(new Set(preflightBytes).size).toBe(1)
    },
  )

  it('resolves every module activation source by ID or namespace while retaining matching duplicate order', () => {
    const database = fixture()
    const char = records(database.characters)[0]
    const chat = records(char.chats)[0]
    database.enabledModules = ['global-ns']
    char.modules = ['character-module']
    chat.modules = ['chat-module']
    records(database.personas)[0].modules = ['persona-ns']
    records(database.promptPresets)[0].moduleIntergration = 'prompt-ns'
    database.agentPresetDefaultId = 'selected-agent-preset'
    database.agentPresets = [
      { id: 'unused-agent-preset', agentUses: [] },
      { id: 'selected-agent-preset', moduleIntergration: 'agent-ns', agentUses: [{ agentId: 'selected-agent' }] },
    ]
    database.agents = [{ id: 'unused-agent' }, { id: 'selected-agent', toggles: [] }]
    database.modules = [
      { id: 'duplicated', namespace: 'unmatched', name: 'Earlier nonmatching duplicate' },
      { id: 'persona-module', namespace: 'persona-ns', name: 'Persona' },
      {
        id: 'duplicated',
        namespace: 'global-ns',
        name: 'First matching duplicate',
        lorebook: [{ content: 'Executable body' }],
      },
      { id: 'duplicated', namespace: 'global-ns', name: 'Later matching duplicate' },
      { id: 'prompt-module', namespace: 'prompt-ns', name: 'Prompt' },
      { id: 'character-module', name: 'Character' },
      { id: 'chat-module', name: 'Chat' },
      { id: 'agent-module', namespace: 'agent-ns', name: 'Agent' },
    ]
    const { db, directory } = openFixture(database)
    const loaded = record(loadPersistedForGenerationAssembly(db, directory, target).database)
    const modules = records(loaded.modules)
    expect(modules.map((module) => module.name)).toEqual([
      'Persona',
      'First matching duplicate',
      'Later matching duplicate',
      'Prompt',
      'Character',
      'Chat',
      'Agent',
    ])
    const active = resolveModuleActivationStates({
      modules: modules.map((module) => ({
        ...module,
        name: String(module.name),
        id: String(module.id),
        namespace: typeof module.namespace === 'string' ? module.namespace : undefined,
      })),
      identifiers: { global: ['global-ns', 'persona-ns', 'prompt-ns', 'character-module', 'chat-module', 'agent-ns'] },
    })
    expect(active.map((state) => state.module.name)).toEqual([
      'Persona',
      'First matching duplicate',
      'Prompt',
      'Character',
      'Chat',
      'Agent',
    ])
    expect(records(loaded.agents).map((agent) => agent.id)).toEqual(['selected-agent'])
    expect(records(loaded.agentPresets).map((preset) => preset.id)).toEqual(['selected-agent-preset'])
    const preflight = record(loadPersistedForGenerationPreflight(db, directory, target).preflightInputs?.database)
    expect(records(preflight.modules).map((module) => module.id)).toEqual([
      'persona-module',
      'duplicated',
      'duplicated',
      'prompt-module',
      'character-module',
      'chat-module',
      'agent-module',
    ])
    expect(records(preflight.modules).every((module) => !('lorebook' in module) && !('name' in module))).toBe(true)
  })

  it('preserves duplicate prompt rejection and first-match model/persona ownership', () => {
    const database = fixture()
    database.promptPresets = [0, 1, 2].map((index) => ({ id: 'selected-prompt', name: `Prompt ${index}` }))
    database.modelPresets = [0, 1].map((index) => ({ id: 'selected-model', name: `Model ${index}` }))
    database.personas = [0, 1].map((index) => ({ id: 'selected-persona', name: `Persona ${index}` }))
    const { db, directory } = openFixture(database)
    const loaded = record(loadPersistedForGenerationAssembly(db, directory, target).database)
    const promptPresets = records(loaded.promptPresets)
    expect(promptPresets).toHaveLength(2)
    expect(resolveUniquePromptPreset(promptPresets, 'selected-prompt')).toBeUndefined()
    expect(records(loaded.modelPresets)[0].name).toBe('Model 0')
    expect(records(loaded.personas)[0].name).toBe('Persona 0')
  })

  it('uses embedded collection fallback only when the extracted table is empty', () => {
    const database = fixture()
    const { db, directory } = openFixture(database)
    const embedded = { ...database, modelPresets: [{ id: 'selected-model', name: 'Embedded model' }] }
    db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(embedded))
    writeSingleCollectionTable(db, 'modelPresets', [{ id: 'other-model', name: 'Authoritative table' }])
    let loaded = record(loadPersistedForGenerationAssembly(db, directory, target).database)
    expect(loaded.modelPresets).toEqual([])
    db.exec('DELETE FROM model_presets')
    loaded = record(loadPersistedForGenerationAssembly(db, directory, target).database)
    expect(loaded.modelPresets).toEqual([{ id: 'selected-model', name: 'Embedded model' }])
  })

  it('keeps target embedded messages/Hypa fallback without reading it during preflight', () => {
    const { db, directory } = openFixture()
    db.exec('DELETE FROM messages')
    const stored = record(
      JSON.parse(String(db.prepare('SELECT data_json FROM chats WHERE id = ?').get(target.chatId)?.data_json)),
    )
    stored.message = [{ role: 'char', data: 'Embedded transcript', chatId: 'embedded-message' }]
    stored.hypaV3Data = { summaries: ['Embedded memory'] }
    db.prepare('UPDATE chats SET data_json = ? WHERE id = ?').run(JSON.stringify(stored), target.chatId)
    const preflight = observed(db, () => loadPersistedForGenerationPreflight(db, directory, target))
    expect(preflight.calls.some(({ sql }) => /\b(?:messages|chat_hypa_v3)\b/i.test(sql))).toBe(false)
    expect(JSON.stringify(preflight.result)).not.toContain('Embedded transcript')
    const loaded = record(loadPersistedForGenerationAssembly(db, directory, target).database)
    const chat = records(records(loaded.characters)[0].chats)[0]
    expect(chat.message).toEqual(stored.message)
    expect(chat.hypaV3Data).toEqual(stored.hypaV3Data)
  })

  it('preserves authoritative target message/Hypa rows and loads only the selected Hypa preset', () => {
    const database = fixture()
    database.selectedHypaV3PresetId = 'selected-hypa'
    database.hypaV3Presets = [
      { id: 'unused-hypa', name: 'Unused', settings: {} },
      { id: 'selected-hypa', name: 'Selected', settings: { memoryTokensRatio: 0.2 } },
    ]
    records(records(database.characters)[0].chats)[0].hypaV3Data = { summaries: ['Stored memory'] }
    const { db, directory } = openFixture(database)
    // Persist contradictory legacy bodies alongside canonical rows: agreement
    // between two loaders alone cannot prove which owner supplied the result.
    db.prepare(
      "UPDATE chats SET data_json = json_set(data_json, '$.message', json(?), '$.hypaV3Data', json(?)) WHERE id = ?",
    ).run(
      JSON.stringify([{ role: 'char', data: 'Stale embedded transcript', chatId: 'stale-message' }]),
      JSON.stringify({ summaries: ['Stale embedded memory'] }),
      target.chatId,
    )
    const storedBefore = db.prepare('SELECT data_json FROM chats WHERE id = ?').get(target.chatId)
    const broad = record(loadPersistedForAssembly(db, directory, target.chatId).database)
    const loaded = record(loadPersistedForGenerationAssembly(db, directory, target).database)
    const selectedChat = records(records(loaded.characters)[0].chats)[0]
    expect(selectedChat).toEqual(records(records(broad.characters)[0].chats)[0])
    expect(selectedChat.message).toEqual([
      { role: 'user', data: 'Message 0', chatId: 'message-0' },
      { role: 'char', data: 'Message 1', chatId: 'message-1' },
      { role: 'user', data: 'Message 2', chatId: 'message-2' },
      { role: 'char', data: 'Message 3', chatId: 'message-3' },
    ])
    expect(selectedChat.hypaV3Data).toEqual({ summaries: ['Stored memory'] })
    expect(db.prepare('SELECT data_json FROM chats WHERE id = ?').get(target.chatId)).toEqual(storedBefore)
    expect(records(loaded.hypaV3Presets).map((preset) => preset.id)).toEqual(['selected-hypa'])
    expect(loaded.hypaV3PresetId).toBe(0)
    const preflight = observed(db, () => loadPersistedForGenerationPreflight(db, directory, target))
    expect(preflight.calls.some(({ sql }) => /SELECT data_json FROM hypa_v3_presets/i.test(sql))).toBe(false)
  })

  it('loads root template cards only for the exact default scaffold with an absent own body', () => {
    const rootTemplate = [{ type: 'plain', type2: 'main', role: 'system', text: 'Root template' }]
    const ownedTemplate = [{ type: 'plain', type2: 'main', role: 'system', text: 'Owned template' }]
    for (const source of ['table', 'embedded'] as const) {
      for (const selected of [
        { id: 'default-prompt-preset', name: 'Default Prompt' },
        { id: 'default-prompt-preset', name: 'Default Prompt', promptTemplate: null },
        { id: 'default-prompt-preset', name: 'Default Prompt', promptTemplate: [] },
        { id: 'default-prompt-preset', name: 'Default Prompt', promptTemplate: ownedTemplate },
        { id: 'nondefault-prompt-preset', name: 'Default Prompt' },
        { id: 'default-prompt-preset', name: 'Renamed default' },
      ]) {
        const database = fixture()
        database.promptPresets = [selected]
        database.promptTemplate = rootTemplate
        records(records(database.characters)[0].chats)[0].generationSettings = {
          ...settings,
          promptPresetId: selected.id,
        }
        const { db, directory } = openFixture(database)
        if (source === 'embedded') {
          db.exec('DELETE FROM prompt_templates')
          const storedSettings = JSON.parse(
            String(db.prepare('SELECT data_json FROM settings WHERE id = 1').get()?.data_json),
          )
          db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(
            JSON.stringify({ ...storedSettings, promptTemplate: rootTemplate }),
          )
        }
        const broad = record(loadPersistedForAssembly(db, directory, target.chatId).database)
        const observedAssembly = observed(db, () => loadPersistedForGenerationAssembly(db, directory, target))
        const loaded = record(observedAssembly.result.database)
        expect(loaded.promptTemplate).toEqual(broad.promptTemplate)
        // The default scaffold's global compatibility resolver can use root
        // cards; an explicit chat owner still has the exact modern semantics.
        expect(resolveEffectivePromptTemplate(loaded)).toEqual(resolveEffectivePromptTemplate(broad))
        expect(resolveEffectivePromptTemplate(loaded, { chatPromptPresetId: selected.id })).toEqual(
          resolveEffectivePromptTemplate(broad, { chatPromptPresetId: selected.id }),
        )
        const needsRoot =
          selected.id === 'default-prompt-preset' &&
          selected.name === 'Default Prompt' &&
          !('promptTemplate' in selected)
        expect(observedAssembly.calls.some(({ sql }) => /SELECT data_json FROM prompt_templates/i.test(sql))).toBe(
          needsRoot,
        )
        const preflight = record(loadPersistedForGenerationPreflight(db, directory, target).preflightInputs?.database)
        expect(preflight.promptTemplate).toEqual(broad.promptTemplate)
      }
    }
  })

  it('preserves explicit Hypa legacy repair while normal reads never resurrect numeric-only or invalid stable selection', () => {
    const database = fixture()
    database.hypaV3Presets = [
      { id: 'first-hypa', name: 'First', settings: {} },
      { id: 'selected-hypa', name: 'Selected', settings: { memoryTokensRatio: 0.2 } },
    ]
    database.hypaV3PresetId = 1
    const { db, directory } = openFixture(database)
    let narrow = record(loadPersistedForGenerationAssembly(db, directory, target).database)
    let broad = record(loadPersistedForAssembly(db, directory, target.chatId).database)
    expect(narrow.hypaV3PresetId).toBe(-1)
    expect(narrow.hypaV3PresetId).toBe(broad.hypaV3PresetId)
    expect(narrow.hypaV3Presets).toEqual([])

    expect(repairPersistedHypaV3PresetSelectionIdentityInSqlite(db)).toBe(true)
    narrow = record(loadPersistedForGenerationAssembly(db, directory, target).database)
    expect(narrow.selectedHypaV3PresetId).toBe('selected-hypa')
    expect(narrow.hypaV3PresetId).toBe(0)
    expect(records(narrow.hypaV3Presets).map((preset) => preset.id)).toEqual(['selected-hypa'])

    db.prepare(
      "UPDATE settings SET data_json = json_set(data_json, '$.selectedHypaV3PresetId', ?, '$.hypaV3PresetId', 1) WHERE id = 1",
    ).run('missing')
    narrow = record(loadPersistedForGenerationAssembly(db, directory, target).database)
    broad = record(loadPersistedForAssembly(db, directory, target.chatId).database)
    expect(narrow.hypaV3PresetId).toBe(broad.hypaV3PresetId)
    expect(narrow.hypaV3PresetId).toBe(-1)
    expect(narrow.hypaV3Presets).toEqual([])
  })

  it('names embedded-character fallback, seeds speaker names, and never hydrates preflight transcripts', () => {
    const database = fixture(1)
    const messages = records(records(records(database.characters)[0].chats)[0].message)
    messages[1].saying = 'character-0'
    messages[3].saying = target.characterId
    const { db, directory } = openFixture(database)
    db.exec('DELETE FROM characters')
    db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(database))
    const preflight = observed(db, () => loadPersistedForGenerationPreflight(db, directory, target))
    expect(preflight.result).toMatchObject({ generationScope: 'legacy', generationLegacyReason: 'embedded-characters' })
    expect(preflight.calls.some(({ sql }) => /\b(?:messages|chat_hypa_v3|assets)\b/i.test(sql))).toBe(false)
    expect(preflight.result.preflightInputs?.currentChat).not.toHaveProperty('message')
    const assembly = loadPersistedForGenerationAssembly(db, directory, target)
    expect(assembly).toMatchObject({
      generationScope: 'legacy',
      generationLegacyReason: 'embedded-characters',
      speakerNames: { 'target-character': 'Target', 'character-0': 'Sibling 0' },
    })
    expect(records(record(assembly.database).characters)).toHaveLength(1)
    expect(records(records(record(assembly.database).characters)[0].chats)).toHaveLength(1)
  })

  it('defers missing database, selected owner and mismatched chat ownership without broad fallback', () => {
    const { db, directory } = openFixture(fixture(1))
    for (const { selection, missingTarget } of [
      { selection: { ...target, chatId: 'missing' }, missingTarget: 'chat' },
      { selection: { ...target, characterId: 'missing' }, missingTarget: 'character' },
      { selection: { ...target, characterId: 'character-0' }, missingTarget: 'chat' },
    ]) {
      expect(loadPersistedForGenerationPreflight(db, directory, selection)).toEqual({
        generationScope: 'selected',
        preflightInputs: null,
        missingTarget,
      })
      expect(loadPersistedForGenerationAssembly(db, directory, selection).database).toBeNull()
    }
    db.exec('DELETE FROM settings')
    expect(loadPersistedForGenerationPreflight(db, directory, target)).toEqual({
      generationScope: 'selected',
      preflightInputs: null,
      missingTarget: 'database',
    })
  })

  it('distinguishes missing owners in embedded legacy state without borrowing another character chat', () => {
    const database = fixture(1)
    const { db, directory } = openFixture(database)
    db.exec('DELETE FROM characters')
    db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(database))
    for (const { selection, missingTarget } of [
      { selection: { ...target, characterId: 'missing' }, missingTarget: 'character' },
      { selection: { ...target, chatId: 'missing' }, missingTarget: 'chat' },
      { selection: { ...target, characterId: 'character-0' }, missingTarget: 'chat' },
    ]) {
      expect(loadPersistedForGenerationPreflight(db, directory, selection)).toEqual({
        generationScope: 'legacy',
        generationLegacyReason: 'embedded-characters',
        preflightInputs: null,
        missingTarget,
      })
    }
  })

  it('keeps modern ownership authoritative over embedded data and rejects mismatched stored identities', () => {
    const database = fixture(1)
    const { db, directory } = openFixture(database)
    const embedded = fixture()
    records(embedded.characters)[0].chaId = 'character-0'
    db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(embedded))
    expect(loadPersistedForGenerationPreflight(db, directory, { ...target, characterId: 'character-0' })).toEqual({
      generationScope: 'selected',
      preflightInputs: null,
      missingTarget: 'chat',
    })
    db.prepare("UPDATE chats SET data_json = json_set(data_json, '$.id', ?) WHERE id = ?").run(
      'wrong-chat',
      target.chatId,
    )
    expect(loadPersistedForGenerationPreflight(db, directory, target).missingTarget).toBe('chat')
    db.prepare("UPDATE characters SET data_json = json_set(data_json, '$.chaId', ?) WHERE id = ?").run(
      'wrong-character',
      target.characterId,
    )
    expect(loadPersistedForGenerationPreflight(db, directory, target).missingTarget).toBe('character')
  })

  it('does not read sibling speaker names when the target has no saying IDs', () => {
    const { db, directory } = openFixture(fixture(3))
    const loaded = observed(db, () => loadPersistedForGenerationAssembly(db, directory, target))
    expect(loaded.result.speakerNames).toBeUndefined()
    expect(loaded.calls.some(({ sql }) => sql.includes("json_extract(data_json, '$.name') AS name"))).toBe(false)
  })

  it('captures referenced speaker names and explicit misses before later character edits', () => {
    const database = fixture(3)
    const chat = records(records(database.characters)[0].chats)[0]
    chat.message = [
      { role: 'char', data: 'First', saying: 'character-1', chatId: 'speaker-1' },
      { role: 'char', data: 'Again', saying: 'character-1', chatId: 'speaker-2' },
      { role: 'char', data: 'Missing', saying: 'missing', chatId: 'speaker-3' },
      { role: 'char', data: 'Named', saying: 'character-2', name: 'Override', chatId: 'speaker-4' },
      { role: 'user', data: 'User', saying: 'character-0', chatId: 'speaker-5' },
    ]
    const { db, directory } = openFixture(database)
    const assembly = observed(db, () => loadPersistedForGenerationAssembly(db, directory, target))
    expect(assembly.result.speakerNames).toEqual({
      'character-0': 'Sibling 0',
      'character-1': 'Sibling 1',
      'character-2': 'Sibling 2',
      missing: undefined,
    })
    expect(Object.prototype.hasOwnProperty.call(assembly.result.speakerNames, 'missing')).toBe(true)
    const speakerReads = assembly.calls.filter(({ sql }) => sql.includes("json_extract(data_json, '$.name') AS name"))
    expect(speakerReads).toHaveLength(1)
    expect(speakerReads[0].rows).toBe(3)
    db.prepare("UPDATE characters SET data_json = json_set(data_json, '$.name', ?) WHERE id = ?").run(
      'New name',
      'character-1',
    )
    expect(assembly.result.speakerNames?.['character-1']).toBe('Sibling 1')
  })
})

describe('generation collection identity indexes', () => {
  it('are idempotent derived schema and preserve duplicate IDs without revision changes', () => {
    const { db } = openFixture()
    const before = getSchemaState(db)
    createCollectionTables(db)
    createCollectionTables(db)
    expect(getSchemaState(db)).toEqual(before)
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_generation_%' ORDER BY name")
      .all()
      .map((row) => row.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'idx_generation_modules_id',
        'idx_generation_modules_namespace',
        'idx_generation_model_presets_id',
        'idx_generation_prompt_presets_id',
        'idx_generation_personas_id',
        'idx_generation_hypa_v3_presets_id',
      ]),
    )
    writeSingleCollectionTable(db, 'promptPresets', [{ id: 'duplicate' }, { id: 'duplicate' }])
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM prompt_presets WHERE json_extract(data_json, '$.id') = ?")
        .get('duplicate')?.count,
    ).toBe(2)
  })

  it('uses expression indexes for selected IDs and module ID/namespace union queries', () => {
    const { db } = openFixture(fixture(48))
    for (const table of ['model_presets', 'prompt_presets', 'personas', 'hypa_v3_presets']) {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT data_json FROM ${table} WHERE json_extract(data_json, '$.id') = ? ORDER BY position LIMIT ?`,
        )
        .all('selected', 2)
      expect(plan.map((row) => row.detail).join('\n')).toContain(`USING INDEX idx_generation_${table}_id`)
    }
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT data_json FROM modules
      WHERE json_extract(data_json, '$.id') IN (SELECT value FROM json_each(?))
        OR json_extract(data_json, '$.namespace') IN (SELECT value FROM json_each(?)) ORDER BY position`,
      )
      .all('["selected"]', '["namespace"]')
    const details = plan.map((row) => row.detail).join('\n')
    expect(details).toContain('USING INDEX idx_generation_modules_id')
    expect(details).toContain('USING INDEX idx_generation_modules_namespace')
    expect(details).not.toContain('SCAN modules')
  })
})
