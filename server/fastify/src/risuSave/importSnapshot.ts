import { canonicalizeLegacyGenerationValues } from '@risuai/shared-core/legacy-generation-value-canonicalization'
import { type RisuSaveUnsupportedReferenceKind, RisuSaveBlockType, decodeRisuSaveBlockEnvelope } from './blockCodec.js'
import {
  type RisuSaveEnvelopeKind,
  classifyRisuSaveEnvelope,
  decodeLegacyRisuSaveEnvelope,
} from './legacyEnvelopeCodec.js'
import type { ExpandedSizeLimitOptions } from './importLimits.js'
import {
  COLLECTION_FIELDS,
  repairPersistedHypaV3PresetSelectionIdentity,
  repairPersistedPersonaSelectionIdentity,
  ValidationError,
} from '../repository.js'
import { normalizePresetCollection } from '../commands/presets.js'
import { normalizePromptTemplateCollection } from '../commands/prompts.js'
import { normalizePersonaCollection } from '../commands/personas.js'
import { normalizeTranslatorPresetCollectionWithLegacyCompatibility } from '../commands/translatorPresets.js'
import { normalizeLoadoutCollection } from '../commands/loadouts.js'
import { normalizeAllChatMessages } from '../commands/messages.js'
import { normalizeCharacterCollection } from '../commands/characters.js'
import { ensureModuleRecords, ensureEnabledModules } from '../commands/modules.js'
import { ensurePluginRecords } from '../commands/plugins.js'
import { ensurePluginCustomStorage } from '../commands/pluginStorage.js'
import { ensureGlobalLorebookCollection, ensureAllChildLorebooks } from '../commands/lorebooks.js'
import { normalizeScriptDefinitionCollection } from '../commands/scriptDefinitions.js'
import { normalizeDatabaseDefaults } from '../databaseDefaults.js'
import { normalizeStoredChatGenerationSettings } from '../chatGenerationSettingsStorage.js'
import { CHAT_GENERATION_SETTINGS_FIELD } from '@risuai/shared-core/chat-generation-settings'
import { SERVER_SETTINGS_KEYS_BY_GROUP } from '@risuai/shared-core/settings-groups'
import {
  RISU_SERVER_DATA_KEY,
  emptyRisuServerPortableMetadata,
  validateRisuServerPortableMetadata,
  type RisuServerPortableMetadata,
} from './portableMetadata.js'
import {
  GREETING_TRANSLATIONS_PORTABLE_FIELD,
  GreetingTranslationValidationError,
  greetingSourceAtIndex,
  parsePortableGreetingTranslation,
  sourceHash,
  type GreetingTranslationRow,
} from '../translation/greetingTranslationStore.js'

type JsonRecord = Record<string, unknown>

const ROOT_COMPONENT_RESERVED_KEYS = new Set([
  'characters',
  'botPresets',
  'modules',
  'loadouts',
  'plugins',
  'pluginCustomStorage',
  '__directory',
  RISU_SERVER_DATA_KEY,
])

export const RISUSAVE_EMPTY_DATABASE_ERROR = 'risusave_empty_database'
export const RISUSAVE_INCOMPLETE_BLOCKS_ERROR = 'risusave_incomplete_blocks'

const RECOGNIZED_IMPORT_DATABASE_KEYS = new Set([
  // Current and historical database-level format markers.
  'formatversion',
  'version',
  // Whole-database resource families. Presence is intentional: legacy saves
  // may legitimately carry an empty collection or a malformed collection that
  // the compatibility normalizer repairs below.
  'characters',
  'pluginCustomStorage',
  ...COLLECTION_FIELDS,
  // The browser/server settings ownership catalog is the authoritative list of
  // persisted settings-bearing keys, including provider, prompt, display,
  // account, model-profile, and agent-preset settings.
  ...Object.values(SERVER_SETTINGS_KEYS_BY_GROUP).flat(),
])

export interface RisuSaveImportUnsupportedReference {
  name: string
  type: RisuSaveBlockType.REMOTE
  kind: RisuSaveUnsupportedReferenceKind
}

export interface RisuSaveImportSkippedBlock {
  name: string
  type: 'CHAT'
}

export interface RisuSaveImportSnapshot {
  envelope: RisuSaveEnvelopeKind
  database: JsonRecord
  portableMetadata: RisuServerPortableMetadata
  greetingTranslations: GreetingTranslationRow[]
  incompleteChatCount: number
  unsupportedReferences: RisuSaveImportUnsupportedReference[]
  skippedBlocks: RisuSaveImportSkippedBlock[]
}

export interface UnsupportedGroupCharacterSummary {
  id: string | null
  name: string | null
}

export class UnsupportedStandaloneChatBlocksError extends ValidationError {
  constructor() {
    super(
      'This save stores chats in standalone CHAT blocks, which this version of RisuAI cannot import. ' +
        'Nothing was imported, and the active database was not changed.',
    )
    this.name = 'UnsupportedStandaloneChatBlocksError'
  }
}

export class UnsupportedGroupCharactersError extends ValidationError {
  readonly count: number
  readonly groups: UnsupportedGroupCharacterSummary[]

  constructor(count: number, groups: UnsupportedGroupCharacterSummary[]) {
    const described = groups
      .slice(0, 5)
      .map((group) => group.name || group.id || 'unnamed group')
      .join(', ')
    const suffix = described ? `: ${described}${count > 5 ? ', …' : ''}` : ''
    super(
      `This backup contains ${count} unsupported group character${count === 1 ? '' : 's'}${suffix}. ` +
        'The active database was not changed.',
    )
    this.name = 'UnsupportedGroupCharactersError'
    this.count = count
    this.groups = groups
  }
}

export interface RisuSaveImportDatabaseNormalization {
  database: JsonRecord
  portableMetadata: RisuServerPortableMetadata
  greetingTranslations: GreetingTranslationRow[]
  incompleteChatCount: number
}

export function decodeRisuSaveImportSnapshot(
  data: Uint8Array,
  options: ExpandedSizeLimitOptions = {},
): RisuSaveImportSnapshot {
  const envelope = classifyRisuSaveEnvelope(data)
  if (envelope === 'legacy-raw' || envelope === 'legacy-compressed' || envelope === 'legacy-stream') {
    return {
      envelope,
      ...normalizeImportDatabase(decodeEnvelopeAsValidation(() => decodeLegacyRisuSaveEnvelope(data, options))),
      unsupportedReferences: [],
      skippedBlocks: [],
    }
  }

  if (envelope !== 'risusave-blocks') {
    throw new ValidationError(`Unsupported .risu envelope: ${envelope}`)
  }

  const decoded = decodeEnvelopeAsValidation(() => decodeRisuSaveBlockEnvelope(data, options))
  if (decoded.unsupportedReferences.some((reference) => reference.kind === 'cache-only')) {
    throw new ValidationError(RISUSAVE_INCOMPLETE_BLOCKS_ERROR)
  }
  const assembled = assembleBlockDatabase(decoded.blocks)
  return {
    envelope,
    ...normalizeImportDatabase(assembled.database),
    unsupportedReferences: decoded.unsupportedReferences,
    skippedBlocks: assembled.skippedBlocks,
  }
}

/**
 * The low-level envelope decoders throw plain Errors for malformed structures
 * (truncated headers, bad gzip, unparsable directory JSON). Uploaded saves are
 * untrusted input, so surface those as ValidationError (400) rather than
 * letting them bubble up as internal 500s. ValidationErrors pass through.
 */
function decodeEnvelopeAsValidation<T>(decode: () => T): T {
  try {
    return decode()
  } catch (err) {
    if (err instanceof ValidationError) throw err
    throw new ValidationError(err instanceof Error ? err.message : 'Malformed .risu save envelope')
  }
}

export function normalizeRisuSaveImportDatabase(database: unknown): JsonRecord {
  return normalizeImportDatabase(database).database
}

export function normalizeRisuSaveJsonImportSnapshot(database: unknown): RisuSaveImportDatabaseNormalization {
  return normalizeImportDatabase(database)
}

export function normalizeRisuSaveSnapshotDatabase(database: unknown): JsonRecord {
  return normalizeImportDatabaseShape(database)
}

function assembleBlockDatabase(blocks: ReturnType<typeof decodeRisuSaveBlockEnvelope>['blocks']): {
  database: JsonRecord
  skippedBlocks: RisuSaveImportSkippedBlock[]
} {
  const database: JsonRecord = {}
  const skippedBlocks: RisuSaveImportSkippedBlock[] = []
  let sawRoot = false
  const singletonTypes = new Set<RisuSaveBlockType>()
  const singletonBlockTypes = new Set([
    RisuSaveBlockType.ROOT,
    RisuSaveBlockType.BOTPRESET,
    RisuSaveBlockType.MODULES,
    RisuSaveBlockType.PLUGINS,
    RisuSaveBlockType.LOADOUTS,
    RisuSaveBlockType.PLUGIN_STORAGE,
    RisuSaveBlockType.CONFIG,
  ])
  const rootComponentKeys = new Set<string>()

  for (const block of blocks) {
    if (block.unsupportedReference) continue
    if (block.type === RisuSaveBlockType.CHAT) {
      skippedBlocks.push({ name: block.name, type: 'CHAT' })
      continue
    }
    if (block.content === null) {
      throw new ValidationError(`RISUSAVE block ${block.name} has no content`)
    }
    if (singletonBlockTypes.has(block.type)) {
      if (singletonTypes.has(block.type)) {
        throw new ValidationError(`RISUSAVE save contains duplicate singleton block type ${block.type}`)
      }
      singletonTypes.add(block.type)
    }

    const parsed = parseBlockJson(block.name, block.content)
    switch (block.type) {
      case RisuSaveBlockType.ROOT:
        sawRoot = true
        Object.assign(database, omitDirectory(readJsonObject(parsed, `${block.name} block`)))
        break
      case RisuSaveBlockType.CHARACTER_WITH_CHAT:
      case RisuSaveBlockType.CHARACTER_WITHOUT_CHAT:
        database.characters ??= []
        if (!Array.isArray(database.characters)) {
          throw new ValidationError('characters must be an array')
        }
        database.characters.push(readJsonObject(parsed, `${block.name} block`))
        break
      case RisuSaveBlockType.BOTPRESET:
        database.botPresets = readJsonArray(parsed, `${block.name} block`)
        break
      case RisuSaveBlockType.MODULES:
        database.modules = readJsonArray(parsed, `${block.name} block`)
        break
      case RisuSaveBlockType.PLUGINS:
        database.plugins = readJsonArray(parsed, `${block.name} block`)
        break
      case RisuSaveBlockType.LOADOUTS:
        database.loadouts = readJsonArray(parsed, `${block.name} block`)
        break
      case RisuSaveBlockType.PLUGIN_STORAGE:
        database.pluginCustomStorage = readJsonObject(parsed, `${block.name} block`)
        break
      case RisuSaveBlockType.CONFIG:
        readJsonObject(parsed, `${block.name} block`)
        break
      case RisuSaveBlockType.ROOT_COMPONENT: {
        const component = readJsonObject(parsed, `${block.name} block`)
        if (typeof component.key !== 'string' || component.key.trim() === '') {
          throw new ValidationError(`${block.name} block key must be a non-empty string`)
        }
        if (ROOT_COMPONENT_RESERVED_KEYS.has(component.key)) {
          throw new ValidationError(`${block.name} block key ${component.key} is reserved for resource blocks`)
        }
        if (rootComponentKeys.has(component.key)) {
          throw new ValidationError(`${block.name} block key ${component.key} duplicates another root component`)
        }
        rootComponentKeys.add(component.key)
        database[component.key] = cloneJson(component.data)
        break
      }
      case RisuSaveBlockType.REMOTE:
        break
      default:
        throw new ValidationError(`Unsupported RISUSAVE block type ${block.type} for ${block.name}`)
    }
  }

  if (!sawRoot) {
    throw new ValidationError('RISUSAVE block save must include a root block')
  }

  return { database, skippedBlocks }
}

function normalizeImportDatabase(database: unknown): RisuSaveImportDatabaseNormalization {
  const extracted = extractPortableMetadata(database)
  assertRecognizedImportDatabase(extracted.database)
  rejectUnsupportedGroupCharacters(extracted.database)
  assertPortableGreetingTranslationCharacterIds(extracted.database)
  const target = normalizeImportDatabaseShape(extracted.database)
  const portable = extractPortableGreetingTranslations(target)
  return {
    database: portable.database,
    portableMetadata: extracted.portableMetadata,
    greetingTranslations: portable.rows,
    incompleteChatCount: normalizeImportedChatGenerationSettings(target),
  }
}

function assertPortableGreetingTranslationCharacterIds(database: JsonRecord): void {
  if (!Array.isArray(database.characters)) return
  for (let characterIndex = 0; characterIndex < database.characters.length; characterIndex += 1) {
    const character = database.characters[characterIndex]
    if (!isJsonRecord(character)) continue
    const portable = character[GREETING_TRANSLATIONS_PORTABLE_FIELD]
    if (
      Array.isArray(portable) &&
      portable.length > 0 &&
      (typeof character.chaId !== 'string' || character.chaId.trim() === '')
    ) {
      throw new ValidationError(
        `database.characters[${characterIndex}].chaId must be a non-empty string when greeting translations exist`,
      )
    }
  }
}

function extractPortableGreetingTranslations(database: JsonRecord): {
  database: JsonRecord
  rows: GreetingTranslationRow[]
} {
  if (!Array.isArray(database.characters)) return { database, rows: [] }
  const rows: GreetingTranslationRow[] = []
  const identities = new Set<string>()
  const characters = database.characters.map((value, characterIndex) => {
    if (!isJsonRecord(value)) return value
    const character = { ...value }
    const portable = character[GREETING_TRANSLATIONS_PORTABLE_FIELD]
    delete character[GREETING_TRANSLATIONS_PORTABLE_FIELD]
    if (portable === undefined) return character
    if (!Array.isArray(portable)) {
      throw new ValidationError(
        `database.characters[${characterIndex}].${GREETING_TRANSLATIONS_PORTABLE_FIELD} must be an array`,
      )
    }
    if (portable.length > 0 && (typeof character.chaId !== 'string' || character.chaId.trim() === '')) {
      throw new ValidationError(
        `database.characters[${characterIndex}].chaId must be a non-empty string when greeting translations exist`,
      )
    }
    for (let rowIndex = 0; rowIndex < portable.length; rowIndex += 1) {
      const label = `database.characters[${characterIndex}].${GREETING_TRANSLATIONS_PORTABLE_FIELD}[${rowIndex}]`
      let parsed
      try {
        parsed = parsePortableGreetingTranslation(portable[rowIndex], label)
      } catch (error) {
        if (error instanceof GreetingTranslationValidationError) {
          throw new ValidationError(error.message)
        }
        throw error
      }
      const identity = `${character.chaId}\u0000${parsed.greetingIndex}\u0000${parsed.settingsHash}`
      if (identities.has(identity)) {
        throw new ValidationError(`${label} duplicates another greeting translation row`)
      }
      identities.add(identity)
      const source = greetingSourceAtIndex(character, parsed.greetingIndex)
      if (source === null || sourceHash(source) !== parsed.translation.sourceHash) continue
      rows.push({
        characterId: character.chaId as string,
        greetingIndex: parsed.greetingIndex,
        settingsHash: parsed.settingsHash,
        sourceHash: parsed.translation.sourceHash,
        translation: parsed.translation,
        updatedAt: parsed.translation.updatedAt,
      })
    }
    return character
  })
  return { database: { ...database, characters }, rows }
}

function extractPortableMetadata(database: unknown): {
  database: JsonRecord
  portableMetadata: RisuServerPortableMetadata
} {
  const source = readJsonObject(database, 'database')
  const domainDatabase = { ...source }
  const portableMetadata = hasOwn(source, RISU_SERVER_DATA_KEY)
    ? validateRisuServerPortableMetadata(source[RISU_SERVER_DATA_KEY])
    : emptyRisuServerPortableMetadata()
  delete domainDatabase[RISU_SERVER_DATA_KEY]
  return { database: domainDatabase, portableMetadata }
}

function assertRecognizedImportDatabase(database: unknown): void {
  const record = readJsonObject(database, 'database')
  if (!Object.keys(record).some((key) => RECOGNIZED_IMPORT_DATABASE_KEYS.has(key))) {
    throw new ValidationError(RISUSAVE_EMPTY_DATABASE_ERROR)
  }
}

function rejectUnsupportedGroupCharacters(database: unknown): void {
  if (!isJsonRecord(database) || !Array.isArray(database.characters)) return

  const groups: UnsupportedGroupCharacterSummary[] = []
  let count = 0
  for (const character of database.characters) {
    if (!isJsonRecord(character) || character.type !== 'group') continue
    count += 1
    if (groups.length >= 50) continue
    groups.push({
      id:
        typeof character.chaId === 'string' && character.chaId.trim()
          ? character.chaId
          : typeof character.id === 'string' && character.id.trim()
            ? character.id
            : null,
      name:
        typeof character.name === 'string' && character.name.trim()
          ? character.name
          : typeof character.displayName === 'string' && character.displayName.trim()
            ? character.displayName
            : null,
    })
  }
  if (count > 0) throw new UnsupportedGroupCharactersError(count, groups)
}

function normalizeImportDatabaseShape(database: unknown): JsonRecord {
  const target = readJsonObject(cloneJson(database), 'database')
  normalizeAllChatMessages(target)
  normalizeCharacterCollection(target)

  normalizePresetCollection(target)
  normalizePromptTemplateCollection(target)
  if (
    hasAnyKey(target, ['personas', 'selectedPersonaId', 'selectedPersona', 'username', 'userIcon', 'personaPrompt'])
  ) {
    repairPersistedPersonaSelectionIdentity(target)
    normalizePersonaCollection(target)
  }
  if (hasAnyKey(target, ['translatorPresets', 'translatorPresetId', 'translatorPrompt', 'translatorMaxResponse'])) {
    normalizeTranslatorPresetCollectionWithLegacyCompatibility(target)
  }
  normalizeLoadoutCollection(target)
  ensureModuleRecords(target)
  ensureEnabledModules(target)
  ensurePluginRecords(target)
  if (typeof target.currentPluginProvider !== 'string') target.currentPluginProvider = ''
  ensurePluginCustomStorage(target)
  ensureAllChildLorebooks(target)
  normalizeScriptDefinitionCollection(target)

  const normalized = normalizeDatabaseDefaults(target, { providerDefaults: false })
  // Defaults may create the first global lorebook after the earlier import
  // repair passes. Run the authoritative repair after defaults so imported
  // rows always reach SQLite with stable book and entry ids.
  ensureGlobalLorebookCollection(normalized)
  repairPersistedHypaV3PresetSelectionIdentity(normalized)
  if (Array.isArray(normalized.botPresets)) {
    normalized.botPresets = normalized.botPresets.map(canonicalizeLegacyGenerationValues)
  }
  return canonicalizeLegacyGenerationValues(normalized) as JsonRecord
}

function normalizeImportedChatGenerationSettings(database: JsonRecord): number {
  if (!Array.isArray(database.characters)) return 0

  const translatorPresetIds = new Set(
    (Array.isArray(database.translatorPresets) ? database.translatorPresets : []).flatMap((preset) =>
      isJsonRecord(preset) && typeof preset.id === 'string' && preset.id.trim() ? [preset.id] : [],
    ),
  )
  let chatCount = 0
  for (const character of database.characters) {
    if (!isJsonRecord(character) || !Array.isArray(character.chats)) continue
    for (const chat of character.chats) {
      if (!isJsonRecord(chat)) continue
      chatCount += 1
      if (typeof chat.translatorPresetId !== 'string' || !translatorPresetIds.has(chat.translatorPresetId)) {
        delete chat.translatorPresetId
      }
      if (!hasOwn(chat, CHAT_GENERATION_SETTINGS_FIELD)) continue

      const normalized = normalizeStoredChatGenerationSettings(chat[CHAT_GENERATION_SETTINGS_FIELD])
      if (normalized) {
        chat[CHAT_GENERATION_SETTINGS_FIELD] = {
          ...normalized,
          configured: false,
        }
      } else {
        delete chat[CHAT_GENERATION_SETTINGS_FIELD]
      }
    }
  }

  return chatCount
}

function parseBlockJson(name: string, content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    throw new ValidationError(`RISUSAVE block ${name} must contain valid JSON`)
  }
}

function readJsonObject(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`)
  }
  validateJsonValue(label, value)
  return value as JsonRecord
}

function readJsonArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${label} must be an array`)
  }
  validateJsonValue(label, value)
  return value
}

function omitDirectory(root: JsonRecord): JsonRecord {
  const next: JsonRecord = {}
  for (const [key, value] of Object.entries(root)) {
    if (key === '__directory') continue
    next[key] = value
  }
  return next
}

function hasAnyKey(record: JsonRecord, keys: readonly string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(record, key))
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function validateJsonValue(label: string, value: unknown): void {
  if (value === undefined) {
    throw new ValidationError(`${label} must be JSON-serializable`)
  }
  try {
    JSON.stringify(value)
  } catch {
    throw new ValidationError(`${label} must be JSON-serializable`)
  }
}
