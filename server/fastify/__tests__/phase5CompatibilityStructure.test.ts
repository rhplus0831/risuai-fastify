import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  MODEL_PRESET_FIELDS,
  PROMPT_PRESET_FIELDS,
  PROMPT_PRESET_MODEL_OVERRIDE_FIELDS,
  databaseKeyForModelPresetField,
} from '@risuai/shared-core/preset-split'
import { SERVER_SETTINGS_GROUP_BY_KEY, SERVER_SETTINGS_KEYS_BY_GROUP } from '@risuai/shared-core/settings-groups'
import { LEGACY_BOT_PRESET_APPLY_DATABASE_FIELDS } from '../src/commands/presets.js'
import { createInitialDatabase, normalizeDatabaseDefaults } from '../src/databaseDefaults.js'
import { COLLECTION_FIELDS } from '../src/repository.js'
import {
  READABLE_SETTINGS_GROUPS,
  SETTINGS_GROUP_KEYS,
  SETTINGS_GROUPS,
  type ReadableSettingsGroup,
} from '../src/routes/commands.js'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** Settings persisted in the settings row but edited by a dedicated command family. */
const DEDICATED_COMMAND_DATABASE_FIELDS = [
  'agentPresetDefaultId',
  'agentPresets',
  'agents',
  'botPresetsId',
  'characterOrder',
  'loreBookPage',
  'modelPresetsId',
  'personaPrompt',
  'promptPresetsId',
  'selectedPersona',
  'selectedPersonaId',
  'translatorPresetId',
  'userIcon',
  'userNote',
] as const

/** Settings whose effective value is derived while a legacy/split preset is applied. */
const PRESET_DERIVED_DATABASE_FIELDS = [
  'autoSuggestClean',
  'autoSuggestPrefix',
  'dynamicOutput',
  'groupOtherBotRole',
  'groupTemplate',
  'localNetworkMode',
  'localNetworkTimeoutSec',
] as const

/** Imported legacy settings retained outside generic writes for whole-state round trips. */
const RETAINED_ROUND_TRIP_DATABASE_FIELDS = [
  'agentContextEnabled',
  'agentContextMaxOutput',
  'agentContextMaxToolRounds',
  'agentContextPrompt',
  'antiServerOverloads',
  'cipherChat',
  'claudeBatching',
  'claudeRetrivalCaching',
  'disableAprilFools',
  'emotionPrompt',
  'forceProxyAsOpenAI',
  'formatversion',
  'geminiStream',
  'googleClaudeTokenizing',
  'hubServerType',
  'hypaV3Settings',
  'igpPrompt', // Also read by the retained completion-effect runtime.
  'lastPatchNoteCheckVersion',
  'pluginV2',
  'removePunctuationHypa',
  'saveTime',
  'statics',
  'supaMemoryKey',
] as const

type AuthoringCollectionOwner = {
  table: string
  commandPathPrefix: string
  phaseOwner: 'settings-authoring' | 'extensions' | 'memory'
}

/**
 * Every repository collection chooses an authoritative SQLite table, a command
 * owner, and the phase that owns its deeper behavior. This prevents a new
 * authoring collection from silently falling back to whole-database writes.
 */
const AUTHORING_COLLECTION_OWNERS: Record<(typeof COLLECTION_FIELDS)[number], AuthoringCollectionOwner> = {
  modules: {
    table: 'modules',
    commandPathPrefix: '/api/v1/commands/modules',
    phaseOwner: 'extensions',
  },
  plugins: {
    table: 'plugins',
    commandPathPrefix: '/api/v1/commands/plugins',
    phaseOwner: 'extensions',
  },
  modelPresets: {
    table: 'model_presets',
    commandPathPrefix: '/api/v1/commands/model-presets',
    phaseOwner: 'settings-authoring',
  },
  promptPresets: {
    table: 'prompt_presets',
    commandPathPrefix: '/api/v1/commands/prompt-presets',
    phaseOwner: 'settings-authoring',
  },
  botPresets: {
    table: 'bot_presets',
    commandPathPrefix: '/api/v1/commands/presets',
    phaseOwner: 'settings-authoring',
  },
  promptTemplate: {
    table: 'prompt_templates',
    commandPathPrefix: '/api/v1/commands/prompt-items',
    phaseOwner: 'settings-authoring',
  },
  personas: {
    table: 'personas',
    commandPathPrefix: '/api/v1/commands/personas',
    phaseOwner: 'settings-authoring',
  },
  loadouts: {
    table: 'loadouts',
    commandPathPrefix: '/api/v1/commands/loadouts',
    phaseOwner: 'settings-authoring',
  },
  loreBook: {
    table: 'lore_books',
    commandPathPrefix: '/api/v1/commands/lorebooks',
    phaseOwner: 'settings-authoring',
  },
  translatorPresets: {
    table: 'translator_presets',
    commandPathPrefix: '/api/v1/commands/translator-presets',
    phaseOwner: 'settings-authoring',
  },
  hypaV3Presets: {
    table: 'hypa_v3_presets',
    commandPathPrefix: '/api/v1/commands/settings/:group',
    phaseOwner: 'memory',
  },
}

const DERIVED_READ_ONLY_SETTINGS_GROUPS: Record<'agents' | 'models', readonly string[]> = {
  agents: ['agents', 'agentPresets', 'agentPresetDefaultId'],
  models: ['providerCredentials', 'modelProfiles', 'modelProfileOrder', 'modelRoleProfiles', 'modelRuntimeDefaults'],
}

/**
 * These imported keys are deliberately not current settings controls. Some
 * retain a generic persistence owner; the rest are opaque round-trip data.
 */
const LEGACY_NO_CONTROL_SETTINGS: Record<string, string | null> = {
  antiServerOverloads: null,
  claudeBatching: null,
  claudeRetrivalCaching: null,
  coldstorage: 'advanced',
  enableRemoteSaving: 'advanced',
  forceProxyAsOpenAI: null,
  googleClaudeTokenizing: null,
  localNetworkMode: null,
  localNetworkTimeoutSec: null,
  presetChain: 'advanced',
  realmDirectOpen: 'advanced',
  removePunctuationHypa: null,
  showPromptComparison: 'display',
}

/** Retained defaults whose absence would change first-run or legacy behavior. */
const RETAINED_INITIAL_DEFAULTS: Record<string, unknown> = {
  applyAdditionalParamsToAll: false,
  autoTranslateNotificationDeferCapSeconds: 180,
  chatLoadAdditionalPages: 15,
  chatLoadInitialPages: 30,
  chatScreenWidth: 900,
  floatingChatInput: true,
  keepSessionAlive: 'off',
  openAIFlexProcessing: false,
  paragraphBreakBySentences: false,
  paragraphBreakSentenceCount: 3,
  reducedMotion: false,
  showGlobalLorebookAndRegex: false,
  showSavingIcon: true,
  useMonacoEditorOnDesktop: false,
  useMonacoEditorOnMobile: false,
}

/** Missing is semantic for these optional compatibility settings. */
const RETAINED_OMITTED_DEFAULTS: Record<string, unknown> = {
  hanuraiEnable: true,
  hypaMemory: true,
  hypav2: true,
  legacyMemoryMigrationNoticeDismissed: true,
  memoryAlgorithmType: 'legacy',
  promptTemplate: [],
  supaModelType: 'legacy',
}

describe('Phase 5 compatibility structure', () => {
  it('keeps ordinary module and lorebook commands off repair-permissive loaders', () => {
    const commandSource = readRepoFile('server/fastify/src/routes/commands.ts')
    const moduleCommandBlock = commandSource.slice(
      commandSource.indexOf("app.post('/api/v1/commands/modules'"),
      commandSource.indexOf("app.post('/api/v1/commands/plugins'"),
    )
    const lorebookCommandSource = readRepoFile('server/fastify/src/commands/lorebooks.ts')

    expect(commandSource).not.toContain('ensureGlobalLorebookCollection')
    expect(commandSource).not.toContain('repairLorebookEntries')
    expect(moduleCommandBlock).not.toContain('ensureModuleCommandDatabase')
    expect(moduleCommandBlock).not.toContain('ensureModuleRecords')
    expect(moduleCommandBlock).toContain('readStrictModuleRecords')
    expect(lorebookCommandSource).toContain('validateStoredLorebookEntries(character.globalLore')
    expect(lorebookCommandSource).toContain('validateStoredLorebookEntries(chat.localLore')
  })

  it('classifies every Database field under settings, collection, character, or derived command ownership', () => {
    const databaseFields = databaseFieldNames()
    const collectionFields = new Set<string>(COLLECTION_FIELDS)
    const genericSettings = SETTINGS_GROUPS.flatMap((group) => SETTINGS_GROUP_KEYS[group]).filter(
      (field) => !collectionFields.has(field),
    )
    const classified = [
      'characters',
      'pluginCustomStorage',
      ...COLLECTION_FIELDS,
      ...genericSettings,
      ...DEDICATED_COMMAND_DATABASE_FIELDS,
      ...PRESET_DERIVED_DATABASE_FIELDS,
      ...RETAINED_ROUND_TRIP_DATABASE_FIELDS,
    ]

    expect(new Set(databaseFields).size).toBe(databaseFields.length)
    expect(new Set(classified).size, duplicateValues(classified).join(', ')).toBe(classified.length)
    expect([...classified].sort()).toEqual([...databaseFields].sort())
  })

  it('keeps every readable and writable settings group exact, unique, and owned on both sides', () => {
    const databaseFields = new Set(databaseFieldNames())
    const writableOwners = new Map<string, string[]>()

    for (const group of READABLE_SETTINGS_GROUPS) {
      const serverReadableKeys = [
        ...SETTINGS_GROUP_KEYS[group],
        ...(group === 'language' ? ['translatorPresetId'] : []),
        ...(group === 'advanced' ? ['igpPrompt'] : []),
      ]
      const browserReadableKeys = SERVER_SETTINGS_KEYS_BY_GROUP[group]
      expect(new Set(serverReadableKeys).size, `${group} server duplicates`).toBe(serverReadableKeys.length)
      expect(new Set(browserReadableKeys).size, `${group} browser duplicates`).toBe(browserReadableKeys.length)
      expect([...browserReadableKeys].sort(), `${group} readable projection`).toEqual([...serverReadableKeys].sort())
      expect(
        serverReadableKeys.filter((key) => !databaseFields.has(key)),
        `${group} unowned Database keys`,
      ).toEqual([])
    }

    for (const group of SETTINGS_GROUPS) {
      for (const key of SETTINGS_GROUP_KEYS[group]) {
        writableOwners.set(key, [...(writableOwners.get(key) ?? []), group])
      }
    }
    expect([...writableOwners.entries()].filter(([, owners]) => owners.length !== 1)).toEqual([])
    expect(Object.fromEntries([...writableOwners].map(([key, [owner]]) => [key, owner]))).toEqual(
      SERVER_SETTINGS_GROUP_BY_KEY,
    )

    for (const [group, keys] of Object.entries(DERIVED_READ_ONLY_SETTINGS_GROUPS)) {
      expect(SETTINGS_GROUPS).not.toContain(group)
      expect(SETTINGS_GROUP_KEYS[group as ReadableSettingsGroup]).toEqual(keys)
    }
  })

  it('pins every preset and authoring collection to a command family and SQLite owner', () => {
    const commandSource = readRepoFile('server/fastify/src/routes/commands.ts')
    const repositorySource = readRepoFile('server/fastify/src/repository.ts')
    const commandPaths = [...commandSource.matchAll(/app\.(?:post|put|patch|delete)\('([^']+)'/g)].map(
      (match) => match[1],
    )

    expect(Object.keys(AUTHORING_COLLECTION_OWNERS).sort()).toEqual([...COLLECTION_FIELDS].sort())
    for (const [field, owner] of Object.entries(AUTHORING_COLLECTION_OWNERS)) {
      expect(
        commandPaths.some((route) => route.startsWith(owner.commandPathPrefix)),
        `${field} command owner`,
      ).toBe(true)
      expect(repositorySource, `${field} persistence owner`).toContain(`${field}: '${owner.table}'`)
    }

    expect(commandPaths.some((route) => route.startsWith('/api/v1/commands/characters'))).toBe(true)
    expect(commandPaths.some((route) => route.startsWith('/api/v1/commands/agents'))).toBe(true)
    expect(commandPaths.some((route) => route.startsWith('/api/v1/commands/agent-presets'))).toBe(true)
    expect(repositorySource).toContain('CREATE TABLE IF NOT EXISTS characters')
    expect(repositorySource).toContain('export function writeSingleCharacterRow')
    expect(repositorySource).toContain('CREATE TABLE IF NOT EXISTS plugin_custom_storage')
    expect(repositorySource).toContain('export function writePluginStorageKey')
  })

  it('keeps legacy, model, and prompt preset field catalogs closed over Database owners', () => {
    const databaseFields = new Set(databaseFieldNames())
    const modelDatabaseFields = MODEL_PRESET_FIELDS.map(databaseKeyForModelPresetField)
    const promptDirectFields = PROMPT_PRESET_FIELDS.filter((field) => field !== 'regex' && field !== 'presetRegex')
    const promptOverrideDatabaseFields = PROMPT_PRESET_MODEL_OVERRIDE_FIELDS.map(databaseKeyForModelPresetField)

    for (const [label, fields] of Object.entries({
      legacy: LEGACY_BOT_PRESET_APPLY_DATABASE_FIELDS,
      model: modelDatabaseFields,
      prompt: [...promptDirectFields, 'presetRegex'],
      promptOverride: promptOverrideDatabaseFields,
    })) {
      expect(new Set(fields).size, `${label} duplicate fields`).toBe(fields.length)
      expect(
        fields.filter((field) => !databaseFields.has(field)),
        `${label} unowned fields`,
      ).toEqual([])
    }

    expect(MODEL_PRESET_FIELDS).toContain('additionalParams')
    expect(LEGACY_BOT_PRESET_APPLY_DATABASE_FIELDS).toContain('additionalParams')
    expect(PROMPT_PRESET_FIELDS).toEqual(expect.arrayContaining(['regex', 'presetRegex']))
  })

  it('pins retained defaults and preserves semantic omission for optional legacy settings', () => {
    const initial = createInitialDatabase()
    expect(initial).toMatchObject(RETAINED_INITIAL_DEFAULTS)
    expect(initial).not.toHaveProperty('agentPresetDefaultId')
    expect(
      normalizeDatabaseDefaults(
        {
          agentPresets: [{ id: 'preset-a', name: 'Preset A' }],
          agentPresetDefaultId: 'preset-a',
        },
        { providerDefaults: false },
      ).agentPresetDefaultId,
    ).toBe('preset-a')

    for (const [key, sentinel] of Object.entries(RETAINED_OMITTED_DEFAULTS)) {
      expect(initial, `${key} must remain absent by default`).not.toHaveProperty(key)
      expect(normalizeDatabaseDefaults({ [key]: sentinel }, { providerDefaults: false })[key]).toEqual(sentinel)
    }

    expect(normalizeDatabaseDefaults({ keepSessionAlive: 'pip' }, { providerDefaults: false }).keepSessionAlive).toBe(
      'sound',
    )
  })

  it('keeps documented legacy/no-control settings explicit and absent from current row definitions', () => {
    const databaseFields = new Set(databaseFieldNames())
    const settingDefinitionSource = readProductionSources('src/ts/setting')

    for (const [key, expectedGroup] of Object.entries(LEGACY_NO_CONTROL_SETTINGS)) {
      expect(databaseFields.has(key), `${key} retained compatibility shape`).toBe(true)
      expect(SERVER_SETTINGS_GROUP_BY_KEY[key] ?? null, `${key} persistence class`).toBe(expectedGroup)
      expect(settingDefinitionSource, `${key} must not regain a settings control`).not.toMatch(
        new RegExp(`bindKey\\s*:\\s*['\"]${escapeRegExp(key)}['\"]`),
      )
    }
  })
})

function databaseFieldNames(): string[] {
  const source = readRepoFile('src/ts/storage/database.svelte.ts')
  const parsed = ts.createSourceFile('database.svelte.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const database = parsed.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === 'Database',
  )
  expect(database).toBeDefined()
  return database!.members.flatMap((member) => {
    if (!ts.isPropertySignature(member) || member.name === undefined) return []
    return ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? [member.name.text] : []
  })
}

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function readProductionSources(relativeDirectory: string): string {
  const root = path.join(REPO_ROOT, relativeDirectory)
  const visit = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) return visit(absolute)
      if ((!entry.name.endsWith('.ts') && !entry.name.endsWith('.svelte')) || entry.name.includes('.test.')) return []
      return [readFileSync(absolute, 'utf8')]
    })
  return visit(root).join('\n')
}

function duplicateValues(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) !== index)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
