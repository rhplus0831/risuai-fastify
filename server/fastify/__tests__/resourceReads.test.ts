import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { COLLECTION_FIELDS } from '../src/repository.js'
import { MASKED_PROVIDER_SECRET } from '../src/providerSecrets.js'
import { setupAuthedClient } from './helpers/auth.js'
import { PROMPT_SETTINGS_KEYS } from '@risuai/shared-core/prompt-settings'
import { BULK_RESOURCE_MAX_BODY_BYTES, BULK_RESOURCE_MAX_IDS } from '../src/routes/resourceReads.js'
import { applyMigrations } from '../src/db.js'
import { addAlternateMessage, replaceChatMessages } from '../src/messageStore.js'
import {
  SERVER_CHARACTER_SUMMARY_KEYS,
  SERVER_CHARACTER_SUMMARY_VERSION,
  isServerCharactersSummaryPayload,
} from '@risuai/protocol/character-summary-resource'
import {
  SERVER_SHELL_PAYLOAD_KEYS,
  SERVER_SHELL_PROTOCOL_VERSION,
  SERVER_SHELL_SETTINGS_KEYS,
  isServerShellPayload,
} from '@risuai/protocol/shell-resource'

interface Harness {
  app: FastifyInstance
  dataDir: string
}

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-resource-reads-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 2 * 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    memoryWorker: false,
    assetGc: false,
  })
  return { app, dataDir }
}

let harness: Harness
let assertion: string
let revision: number

function readAllDatabaseRows(): Record<string, unknown[]> {
  const sqlite = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
  try {
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string
    }>
    return Object.fromEntries(
      tables.map(({ name }) => [name, sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as unknown[]]),
    )
  } finally {
    sqlite.close()
  }
}

beforeEach(async () => {
  harness = await startHarness()
  ;({ assertion } = await setupAuthedClient(harness.app))
  const imported = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion },
    payload: {
      database: {
        currentChar: 0,
        characterOrder: ['char-a', 'char-b'],
        selectedPersona: 0,
        personaPrompt: 'Persona prompt',
        mainPrompt: 'Main prompt',
        jailbreak: 'Jailbreak prompt',
        globalNote: 'Global note',
        formatingOrder: ['main', 'jailbreak', 'globalNote'],
        promptPreprocess: true,
        presetRegex: [],
        promptSettings: { sendName: true },
        jsonSchemaEnabled: true,
        jsonSchema: '{"type":"object"}',
        strictJsonSchema: true,
        extractJson: 'value',
        customPromptTemplateToggle: 'custom',
        templateDefaultVariables: 'name=value',
        OAIPrediction: 'prediction',
        autoSuggestPrompt: 'suggestion',
        systemContentReplacement: 'system: {{slot}}',
        systemRoleReplacement: 'user',
        outputImageModal: true,
        fallbackModels: { model: ['fallback-main'] },
        fallbackWhenBlankResponse: true,
        doNotChangeFallbackModels: true,
        enableLorebookStubs: true,
        localNetworkMode: true,
        localNetworkTimeoutSec: 45,
        openAIKey: 'root-secret',
        providerCredentials: [
          { id: 'credential-api', name: 'API', type: 'apiKey', apiKey: 'profile-secret' },
          {
            id: 'credential-vertex',
            name: 'Vertex',
            type: 'vertexServiceAccount',
            vertex: { clientEmail: 'vertex@example.com', privateKey: 'vertex-secret' },
          },
        ],
        modelProfiles: [
          {
            id: 'profile-a',
            name: 'Profile A',
            providerId: 'vertex',
            modelId: 'model-a',
            providerOptions: {
              credentialId: 'credential-vertex',
              vertex: {
                projectId: 'project-a',
              },
            },
          },
        ],
        modelProfileOrder: [{ kind: 'profile', profileId: 'profile-a' }],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'profile-a' } },
        modelRuntimeDefaults: { maxContext: 8_192 },
        enabledModules: ['module-a'],
        modules: [{ id: 'module-a', name: 'Module A', cjs: 'module.exports = true' }],
        plugins: [{ name: 'plugin-a', displayName: 'Plugin A', script: 'Risuai.log("plugin")', version: '3.0' }],
        modelPresets: [{ id: 'model-a', name: 'Model A', openAIKey: 'model-secret' }],
        promptPresets: [
          {
            id: 'prompt-a',
            name: 'Prompt A',
            promptTemplate: [{ id: 'prompt-item-a', type: 'plain', text: 'Prompt text', role: 'system' }],
          },
          { id: 'prompt-empty', name: 'Prompt Empty' },
        ],
        botPresets: [
          {
            id: 'legacy-a',
            name: 'Legacy A',
            image: 'legacy-a.png',
            metadata: { source: 'test' },
            customPromptTemplateToggle: 'mode=Mode=select=warm,cold',
            moduleIntergration: 'legacy-module-space',
            openAIKey: 'legacy-secret',
            temperature: 0.7,
            mainPrompt: 'Large legacy body'.repeat(2_000),
            promptTemplate: [{ id: 'legacy-prompt', type: 'plain', text: 'Legacy prompt body' }],
          },
        ],
        promptTemplate: [{ id: 'root-prompt', type: 'plain', text: 'Root prompt', role: 'system' }],
        personas: [{ id: 'persona-a', name: 'Persona A' }],
        agentPresets: [{ id: 'agent-a', name: 'Agent A', enabled: true, version: 1, steps: [] }],
        agentPresetDefaultId: 'agent-a',
        loadouts: [{ id: 'loadout-a', name: 'Loadout A' }],
        loreBook: [{ id: 'lorebook-a', name: 'Lorebook A', data: [] }],
        translatorPresets: [{ id: 'translator-a', name: 'Translator A' }],
        hypaV3Settings: { summarizationPrompt: 'stale flat prompt' },
        supaMemoryKey: 'stale-flat-key',
        hypaV3Presets: [{ id: 'hypa-a', name: 'Hypa A' }],
        pluginCustomStorage: { 'plugin-a:state': { enabled: true } },
        characters: [
          {
            chaId: 'char-a',
            name: 'Ada',
            displayName: 'Ada Lovelace',
            image: 'asset://ada',
            creatorNotes: '# `en`\nFirst programmer',
            trashTime: null,
            creation_date: 1,
            modification_date: 2,
            lastInteraction: 123,
            chatPage: 0,
            desc: 'Full character detail',
            oaiTTSConfig: { apiKey: 'tts-secret' },
            globalLore: [{ key: ['Ada'], content: 'Character lore' }],
            chats: [
              {
                id: 'chat-a',
                name: 'Chat A',
                pinned: true,
                message: [
                  { uid: 'message-a', role: 'user', data: 'one' },
                  { uid: 'message-b', role: 'char', data: 'two' },
                ],
                hypaV3Data: { mainChunks: [{ text: 'summary' }] },
              },
            ],
          },
          {
            chaId: 'char-b',
            name: 'Bea',
            globalLore: [{ key: ['Bea'], content: 'Second lore' }],
            chats: [],
          },
        ],
      },
    },
  })
  expect(imported.statusCode).toBe(200)
  revision = imported.json().revision as number
})

afterEach(async () => {
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
})

function authHeaders(): Record<string, string> {
  return { 'risu-auth': assertion }
}

function jsonSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function cachePayload(hashes: Record<string, string[]>): Record<string, unknown> {
  return { cache: { version: 2, hashes } }
}

describe('authenticated resource read routes', () => {
  it('loads greeting translations with nullable legacy generation settings without rewriting them', async () => {
    const sqlite = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      const row = sqlite.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
      const settings = {
        ...JSON.parse(row.data_json),
        translatorPresetId: 'translator-a',
        translatorType: 'google',
        translator: 'en',
        dynamicOutput: null,
        thinkingTokens: null,
        promptSettings: null,
        reverseProxyOobaArgs: null,
        seperateModels: null,
        modelRuntimeDefaults: { dynamicOutput: null },
      }
      sqlite.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
    } finally {
      sqlite.close()
    }
    const before = readAllDatabaseRows()
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-a/greeting-translations?chatId=chat-a',
      headers: { 'risu-auth': assertion },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      characterId: 'char-a',
      chatId: 'chat-a',
      revision,
      settingsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      translations: [],
    })
    expect(readAllDatabaseRows()).toEqual(before)
  })

  it('loads greeting translations after migrating a legacy numeric translator selection', async () => {
    const sqlite = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      const row = sqlite.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
      const settings = {
        ...JSON.parse(row.data_json),
        translatorPresetId: 0,
        translatorType: 'google',
        translator: 'en',
      }
      sqlite.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
      sqlite.exec('UPDATE schema_version SET version = 36 WHERE id = 1')
      applyMigrations(sqlite, 36)
      expect(
        JSON.parse(
          (sqlite.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }).data_json,
        ).translatorPresetId,
      ).toBe('translator-a')
    } finally {
      sqlite.close()
    }
    const before = readAllDatabaseRows()
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-a/greeting-translations?chatId=chat-a',
      headers: { 'risu-auth': assertion },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      characterId: 'char-a',
      chatId: 'chat-a',
      revision,
      settingsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      translations: [],
    })
    expect(readAllDatabaseRows()).toEqual(before)
  })

  it.each([null, '', 0, 'missing-translator'])(
    'returns an unavailable greeting projection without repairing invalid translator selection %s on read',
    async (selection) => {
      const sqlite = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
      try {
        const row = sqlite.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
        const settings = { ...JSON.parse(row.data_json), translatorPresetId: selection, translatorType: 'google' }
        sqlite.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
      } finally {
        sqlite.close()
      }
      const before = readAllDatabaseRows()
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/characters/char-a/greeting-translations?chatId=chat-a',
        headers: { 'risu-auth': assertion },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        characterId: 'char-a',
        chatId: 'chat-a',
        revision,
        settingsHash: null,
        translations: [],
      })
      expect(readAllDatabaseRows()).toEqual(before)
    },
  )

  it('returns the exact versioned coherent shell projection', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/resources/shell',
      headers: authHeaders(),
    })

    expect(response.statusCode).toBe(200)
    const shell = response.json()
    expect(Object.keys(shell)).toEqual(SERVER_SHELL_PAYLOAD_KEYS)
    expect(shell.protocolVersion).toBe(SERVER_SHELL_PROTOCOL_VERSION)
    expect(shell.revision).toBe(revision)
    expect(Object.keys(shell.settings)).toEqual(SERVER_SHELL_SETTINGS_KEYS)
    expect(shell.characters).toMatchObject({
      version: SERVER_CHARACTER_SUMMARY_VERSION,
      revision,
      currentChar: 0,
      characterOrder: ['char-a', 'char-b'],
    })
    expect(isServerShellPayload(shell)).toBe(true)
    expect(Object.keys(shell.characters.characters[0])).toEqual(SERVER_CHARACTER_SUMMARY_KEYS)

    for (const forbidden of [
      'openAIKey',
      'providerCredentials',
      'modules',
      'plugins',
      'promptPresets',
      'botPresets',
      'personas',
    ]) {
      expect(shell.settings).not.toHaveProperty(forbidden)
    }
    expect(response.payload).not.toContain('root-secret')
    expect(response.payload).not.toContain('Large legacy body')
    expect(response.payload).not.toContain('Character lore')
    expect(response.payload).not.toContain('Large message')
  })

  it('normalizes missing, null, empty, malformed, and legacy shell settings before strict bootstrap validation', async () => {
    const sqlite = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      const row = sqlite.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
      const settings = JSON.parse(row.data_json) as Record<string, unknown>
      delete settings.language
      settings.username = null
      settings.customCSS = ''
      settings.keepSessionAlive = 'pip'
      settings.animationSpeed = 'fast'
      settings.colorScheme = {}
      settings.customTextTheme = { FontColorStandard: '#ffffff' }
      settings.doNotWarnExternalServers = 1
      settings.characterOrder = null
      settings.currentChar = 99
      sqlite.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
    } finally {
      sqlite.close()
    }

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/resources/shell',
      headers: authHeaders(),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().settings).toMatchObject({
      language: 'en',
      username: 'User',
      customCSS: '',
      keepSessionAlive: 'sound',
      animationSpeed: 0.4,
      colorScheme: expect.objectContaining({ type: 'dark' }),
      customTextTheme: expect.objectContaining({
        FontColorStandard: '#ffffff',
        FontColorBold: '#f8f8f2',
      }),
      doNotWarnExternalServers: false,
    })
    expect(response.json().characters).toMatchObject({ characterOrder: [], currentChar: -1 })
    expect(isServerShellPayload(response.json())).toBe(true)

    const fullSettings = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: authHeaders(),
    })
    expect(fullSettings.json().settings).toMatchObject({
      language: 'en',
      username: 'User',
      customCSS: '',
      keepSessionAlive: 'sound',
      animationSpeed: 0.4,
      colorScheme: expect.objectContaining({ type: 'dark' }),
      customTextTheme: expect.objectContaining({
        FontColorStandard: '#ffffff',
        FontColorBold: '#f8f8f2',
      }),
      doNotWarnExternalServers: false,
      characterOrder: [],
      currentChar: -1,
    })

    const languageGroup = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/language',
      headers: authHeaders(),
    })
    expect(languageGroup.json().settings.language).toBe('en')

    const advancedGroup = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/advanced',
      headers: authHeaders(),
    })
    expect(advancedGroup.json().settings.keepSessionAlive).toBe('sound')
  })

  it('returns one exact standalone setting projection', async () => {
    const stableSelection = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/resources/settings/selectedPersonaId',
      headers: authHeaders(),
    })
    expect(stableSelection.statusCode).toBe(200)
    expect(stableSelection.json()).toEqual({
      revision,
      setting: 'selectedPersonaId',
      state: { present: true, value: 'persona-a' },
    })

    const present = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/resources/settings/selectedPersona',
      headers: authHeaders(),
    })
    expect(present.statusCode).toBe(200)
    expect(present.json()).toEqual({
      revision,
      setting: 'selectedPersona',
      state: { present: true, value: 0 },
    })

    const defaulted = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/resources/settings/userNote',
      headers: authHeaders(),
    })
    expect(defaulted.statusCode).toBe(200)
    expect(defaulted.json()).toEqual({
      revision,
      setting: 'userNote',
      state: { present: true, value: '' },
    })

    const unknown = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/resources/settings/openAIKey',
      headers: authHeaders(),
    })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toMatchObject({ error: 'standalone_setting_not_found' })
  })

  it('returns settings without collection fields and masks provider secrets', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: authHeaders(),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      revision,
      settings: {
        currentChar: 0,
        characterOrder: ['char-a', 'char-b'],
        openAIKey: MASKED_PROVIDER_SECRET,
      },
    })
    expect(response.json().settings).not.toHaveProperty('characters')
    expect(response.json().settings).not.toHaveProperty('modules')
  })

  it('preserves configured IGP through the narrow advanced settings read used after writer transfer', async () => {
    const prompt = '<|im_start|>system<|im_sep|>Append the configured effect.<|im_end|>'
    const sqlite = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      const row = sqlite.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
      sqlite
        .prepare('UPDATE settings SET data_json = ? WHERE id = 1')
        .run(JSON.stringify({ ...JSON.parse(row.data_json), igpPrompt: prompt }))
    } finally {
      sqlite.close()
    }
    const before = readAllDatabaseRows()
    const full = await harness.app.inject({ method: 'GET', url: '/api/v1/settings', headers: authHeaders() })
    expect(full.statusCode).toBe(200)
    expect(full.json().settings.igpPrompt).toBe(prompt)
    const narrow = await harness.app.inject({ method: 'GET', url: '/api/v1/settings/advanced', headers: authHeaders() })
    expect(narrow.statusCode).toBe(200)
    expect(narrow.json().settings.igpPrompt).toBe(prompt)
    expect(readAllDatabaseRows()).toEqual(before)
  })

  it('returns an allowlisted, masked settings group without collection-owned memory presets', async () => {
    const providers = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/providers',
      headers: authHeaders(),
    })
    expect(providers.statusCode).toBe(200)
    expect(providers.json()).toMatchObject({
      revision,
      group: 'providers',
      settings: {
        openAIKey: MASKED_PROVIDER_SECRET,
        providerCredentials: [
          { id: 'credential-api', apiKey: MASKED_PROVIDER_SECRET },
          { id: 'credential-vertex', vertex: { privateKey: MASKED_PROVIDER_SECRET } },
        ],
        modelProfiles: [
          {
            id: 'profile-a',
            providerOptions: {
              credentialId: 'credential-vertex',
            },
          },
        ],
      },
    })
    expect(providers.json().settings).not.toHaveProperty('enableLorebookStubs')
    expect(providers.json().settings).not.toHaveProperty('hypaV3Presets')

    const memory = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/memory',
      headers: authHeaders(),
    })
    expect(memory.statusCode).toBe(200)
    expect(memory.json()).toMatchObject({ revision, group: 'memory' })
    expect(memory.json().settings).not.toHaveProperty('hypaV3Presets')
    expect(memory.json().settings).not.toHaveProperty('hypaV3Settings')
    expect(memory.json().settings).not.toHaveProperty('supaMemoryKey')

    const runtime = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/runtime',
      headers: authHeaders(),
    })
    expect(runtime.statusCode).toBe(200)
    expect(runtime.json().settings).not.toHaveProperty('localNetworkMode')
    expect(runtime.json().settings).not.toHaveProperty('localNetworkTimeoutSec')
    expect(runtime.json().settings).not.toHaveProperty('fallbackModels')
    expect(runtime.json().settings).not.toHaveProperty('fallbackWhenBlankResponse')
    expect(runtime.json().settings).not.toHaveProperty('doNotChangeFallbackModels')

    const language = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/language',
      headers: authHeaders(),
    })
    expect(language.statusCode).toBe(200)
    expect(language.json()).toMatchObject({
      revision,
      group: 'language',
      settings: { translatorPresetId: 'translator-a' },
    })

    const prompt = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/prompt',
      headers: authHeaders(),
    })
    expect(prompt.statusCode).toBe(200)
    expect(prompt.json()).toMatchObject({
      revision,
      group: 'prompt',
      settings: {
        mainPrompt: 'Main prompt',
        outputImageModal: true,
        fallbackModels: { model: ['fallback-main'] },
        fallbackWhenBlankResponse: true,
        doNotChangeFallbackModels: true,
      },
    })
    expect(Object.keys(prompt.json().settings).sort()).toEqual([...PROMPT_SETTINGS_KEYS].sort())

    const media = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/media',
      headers: authHeaders(),
    })
    expect(media.statusCode).toBe(200)
    expect(media.json().settings).not.toHaveProperty('outputImageModal')

    const sidebar = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/sidebar',
      headers: authHeaders(),
    })
    expect(sidebar.statusCode).toBe(200)
    expect(sidebar.json().settings).toMatchObject({ lastLoadedLoadoutName: '' })

    const modules = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/modules',
      headers: authHeaders(),
    })
    expect(modules.statusCode).toBe(200)
    expect(modules.json()).toEqual({
      revision,
      group: 'modules',
      settings: { enabledModules: ['module-a'], moduleFolders: [] },
    })

    const account = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/account',
      headers: authHeaders(),
    })
    expect(account.statusCode).toBe(200)
    expect(account.json().settings).not.toHaveProperty('localNetworkMode')
    expect(account.json().settings).not.toHaveProperty('localNetworkTimeoutSec')

    const agents = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/agents',
      headers: authHeaders(),
    })
    expect(agents.statusCode).toBe(200)
    expect(agents.json()).toEqual({
      revision,
      group: 'agents',
      settings: {
        agents: [],
        agentPresets: [{ id: 'agent-a', name: 'Agent A', enabled: true, version: 1, agentUses: [], steps: [] }],
        agentPresetDefaultId: 'agent-a',
      },
    })
    expect(agents.json().settings).not.toHaveProperty('theme')

    const models = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/models',
      headers: authHeaders(),
    })
    expect(models.statusCode).toBe(200)
    expect(models.json()).toMatchObject({
      revision,
      group: 'models',
      settings: {
        providerCredentials: [
          { id: 'credential-api', apiKey: MASKED_PROVIDER_SECRET },
          { id: 'credential-vertex', vertex: { privateKey: MASKED_PROVIDER_SECRET } },
        ],
        modelProfiles: [
          {
            id: 'profile-a',
            providerOptions: {
              credentialId: 'credential-vertex',
            },
          },
        ],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'profile-a' } },
        modelRuntimeDefaults: { maxContext: 8_192 },
      },
    })
    expect(Object.keys(models.json().settings).sort()).toEqual(
      ['providerCredentials', 'modelProfiles', 'modelProfileOrder', 'modelRoleProfiles', 'modelRuntimeDefaults'].sort(),
    )
    expect(models.json().settings).not.toHaveProperty('openAIKey')

    const unknown = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/not-a-group',
      headers: authHeaders(),
    })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json().error).toBe('settings_group_not_found')
  })

  it('substitutes exact masked settings and settings-group projections by content hash', async () => {
    const full = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: authHeaders(),
    })
    const fullSettings = full.json().settings as Record<string, unknown>
    const fullHash = jsonSha256(fullSettings)
    const unmaskedHash = jsonSha256({ ...fullSettings, openAIKey: 'root-secret' })

    const changed = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/settings',
      headers: authHeaders(),
      payload: cachePayload({ settings: [unmaskedHash] }),
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toEqual({
      revision,
      cache: { version: 2, algorithm: 'sha256' },
      settings: fullSettings,
    })

    const cached = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/settings',
      headers: authHeaders(),
      payload: cachePayload({ settings: [fullHash] }),
    })
    expect(cached.statusCode).toBe(200)
    expect(cached.json()).toEqual({
      revision,
      cache: { version: 2, algorithm: 'sha256' },
      settings: fullHash,
    })

    const models = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/models',
      headers: authHeaders(),
    })
    const modelSettings = models.json().settings as Record<string, unknown>
    const modelHash = jsonSha256(modelSettings)
    const cachedModels = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/settings/models',
      headers: authHeaders(),
      payload: cachePayload({ settings: [modelHash] }),
    })
    expect(cachedModels.statusCode).toBe(200)
    expect(cachedModels.json()).toEqual({
      revision,
      group: 'models',
      cache: { version: 2, algorithm: 'sha256' },
      settings: modelHash,
    })
  })

  it('returns aggregate and allowlisted targeted collections with masked secrets', async () => {
    const aggregate = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/collections',
      headers: authHeaders(),
    })
    expect(aggregate.statusCode).toBe(200)
    const aggregateBody = aggregate.json()
    expect(aggregateBody.revision).toBe(revision)
    expect(Object.keys(aggregateBody.collections).sort()).toEqual([...COLLECTION_FIELDS, 'pluginCustomStorage'].sort())
    expect(aggregateBody.collections.modules).toEqual([
      expect.objectContaining({ id: 'module-a', cjs: 'module.exports = true' }),
    ])
    expect(aggregateBody.collections.modelPresets[0].openAIKey).toBe(MASKED_PROVIDER_SECRET)
    expect(aggregateBody.collections.pluginCustomStorage).toEqual({ 'plugin-a:state': { enabled: true } })
    expect(aggregateBody.collections.promptPresets).toEqual([
      { id: 'prompt-a', name: 'Prompt A' },
      { id: 'prompt-empty', name: 'Prompt Empty' },
    ])
    expect(aggregateBody.collections.promptTemplate).toEqual([])
    expect(aggregateBody.collections.botPresets).toEqual([
      {
        id: 'legacy-a',
        name: 'Legacy A',
        image: 'legacy-a.png',
        metadata: { source: 'test' },
        customPromptTemplateToggle: 'mode=Mode=select=warm,cold',
        moduleIntergration: 'legacy-module-space',
      },
    ])
    expect(aggregate.payload).not.toContain('Large legacy body')
    expect(aggregate.payload).not.toContain('legacy-secret')

    const targeted = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/collections/modelPresets',
      headers: authHeaders(),
    })
    expect(targeted.statusCode).toBe(200)
    expect(targeted.json()).toEqual({
      revision,
      collections: {
        modelPresets: [expect.objectContaining({ id: 'model-a', openAIKey: MASKED_PROVIDER_SECRET })],
      },
    })

    const legacyPresets = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/collections/botPresets',
      headers: authHeaders(),
    })
    expect(legacyPresets.statusCode).toBe(200)
    expect(legacyPresets.json()).toEqual({
      revision,
      collections: {
        botPresets: [
          {
            id: 'legacy-a',
            name: 'Legacy A',
            image: 'legacy-a.png',
            metadata: { source: 'test' },
            customPromptTemplateToggle: 'mode=Mode=select=warm,cold',
            moduleIntergration: 'legacy-module-space',
          },
        ],
      },
    })
    expect(legacyPresets.payload).not.toContain('Large legacy body')
    expect(legacyPresets.payload).not.toContain('legacy-secret')

    const promptPresets = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/collections/promptPresets',
      headers: authHeaders(),
    })
    expect(promptPresets.statusCode).toBe(200)
    expect(promptPresets.json()).toEqual({
      revision,
      collections: {
        promptPresets: [
          { id: 'prompt-a', name: 'Prompt A' },
          { id: 'prompt-empty', name: 'Prompt Empty' },
        ],
      },
    })

    const rootPromptTemplate = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/collections/promptTemplate',
      headers: authHeaders(),
    })
    expect(rootPromptTemplate.statusCode).toBe(200)
    expect(rootPromptTemplate.json()).toEqual({
      revision,
      collections: {
        promptTemplate: [{ id: 'root-prompt', type: 'plain', text: 'Root prompt', role: 'system' }],
      },
    })

    const unknown = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/collections/not-a-collection',
      headers: authHeaders(),
    })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json().error).toBe('collection_not_found')
  })

  it('returns only changed collection items and treats hash arrays as content inventories', async () => {
    const aggregate = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/collections',
      headers: authHeaders(),
    })
    const collections = aggregate.json().collections as Record<string, unknown>
    const modules = collections.modules as unknown[]
    const modelPresets = collections.modelPresets as Array<Record<string, unknown>>
    const promptPresets = collections.promptPresets as Array<Record<string, unknown>>
    const moduleHash = jsonSha256(modules[0])
    const maskedModelHash = jsonSha256(modelPresets[0])
    const unmaskedModelHash = jsonSha256({ ...modelPresets[0], openAIKey: 'model-secret' })
    const promptHashes = promptPresets.map(jsonSha256)
    const fullPromptOwnerHash = jsonSha256({
      id: 'prompt-a',
      name: 'Prompt A',
      promptTemplate: [{ id: 'prompt-item-a', type: 'plain', text: 'Prompt text', role: 'system' }],
    })
    const pluginStorageHash = jsonSha256(collections.pluginCustomStorage)

    const cached = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: authHeaders(),
      payload: cachePayload({
        modules: [moduleHash],
        modelPresets: [unmaskedModelHash, maskedModelHash],
        // Reverse the inventory and include the stripped owner body's hash.
        // Membership, not request position, decides whether a row is cached.
        promptPresets: [promptHashes[1], fullPromptOwnerHash, promptHashes[0]],
        pluginCustomStorage: [pluginStorageHash],
      }),
    })
    expect(cached.statusCode).toBe(200)
    const cachedBody = cached.json()
    expect(cachedBody.cache).toEqual({ version: 2, algorithm: 'sha256' })
    expect(cachedBody.collections.modules).toEqual([{ hash: moduleHash }])
    expect(cachedBody.collections.modelPresets).toEqual([{ hash: maskedModelHash }])
    expect(cachedBody.collections.promptPresets).toEqual(promptHashes.map((hash) => ({ hash })))
    expect(cachedBody.collections.pluginCustomStorage).toBe(pluginStorageHash)
    expect(cachedBody.collections.promptTemplate).toEqual([])
    expect(cached.payload).not.toContain('model-secret')
    expect(cached.payload).not.toContain('Prompt text')

    const partial = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections/promptPresets',
      headers: authHeaders(),
      payload: cachePayload({ promptPresets: [promptHashes[0]] }),
    })
    expect(partial.statusCode).toBe(200)
    expect(partial.json()).toEqual({
      revision,
      cache: { version: 2, algorithm: 'sha256' },
      collections: {
        promptPresets: [{ hash: promptHashes[0] }, { value: promptPresets[1] }],
      },
    })

    const promptTemplate = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/collections/promptTemplate',
      headers: authHeaders(),
    })
    const promptTemplateItem = promptTemplate.json().collections.promptTemplate[0]
    const promptTemplateHash = jsonSha256(promptTemplateItem)
    const cachedPromptTemplate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections/promptTemplate',
      headers: authHeaders(),
      payload: cachePayload({ promptTemplate: [promptTemplateHash] }),
    })
    expect(cachedPromptTemplate.json()).toEqual({
      revision,
      cache: { version: 2, algorithm: 'sha256' },
      collections: { promptTemplate: [{ hash: promptTemplateHash }] },
    })

    expect(aggregate.json()).not.toHaveProperty('cache')
  })

  it('strictly validates versioned cache inventories and caps their total hashes', async () => {
    const validHash = 'a'.repeat(64)
    const invalidPayloads: Array<Record<string, unknown>> = [
      {},
      { cache: { version: 1, hashes: {} } },
      { cache: { version: 2, hashes: {}, extra: true } },
      { cache: { version: 2, hashes: { unknown: [] } } },
      { cache: { version: 2, hashes: { modules: validHash } } },
      { cache: { version: 2, hashes: { modules: [validHash.toUpperCase()] } } },
      { cache: { version: 2, hashes: { modules: [validHash] } }, extra: true },
    ]

    for (const payload of invalidPayloads) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: authHeaders(),
        payload,
      })
      expect(response.statusCode, JSON.stringify(payload)).toBe(400)
      expect(response.json().error).toBe('invalid_resource_cache_request')
    }

    const oversized = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: authHeaders(),
      payload: cachePayload({ modules: new Array(10_001).fill(validHash) }),
    })
    expect(oversized.statusCode).toBe(400)
    expect(oversized.json()).toMatchObject({
      error: 'invalid_resource_cache_request',
      reason: 'body.cache.hashes must contain at most 10000 hashes',
    })

    const oversizedBody = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: authHeaders(),
      payload: cachePayload({ modules: ['a'.repeat(1024 * 1024)] }),
    })
    expect(oversizedBody.statusCode).toBe(413)

    const unknownCollection = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections/not-a-collection',
      headers: authHeaders(),
      payload: cachePayload({}),
    })
    expect(unknownCollection.statusCode).toBe(404)
    expect(unknownCollection.json().error).toBe('collection_not_found')

    const unknownGroup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/settings/not-a-group',
      headers: authHeaders(),
      payload: cachePayload({}),
    })
    expect(unknownGroup.statusCode).toBe(404)
    expect(unknownGroup.json().error).toBe('settings_group_not_found')
  })

  it('rejects a malformed selected prompt pointer without changing any persisted row', async () => {
    const sqlite = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      const row = sqlite.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
      const settings = JSON.parse(row.data_json) as Record<string, unknown>
      settings.promptPresetsId = 99
      sqlite.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
    } finally {
      sqlite.close()
    }
    const damagedRows = readAllDatabaseRows()

    const aggregate = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/collections',
      headers: authHeaders(),
    })

    expect(aggregate.statusCode).toBe(500)
    expect(readAllDatabaseRows()).toEqual(damagedRows)
  })

  it('rejects duplicate modern preset ids without changing any persisted row', async () => {
    const sqlite = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      sqlite
        .prepare('UPDATE prompt_presets SET data_json = ? WHERE position = 1')
        .run(JSON.stringify({ id: 'prompt-a', name: 'Duplicate Prompt A' }))
    } finally {
      sqlite.close()
    }
    const damagedRows = readAllDatabaseRows()

    const aggregate = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/collections',
      headers: authHeaders(),
    })
    expect(aggregate.statusCode).toBe(500)
    expect(readAllDatabaseRows()).toEqual(damagedRows)

    const hydration = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/prompt-presets/prompt-a/template',
      headers: authHeaders(),
    })
    expect(hydration.statusCode).toBe(500)
    expect(readAllDatabaseRows()).toEqual(damagedRows)
  })

  it('preserves and hydrates the selected default-scaffold fallback from the root template', async () => {
    const sqlite = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      sqlite
        .prepare('UPDATE prompt_presets SET data_json = ? WHERE position = 0')
        .run(JSON.stringify({ id: 'default-prompt-preset', name: 'Default Prompt' }))
      const legacyRow = sqlite.prepare('SELECT data_json FROM bot_presets WHERE position = 0').get() as {
        data_json: string
      }
      const legacyPreset = JSON.parse(legacyRow.data_json) as Record<string, unknown>
      delete legacyPreset.promptTemplate
      sqlite.prepare('UPDATE bot_presets SET data_json = ? WHERE position = 0').run(JSON.stringify(legacyPreset))
    } finally {
      sqlite.close()
    }

    const aggregate = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/collections',
      headers: authHeaders(),
    })
    expect(aggregate.statusCode).toBe(200)
    expect(aggregate.json().collections.promptTemplate).toEqual([
      { id: 'root-prompt', type: 'plain', text: 'Root prompt', role: 'system' },
    ])

    const hydration = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/prompt-presets/default-prompt-preset/template',
      headers: authHeaders(),
    })
    expect(hydration.statusCode).toBe(200)
    expect(hydration.json()).toEqual({
      revision,
      promptPresetId: 'default-prompt-preset',
      promptTemplate: null,
      selectedFallbackPromptTemplate: [{ id: 'root-prompt', type: 'plain', text: 'Root prompt', role: 'system' }],
    })

    const nullTemplateHash = jsonSha256(null)
    const fallbackTemplate = hydration.json().selectedFallbackPromptTemplate as unknown[]
    const fallbackTemplateHash = jsonSha256(fallbackTemplate[0])
    const cachedHydration = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/prompt-presets/default-prompt-preset/template',
      headers: authHeaders(),
      payload: cachePayload({
        promptTemplate: [nullTemplateHash],
        selectedFallbackPromptTemplate: [fallbackTemplateHash],
      }),
    })
    expect(cachedHydration.statusCode).toBe(200)
    expect(cachedHydration.json()).toEqual({
      revision,
      promptPresetId: 'default-prompt-preset',
      cache: { version: 2, algorithm: 'sha256' },
      promptTemplate: nullTemplateHash,
      selectedFallbackPromptTemplate: [{ hash: fallbackTemplateHash }],
    })
  })

  it('does not expose the root fallback when a legacy preset still owns a template', async () => {
    const sqlite = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      sqlite
        .prepare('UPDATE prompt_presets SET data_json = ? WHERE position = 0')
        .run(JSON.stringify({ id: 'default-prompt-preset', name: 'Default Prompt' }))
    } finally {
      sqlite.close()
    }

    const aggregate = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/collections',
      headers: authHeaders(),
    })
    expect(aggregate.statusCode).toBe(200)
    expect(aggregate.json().collections.promptTemplate).toEqual([])

    const hydration = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/prompt-presets/default-prompt-preset/template',
      headers: authHeaders(),
    })
    expect(hydration.statusCode).toBe(200)
    expect(hydration.json()).toEqual({
      revision,
      promptPresetId: 'default-prompt-preset',
      promptTemplate: null,
    })
  })

  it('returns exact versioned character summaries and preserves scoped detail reads', async () => {
    const list = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters',
      headers: authHeaders(),
    })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toMatchObject({
      version: SERVER_CHARACTER_SUMMARY_VERSION,
      revision,
      currentChar: 0,
      characterOrder: ['char-a', 'char-b'],
    })
    expect(isServerCharactersSummaryPayload(list.json())).toBe(true)
    const listedAda = list.json().characters.find((character: { chaId?: string }) => character.chaId === 'char-a')
    expect(Object.keys(listedAda)).toEqual(SERVER_CHARACTER_SUMMARY_KEYS)
    expect(listedAda).toEqual({
      __serverCharacterShell: true,
      chaId: 'char-a',
      type: 'character',
      name: 'Ada',
      displayName: 'Ada Lovelace',
      image: 'asset://ada',
      creatorNotes: '# `en`\nFirst programmer',
      trashTime: null,
      creation_date: 1,
      modification_date: 2,
      lastInteraction: 123,
      chatCount: 1,
      activeChatId: 'chat-a',
      chatIds: ['chat-a'],
      pinnedChats: [{ id: 'chat-a', name: 'Chat A' }],
    })
    for (const forbidden of ['chats', 'desc', 'oaiTTSConfig', 'globalLore', 'customscript', 'triggerscript']) {
      expect(listedAda).not.toHaveProperty(forbidden)
    }
    expect(list.payload).not.toContain('tts-secret')
    expect(list.payload).not.toContain('Character lore')
    expect(list.payload).not.toContain('summary')

    const detail = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-a',
      headers: authHeaders(),
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().character).toMatchObject({
      chaId: 'char-a',
      chats: [{ id: 'chat-a', message: [] }],
    })
    expect(detail.json().character).not.toHaveProperty('globalLore')
    expect(detail.json().character.oaiTTSConfig.apiKey).toBe(MASKED_PROVIDER_SECRET)

    const missing = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/missing',
      headers: authHeaders(),
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('character_not_found')
  })

  it('substitutes cached character summaries without depending on inventory order', async () => {
    const list = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters',
      headers: authHeaders(),
    })
    const characters = list.json().characters as Array<Record<string, unknown>>
    const characterHashes = characters.map(jsonSha256)

    const cached = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/characters',
      headers: authHeaders(),
      payload: cachePayload({ characters: [characterHashes[1], characterHashes[0]] }),
    })
    expect(cached.statusCode).toBe(200)
    expect(cached.json()).toEqual({
      version: SERVER_CHARACTER_SUMMARY_VERSION,
      revision,
      cache: { version: 2, algorithm: 'sha256' },
      characters: characterHashes.map((hash) => ({ hash })),
      characterOrder: ['char-a', 'char-b'],
      currentChar: 0,
    })
    expect(cached.payload).not.toContain('tts-secret')

    const partial = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/characters',
      headers: authHeaders(),
      payload: cachePayload({ characters: [characterHashes[0]] }),
    })
    expect(partial.statusCode).toBe(200)
    expect(partial.json().characters).toEqual([{ hash: characterHashes[0] }, { value: characters[1] }])
    expect(partial.json().characterOrder).toEqual(['char-a', 'char-b'])
    expect(partial.json().currentChar).toBe(0)
    expect(list.json()).not.toHaveProperty('cache')
  })

  it('keeps character lorebooks resident when lorebook stubs are disabled', async () => {
    const imported = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: authHeaders(),
      payload: {
        database: {
          enableLorebookStubs: false,
          characters: [
            {
              chaId: 'char-full-lore',
              name: 'Lore keeper',
              globalLore: [{ key: ['resident'], content: 'Resident lore' }],
              chats: [],
            },
          ],
        },
      },
    })
    expect(imported.statusCode).toBe(200)

    const aggregate = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/aggregate',
      headers: authHeaders(),
    })
    const detail = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-full-lore',
      headers: authHeaders(),
    })

    expect(aggregate.statusCode).toBe(200)
    expect(detail.statusCode).toBe(200)
    expect(aggregate.json().characters[0].globalLore).toEqual([
      expect.objectContaining({ key: 'resident', content: 'Resident lore' }),
    ])
    expect(detail.json().character.globalLore).toEqual([
      expect.objectContaining({ key: 'resident', content: 'Resident lore' }),
    ])
  })

  it('returns narrow character order and selection resources', async () => {
    const order = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/order',
      headers: authHeaders(),
    })
    expect(order.statusCode).toBe(200)
    expect(order.json()).toEqual({
      revision,
      characterOrder: ['char-a', 'char-b'],
    })

    const selection = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-a/selection',
      headers: authHeaders(),
    })
    expect(selection.statusCode).toBe(200)
    expect(selection.json()).toEqual({
      revision,
      characterId: 'char-a',
      currentChar: 0,
      lastInteraction: 123,
    })

    const missing = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/missing/selection',
      headers: authHeaders(),
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('character_not_found')
  })

  it('serves full, ranged, and bulk chat message reads with per-chat alternates', async () => {
    const full = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/chats/chat-a/messages',
      headers: authHeaders(),
    })
    expect(full.statusCode).toBe(200)
    expect(full.json()).toMatchObject({
      revision,
      chatId: 'chat-a',
      message: [
        { uid: 'message-a', data: 'one' },
        { uid: 'message-b', data: 'two' },
      ],
      hypaV3Data: { mainChunks: [{ text: 'summary' }] },
      alternates: [],
    })

    const tail = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/chats/chat-a/messages?tail=1',
      headers: authHeaders(),
    })
    expect(tail.statusCode).toBe(200)
    expect(tail.json()).toMatchObject({
      message: [{ uid: 'message-b', data: 'two' }],
      messageStart: 1,
      messageTotal: 2,
    })

    const generationWindow = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/chats/chat-a/messages?generationMessageId=${encodeURIComponent(full.json().message[1].chatId)}`,
      headers: authHeaders(),
    })
    expect(generationWindow.statusCode).toBe(200)
    expect(generationWindow.json()).toMatchObject({
      chatId: 'chat-a',
      message: [{ uid: 'message-b', data: 'two' }],
      messageStart: 1,
      messageTotal: 2,
      alternates: [],
    })
    expect(generationWindow.json()).not.toHaveProperty('hypaV3Data')

    const sqlite = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      sqlite
        .prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, ?, ?)')
        .run('chat-bulk-b', 'char-a', 1, JSON.stringify({ id: 'chat-bulk-b', name: 'Chat Bulk B', message: [] }))
      replaceChatMessages(sqlite, 'chat-bulk-b', [{ chatId: 'bulk-b-primary', role: 'char', data: 'bulk B primary' }])
      addAlternateMessage(sqlite, 'chat-a', {
        chatId: 'chat-a-alternate-old',
        role: 'char',
        data: 'chat A older candidate',
      })
      addAlternateMessage(sqlite, 'chat-a', {
        chatId: 'chat-a-alternate-new',
        role: 'char',
        data: 'chat A newer candidate',
      })
      addAlternateMessage(sqlite, 'chat-bulk-b', {
        chatId: 'chat-b-alternate',
        role: 'char',
        data: 'chat B candidate',
      })
    } finally {
      sqlite.close()
    }

    const bulk = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/chats/messages/bulk',
      headers: authHeaders(),
      payload: { ids: ['chat-a', 'chat-bulk-b', 'missing', 'chat-a'] },
    })
    expect(bulk.statusCode).toBe(200)
    expect(bulk.json()).toEqual({
      revision,
      chats: [
        {
          chatId: 'chat-a',
          message: [
            expect.objectContaining({ uid: 'message-a', data: 'one' }),
            expect.objectContaining({ uid: 'message-b', data: 'two' }),
          ],
          hypaV3Data: { mainChunks: [{ text: 'summary' }] },
          alternates: [
            { chatId: 'chat-a-alternate-new', role: 'char', data: 'chat A newer candidate' },
            { chatId: 'chat-a-alternate-old', role: 'char', data: 'chat A older candidate' },
          ],
        },
        {
          chatId: 'chat-bulk-b',
          message: [{ chatId: 'bulk-b-primary', role: 'char', data: 'bulk B primary' }],
          alternates: [{ chatId: 'chat-b-alternate', role: 'char', data: 'chat B candidate' }],
        },
      ],
      missing: ['missing'],
    })

    const invalid = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/chats/chat-a/messages?tail=1&start=0',
      headers: authHeaders(),
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toBe('invalid_chat_message_range')

    const invalidGenerationWindow = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/chats/chat-a/messages?generationMessageId=${encodeURIComponent(full.json().message[1].chatId)}&tail=1`,
      headers: authHeaders(),
    })
    expect(invalidGenerationWindow.statusCode).toBe(400)
    expect(invalidGenerationWindow.json().error).toBe('invalid_chat_message_range')
  })

  it('bounds raw ids and request bodies on both bulk resource routes', async () => {
    const routes = [
      { url: '/api/v1/chats/messages/bulk', invalidError: 'invalid_chat_ids' },
      { url: '/api/v1/characters/lorebooks/bulk', invalidError: 'invalid_character_lorebook_ids' },
    ]

    for (const route of routes) {
      const exactIds = Array.from({ length: BULK_RESOURCE_MAX_IDS }, (_, index) => `missing-${index}`)
      const exact = await harness.app.inject({
        method: 'POST',
        url: route.url,
        headers: authHeaders(),
        payload: { ids: exactIds },
      })
      expect(exact.statusCode, route.url).toBe(200)
      expect(exact.json().missing, route.url).toEqual(exactIds)

      const deduplicated = await harness.app.inject({
        method: 'POST',
        url: route.url,
        headers: authHeaders(),
        payload: { ids: Array(BULK_RESOURCE_MAX_IDS).fill(' missing-duplicate ') },
      })
      expect(deduplicated.statusCode, route.url).toBe(200)
      expect(deduplicated.json().missing, route.url).toEqual(['missing-duplicate'])

      const tooMany = await harness.app.inject({
        method: 'POST',
        url: route.url,
        headers: authHeaders(),
        payload: { ids: Array(BULK_RESOURCE_MAX_IDS + 1).fill('duplicate-still-counts') },
      })
      expect(tooMany.statusCode, route.url).toBe(413)
      expect(tooMany.json(), route.url).toEqual({
        error: 'bulk_resource_limit_exceeded',
        maxItems: BULK_RESOURCE_MAX_IDS,
      })

      const invalid = await harness.app.inject({
        method: 'POST',
        url: route.url,
        headers: authHeaders(),
        payload: { ids: [''] },
      })
      expect(invalid.statusCode, route.url).toBe(400)
      expect(invalid.json().error, route.url).toBe(route.invalidError)

      const oversized = await harness.app.inject({
        method: 'POST',
        url: route.url,
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        payload: JSON.stringify({ ids: ['x'.repeat(BULK_RESOURCE_MAX_BODY_BYTES)] }),
      })
      expect(oversized.statusCode, route.url).toBe(413)
    }
  })

  it('serves full single and bulk character lorebooks while character rows are stubbed', async () => {
    const single = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-a/lorebook',
      headers: authHeaders(),
    })
    expect(single.statusCode).toBe(200)
    expect(single.json()).toMatchObject({
      revision,
      characterId: 'char-a',
      globalLore: [expect.objectContaining({ key: 'Ada', content: 'Character lore' })],
    })

    const globalLore = single.json().globalLore as unknown[]
    const globalLoreHash = jsonSha256(globalLore[0])
    const cachedSingle = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/characters/char-a/lorebook',
      headers: authHeaders(),
      payload: cachePayload({ globalLore: [globalLoreHash] }),
    })
    expect(cachedSingle.statusCode).toBe(200)
    expect(cachedSingle.json()).toEqual({
      revision,
      characterId: 'char-a',
      cache: { version: 2, algorithm: 'sha256' },
      globalLore: [{ hash: globalLoreHash }],
    })

    const uncachedSingle = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/characters/char-a/lorebook',
      headers: authHeaders(),
      payload: cachePayload({ globalLore: [] }),
    })
    expect(uncachedSingle.statusCode).toBe(200)
    expect(uncachedSingle.json()).toEqual({
      revision,
      characterId: 'char-a',
      cache: { version: 2, algorithm: 'sha256' },
      globalLore: globalLore.map((value) => ({ value })),
    })

    const bulk = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/characters/lorebooks/bulk',
      headers: authHeaders(),
      payload: { ids: ['char-a', 'missing', 'char-b'] },
    })
    expect(bulk.statusCode).toBe(200)
    expect(bulk.json()).toMatchObject({
      revision,
      characters: [
        {
          characterId: 'char-a',
          globalLore: [expect.objectContaining({ key: 'Ada', content: 'Character lore' })],
        },
        {
          characterId: 'char-b',
          globalLore: [expect.objectContaining({ key: 'Bea', content: 'Second lore' })],
        },
      ],
      missing: ['missing'],
    })
  })

  it('serves masked legacy preset detail and prompt-preset templates', async () => {
    const legacy = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/legacy-presets/legacy-a',
      headers: authHeaders(),
    })
    expect(legacy.statusCode).toBe(200)
    expect(legacy.json()).toEqual({
      revision,
      preset: expect.objectContaining({
        id: 'legacy-a',
        name: 'Legacy A',
        openAIKey: MASKED_PROVIDER_SECRET,
        temperature: 0.7,
        mainPrompt: 'Large legacy body'.repeat(2_000),
        promptTemplate: [{ id: 'legacy-prompt', type: 'plain', text: 'Legacy prompt body', role: 'system' }],
      }),
    })
    expect(legacy.payload).not.toContain('legacy-secret')

    const legacyPreset = legacy.json().preset as Record<string, unknown>
    const maskedPresetHash = jsonSha256(legacyPreset)
    const unmaskedPresetHash = jsonSha256({ ...legacyPreset, openAIKey: 'legacy-secret' })
    const uncachedLegacy = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/legacy-presets/legacy-a',
      headers: authHeaders(),
      payload: cachePayload({ preset: [unmaskedPresetHash] }),
    })
    expect(uncachedLegacy.statusCode).toBe(200)
    expect(uncachedLegacy.json()).toEqual({
      revision,
      cache: { version: 2, algorithm: 'sha256' },
      preset: legacyPreset,
    })
    expect(uncachedLegacy.payload).not.toContain('legacy-secret')

    const cachedLegacy = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/legacy-presets/legacy-a',
      headers: authHeaders(),
      payload: cachePayload({ preset: [maskedPresetHash] }),
    })
    expect(cachedLegacy.statusCode).toBe(200)
    expect(cachedLegacy.json()).toEqual({
      revision,
      cache: { version: 2, algorithm: 'sha256' },
      preset: maskedPresetHash,
    })
    expect(cachedLegacy.payload.length).toBeLessThan(legacy.payload.length)

    const template = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/prompt-presets/prompt-a/template',
      headers: authHeaders(),
    })
    expect(template.statusCode).toBe(200)
    expect(template.json()).toEqual({
      revision,
      promptPresetId: 'prompt-a',
      promptTemplate: [{ id: 'prompt-item-a', type: 'plain', text: 'Prompt text', role: 'system' }],
    })

    const promptTemplate = template.json().promptTemplate as unknown[]
    const promptTemplateHash = jsonSha256(promptTemplate[0])
    const cachedTemplate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/prompt-presets/prompt-a/template',
      headers: authHeaders(),
      payload: cachePayload({
        promptTemplate: [promptTemplateHash],
        selectedFallbackPromptTemplate: [],
      }),
    })
    expect(cachedTemplate.statusCode).toBe(200)
    expect(cachedTemplate.json()).toEqual({
      revision,
      promptPresetId: 'prompt-a',
      cache: { version: 2, algorithm: 'sha256' },
      promptTemplate: [{ hash: promptTemplateHash }],
    })

    const empty = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/prompt-presets/prompt-empty/template',
      headers: authHeaders(),
    })
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual({ revision, promptPresetId: 'prompt-empty', promptTemplate: null })

    const nullTemplateHash = jsonSha256(null)
    const cachedEmpty = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/prompt-presets/prompt-empty/template',
      headers: authHeaders(),
      payload: cachePayload({
        promptTemplate: [nullTemplateHash],
        selectedFallbackPromptTemplate: [],
      }),
    })
    expect(cachedEmpty.statusCode).toBe(200)
    expect(cachedEmpty.json()).toEqual({
      revision,
      promptPresetId: 'prompt-empty',
      cache: { version: 2, algorithm: 'sha256' },
      promptTemplate: nullTemplateHash,
    })

    const missing = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/prompt-presets/missing/template',
      headers: authHeaders(),
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('prompt_preset_not_found')
  })
})
