import { buildRisuSaveAssetReport } from './risuSave/assetReferences.js'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AcceptedEffectiveGenerationConfiguration } from './prompt/assemble.js'
import {
  canonicalizeGenerationOperationSemantics,
  assertGenerationEffectiveConfigurationFingerprint,
} from './generationOperations.js'
import {
  GenerationSettingsOwners,
  FastifyCharacterOwners,
  FastifyChatOwners,
  selectFixedFields,
  translationPolicyFields,
  ModuleOwners,
  imageGenerationPolicyFields,
  openAiCompatibleImageOwners,
} from './generationConfigurationManifest.js'
import { PROVIDER_SECRET_PATHS, PROVIDER_SECRET_PATH_WILDCARD } from '@risuai/shared-core/provider-secret-mask'

type RecordValue = Record<string, unknown>
const generatedReferences = new WeakSet<object>()
type Reference = { $generationDependency: string; kind: 'configuration' | 'secret' | 'assets' }
export interface StoredGenerationConfiguration {
  version: 2
  contractVersion: 1
  configuration: RecordValue
  assets: Reference
}

export function createGenerationConfigurationTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS generation_configuration_dependencies (
      hash TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('configuration', 'secret', 'assets')),
      json TEXT NOT NULL CHECK (json_valid(json)),
      asset_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(asset_ids_json)),
      CHECK (kind <> 'assets' OR json = asset_ids_json)
    );
  `)
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function hash(kind: string, json: string): string {
  return createHash('sha256').update(kind).update('\0').update(json).digest('hex')
}
function put(db: DatabaseSync, kind: Reference['kind'], value: unknown, assetIds: string[] = []): Reference {
  const json = canonicalizeGenerationOperationSemantics(value)
  const digest = hash(kind, json)
  const existing = db
    .prepare('SELECT kind, json FROM generation_configuration_dependencies WHERE hash = ?')
    .get(digest) as { kind: string; json: string } | undefined
  if (existing && (existing.kind !== kind || existing.json !== json))
    throw new Error('generation_configuration_dependency_corrupt')
  if (!existing) {
    db.prepare(
      'INSERT INTO generation_configuration_dependencies (hash, kind, json, asset_ids_json) VALUES (?, ?, ?, ?)',
    ).run(digest, kind, json, JSON.stringify(assetIds))
  }
  const reference = { $generationDependency: digest, kind }
  generatedReferences.add(reference)
  return reference
}

/** Fixed fields only, preserving absent/null values and the ordered candidate
 * sets selected by the repository. Runtime owners are supplied by consumers. */
export function projectGenerationConfiguration(
  input: AcceptedEffectiveGenerationConfiguration,
): AcceptedEffectiveGenerationConfiguration {
  const database = input.database as unknown as RecordValue
  const projected = selectFixedFields(database, GenerationSettingsOwners)
  for (const key of imageGenerationPolicyFields) {
    if (Object.hasOwn(database, key)) projected[key] = database[key]
  }
  if (Object.hasOwn(database, 'openaiCompatImage')) {
    projected.openaiCompatImage = record(database.openaiCompatImage)
      ? selectFixedFields(database.openaiCompatImage, openAiCompatibleImageOwners)
      : database.openaiCompatImage
  }
  // Kei consumes the account token, not the account's unrelated profile/cache.
  if (record(database.account)) projected.account = selectFixedFields(database.account, { token: 'fixed' })
  if (Array.isArray(database.modules))
    projected.modules = database.modules.map((module) =>
      record(module) ? selectFixedFields(module, ModuleOwners) : module,
    )
  projected.characters = input.database.characters.map((character) => {
    const selected = selectFixedFields(character as unknown as RecordValue, FastifyCharacterOwners)
    selected.chatFolders = []
    selected.chats = character.chats.map((chat) => ({
      ...selectFixedFields(chat as unknown as RecordValue, FastifyChatOwners),
      message: [],
    }))
    return selected
  })
  if (Object.hasOwn(database, 'currentChar')) projected.currentChar = database.currentChar
  const translation = input.translationSettings ?? {}
  const fixedTranslation = selectFixedFields(translation, GenerationSettingsOwners)
  if (Array.isArray(fixedTranslation.modules))
    fixedTranslation.modules = fixedTranslation.modules.map((module) =>
      record(module) ? selectFixedFields(module, ModuleOwners) : module,
    )
  for (const key of translationPolicyFields) {
    if (Object.hasOwn(translation, key)) fixedTranslation[key] = translation[key]
    else if (Object.hasOwn(database, key)) fixedTranslation[key] = database[key]
  }
  return {
    ...input,
    database: projected as unknown as AcceptedEffectiveGenerationConfiguration['database'],
    translationSettings: fixedTranslation,
  }
}

/** Only call inside acceptance's transaction: rollback removes new dependencies
 * as well as the operation. References preserve array order and duplicate rows. */
export function storeGenerationConfiguration(
  db: DatabaseSync,
  input: AcceptedEffectiveGenerationConfiguration,
): StoredGenerationConfiguration {
  if (!db.isTransaction) throw new Error('Generation configuration capture requires an acceptance transaction')
  const configuration = structuredClone(projectGenerationConfiguration(input)) as unknown as RecordValue
  const assetIds = buildRisuSaveAssetReport(configuration.database, []).referenced.map((reference) => reference.id)
  // Secret fields are stored separately from ordinary configuration payloads.
  // Durable credential IDs are refreshed at dispatch; legacy flat credentials
  // keep their accepted value through these separately classified references.
  for (const owner of [configuration.database, configuration.translationSettings]) {
    for (const path of PROVIDER_SECRET_PATHS) separateSecrets(db, owner, path)
  }
  if (record(configuration.resolvedMainProfile)) {
    const options = configuration.resolvedMainProfile.providerOptions
    separateSecrets(db, options, ['apiKey'])
    separateSecrets(db, options, ['vertex', 'privateKey'])
    separateSecrets(db, options, ['ollama', 'apiKey'])
    separateSecrets(db, options, ['customModel', 'key'])
    const capability = configuration.resolvedMainProfile.providerCapabilityInput
    if (record(capability)) {
      for (const path of PROVIDER_SECRET_PATHS) separateSecrets(db, capability.config, path)
      separateSecrets(db, capability.config, ['oaiCompApiKeys', PROVIDER_SECRET_PATH_WILDCARD])
    }
  }
  // These are independent immutable definitions/catalogs, not scalar policy.
  // Sharing by content also deduplicates flattened templates and preset copies.
  const catalogFields = new Set([
    'modules',
    'modelPresets',
    'promptPresets',
    'personas',
    'hypaV3Presets',
    'agents',
    'agentPresets',
    'modelProfiles',
    'providerCredentials',
    'customModels',
    'translatorPresets',
  ])
  const sharedFields = new Set([
    'assets',
    'additionalAssets',
    'emotionImages',
    'globalLore',
    'localLore',
    'promptTemplate',
    'globalscript',
    'presetRegex',
    'customscript',
    'triggerscript',
  ])
  function pin(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(pin)
    if (!record(value)) return value
    if (generatedReferences.has(value)) return value
    if (Object.hasOwn(value, '$generationDependency') || Object.hasOwn(value, '$generationObject')) {
      return { $generationObject: Object.entries(value).map(([key, child]) => [key, pin(child)]) }
    }
    const result: RecordValue = Object.create(null)
    for (const [key, child] of Object.entries(value)) {
      if (catalogFields.has(key) && Array.isArray(child)) {
        result[key] = child.map((row) => put(db, 'configuration', pin(row)))
      } else if (sharedFields.has(key) && child !== undefined && child !== null) {
        result[key] = put(db, 'configuration', pin(child))
      } else result[key] = pin(child)
    }
    return result
  }
  return {
    version: 2,
    contractVersion: 1,
    configuration: pin(configuration) as RecordValue,
    assets: put(db, 'assets', assetIds, assetIds),
  }
}

function separateSecrets(
  db: DatabaseSync,
  owner: unknown,
  path: readonly (string | typeof PROVIDER_SECRET_PATH_WILDCARD)[],
): void {
  if (!owner || typeof owner !== 'object' || path.length === 0) return
  const [key, ...rest] = path
  if (key === PROVIDER_SECRET_PATH_WILDCARD) {
    for (const entry of Object.keys(owner)) separateSecrets(db, owner, [entry, ...rest])
    return
  }
  const target = owner as RecordValue
  if (!Object.hasOwn(target, key)) return
  if (rest.length) separateSecrets(db, target[key], rest)
  else if (typeof target[key] === 'string' && target[key] !== '') target[key] = put(db, 'secret', target[key])
}

/** Verify the bounded manifest first, then every referenced payload. A missing
 * version never falls back to current settings. Legacy fingerprints stay intact. */
export function resolveGenerationConfiguration(
  db: DatabaseSync,
  stored: unknown,
  fingerprint: string | undefined,
): AcceptedEffectiveGenerationConfiguration {
  assertGenerationEffectiveConfigurationFingerprint(stored, fingerprint)
  if (!record(stored)) throw new Error('generation_configuration_invalid')
  if (stored.version === 1 && record(stored.database)) {
    return structuredClone(stored) as unknown as AcceptedEffectiveGenerationConfiguration
  }
  if (stored.version !== 2 || stored.contractVersion !== 1 || !record(stored.configuration)) {
    throw new Error('generation_configuration_version_unsupported')
  }
  const active = new Set<string>()
  const cache = new Map<string, unknown>()
  function hydrate(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(hydrate)
    if (!record(value)) return value
    if (Object.hasOwn(value, '$generationObject')) {
      if (Object.keys(value).length !== 1 || !Array.isArray(value.$generationObject))
        throw new Error('generation_configuration_dependency_invalid')
      return Object.fromEntries(
        value.$generationObject.map((entry) => {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')
            throw new Error('generation_configuration_dependency_invalid')
          return [entry[0], hydrate(entry[1])]
        }),
      )
    }
    if (Object.hasOwn(value, '$generationDependency')) {
      if (
        typeof value.$generationDependency !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.$generationDependency) ||
        (value.kind !== 'configuration' && value.kind !== 'secret' && value.kind !== 'assets') ||
        Object.keys(value).length !== 2
      ) {
        throw new Error('generation_configuration_dependency_invalid')
      }
      const digest = value.$generationDependency
      if (active.has(digest)) throw new Error('generation_configuration_dependency_cycle')
      if (cache.has(digest)) return structuredClone(cache.get(digest))
      const row = db
        .prepare('SELECT kind, json FROM generation_configuration_dependencies WHERE hash = ?')
        .get(digest) as { kind: string; json: string } | undefined
      if (!row) throw new Error('generation_configuration_dependency_missing')
      if (row.kind !== value.kind || hash(row.kind, row.json) !== digest) {
        throw new Error('generation_configuration_dependency_corrupt')
      }
      active.add(digest)
      const result = hydrate(JSON.parse(row.json))
      active.delete(digest)
      cache.set(digest, result)
      return structuredClone(result)
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, hydrate(child)]))
  }
  const retainedAssets = hydrate(stored.assets)
  if (
    !Array.isArray(retainedAssets) ||
    retainedAssets.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
  )
    throw new Error('generation_configuration_asset_index_invalid')
  const configuration = hydrate(stored.configuration)
  if (!record(configuration) || configuration.version !== 1 || !record(configuration.database)) {
    throw new Error('generation_configuration_invalid')
  }
  configuration.database.acceptedCredentialPolicy = 'live-id-v1'
  return configuration as unknown as AcceptedEffectiveGenerationConfiguration
}

/** Follow-up consumers call this after validating their source/terminal binding.
 * Settings remain accepted; chat variables and memory pointers belong to runtime. */
export function overlayGenerationChatRuntime(db: DatabaseSync, chat: RecordValue): void {
  if (typeof chat.id !== 'string') throw new Error('generation_configuration_chat_missing')
  const row = db.prepare('SELECT data_json FROM chats WHERE id = ?').get(chat.id) as { data_json: string } | undefined
  if (!row) throw new Error('generation_configuration_chat_missing')
  const live = JSON.parse(row.data_json) as RecordValue
  for (const field of ['scriptstate', 'lastMemory', 'hypaContextTruncationAcknowledged'] as const) {
    if (Object.hasOwn(live, field)) chat[field] = structuredClone(live[field])
    else delete chat[field]
  }
}

/** Retain all accepted operations, including retryable terminal ones. Child jobs
 * retain their parent operation; backups own independent SQLite copies. */
export function pruneGenerationConfigurationDependencies(db: DatabaseSync): number {
  if (!db.isTransaction) throw new Error('Generation configuration pruning requires a transaction')
  const reachable = new Set<string>()
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (!record(value)) return
    if (typeof value.$generationDependency === 'string') {
      const digest = value.$generationDependency
      if (reachable.has(digest)) return
      reachable.add(digest)
      const row = db.prepare('SELECT json FROM generation_configuration_dependencies WHERE hash = ?').get(digest) as
        | { json: string }
        | undefined
      if (!row) throw new Error('generation_configuration_dependency_missing')
      visit(JSON.parse(row.json))
    } else for (const child of Object.values(value)) visit(child)
  }
  for (const row of db
    .prepare(
      'SELECT effective_configuration_json AS json FROM generation_operations WHERE effective_configuration_json IS NOT NULL',
    )
    .all() as { json: string }[]) {
    const value: unknown = JSON.parse(row.json)
    if (record(value) && value.version === 2) visit(value)
  }
  let removed = 0
  for (const row of db.prepare('SELECT hash FROM generation_configuration_dependencies').all() as { hash: string }[]) {
    if (!reachable.has(row.hash))
      removed += Number(
        db.prepare('DELETE FROM generation_configuration_dependencies WHERE hash = ?').run(row.hash).changes,
      )
  }
  return removed
}
