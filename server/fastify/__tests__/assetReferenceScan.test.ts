import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAssetGcRisuSaveAssetReport } from '../src/assetGc.js'
import {
  ASSET_REFERENCE_SCAN_BYTES,
  ASSET_REFERENCE_SCAN_ROWS,
  scanAssetReferences,
  type AssetReferenceMarks,
} from '../src/assetReferenceScan.js'
import { openDatabase } from '../src/db.js'
import { CHARACTER_TEXT_INLAY_FIELDS } from '../src/risuSave/assetOwnerCatalog.js'

let dataDir: string
let scratchPath: string
let db: DatabaseSync
const openMarks: AssetReferenceMarks[] = []
const id = (value: number): string => value.toString(16).padStart(64, '0')
const inlay = (value: number): string => `{{inlay::${id(value)}}}`

function settings(value: unknown): void {
  db.prepare('INSERT OR REPLACE INTO settings (id, data_json) VALUES (1, ?)').run(JSON.stringify(value))
}

function character(characterId: string, value: unknown, rowid = 1): void {
  db.prepare('INSERT INTO characters (rowid, id, position, data_json) VALUES (?, ?, ?, ?)').run(
    rowid,
    characterId,
    rowid,
    JSON.stringify(value),
  )
}

function chat(chatId: string, characterId: string, value: unknown, rowid = 1): void {
  db.prepare('INSERT INTO chats (rowid, id, character_id, position, data_json) VALUES (?, ?, ?, ?, ?)').run(
    rowid,
    chatId,
    characterId,
    rowid,
    JSON.stringify(value),
  )
}

function message(chatId: string, value: number, alternate = 0, seq = 0): void {
  db.prepare('INSERT INTO messages (chat_id, seq, uid, role, data, json, alternate) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    chatId,
    seq,
    `message-${value}`,
    'char',
    inlay(value),
    JSON.stringify({ unrelated: id(999) }),
    alternate,
  )
}

function retry(value: number, alternate: unknown, status = 'pending'): void {
  db.prepare(
    `INSERT INTO generation_finalization_retries
    (generation_id, chat_id, mode, message_json, alternate_messages_json, chat_var_mutations_json, status)
    VALUES (?, 'unowned-chat', 'send', ?, ?, '{}', ?)`,
  ).run(
    `generation-${value}`,
    JSON.stringify({ data: inlay(value), arbitrary: id(999) }),
    JSON.stringify(alternate),
    status,
  )
}

async function collect(marks: AssetReferenceMarks): Promise<string[]> {
  const found: string[] = []
  for await (const page of marks.referencePages()) {
    expect(page.length).toBeLessThanOrEqual(ASSET_REFERENCE_SCAN_ROWS)
    found.push(...page)
  }
  return found.sort()
}

async function parity(expected: readonly string[]): Promise<AssetReferenceMarks> {
  const synchronous = buildAssetGcRisuSaveAssetReport(db, [])
    .referenced.map((reference) => reference.id)
    .sort()
  expect(synchronous).toEqual([...expected].sort())
  const marks = await scanAssetReferences(db, { scratchPath })
  openMarks.push(marks)
  expect(await collect(marks)).toEqual(synchronous)
  expect(marks.stats.referenceCount).toBe(expected.length)
  for (const reference of expected) expect(marks.has(reference)).toBe(true)
  expect(marks.has(id(999))).toBe(false)
  return marks
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'risu-reference-scan-'))
  scratchPath = path.join(dataDir, '.maintenance-reference-scan.sqlite')
  db = openDatabase(dataDir)
})

afterEach(async () => {
  for (const marks of openMarks.splice(0)) await marks.close()
  vi.restoreAllMocks()
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('scanAssetReferences', () => {
  it('matches every current reference owner and ignores arbitrary JSON outside plugin storage', async () => {
    settings({
      userIcon: id(1),
      customBackground: `assets/${id(2)}.png`,
      NAIImgConfig: { image: id(3), character_image: id(4), unknown: id(999) },
      wavespeedImage: { reference_image: id(5) },
      characterOrder: [{ img: id(6), imgFile: id(7), unknown: id(999) }],
      modules: [{ assets: [['icon', id(8)]], lore: id(999) }],
      personas: [{ icon: id(9) }],
      botPresets: [{ image: id(10) }],
      modelPresets: [{ image: id(11) }],
      promptPresets: [{ image: id(12) }],
      pluginCustomStorage: { nested: [id(13), { path: `assets/${id(14)}.onnx` }] },
      unrelated: { image: id(999), text: inlay(999) },
      loreBook: [{ content: inlay(999) }],
    })
    character('character', {
      image: id(15),
      notificationImage: id(16),
      emotionImages: [['happy', id(17)]],
      additionalAssets: [['audio', id(18), 'wav']],
      ccAssets: [{ uri: id(19) }],
      vits: { files: { model: id(20) }, unrelated: id(999) },
      prebuiltAssetExclude: [id(21)],
      gptSoVitsConfig: { ref_audio_data: { assetId: id(22) }, unknown: id(999) },
      alternateGreetings: [inlay(23)],
      ...Object.fromEntries(CHARACTER_TEXT_INLAY_FIELDS.map((field, index) => [field, inlay(24 + index)])),
      lore: [{ content: inlay(999) }],
      unrelated: { image: id(999) },
    })
    chat('chat', 'character', { id: 'chat', message: [{ data: inlay(33), arbitrary: id(999) }], note: inlay(999) })
    message('chat', 34)
    message('chat', 35, 1, 1)
    retry(36, [{ data: `{{inlayed::${id(37)}}}` }, { data: `{{inlayeddata::assets/${id(38)}.wav}}` }])
    db.prepare('INSERT INTO assets (id, ext, size, content_type) VALUES (?, ?, ?, ?)').run(
      id(39),
      'png',
      1,
      'image/png',
    )
    db.prepare('INSERT INTO inlay_catalog (asset_id, name, aliases_json) VALUES (?, ?, ?)').run(id(39), 'catalog', '[]')
    retry(999, [{ data: inlay(999) }], 'terminal')
    await parity(Array.from({ length: 39 }, (_, index) => id(index + 1)))
  })

  it('gives extracted collections, characters, chats and plugin rows precedence over embedded copies', async () => {
    settings({
      modules: [{ assets: [['old', id(999)]] }],
      personas: [{ icon: id(999) }],
      botPresets: [{ image: id(999) }],
      modelPresets: [{ image: id(999) }],
      promptPresets: [{ image: id(999) }],
      pluginCustomStorage: { old: id(999) },
      characters: [{ image: id(999), chats: [{ id: 'old-chat', message: [{ data: inlay(999) }] }] }],
    })
    for (const [table, payload] of [
      ['modules', { assets: [['new', id(1)]], arbitrary: id(999) }],
      ['personas', { icon: id(2) }],
      ['bot_presets', { image: id(3) }],
      ['model_presets', { image: id(4) }],
      ['prompt_presets', { image: id(5) }],
    ] as const)
      db.prepare(`INSERT INTO ${table} (position, data_json) VALUES (-9, ?)`).run(JSON.stringify(payload))
    db.prepare('INSERT INTO plugin_custom_storage (key, value_json) VALUES (?, ?)').run(
      'key',
      JSON.stringify({ deep: [id(6)] }),
    )
    character('new-character', { image: id(7), chats: [{ id: 'ignored', message: [{ data: inlay(999) }] }] }, -10)
    chat('new-chat', 'new-character', { message: [{ data: inlay(8) }] }, -11)
    message('new-chat', 9)
    message('old-chat', 999)
    await parity(Array.from({ length: 9 }, (_, index) => id(index + 1)))
  })

  it('retains embedded legacy character/chat IDs and their active and alternate table messages', async () => {
    settings({
      characters: [
        null,
        'ignored',
        {
          image: id(1),
          chats: [null, 'ignored', { id: 'legacy-chat', message: [{ data: inlay(2) }] }],
        },
        {
          chats: [
            { id: 'legacy-chat' },
            { id: 3, message: [{ data: inlay(3) }] },
            { id: [], message: [{ data: [inlay(999)] }] },
          ],
        },
      ],
    })
    message('legacy-chat', 4)
    message('legacy-chat', 5, 1, 1)
    message('3', 999)
    message('[]', 999)
    await parity([1, 2, 3, 4, 5].map(id))
  })

  it('uses chat data IDs as aliases and excludes unowned rows and stale SQL IDs', async () => {
    settings({})
    character('character', {})
    chat('row-id', 'character', { id: 'alias' })
    chat('fallback', 'character', { id: 123 }, 2)
    message('alias', 1)
    message('alias', 2, 1, 1)
    message('fallback', 3)
    message('row-id', 999)
    message('orphan', 999)
    db.exec('PRAGMA foreign_keys = OFF')
    chat('orphan', 'missing-character', { id: 'orphan', message: [{ data: inlay(999) }] }, 3)
    await parity([1, 2, 3].map(id))
  })

  it('round-trips the full signed rowid range in source keysets', async () => {
    settings({})
    const insert = db.prepare('INSERT INTO modules (position, data_json) VALUES (?, ?)')
    insert.run(-9223372036854775808n, JSON.stringify({ assets: [['first', id(1)]] }))
    insert.run(9223372036854775807n, JSON.stringify({ assets: [['last', id(2)]] }))
    await parity([id(1), id(2)])
  })

  it.each([undefined, null, [], 'settings-string'])(
    'keeps operational references without object settings (%j)',
    async (value) => {
      if (value !== undefined) settings(value)
      character('ignored-character', { image: id(999) })
      db.prepare('INSERT INTO plugin_custom_storage (key, value_json) VALUES (?, ?)').run(
        'ignored',
        JSON.stringify(id(999)),
      )
      retry(1, { first: { data: inlay(2) }, ignored: inlay(999), ignoredArray: [{ data: inlay(999) }] })
      db.prepare('INSERT INTO assets (id, ext, size, content_type) VALUES (?, ?, ?, ?)').run(
        id(3),
        'png',
        1,
        'image/png',
      )
      db.prepare('INSERT INTO inlay_catalog (asset_id, name, aliases_json) VALUES (?, ?, ?)').run(
        id(3),
        'catalog',
        '[]',
      )
      await parity([1, 2, 3].map(id))
    },
  )

  it('preserves malformed field types, extracted JSON fragments and existing ID/path validation', async () => {
    const uppercasePathId = 'AB'.repeat(32)
    settings({
      userIcon: uppercasePathId,
      customBackground: `assets/${uppercasePathId}.PNG`,
      personas: JSON.stringify([{ icon: id(999) }]),
      modules: [{ assets: 'not-json' }],
      pluginCustomStorage: { invalid: [`ASSETS/${id(999)}.png`, `assets/${id(999)}.bad-ext`, inlay(999)] },
    })
    character('character', {
      emotionImages: JSON.stringify([['legacy', id(1)]]),
      ccAssets: JSON.stringify([{ uri: id(2) }]),
      vits: { files: JSON.stringify({ model: id(3) }) },
      alternateGreetings: JSON.stringify([inlay(4)]),
      additionalAssets: 'not-json',
      prebuiltAssetExclude: {},
      firstMessage: [inlay(6)],
    })
    chat('chat', 'character', { message: JSON.stringify([{ data: inlay(5) }]) })
    await parity([uppercasePathId, ...[1, 2, 3, 4, 5, 6].map(id)])
  })

  it('fails closed on invalid persisted JSON and removes scratch state', async () => {
    settings({})
    db.exec('PRAGMA ignore_check_constraints = ON')
    db.prepare('UPDATE settings SET data_json = ?').run('{broken')
    await expect(scanAssetReferences(db, { scratchPath })).rejects.toThrow()
    expect(existsSync(scratchPath)).toBe(false)
  })

  it('makes bounded multi-page progress without primary writes or full unrelated JSON projections', async () => {
    settings({ unrelated: 'x'.repeat(ASSET_REFERENCE_SCAN_BYTES * 3) })
    const insert = db.prepare('INSERT INTO modules (position, data_json) VALUES (?, ?)')
    for (let index = 0; index < 150; index++) {
      insert.run(index - 75, JSON.stringify({ assets: [['ref', id(index + 1)]], lore: 'x'.repeat(8192) }))
    }
    character('character', { lore: 'x'.repeat(ASSET_REFERENCE_SCAN_BYTES * 3) })
    chat('chat', 'character', {
      message: [{ data: inlay(151), unrelated: 'x'.repeat(ASSET_REFERENCE_SCAN_BYTES * 3) }, { data: [inlay(999)] }],
    })
    const before = db.prepare('SELECT total_changes() AS changes').get()
    const pragmas = ['temp_store', 'cache_size', 'mmap_size'].map((pragma) => db.prepare(`PRAGMA ${pragma}`).get())
    const queries: string[] = []
    const prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((query) => {
      queries.push(query)
      return prepare(query)
    })
    let progressed = false
    setImmediate(() => {
      progressed = true
    })
    const marks = await scanAssetReferences(db, {
      scratchPath,
      onYield() {
        expect(db.isTransaction).toBe(false)
      },
    })
    openMarks.push(marks)
    expect(progressed).toBe(true)
    expect(marks.stats.yields).toBeGreaterThanOrEqual(2)
    expect(marks.stats.referenceCount).toBe(151)
    expect(marks.stats.largestRowBytes).toBeLessThan(4096)
    expect(marks.stats.bytes).toBeLessThan(ASSET_REFERENCE_SCAN_BYTES)
    expect(await collect(marks)).toEqual(Array.from({ length: 151 }, (_, index) => id(index + 1)))
    expect(prepare('SELECT total_changes() AS changes').get()).toEqual(before)
    expect(['temp_store', 'cache_size', 'mmap_size'].map((pragma) => prepare(`PRAGMA ${pragma}`).get())).toEqual(
      pragmas,
    )
    expect(
      queries.filter((query) => query.includes(' AS cursor0, ')).every((query) => query.includes('LIMIT 64')),
    ).toBe(true)
    expect(queries.some((query) => /\bOFFSET\b/i.test(query))).toBe(false)
    expect(queries.some((query) => /SELECT data_json\b/.test(query))).toBe(false)
  })

  it('retains nested legacy references and deduplicates shared IDs across source pages', async () => {
    const messagesPerChat = ASSET_REFERENCE_SCAN_ROWS + 1
    const sharedId = id(500)
    const characters = Array.from({ length: 2 }, (_, characterIndex) => ({
      image: sharedId,
      chats: Array.from({ length: 2 }, (_, chatIndex) => ({
        id: `legacy-${characterIndex}-${chatIndex}`,
        message: Array.from({ length: messagesPerChat }, (_, messageIndex) => ({
          data: `${inlay(1000 + (characterIndex * 2 + chatIndex) * messagesPerChat + messageIndex)} {{inlay::${sharedId}}}`,
        })),
      })),
    }))
    settings({ userIcon: sharedId, characters })
    message('legacy-1-1', 501)
    message('legacy-1-1', 502, 1, 1)
    const rawSettings = db.prepare('SELECT data_json FROM settings WHERE id = 1').get()
    const before = db.prepare('SELECT total_changes() AS changes').get()
    const expected = [
      ...Array.from({ length: 4 * messagesPerChat }, (_, index) => id(1000 + index)),
      sharedId,
      id(501),
      id(502),
    ]

    const marks = await parity(expected)

    expect(marks.stats.yields).toBeGreaterThan(0)
    expect(db.prepare('SELECT data_json FROM settings WHERE id = 1').get()).toEqual(rawSettings)
    expect(db.prepare('SELECT total_changes() AS changes').get()).toEqual(before)
  })

  it('reports and yields after an oversized existing scalar without rejecting it', async () => {
    settings({})
    character('character', { firstMessage: `${'x'.repeat(ASSET_REFERENCE_SCAN_BYTES + 1)}${inlay(1)}` })
    const marks = await parity([id(1)])
    expect(marks.stats.largestRowBytes).toBeGreaterThan(ASSET_REFERENCE_SCAN_BYTES)
    expect(marks.stats.yields).toBeGreaterThan(0)
  })

  it.each(['abort', 'checkpoint'] as const)('cleans up when %s interrupts a yielded source scan', async (failure) => {
    settings({})
    const insert = db.prepare('INSERT INTO modules (position, data_json) VALUES (?, ?)')
    for (let index = 0; index < 100; index++) insert.run(index, JSON.stringify({ assets: [['ref', id(index + 1)]] }))
    const controller = new AbortController()
    const expected = new Error(failure)
    let suspended = false
    await expect(
      scanAssetReferences(db, {
        scratchPath,
        signal: controller.signal,
        checkpoint() {
          if (suspended && failure === 'checkpoint') throw expected
        },
        onYield() {
          suspended = true
          if (failure === 'abort') controller.abort(expected)
        },
      }),
    ).rejects.toBe(expected)
    expect(readdirSync(dataDir).filter((name) => name.startsWith('.maintenance-reference-scan'))).toEqual([])
  })

  it('replaces leftover scratch, closes idempotently, and checks cancellation during reference paging', async () => {
    settings({ userIcon: id(1) })
    writeFileSync(scratchPath, 'interrupted scratch database')
    const controller = new AbortController()
    const marks = await scanAssetReferences(db, { scratchPath, signal: controller.signal })
    openMarks.push(marks)
    const pages = marks.referencePages()[Symbol.asyncIterator]()
    expect(await pages.next()).toMatchObject({ value: [id(1)], done: false })
    const expected = new Error('paging cancelled')
    controller.abort(expected)
    await expect(pages.next()).rejects.toBe(expected)
    expect(existsSync(scratchPath)).toBe(false)
    await marks.close()
    expect(() => marks.has(id(1))).toThrow('closed')
  })
})
