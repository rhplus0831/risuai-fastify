import { rm } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'
import {
  buildRisuSaveAssetReport,
  collectInlayAssetReferenceSources,
  type RisuSaveAssetReferenceSource,
} from './risuSave/assetReferences.js'
import {
  CHARACTER_ASSET_REFERENCE_FIELDS,
  CHARACTER_ASSET_REFERENCE_LIST_FIELDS,
  CHARACTER_ASSET_TUPLE_FIELDS,
  CHARACTER_TEXT_INLAY_FIELDS,
  COLLECTION_ASSET_IMAGE_OWNERS,
  NESTED_ASSET_REFERENCE_FIELDS,
  ROOT_ASSET_REFERENCE_FIELDS,
} from './risuSave/assetOwnerCatalog.js'

export const ASSET_REFERENCE_SCAN_ROWS = 64
export const ASSET_REFERENCE_SCAN_BYTES = 256 * 1024
export const ASSET_REFERENCE_SCAN_SLICE_MS = 4

export interface AssetReferenceScanStats {
  rows: number
  bytes: number
  yields: number
  largestRowBytes: number
  referenceCount: number
}

export interface AssetReferenceMarks {
  has(id: string): boolean
  referencePages(): AsyncIterable<readonly string[]>
  readonly stats: AssetReferenceScanStats
  close(): Promise<void>
}

export interface AssetReferenceScanOptions {
  /** A private, fixed filename owned by the caller's maintenance lease. */
  scratchPath: string
  signal?: AbortSignal
  /** Revalidate the caller's snapshot/activity fence; throwing discards the scan. */
  checkpoint?: () => void
  onYield?: () => void | Promise<void>
}

type Row = Record<string, unknown>
type Field = { path: string; fragment?: boolean }
type Query = {
  from: string
  columns: string
  keys: string[]
  where?: string
  args?: SQLInputValue[]
}

const characterFields: Field[] = [
  ...CHARACTER_ASSET_REFERENCE_FIELDS.map((path) => ({ path })),
  ...CHARACTER_ASSET_TUPLE_FIELDS.map((path) => ({ path, fragment: true })),
  ...CHARACTER_ASSET_REFERENCE_LIST_FIELDS.map((path) => ({ path, fragment: true })),
  { path: 'ccAssets', fragment: true },
  { path: 'vits.files', fragment: true },
  { path: 'gptSoVitsConfig.ref_audio_data.assetId' },
  ...CHARACTER_TEXT_INLAY_FIELDS.map((path) => ({ path })),
  { path: 'alternateGreetings', fragment: true },
]

const settingsFields: Field[] = [
  ...ROOT_ASSET_REFERENCE_FIELDS.map((path) => ({ path })),
  ...NESTED_ASSET_REFERENCE_FIELDS.flatMap(({ owner, fields }) =>
    fields.map((field) => ({ path: `${owner}.${field}` })),
  ),
]

const collectionOwners = [
  { owner: 'modules', table: 'modules', field: 'assets', fragment: true },
  { owner: 'personas', table: 'personas', field: 'icon' },
  ...COLLECTION_ASSET_IMAGE_OWNERS.map((owner) => ({
    owner,
    table: { botPresets: 'bot_presets', modelPresets: 'model_presets', promptPresets: 'prompt_presets' }[owner],
    field: 'image',
  })),
]

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

// JSON quoting preserves the distinction between a JSON string containing an
// array and an actual array. The old extracted-row projection parses both for
// its fragment fields; embedded settings retain their original JSON types.
function projection(json: string, fields: readonly Field[], extracted = false): string {
  return fields
    .map(
      ({ path }, index) =>
        `${extracted ? `json_extract(${json}, '$.${path}')` : `json_quote(json_extract(${json}, '$.${path}'))`} AS field${index}`,
    )
    .join(', ')
}

function shape(row: Row, fields: readonly Field[], extracted = false): Row {
  const result: Row = {}
  fields.forEach(({ path, fragment }, index) => {
    const value = extracted && !fragment ? row[`field${index}`] : parseJson(row[`field${index}`])
    const parts = path.split('.')
    let target = result
    for (const part of parts.slice(0, -1)) target = (target[part] ??= {}) as Row
    target[parts[parts.length - 1]] = value
  })
  return result
}

function bytesInRow(row: Row): number {
  return Object.values(row).reduce<number>(
    (bytes, value) => bytes + (typeof value === 'string' ? Buffer.byteLength(value) : 8),
    0,
  )
}

/**
 * Discover the same IDs as the synchronous GC report, retaining only one
 * projected owner at a time in JS. Distinct IDs and message ownership spill to
 * a disposable database; the authoritative connection is never written to.
 *
 * Row/byte/time limits are cooperative: SQLite's projection and one legacy
 * owner or scalar cannot be preempted. largestRowBytes makes that residual
 * visible without introducing a new persisted-data rejection policy.
 * Embedded json_each pages can reparse/rescan their enclosing legacy JSON in
 * SQLite, so the projected byte target is not a strict native-work time limit.
 */
export async function scanAssetReferences(
  db: DatabaseSync,
  options: AssetReferenceScanOptions,
): Promise<AssetReferenceMarks> {
  let scratch: DatabaseSync | undefined
  let closed = false
  const stats: AssetReferenceScanStats = { rows: 0, bytes: 0, yields: 0, largestRowBytes: 0, referenceCount: 0 }
  let sliceBytes = 0
  let sliceRows = 0
  let sliceStart = performance.now()

  const checkpoint = (): void => {
    options.signal?.throwIfAborted()
    options.checkpoint?.()
  }
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    try {
      scratch?.close()
    } finally {
      await Promise.all(
        ['', '-journal', '-wal', '-shm'].map((suffix) => rm(`${options.scratchPath}${suffix}`, { force: true })),
      )
    }
  }
  const yieldSlice = async (): Promise<void> => {
    checkpoint()
    stats.yields++
    await options.onYield?.()
    await setImmediate()
    checkpoint()
    sliceBytes = 0
    sliceRows = 0
    sliceStart = performance.now()
  }
  const needsYield = (): boolean =>
    sliceRows >= ASSET_REFERENCE_SCAN_ROWS ||
    sliceBytes >= ASSET_REFERENCE_SCAN_BYTES ||
    performance.now() - sliceStart >= ASSET_REFERENCE_SCAN_SLICE_MS

  // Finalize every primary iterator before awaiting. Text cursors round-trip
  // the entire signed SQLite integer range, including negative legacy rowids.
  const scanRows = async (query: Query, visit: (row: Row) => void): Promise<void> => {
    const columns = query.keys.map((key, index) => `CAST(${key} AS TEXT) AS cursor${index}`).join(', ')
    const base = `SELECT ${columns}, ${query.columns} FROM ${query.from}`
    const order = `ORDER BY ${query.keys.join(', ')} LIMIT ${ASSET_REFERENCE_SCAN_ROWS}`
    const first = db.prepare(`${base} ${query.where ? `WHERE ${query.where}` : ''} ${order}`)
    const comparison =
      query.keys.length === 1
        ? `${query.keys[0]} > CAST(? AS INTEGER)`
        : `(${query.keys.join(', ')}) > (${query.keys.map(() => 'CAST(? AS INTEGER)').join(', ')})`
    const next = db.prepare(`${base} WHERE ${query.where ? `(${query.where}) AND ` : ''}${comparison} ${order}`)
    let cursor: SQLInputValue[] | undefined
    while (true) {
      checkpoint()
      let count = 0
      const rows = cursor ? next.iterate(...(query.args ?? []), ...cursor) : first.iterate(...(query.args ?? []))
      for (const row of rows) {
        const size = bytesInRow(row)
        stats.rows++
        stats.bytes += size
        stats.largestRowBytes = Math.max(stats.largestRowBytes, size)
        sliceRows++
        sliceBytes += size
        cursor = query.keys.map((_, index) => row[`cursor${index}`] as string)
        count++
        visit(row)
        if (needsYield()) break
      }
      // for-of's IteratorClose releases the SELECT even when a slice ends
      // before LIMIT. There is no primary transaction across this await.
      if (needsYield()) await yieldSlice()
      if (count === 0) break
    }
  }

  try {
    // Fixed-name recovery removes the previous interrupted scan under the
    // caller's lease, rather than accumulating crash artifacts per attempt.
    await Promise.all(
      ['', '-journal', '-wal', '-shm'].map((suffix) => rm(`${options.scratchPath}${suffix}`, { force: true })),
    )
    checkpoint()
    scratch = new DatabaseSync(options.scratchPath)
    scratch.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA cache_size = -2048;
      PRAGMA mmap_size = 0;
      CREATE TABLE references_found (id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE authoritative_chats (id TEXT PRIMARY KEY) WITHOUT ROWID;
    `)
    const insertReference = scratch.prepare('INSERT OR IGNORE INTO references_found (id) VALUES (?)')
    const insertChat = scratch.prepare('INSERT OR IGNORE INTO authoritative_chats (id) VALUES (?)')
    const mark = (database: unknown, extra: readonly RisuSaveAssetReferenceSource[] = []): void => {
      for (const reference of buildRisuSaveAssetReport(database, [], extra).referenced) {
        stats.referenceCount += Number(insertReference.run(reference.id).changes)
      }
    }
    const markInlay = (value: unknown): void => mark({}, collectInlayAssetReferenceSources(value, 'scan'))
    const hasRows = (table: string): boolean => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined

    let hasSettings = false
    await scanRows(
      {
        from: 'settings',
        keys: ['settings.rowid'],
        where: 'id = 1',
        columns: `json_type(data_json) AS rootType, ${projection('data_json', settingsFields)}`,
      },
      (row) => {
        hasSettings = row.rootType === 'object'
        if (hasSettings) mark(shape(row, settingsFields))
      },
    )

    if (hasSettings) {
      for (const collection of [...collectionOwners, { owner: 'characterOrder', table: '', field: 'img' }]) {
        const fields =
          collection.owner === 'characterOrder'
            ? [{ path: 'img' }, { path: 'imgFile' }]
            : [{ path: collection.field, fragment: 'fragment' in collection && collection.fragment === true }]
        const extracted = !!collection.table && hasRows(collection.table)
        await scanRows(
          extracted
            ? {
                from: collection.table,
                keys: ['rowid'],
                columns: projection('data_json', fields, true),
              }
            : {
                from: `settings, json_each(settings.data_json, '$.${collection.owner}') AS owner`,
                keys: ['CAST(owner.key AS INTEGER)'],
                where: `settings.id = 1 AND json_type(settings.data_json, '$.${collection.owner}') = 'array' AND owner.type = 'object'`,
                columns: projection("CASE WHEN owner.type = 'object' THEN owner.value END", fields),
              },
          (row) => mark({ [collection.owner]: [shape(row, fields, extracted)] }),
        )
      }

      if (hasRows('plugin_custom_storage')) {
        await scanRows({ from: 'plugin_custom_storage', keys: ['rowid'], columns: 'key, value_json' }, (row) => {
          // The compatibility loader assigns into {}, so __proto__ is not an
          // enumerable storage entry. Preserve its existing discovery policy.
          if (row.key !== '__proto__') mark({ pluginCustomStorage: parseJson(row.value_json) })
        })
      } else {
        await scanRows(
          {
            from: 'settings',
            keys: ['rowid'],
            where: 'id = 1',
            columns: "json_quote(json_extract(data_json, '$.pluginCustomStorage')) AS storage",
          },
          (row) => mark({ pluginCustomStorage: parseJson(row.storage) }),
        )
      }

      const extractedCharacters = hasRows('characters')
      await scanRows(
        extractedCharacters
          ? {
              from: 'characters',
              keys: ['rowid'],
              columns: projection('data_json', characterFields, true),
            }
          : {
              from: "settings, json_each(settings.data_json, '$.characters') AS owner",
              keys: ['CAST(owner.key AS INTEGER)'],
              where:
                "settings.id = 1 AND json_type(settings.data_json, '$.characters') = 'array' AND owner.type = 'object'",
              columns: projection("CASE WHEN owner.type = 'object' THEN owner.value END", characterFields),
            },
        (row) => mark({ characters: [shape(row, characterFields, extractedCharacters)] }),
      )

      // Keep IDs and embedded message fields scoped to the authoritative chat
      // projection. data_json.id aliases deliberately override the SQL row id.
      const embeddedCharacters = "settings, json_each(settings.data_json, '$.characters') AS owner"
      const characterJson = "CASE WHEN owner.type = 'object' THEN owner.value END"
      const embeddedChats = `${embeddedCharacters}, json_each(${characterJson}, '$.chats') AS chat`
      const chatJson = "CASE WHEN chat.type = 'object' THEN chat.value END"
      const embeddedWhere = `settings.id = 1 AND json_type(settings.data_json, '$.characters') = 'array' AND owner.type = 'object'
        AND json_type(${characterJson}, '$.chats') = 'array' AND chat.type = 'object'`
      const chatQuery: Query = extractedCharacters
        ? {
            from: 'chats',
            keys: ['chats.rowid'],
            where: 'EXISTS (SELECT 1 FROM characters WHERE characters.id = chats.character_id)',
            columns: "id, json_extract(data_json, '$.id') AS dataId",
          }
        : {
            from: embeddedChats,
            keys: ['CAST(owner.key AS INTEGER)', 'CAST(chat.key AS INTEGER)'],
            where: embeddedWhere,
            columns: `NULL AS id, CASE WHEN json_type(${chatJson}, '$.id') = 'text' THEN json_extract(${chatJson}, '$.id') END AS dataId`,
          }
      await scanRows(chatQuery, (row) => {
        const id = typeof row.dataId === 'string' ? row.dataId : row.id
        if (typeof id === 'string') insertChat.run(id)
      })
      const messageValue = "json_extract(chats.data_json, '$.message')"
      const extractedMessages = `CASE
        WHEN json_type(chats.data_json, '$.message') = 'array' THEN ${messageValue}
        WHEN json_type(chats.data_json, '$.message') = 'text' THEN
          CASE WHEN json_valid(${messageValue}) THEN
            CASE WHEN json_type(${messageValue}) = 'array' THEN ${messageValue} END
          END
        END`
      const embeddedMessages = `CASE WHEN json_type(${chatJson}, '$.message') = 'array' THEN json_extract(${chatJson}, '$.message') END`
      await scanRows(
        {
          ...chatQuery,
          from: `${chatQuery.from}, json_each(${extractedCharacters ? extractedMessages : embeddedMessages}) AS message`,
          keys: [...chatQuery.keys, 'message.id'],
          columns: `CASE WHEN message.type = 'object' THEN
            CASE WHEN json_type(message.value, '$.data') = 'text' THEN json_extract(message.value, '$.data') END
            END AS data`,
        },
        (row) => markInlay(row.data),
      )

      // Query each authoritative chat through messages' (chat_id, seq) index.
      // No orphan message data or messages.json payload crosses into JS.
      const chatPages = scratch.prepare('SELECT id FROM authoritative_chats WHERE id > ? ORDER BY id LIMIT 64')
      const firstChatPage = scratch.prepare('SELECT id FROM authoritative_chats ORDER BY id LIMIT 64')
      let chatCursor: string | undefined
      while (true) {
        checkpoint()
        const chats = (chatCursor === undefined ? firstChatPage.all() : chatPages.all(chatCursor)) as Array<{
          id: string
        }>
        if (chats.length === 0) break
        for (const chat of chats) {
          await scanRows(
            { from: 'messages', keys: ['seq'], where: 'chat_id = ?', args: [chat.id], columns: 'data' },
            (row) => markInlay(row.data),
          )
          chatCursor = chat.id
        }
        await yieldSlice()
      }
    }

    // Dependencies outlive module edits/deletion. Scan their compact retained
    // asset index instead of repeatedly hydrating every accepted operation.
    await scanRows(
      {
        from: 'generation_configuration_dependencies AS dependency, json_each(dependency.asset_ids_json) AS asset',
        keys: ['dependency.rowid', 'asset.id'],
        columns: 'asset.value AS asset_id',
      },
      (row) => mark({}, [{ value: row.asset_id, path: 'acceptedConfiguration' }]),
    )
    await scanRows(
      {
        from: 'generation_operations',
        keys: ['rowid'],
        where: "json_extract(effective_configuration_json, '$.version') = 1",
        columns: "json_extract(effective_configuration_json, '$.database') AS database_json",
      },
      (row) => mark(parseJson(row.database_json)),
    )

    await scanRows({ from: 'inlay_catalog', keys: ['rowid'], columns: 'asset_id' }, (row) =>
      mark({}, [{ value: row.asset_id, path: 'inlayCatalog' }]),
    )
    await scanRows(
      {
        from: 'generation_finalization_retries',
        keys: ['rowid'],
        where: "status = 'pending'",
        columns: "json_extract(message_json, '$.data') AS data",
      },
      (row) => markInlay(row.data),
    )
    await scanRows(
      {
        from: 'generation_finalization_retries AS retries, json_each(retries.alternate_messages_json) AS alternate',
        keys: ['retries.rowid', 'alternate.id'],
        where: "retries.status = 'pending'",
        columns: "CASE WHEN alternate.type = 'object' THEN json_extract(alternate.value, '$.data') END AS data",
      },
      (row) => markInlay(row.data),
    )
    checkpoint()

    const hasReference = scratch.prepare('SELECT 1 FROM references_found WHERE id = ?')
    const references = scratch.prepare('SELECT id FROM references_found WHERE id > ? ORDER BY id LIMIT 64')
    const assertOpen = (): void => {
      if (closed) throw new Error('Asset reference marks are closed')
    }
    return {
      stats,
      has(id) {
        assertOpen()
        return hasReference.get(id) !== undefined
      },
      async *referencePages() {
        try {
          assertOpen()
          let cursor = ''
          while (true) {
            checkpoint()
            const rows = references.all(cursor) as Array<{ id: string }>
            if (rows.length === 0) return
            cursor = rows[rows.length - 1].id
            yield rows.map((row) => row.id)
            assertOpen()
            await yieldSlice()
          }
        } catch (error) {
          await close()
          throw error
        }
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
