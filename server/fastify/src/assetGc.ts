import fs from 'node:fs'
import path from 'node:path'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { scanAssetReferences, type AssetReferenceMarks, type AssetReferenceScanStats } from './assetReferenceScan.js'
import { getDatabaseLineage } from './databaseLineage.js'
import { getMaintenanceCoordinator } from './maintenanceCoordinator.js'
import type { DatabaseSync } from 'node:sqlite'
import { assetPath, assetsDir, deleteAssetMetadataByIds, isValidAssetId, type PersistedAsset } from './repository.js'
import {
  type RisuSaveAssetReport,
  type RisuSaveAssetReferenceSource,
  buildRisuSaveAssetReport,
  collectInlayAssetReferenceSources,
  collectMessageInlayReferences,
} from './risuSave/assetReferences.js'

// Periodic discovery yields to requests; reclamation keeps short synchronous
// transactions/turns so no new reference can enter a check/delete gap.
export const ASSET_GC_INTERVAL_MS = 15 * 60_000

// An unreferenced asset must have been on disk (by file mtime) for at least this
// long before it is eligible for deletion. This closes the upload→reference
// race: an asset is uploaded by one request and referenced by a later mutation,
// so a sweep that runs in between must not reclaim the freshly-written bytes.
export const ASSET_GC_GRACE_MS = 60 * 60_000
export const ASSET_GC_RECLAIM_BATCH = 16
export const ASSET_GC_RESULT_LIMIT = 1024
export const ASSET_GC_FILE_READ_CONCURRENCY = 4
const ASSET_GC_SCAN_PAGE = 64

export interface AssetGcOptions {
  /** SQLite connection used to project all durable reference surfaces. */
  db?: DatabaseSync
  /** Minimum age (by file mtime) before an unreferenced asset may be deleted. */
  graceMs?: number
  /** Injectable clock (ms epoch) for tests. */
  now?: () => number
  signal?: AbortSignal
  /** Diagnostic/interleaving seam; production has no phase callback. */
  onPhase?: (phase: 'discovered' | 'before-reclaim' | 'after-reclaim') => void | Promise<void>
}

export interface AssetGcResult {
  /** sha256 ids whose metadata entry (and file, if present) were removed. */
  deletedAssetIds: string[]
  /** stray asset files (no metadata entry, unreferenced) that were removed. */
  deletedStrayFiles: string[]
  /** orphaned/stray candidates skipped because they are within the grace window. */
  skippedByGrace: number
  /** total orphaned metadata entries considered this run. */
  scannedOrphans: number
  deletedAssetCount: number
  deletedStrayFileCount: number
  resultsTruncated: boolean
  status: 'completed' | 'skipped' | 'cancelled' | 'stale'
  referenceScan?: AssetReferenceScanStats
}

type JsonRecord = Record<string, unknown>

interface CollectionReferenceRow {
  value: unknown
}

interface CharacterReferenceRow {
  id: string
  image: unknown
  notificationImage: unknown
  emotionImagesJson: unknown
  additionalAssetsJson: unknown
  ccAssetsJson: unknown
  vitsFilesJson: unknown
  prebuiltAssetExcludeJson: unknown
  gptSoVitsAssetId: unknown
  firstMessage: unknown
  alternateGreetingsJson: unknown
  backgroundHTML: unknown
  creatorNotes: unknown
  name: unknown
  nickname: unknown
  desc: unknown
  personality: unknown
  scenario: unknown
  exampleMessage: unknown
}

interface ChatReferenceRow {
  id: string
  characterId: string
  dataId: unknown
  messageJson: unknown
}

function fileAgeMs(file: string, now: number): number | null {
  try {
    const stat = fs.statSync(file)
    return now - stat.mtimeMs
  } catch {
    // File missing or unreadable.
    return null
  }
}

function readRecord(value: unknown): JsonRecord | null {
  return !!value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null
}

function readJsonFragment(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function setIfPresent(record: JsonRecord, key: string, value: unknown): void {
  if (value !== null && value !== undefined) record[key] = value
}

function loadSettingsReferenceShape(db: DatabaseSync): JsonRecord | null {
  const row = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined
  if (!row) return null
  const parsed = JSON.parse(row.data_json) as unknown
  return readRecord(parsed)
}

function collectionRows(db: DatabaseSync, tableName: string, fieldPath: string): unknown[] {
  const rows = db
    .prepare(`SELECT json_extract(data_json, ?) AS value FROM ${tableName} ORDER BY position`)
    .all(fieldPath) as unknown as CollectionReferenceRow[]
  return rows.map((row) => row.value)
}

function collectionRowsWithJsonFragment(db: DatabaseSync, tableName: string, fieldPath: string): unknown[] {
  return collectionRows(db, tableName, fieldPath).map(readJsonFragment)
}

function applyCollectionOverride(
  database: JsonRecord,
  field: string,
  rows: unknown[],
  buildRow: (value: unknown) => JsonRecord,
): void {
  if (rows.length === 0) return
  database[field] = rows.map(buildRow)
}

function loadCharacterReferenceRows(db: DatabaseSync): CharacterReferenceRow[] {
  return db
    .prepare(
      `
      SELECT
        id,
        json_extract(data_json, '$.image') AS image,
        json_extract(data_json, '$.notificationImage') AS notificationImage,
        json_extract(data_json, '$.emotionImages') AS emotionImagesJson,
        json_extract(data_json, '$.additionalAssets') AS additionalAssetsJson,
        json_extract(data_json, '$.ccAssets') AS ccAssetsJson,
        json_extract(data_json, '$.vits.files') AS vitsFilesJson,
        json_extract(data_json, '$.prebuiltAssetExclude') AS prebuiltAssetExcludeJson,
        json_extract(data_json, '$.gptSoVitsConfig.ref_audio_data.assetId') AS gptSoVitsAssetId,
        json_extract(data_json, '$.firstMessage') AS firstMessage,
        json_extract(data_json, '$.alternateGreetings') AS alternateGreetingsJson,
        json_extract(data_json, '$.backgroundHTML') AS backgroundHTML,
        json_extract(data_json, '$.creatorNotes') AS creatorNotes,
        json_extract(data_json, '$.name') AS name,
        json_extract(data_json, '$.nickname') AS nickname,
        json_extract(data_json, '$.desc') AS desc,
        json_extract(data_json, '$.personality') AS personality,
        json_extract(data_json, '$.scenario') AS scenario,
        json_extract(data_json, '$.exampleMessage') AS exampleMessage
      FROM characters
      ORDER BY position
    `,
    )
    .all() as unknown as CharacterReferenceRow[]
}

function loadChatReferenceRows(db: DatabaseSync): ChatReferenceRow[] {
  return db
    .prepare(
      `
      SELECT
        id,
        character_id AS characterId,
        json_extract(data_json, '$.id') AS dataId,
        json_extract(data_json, '$.message') AS messageJson
      FROM chats
      ORDER BY character_id, position
    `,
    )
    .all() as unknown as ChatReferenceRow[]
}

function buildMinimalCharacter(row: CharacterReferenceRow, chats: unknown[]): JsonRecord {
  const character: JsonRecord = { chats }
  setIfPresent(character, 'image', row.image)
  setIfPresent(character, 'notificationImage', row.notificationImage)
  setIfPresent(character, 'emotionImages', readJsonFragment(row.emotionImagesJson))
  setIfPresent(character, 'additionalAssets', readJsonFragment(row.additionalAssetsJson))
  setIfPresent(character, 'ccAssets', readJsonFragment(row.ccAssetsJson))
  setIfPresent(character, 'prebuiltAssetExclude', readJsonFragment(row.prebuiltAssetExcludeJson))
  const vitsFiles = readJsonFragment(row.vitsFilesJson)
  if (vitsFiles !== undefined) character.vits = { files: vitsFiles }
  if (row.gptSoVitsAssetId !== null && row.gptSoVitsAssetId !== undefined) {
    character.gptSoVitsConfig = { ref_audio_data: { assetId: row.gptSoVitsAssetId } }
  }
  setIfPresent(character, 'firstMessage', row.firstMessage)
  setIfPresent(character, 'alternateGreetings', readJsonFragment(row.alternateGreetingsJson))
  setIfPresent(character, 'backgroundHTML', row.backgroundHTML)
  setIfPresent(character, 'creatorNotes', row.creatorNotes)
  setIfPresent(character, 'name', row.name)
  setIfPresent(character, 'nickname', row.nickname)
  setIfPresent(character, 'desc', row.desc)
  setIfPresent(character, 'personality', row.personality)
  setIfPresent(character, 'scenario', row.scenario)
  setIfPresent(character, 'exampleMessage', row.exampleMessage)
  return character
}

function buildMinimalChat(row: ChatReferenceRow): JsonRecord {
  const chat: JsonRecord = {}
  chat.id = typeof row.dataId === 'string' ? row.dataId : row.id
  const message = readJsonFragment(row.messageJson)
  if (message !== undefined) chat.message = message
  return chat
}

function loadAssetGcReferenceDatabase(db: DatabaseSync): unknown {
  const settings = loadSettingsReferenceShape(db)
  if (settings === null) return null

  const database: JsonRecord = { ...settings }

  applyCollectionOverride(database, 'modules', collectionRowsWithJsonFragment(db, 'modules', '$.assets'), (assets) => ({
    assets,
  }))
  applyCollectionOverride(database, 'personas', collectionRows(db, 'personas', '$.icon'), (icon) => ({
    icon,
  }))
  applyCollectionOverride(database, 'botPresets', collectionRows(db, 'bot_presets', '$.image'), (image) => ({ image }))
  applyCollectionOverride(database, 'modelPresets', collectionRows(db, 'model_presets', '$.image'), (image) => ({
    image,
  }))
  applyCollectionOverride(database, 'promptPresets', collectionRows(db, 'prompt_presets', '$.image'), (image) => ({
    image,
  }))

  const pluginCustomStorage = loadPluginCustomStorageReferenceShape(db)
  if (pluginCustomStorage !== null) database.pluginCustomStorage = pluginCustomStorage

  const characterRows = loadCharacterReferenceRows(db)
  if (characterRows.length > 0 || !Array.isArray(settings.characters)) {
    const chatsByCharacterId = new Map<string, unknown[]>()
    for (const row of loadChatReferenceRows(db)) {
      const chats = chatsByCharacterId.get(row.characterId) ?? []
      chats.push(buildMinimalChat(row))
      chatsByCharacterId.set(row.characterId, chats)
    }
    database.characters = characterRows.map((row) => buildMinimalCharacter(row, chatsByCharacterId.get(row.id) ?? []))
  }

  return database
}

export function buildAssetGcRisuSaveAssetReport(
  db: DatabaseSync,
  assets: readonly PersistedAsset[],
): RisuSaveAssetReport {
  // Extra references (including catalog membership) must still participate on
  // a freshly initialized database whose settings row has not been created.
  const database = loadAssetGcReferenceDatabase(db) ?? {}
  return buildRisuSaveAssetReport(database, assets, [
    ...collectMessageInlayReferences(db, database),
    ...collectInlayCatalogReferences(db),
    ...collectPendingFinalizationInlayReferences(db),
    ...collectAcceptedConfigurationAssetReferences(db),
  ])
}

function collectAcceptedConfigurationAssetReferences(db: DatabaseSync): RisuSaveAssetReferenceSource[] {
  const references: RisuSaveAssetReferenceSource[] = []
  for (const row of db
    .prepare(
      `
    SELECT asset.value AS value FROM generation_configuration_dependencies AS dependency,
    json_each(dependency.asset_ids_json) AS asset
  `,
    )
    .iterate()) {
    references.push({ value: row.value, path: 'acceptedConfiguration' })
    references.push(...collectInlayAssetReferenceSources(row.value, 'acceptedConfiguration'))
  }
  for (const row of db
    .prepare(
      "SELECT json_extract(effective_configuration_json, '$.database') AS json FROM generation_operations WHERE json_extract(effective_configuration_json, '$.version') = 1",
    )
    .iterate()) {
    for (const asset of buildRisuSaveAssetReport(JSON.parse(String(row.json)), []).referenced) {
      references.push({ value: asset.id, path: 'acceptedConfiguration' })
    }
  }
  return references
}

function loadPluginCustomStorageReferenceShape(db: DatabaseSync): JsonRecord | null {
  const rows = db.prepare('SELECT key, value_json FROM plugin_custom_storage ORDER BY key').all() as Array<{
    key: string
    value_json: string
  }>
  if (rows.length === 0) return null
  const storage: JsonRecord = {}
  for (const row of rows) {
    const value = readJsonFragment(row.value_json)
    if (value !== undefined) storage[row.key] = value
  }
  return storage
}

function collectInlayCatalogReferences(db: DatabaseSync): RisuSaveAssetReferenceSource[] {
  const rows = db.prepare('SELECT asset_id FROM inlay_catalog ORDER BY asset_id').all() as Array<{ asset_id: string }>
  return rows.map((row, index) => ({
    value: row.asset_id,
    path: `inlayCatalog[${index}].assetId`,
  }))
}

function collectPendingFinalizationInlayReferences(db: DatabaseSync): RisuSaveAssetReferenceSource[] {
  const messageRows = db
    .prepare(
      `
        SELECT generation_id, json_extract(message_json, '$.data') AS data
        FROM generation_finalization_retries
        WHERE status = 'pending'
        ORDER BY generation_id
      `,
    )
    .all() as Array<{ generation_id: string; data: unknown }>
  const alternateRows = db
    .prepare(
      `
        SELECT
          retries.generation_id,
          CAST(alternates.key AS INTEGER) AS message_index,
          CASE
            WHEN alternates.type = 'object' THEN json_extract(alternates.value, '$.data')
            ELSE NULL
          END AS data
        FROM generation_finalization_retries AS retries,
          json_each(retries.alternate_messages_json) AS alternates
        WHERE retries.status = 'pending'
        ORDER BY retries.generation_id, CAST(alternates.key AS INTEGER)
      `,
    )
    .all() as Array<{ generation_id: string; message_index: number; data: unknown }>

  return [
    ...messageRows.flatMap((row) =>
      collectInlayAssetReferenceSources(
        row.data,
        `generationFinalizationRetries[${JSON.stringify(row.generation_id)}].message.data`,
      ),
    ),
    ...alternateRows.flatMap((row) =>
      collectInlayAssetReferenceSources(
        row.data,
        `generationFinalizationRetries[${JSON.stringify(row.generation_id)}].alternateMessages[${row.message_index}].data`,
      ),
    ),
  ]
}

class StaleAssetDiscoveryError extends Error {}

async function* assetFiles(directory: string): AsyncGenerator<string> {
  let handle: fs.Dir
  try {
    handle = await fs.promises.opendir(directory, { bufferSize: ASSET_GC_SCAN_PAGE })
  } catch {
    return
  }
  for await (const entry of handle) yield entry.name
}

async function asyncFileAgeMs(file: string, now: number): Promise<number | null> {
  try {
    return now - (await fs.promises.stat(file)).mtimeMs
  } catch {
    return null
  }
}

/**
 * Mark references in bounded yielding scans, then reclaim under a current
 * authoritative fence. A stale scan retains candidates for a later sweep.
 * Metadata commits before canonical unlink, with no await between them: failed
 * COMMIT never loses bytes and a new upload cannot enter the unlink interval.
 */
export async function runAssetGc(dataDir: string, opts: AssetGcOptions = {}): Promise<AssetGcResult> {
  const result: AssetGcResult = {
    deletedAssetIds: [],
    deletedStrayFiles: [],
    skippedByGrace: 0,
    scannedOrphans: 0,
    deletedAssetCount: 0,
    deletedStrayFileCount: 0,
    resultsTruncated: false,
    status: 'skipped',
  }
  if (!opts.db) return result
  if (opts.signal?.aborted) return { ...result, status: 'cancelled' }
  const db = opts.db
  const coordinator = getMaintenanceCoordinator(dataDir)
  const lease = coordinator.beginGc(opts.signal)
  if (!lease) return result
  let marks: AssetReferenceMarks | undefined
  try {
    const changes = db.prepare('SELECT total_changes() AS value')
    const dataVersion = db.prepare('PRAGMA data_version')
    const readChanges = () => Number(changes.get()?.value)
    let expectedChanges = readChanges()
    const expectedDataVersion = dataVersion.get()?.data_version
    const expectedLineage = getDatabaseLineage(db)
    const protectionVersion = coordinator.protectionVersion
    const activityVersion = coordinator.activityVersion
    const graceMs = opts.graceMs ?? ASSET_GC_GRACE_MS
    const now = opts.now ? opts.now() : Date.now()
    const directory = assetsDir(dataDir)
    const assertCurrent = (): void => {
      lease.signal.throwIfAborted()
      if (
        coordinator.isReclamationBlocked() ||
        coordinator.protectionVersion !== protectionVersion ||
        coordinator.activityVersion !== activityVersion ||
        readChanges() !== expectedChanges ||
        dataVersion.get()?.data_version !== expectedDataVersion ||
        getDatabaseLineage(db) !== expectedLineage
      ) {
        throw new StaleAssetDiscoveryError()
      }
    }
    const recordDeletion = (kind: 'asset' | 'stray', value: string): void => {
      if (kind === 'asset') result.deletedAssetCount++
      else result.deletedStrayFileCount++
      if (result.deletedAssetIds.length + result.deletedStrayFiles.length < ASSET_GC_RESULT_LIMIT) {
        ;(kind === 'asset' ? result.deletedAssetIds : result.deletedStrayFiles).push(value)
      } else result.resultsTruncated = true
    }
    const phase = async (name: 'discovered' | 'before-reclaim' | 'after-reclaim'): Promise<void> => {
      if (opts.onPhase) await opts.onPhase(name)
      assertCurrent()
    }
    marks = await scanAssetReferences(db, {
      scratchPath: path.join(dataDir, '.asset-gc-references.sqlite'),
      signal: lease.signal,
      checkpoint: assertCurrent,
    })
    result.referenceScan = marks.stats

    // Preserve the global upload/import grace policy without retaining a
    // directory-sized array. Recent activity defers all orphan/stray removal.
    let uploadActive = false
    let ageFiles: string[] = []
    const checkFileAges = async (): Promise<void> => {
      if (ageFiles.length === 0) return
      const files = ageFiles
      ageFiles = []
      // stat errors retain their previous unreadable/missing policy. All four
      // reads settle before cancellation or a changed authority fence is used.
      const ages = await Promise.all(files.map((file) => asyncFileAgeMs(file, now)))
      assertCurrent()
      uploadActive = ages.some((age) => age !== null && age < graceMs)
    }
    for await (const name of assetFiles(directory)) {
      assertCurrent()
      const id = name.replace(/\.[^.]+$/, '')
      if (!isValidAssetId(id)) continue
      ageFiles.push(path.join(directory, name))
      if (ageFiles.length >= ASSET_GC_FILE_READ_CONCURRENCY) {
        await checkFileAges()
        if (uploadActive) break
      }
    }
    await checkFileAges()
    await phase('discovered')
    const assetPage = db.prepare(
      'SELECT id, ext, size, content_type AS contentType FROM assets WHERE id > ? ORDER BY id LIMIT 64',
    )
    const currentAsset = db.prepare('SELECT id, ext FROM assets WHERE id = ?')
    let cursor = ''
    while (true) {
      assertCurrent()
      const assets = assetPage.all(cursor) as unknown as PersistedAsset[]
      if (assets.length === 0) break
      cursor = assets[assets.length - 1].id
      for (let start = 0; start < assets.length; start += ASSET_GC_RECLAIM_BATCH) {
        const candidates = assets.slice(start, start + ASSET_GC_RECLAIM_BATCH).filter((asset) => !marks!.has(asset.id))
        result.scannedOrphans += candidates.length
        if (uploadActive) {
          result.skippedByGrace += candidates.length
          continue
        }
        if (candidates.length === 0) continue
        await phase('before-reclaim')
        const reclaimed: Array<{ id: string; file: string | null }> = []
        db.exec('BEGIN IMMEDIATE')
        try {
          assertCurrent()
          for (const asset of candidates) {
            const current = currentAsset.get(asset.id)
            if (!current || current.ext !== asset.ext || marks.has(asset.id)) continue
            const file = assetPath(dataDir, asset)
            const age = fileAgeMs(file, now)
            if (age !== null && age < graceMs) {
              result.skippedByGrace++
              continue
            }
            reclaimed.push({ id: asset.id, file: age === null ? null : file })
          }
          deleteAssetMetadataByIds(
            db,
            reclaimed.map((asset) => asset.id),
          )
          db.exec('COMMIT')
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK')
          throw error
        }
        // This is the same JS turn as COMMIT; only unique canonical paths from
        // that committed batch can be removed, never a later asynchronous tail.
        for (const asset of reclaimed) {
          if (asset.file) {
            try {
              fs.rmSync(asset.file, { force: true })
            } catch {
              /* retry as a stray later */
            }
          }
          recordDeletion('asset', asset.id)
        }
        expectedChanges = readChanges()
        await phase('after-reclaim')
        await yieldTurn()
      }
      await yieldTurn()
    }

    // Reopen the directory for strays instead of retaining names across awaits.
    let strayBatch: Array<{ id: string; name: string }> = []
    const reclaimStrays = async (): Promise<void> => {
      const candidates = strayBatch
      strayBatch = []
      if (candidates.length === 0) return
      if (uploadActive) {
        result.skippedByGrace += candidates.length
        return
      }
      await phase('before-reclaim')
      const files: Array<{ name: string; file: string }> = []
      db.exec('BEGIN IMMEDIATE')
      try {
        assertCurrent()
        for (const entry of candidates) {
          if (currentAsset.get(entry.id) || marks!.has(entry.id)) continue
          const file = path.join(directory, entry.name)
          const age = fileAgeMs(file, now)
          if (age === null) continue
          if (age < graceMs) {
            result.skippedByGrace++
            continue
          }
          files.push({ name: entry.name, file })
        }
        db.exec('COMMIT')
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK')
        throw error
      }
      for (const { name, file } of files) {
        try {
          fs.rmSync(file, { force: true })
          recordDeletion('stray', name)
        } catch {
          /* retry later */
        }
      }
      expectedChanges = readChanges()
      await phase('after-reclaim')
      await yieldTurn()
    }
    for await (const name of assetFiles(directory)) {
      assertCurrent()
      const id = name.replace(/\.[^.]+$/, '')
      if (!isValidAssetId(id) || currentAsset.get(id) || marks.has(id)) continue
      strayBatch.push({ id, name })
      if (strayBatch.length >= ASSET_GC_RECLAIM_BATCH) await reclaimStrays()
    }
    await reclaimStrays()
    assertCurrent()
    result.status = 'completed'
    return result
  } catch (error) {
    if (lease.signal.aborted) return { ...result, status: 'cancelled' }
    if (error instanceof StaleAssetDiscoveryError) return { ...result, status: 'stale' }
    throw error
  } finally {
    try {
      await marks?.close()
    } finally {
      lease.release()
    }
  }
}
