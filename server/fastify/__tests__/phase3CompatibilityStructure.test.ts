import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMMAND_EVENT_CATALOG,
  PRESET_COLLECTION_WITH_POINTER_RESOURCE,
  PRESET_POINTER_RESOURCE,
  REVISION_ONLY_RESOURCE,
  SETTINGS_WITH_HYPA_V3_PRESETS_RESOURCE,
  selectCommandEventReplay,
  type CommandEvent,
} from '../src/commands/events.js'
import { openDatabase } from '../src/db.js'
import { COLLECTION_FIELDS } from '../src/repository.js'
import { SETTINGS_GROUP_KEYS, SETTINGS_GROUPS } from '../src/routes/commands.js'
import { SERVER_SETTINGS_GROUP_BY_KEY } from '@risuai/shared-core/settings-groups'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const temporaryDirectories: string[] = []

const EXPECTED_COMMAND_ROUTE_COUNT = 165
const EXPECTED_COMMAND_ROUTE_DIGEST = '6cf578fff081487c445f780af234697ff41635daf5a6b12450c833b26f3cbe7e'
const EXPECTED_COMMAND_EVENT_COUNT = 150
const EXPECTED_COMMAND_EVENT_DIGEST = 'd3d6a356bea9e728b5e2cae0422f696dee8065534eb5bb7781d471c6617859cd'
const EXPECTED_SQLITE_SCHEMA_DIGEST = '8d5936e7ab85badf3bac393270d800efb0e1f2749b286660a345348027f42f5c'

/**
 * Persisted event history from before reusable Agents can still contain these
 * names. Current compatibility `/steps` routes emit the replacement `use.*`
 * vocabulary, so these entries are replay-only rather than live producers.
 */
const REPLAY_ONLY_COMMAND_EVENT_KEYS = [
  'agentPresetStepCreated',
  'agentPresetStepDeleted',
  'agentPresetStepDuplicated',
  'agentPresetStepReordered',
  'agentPresetStepUpdated',
] as const

type EventRefreshClass = 'targeted-read' | 'complete-refresh' | 'revision-only'

/**
 * Every resource the current server emits plus the retained legacy resources
 * the browser can still receive during an upgrade/reconnect window. A new
 * resource must choose an explicit reconciliation class before it can ship.
 */
const EVENT_RESOURCE_CLASSIFICATION: Record<string, EventRefreshClass> = {
  agentPreset: 'targeted-read',
  agentPresetDeleted: 'targeted-read',
  asset: 'revision-only',
  bardWikiChat: 'targeted-read',
  bardWikiDocument: 'targeted-read',
  character: 'targeted-read',
  characterLorebook: 'targeted-read',
  characterOrder: 'targeted-read',
  characterRow: 'targeted-read',
  characterSelection: 'targeted-read',
  chat: 'targeted-read',
  chatFolder: 'targeted-read',
  chatTranscript: 'targeted-read',
  generation: 'targeted-read',
  globalLorebook: 'targeted-read',
  greetingTranslation: 'targeted-read',
  inlayCatalog: 'targeted-read',
  legacyBotPreset: 'targeted-read',
  loadout: 'targeted-read',
  lorebook: 'complete-refresh',
  message: 'targeted-read',
  modelPreset: 'targeted-read',
  modelProfile: 'targeted-read',
  module: 'targeted-read',
  moduleCreated: 'targeted-read',
  moduleEnabled: 'targeted-read',
  moduleFolders: 'targeted-read',
  moduleOrganization: 'targeted-read',
  moduleReordered: 'targeted-read',
  moduleScriptDefinition: 'targeted-read',
  moduleTriggerDefinition: 'targeted-read',
  moduleUpdated: 'targeted-read',
  persona: 'targeted-read',
  plugin: 'complete-refresh',
  pluginCollection: 'targeted-read',
  pluginCollectionWithProvider: 'targeted-read',
  pluginProvider: 'targeted-read',
  pluginStorage: 'targeted-read',
  preset: 'complete-refresh',
  presetApplied: 'targeted-read',
  presetCollection: 'targeted-read',
  presetCollectionWithPointer: 'targeted-read',
  presetPointer: 'targeted-read',
  presetRow: 'targeted-read',
  prompt: 'targeted-read',
  promptItem: 'targeted-read',
  promptPreset: 'targeted-read',
  providerCredential: 'targeted-read',
  revisionOnly: 'revision-only',
  scriptDefinition: 'targeted-read',
  settings: 'targeted-read',
  settingsWithHypaV3Presets: 'targeted-read',
  state: 'complete-refresh',
  translatorPreset: 'targeted-read',
  triggerDefinition: 'targeted-read',
}

type PersistedTableClass =
  | 'shared-logical-state'
  | 'command-durability'
  | 'generation-lifecycle'
  | 'memory-domain'
  | 'bardwiki-domain'
  | 'server-operational'

/** Every SQLite column inherits the compatibility owner assigned to its table. */
const PERSISTED_TABLE_CLASSIFICATION: Record<string, { class: PersistedTableClass; owner: string }> = {
  assets: { class: 'shared-logical-state', owner: 'repository assets' },
  bardwiki_change_manifest: { class: 'bardwiki-domain', owner: 'BardWiki change application' },
  bardwiki_chat_settings: { class: 'bardwiki-domain', owner: 'BardWiki chat settings' },
  bardwiki_document_search: { class: 'bardwiki-domain', owner: 'BardWiki search projection' },
  bardwiki_document_sources: { class: 'bardwiki-domain', owner: 'BardWiki source provenance' },
  bardwiki_document_versions: { class: 'bardwiki-domain', owner: 'BardWiki document history' },
  bardwiki_documents: { class: 'bardwiki-domain', owner: 'BardWiki documents' },
  bardwiki_jobs: { class: 'bardwiki-domain', owner: 'BardWiki jobs' },
  bardwiki_links: { class: 'bardwiki-domain', owner: 'BardWiki links' },
  bardwiki_rebuild_staging: { class: 'bardwiki-domain', owner: 'BardWiki rebuild staging' },
  bardwiki_turn_receipts: { class: 'bardwiki-domain', owner: 'BardWiki turn receipts' },
  bot_presets: { class: 'shared-logical-state', owner: 'legacy preset collection' },
  characters: { class: 'shared-logical-state', owner: 'character repository' },
  chat_hypa_v3: { class: 'shared-logical-state', owner: 'chat memory projection' },
  chats: { class: 'shared-logical-state', owner: 'chat repository' },
  command_events: { class: 'command-durability', owner: 'command event replay' },
  command_mutation_receipts: { class: 'command-durability', owner: 'mutation idempotency' },
  database_metadata: { class: 'server-operational', owner: 'lineage, active writer, and module content version' },
  generation_effects: { class: 'generation-lifecycle', owner: 'generation effect ledger' },
  generation_finalization_retries: { class: 'generation-lifecycle', owner: 'generation finalization retry' },
  generation_operation_attempts: { class: 'generation-lifecycle', owner: 'generation attempt ledger' },
  generation_operation_projection_state: {
    class: 'generation-lifecycle',
    owner: 'generation projection epoch',
  },
  generation_operations: { class: 'generation-lifecycle', owner: 'generation operation ledger' },
  greeting_translations: { class: 'shared-logical-state', owner: 'greeting translations' },
  hypa_v3_presets: { class: 'shared-logical-state', owner: 'Hypa V3 preset collection' },
  inlay_catalog: { class: 'shared-logical-state', owner: 'inlay catalog' },
  loadouts: { class: 'shared-logical-state', owner: 'loadout collection' },
  lore_books: { class: 'shared-logical-state', owner: 'global lorebook collection' },
  memory_chunks: { class: 'memory-domain', owner: 'memory chunks' },
  memory_embeddings: { class: 'memory-domain', owner: 'memory embeddings' },
  memory_jobs: { class: 'memory-domain', owner: 'memory jobs' },
  memory_legacy_summary_tombstones: { class: 'memory-domain', owner: 'legacy summary deletion' },
  memory_summaries: { class: 'memory-domain', owner: 'memory summaries' },
  messages: { class: 'shared-logical-state', owner: 'message store' },
  model_presets: { class: 'shared-logical-state', owner: 'model preset collection' },
  modules: { class: 'shared-logical-state', owner: 'module collection' },
  personas: { class: 'shared-logical-state', owner: 'persona collection' },
  plugin_custom_storage: { class: 'shared-logical-state', owner: 'plugin storage commands' },
  plugins: { class: 'shared-logical-state', owner: 'plugin collection' },
  prompt_presets: { class: 'shared-logical-state', owner: 'prompt preset collection' },
  prompt_templates: { class: 'shared-logical-state', owner: 'prompt template compatibility mirror' },
  push_subscriptions: { class: 'server-operational', owner: 'Web Push subscriptions' },
  request_history: { class: 'server-operational', owner: 'request history' },
  schema_version: { class: 'server-operational', owner: 'schema and domain revision' },
  settings: { class: 'shared-logical-state', owner: 'settings repository' },
  translator_presets: { class: 'shared-logical-state', owner: 'translator preset collection' },
}

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

const PRESET_OWNED_DATABASE_FIELDS = [
  'autoSuggestClean',
  'autoSuggestPrefix',
  'dynamicOutput',
  'groupOtherBotRole',
  'groupTemplate',
  'localNetworkMode',
  'localNetworkTimeoutSec',
] as const

/** Retained in the opaque settings envelope for import/export and old-data use. */
const ROUND_TRIP_DATABASE_FIELDS = [
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
  'igpPrompt',
  'lastPatchNoteCheckVersion',
  'pluginV2',
  'removePunctuationHypa',
  'saveTime',
  'statics',
  'supaMemoryKey',
] as const

interface BridgeClassification {
  file: string
  flusher: string
  registrationId?: string
  commands: readonly string[]
  outcomes: readonly string[]
}

const BRIDGE_CLASSIFICATION: readonly BridgeClassification[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Phase 3 compatibility structure', () => {
  it('classifies the complete command route vocabulary and mutation policy', () => {
    const source = readRepoFile('server/fastify/src/routes/commands.ts')
    const routes = [...source.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/g)].map((match) => ({
      method: match[1].toUpperCase(),
      path: match[2],
    }))
    const routeKeys = routes.map((route) => `${route.method}\0${route.path}`).sort()

    expect(new Set(routeKeys).size).toBe(routes.length)
    expect(routes.every((route) => commandRouteDomain(route.path) !== null)).toBe(true)
    expect(countBy(routes.map((route) => commandRoutePolicy(route.path)))).toEqual({
      'async-revisioned': 1,
      'conditional-preview-or-revisioned': 2,
      initialization: 1,
      'receipt-acknowledgement': 1,
      revisioned: 160,
    })
    expect(routes).toHaveLength(EXPECTED_COMMAND_ROUTE_COUNT)
    expect(digest(routeKeys.join('\n'))).toBe(EXPECTED_COMMAND_ROUTE_DIGEST)
  })

  it('keeps the browser and Fastify writable settings field catalogs identical', () => {
    const serverWritableEntries = SETTINGS_GROUPS.flatMap((group) =>
      SETTINGS_GROUP_KEYS[group].map((key) => [key, group] as const),
    )
    expect(new Set(serverWritableEntries.map(([key]) => key)).size).toBe(serverWritableEntries.length)
    expect(Object.fromEntries(serverWritableEntries)).toEqual(SERVER_SETTINGS_GROUP_BY_KEY)
  })

  it('classifies every logical Database field under a durable owner', () => {
    const source = readRepoFile('src/ts/storage/database.svelte.ts')
    const parsed = ts.createSourceFile('database.svelte.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const database = parsed.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === 'Database',
    )
    expect(database).toBeDefined()

    const fields = database!.members.flatMap((member) => {
      if (!ts.isPropertySignature(member) || member.name === undefined) return []
      return ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? [member.name.text] : []
    })
    const collectionFields = new Set<string>(COLLECTION_FIELDS)
    const writableSettings = SETTINGS_GROUPS.flatMap((group) => SETTINGS_GROUP_KEYS[group]).filter(
      (field) => !collectionFields.has(field),
    )
    const classified = [
      'characters',
      'pluginCustomStorage',
      ...COLLECTION_FIELDS,
      ...writableSettings,
      ...DEDICATED_COMMAND_DATABASE_FIELDS,
      ...PRESET_OWNED_DATABASE_FIELDS,
      ...ROUND_TRIP_DATABASE_FIELDS,
    ]

    expect(new Set(fields).size).toBe(fields.length)
    expect(new Set(classified).size).toBe(classified.length)
    expect([...classified].sort()).toEqual([...fields].sort())
  })

  it('pins every SQLite table and column to a reviewed persistence owner', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-phase3-schema-'))
    temporaryDirectories.push(dataDir)
    const db = openDatabase(dataDir)
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
      ).map(({ name }) => name)
      const schema = Object.fromEntries(
        tables.map((table) => [
          table,
          (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name),
        ]),
      )
      const serialized = Object.entries(schema)
        .map(([table, columns]) => `${table}\0${columns.join(',')}`)
        .join('\n')

      expect(Object.keys(PERSISTED_TABLE_CLASSIFICATION).sort()).toEqual(tables)
      expect(digest(serialized), JSON.stringify(schema, null, 2)).toBe(EXPECTED_SQLITE_SCHEMA_DIGEST)
    } finally {
      db.close()
    }
  })

  it('classifies every event type/resource and every browser reconciliation branch', () => {
    const catalogEntries = Object.entries(COMMAND_EVENT_CATALOG).sort(([left], [right]) => left.localeCompare(right))
    const serialized = catalogEntries.map(([key, event]) => `${key}\0${event.type}\0${event.resource}`).join('\n')
    expect(catalogEntries).toHaveLength(EXPECTED_COMMAND_EVENT_COUNT)
    expect(digest(serialized)).toBe(EXPECTED_COMMAND_EVENT_DIGEST)

    const producerSource = serverProductionSourcesExceptEventCatalog()
    const producerlessKeys = catalogEntries
      .map(([key]) => key)
      .filter((key) => !producerSource.includes(`COMMAND_EVENT_CATALOG.${key}`))
    expect(producerlessKeys).toEqual(REPLAY_ONLY_COMMAND_EVENT_KEYS)

    const resourceOverrides = [...producerSource.matchAll(/resource:\s*'([^']+)'/g)].map((match) => match[1])
    const serverResources = new Set([
      ...catalogEntries.map(([, event]) => event.resource),
      ...resourceOverrides,
      SETTINGS_WITH_HYPA_V3_PRESETS_RESOURCE,
      PRESET_COLLECTION_WITH_POINTER_RESOURCE,
      PRESET_POINTER_RESOURCE,
      REVISION_ONLY_RESOURCE,
    ])
    expect([...serverResources].filter((resource) => !(resource in EVENT_RESOURCE_CLASSIFICATION))).toEqual([])

    const clientResources = eventResourceSwitchCases(readRepoFile('src/ts/server/resourceInvalidation.ts'))
    expect(clientResources).toEqual(Object.keys(EVENT_RESOURCE_CLASSIFICATION).sort())
  })

  it('fails command replay closed on missing, duplicate, reordered, and ahead revisions', () => {
    const event = (revision: number): CommandEvent => ({
      type: 'settings.updated',
      revision,
      resource: 'settings',
      id: 'runtime',
    })

    expect(selectCommandEventReplay([event(2), event(3)], 1, 3)).toEqual({
      status: 'ok',
      events: [event(2), event(3)],
    })
    for (const history of [
      [event(2), event(4)],
      [event(2), event(2), event(3)],
      [event(3), event(2)],
    ]) {
      expect(selectCommandEventReplay(history, 1, 3).status).toBe('unavailable')
    }
    expect(selectCommandEventReplay([event(2), event(3)], 4, 3).status).toBe('unavailable')
  })

  it('classifies every built-in bridge, durable dispatch, rollback, and lifecycle flush owner', () => {
    const bridgeDirectory = path.join(REPO_ROOT, 'src/ts/server')
    const bridgeFiles = readdirSync(bridgeDirectory)
      .filter((file) => file.endsWith('Bridge.svelte.ts'))
      .sort()
    expect(bridgeFiles).toEqual(BRIDGE_CLASSIFICATION.map(({ file }) => file).sort())

    const aggregateFlush = bridgeFiles.length > 0 ? readRepoFile('src/ts/server/bridgeFlush.ts') : ''
    if (bridgeFiles.length === 0) {
      expect(() => readRepoFile('src/ts/server/bridgeFlush.ts')).toThrow()
    }
    for (const bridge of BRIDGE_CLASSIFICATION) {
      const source = readRepoFile(`src/ts/server/${bridge.file}`)
      expect(source).toContain('dispatchDurableMutation')
      expect(source).toContain('stagePendingMutation')
      expect(source).toMatch(/rollback/i)
      expect(source).toContain(`export function ${bridge.flusher}`)
      expect(aggregateFlush).toContain(bridge.flusher)
      expect(bridge.commands.length).toBeGreaterThan(0)
      expect(bridge.outcomes.length).toBeGreaterThan(0)
      if (bridge.registrationId) {
        expect(source).toContain(`registerPendingBridgePatchFlusher('${bridge.registrationId}', ${bridge.flusher})`)
      }
      expect(
        readFileSync(path.join(bridgeDirectory, bridge.file.replace('.ts', '.test.ts')), 'utf8').length,
      ).toBeGreaterThan(0)
    }
  })
})

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function serverProductionSourcesExceptEventCatalog(): string {
  const root = path.join(REPO_ROOT, 'server/fastify/src')
  const visit = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) return visit(absolute)
      if (!entry.name.endsWith('.ts') || absolute.endsWith(path.join('commands', 'events.ts'))) return []
      return [readFileSync(absolute, 'utf8')]
    })
  return visit(root).join('\n')
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function commandRoutePolicy(pathname: string): string {
  if (pathname.endsWith('/mutation-receipts/ack')) return 'receipt-acknowledgement'
  if (pathname.endsWith('/state/initialize')) return 'initialization'
  if (pathname.includes('/greetings/') && pathname.endsWith('/translate')) return 'async-revisioned'
  if (pathname.endsWith('/imports') || pathname.endsWith('/rebuilds')) return 'conditional-preview-or-revisioned'
  return 'revisioned'
}

function commandRouteDomain(pathname: string): string | null {
  const relative = pathname.replace('/api/v1/commands/', '')
  if (relative === 'state/initialize' || relative === 'mutation-receipts/ack') return 'command-control'
  if (relative === 'onboarding' || relative.startsWith('settings/')) return 'settings'
  if (/^(model-profiles|model-role-profiles|model-runtime-defaults|provider-credentials)(\/|$)/u.test(relative)) {
    return 'models-and-credentials'
  }
  if (/^(agents|agent-presets)(\/|$)/u.test(relative)) return 'agents-and-presets'
  if (/^bardwiki\//u.test(relative)) return 'bardwiki'
  if (/(^|\/)lorebooks(\/|$)/u.test(relative)) return 'lorebooks'
  if (/(^|\/)(scripts|triggers)(\/|$)/u.test(relative)) return 'script-definitions'
  if (/^(modules|module-folders|plugins|plugin-storage|inlay-assets)(\/|$)/u.test(relative)) return 'extensions'
  if (/^(characters|chats|chat-folders|messages)(\/|$)/u.test(relative)) return 'characters-chats-messages'
  if (
    /^(presets|model-presets|prompt-presets|legacy-bot-presets|prompt-settings|prompt-items|personas|translator-presets|loadouts)(\/|$)/u.test(
      relative,
    )
  ) {
    return 'presets-personas-loadouts'
  }
  return null
}

function eventResourceSwitchCases(source: string): string[] {
  const parsed = ts.createSourceFile('resourceInvalidation.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let resources: string[] | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isSwitchStatement(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'event' &&
      node.expression.name.text === 'resource'
    ) {
      resources = node.caseBlock.clauses.flatMap((clause) =>
        ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression) ? [clause.expression.text] : [],
      )
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  expect(resources).toBeDefined()
  return [...new Set(resources)].sort()
}
