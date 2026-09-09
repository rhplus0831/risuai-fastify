import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { backup as backupSqliteDatabase, DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { SERVER_CHARACTER_SHELL_MARKER, type ServerCharacterSummary } from '@risuai/protocol/character-summary-resource'
import {
  createInitialDatabase,
  migrateLegacyFlatModelConfiguration,
  normalizeDatabaseDefaults,
} from './databaseDefaults.js'
import { rebuildAllBardWikiDerivedState } from './bardWikiRepository.js'
import {
  normalizeStoredChatGenerationSettings,
  repairStoredChatGenerationSettings,
} from './chatGenerationSettingsStorage.js'
import { DEFAULT_AUTOMATIC_BACKUP_RETENTION } from './config.js'
import { getMaintenanceCoordinator, MaintenanceBusyError, type MaintenanceLease } from './maintenanceCoordinator.js'
import { BackupAssetError, copyBackupAssets, copyBackupDirectory } from './backupFiles.js'
import { BackupCopyPool } from './backupCopyPool.js'
import { scanAssetReferences, type AssetReferenceMarks } from './assetReferenceScan.js'
import { setImmediate as yieldMaintenanceTurn } from 'node:timers/promises'
import { getSchemaState } from './db.js'
import { repairLegacyLocalStopStrings } from '@risuai/shared-core/local-stop-strings'
import { assessDatabaseInitialization, InitializeConflictError } from './databaseInitialization.js'
import { COMMAND_EVENT_CATALOG, persistRevisionedCommandEvent, type CommandEvent } from './commands/events.js'
import { getDatabaseLineage, getDatabaseWriterMetadata, rotateDatabaseLineage } from './databaseLineage.js'
import { recordTableWrite } from './protocolMetrics.js'
import {
  readDisplaySourceData,
  parseDisplaySourceJson,
  type DisplaySourceLoadMeasurement,
  type DisplaySourceDiagnostics,
} from './displaySourceDiagnostics.js'
import { bumpGenerationOperationProjectionEpoch, createGenerationOperationTables } from './generationOperations.js'
import {
  GREETING_TRANSLATIONS_PORTABLE_FIELD,
  listGreetingTranslationsForRewrite,
  replaceGreetingTranslationsForImport,
  type GreetingTranslationRow,
} from './translation/greetingTranslationStore.js'
import {
  applyChatMessageDiff,
  deleteChatHypaV3,
  deleteChatMessages,
  getAlternateMessagesGroupedByIds,
  getAllChatAlternateMessagesGrouped,
  getAllChatHypaV3Grouped,
  getAllChatMessagesGrouped,
  getAlternateMessages,
  getChatHypaV3,
  getChatHypaV3GroupedByIds,
  getChatMessages,
  getChatMessagesRange,
  getChatMessagesGroupedByIds,
  getActiveMessageLocationById,
  insertAllChatAlternateMessages,
  replaceAllChatHypaV3,
  replaceAllChatMessages,
  setChatHypaV3,
  countChatMessages,
} from './messageStore.js'
import {
  repairPersonaSelectionIdentity,
  selectedPersonaIndexFromStableId,
} from '@risuai/shared-core/persona-selection-identity'
import {
  hypaV3PresetIndexFromStableId,
  repairHypaV3PresetSelectionIdentity,
} from '@risuai/shared-core/hypa-v3-preset-selection-identity'
import { normalizeAgentConfiguration, normalizeAgentPresetDefaultId } from '@risuai/shared-core/agent-preset-records'
import { getCanonicalTranslatorPresets } from '@risuai/shared-core/translator-presets'
import { parseModuleIntegration, resolveAgentPresetModuleIntegration } from '@risuai/shared-core/module-integration'
import { resolveEffectiveAgentPresetId } from '@risuai/shared-core/agent-preset-resolver'

const PLUGIN_CUSTOM_STORAGE_EMPTY_SENTINEL_KEY = '__risu_internal_plugin_custom_storage_empty__'

export const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'application/x-onnx': 'onnx',
  'application/x-risu-inlay-signature+json': 'json',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/webm': 'weba',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'image/svg+xml': 'svg',
  'text/css': 'css',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
}

export const SUPPORTED_ASSET_CONTENT_TYPES = Object.keys(CONTENT_TYPE_EXTENSIONS)

const SHA256_RE = /^[a-f0-9]{64}$/

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.byteLength < offset + value.length) return false
  return [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0))
}

/** Detect media types whose picker-facing formats have stable magic bytes. */
export function detectAssetContentType(bytes: Uint8Array): string | null {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return 'image/gif'
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp'
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WAVE')) return 'audio/wav'
  if (asciiAt(bytes, 0, 'OggS')) return 'audio/ogg'
  if (asciiAt(bytes, 0, 'fLaC')) return 'audio/flac'
  if (asciiAt(bytes, 0, 'ID3')) return 'audio/mpeg'
  if (bytes[0] === 0xff && bytes.byteLength >= 2 && (bytes[1] & 0xf0) === 0xf0) {
    return (bytes[1] & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg'
  }
  if (asciiAt(bytes, 4, 'ftyp')) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12))
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (['isom', 'iso2', 'mp41', 'mp42', 'M4V ', 'qt  '].includes(brand)) return 'video/mp4'
  }
  return null
}

/**
 * Cards in the wild routinely lie about asset extensions (e.g. WebP bytes in a
 * `.png` asset), so a declared type that disagrees with recognizable magic
 * bytes is coerced to the detected type instead of rejected.
 */
function resolveEffectiveAssetContentType(asset: AddAssetInput): string {
  const detectedContentType = detectAssetContentType(asset.bytes)
  return detectedContentType ?? asset.contentType
}

export function isValidAssetId(id: string): boolean {
  return SHA256_RE.test(id)
}

export const PERSISTED_VERSION = 1

export interface PersistedAsset {
  id: string
  ext: string
  size: number
  contentType: string
}

export type PersistedInlayCatalogAssetType = 'image' | 'video' | 'audio' | 'signature'

export interface PersistedInlayCatalogEntry {
  assetId: string
  aliases: string[]
  ext: string
  height?: number
  name: string
  size: number
  type: PersistedInlayCatalogAssetType
  width?: number
}

interface AssetMetadataRow {
  id: string
  ext: string
  size: number
  content_type: string
}

function rowToPersistedAsset(row: AssetMetadataRow): PersistedAsset {
  return { id: row.id, ext: row.ext, size: row.size, contentType: row.content_type }
}

export const COLLECTION_FIELDS = [
  'modules',
  'plugins',
  'modelPresets',
  'promptPresets',
  'botPresets',
  'promptTemplate',
  'personas',
  'loadouts',
  'loreBook',
  'translatorPresets',
  'hypaV3Presets',
] as const

export type CollectionFieldKey = (typeof COLLECTION_FIELDS)[number]

const NON_SETTINGS_FIELDS = new Set<string>(['characters', ...COLLECTION_FIELDS, 'pluginCustomStorage'])

const COLLECTION_TABLE_MAP: Record<string, string> = {
  modules: 'modules',
  plugins: 'plugins',
  modelPresets: 'model_presets',
  promptPresets: 'prompt_presets',
  botPresets: 'bot_presets',
  promptTemplate: 'prompt_templates',
  personas: 'personas',
  loadouts: 'loadouts',
  loreBook: 'lore_books',
  translatorPresets: 'translator_presets',
  hypaV3Presets: 'hypa_v3_presets',
}

const MODEL_PROFILE_INLINE_SECRET_PRESET_TABLES = ['bot_presets', 'model_presets'] as const

export function createCollectionTables(db: DatabaseSync): void {
  for (const tableName of Object.values(COLLECTION_TABLE_MAP)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        position INTEGER PRIMARY KEY,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      )
    `)
  }
  // These non-unique derived indexes preserve imported duplicate-ID semantics
  // while keeping selected generation reads off unrelated collection JSON.
  for (const tableName of ['modules', 'model_presets', 'prompt_presets', 'personas', 'hypa_v3_presets']) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_generation_${tableName}_id ON ${tableName} (json_extract(data_json, '$.id'))`,
    )
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_generation_modules_namespace ON modules (json_extract(data_json, '$.namespace'))",
  )
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_custom_storage (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL CHECK (json_valid(value_json))
    )
  `)
}

/**
 * Persisted global lorebook ids are API identities. Repair them before a row
 * reaches a resource response or command baseline; otherwise the browser and
 * server can independently mint different ids for the same legacy row.
 */
export function repairPersistedGlobalLorebookIds(database: unknown): boolean {
  if (!isRecord(database) || !Array.isArray(database.loreBook)) return false

  let changed = false
  const lorebookIds = new Set<string>()
  for (const rawLorebook of database.loreBook) {
    if (!isRecord(rawLorebook)) continue

    let lorebookId = typeof rawLorebook.id === 'string' && rawLorebook.id.trim() ? rawLorebook.id : ''
    if (!lorebookId || lorebookIds.has(lorebookId)) {
      lorebookId = randomUUID()
      rawLorebook.id = lorebookId
      changed = true
    }
    lorebookIds.add(lorebookId)

    if (!Array.isArray(rawLorebook.data)) continue
    const entryIds = new Set<string>()
    for (const rawEntry of rawLorebook.data) {
      if (!isRecord(rawEntry)) continue
      let entryId = typeof rawEntry.id === 'string' && rawEntry.id.trim() ? rawEntry.id : ''
      if (!entryId || entryIds.has(entryId)) {
        entryId = randomUUID()
        rawEntry.id = entryId
        changed = true
      }
      entryIds.add(entryId)
    }
  }
  return changed
}

export function repairPersistedGlobalLorebookIdsInSqlite(db: DatabaseSync): boolean {
  let changed = false
  const rows = db.prepare('SELECT position, data_json FROM lore_books ORDER BY position').all() as Array<{
    position: number
    data_json: string
  }>
  if (rows.length > 0) {
    const projected = { loreBook: rows.map((row) => JSON.parse(row.data_json)) }
    if (repairPersistedGlobalLorebookIds(projected)) {
      const update = db.prepare('UPDATE lore_books SET data_json = ? WHERE position = ?')
      projected.loreBook.forEach((lorebook, index) => {
        update.run(JSON.stringify(lorebook), rows[index].position)
      })
      changed = true
    }
  }

  // Defensive fallback for stores that still carry an embedded collection in
  // settings because collection extraction never completed.
  const settingsRow = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as
    | { data_json: string }
    | undefined
  if (settingsRow) {
    const settings = JSON.parse(settingsRow.data_json)
    if (repairPersistedGlobalLorebookIds(settings)) {
      db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
      changed = true
    }
  }
  return changed
}

/** Migration/recovery repair; callers own the transaction and revision/lineage boundary. */
export function repairPersistedLegacyLocalStopStringsInSqlite(db: DatabaseSync): boolean {
  let changed = false
  const settingsRow = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as
    | { data_json: string }
    | undefined
  if (settingsRow) {
    const settings: unknown = JSON.parse(settingsRow.data_json)
    let settingsChanged = repairLegacyLocalStopStrings(settings)
    if (isRecord(settings)) {
      // Older stores can still carry embedded preset collections.
      for (const key of ['botPresets', 'modelPresets', 'promptPresets']) {
        if (!Array.isArray(settings[key])) continue
        for (const preset of settings[key]) {
          if (repairLegacyLocalStopStrings(preset)) settingsChanged = true
        }
      }
    }
    if (settingsChanged) {
      db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
      changed = true
    }
  }

  for (const table of ['bot_presets', 'model_presets', 'prompt_presets']) {
    const rows = db
      .prepare(`SELECT position, data_json FROM ${table} WHERE json_type(data_json, '$.localStopStrings') = 'object'`)
      .all() as Array<{ position: number; data_json: string }>
    const update = db.prepare(`UPDATE ${table} SET data_json = ? WHERE position = ?`)
    for (const row of rows) {
      const preset: unknown = JSON.parse(row.data_json)
      if (!repairLegacyLocalStopStrings(preset)) continue
      update.run(JSON.stringify(preset), row.position)
      changed = true
    }
  }
  return changed
}

/** Explicit migration/import/recovery-boundary persona identity repair. */
export function repairPersistedPersonaSelectionIdentity(database: unknown): boolean {
  if (!isRecord(database)) return false
  return repairPersonaSelectionIdentity(database).changed
}

/** Schema-migration and backup-recovery adapter for split settings/persona rows. */
export function repairPersistedPersonaSelectionIdentityInSqlite(db: DatabaseSync): boolean {
  const settingsRow = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as
    | { data_json: string }
    | undefined
  if (!settingsRow) return false

  const settings = JSON.parse(settingsRow.data_json) as unknown
  if (!isRecord(settings)) return false
  const rows = db.prepare('SELECT position, data_json FROM personas ORDER BY position').all() as Array<{
    position: number
    data_json: string
  }>

  if (rows.length === 0) {
    const result = repairPersonaSelectionIdentity(settings)
    if (result.changed) db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
    return result.changed
  }

  const personas = rows.map((row) => JSON.parse(row.data_json))
  const projection: JsonRecord = { ...settings, personas }
  const result = repairPersonaSelectionIdentity(projection)
  if (!result.changed) return false

  const updatePersona = db.prepare('UPDATE personas SET data_json = ? WHERE position = ?')
  personas.forEach((persona, index) => {
    const encoded = JSON.stringify(persona)
    if (encoded !== rows[index]!.data_json) updatePersona.run(encoded, rows[index]!.position)
  })
  settings.selectedPersona = result.selectedPersona
  settings.selectedPersonaId = result.selectedPersonaId
  db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
  return true
}

/** Explicit migration/import/recovery-boundary Hypa V3 preset identity repair. */
export function repairPersistedHypaV3PresetSelectionIdentity(database: unknown): boolean {
  if (!isRecord(database)) return false
  return repairHypaV3PresetSelectionIdentity(database).changed
}

/** Schema-migration and backup-recovery adapter for split settings/Hypa V3 preset rows. */
export function repairPersistedHypaV3PresetSelectionIdentityInSqlite(db: DatabaseSync): boolean {
  const settingsRow = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as
    | { data_json: string }
    | undefined
  if (!settingsRow) return false

  const settings = JSON.parse(settingsRow.data_json) as unknown
  if (!isRecord(settings)) return false
  const rows = db.prepare('SELECT position, data_json FROM hypa_v3_presets ORDER BY position').all() as Array<{
    position: number
    data_json: string
  }>

  if (rows.length === 0) {
    const result = repairHypaV3PresetSelectionIdentity(settings)
    if (result.changed) db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
    return result.changed
  }

  const hypaV3Presets = rows.map((row) => JSON.parse(row.data_json))
  const projection: JsonRecord = { ...settings, hypaV3Presets }
  const result = repairHypaV3PresetSelectionIdentity(projection)
  if (!result.changed) return false

  const updatePreset = db.prepare('UPDATE hypa_v3_presets SET data_json = ? WHERE position = ?')
  hypaV3Presets.forEach((preset, index) => {
    const encoded = JSON.stringify(preset)
    if (encoded !== rows[index]!.data_json) updatePreset.run(encoded, rows[index]!.position)
  })
  settings.hypaV3PresetId = result.hypaV3PresetId
  settings.selectedHypaV3PresetId = result.selectedHypaV3PresetId
  db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
  return true
}

/** Schema-migration and backup-recovery repair of legacy numeric translator selections. */
export function repairPersistedTranslatorPresetSelectionIdentityInSqlite(db: DatabaseSync): boolean {
  const settingsRow = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as
    | { data_json: string }
    | undefined
  if (!settingsRow) return false
  const settings = JSON.parse(settingsRow.data_json) as unknown
  if (!isRecord(settings)) return false

  const rows = db.prepare('SELECT data_json FROM translator_presets ORDER BY position').all() as Array<{
    data_json: string
  }>
  const presets = getCanonicalTranslatorPresets({
    translatorPresets:
      rows.length > 0
        ? rows.map((row) => JSON.parse(row.data_json))
        : Array.isArray(settings.translatorPresets)
          ? settings.translatorPresets
          : undefined,
  })
  // This migration only repairs the pointer into an existing canonical
  // collection. It must not replace preset bodies or invent new preset IDs.
  if (!presets) return false
  const selection = settings.translatorPresetId
  if (presets.some((preset) => preset.id === selection)) return false
  const selected =
    typeof selection === 'number' && Number.isInteger(selection) && selection >= 0 && selection < presets.length
      ? presets[selection]!
      : presets[0]!
  settings.translatorPresetId = selected.id
  settings.translatorPrompt = selected.prompt
  settings.translatorMaxResponse = selected.maxResponse
  db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
  return true
}

/**
 * Model-profile credentials were historically persisted inline. Scrub those
 * legacy fields before settings can reach a resource response or command
 * baseline now that masking applies only to providerCredentials.
 */
export function repairPersistedModelProfileInlineSecrets(settings: unknown): boolean {
  if (!isRecord(settings) || !Array.isArray(settings.modelProfiles)) return false

  let changed = false
  for (const rawProfile of settings.modelProfiles) {
    if (!isRecord(rawProfile) || !isRecord(rawProfile.providerOptions)) continue
    const providerOptions = rawProfile.providerOptions
    if (Object.prototype.hasOwnProperty.call(providerOptions, 'apiKey')) {
      delete providerOptions.apiKey
      changed = true
    }

    if (!isRecord(providerOptions.vertex)) continue
    if (Object.prototype.hasOwnProperty.call(providerOptions.vertex, 'clientEmail')) {
      delete providerOptions.vertex.clientEmail
      changed = true
    }
    if (Object.prototype.hasOwnProperty.call(providerOptions.vertex, 'privateKey')) {
      delete providerOptions.vertex.privateKey
      changed = true
    }
  }
  return changed
}

function repairPersistedPresetModelProfileInlineSecrets(database: unknown): boolean {
  if (!isRecord(database)) return false

  let changed = false
  for (const field of ['botPresets', 'modelPresets'] as const) {
    const presets = database[field]
    if (!Array.isArray(presets)) continue
    for (const preset of presets) {
      if (repairPersistedModelProfileInlineSecrets(preset)) changed = true
    }
  }
  return changed
}

/** Starts its own transaction at boot, or joins the caller's restore transaction. */
export function repairPersistedModelProfileInlineSecretsInSqlite(db: DatabaseSync): boolean {
  const ownsTransaction = !db.isTransaction
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE')

  let changed = false
  try {
    const settingsRow = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as
      | { data_json: string }
      | undefined
    if (settingsRow) {
      const settings = JSON.parse(settingsRow.data_json)
      if (repairPersistedModelProfileInlineSecrets(settings)) {
        db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
        changed = true
      }
    }

    for (const tableName of MODEL_PROFILE_INLINE_SECRET_PRESET_TABLES) {
      const rows = db.prepare(`SELECT position, data_json FROM ${tableName} ORDER BY position`).all() as Array<{
        position: number
        data_json: string
      }>
      const update = db.prepare(`UPDATE ${tableName} SET data_json = ? WHERE position = ?`)
      for (const row of rows) {
        const preset = JSON.parse(row.data_json)
        if (!repairPersistedModelProfileInlineSecrets(preset)) continue
        update.run(JSON.stringify(preset), row.position)
        changed = true
      }
    }

    if (ownsTransaction) db.exec('COMMIT')
    return changed
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Upgrade settings rows written before the standalone Agent collection existed.
 *
 * A missing `agents` key identifies the legacy shape. Once that owner exists,
 * strict command reads deliberately reject malformed/non-canonical state rather
 * than repairing ordinary mutations as a side effect.
 */
export function migrateLegacyAgentConfigurationInSqlite(db: DatabaseSync): boolean {
  const ownsTransaction = !db.isTransaction
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE')

  try {
    const row = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined
    if (!row) {
      if (ownsTransaction) db.exec('COMMIT')
      return false
    }

    const settings = JSON.parse(row.data_json) as unknown
    if (!isRecord(settings) || Object.prototype.hasOwnProperty.call(settings, 'agents')) {
      if (ownsTransaction) db.exec('COMMIT')
      return false
    }

    const normalized = normalizeAgentConfiguration(undefined, settings.agentPresets)
    settings.agents = normalized.agents
    settings.agentPresets = normalized.agentPresets
    const defaultId = normalizeAgentPresetDefaultId(settings.agentPresetDefaultId, normalized.agentPresets)
    if (defaultId) {
      settings.agentPresetDefaultId = defaultId
    } else {
      delete settings.agentPresetDefaultId
    }
    db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))

    if (ownsTransaction) db.exec('COMMIT')
    return true
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

function loadCollectionsFromSqlite(db: DatabaseSync, database: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...database }
  for (const [field, tableName] of Object.entries(COLLECTION_TABLE_MAP)) {
    const rows = db.prepare(`SELECT data_json FROM ${tableName} ORDER BY position`).all() as unknown as Array<{
      data_json: string
    }>
    if (rows.length > 0) {
      merged[field] = rows.map((r) => JSON.parse(r.data_json))
    }
    // SQLite empty → keep existing value ([] marker or absent); don't fabricate a field.
  }
  projectSelectedPromptTemplate(merged, merged.promptPresetsId)
  const storageRows = db.prepare('SELECT key, value_json FROM plugin_custom_storage').all() as unknown as Array<{
    key: string
    value_json: string
  }>
  if (storageRows.length > 0) {
    const storage: Record<string, unknown> = {}
    for (const row of storageRows) {
      if (isPluginStorageEmptySentinelKey(row.key)) continue
      storage[row.key] = JSON.parse(row.value_json)
    }
    merged.pluginCustomStorage = storage
  }
  // SQLite empty → keep existing value ({} marker or absent).
  return merged
}

/**
 * The extracted prompt-template table is only a compatibility projection. A
 * selected modern preset owns its body, so a stale top-level row must never
 * become the body seen by a normal repository consumer. Invalid selection
 * state is deliberately left untouched: the shared prompt resolver can fail
 * closed (and the legacy projection remains available to explicit recovery
 * and import/export paths).
 */
function projectSelectedPromptTemplate(database: Record<string, unknown>, selectedIndex: unknown): void {
  if (!Number.isInteger(selectedIndex) || (selectedIndex as number) < 0) return
  const presets = Array.isArray(database.promptPresets) ? database.promptPresets : []
  const selected = presets[selectedIndex as number]
  if (!isRecord(selected)) return
  const selectedId = stablePromptPresetId(selected.id)
  if (!selectedId || !hasUniquePromptPresetId(presets, selectedId)) return

  if (Object.prototype.hasOwnProperty.call(selected, 'promptTemplate')) {
    database.promptTemplate = selected.promptTemplate
    return
  }

  // The default scaffold intentionally retains the top-level projection as
  // its supported missing-template fallback. Every other selected modern
  // preset explicitly owns a disabled/null body when the field is absent.
  if (!isDefaultPromptPreset(selected)) database.promptTemplate = null
}

function hasUniquePromptPresetId(presets: readonly unknown[], id: string): boolean {
  let matches = 0
  for (const candidate of presets) {
    if (isRecord(candidate) && stablePromptPresetId(candidate.id) === id) matches += 1
  }
  return matches === 1
}

function stablePromptPresetId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function isDefaultPromptPreset(preset: Record<string, unknown>): boolean {
  return preset.id === 'default-prompt-preset' && preset.name === 'Default Prompt'
}

export function replaceAllCollectionsInTable(db: DatabaseSync, database: unknown): void {
  if (!isRecord(database)) return
  repairPersistedPresetModelProfileInlineSecrets(database)
  for (const [field, tableName] of Object.entries(COLLECTION_TABLE_MAP)) {
    const arr = database[field]
    writeCollectionTableRows(db, tableName, Array.isArray(arr) ? arr : [])
  }
  recordTableWrite('plugin_custom_storage')
  db.exec('DELETE FROM plugin_custom_storage')
  const storage = database.pluginCustomStorage
  if (isRecord(storage)) {
    const entries = Object.entries(storage)
    if (entries.length === 0) {
      insertPluginStorageEmptySentinel(db)
      return
    }
    const stmt = db.prepare('INSERT INTO plugin_custom_storage (key, value_json) VALUES (?, ?)')
    for (const [key, value] of entries) {
      stmt.run(key, JSON.stringify(value ?? null))
    }
  }
}

export function createSettingsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data_json TEXT NOT NULL CHECK (json_valid(data_json))
    )
  `)
}

export function loadSettingsFromSqlite(
  db: DatabaseSync,
  measurement?: DisplaySourceLoadMeasurement,
): Record<string, unknown> | null {
  const row = readDisplaySourceData(measurement, () =>
    db.prepare('SELECT data_json FROM settings WHERE id = 1').get(),
  ) as { data_json: string } | undefined
  return parseAndRepairSettingsRow(db, row, measurement)
}

function parseAndRepairSettingsRow(
  db: DatabaseSync,
  row: { data_json: string } | undefined,
  measurement?: DisplaySourceLoadMeasurement,
): Record<string, unknown> | null {
  if (!row) return null
  const parsed = parseDisplaySourceJson(row.data_json, measurement)
  if (!isRecord(parsed)) return null
  if (repairPersistedModelProfileInlineSecrets(parsed)) {
    db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(parsed))
  }
  return parsed
}

export function loadSettingsWithTranslatorPresetsFromSqlite(db: DatabaseSync): Record<string, unknown> | null {
  const settings = loadSettingsFromSqlite(db)
  if (settings === null) return null

  const rows = db.prepare('SELECT data_json FROM translator_presets ORDER BY position').all() as unknown as Array<{
    data_json: string
  }>
  if (rows.length > 0) {
    settings.translatorPresets = rows.map((row) => JSON.parse(row.data_json))
  }
  // Mirror `loadCollectionsFromSqlite`: an empty table keeps any embedded
  // legacy value or leaves the collection absent so preset fallback still works.
  return settings
}

export function loadServerIntentCompletionSettings(db: DatabaseSync): Record<string, unknown> | null {
  return loadSettingsFromSqlite(db)
}

export function extractSettings(database: Record<string, unknown>): Record<string, unknown> {
  const settings: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(database)) {
    if (!NON_SETTINGS_FIELDS.has(key)) {
      settings[key] = value
    }
  }
  return settings
}

export function replaceAllSettingsInTable(db: DatabaseSync, database: unknown): void {
  if (!isRecord(database)) return
  const settings = extractSettings(database)
  recordTableWrite('settings')
  db.exec('DELETE FROM settings')
  db.prepare('INSERT INTO settings (id, data_json) VALUES (1, ?)').run(JSON.stringify(settings))
}

/** Schema-migration adapter for the singleton settings owner. */
export function migrateLegacyFlatModelConfigurationInSqlite(db: DatabaseSync): boolean {
  const settingsTable = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
    .get()
  if (!settingsTable) return false
  const row = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined
  if (!row) return false
  const settings = JSON.parse(row.data_json) as unknown
  if (!isRecord(settings) || !migrateLegacyFlatModelConfiguration(settings)) return false
  writeSettingsOnly(db, settings)
  return true
}

export function stripSettings(next: Persisted): Persisted {
  if (!isRecord(next.database)) return next
  const kept: Record<string, unknown> = {}
  const db = next.database as Record<string, unknown>
  for (const key of Object.keys(db)) {
    if (NON_SETTINGS_FIELDS.has(key)) {
      kept[key] = db[key]
    }
  }
  return { ...next, database: kept }
}

export function stripCollections(next: Persisted): Persisted {
  if (!isRecord(next.database)) return next
  const stripped = { ...next.database }
  for (const field of COLLECTION_FIELDS) {
    if (Array.isArray(stripped[field])) {
      stripped[field] = []
    }
  }
  if (isRecord(stripped.pluginCustomStorage)) {
    stripped.pluginCustomStorage = {}
  }
  return { ...next, database: stripped }
}

export function createCharacterTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      data_json TEXT NOT NULL CHECK (json_valid(data_json))
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL
        REFERENCES characters(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      data_json TEXT NOT NULL CHECK (json_valid(data_json))
    );
    CREATE INDEX IF NOT EXISTS idx_chats_character_id ON chats (character_id);
  `)
}

interface CharacterRow {
  id: string
  position: number
  data_json: string
}

interface ChatRow {
  id: string
  character_id: string
  position: number
  data_json: string
}

interface CharacterSummaryProjectionRow {
  id: string
  name: unknown
  display_name: unknown
  image: unknown
  creator_notes: unknown
  trash_time: unknown
  creation_date: unknown
  modification_date: unknown
  last_interaction: unknown
  chat_page: unknown
}

interface CharacterSummaryChatProjectionRow {
  id: string
  character_id: string
  name: unknown
  pinned: unknown
}

export interface CharacterSelectionRows {
  characterId: string
  position: number
  character: JsonRecord
  settings: JsonRecord
}

export interface CharacterMutationTarget {
  characterId: string
  /** Preserve the stored character payload without stamping its table id into
   * the JSON row. Used when every non-target field must remain exact. */
  exactCharacterRow?: boolean
  /** Optional collection dependencies needed to validate the character-row
   * mutation without falling back to a whole-corpus load. */
  collectionFields?: readonly CollectionFieldKey[]
}

export interface CharacterSelectionProjection {
  characterId: string
  currentChar: number
  lastInteraction?: number
}

function loadCharactersFromSqlite(db: DatabaseSync, options: { exactChatRows?: boolean } = {}): unknown[] {
  const charRows = db
    .prepare('SELECT id, position, data_json FROM characters ORDER BY position')
    .all() as unknown as CharacterRow[]
  if (charRows.length === 0) return []

  const chatRows = db
    .prepare('SELECT id, character_id, position, data_json FROM chats ORDER BY character_id, position')
    .all() as unknown as ChatRow[]

  const chatsByCharId = new Map<string, unknown[]>()
  for (const row of chatRows) {
    const chat = options.exactChatRows ? JSON.parse(row.data_json) : parseStoredChatRow(row.data_json)
    const list = chatsByCharId.get(row.character_id) ?? []
    list.push(chat)
    chatsByCharId.set(row.character_id, list)
  }

  return charRows.map((row) => {
    const char = JSON.parse(row.data_json) as Record<string, unknown>
    char.chats = chatsByCharId.get(row.id) ?? []
    return char
  })
}

export function replaceAllCharactersInTable(db: DatabaseSync, database: unknown): void {
  const characters = isRecord(database) && Array.isArray(database.characters) ? database.characters : []
  const greetingTranslationSnapshot = listGreetingTranslationsForRewrite(db)
  const greetingTranslations = greetingTranslationSnapshot.rows
  if (greetingTranslationSnapshot.droppedKeys.length > 0) {
    console.warn('Dropped invalid greeting translation cache rows during broad character rewrite', {
      droppedKeys: greetingTranslationSnapshot.droppedKeys,
    })
  }

  recordTableWrite('characters')
  recordTableWrite('chats')
  recordTableWrite('greeting_translations')
  db.exec('DELETE FROM chats')
  db.exec('DELETE FROM characters')

  if (characters.length === 0) return

  const insertChar = db.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, ?, ?)')
  const insertChat = db.prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, ?, ?)')

  for (let i = 0; i < characters.length; i++) {
    const char = characters[i]
    if (!isRecord(char)) continue
    const chaId = char.chaId
    if (typeof chaId !== 'string') continue

    const chats = Array.isArray(char.chats) ? char.chats : []
    const { chats: _chats, ...charWithoutChats } = char
    delete charWithoutChats[GREETING_TRANSLATIONS_PORTABLE_FIELD]
    insertChar.run(chaId, i, JSON.stringify(charWithoutChats))

    for (let j = 0; j < chats.length; j++) {
      const chat = chats[j]
      if (!isRecord(chat)) continue
      const chatId = chat.id
      if (typeof chatId !== 'string') continue
      const { message: _msg, hypaV3Data: _hypa, ...chatClean } = chat
      repairStoredChatGenerationSettings(chatClean)
      insertChat.run(chatId, chaId, j, JSON.stringify(chatClean))
    }
  }

  const characterIds = new Set(
    characters.flatMap((character) =>
      isRecord(character) && typeof character.chaId === 'string' ? [character.chaId] : [],
    ),
  )
  replaceGreetingTranslationsForImport(
    db,
    greetingTranslations.filter((row) => characterIds.has(row.characterId)),
  )
}

export function loadCharacterSelectionRows(db: DatabaseSync, characterId: string): CharacterSelectionRows {
  const settings = loadSettingsFromSqlite(db)
  if (settings === null) {
    throw new ValidationError('database must be an object before character commands can run')
  }

  const row = db.prepare('SELECT id, position, data_json FROM characters WHERE id = ?').get(characterId) as unknown as
    | CharacterRow
    | undefined
  if (!row) {
    throw new EntityNotFoundError(`Character not found: ${characterId}`)
  }

  const character = JSON.parse(row.data_json)
  if (!isRecord(character)) {
    throw new ValidationError(`Character row is not an object: ${characterId}`)
  }

  return {
    characterId: row.id,
    position: row.position,
    character,
    settings,
  }
}

export function writeCharacterSelectionRows(db: DatabaseSync, rows: CharacterSelectionRows): void {
  recordTableWrite('characters')
  db.prepare('UPDATE characters SET data_json = ? WHERE id = ?').run(JSON.stringify(rows.character), rows.characterId)
  recordTableWrite('settings')
  db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(rows.settings))
}

export function loadCharacterSelectionProjection(
  db: DatabaseSync,
  characterId: string,
): CharacterSelectionProjection | null {
  const row = db.prepare('SELECT position, data_json FROM characters WHERE id = ?').get(characterId) as
    | Pick<CharacterRow, 'position' | 'data_json'>
    | undefined
  if (!row) return null

  const settings = loadSettingsFromSqlite(db)
  const currentChar =
    settings !== null && Number.isInteger(settings.currentChar) ? (settings.currentChar as number) : row.position
  const character = JSON.parse(row.data_json)
  const lastInteraction = isRecord(character) ? character.lastInteraction : undefined
  return {
    characterId,
    currentChar,
    ...(typeof lastInteraction === 'number' ? { lastInteraction } : {}),
  }
}

// --- Targeted writer kit -----------------------------------------------------
// Narrow SQLite writers that touch exactly the rows a single command changed,
// the building blocks that route broad commands onto row-level updates.
// Each writer performs only its `UPDATE`/`DELETE`+`INSERT` and reports its table
// to the mutation-range metric; it owns no revision/event emission and runs
// inside the caller's open `BEGIN IMMEDIATE` transaction. None of them touch the
// message store, `hypaV3Data`, or alternates. They leave every unrelated rowid
// stable (the rowid-stability contract `writeCharacterSelectionRows` set).

/** One `UPDATE settings` (id=1). Drop-in for the settings half of
 *  `writeCharacterSelectionRows`; the caller passes the (already-extracted)
 *  settings record to persist. */
export function writeSettingsOnly(db: DatabaseSync, settings: JsonRecord): void {
  recordTableWrite('settings')
  db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
}

/** `UPDATE characters WHERE id=?` for one character row. `chats` is stripped to
 *  match the storage contract (chats live in the `chats` table). */
export function writeSingleCharacterRow(db: DatabaseSync, characterId: string, character: JsonRecord): void {
  const { chats: _chats, ...charWithoutChats } = character
  delete charWithoutChats[GREETING_TRANSLATIONS_PORTABLE_FIELD]
  recordTableWrite('characters')
  db.prepare('UPDATE characters SET data_json = ? WHERE id = ?').run(JSON.stringify(charWithoutChats), characterId)
}

export function characterRowExists(db: DatabaseSync, characterId: string): boolean {
  const row = db.prepare('SELECT 1 AS found FROM characters WHERE id = ? LIMIT 1').get(characterId) as
    | { found: number }
    | undefined
  return !!row
}

export function chatRowExists(db: DatabaseSync, chatId: string): boolean {
  const row = db.prepare('SELECT 1 AS found FROM chats WHERE id = ? LIMIT 1').get(chatId) as
    | { found: number }
    | undefined
  return !!row
}

export function nextCharacterRowPosition(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS position FROM characters').get() as {
    position: number
  }
  return row.position
}

/** Identity/order projection for appending a character. Never materialize the
 * unrelated character or chat bodies, collections, messages, or asset catalog.
 * The caller validates the settings order and writes inside its transaction. */
export function loadCharacterAppendState(db: DatabaseSync): {
  settings: JsonRecord
  characters: Array<{ chaId: string; trashTime?: number }>
} {
  const settings = loadSettingsFromSqlite(db)
  if (settings === null) {
    throw new ValidationError('database must be an object before character commands can run')
  }
  const rows = db
    .prepare(
      `SELECT id, json_extract(data_json, '$.chaId') AS stored_id,
        json_extract(data_json, '$.trashTime') AS trash_time
       FROM characters ORDER BY position`,
    )
    .all()
  const characters = rows.map((row) => {
    if (typeof row.id !== 'string' || row.stored_id !== row.id) {
      throw new ValidationError('character.chaId must match its stored character id')
    }
    if (row.trash_time !== null && typeof row.trash_time !== 'number') {
      throw new ValidationError('character.trashTime must be a number')
    }
    return { chaId: row.id, ...(typeof row.trash_time === 'number' ? { trashTime: row.trash_time } : {}) }
  })
  // Legacy embedded characters require the explicit import/recovery boundary;
  // an append must never hide them behind the first normalized SQLite row.
  if (characters.length === 0 && Array.isArray(settings.characters) && settings.characters.length > 0) {
    throw new ValidationError('embedded characters must be imported before creating a character')
  }
  return { settings, characters }
}

/** INSERT one brand-new character row at the supplied position. `chats` is
 *  stripped to match the storage contract (chats live in the `chats` table). */
export function insertCharacterRow(db: DatabaseSync, position: number, character: JsonRecord): void {
  const characterId = character.chaId
  if (typeof characterId !== 'string' || characterId.trim() === '') {
    throw new ValidationError('character.chaId must be a non-empty string')
  }
  const { chats: _chats, ...charWithoutChats } = character
  delete charWithoutChats[GREETING_TRANSLATIONS_PORTABLE_FIELD]
  recordTableWrite('characters')
  db.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, ?, ?)').run(
    characterId,
    position,
    JSON.stringify(charWithoutChats),
  )
}

/** `UPDATE chats WHERE id=?` for one chat row. `message` / `hypaV3Data` are
 *  stripped to match the storage contract (they live in the message store). */
export function writeSingleChatRow(db: DatabaseSync, chatId: string, chat: JsonRecord): void {
  writeSingleChatRowData(db, chatId, chat, true)
}

/** Lorebook mutations already own their target-field repair. Preserve every
 * unrelated persisted chat field exactly while still respecting the storage
 * split for messages and hypa data. */
export function writeSingleChatRowExact(db: DatabaseSync, chatId: string, chat: JsonRecord): void {
  writeSingleChatRowData(db, chatId, chat, false)
}

export function clearChatTranslatorPresetBindings(db: DatabaseSync, presetId: string): string[] {
  const rows = db
    .prepare("SELECT id, data_json FROM chats WHERE json_extract(data_json, '$.translatorPresetId') = ? ORDER BY id")
    .all(presetId) as unknown as Array<Pick<ChatRow, 'id' | 'data_json'>>
  const clearedChatIds: string[] = []
  for (const row of rows) {
    const chat = JSON.parse(row.data_json)
    if (!isRecord(chat) || chat.translatorPresetId !== presetId) continue
    delete chat.translatorPresetId
    writeSingleChatRowExact(db, row.id, chat)
    clearedChatIds.push(row.id)
  }
  return clearedChatIds
}

function writeSingleChatRowData(
  db: DatabaseSync,
  chatId: string,
  chat: JsonRecord,
  repairGenerationSettings: boolean,
): void {
  const { message: _msg, hypaV3Data: _hypa, ...chatClean } = chat
  if (repairGenerationSettings) repairStoredChatGenerationSettings(chatClean)
  recordTableWrite('chats')
  const result = db.prepare('UPDATE chats SET data_json = ? WHERE id = ?').run(JSON.stringify(chatClean), chatId)
  if (Number(result.changes) === 0) {
    const row = db.prepare('SELECT 1 AS found FROM chats WHERE id = ? LIMIT 1').get(chatId) as
      | { found: number }
      | undefined
    if (!row) throw new EntityNotFoundError(`Chat row not found: ${chatId}`)
  }
}

/** Delete one chat row from the `chats` table (scoped by its parent character).
 *  Pairs with the message-store deletes for a chat removal; the caller re-stamps
 *  the remaining rows' positions. Keyed by character so a character-wide delete
 *  can iterate it. */
export function deleteCharacterChatRow(db: DatabaseSync, chatId: string, characterId: string): void {
  recordTableWrite('chats')
  db.prepare('DELETE FROM chats WHERE id = ? AND character_id = ?').run(chatId, characterId)
}

/** Delete one character's row and compact the positions of the rows after it so
 *  the `characters` table stays contiguous (matching the broad rewrite). The
 *  `chats.character_id` FK declares `ON DELETE CASCADE` and `openDatabase`
 *  sets `PRAGMA foreign_keys = ON`, so this single DELETE also removes the
 *  character's chat rows.
 *  Pairs with the message-store deletes for a character removal. Remaining
 *  rows keep their rowids (UPDATE/DELETE, no reINSERT). */
export function deleteCharacterRow(db: DatabaseSync, characterId: string): void {
  recordTableWrite('characters')
  // The FK cascade physically writes the chats table; record it so the
  // command-metric `writtenTables` budget stays truthful.
  recordTableWrite('chats')
  recordTableWrite('greeting_translations')
  const row = db.prepare('SELECT position FROM characters WHERE id = ?').get(characterId) as
    | { position: number }
    | undefined
  db.prepare('DELETE FROM characters WHERE id = ?').run(characterId)
  if (row) {
    db.prepare('UPDATE characters SET position = position - 1 WHERE position > ?').run(row.position)
  }
}

/** Re-stamp one character's chat rows in place: `position` = array index and the
 *  updated `data_json`, keyed by id, for reorder / folder-cascade edits where the
 *  chat set is unchanged. Each row keeps its rowid (UPDATE, not DELETE+reINSERT);
 *  `message` / `hypaV3Data` are stripped (they live in the message store). */
export function writeCharacterChatRows(db: DatabaseSync, characterId: string, chats: readonly JsonRecord[]): void {
  recordTableWrite('chats')
  const stmt = db.prepare('UPDATE chats SET position = ?, data_json = ? WHERE id = ? AND character_id = ?')
  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i]
    const chatId = chat.id
    if (typeof chatId !== 'string') continue
    const { message: _msg, hypaV3Data: _hypa, ...chatClean } = chat
    repairStoredChatGenerationSettings(chatClean)
    stmt.run(i, JSON.stringify(chatClean), chatId, characterId)
  }
}

/** INSERT one brand-new chat row for a character at `position` (e.g. fork's
 *  head `unshift`). The new chat's messages persist separately via the message
 *  store; `message` / `hypaV3Data` are stripped here. */
export function insertCharacterChatRow(
  db: DatabaseSync,
  characterId: string,
  position: number,
  chat: JsonRecord,
): void {
  const chatId = chat.id
  if (typeof chatId !== 'string') {
    throw new ValidationError('chat.id must be a non-empty string')
  }
  const { message: _msg, hypaV3Data: _hypa, ...chatClean } = chat
  repairStoredChatGenerationSettings(chatClean)
  recordTableWrite('chats')
  db.prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, ?, ?)').run(
    chatId,
    characterId,
    position,
    JSON.stringify(chatClean),
  )
}

export function updateSettingsForCharacterAppend(
  db: DatabaseSync,
  characterId: string,
  character: JsonRecord,
  nextCharacterCount: number,
): void {
  const settings = loadSettingsFromSqlite(db)
  if (settings === null) {
    throw new ValidationError('database must be an object before character commands can run')
  }

  if (!Number.isInteger(settings.currentChar as number)) {
    settings.currentChar = nextCharacterCount > 0 ? 0 : -1
  }
  if ((settings.currentChar as number) >= nextCharacterCount) {
    settings.currentChar = nextCharacterCount > 0 ? nextCharacterCount - 1 : -1
  }
  if ((settings.currentChar as number) < -1) {
    settings.currentChar = nextCharacterCount > 0 ? 0 : -1
  }

  if (!Array.isArray(settings.characterOrder)) {
    settings.characterOrder = []
  }
  if (!character.trashTime && characterId !== '§temp') {
    const order = settings.characterOrder as unknown[]
    if (!characterOrderContains(order, characterId)) {
      order.push(characterId)
    }
  }

  writeSettingsOnly(db, settings)
}

function characterOrderContains(order: readonly unknown[], characterId: string): boolean {
  for (const entry of order) {
    if (entry === characterId) return true
    if (isRecord(entry) && Array.isArray(entry.data) && entry.data.includes(characterId)) {
      return true
    }
  }
  return false
}

function collectionTableForField(field: string): string {
  const tableName = COLLECTION_TABLE_MAP[field]
  if (!tableName) {
    throw new ValidationError(`Unknown collection field: ${field}`)
  }
  return tableName
}

function writeCollectionTableRows(db: DatabaseSync, tableName: string, array: readonly unknown[]): void {
  recordTableWrite(tableName)
  db.exec(`DELETE FROM ${tableName}`)
  if (array.length > 0) {
    const stmt = db.prepare(`INSERT INTO ${tableName} (position, data_json) VALUES (?, ?)`)
    for (let i = 0; i < array.length; i++) {
      stmt.run(i, JSON.stringify(array[i]))
    }
  }
}

/** Rebuild one collection table (DELETE + ordered reinsert) for
 *  create/delete/reorder. Leaves the other eight tables untouched. */
export function writeSingleCollectionTable(db: DatabaseSync, field: string, array: readonly unknown[]): void {
  const tableName = collectionTableForField(field)
  writeCollectionTableRows(db, tableName, array)
}

/** `UPDATE <collection> WHERE position=?` for a single pure field edit. Keeps
 *  the row's rowid stable (no delete+reinsert). */
export function writeSingleCollectionRow(db: DatabaseSync, field: string, position: number, value: unknown): void {
  const tableName = collectionTableForField(field)
  const json = JSON.stringify(value)
  recordTableWrite(tableName)
  db.prepare(`UPDATE ${tableName} SET data_json = ? WHERE position = ?`).run(json, position)
}

// The `promptTemplate` collection (`prompt_templates` table) is written through
// these named wrappers, never the bare field string, so literal-`'promptTemplate'`
// checks over `routes/commands.ts` stay focused on generic-settings writes while
// targeted-collection writes still address the table directly.
export function writePromptTemplatesTable(db: DatabaseSync, items: readonly unknown[]): void {
  writeSingleCollectionTable(db, 'promptTemplate', items)
}

export function writePromptTemplateRow(db: DatabaseSync, position: number, value: unknown): void {
  writeSingleCollectionRow(db, 'promptTemplate', position, value)
}

/** Single-key upsert on `plugin_custom_storage`. */
export function writePluginStorageKey(db: DatabaseSync, key: string, value: unknown): void {
  recordTableWrite('plugin_custom_storage')
  db.prepare('DELETE FROM plugin_custom_storage WHERE key = ?').run(PLUGIN_CUSTOM_STORAGE_EMPTY_SENTINEL_KEY)
  db.prepare(
    'INSERT INTO plugin_custom_storage (key, value_json) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(key, JSON.stringify(value ?? null))
}

/** Single-key delete on `plugin_custom_storage`. */
export function deletePluginStorageKey(db: DatabaseSync, key: string): void {
  recordTableWrite('plugin_custom_storage')
  db.prepare('DELETE FROM plugin_custom_storage WHERE key = ?').run(key)
  if (!hasPluginStorageUserRows(db)) insertPluginStorageEmptySentinel(db)
}

/** Rewrite the whole `plugin_custom_storage` table (DELETE-all + reinsert) to
 *  match the given key/value map. The bulk command's clear/replace semantics;
 *  mirrors the `plugin_custom_storage` tail of `replaceAllCollectionsInTable` but
 *  touches only that one table. */
export function replacePluginStorage(db: DatabaseSync, storage: Record<string, unknown>): void {
  recordTableWrite('plugin_custom_storage')
  db.exec('DELETE FROM plugin_custom_storage')
  const keys = Object.keys(storage)
  if (keys.length === 0) {
    insertPluginStorageEmptySentinel(db)
    return
  }
  const stmt = db.prepare('INSERT INTO plugin_custom_storage (key, value_json) VALUES (?, ?)')
  for (const key of keys) {
    stmt.run(key, JSON.stringify(storage[key] ?? null))
  }
}

function isPluginStorageEmptySentinelKey(key: string): boolean {
  return key === PLUGIN_CUSTOM_STORAGE_EMPTY_SENTINEL_KEY
}

function hasPluginStorageUserRows(db: DatabaseSync): boolean {
  const row = db
    .prepare('SELECT 1 AS found FROM plugin_custom_storage WHERE key != ? LIMIT 1')
    .get(PLUGIN_CUSTOM_STORAGE_EMPTY_SENTINEL_KEY) as { found: number } | undefined
  return !!row
}

function insertPluginStorageEmptySentinel(db: DatabaseSync): void {
  db.prepare('INSERT OR IGNORE INTO plugin_custom_storage (key, value_json) VALUES (?, ?)').run(
    PLUGIN_CUSTOM_STORAGE_EMPTY_SENTINEL_KEY,
    'null',
  )
}

export function createAssetMetadataTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      ext TEXT NOT NULL,
      size INTEGER NOT NULL,
      content_type TEXT NOT NULL
    )
  `)
}

export function createInlayCatalogTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inlay_catalog (
      asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      width INTEGER CHECK (width IS NULL OR width > 0),
      height INTEGER CHECK (height IS NULL OR height > 0),
      aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json))
    )
  `)
}

function inlayTypeFromContentType(contentType: string): PersistedInlayCatalogAssetType | null {
  if (contentType === 'application/x-risu-inlay-signature+json') return 'signature'
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('audio/')) return 'audio'
  if (contentType.startsWith('video/')) return 'video'
  return null
}

interface InlayCatalogRow {
  asset_id: string
  aliases_json: string
  content_type: string
  ext: string
  height: number | null
  name: string
  size: number
  width: number | null
}

function inlayCatalogEntryFromRow(row: InlayCatalogRow): PersistedInlayCatalogEntry | null {
  const type = inlayTypeFromContentType(row.content_type)
  if (!type) return null
  let aliases: unknown
  try {
    aliases = JSON.parse(row.aliases_json)
  } catch {
    aliases = []
  }
  return {
    assetId: row.asset_id,
    aliases: Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === 'string') : [],
    ext: row.ext,
    ...(row.height !== null ? { height: row.height } : {}),
    name: row.name,
    size: row.size,
    type,
    ...(row.width !== null ? { width: row.width } : {}),
  }
}

export function listInlayCatalogEntries(db: DatabaseSync): PersistedInlayCatalogEntry[] {
  const rows = db
    .prepare(
      `
        SELECT catalog.asset_id, catalog.name, catalog.width, catalog.height, catalog.aliases_json,
               assets.ext, assets.size, assets.content_type
        FROM inlay_catalog AS catalog
        INNER JOIN assets ON assets.id = catalog.asset_id
        ORDER BY catalog.name COLLATE NOCASE, catalog.asset_id
      `,
    )
    .all() as unknown as InlayCatalogRow[]
  return rows.flatMap((row) => {
    const entry = inlayCatalogEntryFromRow(row)
    return entry ? [entry] : []
  })
}

export function upsertInlayCatalogEntry(
  db: DatabaseSync,
  input: { assetId: string; aliases: readonly string[]; height?: number; name: string; width?: number },
): PersistedInlayCatalogEntry {
  const asset = getAssetMetadataById(db, input.assetId)
  if (!asset) throw new EntityNotFoundError(`Asset not found: ${input.assetId}`)
  if (!inlayTypeFromContentType(asset.contentType)) {
    throw new ValidationError(`Asset is not a supported inlay type: ${input.assetId}`)
  }

  const existing = db.prepare('SELECT aliases_json FROM inlay_catalog WHERE asset_id = ?').get(input.assetId) as
    | { aliases_json: string }
    | undefined
  const priorAliases = existing ? (JSON.parse(existing.aliases_json) as unknown) : []
  const aliases = Array.from(
    new Set([
      ...(Array.isArray(priorAliases)
        ? priorAliases.filter((alias): alias is string => typeof alias === 'string')
        : []),
      ...input.aliases,
    ]),
  ).filter((alias) => alias !== input.assetId)

  if (input.aliases.length > 0) {
    const incomingAliases = new Set(input.aliases)
    const otherRows = db
      .prepare('SELECT asset_id, aliases_json FROM inlay_catalog WHERE asset_id != ?')
      .all(input.assetId) as unknown as Array<{ asset_id: string; aliases_json: string }>
    const rewriteAliases = db.prepare('UPDATE inlay_catalog SET aliases_json = ? WHERE asset_id = ?')
    for (const row of otherRows) {
      const parsed = JSON.parse(row.aliases_json) as unknown
      if (!Array.isArray(parsed)) continue
      const filtered = parsed.filter(
        (alias): alias is string => typeof alias === 'string' && !incomingAliases.has(alias),
      )
      if (filtered.length !== parsed.length) rewriteAliases.run(JSON.stringify(filtered), row.asset_id)
    }
  }

  db.prepare(
    `
      INSERT INTO inlay_catalog (asset_id, name, width, height, aliases_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(asset_id) DO UPDATE SET
        name = excluded.name,
        width = excluded.width,
        height = excluded.height,
        aliases_json = excluded.aliases_json
    `,
  ).run(input.assetId, input.name, input.width ?? null, input.height ?? null, JSON.stringify(aliases))
  recordTableWrite('inlay_catalog')

  const entry = listInlayCatalogEntries(db).find((candidate) => candidate.assetId === input.assetId)
  if (!entry) throw new Error(`Failed to read inlay catalog entry after upsert: ${input.assetId}`)
  return entry
}

export function deleteInlayCatalogEntry(db: DatabaseSync, assetId: string): boolean {
  const result = db.prepare('DELETE FROM inlay_catalog WHERE asset_id = ?').run(assetId)
  if (result.changes > 0) recordTableWrite('inlay_catalog')
  return result.changes > 0
}

export function getAllAssetMetadata(db: DatabaseSync): PersistedAsset[] {
  const rows = db
    .prepare('SELECT id, ext, size, content_type FROM assets ORDER BY id')
    .all() as unknown as AssetMetadataRow[]
  return rows.map(rowToPersistedAsset)
}

export function getAssetMetadataById(db: DatabaseSync, id: string): PersistedAsset | null {
  const row = db.prepare('SELECT id, ext, size, content_type FROM assets WHERE id = ?').get(id) as unknown as
    | AssetMetadataRow
    | undefined
  return row ? rowToPersistedAsset(row) : null
}

export function insertAssetMetadataBatch(db: DatabaseSync, assets: readonly PersistedAsset[]): void {
  if (assets.length === 0) return
  const stmt = db.prepare('INSERT OR IGNORE INTO assets (id, ext, size, content_type) VALUES (?, ?, ?, ?)')
  for (const asset of assets) {
    stmt.run(asset.id, asset.ext, asset.size, asset.contentType)
  }
}

export function deleteAssetMetadataByIds(db: DatabaseSync, ids: readonly string[]): void {
  if (ids.length === 0) return
  const stmt = db.prepare('DELETE FROM assets WHERE id = ?')
  for (const id of ids) {
    stmt.run(id)
  }
}

export function getAssetMetadataCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM assets').get() as { count: number }
  return row.count
}

export function getMissingAssetIds(db: DatabaseSync, ids: readonly string[]): string[] {
  if (ids.length === 0) return []
  const stmt = db.prepare('SELECT id FROM assets WHERE id = ?')
  return ids.filter((id) => !stmt.get(id))
}

export interface Persisted {
  _version: number
  database: unknown | null
  assets: PersistedAsset[]
}

export interface ChatHydrationPayload {
  chatId: string
  message: unknown[]
  hypaV3Data: unknown
  /** Persisted reroll candidates for this chat's current turn. */
  alternates?: unknown[]
}

export interface BulkChatHydrationPayload {
  chats: ChatHydrationPayload[]
  missing: string[]
}

export interface CharacterLorebookHydrationPayload {
  characterId: string
  globalLore: unknown[]
}

export interface BulkCharacterLorebookHydrationPayload {
  characters: CharacterLorebookHydrationPayload[]
  missing: string[]
}

export interface PresetHydrationPayload {
  presetId: string
  preset: JsonRecord
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export type BackupDatabaseValidationErrorCode = 'backup_database_missing' | 'backup_database_invalid'

export class BackupDatabaseValidationError extends ValidationError {
  constructor(readonly code: BackupDatabaseValidationErrorCode) {
    super(code)
    this.name = 'BackupDatabaseValidationError'
  }
}

export const AUTOMATIC_BACKUP_ERROR = 'automatic_backup_failed'

export class AutomaticBackupError extends Error {
  readonly code = AUTOMATIC_BACKUP_ERROR

  constructor(cause: unknown) {
    super(AUTOMATIC_BACKUP_ERROR, { cause })
    this.name = 'AutomaticBackupError'
  }
}

export class WalCheckpointError extends Error {
  readonly code = 'backup_wal_checkpoint_failed'

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WalCheckpointError'
  }
}

export class RevisionMismatchError extends Error {
  readonly currentRevision: number
  constructor(currentRevision: number, message = 'Revision mismatch') {
    super(message)
    this.name = 'RevisionMismatchError'
    this.currentRevision = currentRevision
  }
}

export class EntityNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EntityNotFoundError'
  }
}

function dbJsonPath(dataDir: string): string {
  return path.join(dataDir, 'db.json')
}

export interface LegacyDatabaseImportLogger {
  warn(bindings: Record<string, unknown>, message: string): void
  error(bindings: Record<string, unknown>, message: string): void
}

class LegacyDatabaseSnapshotParseError extends Error {
  constructor(
    readonly filePath: string,
    cause: unknown,
  ) {
    super(
      `Legacy database snapshot at ${filePath} could not be parsed. Repair or move the file, then restart the server.`,
      { cause },
    )
    this.name = 'LegacyDatabaseSnapshotParseError'
  }
}

class LegacyDatabaseSnapshotEnvelopeError extends Error {
  constructor(readonly filePath: string) {
    super(`Legacy database snapshot at ${filePath} does not contain an object database`)
    this.name = 'LegacyDatabaseSnapshotEnvelopeError'
  }
}

function logLegacyDatabaseImportWarning(
  logger: LegacyDatabaseImportLogger | undefined,
  bindings: Record<string, unknown>,
  message: string,
): void {
  if (logger) {
    logger.warn(bindings, message)
  } else {
    console.warn(message, bindings)
  }
}

function logLegacyDatabaseImportError(
  logger: LegacyDatabaseImportLogger | undefined,
  bindings: Record<string, unknown>,
  message: string,
): void {
  if (logger) {
    logger.error(bindings, message)
  } else {
    console.error(message, bindings)
  }
}

function readLegacyDatabaseSnapshot(filePath: string): Persisted {
  const raw = fs.readFileSync(filePath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new LegacyDatabaseSnapshotParseError(filePath, err)
  }
  if (!isRecord(parsed) || !isRecord(parsed.database)) {
    throw new LegacyDatabaseSnapshotEnvelopeError(filePath)
  }
  return {
    _version: typeof parsed._version === 'number' ? parsed._version : PERSISTED_VERSION,
    database: parsed.database,
    assets: Array.isArray(parsed.assets) ? (parsed.assets as PersistedAsset[]) : [],
  }
}

/**
 * Import one legacy snapshot from its current path without moving or rewriting
 * it. The caller owns the surrounding transaction so restore can compose these
 * writes with its table swap and boot can make the full migration atomic.
 */
function importLegacyDatabaseSnapshot(db: DatabaseSync, filePath: string): void {
  const parsed = readLegacyDatabaseSnapshot(filePath)
  const database = parsed.database as JsonRecord

  normalizeDatabaseDefaults(database)
  repairLegacyCharacterCompatibilityShape(database)
  migrateLegacyFlatModelConfiguration(database)
  repairPersistedGlobalLorebookIds(database)
  repairPersistedPersonaSelectionIdentity(database)
  repairPersistedHypaV3PresetSelectionIdentity(database)
  repairChatIds(database)
  replaceAllSettingsInTable(db, database)
  replaceAllCharactersInTable(db, database)
  replaceAllCollectionsInTable(db, database)

  const chats: { chatId: string; messages: unknown[] }[] = []
  const hypa: { chatId: string; hypaV3Data: unknown }[] = []
  eachChat(database, (chat) => {
    const messages = Array.isArray(chat.message) ? chat.message : []
    const chatId = chat.id as string
    if (messages.length > 0) chats.push({ chatId, messages })
    if (chat.hypaV3Data !== undefined) hypa.push({ chatId, hypaV3Data: chat.hypaV3Data })
  })
  if (chats.length > 0) replaceAllChatMessages(db, chats)
  if (hypa.length > 0) replaceAllChatHypaV3(db, hypa)

  if (parsed.assets.length > 0) insertAssetMetadataBatch(db, parsed.assets)
}

function repairLegacyCharacterCompatibilityShape(database: JsonRecord): void {
  const characters = Array.isArray(database.characters) ? database.characters : []
  for (const candidate of characters) {
    if (!isRecord(candidate)) continue
    if (!Array.isArray(candidate.chatFolders)) candidate.chatFolders = []
    if (!Array.isArray(candidate.chats)) candidate.chats = []
    const chats = candidate.chats as unknown[]
    const selected = Number.isInteger(candidate.chatPage) ? (candidate.chatPage as number) : 0
    candidate.chatPage = chats.length === 0 ? 0 : Math.min(Math.max(selected, 0), chats.length - 1)
    for (const [index, chat] of chats.entries()) {
      if (!isRecord(chat)) continue
      if (typeof chat.name !== 'string') chat.name = `New Chat ${index + 1}`
      if (typeof chat.note !== 'string') chat.note = ''
      if (!Array.isArray(chat.localLore)) chat.localLore = []
      if (!Array.isArray(chat.message)) chat.message = []
    }
  }
}

function nextLegacyDatabaseQuarantinePath(filePath: string): string {
  const base = `${filePath}.invalid`
  if (!fs.existsSync(base)) return base
  let suffix = 1
  while (fs.existsSync(`${base}.${suffix}`)) suffix += 1
  return `${base}.${suffix}`
}

function quarantineInvalidLegacyDatabaseSnapshot(
  filePath: string,
  logger: LegacyDatabaseImportLogger | undefined,
): void {
  const quarantinePath = nextLegacyDatabaseQuarantinePath(filePath)
  try {
    fs.renameSync(filePath, quarantinePath)
    logLegacyDatabaseImportWarning(
      logger,
      { filePath, quarantinePath },
      'Legacy database snapshot has an invalid envelope and was quarantined without being imported',
    )
  } catch (err) {
    // An invalid envelope must not crash-loop the server even when the data
    // directory cannot be renamed. Ignore it for this boot and keep the source
    // untouched so an operator can repair the filesystem problem.
    logLegacyDatabaseImportWarning(
      logger,
      { err, filePath, quarantinePath },
      'Legacy database snapshot has an invalid envelope but could not be quarantined; it was ignored for this boot',
    )
  }
}

export function emptyPersisted(): Persisted {
  return { _version: PERSISTED_VERSION, database: null, assets: [] }
}

function loadPersistedDatabase(
  db: DatabaseSync,
  _dataDir: string,
  options: { exactChatRows?: boolean } = {},
): unknown | null {
  let database: unknown = loadSettingsFromSqlite(db)
  if (database === null) return null
  const rec = database as Record<string, unknown>
  for (const field of COLLECTION_FIELDS) {
    if (field !== 'promptTemplate' && !(field in rec)) rec[field] = []
  }
  if (!('pluginCustomStorage' in rec)) rec.pluginCustomStorage = {}
  const sqliteChars = loadCharactersFromSqlite(db, options)
  if (sqliteChars.length > 0 || !Array.isArray(rec.characters)) {
    rec.characters = sqliteChars
  }
  database = loadCollectionsFromSqlite(db, rec)
  projectSelectedPersonaCompatibilityIndex(database as Record<string, unknown>)
  projectSelectedHypaV3PresetCompatibilityIndex(database as Record<string, unknown>)
  return database
}

/** Normal reads derive the legacy numeric pointer without repairing or persisting rows. */
function projectSelectedPersonaCompatibilityIndex(database: Record<string, unknown>): void {
  if (!Array.isArray(database.personas)) return
  database.selectedPersona = selectedPersonaIndexFromStableId(database)
}

/** Normal reads derive the legacy numeric pointer without repairing or persisting rows. */
function projectSelectedHypaV3PresetCompatibilityIndex(database: Record<string, unknown>): void {
  if (!Array.isArray(database.hypaV3Presets)) return
  database.hypaV3PresetId = hypaV3PresetIndexFromStableId(database)
}

export function loadPersisted(db: DatabaseSync, dataDir: string): Persisted {
  const database = loadPersistedDatabase(db, dataDir)
  if (database === null) return emptyPersisted()
  return {
    _version: PERSISTED_VERSION,
    database,
    assets: getAllAssetMetadata(db),
  }
}

function loadPersistedWithExactChatRows(db: DatabaseSync, dataDir: string): Persisted {
  const database = loadPersistedDatabase(db, dataDir, { exactChatRows: true })
  if (database === null) return emptyPersisted()
  return {
    _version: PERSISTED_VERSION,
    database,
    assets: getAllAssetMetadata(db),
  }
}

export function loadPersistedForSettingsMutation(db: DatabaseSync, dataDir: string): Persisted {
  const settings = loadSettingsFromSqlite(db)
  if (settings === null) return loadPersisted(db, dataDir)
  for (const field of NON_SETTINGS_FIELDS) {
    if (field in settings) return loadPersisted(db, dataDir)
  }
  return {
    _version: PERSISTED_VERSION,
    database: settings,
    assets: [],
  }
}

export function loadPersistedForCollectionMutation(
  db: DatabaseSync,
  dataDir: string,
  fieldKeys: readonly CollectionFieldKey[],
): Persisted {
  const { fields, settings } = loadDatabaseFieldsFromSqlite(db, fieldKeys)
  if (settings === null) return loadPersisted(db, dataDir)
  if (!settingsCanRepresentCollectionMutation(settings, fieldKeys)) {
    return loadPersisted(db, dataDir)
  }
  return {
    _version: PERSISTED_VERSION,
    database: { ...settings, ...fields },
    assets: [],
  }
}

function settingsCanRepresentCollectionMutation(
  settings: Record<string, unknown>,
  fieldKeys: readonly CollectionFieldKey[],
): boolean {
  const requested = new Set<string>(fieldKeys)
  for (const field of NON_SETTINGS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(settings, field)) continue
    if (requested.has(field)) continue
    return false
  }
  return true
}

export function loadPersistedForCharacterMutation(
  db: DatabaseSync,
  dataDir: string,
  target: CharacterMutationTarget,
): Persisted {
  const dependencyLoad =
    target.collectionFields && target.collectionFields.length > 0
      ? loadDatabaseFieldsFromSqlite(db, target.collectionFields)
      : undefined
  const settings = dependencyLoad?.settings ?? loadSettingsFromSqlite(db)
  if (settings === null) return loadPersisted(db, dataDir)

  const charRow = db
    .prepare('SELECT id, position, data_json FROM characters WHERE id = ?')
    .get(target.characterId) as unknown as CharacterRow | undefined
  if (!charRow) return loadPersisted(db, dataDir)

  const character = JSON.parse(charRow.data_json) as unknown
  if (!isRecord(character)) return loadPersisted(db, dataDir)
  if (!target.exactCharacterRow) character.chaId = target.characterId

  const fields = dependencyLoad?.fields ?? {}

  return {
    _version: PERSISTED_VERSION,
    database: { ...settings, ...fields, characters: [character] },
    assets: [],
  }
}

export function loadPersistedDatabaseFields(
  db: DatabaseSync,
  _dataDir: string,
  fieldKeys: readonly string[],
): Record<string, unknown> {
  return loadDatabaseFieldsFromSqlite(db, fieldKeys).fields
}

/**
 * Character rows for resource APIs, with chat metadata retained and the
 * separately stored chat bodies omitted. When `enableLorebookStubs` is on,
 * `globalLore` stays behind the dedicated character-lorebook hydration routes.
 */
export function loadCharacterRowsForRead(db: DatabaseSync, _dataDir: string): JsonRecord[] {
  const { fields, settings } = loadDatabaseFieldsFromSqlite(db, ['characters'])
  const characters = Array.isArray(fields.characters) ? fields.characters : []
  const result = characters.filter(isRecord)
  eachChat({ characters: result }, (chat) => {
    chat.message = []
    delete chat.hypaV3Data
  })
  if (settings?.enableLorebookStubs === true) stripCharacterGlobalLoreForRead(result)
  return result
}

/**
 * Versioned list projection for startup and character pickers. SQLite extracts
 * only the protocol-approved scalars; no raw character or chat JSON payload is
 * returned to JavaScript.
 */
export function loadCharacterSummariesForRead(db: DatabaseSync): ServerCharacterSummary[] {
  const characterRows = db
    .prepare(
      `
      SELECT
        id,
        json_extract(data_json, '$.name') AS name,
        json_extract(data_json, '$.displayName') AS display_name,
        json_extract(data_json, '$.image') AS image,
        json_extract(data_json, '$.creatorNotes') AS creator_notes,
        json_extract(data_json, '$.trashTime') AS trash_time,
        json_extract(data_json, '$.creation_date') AS creation_date,
        json_extract(data_json, '$.modification_date') AS modification_date,
        json_extract(data_json, '$.lastInteraction') AS last_interaction,
        json_extract(data_json, '$.chatPage') AS chat_page
      FROM characters
      ORDER BY position
    `,
    )
    .all() as unknown as CharacterSummaryProjectionRow[]

  const chatRows = db
    .prepare(
      `
      SELECT
        id,
        character_id,
        json_extract(data_json, '$.name') AS name,
        CASE WHEN json_extract(data_json, '$.pinned') = 1 THEN 1 ELSE 0 END AS pinned
      FROM chats
      ORDER BY character_id, position
    `,
    )
    .all() as unknown as CharacterSummaryChatProjectionRow[]

  const chatsByCharacterId = new Map<string, CharacterSummaryChatProjectionRow[]>()
  for (const chat of chatRows) {
    const chats = chatsByCharacterId.get(chat.character_id) ?? []
    chats.push(chat)
    chatsByCharacterId.set(chat.character_id, chats)
  }

  return characterRows.map((row) => {
    const chats = chatsByCharacterId.get(row.id) ?? []
    const chatIds = chats.map((chat) => chat.id)
    const chatPage = integerOrNull(row.chat_page)
    return {
      [SERVER_CHARACTER_SHELL_MARKER]: true,
      chaId: row.id,
      type: 'character',
      name: stringOrEmpty(row.name),
      displayName: stringOrEmpty(row.display_name),
      image: stringOrEmpty(row.image),
      creatorNotes: stringOrEmpty(row.creator_notes),
      trashTime: finiteNumberOrNull(row.trash_time),
      creation_date: finiteNumberOrNull(row.creation_date),
      modification_date: finiteNumberOrNull(row.modification_date),
      lastInteraction: finiteNumberOrNull(row.last_interaction),
      chatCount: chats.length,
      activeChatId: chatPage !== null && chatPage >= 0 ? (chats[chatPage]?.id ?? null) : null,
      chatIds,
      pinnedChats: chats
        .filter((chat) => chat.pinned === 1)
        .map((chat) => ({ id: chat.id, name: stringOrEmpty(chat.name) })),
    }
  })
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

export function loadPresetHydration(
  db: DatabaseSync,
  dataDir: string,
  presetId: string,
): PresetHydrationPayload | null {
  const fields = loadPersistedDatabaseFields(db, dataDir, ['botPresets'])
  const presets = fields.botPresets
  if (!Array.isArray(presets)) return null
  for (const preset of presets) {
    if (!isRecord(preset)) continue
    if (preset.id === presetId) {
      return { presetId, preset }
    }
  }
  return null
}

function loadDatabaseFieldsFromSqlite(
  db: DatabaseSync,
  fieldKeys: readonly string[],
): { fields: Record<string, unknown>; settings: Record<string, unknown> | null } {
  const settings = loadSettingsFromSqlite(db)
  if (settings === null) {
    const fields: Record<string, unknown> = {}
    if (fieldKeys.includes('pluginCustomStorage')) {
      fields.pluginCustomStorage = loadPluginCustomStorageFieldFromSqlite(db) ?? {}
    }
    return { fields, settings: null }
  }

  const fields: Record<string, unknown> = {}
  for (const key of fieldKeys) {
    if (key === 'characters') {
      const sqliteChars = loadCharactersFromSqlite(db)
      if (sqliteChars.length > 0 || !Array.isArray(settings.characters)) {
        fields.characters = sqliteChars
      } else {
        fields.characters = settings.characters
      }
      continue
    }

    if (key === 'pluginCustomStorage') {
      const storage = loadPluginCustomStorageFieldFromSqlite(db)
      if (storage !== null) fields.pluginCustomStorage = storage
      else if (!Object.prototype.hasOwnProperty.call(settings, 'pluginCustomStorage')) {
        fields.pluginCustomStorage = {}
      }
      continue
    }

    const tableName = COLLECTION_TABLE_MAP[key]
    if (tableName !== undefined) {
      const collection = loadCollectionFieldFromSqlite(db, tableName)
      if (collection !== null) {
        fields[key] = collection
      } else if (Object.prototype.hasOwnProperty.call(settings, key)) {
        fields[key] = settings[key]
      } else if (key !== 'promptTemplate' && !Object.prototype.hasOwnProperty.call(settings, key)) {
        fields[key] = []
      }
      continue
    }

    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      fields[key] = settings[key]
    }
  }

  if (fieldKeys.includes('promptPresets') && fieldKeys.includes('promptTemplate')) {
    projectSelectedPromptTemplate(fields, settings.promptPresetsId)
  }
  if (fieldKeys.includes('personas')) {
    const projection = { ...settings, ...fields }
    projectSelectedPersonaCompatibilityIndex(projection)
    settings.selectedPersona = projection.selectedPersona
  }
  if (fieldKeys.includes('hypaV3Presets')) {
    const projection = { ...settings, ...fields }
    projectSelectedHypaV3PresetCompatibilityIndex(projection)
    settings.hypaV3PresetId = projection.hypaV3PresetId
  }

  return { fields, settings }
}

function loadCollectionFieldFromSqlite(db: DatabaseSync, tableName: string): unknown[] | null {
  const rows = db.prepare(`SELECT data_json FROM ${tableName} ORDER BY position`).all() as unknown as Array<{
    data_json: string
  }>
  if (rows.length === 0) return null
  return rows.map((row) => JSON.parse(row.data_json))
}

function loadPluginCustomStorageFieldFromSqlite(db: DatabaseSync): Record<string, unknown> | null {
  const rows = db.prepare('SELECT key, value_json FROM plugin_custom_storage').all() as unknown as Array<{
    key: string
    value_json: string
  }>
  if (rows.length === 0) return null
  const storage: Record<string, unknown> = {}
  for (const row of rows) {
    if (isPluginStorageEmptySentinelKey(row.key)) continue
    storage[row.key] = JSON.parse(row.value_json)
  }
  return storage
}

/**
 * Scoped character detail read for resource APIs. Reads one character and its
 * chat metadata without message/hypa bodies. It applies the same optional
 * lorebook-stub boundary as the aggregate character resource.
 */
export function loadSingleCharacterRowForRead(
  db: DatabaseSync,
  dataDir: string,
  characterId: string,
): JsonRecord | null {
  const settings = loadSettingsFromSqlite(db)
  if (settings === null) return loadSingleCharacterRowForReadBroad(db, dataDir, characterId)

  const charRow = db
    .prepare('SELECT id, position, data_json FROM characters WHERE id = ?')
    .get(characterId) as unknown as CharacterRow | undefined
  if (!charRow) return loadSingleCharacterRowForReadBroad(db, dataDir, characterId)

  const character = JSON.parse(charRow.data_json) as unknown
  if (!isRecord(character)) return loadSingleCharacterRowForReadBroad(db, dataDir, characterId)

  const chatRows = db
    .prepare('SELECT id, character_id, position, data_json FROM chats WHERE character_id = ? ORDER BY position')
    .all(charRow.id) as unknown as ChatRow[]
  character.chats = chatRows.map((row) => {
    const chat = parseStoredChatRow(row.data_json)
    if (isRecord(chat)) {
      chat.message = []
      delete chat.hypaV3Data
    }
    return chat
  })
  if (settings.enableLorebookStubs === true) delete character.globalLore
  return character
}

function loadSingleCharacterRowForReadBroad(db: DatabaseSync, dataDir: string, characterId: string): JsonRecord | null {
  return loadCharacterRowsForRead(db, dataDir).find((candidate) => candidate.chaId === characterId) ?? null
}

function stripCharacterGlobalLoreForRead(characters: readonly JsonRecord[]): void {
  for (const character of characters) delete character.globalLore
}

function selectDatabaseFields(
  database: Record<string, unknown>,
  fieldKeys: readonly string[],
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const key of fieldKeys) {
    if (Object.prototype.hasOwnProperty.call(database, key)) {
      fields[key] = database[key]
    }
  }
  return fields
}

// `loadPersistedWithMessages` is the message-aware read boundary used by
// full-corpus readers that need every chat hydrated (migration/backfill,
// export/save, and explicit broad fallbacks). Prompt assembly uses the selected
// `loadPersistedForGenerationAssembly` path below. Messages live in the SQLite
// `messages` table; `loadPersisted` returns message-free chats.

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseStoredChatRow(dataJson: string, measurement?: DisplaySourceLoadMeasurement): unknown {
  const chat = parseDisplaySourceJson(dataJson, measurement)
  if (isRecord(chat)) repairStoredChatGenerationSettings(chat)
  return chat
}

function eachChat(database: unknown, visit: (chat: JsonRecord) => void): void {
  if (!isRecord(database) || !Array.isArray(database.characters)) return
  for (const character of database.characters) {
    if (!isRecord(character) || !Array.isArray(character.chats)) continue
    for (const chat of character.chats) {
      if (isRecord(chat)) visit(chat)
    }
  }
}

function chatIdNeedsRepair(chat: JsonRecord, seen: Set<string>): boolean {
  const id = chat.id
  return typeof id !== 'string' || id.trim() === '' || seen.has(id)
}

function repairChatIds(database: unknown): boolean {
  const seen = new Set<string>()
  let repaired = false
  eachChat(database, (chat) => {
    if (chatIdNeedsRepair(chat, seen)) {
      let id = randomUUID()
      while (seen.has(id)) id = randomUUID()
      chat.id = id
      repaired = true
    }
    seen.add(chat.id as string)
  })
  return repaired
}

function hasEmbeddedChatPayloadsOrBadIds(database: unknown): boolean {
  const seen = new Set<string>()
  let hasWork = false
  eachChat(database, (chat) => {
    if (chatIdNeedsRepair(chat, seen)) hasWork = true
    if (Array.isArray(chat.message) || chat.hypaV3Data !== undefined) hasWork = true
    if (typeof chat.id === 'string' && chat.id.trim() !== '') seen.add(chat.id)
  })
  return hasWork
}

/** `loadPersisted` + join each chat's messages (SQLite, with embedded fallback). */
export function loadPersistedWithMessages(db: DatabaseSync, dataDir: string): Persisted {
  const persisted = loadPersisted(db, dataDir)
  const grouped = getAllChatMessagesGrouped(db)
  const alternatesGrouped = getAllChatAlternateMessagesGrouped(db)
  const hypaGrouped = getAllChatHypaV3Grouped(db)
  eachChat(persisted.database, (chat) => {
    const chatId = chat.id
    if (typeof chatId !== 'string') {
      if (!Array.isArray(chat.message)) chat.message = []
      return
    }
    const rows = grouped.get(chatId)
    if (rows && rows.length > 0) {
      chat.message = rows
    } else if (!Array.isArray(chat.message)) {
      // No SQLite rows and no embedded array → genuinely empty chat.
      chat.message = []
    }
    // else: no rows but an embedded array is present → keep it (fallback).

    // hypaV3Data joins the same way. It is optional, so only set it when the
    // table has a row; otherwise keep any embedded value.
    if (hypaGrouped.has(chatId)) {
      chat.hypaV3Data = hypaGrouped.get(chatId)
    }
    const alternates = alternatesGrouped.get(chatId)
    if (alternates && alternates.length > 0) {
      chat.alternates = alternates
    }
  })
  return persisted
}

/** Target selector for {@link loadPersistedForChatMutation}: the chat row
 *  itself, or (for the message PATCH/DELETE routes) the active message whose
 *  parent chat owns the mutation. */
export interface ChatMutationTarget {
  chatId?: string
  messageId?: string
  /** Skip persisted chat-field repair on both the scoped read and its broad
   * fallback. Used by mutations that must preserve every non-target field. */
  exactChatRow?: boolean
}

/**
 * Chat-scoped read for targeted command-mutation hot paths. A
 * message/scriptstate/generation mutation only locates one chat row and
 * mutates it (or does message-table writes through the kit writers), so it
 * must not pay `loadPersisted`'s 9-collection-table parse, the assets
 * metadata scan, or the whole characters+chats payload parse. Load
 * exactly the target chat row plus its parent character row.
 *
 * Behavior is preserved by construction:
 * - The chats table's PRIMARY KEY makes cross-character chat-id duplicates
 *   impossible in the table, so `normalizeAllCharacterChats`'s global dedup is
 *   a no-op on every state this loader serves; any state it cannot serve
 *   (unknown id, pre-extraction embedded characters) falls back to the broad
 *   `loadPersisted`, where the full normalize still runs.
 * - The single-row reads parse the identical `data_json` payloads the broad
 *   loader would have parsed for the same records.
 *
 * Never combine with a whole-database write-back (`writeDatabase`); the
 * mutation helper guards this.
 */
export function loadPersistedForChatMutation(db: DatabaseSync, dataDir: string, target: ChatMutationTarget): Persisted {
  const broadFallback = () =>
    target.exactChatRow ? loadPersistedWithExactChatRows(db, dataDir) : loadPersisted(db, dataDir)
  let chatId = target.chatId
  if (chatId === undefined && target.messageId !== undefined) {
    // Id-only resolution (no payload column) of the message's parent chat.
    const row = db
      .prepare('SELECT chat_id FROM messages WHERE uid = ? AND alternate = 0 LIMIT 1')
      .get(target.messageId) as { chat_id: string } | undefined
    chatId = row?.chat_id
  }
  if (chatId === undefined) return broadFallback()

  const chatRow = db
    .prepare('SELECT id, character_id, position, data_json FROM chats WHERE id = ?')
    .get(chatId) as unknown as ChatRow | undefined
  if (!chatRow) return broadFallback()

  const charRow = db
    .prepare('SELECT id, position, data_json FROM characters WHERE id = ?')
    .get(chatRow.character_id) as unknown as CharacterRow | undefined
  if (!charRow) return broadFallback()

  const character = JSON.parse(charRow.data_json) as Record<string, unknown>
  if (!isRecord(character)) return broadFallback()
  const chat = target.exactChatRow ? JSON.parse(chatRow.data_json) : parseStoredChatRow(chatRow.data_json)
  const chatRows = db
    .prepare('SELECT id, position FROM chats WHERE character_id = ? ORDER BY position')
    .all(chatRow.character_id) as unknown as Array<Pick<ChatRow, 'id' | 'position'>>
  character.chats = chatRows.map((row) => (row.id === chatRow.id ? chat : { id: row.id }))

  return {
    _version: PERSISTED_VERSION,
    database: { characters: [character] },
    assets: [],
  }
}

/**
 * Legacy broad display-source fallback: `loadPersisted` plus ONLY the target
 * chat's messages/hypaV3. Ordinary generation uses selected configuration and
 * owners through `loadPersistedForGenerationAssembly` instead.
 * Every non-target chat gets `message = []` (downstream `eachChat`-style
 * iteration still sees an array); the target chat keeps
 * `loadPersistedWithMessages`'s exact semantics, including the embedded-array
 * fallback for a chat that is not extracted. Display-source reads retain this
 * path for pre-extraction or malformed storage.
 */
export function loadPersistedForAssembly(db: DatabaseSync, dataDir: string, chatId: string): Persisted {
  const persisted = loadPersisted(db, dataDir)
  hydrateAssemblyModuleBodies(db, persisted.database)
  const rows = getChatMessagesGroupedByIds(db, [chatId]).get(chatId)
  const hypaGrouped = getChatHypaV3GroupedByIds(db, [chatId])
  eachChat(persisted.database, (chat) => {
    if (chat.id !== chatId) {
      chat.message = []
      return
    }
    if (rows && rows.length > 0) {
      chat.message = rows
    } else if (!Array.isArray(chat.message)) {
      chat.message = []
    }
    // else: zero table rows but an embedded array → keep it (fallback).
    if (hypaGrouped.has(chatId)) {
      chat.hypaV3Data = hypaGrouped.get(chatId)
    }
  })
  return persisted
}

export interface GenerationLoadTarget {
  characterId: string
  chatId: string
}

interface GenerationReadScope {
  generationScope: 'selected' | 'legacy'
  /** Only pre-extraction embedded characters need the broad compatibility read. */
  generationLegacyReason?: 'embedded-characters'
  /** Failure detail for the route's existing missing-entity errors. */
  missingTarget?: 'database' | 'character' | 'chat'
}

export interface GenerationPreflightLoad extends GenerationReadScope {
  preflightInputs: { database: unknown; currentChar: unknown; currentChat: unknown } | null
}

export interface GenerationPersisted extends Persisted, GenerationReadScope {
  /** Captured referenced names, including explicit misses; never fake sibling characters. */
  speakerNames?: Readonly<Record<string, string | undefined>>
}

type GenerationCollectionTable = 'model_presets' | 'prompt_presets' | 'personas' | 'modules' | 'hypa_v3_presets'

// Cache fixed query programs, never configuration or query results. SQLite
// keeps the last parameter bindings on a prepared statement, so large dynamic
// selectors bypass this cache instead of retaining an unbounded request value.
const GENERATION_STATEMENT_LIMIT = 16
const GENERATION_STATEMENT_BINDING_BYTES = 4096
const generationStatements = new WeakMap<DatabaseSync, Map<string, StatementSync>>()

function prepareGenerationRead(
  db: DatabaseSync,
  sql: string,
  parameters: readonly SQLInputValue[] = [],
): StatementSync {
  const parameterBytes = parameters.reduce<number>(
    (size, value) =>
      size + (typeof value === 'string' ? Buffer.byteLength(value) : ArrayBuffer.isView(value) ? value.byteLength : 8),
    0,
  )
  if (parameterBytes > GENERATION_STATEMENT_BINDING_BYTES) return db.prepare(sql)
  let statements = generationStatements.get(db)
  if (!statements) generationStatements.set(db, (statements = new Map()))
  const cached = statements.get(sql)
  if (cached) return cached
  const statement = db.prepare(sql)
  if (statements.size < GENERATION_STATEMENT_LIMIT) statements.set(sql, statement)
  return statement
}

interface GenerationTargetRow {
  character_json: string
  chat_json: string
  model_presets_present: number
  prompt_presets_present: number
  personas_present: number
  modules_present: number
  hypa_v3_presets_present: number
}

interface GenerationSelectedRows {
  database: JsonRecord
  currentChar: JsonRecord
  currentChat: JsonRecord
  speakerNames?: Readonly<Record<string, string>>
}

interface GenerationSelectedLoad extends GenerationReadScope {
  rows: GenerationSelectedRows | null
  missingTarget?: GenerationPreflightLoad['missingTarget']
}

/**
 * Readiness requires selected configuration and owner metadata, not transcripts,
 * Hypa chat bodies, or character descriptions. Keep the raw records unknown at
 * the public boundary so the prompt-owned decoder must validate them.
 */
export function loadPersistedForGenerationPreflight(
  db: DatabaseSync,
  dataDir: string,
  target: GenerationLoadTarget,
): GenerationPreflightLoad {
  const loaded = loadGenerationSelectedRows(db, dataDir, target, false)
  return {
    generationScope: loaded.generationScope,
    ...(loaded.generationLegacyReason ? { generationLegacyReason: loaded.generationLegacyReason } : {}),
    preflightInputs: loaded.rows,
    ...(loaded.missingTarget ? { missingTarget: loaded.missingTarget } : {}),
  }
}

/**
 * Ordinary generation loads one character/chat and selected collection owners.
 * Asset bytes stay behind the existing request-scoped stored-asset resolver.
 * The historical assembly loader remains available for explicit legacy callers.
 */
export function loadPersistedForGenerationAssembly(
  db: DatabaseSync,
  dataDir: string,
  target: GenerationLoadTarget,
): GenerationPersisted {
  const loaded = loadGenerationSelectedRows(db, dataDir, target, true)
  if (!loaded.rows)
    return {
      ...emptyPersisted(),
      generationScope: loaded.generationScope,
      ...(loaded.generationLegacyReason ? { generationLegacyReason: loaded.generationLegacyReason } : {}),
      ...(loaded.missingTarget ? { missingTarget: loaded.missingTarget } : {}),
    }
  const { database, currentChar, currentChat } = loaded.rows
  hydrateGenerationTargetChat(db, currentChat, target.chatId)
  const speakerNames = captureGenerationSpeakerNames(db, currentChar, currentChat, loaded.rows.speakerNames)
  currentChar.chatPage = 0
  currentChar.chats = [currentChat]
  database.currentChar = 0
  database.characters = [currentChar]
  return {
    _version: PERSISTED_VERSION,
    database,
    assets: [],
    generationScope: loaded.generationScope,
    ...(loaded.generationLegacyReason ? { generationLegacyReason: loaded.generationLegacyReason } : {}),
    ...(speakerNames ? { speakerNames } : {}),
  }
}

function captureGenerationSpeakerNames(
  db: DatabaseSync,
  currentChar: JsonRecord,
  currentChat: JsonRecord,
  embeddedNames?: Readonly<Record<string, string>>,
): Readonly<Record<string, string | undefined>> | undefined {
  // Scripts can change a stored message's role while preserving its saying ID.
  // Capture all existing references before any awaited script/provider work.
  const ids = new Set(
    generationRecords(currentChat.message).flatMap((message) =>
      typeof message.saying === 'string' && message.saying !== '' ? [message.saying] : [],
    ),
  )
  if (ids.size === 0) return undefined
  const names: Record<string, string | undefined> = {}
  const pending: string[] = []
  for (const id of ids) {
    const name =
      id === currentChar.chaId
        ? currentChar.name
        : embeddedNames && Object.prototype.hasOwnProperty.call(embeddedNames, id)
          ? embeddedNames[id]
          : undefined
    Object.defineProperty(names, id, {
      value: typeof name === 'string' ? name : undefined,
      enumerable: true,
      writable: true,
    })
    // A legacy embedded snapshot is complete, including a missing ID. Do not
    // replace that absence with a later SQL lookup against another snapshot.
    if (id !== currentChar.chaId && !embeddedNames) pending.push(id)
  }
  if (pending.length > 0) {
    const rows = db
      .prepare(
        `SELECT id, json_extract(data_json, '$.name') AS name FROM characters
      WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(pending))
    for (const row of rows) {
      if (typeof row.id === 'string' && typeof row.name === 'string') names[row.id] = row.name
    }
  }
  return names
}

function loadGenerationSelectedRows(
  db: DatabaseSync,
  dataDir: string,
  target: GenerationLoadTarget,
  includeHistory: boolean,
): GenerationSelectedLoad {
  // Preserve the existing inline-secret repair boundary and its credential
  // semantics. This one settings document remains configuration-scoped work.
  const settings = parseAndRepairSettingsRow(
    db,
    prepareGenerationRead(db, 'SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined,
  )
  if (!settings) return { generationScope: 'selected', rows: null, missingTarget: 'database' }
  const characterProjection = includeHistory
    ? 'character.data_json'
    : `json_object('chaId', json_extract(character.data_json, '$.chaId'),
        'modules', json(character.data_json -> '$.modules'),
        'supaMemory', json(character.data_json -> '$.supaMemory'))`
  const chatProjection = includeHistory
    ? 'chat.data_json'
    : `json_object('id', json_extract(chat.data_json, '$.id'),
        'generationSettings', json(chat.data_json -> '$.generationSettings'),
        'modules', json(chat.data_json -> '$.modules'),
        'hypaContextTruncationAcknowledged', json(chat.data_json -> '$.hypaContextTruncationAcknowledged'))`
  // Presence checks share the target result row. Empty extracted tables retain
  // their embedded compatibility value; an ID miss in a nonempty table cannot.
  const row = prepareGenerationRead(
    db,
    `SELECT ${characterProjection} AS character_json, ${chatProjection} AS chat_json,
      EXISTS(SELECT 1 FROM model_presets) AS model_presets_present,
      EXISTS(SELECT 1 FROM prompt_presets) AS prompt_presets_present,
      EXISTS(SELECT 1 FROM personas) AS personas_present,
      EXISTS(SELECT 1 FROM modules) AS modules_present,
      EXISTS(SELECT 1 FROM hypa_v3_presets) AS hypa_v3_presets_present
    FROM chats AS chat JOIN characters AS character ON character.id = chat.character_id
    WHERE chat.id = ? AND character.id = ?`,
    [target.chatId, target.characterId],
  ).get(target.chatId, target.characterId) as unknown as GenerationTargetRow | undefined
  if (!row) {
    const embeddedCharacters = Array.isArray(settings.characters) ? settings.characters : []
    if (embeddedCharacters.length > 0 && !db.prepare('SELECT 1 AS present FROM characters LIMIT 1').get()) {
      return loadLegacyGenerationSelectedRows(db, dataDir, target, includeHistory)
    }
    const characterExists = db
      .prepare("SELECT 1 AS present FROM characters WHERE id = ? AND json_extract(data_json, '$.chaId') = ?")
      .get(target.characterId, target.characterId)
    return { generationScope: 'selected', rows: null, missingTarget: characterExists ? 'chat' : 'character' }
  }
  const currentChar = JSON.parse(row.character_json) as unknown
  const currentChat = parseStoredChatRow(row.chat_json)
  if (!isRecord(currentChar) || currentChar.chaId !== target.characterId)
    return { generationScope: 'selected', rows: null, missingTarget: 'character' }
  if (!isRecord(currentChat) || currentChat.id !== target.chatId)
    return { generationScope: 'selected', rows: null, missingTarget: 'chat' }
  if (!includeHistory) {
    removeNullGenerationMetadata(currentChar)
    removeNullGenerationMetadata(currentChat)
  }
  const database = selectGenerationConfiguration(db, settings, row, currentChar, currentChat, includeHistory)
  return { generationScope: 'selected', rows: { database, currentChar, currentChat } }
}

function removeNullGenerationMetadata(record: JsonRecord): void {
  for (const key of Object.keys(record)) if (record[key] === null) delete record[key]
}

function selectGenerationConfiguration(
  db: DatabaseSync,
  settings: JsonRecord,
  presence: GenerationTargetRow,
  currentChar: JsonRecord,
  currentChat: JsonRecord,
  includeHistory: boolean,
): JsonRecord {
  const chatSettings = normalizeStoredChatGenerationSettings(currentChat.generationSettings)
  const read = (table: GenerationCollectionTable, field: string, id: unknown, limit = 1) =>
    readGenerationCollectionSelection(db, table, settings[field], presence[`${table}_present`], id, limit)
  const modelPresets = read('model_presets', 'modelPresets', chatSettings?.modelPresetId)
  const promptPresets = read('prompt_presets', 'promptPresets', chatSettings?.promptPresetId, 2)
  const personas = read('personas', 'personas', chatSettings?.personaId)
  const agentPresetId = resolveEffectiveAgentPresetId(
    {
      agentPresetDefaultId:
        typeof settings.agentPresetDefaultId === 'string' ? settings.agentPresetDefaultId : undefined,
    },
    chatSettings,
  )
  const agentPresets = agentPresetId
    ? generationRecords(settings.agentPresets)
        .filter((preset) => preset.id === agentPresetId)
        .slice(0, 1)
    : []
  const agentIds = new Set(generationRecords(agentPresets[0]?.agentUses).map((use) => use.agentId))
  const agents = generationRecords(settings.agents).filter((agent) => agentIds.has(agent.id))
  const promptPreset = promptPresets.length === 1 ? promptPresets[0] : undefined
  const identifiers = [
    ...new Set([
      ...generationStringArray(settings.enabledModules),
      ...generationStringArray(currentChar.modules),
      ...generationStringArray(currentChat.modules),
      ...generationStringArray(personas[0]?.modules),
      ...parseModuleIntegration(promptPreset?.moduleIntergration),
      ...parseModuleIntegration(resolveAgentPresetModuleIntegration(agentPresets, agentPresetId)),
    ]),
  ]
  const modules = readGenerationModules(db, settings.modules, presence.modules_present, identifiers, includeHistory)
  const database = { ...settings }
  for (const field of COLLECTION_FIELDS) delete database[field]
  delete database.characters
  delete database.pluginCustomStorage
  Object.assign(database, { modelPresets, promptPresets, personas, modules, agents, agentPresets })
  database.modelPresetsId = modelPresets.length ? 0 : -1
  database.promptPresetsId = promptPresets.length ? 0 : -1
  if (
    promptPreset &&
    isDefaultPromptPreset(promptPreset) &&
    !Object.prototype.hasOwnProperty.call(promptPreset, 'promptTemplate')
  ) {
    const rootTemplate = loadCollectionFieldFromSqlite(db, 'prompt_templates')
    if (rootTemplate !== null) database.promptTemplate = rootTemplate
    else if (Object.prototype.hasOwnProperty.call(settings, 'promptTemplate'))
      database.promptTemplate = settings.promptTemplate
  }
  projectSelectedPromptTemplate(database, database.promptPresetsId)
  database.selectedPersona = selectedPersonaIndexFromStableId(database)
  if (includeHistory) {
    database.hypaV3Presets = read('hypa_v3_presets', 'hypaV3Presets', settings.selectedHypaV3PresetId, 2)
    projectSelectedHypaV3PresetCompatibilityIndex(database)
  }
  return database
}

function readGenerationCollectionSelection(
  db: DatabaseSync,
  table: GenerationCollectionTable,
  embedded: unknown,
  tablePresent: number,
  id: unknown,
  limit: number,
  measurement?: DisplaySourceLoadMeasurement,
): JsonRecord[] {
  if (typeof id !== 'string' || id.trim() === '') return []
  if (!tablePresent)
    return generationRecords(embedded)
      .filter((record) => record.id === id)
      .slice(0, limit)
  const rows = readDisplaySourceData(measurement, () =>
    prepareGenerationRead(
      db,
      `SELECT data_json FROM ${table}
    WHERE json_extract(data_json, '$.id') = ? ORDER BY position LIMIT ?`,
      [id, limit],
    ).all(id, limit),
  )
  return rows.flatMap((row) => {
    const parsed: unknown =
      typeof row.data_json === 'string' ? parseDisplaySourceJson(row.data_json, measurement) : undefined
    return isRecord(parsed) && parsed.id === id ? [parsed] : []
  })
}

function readGenerationModules(
  db: DatabaseSync,
  embedded: unknown,
  tablePresent: number,
  identifiers: readonly string[],
  includeBodies: boolean,
  measurement?: DisplaySourceLoadMeasurement,
): JsonRecord[] {
  if (identifiers.length === 0) return []
  let records: JsonRecord[]
  if (!tablePresent) {
    const wanted = new Set(identifiers)
    records = generationRecords(embedded).filter(
      (module) =>
        (typeof module.id === 'string' && wanted.has(module.id)) ||
        (typeof module.namespace === 'string' && wanted.has(module.namespace)),
    )
  } else {
    const projection = includeBodies
      ? 'data_json'
      : `json_object('id', json_extract(data_json, '$.id'),
      'namespace', json_extract(data_json, '$.namespace'),
      'customModuleToggle', json_extract(data_json, '$.customModuleToggle'))`
    const selection = JSON.stringify(identifiers)
    const rows = readDisplaySourceData(measurement, () =>
      prepareGenerationRead(
        db,
        `SELECT ${projection} AS data_json FROM modules
      WHERE json_extract(data_json, '$.id') IN (SELECT value FROM json_each(?))
        OR json_extract(data_json, '$.namespace') IN (SELECT value FROM json_each(?))
      ORDER BY position`,
        [selection, selection],
      ).all(selection, selection),
    )
    records = rows.flatMap((row) => {
      const parsed: unknown =
        typeof row.data_json === 'string' ? parseDisplaySourceJson(row.data_json, measurement) : undefined
      return isRecord(parsed) ? [parsed] : []
    })
  }
  // The shared activation resolver deduplicates only after a matching row and
  // preserves collection order. Keep matching duplicate rows here so it remains
  // the single owner of that policy.
  return includeBodies
    ? records
    : records.map((module) => {
        const metadata = { id: module.id, namespace: module.namespace, customModuleToggle: module.customModuleToggle }
        removeNullGenerationMetadata(metadata)
        return metadata
      })
}

function generationRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function generationStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function hydrateGenerationTargetChat(
  db: DatabaseSync,
  chat: JsonRecord,
  chatId: string,
  measurements?: { messages: DisplaySourceLoadMeasurement; memory: DisplaySourceLoadMeasurement },
): void {
  const messages = readDisplaySourceData(measurements?.messages, () =>
    prepareGenerationRead(db, 'SELECT json FROM messages WHERE alternate = 0 AND chat_id = ? ORDER BY seq', [
      chatId,
    ]).all(chatId),
  ) as { json: string }[]
  if (messages.length > 0)
    chat.message = messages.map((row) => parseDisplaySourceJson(row.json, measurements?.messages))
  else if (!Array.isArray(chat.message)) chat.message = []
  const hypa = readDisplaySourceData(measurements?.memory, () =>
    prepareGenerationRead(db, 'SELECT json FROM chat_hypa_v3 WHERE chat_id = ?', [chatId]).get(chatId),
  ) as { json: string } | undefined
  if (hypa) chat.hypaV3Data = parseDisplaySourceJson(hypa.json, measurements?.memory)
}

function loadLegacyGenerationSelectedRows(
  db: DatabaseSync,
  dataDir: string,
  target: GenerationLoadTarget,
  includeHistory: boolean,
): GenerationSelectedLoad {
  // Pre-extraction settings already contain the embedded library JSON. Keep the
  // old collection precedence/repair behavior but never scan asset metadata or
  // hydrate transcripts during preflight.
  const database = loadPersistedDatabase(db, dataDir)
  const scope = { generationScope: 'legacy' as const, generationLegacyReason: 'embedded-characters' as const }
  if (!isRecord(database)) return { ...scope, rows: null, missingTarget: 'database' }
  const currentChar = generationRecords(database.characters).find((character) => character.chaId === target.characterId)
  if (!currentChar) return { ...scope, rows: null, missingTarget: 'character' }
  const currentChat = generationRecords(currentChar.chats).find((chat) => chat.id === target.chatId)
  if (!currentChat) return { ...scope, rows: null, missingTarget: 'chat' }
  const settings = { ...database }
  delete settings.characters
  if (includeHistory) {
    const speakerNames: Record<string, string> = {}
    for (const character of generationRecords(database.characters)) {
      if (
        typeof character.chaId === 'string' &&
        typeof character.name === 'string' &&
        !Object.prototype.hasOwnProperty.call(speakerNames, character.chaId)
      ) {
        Object.defineProperty(speakerNames, character.chaId, { value: character.name, enumerable: true })
      }
    }
    return { ...scope, rows: { database: settings, currentChar, currentChat, speakerNames } }
  }
  const characterMetadata = {
    chaId: currentChar.chaId,
    modules: currentChar.modules,
    supaMemory: currentChar.supaMemory,
  }
  const chatMetadata = {
    id: currentChat.id,
    generationSettings: currentChat.generationSettings,
    modules: currentChat.modules,
    hypaContextTruncationAcknowledged: currentChat.hypaContextTruncationAcknowledged,
  }
  repairStoredChatGenerationSettings(chatMetadata)
  return { ...scope, rows: { database: settings, currentChar: characterMetadata, currentChat: chatMetadata } }
}

interface DisplaySourceTargetRow {
  character_json: string
  chat_json: string
  prompt_presets_present: number
  personas_present: number
  modules_present: number
}

function readDisplayCollectionSelections(
  db: DatabaseSync,
  table: 'personas',
  embedded: unknown,
  tablePresent: number,
  ids: readonly string[],
  measurement?: DisplaySourceLoadMeasurement,
): JsonRecord[] {
  if (ids.length === 0) return []
  const wanted = new Set(ids)
  if (!tablePresent) {
    return generationRecords(embedded).filter((record) => typeof record.id === 'string' && wanted.has(record.id))
  }
  const selection = JSON.stringify(ids)
  const rows = readDisplaySourceData(measurement, () =>
    prepareGenerationRead(
      db,
      `SELECT data_json FROM ${table}
    WHERE json_extract(data_json, '$.id') IN (SELECT value FROM json_each(?))
    ORDER BY position`,
      [selection],
    ).all(selection),
  )
  return rows.flatMap((row) => {
    const parsed: unknown =
      typeof row.data_json === 'string' ? parseDisplaySourceJson(row.data_json, measurement) : undefined
    return isRecord(parsed) && typeof parsed.id === 'string' && wanted.has(parsed.id) ? [parsed] : []
  })
}

function displayModulePersonaId(settings: JsonRecord, currentChat: JsonRecord): string | null {
  const chatSettings = normalizeStoredChatGenerationSettings(currentChat.generationSettings)
  if (currentChat.generationSettings !== undefined) {
    return typeof chatSettings?.personaId === 'string' && chatSettings.personaId.trim() ? chatSettings.personaId : null
  }
  if (typeof currentChat.bindedPersona === 'string' && currentChat.bindedPersona.trim()) {
    return currentChat.bindedPersona
  }
  return typeof settings.selectedPersonaId === 'string' && settings.selectedPersonaId.trim()
    ? settings.selectedPersonaId
    : null
}

function dedupeDisplayModules(value: unknown): JsonRecord[] {
  const modules = generationRecords(value)
  const seenModuleIds = new Set<unknown>()
  return modules.filter((module) => {
    if (seenModuleIds.has(module.id)) return false
    seenModuleIds.add(module.id)
    return true
  })
}

function selectDisplaySourceConfiguration(
  db: DatabaseSync,
  settings: JsonRecord,
  presence: Pick<DisplaySourceTargetRow, 'prompt_presets_present' | 'personas_present' | 'modules_present'>,
  currentChar: JsonRecord,
  currentChat: JsonRecord,
  diagnostics?: DisplaySourceDiagnostics,
): JsonRecord {
  const chatSettings = normalizeStoredChatGenerationSettings(currentChat.generationSettings)
  const promptPresets = readGenerationCollectionSelection(
    db,
    'prompt_presets',
    settings.promptPresets,
    presence.prompt_presets_present,
    chatSettings?.promptPresetId,
    2,
    diagnostics?.load('promptPresets'),
  )
  const globalPersonaId =
    typeof settings.selectedPersonaId === 'string' && settings.selectedPersonaId.trim()
      ? settings.selectedPersonaId
      : null
  const modulePersonaId = displayModulePersonaId(settings, currentChat)
  const personaIds = [...new Set([globalPersonaId, modulePersonaId].filter((id): id is string => id !== null))]
  const personas = readDisplayCollectionSelections(
    db,
    'personas',
    settings.personas,
    presence.personas_present,
    personaIds,
    diagnostics?.load('personas'),
  )
  const agentPresetId = resolveEffectiveAgentPresetId(
    {
      agentPresetDefaultId:
        typeof settings.agentPresetDefaultId === 'string' ? settings.agentPresetDefaultId : undefined,
    },
    chatSettings,
  )
  const agentPresets = agentPresetId
    ? generationRecords(settings.agentPresets)
        .filter((preset) => preset.id === agentPresetId)
        .slice(0, 1)
    : []
  const promptPreset = promptPresets.length === 1 ? promptPresets[0] : undefined
  const modulePersona = modulePersonaId ? personas.find((persona) => persona.id === modulePersonaId) : undefined
  const identifiers = [
    ...new Set([
      ...generationStringArray(settings.enabledModules),
      ...generationStringArray(currentChar.modules),
      ...generationStringArray(currentChat.modules),
      ...generationStringArray(modulePersona?.modules),
      ...parseModuleIntegration(promptPreset?.moduleIntergration),
      ...parseModuleIntegration(resolveAgentPresetModuleIntegration(agentPresets, agentPresetId)),
    ]),
  ]
  const modules = dedupeDisplayModules(
    readGenerationModules(
      db,
      settings.modules,
      presence.modules_present,
      identifiers,
      true,
      diagnostics?.load('modules'),
    ),
  )
  const database = { ...settings }
  for (const field of COLLECTION_FIELDS) delete database[field]
  delete database.characters
  delete database.pluginCustomStorage
  Object.assign(database, { promptPresets, personas, modules, agentPresets, agents: [] })
  database.promptPresetsId = promptPresets.length ? 0 : -1
  database.selectedPersona = selectedPersonaIndexFromStableId(database)
  return database
}

function displaySourcePersistedFromRows(
  db: DatabaseSync,
  settings: JsonRecord,
  presence: Pick<DisplaySourceTargetRow, 'prompt_presets_present' | 'personas_present' | 'modules_present'>,
  character: JsonRecord,
  chat: JsonRecord,
  chatId: string,
  hydrate: boolean,
  diagnostics?: DisplaySourceDiagnostics,
): Persisted {
  if (hydrate)
    hydrateGenerationTargetChat(
      db,
      chat,
      chatId,
      diagnostics
        ? {
            messages: diagnostics.load('messages'),
            memory: diagnostics.load('memory'),
          }
        : undefined,
    )
  const selectConfiguration = () =>
    selectDisplaySourceConfiguration(db, settings, presence, character, chat, diagnostics)
  const database = diagnostics
    ? diagnostics.measurePreparation('configurationMs', selectConfiguration)
    : selectConfiguration()
  character.chatPage = 0
  character.chats = [chat]
  database.currentChar = 0
  database.characters = [character]
  return { _version: PERSISTED_VERSION, database, assets: [] }
}

/**
 * Display projection selects its one character/chat, selected prompt/persona
 * owners and only executable modules that survive activation order/dedup.
 * Inactive collection bodies never enter the display decoder.
 */
export function loadPersistedForDisplaySource(
  db: DatabaseSync,
  dataDir: string,
  target: GenerationLoadTarget,
  diagnostics?: DisplaySourceDiagnostics,
): Persisted {
  if (diagnostics) diagnostics.preparation.loadPath = 'selected'
  const settings = loadSettingsFromSqlite(db, diagnostics?.load('settings'))
  if (settings !== null) {
    const measurement = diagnostics?.load('target')
    const row = readDisplaySourceData(measurement, () =>
      prepareGenerationRead(
        db,
        `SELECT character.data_json AS character_json, chat.data_json AS chat_json,
        EXISTS(SELECT 1 FROM prompt_presets) AS prompt_presets_present,
        EXISTS(SELECT 1 FROM personas) AS personas_present,
        EXISTS(SELECT 1 FROM modules) AS modules_present
      FROM chats AS chat JOIN characters AS character ON character.id = chat.character_id
      WHERE chat.id = ? AND character.id = ?`,
        [target.chatId, target.characterId],
      ).get(target.chatId, target.characterId),
    ) as unknown as DisplaySourceTargetRow | undefined
    if (row) {
      const character = parseDisplaySourceJson(row.character_json, measurement)
      const chat = parseStoredChatRow(row.chat_json, measurement)
      if (
        isRecord(character) &&
        character.chaId === target.characterId &&
        isRecord(chat) &&
        chat.id === target.chatId
      ) {
        return displaySourcePersistedFromRows(db, settings, row, character, chat, target.chatId, true, diagnostics)
      }
    }
  }

  if (diagnostics) diagnostics.preparation.loadPath = 'legacy'
  const loadLegacy = () => loadLegacyGenerationSelectedRows(db, dataDir, target, true)
  const legacy = diagnostics ? diagnostics.measurePreparation('legacyLoadMs', loadLegacy) : loadLegacy()
  if (!legacy.rows) return emptyPersisted()
  return displaySourcePersistedFromRows(
    db,
    legacy.rows.database,
    { prompt_presets_present: 0, personas_present: 0, modules_present: 0 },
    legacy.rows.currentChar,
    legacy.rows.currentChat,
    target.chatId,
    false,
    diagnostics,
  )
}

/**
 * Prompt assembly and post-generation module runtime need executable module
 * children (`trigger`, `regex`, `lorebook`, `assets`, ...), so keep generation
 * pinned to the authoritative server collection table whenever it exists.
 */
export function hydrateAssemblyModuleBodies(db: DatabaseSync, database: unknown): void {
  if (!isRecord(database)) return
  const modules = loadCollectionFieldFromSqlite(db, 'modules')
  if (modules === null) return
  database.modules = modules
}

/**
 * Memory-job-scoped database read. Both worker handlers read settings-level
 * fields (the hypa settings/presets/keys and model-routing fields); summarize
 * additionally requests the target chat's generation-settings references.
 * Summaries resolve the memory role from the model/prompt presets bound to that
 * chat, so load those two rows without hydrating either whole collection. The
 * path still must not pay `loadPersisted`'s whole
 * characters+chats payload parse, its 9-collection-table parse, or the
 * assets metadata scan on every batch. Load the settings row, override
 * `hypaV3Presets` from its table, and keep every non-target chat as an id-only
 * stub.
 *
 * States the scoped read cannot serve fall back to the broad loader so
 * behavior stays identical: an uninitialized settings table returns the same
 * `null`, and a pre-extraction database (no character rows but an embedded
 * `characters` array in the settings JSON) keeps its embedded fallback.
 */
export function loadPersistedDatabaseForMemoryJob(db: DatabaseSync, dataDir: string, chatId?: string): unknown {
  const settings = loadSettingsFromSqlite(db)
  if (settings === null) return loadPersisted(db, dataDir).database

  const charRows = db.prepare('SELECT id, position FROM characters ORDER BY position').all() as unknown as Array<
    Pick<CharacterRow, 'id' | 'position'>
  >
  if (charRows.length === 0 && Array.isArray(settings.characters)) {
    return loadPersisted(db, dataDir).database
  }

  const chatRows = db
    .prepare('SELECT id, character_id FROM chats ORDER BY character_id, position')
    .all() as unknown as Array<Pick<ChatRow, 'id' | 'character_id'>>
  const targetChatRow = chatId
    ? (db.prepare('SELECT id, character_id, data_json FROM chats WHERE id = ?').get(chatId) as unknown as
        | Pick<ChatRow, 'id' | 'character_id' | 'data_json'>
        | undefined)
    : undefined
  const parsedTargetChat = targetChatRow ? parseStoredChatRow(targetChatRow.data_json) : null
  const chatsByCharId = new Map<string, Array<{ id: string }>>()
  for (const row of chatRows) {
    const list = chatsByCharId.get(row.character_id) ?? []
    list.push(
      row.id === chatId && isRecord(parsedTargetChat)
        ? ({ ...parsedTargetChat, id: row.id } as { id: string })
        : { id: row.id },
    )
    chatsByCharId.set(row.character_id, list)
  }
  settings.characters = charRows.map((row) => ({
    chaId: row.id,
    chats: chatsByCharId.get(row.id) ?? [],
  }))

  // Mirror `loadCollectionsFromSqlite`: the table wins only when non-empty,
  // otherwise any embedded settings value is kept.
  const presetRows = db.prepare('SELECT data_json FROM hypa_v3_presets ORDER BY position').all() as unknown as Array<{
    data_json: string
  }>
  if (presetRows.length > 0) {
    settings.hypaV3Presets = presetRows.map((row) => JSON.parse(row.data_json))
  }
  projectSelectedHypaV3PresetCompatibilityIndex(settings)

  if (isRecord(parsedTargetChat) && isRecord(parsedTargetChat.generationSettings)) {
    const modelPresetId = parsedTargetChat.generationSettings.modelPresetId
    const promptPresetId = parsedTargetChat.generationSettings.promptPresetId
    if (typeof modelPresetId === 'string' && modelPresetId.trim()) {
      const modelPreset = loadMemoryJobBoundPreset(db, 'model_presets', modelPresetId)
      if (modelPreset) settings.modelPresets = [modelPreset]
    }
    if (typeof promptPresetId === 'string' && promptPresetId.trim()) {
      const promptPreset = loadMemoryJobBoundPreset(db, 'prompt_presets', promptPresetId)
      if (promptPreset) settings.promptPresets = [promptPreset]
    }
  }
  return settings
}

function loadMemoryJobBoundPreset(
  db: DatabaseSync,
  tableName: 'model_presets' | 'prompt_presets',
  presetId: string,
): Record<string, unknown> | null {
  if (tableName !== 'prompt_presets') {
    const row = db
      .prepare(`SELECT data_json FROM ${tableName} WHERE json_extract(data_json, '$.id') = ? LIMIT 1`)
      .get(presetId) as { data_json: string } | undefined
    if (!row) return null
    const preset = JSON.parse(row.data_json) as unknown
    return isRecord(preset) ? preset : null
  }

  const rows = db
    .prepare(`SELECT data_json FROM ${tableName} WHERE json_extract(data_json, '$.id') = ? ORDER BY position`)
    .all(presetId) as unknown as Array<{ data_json: string }>
  let match: Record<string, unknown> | null = null
  for (const row of rows) {
    const preset = JSON.parse(row.data_json) as unknown
    if (!isRecord(preset) || stablePromptPresetId(preset.id) !== presetId) continue
    if (match) return null
    match = preset
  }
  return match
}

/**
 * Split each chat's `message[]` into the messages table and return the
 * message-free `Persisted`. Pure SQLite write — runs inside the caller's open
 * transaction.
 *
 * The `next.database` object is mutated in place (its chats lose `message`) —
 * callers pass a throwaway clone.
 */
export function splitChatMessagesIntoTable(db: DatabaseSync, next: Persisted): Persisted {
  repairChatIds(next.database)
  const chats: { chatId: string; messages: unknown[] }[] = []
  const alternateChats: { chatId: string; alternates: unknown[] }[] = []
  const hypa: { chatId: string; hypaV3Data: unknown }[] = []
  eachChat(next.database, (chat) => {
    const messages = Array.isArray(chat.message) ? chat.message : []
    const alternates = Array.isArray(chat.alternates) ? chat.alternates : []
    const chatId = chat.id as string
    chats.push({ chatId, messages })
    alternateChats.push({ chatId, alternates })
    hypa.push({ chatId, hypaV3Data: chat.hypaV3Data })
    delete chat.message
    delete chat.alternates
    delete chat.hypaV3Data
  })
  replaceAllChatMessages(db, chats)
  insertAllChatAlternateMessages(db, alternateChats)
  replaceAllChatHypaV3(db, hypa)
  return next
}

/**
 * Convenience for non-transactional callers (and tests): split messages into
 * SQLite tables and sync all table families.
 */
export function writePersistedWithMessages(db: DatabaseSync, _dataDir: string, next: Persisted): void {
  if (isRecord(next.database)) migrateLegacyFlatModelConfiguration(next.database)
  const messageFree = splitChatMessagesIntoTable(db, next)
  replaceAllCharactersInTable(db, messageFree.database)
  replaceAllCollectionsInTable(db, messageFree.database)
  replaceAllSettingsInTable(db, messageFree.database)
}

/**
 * Surgical message persistence for the command path. Diff each chat's
 * `message[]` between the hydrated `baselineDatabase` and mutated `nextDatabase`,
 * writing only changed rows. Removed chats have their rows dropped. Runs inside
 * the caller's open transaction; does NOT touch db.json.
 */
export function syncChatMessages(db: DatabaseSync, baselineDatabase: unknown, nextDatabase: unknown): void {
  const baseline = new Map<string, unknown[]>()
  const baselineHypa = new Map<string, unknown>()
  eachChat(baselineDatabase, (chat) => {
    if (typeof chat.id === 'string') {
      baseline.set(chat.id, Array.isArray(chat.message) ? chat.message : [])
      baselineHypa.set(chat.id, chat.hypaV3Data)
    }
  })
  const nextIds = new Set<string>()
  eachChat(nextDatabase, (chat) => {
    if (typeof chat.id !== 'string') return
    nextIds.add(chat.id)
    const next = Array.isArray(chat.message) ? chat.message : []
    applyChatMessageDiff(db, chat.id, baseline.get(chat.id) ?? [], next)
    // Persist hypaV3Data only when it changed, like messages.
    if (JSON.stringify(baselineHypa.get(chat.id)) !== JSON.stringify(chat.hypaV3Data)) {
      setChatHypaV3(db, chat.id, chat.hypaV3Data)
    }
  })
  for (const chatId of baseline.keys()) {
    if (!nextIds.has(chatId)) {
      deleteChatMessages(db, chatId)
      deleteChatHypaV3(db, chatId)
    }
  }
}

/** Strip every chat's `message[]` + `hypaV3Data` for message-free wire/table writes. */
export function stripChatMessages(next: Persisted): Persisted {
  eachChat(next.database, (chat) => {
    delete chat.message
    delete chat.hypaV3Data
  })
  return next
}

/**
 * One-time boot migration: if a legacy `db.json` still exists, import all its
 * data into SQLite (settings, characters, collections, assets, messages) and,
 * only after the commit is checkpointed to the main database file, rename the
 * source to `db.json.migrated`. A crash after the durable commit but before the
 * rename leaves `db.json` in place for a harmless replacement import on the
 * next boot, before API writes can interleave. Once renamed, later boots are a
 * no-op.
 */
export function ensureDbJsonImported(db: DatabaseSync, dataDir: string, logger?: LegacyDatabaseImportLogger): void {
  const file = dbJsonPath(dataDir)
  if (!fs.existsSync(file)) return

  let transactionOpen = false
  try {
    db.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    importLegacyDatabaseSnapshot(db, file)
    db.exec('COMMIT')
    transactionOpen = false
  } catch (err) {
    if (transactionOpen) db.exec('ROLLBACK')
    if (err instanceof LegacyDatabaseSnapshotEnvelopeError) {
      quarantineInvalidLegacyDatabaseSnapshot(file, logger)
      return
    }
    if (err instanceof LegacyDatabaseSnapshotParseError) {
      logLegacyDatabaseImportError(
        logger,
        { err: err.cause, filePath: file },
        'Legacy database snapshot could not be parsed. Repair or move the file, then restart the server; the file was left untouched',
      )
    }
    throw err
  }

  // WAL + synchronous=NORMAL can lose the newest commit on power failure.
  // Force the committed import into risu.db before retiring its only source.
  checkpointWal(db)
  fs.renameSync(file, `${file}.migrated`)
}

/**
 * One chat's hydration payload: messages, hypaV3Data, and reroll alternates for
 * the hydration endpoint. Uses the table with embedded db.json fallback for
 * chats that are not extracted. `alternates` is always present, empty when none.
 */
export function loadChatHydration(
  db: DatabaseSync,
  dataDir: string,
  chatId: string,
): { message: unknown[]; hypaV3Data: unknown; alternates: unknown[] } {
  const alternates = getAlternateMessages(db, chatId) as unknown[]
  let message = getChatMessages(db, chatId) as unknown[]
  let hypaV3Data = getChatHypaV3(db, chatId)
  if (message.length > 0) {
    // The messages table is authoritative once populated: extraction writes
    // messages and hypaV3Data together, so a missing `chat_hypa_v3` row means
    // the chat has none. A legitimately `undefined` hypaV3Data must not drop
    // the request into the whole-corpus `loadPersisted` fallback.
    return { message, hypaV3Data, alternates }
  }
  // Fallback for a chat not extracted into the table (zero message rows;
  // defensive — startup extraction normally makes the table authoritative).
  const persisted = loadPersisted(db, dataDir)
  eachChat(persisted.database, (chat) => {
    if (chat.id !== chatId) return
    if (message.length === 0 && Array.isArray(chat.message)) message = chat.message
    if (hypaV3Data === undefined && chat.hypaV3Data !== undefined) hypaV3Data = chat.hypaV3Data
  })
  return { message, hypaV3Data, alternates }
}

export interface ChatHydrationRangeInput {
  start?: number
  limit?: number
  tail?: number
}

export interface ChatHydrationRangePayload {
  message: unknown[]
  hypaV3Data?: unknown
  alternates: unknown[]
  messageStart: number
  messageTotal: number
}

function normalizedMessageRange(total: number, range: ChatHydrationRangeInput): { start: number; limit: number } {
  if (Number.isInteger(range.tail) && (range.tail as number) > 0) {
    const limit = Math.min(range.tail as number, total)
    return { start: Math.max(0, total - limit), limit }
  }

  const start = Number.isInteger(range.start) && (range.start as number) > 0 ? (range.start as number) : 0
  const limit =
    Number.isInteger(range.limit) && (range.limit as number) > 0
      ? Math.min(range.limit as number, Math.max(0, total - start))
      : Math.max(0, total - start)
  return { start: Math.min(start, total), limit }
}

/**
 * One chat's hydration payload for a visible message window. The response
 * includes the transcript's total length so the client can keep stable absolute
 * message indexes while filling only loaded rows.
 */
export function loadChatHydrationRange(
  db: DatabaseSync,
  dataDir: string,
  chatId: string,
  range: ChatHydrationRangeInput,
  options: { includeHypaV3Data?: boolean } = {},
): ChatHydrationRangePayload {
  const alternates = getAlternateMessages(db, chatId) as unknown[]
  const includeHypaV3Data = options.includeHypaV3Data !== false
  const hypaV3Data = includeHypaV3Data ? getChatHypaV3(db, chatId) : undefined
  const rowCount = countChatMessages(db, chatId)

  if (rowCount > 0) {
    const { start, limit } = normalizedMessageRange(rowCount, range)
    return {
      message: getChatMessagesRange(db, chatId, start, limit) as unknown[],
      ...(includeHypaV3Data ? { hypaV3Data } : {}),
      alternates,
      messageStart: start,
      messageTotal: rowCount,
    }
  }

  // Defensive fallback for pre-extraction / embedded chat payloads. This path is
  // not expected during normal Fastify runtime, but preserves the old route's
  // behavior while still honoring the requested range.
  const full = loadChatHydration(db, dataDir, chatId)
  const { start, limit } = normalizedMessageRange(full.message.length, range)
  return {
    message: full.message.slice(start, start + limit),
    ...(includeHypaV3Data ? { hypaV3Data: full.hypaV3Data } : {}),
    alternates,
    messageStart: start,
    messageTotal: full.message.length,
  }
}

const GENERATION_CHAT_FALLBACK_TAIL = 8

export function loadGenerationChatHydration(
  db: DatabaseSync,
  dataDir: string,
  chatId: string,
  messageId?: string,
): ChatHydrationRangePayload {
  const location = messageId ? getActiveMessageLocationById(db, messageId) : undefined
  if (location?.chatId === chatId) {
    return loadChatHydrationRange(db, dataDir, chatId, { start: location.seq }, { includeHypaV3Data: false })
  }
  return loadChatHydrationRange(
    db,
    dataDir,
    chatId,
    { tail: GENERATION_CHAT_FALLBACK_TAIL },
    { includeHypaV3Data: false },
  )
}

export function loadChatHydrations(
  db: DatabaseSync,
  dataDir: string,
  chatIds: readonly string[],
  options: { includeAlternates?: boolean } = {},
): BulkChatHydrationPayload {
  if (chatIds.length === 0) return { chats: [], missing: [] }

  const messages = getChatMessagesGroupedByIds(db, chatIds)
  const hypaV3ById = getChatHypaV3GroupedByIds(db, chatIds)
  const alternatesById = options.includeAlternates === false ? null : getAlternateMessagesGroupedByIds(db, chatIds)

  // Known-id + embedded-fallback resolution reads only the REQUESTED chat rows
  // (`WHERE id IN`), not the whole corpus. The chats table is the
  // known-id authority on exactly the states where `loadPersisted` would have
  // served it (settings present, characters extracted into SQLite — the FK ties
  // every chat row to a character row); any other state falls back to the broad
  // walk, which keeps the embedded-characters fallback and the exact `missing`
  // semantics.
  const requestedRows = sqliteIsCharacterAuthority(db) ? getChatRowsByIds(db, chatIds) : null
  if (requestedRows !== null) {
    const chats: ChatHydrationPayload[] = []
    const missing: string[] = []
    for (const chatId of chatIds) {
      const row = requestedRows.get(chatId)
      if (!row) {
        missing.push(chatId)
        continue
      }
      const messageRows = messages.get(chatId)
      const fallbackMessage = Array.isArray(row.message) ? row.message : undefined
      const payload: ChatHydrationPayload = {
        chatId,
        message: messageRows && messageRows.length > 0 ? messageRows : (fallbackMessage ?? []),
        hypaV3Data: hypaV3ById.has(chatId) ? hypaV3ById.get(chatId) : row.hypaV3Data,
      }
      if (alternatesById) payload.alternates = alternatesById.get(chatId) ?? []
      chats.push(payload)
    }
    return { chats, missing }
  }

  const fallbackById = new Map<string, { message?: unknown[]; hypaV3Data?: unknown }>()
  const knownChatIds = new Set<string>()
  const requestedChatIds = new Set(chatIds)
  const persisted = loadPersisted(db, dataDir)

  eachChat(persisted.database, (chat) => {
    if (typeof chat.id !== 'string') return
    knownChatIds.add(chat.id)
    if (!requestedChatIds.has(chat.id)) return
    fallbackById.set(chat.id, {
      message: Array.isArray(chat.message) ? chat.message : undefined,
      hypaV3Data: chat.hypaV3Data,
    })
  })

  const chats: ChatHydrationPayload[] = []
  const missing: string[] = []
  for (const chatId of chatIds) {
    if (!knownChatIds.has(chatId)) {
      missing.push(chatId)
      continue
    }

    const fallback = fallbackById.get(chatId)
    const messageRows = messages.get(chatId)
    const message = messageRows && messageRows.length > 0 ? messageRows : (fallback?.message ?? [])
    const payload: ChatHydrationPayload = {
      chatId,
      message,
      hypaV3Data: hypaV3ById.has(chatId) ? hypaV3ById.get(chatId) : fallback?.hypaV3Data,
    }
    if (alternatesById) payload.alternates = alternatesById.get(chatId) ?? []
    chats.push(payload)
  }

  return { chats, missing }
}

/**
 * Whether the SQLite character/chat tables are the known-id authority that the
 * broad `loadPersisted` walk would have used: settings initialized AND at least
 * one extracted character row. On a pre-extraction database (`characters`
 * empty), `loadPersisted` serves the settings-embedded characters instead, so
 * a scoped table read must not answer known/missing for it.
 */
function sqliteIsCharacterAuthority(db: DatabaseSync): boolean {
  if (loadSettingsFromSqlite(db) === null) return false
  const probe = db.prepare('SELECT 1 FROM characters LIMIT 1').get()
  return probe !== undefined
}

/** The requested chat rows by id (`WHERE id IN`, chunked). Non-record payloads
 *  are skipped — the broad walk's `eachChat` never visits them either, so the
 *  requested id reads as missing on both paths. */
function getChatRowsByIds(db: DatabaseSync, chatIds: readonly string[]): Map<string, JsonRecord> {
  const byId = new Map<string, JsonRecord>()
  const chunkSize = 500
  for (let index = 0; index < chatIds.length; index += chunkSize) {
    const chunk = chatIds.slice(index, index + chunkSize)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db
      .prepare(`SELECT id, data_json FROM chats WHERE id IN (${placeholders})`)
      .all(...chunk) as unknown as Array<{ id: string; data_json: string }>
    for (const row of rows) {
      const parsed = parseStoredChatRow(row.data_json)
      if (isRecord(parsed)) byId.set(row.id, parsed)
    }
  }
  return byId
}

/**
 * One character's full `globalLore` for the hydration endpoint. In extracted
 * SQLite states this reads only the requested character row; pre-extraction
 * embedded-character states keep the broad fallback. Unknown / lore-less
 * characters return `[]`.
 */
export function loadCharacterLorebookHydration(
  db: DatabaseSync,
  dataDir: string,
  characterId: string,
): { globalLore: unknown[] } {
  if (sqliteIsCharacterAuthority(db)) {
    const character = getCharacterRowsByIds(db, [characterId]).get(characterId)
    return {
      globalLore:
        character?.chaId === characterId && Array.isArray(character.globalLore)
          ? (character.globalLore as unknown[])
          : [],
    }
  }

  const persisted = loadPersisted(db, dataDir)
  const characters =
    (
      persisted.database as {
        characters?: Array<{ chaId?: string; globalLore?: unknown } | null>
      } | null
    )?.characters ?? []
  const character = characters.find((candidate) => candidate?.chaId === characterId)
  const globalLore = character && Array.isArray(character.globalLore) ? (character.globalLore as unknown[]) : []
  return { globalLore }
}

export function loadCharacterLorebookHydrations(
  db: DatabaseSync,
  dataDir: string,
  characterIds: readonly string[],
): BulkCharacterLorebookHydrationPayload {
  if (characterIds.length === 0) return { characters: [], missing: [] }

  const requestedCharacterIds = new Set(characterIds)
  const knownCharacterIds = new Set<string>()
  const globalLoreById = new Map<string, unknown[]>()

  // Known-id + lore resolution reads only the REQUESTED character rows
  // (`WHERE id IN`), not the whole corpus; the table stores the
  // full un-stubbed `globalLore`. Same authority gate + broad fallback as
  // `loadChatHydrations`.
  let characters: ReadonlyArray<Record<string, unknown> | null>
  if (sqliteIsCharacterAuthority(db)) {
    characters = [...getCharacterRowsByIds(db, characterIds).values()]
  } else {
    const persisted = loadPersisted(db, dataDir)
    characters = (persisted.database as { characters?: Array<Record<string, unknown> | null> } | null)?.characters ?? []
  }

  for (const character of characters) {
    if (typeof character?.chaId !== 'string') continue
    knownCharacterIds.add(character.chaId)
    if (!requestedCharacterIds.has(character.chaId)) continue
    globalLoreById.set(character.chaId, Array.isArray(character.globalLore) ? (character.globalLore as unknown[]) : [])
  }

  const hydrated: CharacterLorebookHydrationPayload[] = []
  const missing: string[] = []
  for (const characterId of characterIds) {
    if (!knownCharacterIds.has(characterId)) {
      missing.push(characterId)
      continue
    }
    hydrated.push({
      characterId,
      globalLore: globalLoreById.get(characterId) ?? [],
    })
  }

  return { characters: hydrated, missing }
}

/** The requested character rows by id (`WHERE id IN`, chunked). Non-record
 *  payloads are skipped (read as missing, like the broad walk's guards). */
function getCharacterRowsByIds(db: DatabaseSync, characterIds: readonly string[]): Map<string, JsonRecord> {
  const byId = new Map<string, JsonRecord>()
  const chunkSize = 500
  for (let index = 0; index < characterIds.length; index += chunkSize) {
    const chunk = characterIds.slice(index, index + chunkSize)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db
      .prepare(`SELECT id, data_json FROM characters WHERE id IN (${placeholders})`)
      .all(...chunk) as unknown as Array<{ id: string; data_json: string }>
    for (const row of rows) {
      const parsed = JSON.parse(row.data_json) as unknown
      if (isRecord(parsed)) byId.set(row.id, parsed)
    }
  }
  return byId
}

export async function applyImport(
  db: DatabaseSync,
  dataDir: string,
  database: unknown,
  options: {
    beforeRevision?: (db: DatabaseSync) => void
    cloneBeforeMessageSplit?: boolean
    automaticBackupRetention?: number
    greetingTranslations?: readonly GreetingTranslationRow[]
    signal?: AbortSignal
    maintenanceLease?: MaintenanceLease
  } = {},
): Promise<{ revision: number; event: CommandEvent; databaseLineage: string; writerEpoch: number }> {
  if (database === null || database === undefined) {
    throw new ValidationError('database payload missing')
  }
  const coordinator = getMaintenanceCoordinator(dataDir)
  const lease = options.maintenanceLease ?? coordinator.beginExclusive('import', options.signal)
  try {
    coordinator.assertExclusive(lease)
    throwIfImportAborted(lease.signal)
    const safetyFence = captureMaintenanceWriteFence(db)
    await createAutomaticSafetyBackup(db, dataDir, lease, options.automaticBackupRetention)
    // Creating the safety snapshot can yield to the event loop. Do not begin the
    // destructive transaction if the requesting client disconnected meanwhile.
    throwIfImportAborted(lease.signal)
    assertMaintenanceWriteFence(db, safetyFence)
    // The imported payload carries embedded `message[]`; split them into the
    // messages table and persist the message-free domain tables. By default we
    // persist a *clone* so the caller's `database` object is left fully hydrated —
    // downstream consumers (e.g. the legacy hypaV3 memory backfill in
    // routes/save.ts) read chat.message after this returns, and splitting mutates
    // its argument in place. SQLite writes commit atomically so table families
    // never land ahead of the message rows.
    const cloneBeforeMessageSplit = options.cloneBeforeMessageSplit ?? true
    const current = loadPersisted(db, dataDir)
    let transactionOpen = false
    db.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    try {
      // A caller may pass an already-normalized throwaway object and opt out of
      // the repository clone. In that path, run the pre-revision hook before the
      // destructive message split so legacy memory backfill can still read
      // `message[]` and `hypaV3Data` from the import object.
      if (!cloneBeforeMessageSplit) {
        options.beforeRevision?.(db)
      }
      const importedDatabase = cloneBeforeMessageSplit ? structuredClone(database) : database
      if (isRecord(importedDatabase)) {
        migrateLegacyFlatModelConfiguration(importedDatabase)
        repairPersistedPersonaSelectionIdentity(importedDatabase)
        repairPersistedHypaV3PresetSelectionIdentity(importedDatabase)
      }
      const messageFree = splitChatMessagesIntoTable(db, {
        ...current,
        database: importedDatabase,
      })
      replaceAllCharactersInTable(db, messageFree.database)
      replaceGreetingTranslationsForImport(db, options.greetingTranslations ?? [])
      replaceAllCollectionsInTable(db, messageFree.database)
      replaceAllSettingsInTable(db, messageFree.database)
      if (cloneBeforeMessageSplit) {
        options.beforeRevision?.(db)
      }
      // Portable imports never own the live accepted-send ledger. Remove the
      // replaced database lifetime's operations before rotating lineage; any
      // historical assistant metadata remains ordinary transcript metadata.
      db.exec('DELETE FROM generation_effects')
      db.exec('DELETE FROM generation_operation_attempts')
      db.exec('DELETE FROM generation_operations')
      bumpGenerationOperationProjectionEpoch(db)
      const databaseLineage = rotateDatabaseLineage(db)
      const event = persistRevisionedCommandEvent(db, COMMAND_EVENT_CATALOG.stateImported)
      db.exec('COMMIT')
      transactionOpen = false
      return { revision: event.revision, event, databaseLineage, writerEpoch: getDatabaseWriterMetadata(db).epoch }
    } catch (err) {
      if (transactionOpen) {
        db.exec('ROLLBACK')
      }
      throw err
    }
  } finally {
    if (!options.maintenanceLease) lease.release()
  }
}

function throwIfImportAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const error = new Error('Database import aborted')
  error.name = 'AbortError'
  throw error
}

/**
 * First-run seed: write the server-owned default database to SQLite ONLY when
 * no database exists yet.
 *
 * Idempotent and clobber-safe — a valid settings object is a no-op, while
 * durable domain rows or revision history without one are a conflict. The
 * classification runs inside the same `BEGIN IMMEDIATE` transaction as the
 * write, so two clients opening the same fresh server (a second tab, a reload
 * race) can never seed twice or overwrite real data.
 */
export function initializeDefaultDatabase(db: DatabaseSync): {
  revision: number
  initialized: boolean
  event?: CommandEvent
} {
  let transactionOpen = false
  db.exec('BEGIN IMMEDIATE')
  transactionOpen = true
  try {
    const initialization = assessDatabaseInitialization(db)
    if (initialization.state === 'conflict') {
      throw new InitializeConflictError(initialization.evidence)
    }
    if (initialization.state === 'initialized') {
      // Already initialized → never overwrite. Report the live revision so the
      // caller can sync its cursor.
      const { revision } = getSchemaState(db)
      db.exec('COMMIT')
      transactionOpen = false
      return { revision, initialized: false }
    }
    const database = createInitialDatabase()
    repairPersistedGlobalLorebookIds(database)
    replaceAllCharactersInTable(db, database)
    replaceAllCollectionsInTable(db, database)
    replaceAllSettingsInTable(db, database)
    const event = persistRevisionedCommandEvent(db, COMMAND_EVENT_CATALOG.stateInitialized)
    db.exec('COMMIT')
    transactionOpen = false
    return { revision: event.revision, initialized: true, event }
  } catch (err) {
    if (transactionOpen) {
      db.exec('ROLLBACK')
    }
    throw err
  }
}

export function assetsDir(dataDir: string): string {
  return path.join(dataDir, 'assets')
}

export function assetPath(dataDir: string, entry: PersistedAsset): string {
  return path.join(assetsDir(dataDir), `${entry.id}.${entry.ext}`)
}

export function assetById(db: DatabaseSync, id: string): PersistedAsset | null {
  if (!isValidAssetId(id)) return null
  return getAssetMetadataById(db, id)
}

export interface AddAssetResult {
  entry: PersistedAsset
  created: boolean
  revision: number
  event?: CommandEvent
}

interface AddAssetInput {
  bytes: Buffer
  contentType: string
}

export interface StagedAssetInput {
  id: string
  size: number
  contentType: string
  filePath: string
}

export interface StagedAssetLiveFileCopy {
  file: string
  existedBefore: boolean
}

export interface StagedAssetCleanupResult {
  attempted: number
  removed: number
  failures: Array<{ file: string; error: unknown }>
}

export interface StagedAssetPersistResult {
  entry: PersistedAsset
  created: boolean
}

export function addAsset(db: DatabaseSync, dataDir: string, args: AddAssetInput): AddAssetResult {
  return addAssets(db, dataDir, [args])[0]
}

export function addAssets(db: DatabaseSync, dataDir: string, assets: readonly AddAssetInput[]): AddAssetResult[] {
  const normalizedAssets = assets.map((asset) => {
    if (!CONTENT_TYPE_EXTENSIONS[asset.contentType]) {
      throw new ValidationError(`Unsupported content-type: ${asset.contentType}`)
    }
    const effectiveContentType = resolveEffectiveAssetContentType(asset)
    return effectiveContentType === asset.contentType ? asset : { ...asset, contentType: effectiveContentType }
  })
  // Deduplicated uploads can refresh only file mtime, with no SQLite write.
  // Fence any reference scan suspended before this upload-to-reference window.
  if (normalizedAssets.length > 0) getMaintenanceCoordinator(dataDir).noteAssetActivity()

  const createdResults: AddAssetResult[] = []
  const results: AddAssetResult[] = []
  const currentRevision = getSchemaState(db).revision
  const createdFiles: Array<{ file: string; existedBefore: boolean }> = []
  let transactionOpen = false
  try {
    for (const asset of normalizedAssets) {
      const ext = CONTENT_TYPE_EXTENSIONS[asset.contentType]
      const sha256 = createHash('sha256').update(asset.bytes).digest('hex')
      const existing = getAssetMetadataById(db, sha256)
      if (existing) {
        if (existing.contentType !== asset.contentType) {
          throw new ValidationError(
            `Asset content-type conflict: existing ${existing.contentType}, uploaded ${asset.contentType}`,
          )
        }
        const file = assetPath(dataDir, existing)
        if (!fs.existsSync(file)) {
          fs.mkdirSync(assetsDir(dataDir), { recursive: true })
          fs.writeFileSync(file, asset.bytes)
        } else {
          // A deduplicated upload is a fresh adoption attempt. Restart the GC
          // grace window so a previously old orphan cannot be reclaimed before
          // the caller's subsequent reference mutation lands.
          try {
            const now = new Date()
            fs.utimesSync(file, now, now)
          } catch {
            // Best effort: the existing bytes are still valid and readable.
          }
        }
        results.push({ entry: existing, created: false, revision: currentRevision })
        continue
      }

      fs.mkdirSync(assetsDir(dataDir), { recursive: true })
      const file = path.join(assetsDir(dataDir), `${sha256}.${ext}`)
      const existedBefore = fs.existsSync(file)
      createdFiles.push({ file, existedBefore })
      fs.writeFileSync(file, asset.bytes)
      const entry: PersistedAsset = {
        id: sha256,
        ext,
        size: asset.bytes.length,
        contentType: asset.contentType,
      }
      const result = { entry, created: true, revision: currentRevision }
      createdResults.push(result)
      results.push(result)
    }

    if (createdResults.length === 0) {
      return results
    }

    db.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    insertAssetMetadataBatch(
      db,
      createdResults.map((r) => r.entry),
    )
    db.exec('COMMIT')
    transactionOpen = false
    // Asset metadata is outside the projected Database domain. Registering an
    // immutable blob must not advance the global command revision: otherwise a
    // concurrent settings/chat command can conflict even though the two writes
    // cannot overlap semantically.
    return results
  } catch (err) {
    if (transactionOpen) {
      db.exec('ROLLBACK')
    }
    for (const { file, existedBefore } of createdFiles) {
      if (!existedBefore) {
        fs.rmSync(file, { force: true })
      }
    }
    throw err
  }
}

export function persistStagedAssetsInTransaction(
  db: DatabaseSync,
  dataDir: string,
  assets: readonly StagedAssetInput[],
  copiedFiles: StagedAssetLiveFileCopy[],
): StagedAssetPersistResult[] {
  if (assets.length === 0) return []
  for (const asset of assets) {
    if (!isValidAssetId(asset.id)) {
      throw new ValidationError('Local backup asset id is not a sha256 hex string')
    }
    if (!CONTENT_TYPE_EXTENSIONS[asset.contentType]) {
      throw new ValidationError(`Unsupported content-type: ${asset.contentType}`)
    }
    if (!Number.isSafeInteger(asset.size) || asset.size < 0) {
      throw new ValidationError('Local backup asset size is invalid')
    }
  }

  const createdAssets: PersistedAsset[] = []
  const results: StagedAssetPersistResult[] = []
  fs.mkdirSync(assetsDir(dataDir), { recursive: true })

  for (const asset of assets) {
    const existing = getAssetMetadataById(db, asset.id)
    if (existing) {
      const file = assetPath(dataDir, existing)
      if (!fs.existsSync(file)) {
        copiedFiles.push({ file, existedBefore: false })
        fs.copyFileSync(asset.filePath, file)
      }
      results.push({ entry: existing, created: false })
      continue
    }

    const entry: PersistedAsset = {
      id: asset.id,
      ext: CONTENT_TYPE_EXTENSIONS[asset.contentType],
      size: asset.size,
      contentType: asset.contentType,
    }
    const file = assetPath(dataDir, entry)
    const existedBefore = fs.existsSync(file)
    copiedFiles.push({ file, existedBefore })
    fs.copyFileSync(asset.filePath, file)
    createdAssets.push(entry)
    results.push({ entry, created: true })
  }

  insertAssetMetadataBatch(db, createdAssets)
  return results
}

export function cleanupCopiedStagedAssetFiles(
  copiedFiles: readonly StagedAssetLiveFileCopy[],
): StagedAssetCleanupResult {
  const result: StagedAssetCleanupResult = {
    attempted: 0,
    removed: 0,
    failures: [],
  }
  for (const { file, existedBefore } of copiedFiles) {
    if (existedBefore) continue
    result.attempted += 1
    try {
      fs.rmSync(file, { force: true })
      result.removed += 1
    } catch (error) {
      result.failures.push({ file, error })
    }
  }
  return result
}

export function missingAssetIds(db: DatabaseSync, ids: string[]): string[] {
  return getMissingAssetIds(db, ids)
}

export const BACKUP_MANIFEST_VERSION = 1

export const BACKUP_ID_RE = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-[a-f0-9]{6}$/

export interface BackupManifest {
  _version: number
  id: string
  label: string | null
  /** Missing on backups created before backup kinds were introduced. */
  kind?: 'manual' | 'automatic'
  createdAt: string
  revision: number
  assetCount: number
}

export function isValidBackupId(id: string): boolean {
  return BACKUP_ID_RE.test(id)
}

export function generateBackupId(now: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const ts =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`
  const suffix = randomBytes(3).toString('hex')
  return `${ts}-${suffix}`
}

export function backupsDir(dataDir: string): string {
  return path.join(dataDir, 'backups')
}

export function backupDir(dataDir: string, id: string): string {
  return path.join(backupsDir(dataDir), id)
}

// Exhaustive list of child entries inside `dataDir` that the backup contract
// owns. Every file/directory in this list must be snapshotted by `createBackup`
// and restored by `restoreBackup`.
//
// Implementation notes per entry:
//   - 'assets'   : content-addressed asset bytes. Copied as a directory.
//   - 'risu.db'  : SQLite database containing schema/revision state, domain tables,
//                  asset metadata, command events, chat-history tables, and Hypa
//                  V3 memory tables. Backed up through node:sqlite's online backup
//                  API after a checked WAL checkpoint; restored via ATTACH so the
//                  live `DatabaseSync` handle stays valid. Every table that must
//                  survive restore is listed in SQLITE_BACKUP_TABLES.
//   - 'save'     : legacy storage directory written by /api/v1/storage/*.
export const KNOWN_DATA_DIR_CHILDREN = ['assets', 'risu.db', 'save'] as const

function saveDir(dataDir: string): string {
  return path.join(dataDir, 'save')
}

// Tables replaced by a point-in-time content/recovery restore. `createBackup`
// copies all of risu.db through the online backup API, but `restoreBackup`
// deliberately swaps only this ownership allowlist via ATTACH.
//
// Live operational exclusions:
//   - push_subscriptions: origin/device registrations bound to the live VAPID
//     identity, whose key file is outside the backup contract.
//   - database_metadata: live lineage/writer ownership; restore rotates lineage.
//   - command_mutation_receipts: lineage-scoped idempotency records that must not
//     cross a replacement boundary.
//   - request_history: device-local diagnostic telemetry; restore clears it when
//     rotating lineage.
//   - schema_version: live schema metadata; only the snapshot revision is copied.
//   - bardwiki_document_search: derived lexical projection rebuilt from restored
//     authoritative documents before the restore transaction commits.
export const SQLITE_BACKUP_TABLES = [
  'bardwiki_rebuild_staging',
  'bardwiki_change_manifest',
  'bardwiki_document_sources',
  'bardwiki_links',
  'bardwiki_document_versions',
  'bardwiki_jobs',
  'bardwiki_turn_receipts',
  'bardwiki_documents',
  'bardwiki_chat_settings',
  'command_events',
  'generation_finalization_retries',
  'generation_operation_projection_state',
  'generation_operations',
  'generation_operation_attempts',
  'generation_effects',
  'memory_chunks',
  'memory_summaries',
  'memory_legacy_summary_tombstones',
  'memory_embeddings',
  'memory_jobs',
  'messages',
  'chat_hypa_v3',
  'assets',
  'inlay_catalog',
  'characters',
  'chats',
  'greeting_translations',
  'modules',
  'plugins',
  'model_presets',
  'prompt_presets',
  'bot_presets',
  'prompt_templates',
  'personas',
  'loadouts',
  'lore_books',
  'translator_presets',
  'hypa_v3_presets',
  'plugin_custom_storage',
  'settings',
] as const

export const SQLITE_BACKUP_EXCLUDED_TABLES = {
  bardwiki_document_search: 'Derived lexical projection rebuilt from authoritative BardWiki documents on restore.',
  push_subscriptions: 'Origin/device registrations bound to the live VAPID identity.',
  database_metadata: 'Live lineage and writer ownership; restore rotates lineage.',
  command_mutation_receipts: 'Lineage-scoped idempotency records; restore clears them.',
  request_history: 'Device-local diagnostic telemetry; restore clears it when rotating lineage.',
  schema_version: 'Live schema metadata; restore copies only the snapshot revision.',
} as const satisfies Readonly<Record<string, string>>

const REQUIRED_SQLITE_BACKUP_TABLES = ['schema_version', 'settings'] as const

type BackupDatabasePayloadStatus = 'missing' | 'invalid' | 'usable'

interface UsableBackupDatabasePayloads {
  legacyJson: boolean
  sqlite: boolean
}

function validateBackupSqlite(backupDbPath: string): BackupDatabasePayloadStatus {
  if (!fs.existsSync(backupDbPath)) return 'missing'

  try {
    const stat = fs.statSync(backupDbPath)
    if (!stat.isFile() || stat.size === 0) return 'invalid'

    const backupDb = new DatabaseSync(backupDbPath, { readOnly: true })
    try {
      const rows = backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string
      }>
      const tables = new Set(rows.map((row) => row.name))
      return REQUIRED_SQLITE_BACKUP_TABLES.every((table) => tables.has(table)) ? 'usable' : 'invalid'
    } finally {
      backupDb.close()
    }
  } catch {
    return 'invalid'
  }
}

function validateBackupLegacyJson(legacySnapshotPath: string): BackupDatabasePayloadStatus {
  if (!fs.existsSync(legacySnapshotPath)) return 'missing'

  try {
    const parsed = JSON.parse(fs.readFileSync(legacySnapshotPath, 'utf8')) as unknown
    return isRecord(parsed) && isRecord(parsed.database) ? 'usable' : 'invalid'
  } catch {
    return 'invalid'
  }
}

function validateBackupDatabasePayloads(
  backupDbPath: string,
  legacySnapshotPath: string,
): UsableBackupDatabasePayloads {
  const sqlite = validateBackupSqlite(backupDbPath)
  const legacyJson = validateBackupLegacyJson(legacySnapshotPath)

  // A present legacy snapshot is always imported during restore, including
  // when a SQLite snapshot is also present, so it must be valid before any
  // live directories are staged or moved.
  if (legacyJson === 'invalid') {
    throw new BackupDatabaseValidationError('backup_database_invalid')
  }
  if (sqlite === 'usable') {
    return { sqlite: true, legacyJson: legacyJson === 'usable' }
  }
  if (legacyJson === 'usable') {
    // Some transitional backups may contain a bad or empty risu.db beside a
    // valid legacy snapshot. Restore those through the legacy-only path.
    return { sqlite: false, legacyJson: true }
  }
  if (sqlite === 'missing' && legacyJson === 'missing') {
    throw new BackupDatabaseValidationError('backup_database_missing')
  }
  throw new BackupDatabaseValidationError('backup_database_invalid')
}

interface WalCheckpointResult {
  busy: number
  log: number
  checkpointed: number
}

const WAL_CHECKPOINT_ATTEMPTS = 5
const WAL_CHECKPOINT_RETRY_DELAY_MS = 20
const WAL_CHECKPOINT_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

function checkpointWal(db: DatabaseSync): void {
  let lastResult: WalCheckpointResult | undefined
  for (let attempt = 1; attempt <= WAL_CHECKPOINT_ATTEMPTS; attempt += 1) {
    let result: WalCheckpointResult
    try {
      result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as unknown as WalCheckpointResult
    } catch (cause) {
      throw new WalCheckpointError('SQLite WAL checkpoint failed before backup', { cause })
    }
    if (
      !result ||
      !Number.isInteger(result.busy) ||
      !Number.isInteger(result.log) ||
      !Number.isInteger(result.checkpointed)
    ) {
      throw new WalCheckpointError('SQLite WAL checkpoint returned an invalid result')
    }
    lastResult = result
    if (result.busy === 0 && result.checkpointed >= result.log) return
    if (attempt < WAL_CHECKPOINT_ATTEMPTS) {
      Atomics.wait(WAL_CHECKPOINT_RETRY_SIGNAL, 0, 0, WAL_CHECKPOINT_RETRY_DELAY_MS)
    }
  }

  throw new WalCheckpointError(
    `SQLite WAL checkpoint remained busy after ${WAL_CHECKPOINT_ATTEMPTS} attempts ` +
      `(busy=${lastResult?.busy ?? 'unknown'}, log=${lastResult?.log ?? 'unknown'}, ` +
      `checkpointed=${lastResult?.checkpointed ?? 'unknown'}); backup was not created`,
  )
}

/** Ordinary requests remain responsive during a safety snapshot. Refuse a
 * replacement if any accepted write could be absent from its captured DB.
 * Capture before SQLite starts, since promise completion is not the snapshot's
 * transaction boundary; include revision-free assets and other connections. */
function captureMaintenanceWriteFence(db: DatabaseSync) {
  return {
    changes: (db.prepare('SELECT total_changes() AS value').get() as { value: number }).value,
    dataVersion: (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version,
    lineage: getDatabaseLineage(db),
    revision: getSchemaState(db).revision,
  }
}

function assertMaintenanceWriteFence(
  db: DatabaseSync,
  expected: ReturnType<typeof captureMaintenanceWriteFence>,
): void {
  const actual = captureMaintenanceWriteFence(db)
  if (
    actual.changes !== expected.changes ||
    actual.dataVersion !== expected.dataVersion ||
    actual.lineage !== expected.lineage ||
    actual.revision !== expected.revision
  ) {
    throw new MaintenanceBusyError()
  }
}

export const AUTOMATIC_BACKUP_LABEL = 'Automatic safety snapshot'

export async function createBackup(
  db: DatabaseSync,
  dataDir: string,
  label: string | null = null,
  options: { kind?: 'manual' | 'automatic'; signal?: AbortSignal } = {},
): Promise<BackupManifest> {
  const lease = getMaintenanceCoordinator(dataDir).beginExclusive('backup', options.signal)
  try {
    return await createBackupUnderLease(db, dataDir, lease, label, options)
  } finally {
    lease.release()
  }
}

async function createBackupUnderLease(
  db: DatabaseSync,
  dataDir: string,
  lease: MaintenanceLease,
  label: string | null,
  options: { kind?: 'manual' | 'automatic'; restoreFallbackDir?: string } = {},
): Promise<BackupManifest> {
  getMaintenanceCoordinator(dataDir).assertExclusive(lease)
  lease.signal.throwIfAborted()
  const id = generateBackupId()
  const dir = backupDir(dataDir, id)
  try {
    fs.mkdirSync(dir, { recursive: true })
    // The lease protects every asset before SQLite first yields, including
    // uploads incorporated by the online snapshot while it is in progress.
    checkpointWal(db)
    const backupSqlite = path.join(dir, 'risu.db')
    await backupSqliteDatabase(db, backupSqlite)
    lease.signal.throwIfAborted()

    let revision: number
    let assetCount = 0
    const snapshotDb = new DatabaseSync(backupSqlite, { readOnly: true })
    let references: AssetReferenceMarks | undefined
    let copyPool: BackupCopyPool | undefined
    try {
      revision = getSchemaState(snapshotDb).revision
      references = await scanAssetReferences(snapshotDb, {
        scratchPath: path.join(dir, '.asset-references.sqlite'),
        signal: lease.signal,
      })
      const hasMetadata = snapshotDb.prepare('SELECT 1 FROM assets WHERE id = ?')
      for await (const ids of references.referencePages()) {
        for (const assetId of ids)
          if (!hasMetadata.get(assetId)) {
            throw new BackupAssetError(`Required backup asset metadata is missing: ${assetId}`)
          }
      }
      const firstPage = snapshotDb.prepare(
        'SELECT CAST(rowid AS TEXT) AS cursor, id, ext, size, content_type AS contentType FROM assets ORDER BY rowid LIMIT 64',
      )
      const nextPage = snapshotDb.prepare(
        'SELECT CAST(rowid AS TEXT) AS cursor, id, ext, size, content_type AS contentType FROM assets WHERE rowid > CAST(? AS INTEGER) ORDER BY rowid LIMIT 64',
      )
      async function* metadata(): AsyncGenerator<PersistedAsset> {
        let cursor: string | undefined
        while (true) {
          lease.signal.throwIfAborted()
          const rows = (cursor === undefined ? firstPage.all() : nextPage.all(cursor)) as unknown as Array<
            PersistedAsset & { cursor: string }
          >
          if (!rows.length) return
          cursor = rows[rows.length - 1].cursor
          for (const asset of rows) {
            assetCount++
            yield asset
          }
          await yieldMaintenanceTurn()
        }
      }
      copyPool = new BackupCopyPool(lease.signal)
      await copyBackupAssets({
        from: assetsDir(dataDir),
        to: path.join(dir, 'assets'),
        assets: metadata(),
        requiredIds: references,
        signal: lease.signal,
        pool: copyPool,
        restoreFallbackDir: options.restoreFallbackDir,
      })
      await copyBackupDirectory(saveDir(dataDir), path.join(dir, 'save'), lease.signal, copyPool)
    } finally {
      try {
        // Native copies cannot be interrupted mid-call. Every batch and both
        // workers must finish before scratch cleanup, publication or release.
        await copyPool?.close()
      } finally {
        try {
          await references?.close()
        } finally {
          snapshotDb.close()
        }
      }
    }
    copyPool?.throwIfFailed()
    const manifest: BackupManifest = {
      _version: BACKUP_MANIFEST_VERSION,
      id,
      label,
      kind: options.kind ?? 'manual',
      createdAt: new Date().toISOString(),
      revision,
      assetCount,
    }
    const pendingManifest = path.join(dir, '.manifest.json')
    await fs.promises.writeFile(pendingManifest, JSON.stringify(manifest), { signal: lease.signal })
    lease.signal.throwIfAborted()
    // Atomic publication has no await/cancellation window after the last check.
    fs.renameSync(pendingManifest, path.join(dir, 'manifest.json'))
    return manifest
  } catch (err) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true })
    } catch {
      // Preserve the creation failure; a manifest was never published.
    }
    throw err
  }
}

export function listBackups(dataDir: string): BackupManifest[] {
  const root = backupsDir(dataDir)
  if (!fs.existsSync(root)) return []
  const entries = fs.readdirSync(root)
  const manifests: BackupManifest[] = []
  for (const id of entries) {
    if (!isValidBackupId(id)) continue
    const manifestPath = path.join(root, id, 'manifest.json')
    if (!fs.existsSync(manifestPath)) continue
    // One unreadable/corrupt manifest must not 500 the whole backups list
    // skip the broken entry, keep listing the healthy ones. The
    // sort below relies on `createdAt`, so a parsed-but-misshapen manifest is
    // skipped too.
    let parsed: BackupManifest
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || parsed.id !== id || typeof parsed.createdAt !== 'string') continue
    manifests.push(parsed)
  }
  manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return manifests
}

function liveDatabaseIsInitialized(db: DatabaseSync): boolean {
  return db.prepare('SELECT 1 FROM settings WHERE id = 1').get() !== undefined
}

type AutomaticBackupCandidate = Pick<BackupManifest, 'id' | 'createdAt'>

async function readAutomaticBackupCandidate(dataDir: string, id: string): Promise<AutomaticBackupCandidate | null> {
  if (!isValidBackupId(id)) return null
  try {
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(backupDir(dataDir, id), 'manifest.json'), 'utf8'),
    ) as BackupManifest
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      manifest.id !== id ||
      typeof manifest.createdAt !== 'string' ||
      manifest.kind !== 'automatic'
    )
      return null
    return { id, createdAt: manifest.createdAt }
  } catch {
    // Match public listing: one missing, corrupt, or unreadable manifest is
    // ignored, and must never make an ordinary/manual directory collectible.
    return null
  }
}

function compareAutomaticBackups(a: AutomaticBackupCandidate, b: AutomaticBackupCandidate): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

async function pruneAutomaticBackups(
  dataDir: string,
  lease: MaintenanceLease,
  retention: number,
  protectedIds: ReadonlySet<string>,
): Promise<void> {
  getMaintenanceCoordinator(dataDir).assertExclusive(lease)
  if (!Number.isInteger(retention) || retention <= 0) {
    throw new Error('automatic backup retention must be a positive integer')
  }

  // Callers protect only the new safety snapshot and (during restore) its
  // source. A protected manual backup must not consume automatic capacity.
  let protectedAutomaticCount = 0
  for (const id of protectedIds) {
    lease.signal.throwIfAborted()
    if (await readAutomaticBackupCandidate(dataDir, id)) protectedAutomaticCount++
  }
  const capacity = Math.max(0, retention - protectedAutomaticCount)
  const selected: AutomaticBackupCandidate[] = []
  let directory: fs.Dir
  try {
    directory = await fs.promises.opendir(backupsDir(dataDir), { bufferSize: 32 })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  // Retain at most `capacity` small candidates, plus the one being read and
  // at most two protected IDs. Manual manifests are never accumulated. An
  // evicted candidate cannot become necessary when more entries are seen.
  for await (const entry of directory) {
    lease.signal.throwIfAborted()
    if (protectedIds.has(entry.name)) continue
    const candidate = await readAutomaticBackupCandidate(dataDir, entry.name)
    lease.signal.throwIfAborted()
    if (!candidate) continue
    if (capacity === 0 || (selected.length === capacity && compareAutomaticBackups(candidate, selected[0]) <= 0)) {
      await deleteBackupUnderLease(dataDir, candidate.id, lease)
      continue
    }
    if (selected.length === capacity) {
      await deleteBackupUnderLease(dataDir, selected[0].id, lease)
      selected.shift()
    }
    let lower = 0
    let upper = selected.length
    while (lower < upper) {
      const middle = (lower + upper) >>> 1
      if (compareAutomaticBackups(selected[middle], candidate) < 0) lower = middle + 1
      else upper = middle
    }
    selected.splice(lower, 0, candidate)
  }
}

/** Capture safety state and retain its source under the caller's exclusive
 * lease. Explicit nesting keeps import/restore ownership across every await. */
async function createAutomaticSafetyBackup(
  db: DatabaseSync,
  dataDir: string,
  lease: MaintenanceLease,
  retention = DEFAULT_AUTOMATIC_BACKUP_RETENTION,
  protectedBackupIds: readonly string[] = [],
  restoreFallbackDir?: string,
): Promise<BackupManifest | null> {
  getMaintenanceCoordinator(dataDir).assertExclusive(lease)
  if (!liveDatabaseIsInitialized(db)) return null
  try {
    const manifest = await createBackupUnderLease(db, dataDir, lease, AUTOMATIC_BACKUP_LABEL, {
      kind: 'automatic',
      restoreFallbackDir,
    })
    await pruneAutomaticBackups(dataDir, lease, retention, new Set([...protectedBackupIds, manifest.id]))
    return manifest
  } catch (err) {
    if (lease.signal.aborted) lease.signal.throwIfAborted()
    throw new AutomaticBackupError(err)
  }
}

const RESTORE_SWAP_JOURNAL_VERSION = 1
const RESTORE_SWAP_JOURNAL_RE = new RegExp(`^\\.restore-journal-(${BACKUP_ID_RE.source.slice(1, -1)})\\.json$`)
const RESTORE_SWAP_PHASES = [
  'prepared',
  'assets-parked',
  'save-parked',
  'assets-installed',
  'save-installed',
  'committing',
  'committed',
  'rolled-back',
] as const

type RestoreSwapPhase = (typeof RESTORE_SWAP_PHASES)[number]

interface RestoreSwapComponentJournal {
  livePath: string
  backupPath: string
  tmpPath: string
  oldPath: string
  hadLiveDirectory: boolean
  backupHadDirectory: boolean
}

interface RestoreSwapJournal {
  _version: typeof RESTORE_SWAP_JOURNAL_VERSION
  restoreId: string
  phase: RestoreSwapPhase
  expectedDatabaseLineage: string | null
  assets: RestoreSwapComponentJournal
  save: RestoreSwapComponentJournal
}

export interface RestoreRecoveryLogger {
  info?(bindings: Record<string, unknown>, message: string): void
  warn(bindings: Record<string, unknown>, message: string): void
  error(bindings: Record<string, unknown>, message: string): void
}

function restoreJournalPath(dataDir: string, id: string): string {
  return path.join(dataDir, `.restore-journal-${id}.json`)
}

function createRestoreSwapJournal(dataDir: string, id: string): RestoreSwapJournal {
  const backupRoot = backupDir(dataDir, id)
  const liveAssets = assetsDir(dataDir)
  const backupAssets = path.join(backupRoot, 'assets')
  const liveSave = saveDir(dataDir)
  const backupSave = path.join(backupRoot, 'save')
  return {
    _version: RESTORE_SWAP_JOURNAL_VERSION,
    restoreId: id,
    phase: 'prepared',
    expectedDatabaseLineage: null,
    assets: {
      livePath: liveAssets,
      backupPath: backupAssets,
      tmpPath: path.join(dataDir, `.assets-${id}.tmp`),
      oldPath: path.join(dataDir, `.assets-${id}.old`),
      hadLiveDirectory: fs.existsSync(liveAssets),
      backupHadDirectory: fs.existsSync(backupAssets),
    },
    save: {
      livePath: liveSave,
      backupPath: backupSave,
      tmpPath: path.join(dataDir, `.save-${id}.tmp`),
      oldPath: path.join(dataDir, `.save-${id}.old`),
      hadLiveDirectory: fs.existsSync(liveSave),
      backupHadDirectory: fs.existsSync(backupSave),
    },
  }
}

function restoreSwapComponentMatches(
  value: unknown,
  expected: RestoreSwapComponentJournal,
): value is RestoreSwapComponentJournal {
  if (!isRecord(value)) return false
  return (
    value.livePath === expected.livePath &&
    value.backupPath === expected.backupPath &&
    value.tmpPath === expected.tmpPath &&
    value.oldPath === expected.oldPath &&
    typeof value.hadLiveDirectory === 'boolean' &&
    typeof value.backupHadDirectory === 'boolean'
  )
}

function readRestoreSwapJournal(dataDir: string, journalFile: string, id: string): RestoreSwapJournal {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
  } catch (cause) {
    throw new Error(`Restore journal is unreadable: ${journalFile}`, { cause })
  }
  const expected = createRestoreSwapJournal(dataDir, id)
  if (
    !isRecord(parsed) ||
    parsed._version !== RESTORE_SWAP_JOURNAL_VERSION ||
    parsed.restoreId !== id ||
    !RESTORE_SWAP_PHASES.includes(parsed.phase as RestoreSwapPhase) ||
    !(
      parsed.expectedDatabaseLineage === null ||
      (typeof parsed.expectedDatabaseLineage === 'string' && parsed.expectedDatabaseLineage.length > 0)
    ) ||
    !restoreSwapComponentMatches(parsed.assets, expected.assets) ||
    !restoreSwapComponentMatches(parsed.save, expected.save)
  ) {
    throw new Error(`Restore journal is invalid or contains unexpected paths: ${journalFile}`)
  }
  return parsed as unknown as RestoreSwapJournal
}

function writeRestoreSwapJournal(journalFile: string, journal: RestoreSwapJournal, initial = false): void {
  const serialized = JSON.stringify(journal)
  if (initial) {
    fs.writeFileSync(journalFile, serialized, { flag: 'wx' })
    return
  }
  const pendingFile = `${journalFile}.writing`
  fs.writeFileSync(pendingFile, serialized)
  fs.renameSync(pendingFile, journalFile)
}

function updateRestoreSwapJournal(
  journalFile: string,
  journal: RestoreSwapJournal,
  update: Partial<Pick<RestoreSwapJournal, 'phase' | 'expectedDatabaseLineage'>>,
): void {
  const next = { ...journal, ...update }
  writeRestoreSwapJournal(journalFile, next)
  Object.assign(journal, update)
}

function stageRestoreSwapComponent(component: RestoreSwapComponentJournal): void {
  if (fs.existsSync(component.tmpPath)) return
  if (component.backupHadDirectory) {
    if (!fs.existsSync(component.backupPath)) {
      throw new Error(`Restore source directory disappeared: ${component.backupPath}`)
    }
    fs.cpSync(component.backupPath, component.tmpPath, { recursive: true })
  } else {
    fs.mkdirSync(component.tmpPath, { recursive: true })
  }
}

function ensureRestoreComponentForward(component: RestoreSwapComponentJournal): void {
  if (fs.existsSync(component.livePath) && !fs.existsSync(component.tmpPath)) return
  if (!fs.existsSync(component.tmpPath)) stageRestoreSwapComponent(component)

  if (fs.existsSync(component.livePath)) {
    if (fs.existsSync(component.oldPath) || !component.hadLiveDirectory) {
      throw new Error(`Cannot identify the live restore directory safely: ${component.livePath}`)
    }
    fs.renameSync(component.livePath, component.oldPath)
  }
  fs.renameSync(component.tmpPath, component.livePath)
}

function restoreComponentBackward(component: RestoreSwapComponentJournal): void {
  if (component.hadLiveDirectory) {
    if (fs.existsSync(component.oldPath)) {
      rmDirectoryIfPresent(component.livePath)
      fs.cpSync(component.oldPath, component.livePath, { recursive: true })
      return
    }
    // Parked copies are retained until a full forward/rollback completes. If no
    // parked copy exists before commit, this live directory was never moved and
    // is still the original, including a crash during temporary staging.
    if (fs.existsSync(component.livePath)) return
    throw new Error(`Original restore directory is unavailable: ${component.livePath}`)
  }

  if (fs.existsSync(component.oldPath)) {
    throw new Error(`Unexpected parked restore directory requires manual inspection: ${component.oldPath}`)
  }
  if (fs.existsSync(component.tmpPath)) {
    if (fs.existsSync(component.livePath)) {
      throw new Error(`Unexpected live directory appeared during restore rollback: ${component.livePath}`)
    }
    return
  }
  rmDirectoryIfPresent(component.livePath)
}

function collectRestoreRecoveryError(errors: unknown[], operation: () => void): void {
  try {
    operation()
  } catch (error) {
    errors.push(error)
  }
}

function throwRestoreRecoveryErrors(errors: unknown[], message: string): void {
  if (errors.length === 0) return
  throw new AggregateError(errors, message)
}

function cleanupRestoreSwapArtifacts(journalFile: string, journal: RestoreSwapJournal, message: string): void {
  const errors: unknown[] = []
  for (const component of [journal.assets, journal.save]) {
    collectRestoreRecoveryError(errors, () => rmDirectoryIfPresent(component.oldPath))
    collectRestoreRecoveryError(errors, () => rmDirectoryIfPresent(component.tmpPath))
  }
  collectRestoreRecoveryError(errors, () => fs.rmSync(`${journalFile}.writing`, { force: true }))
  throwRestoreRecoveryErrors(errors, message)
  fs.rmSync(journalFile, { force: true })
}

function completeRestoreSwapForward(journalFile: string, journal: RestoreSwapJournal): void {
  const errors: unknown[] = []
  collectRestoreRecoveryError(errors, () => ensureRestoreComponentForward(journal.assets))
  collectRestoreRecoveryError(errors, () => ensureRestoreComponentForward(journal.save))
  throwRestoreRecoveryErrors(errors, 'Unable to complete the committed restore directory swap')
  if (!fs.existsSync(journal.assets.livePath) || !fs.existsSync(journal.save.livePath)) {
    throw new Error('Committed restore directories are incomplete')
  }
  if (journal.phase !== 'committed') {
    updateRestoreSwapJournal(journalFile, journal, { phase: 'committed' })
  }
  cleanupRestoreSwapArtifacts(journalFile, journal, 'Unable to clean up the committed restore directory swap')
}

function completeRestoreSwapBackward(journalFile: string, journal: RestoreSwapJournal): void {
  if (journal.phase !== 'rolled-back') {
    const errors: unknown[] = []
    collectRestoreRecoveryError(errors, () => restoreComponentBackward(journal.assets))
    collectRestoreRecoveryError(errors, () => restoreComponentBackward(journal.save))
    throwRestoreRecoveryErrors(errors, 'Unable to roll back the interrupted restore directory swap')
    if (
      journal.assets.hadLiveDirectory !== fs.existsSync(journal.assets.livePath) ||
      journal.save.hadLiveDirectory !== fs.existsSync(journal.save.livePath)
    ) {
      throw new Error('Interrupted restore rollback did not reproduce the original directory layout')
    }
    updateRestoreSwapJournal(journalFile, journal, { phase: 'rolled-back' })
  }
  cleanupRestoreSwapArtifacts(journalFile, journal, 'Unable to clean up the rolled-back restore directory swap')
}

function restoreJournalDatabaseCommitted(db: DatabaseSync, journal: RestoreSwapJournal): boolean {
  if (journal.phase === 'committed') return true
  return journal.expectedDatabaseLineage !== null && journal.expectedDatabaseLineage === getDatabaseLineage(db)
}

function logRestoreRecovery(
  logger: RestoreRecoveryLogger | undefined,
  level: 'info' | 'warn' | 'error',
  bindings: Record<string, unknown>,
  message: string,
): void {
  const method = logger?.[level]
  if (method) {
    method.call(logger, bindings, message)
    return
  }
  if (level === 'error') console.error(message, bindings)
  else if (level === 'warn') console.warn(message, bindings)
}

/** Recover every interrupted restore before any API route or background worker starts. */
export function recoverInterruptedRestoreSwaps(
  db: DatabaseSync,
  dataDir: string,
  logger?: RestoreRecoveryLogger,
): void {
  if (!fs.existsSync(dataDir)) return
  const journals = fs
    .readdirSync(dataDir)
    .map((name) => ({ name, match: RESTORE_SWAP_JOURNAL_RE.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((left, right) => left.name.localeCompare(right.name))

  for (const { name, match } of journals) {
    const id = match[1]!
    const journalFile = path.join(dataDir, name)
    const journal = readRestoreSwapJournal(dataDir, journalFile, id)
    const committed = restoreJournalDatabaseCommitted(db, journal)
    try {
      if (committed) completeRestoreSwapForward(journalFile, journal)
      else completeRestoreSwapBackward(journalFile, journal)
      logRestoreRecovery(
        logger,
        'warn',
        { restoreId: id, direction: committed ? 'forward' : 'backward' },
        'Recovered an interrupted backup restore directory swap',
      )
    } catch (error) {
      logRestoreRecovery(logger, 'error', { err: error, restoreId: id }, 'Interrupted backup restore recovery failed')
      throw error
    }
  }
}

function assertRestoreScratchIsUnused(journal: RestoreSwapJournal): void {
  for (const scratchPath of [
    journal.assets.tmpPath,
    journal.assets.oldPath,
    journal.save.tmpPath,
    journal.save.oldPath,
  ]) {
    if (fs.existsSync(scratchPath)) {
      throw new Error(`Refusing to overwrite unjournaled restore recovery data: ${scratchPath}`)
    }
  }
}

interface RestoreSqliteHooks {
  beforeCommit?: (databaseLineage: string) => void
  afterCommit?: (databaseLineage: string) => void
  onPostCommitError?: (error: unknown) => void
}

function copyGenerationFinalizationRetriesFromBackup(db: DatabaseSync): void {
  const backupColumns = new Set(
    (
      db.prepare("PRAGMA bak.table_info('generation_finalization_retries')").all() as Array<{
        name: string
      }>
    ).map((column) => column.name),
  )
  const targetSnapshot = backupColumns.has('target_snapshot_json') ? 'target_snapshot_json' : 'NULL'
  const alternateMessages = backupColumns.has('alternate_messages_json') ? 'alternate_messages_json' : "'[]'"
  const databaseLineage = backupColumns.has('database_lineage') ? 'database_lineage' : 'NULL'
  const operationId = backupColumns.has('operation_id') ? 'operation_id' : 'NULL'
  const operationAttemptNo = backupColumns.has('operation_attempt_no') ? 'operation_attempt_no' : 'NULL'
  const actorWriterSessionId = backupColumns.has('actor_writer_session_id') ? 'actor_writer_session_id' : 'NULL'
  const actorWriterEpoch = backupColumns.has('actor_writer_epoch') ? 'actor_writer_epoch' : 'NULL'
  const acceptedMessageId = backupColumns.has('accepted_message_id') ? 'accepted_message_id' : 'NULL'
  const terminalOutcome = backupColumns.has('terminal_outcome') ? 'terminal_outcome' : 'NULL'

  // Historical queue tables predate target snapshots (schema v18) and
  // alternate messages (v20). Keep the current destination order explicit so
  // both altered historical tables and fresh current tables restore safely.
  db.exec(`
    INSERT INTO main.generation_finalization_retries (
      generation_id,
      database_lineage,
      operation_id,
      operation_attempt_no,
      actor_writer_session_id,
      actor_writer_epoch,
      accepted_message_id,
      terminal_outcome,
      chat_id,
      mode,
      target_message_id,
      message_json,
      alternate_messages_json,
      chat_var_mutations_json,
      target_snapshot_json,
      failure_count,
      last_error,
      terminal_error,
      status,
      created_at,
      updated_at
    )
    SELECT
      generation_id,
      ${databaseLineage},
      ${operationId},
      ${operationAttemptNo},
      ${actorWriterSessionId},
      ${actorWriterEpoch},
      ${acceptedMessageId},
      ${terminalOutcome},
      chat_id,
      mode,
      target_message_id,
      message_json,
      ${alternateMessages},
      chat_var_mutations_json,
      ${targetSnapshot},
      failure_count,
      last_error,
      terminal_error,
      status,
      created_at,
      updated_at
    FROM bak.generation_finalization_retries
  `)
}

function copyCommandEventsFromBackup(db: DatabaseSync): void {
  const backupColumns = new Set(
    (
      db.prepare("PRAGMA bak.table_info('command_events')").all() as Array<{
        name: string
      }>
    ).map((column) => column.name),
  )
  const columnOrNull = (column: string): string => (backupColumns.has(column) ? column : 'NULL')
  db.exec(`
    INSERT INTO main.command_events (
      revision, type, resource, id, parent_id, origin_writer_session_id,
      database_lineage, operation_id, source_message_id, job_id, created_at
    )
    SELECT
      revision, type, resource, id, parent_id, ${columnOrNull('origin_writer_session_id')},
      ${columnOrNull('database_lineage')}, ${columnOrNull('operation_id')},
      ${columnOrNull('source_message_id')}, ${columnOrNull('job_id')}, created_at
    FROM bak.command_events
  `)
}

function rewriteRestoredGenerationOperationLineage(db: DatabaseSync, databaseLineage: string): void {
  createGenerationOperationTables(db)
  const projectionEpoch = bumpGenerationOperationProjectionEpoch(db)
  db.prepare(
    `
      UPDATE generation_operations
      SET database_lineage = ?, projection_epoch = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `,
  ).run(databaseLineage, projectionEpoch)
  db.prepare('UPDATE generation_operation_attempts SET database_lineage = ?').run(databaseLineage)
  db.prepare('UPDATE generation_effects SET database_lineage = ?').run(databaseLineage)
  db.prepare(
    `
      UPDATE generation_finalization_retries
      SET database_lineage = ?
      WHERE operation_id IS NOT NULL
    `,
  ).run(databaseLineage)
  db.prepare(
    `
      UPDATE command_events
      SET database_lineage = ?
      WHERE operation_id IS NOT NULL
    `,
  ).run(databaseLineage)
  db.prepare(
    `
      UPDATE messages
      SET json = json_set(json, '$.generationInfo.databaseLineage', ?)
      WHERE json_valid(json)
        AND json_type(json, '$.generationInfo.operationId') = 'text'
        AND EXISTS (
          SELECT 1
          FROM generation_operations
          WHERE database_lineage = ?
            AND operation_id = json_extract(messages.json, '$.generationInfo.operationId')
        )
    `,
  ).run(databaseLineage, databaseLineage)
}

function restoreSqliteFromBackup(
  db: DatabaseSync,
  backupDbPath: string | null,
  hooks: RestoreSqliteHooks = {},
): string {
  // Use ATTACH + table-level swap so the existing `db` handle stays valid
  // (file-rename would orphan open file descriptors and break every other
  // active route holding the same handle). The transaction is atomic with
  // respect to other queries on this connection.
  if (backupDbPath === null) {
    // No SQLite backup payload: clear live SQLite-backed state before importing
    // any legacy db.json, so rows absent from the snapshot do not survive
    // restore.
    db.exec('BEGIN')
    db.exec('PRAGMA defer_foreign_keys = ON')
    let databaseLineage: string
    let committed = false
    try {
      for (const table of SQLITE_BACKUP_TABLES) {
        db.exec(`DELETE FROM ${table}`)
      }
      rebuildAllBardWikiDerivedState(db)
      db.exec('DELETE FROM request_history')
      databaseLineage = rotateDatabaseLineage(db)
      rewriteRestoredGenerationOperationLineage(db, databaseLineage)
      hooks.beforeCommit?.(databaseLineage)
      migrateLegacyAgentConfigurationInSqlite(db)
      repairPersistedModelProfileInlineSecretsInSqlite(db)
      db.exec('COMMIT')
      committed = true
    } catch (err) {
      if (!committed) {
        try {
          db.exec('ROLLBACK')
        } catch (rollbackError) {
          throw new AggregateError([err, rollbackError], 'SQLite restore and rollback both failed')
        }
      }
      throw err
    }
    try {
      hooks.afterCommit?.(databaseLineage)
    } catch (error) {
      hooks.onPostCommitError?.(error)
    }
    return databaseLineage
  }

  // ATTACH expects a SQL string literal; the path is constructed locally and
  // sanitised by replacing single quotes.
  const sqlLiteralPath = backupDbPath.replaceAll("'", "''")
  db.exec(`ATTACH DATABASE '${sqlLiteralPath}' AS bak`)
  let databaseLineage: string | undefined
  let committed = false
  let operationError: unknown
  try {
    db.exec('BEGIN')
    db.exec('PRAGMA defer_foreign_keys = ON')
    try {
      // Keep the live schema version current; only the snapshot's revision is
      // part of the restored durable state.
      const schemaVersionExists = db
        .prepare("SELECT name FROM bak.sqlite_master WHERE type = 'table' AND name = 'schema_version'")
        .get()
      if (schemaVersionExists) {
        db.exec(
          `UPDATE main.schema_version
           SET revision = COALESCE(
             (SELECT revision FROM bak.schema_version WHERE id = 1),
             revision
           )
           WHERE id = 1`,
        )
      }
      for (const table of SQLITE_BACKUP_TABLES) {
        // Verify the table exists in the backup; older snapshots may predate
        // memory tables.
        const exists = db.prepare(`SELECT name FROM bak.sqlite_master WHERE type = 'table' AND name = ?`).get(table)
        db.exec(`DELETE FROM main.${table}`)
        if (exists) {
          if (table === 'generation_finalization_retries') {
            copyGenerationFinalizationRetriesFromBackup(db)
          } else if (table === 'command_events') {
            copyCommandEventsFromBackup(db)
          } else {
            db.exec(`INSERT INTO main.${table} SELECT * FROM bak.${table}`)
          }
        }
      }
      rebuildAllBardWikiDerivedState(db)
      db.exec('DELETE FROM request_history')
      repairPersistedGlobalLorebookIdsInSqlite(db)
      repairPersistedPersonaSelectionIdentityInSqlite(db)
      repairPersistedHypaV3PresetSelectionIdentityInSqlite(db)
      repairPersistedTranslatorPresetSelectionIdentityInSqlite(db)
      repairPersistedLegacyLocalStopStringsInSqlite(db)
      databaseLineage = rotateDatabaseLineage(db)
      rewriteRestoredGenerationOperationLineage(db, databaseLineage)
      hooks.beforeCommit?.(databaseLineage)
      migrateLegacyAgentConfigurationInSqlite(db)
      repairPersistedModelProfileInlineSecretsInSqlite(db)
      db.exec('COMMIT')
      committed = true
    } catch (err) {
      if (!committed) {
        try {
          db.exec('ROLLBACK')
        } catch (rollbackError) {
          throw new AggregateError([err, rollbackError], 'SQLite restore and rollback both failed')
        }
      }
      throw err
    }
  } catch (error) {
    operationError = error
  }
  if (committed && databaseLineage) {
    try {
      hooks.afterCommit?.(databaseLineage)
    } catch (error) {
      hooks.onPostCommitError?.(error)
    }
  }
  try {
    db.exec('DETACH DATABASE bak')
  } catch (detachError) {
    if (committed) hooks.onPostCommitError?.(detachError)
    else if (operationError) operationError = new AggregateError([operationError, detachError], 'SQLite restore failed')
    else operationError = detachError
  }
  if (operationError) throw operationError
  if (!databaseLineage) {
    throw new Error('restore did not rotate database lineage')
  }
  return databaseLineage
}

export interface RestoreBackupResult {
  revision: number
  event: CommandEvent
  databaseLineage: string
  writerEpoch: number
}

export async function restoreBackup(
  db: DatabaseSync,
  dataDir: string,
  id: string,
  options: {
    automaticBackupRetention?: number
    signal?: AbortSignal
    /** Synchronous route effects must precede post-commit retention awaits. */
    onCommitted?: (result: RestoreBackupResult) => void
  } = {},
): Promise<RestoreBackupResult> {
  const lease = getMaintenanceCoordinator(dataDir).beginExclusive('restore', options.signal)
  try {
    if (!isValidBackupId(id)) {
      throw new EntityNotFoundError(`Backup not found: ${id}`)
    }
    const manifestPath = path.join(backupDir(dataDir, id), 'manifest.json')
    const legacySnapshot = path.join(backupDir(dataDir, id), 'db.json')
    if (!fs.existsSync(manifestPath) && !fs.existsSync(legacySnapshot)) {
      throw new EntityNotFoundError(`Backup not found: ${id}`)
    }

    const backupSqlite = path.join(backupDir(dataDir, id), 'risu.db')
    const usableDatabasePayloads = validateBackupDatabasePayloads(backupSqlite, legacySnapshot)

    // A prior failed attempt is recovered before a safety snapshot or new
    // staging work. Validation intentionally remains the first mutating guard.
    recoverInterruptedRestoreSwaps(db, dataDir)
    const journal = createRestoreSwapJournal(dataDir, id)
    const journalFile = restoreJournalPath(dataDir, id)
    assertRestoreScratchIsUnused(journal)

    const safetyFence = captureMaintenanceWriteFence(db)
    const automaticBackup = await createAutomaticSafetyBackup(
      db,
      dataDir,
      lease,
      options.automaticBackupRetention,
      // Retention must not delete an automatic snapshot while it is the active
      // restore source. The newly created snapshot is protected by the helper.
      [id],
      path.join(backupDir(dataDir, id), 'assets'),
    )
    lease.signal.throwIfAborted()
    assertMaintenanceWriteFence(db, safetyFence)

    writeRestoreSwapJournal(journalFile, journal, true)
    try {
      stageRestoreSwapComponent(journal.assets)
      stageRestoreSwapComponent(journal.save)
    } catch (error) {
      try {
        completeRestoreSwapBackward(journalFile, journal)
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], 'Restore staging failed and cleanup is incomplete')
      }
      throw error
    }

    let event: CommandEvent | undefined
    let databaseLineage: string | undefined
    let sqliteCommitted = false
    try {
      if (journal.assets.hadLiveDirectory) fs.renameSync(journal.assets.livePath, journal.assets.oldPath)
      updateRestoreSwapJournal(journalFile, journal, { phase: 'assets-parked' })
      if (journal.save.hadLiveDirectory) fs.renameSync(journal.save.livePath, journal.save.oldPath)
      updateRestoreSwapJournal(journalFile, journal, { phase: 'save-parked' })

      databaseLineage = restoreSqliteFromBackup(db, usableDatabasePayloads.sqlite ? backupSqlite : null, {
        beforeCommit: (nextDatabaseLineage) => {
          // Retain the transaction's lineage in memory too, so an ambiguous COMMIT
          // error that is resolved as committed can still return the correct
          // replacement ownership after finishing forward.
          databaseLineage = nextDatabaseLineage
          // If the backup carries a legacy db.json, import it into SQLite inside
          // the restore transaction so a failed re-import rolls everything back.
          if (usableDatabasePayloads.legacyJson) importLegacyDatabaseSnapshot(db, legacySnapshot)
          event = persistRevisionedCommandEvent(db, COMMAND_EVENT_CATALOG.stateRestored)

          fs.renameSync(journal.assets.tmpPath, journal.assets.livePath)
          updateRestoreSwapJournal(journalFile, journal, { phase: 'assets-installed' })
          fs.renameSync(journal.save.tmpPath, journal.save.livePath)
          updateRestoreSwapJournal(journalFile, journal, { phase: 'save-installed' })
          // This lineage is transactionally visible iff COMMIT succeeds. Boot can
          // therefore resolve a crash before the post-COMMIT phase write.
          updateRestoreSwapJournal(journalFile, journal, {
            phase: 'committing',
            expectedDatabaseLineage: nextDatabaseLineage,
          })
        },
        afterCommit: () => {
          sqliteCommitted = true
          updateRestoreSwapJournal(journalFile, journal, { phase: 'committed' })
        },
        onPostCommitError: (error) => {
          sqliteCommitted = true
          logRestoreRecovery(
            undefined,
            'error',
            { err: error, restoreId: id },
            'Backup restore committed; finishing the directory swap forward after a post-commit error',
          )
        },
      })
      sqliteCommitted = true
      completeRestoreSwapForward(journalFile, journal)
    } catch (err) {
      const committed = sqliteCommitted || restoreJournalDatabaseCommitted(db, journal)
      if (committed) {
        logRestoreRecovery(
          undefined,
          'error',
          { err, restoreId: id },
          'Backup restore committed; completing the directory swap forward',
        )
        completeRestoreSwapForward(journalFile, journal)
      } else {
        try {
          completeRestoreSwapBackward(journalFile, journal)
        } catch (recoveryError) {
          logRestoreRecovery(
            undefined,
            'error',
            { err: recoveryError, restoreId: id },
            'Backup restore rollback is incomplete and will be retried on boot',
          )
          throw new AggregateError([err, recoveryError], 'Backup restore failed and directory rollback is incomplete')
        }
        throw err
      }
    }

    if (!event) {
      throw new Error('restore did not produce a command event')
    }
    if (!databaseLineage) {
      throw new Error('restore did not return database lineage')
    }
    const result: RestoreBackupResult = {
      revision: event.revision,
      event,
      databaseLineage,
      writerEpoch: getDatabaseWriterMetadata(db).epoch,
    }
    // Reconcile the restored ledger and publish state.restored before another
    // request can accept work in the replacement lineage during retention.
    options.onCommitted?.(result)
    if (automaticBackup) {
      try {
        // A retention cap of one temporarily needs both the restore source and
        // its safety snapshot. Once restore is complete, the old source may be
        // pruned without racing the operation; always retain the new snapshot.
        await pruneAutomaticBackups(
          dataDir,
          lease,
          options.automaticBackupRetention ?? DEFAULT_AUTOMATIC_BACKUP_RETENTION,
          new Set([automaticBackup.id]),
        )
      } catch {
        // The safety snapshot already exists and the restore has committed. Do
        // not report a false restore failure for post-operation housekeeping;
        // the next safety snapshot will retry bounded retention.
      }
    }
    return result
  } finally {
    lease.release()
  }
}

export async function deleteBackup(dataDir: string, id: string): Promise<void> {
  const lease = getMaintenanceCoordinator(dataDir).beginExclusive('delete-backup')
  try {
    await deleteBackupUnderLease(dataDir, id, lease)
  } finally {
    lease.release()
  }
}

async function deleteBackupUnderLease(dataDir: string, id: string, lease: MaintenanceLease): Promise<void> {
  getMaintenanceCoordinator(dataDir).assertExclusive(lease)
  if (!isValidBackupId(id)) throw new EntityNotFoundError(`Backup not found: ${id}`)
  const dir = backupDir(dataDir, id)
  if (!fs.existsSync(dir)) throw new EntityNotFoundError(`Backup not found: ${id}`)
  await fs.promises.rm(dir, { recursive: true, force: true })
}

function rmDirectoryIfPresent(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}
