import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAssetGcRisuSaveAssetReport, runAssetGc } from '../src/assetGc.js'
import {
  assetsDir,
  getAllAssetMetadata,
  deleteInlayCatalogEntry,
  insertAssetMetadataBatch,
  loadPersistedWithMessages,
  writePersistedWithMessages,
  upsertInlayCatalogEntry,
  type PersistedAsset,
} from '../src/repository.js'
import { openDatabase } from '../src/db.js'
import {
  enqueueGenerationFinalizationRetry,
  markGenerationFinalizationRetryFailure,
} from '../src/generationFinalizationRetry.js'
import { replaceAllChatMessages } from '../src/messageStore.js'
import { buildRepositoryRisuSaveAssetReport, buildRisuSaveAssetReport } from '../src/risuSave/assetReferences.js'
import { CORPUS_TABLES, assertScopedLoadOnHotPath } from './helpers/loadCostHarness.js'

const REFERENCED = 'a'.repeat(64)
const SHARED = 'b'.repeat(64)
const ORPHAN_OLD = 'c'.repeat(64)
const ORPHAN_FRESH = 'd'.repeat(64)
const STRAY_OLD = 'e'.repeat(64)
const SETTINGS_REF = '1'.repeat(64)
const COLLECTION_REF = '2'.repeat(64)
const CHARACTER_REF = '3'.repeat(64)
const CHAT_ROW_REF = '4'.repeat(64)
const MESSAGE_REF = '5'.repeat(64)
const NOTIFICATION_IMAGE_REF = '6'.repeat(64)
const PENDING_MESSAGE_REF = '06'.repeat(32)
const PENDING_ALTERNATE_REF = '07'.repeat(32)

const GRACE_MS = 60 * 60_000
const NOW = 10_000_000_000
const OLD_MTIME = NOW - GRACE_MS - 60_000
const FRESH_MTIME = NOW - 60_000

function asset(id: string): PersistedAsset {
  return { id, ext: 'png', size: 1, contentType: 'image/png' }
}

let dataDir: string
let db: DatabaseSync

function writeAssetFile(id: string, mtimeMs: number): string {
  const dir = assetsDir(dataDir)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.png`)
  writeFileSync(file, Buffer.from([1, 2, 3]))
  const secs = mtimeMs / 1000
  utimesSync(file, secs, secs)
  return file
}

function seedDatabase(database: unknown, assets: PersistedAsset[]): void {
  writePersistedWithMessages(db, dataDir, { _version: 1, database, assets: [] })
  insertAssetMetadataBatch(db, assets)
}

function embedChatRowMessage(chatId: string, messageData: string): void {
  const row = db.prepare('SELECT data_json FROM chats WHERE id = ?').get(chatId) as { data_json: string } | undefined
  if (!row) throw new Error(`missing chat row ${chatId}`)
  const chat = JSON.parse(row.data_json) as Record<string, unknown>
  chat.message = [{ chatId: `${chatId}-embedded-message`, role: 'user', data: messageData }]
  db.prepare('UPDATE chats SET data_json = ? WHERE id = ?').run(JSON.stringify(chat), chatId)
}

async function runGcAndExpectReferencesSurvive(referenceIds: readonly string[]): Promise<void> {
  const referencedFiles = referenceIds.map((id) => writeAssetFile(id, OLD_MTIME))
  const orphanFile = writeAssetFile(ORPHAN_OLD, OLD_MTIME)

  const result = await runAssetGc(dataDir, { db, graceMs: GRACE_MS, now: () => NOW })

  expect(result.deletedAssetIds).toEqual([ORPHAN_OLD])
  for (const file of referencedFiles) expect(existsSync(file)).toBe(true)
  expect(existsSync(orphanFile)).toBe(false)
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'risu-asset-gc-'))
  db = openDatabase(dataDir)
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('runAssetGc', () => {
  it('reclaims only orphaned assets past the grace window and keeps referenced plus shared assets', async () => {
    const database = {
      characters: [
        { chaId: 'char-a', image: REFERENCED, emotionImages: [['happy', SHARED]] },
        { chaId: 'char-b', image: SHARED },
      ],
    }
    seedDatabase(database, [asset(REFERENCED), asset(SHARED), asset(ORPHAN_OLD)])
    const refFile = writeAssetFile(REFERENCED, OLD_MTIME)
    const sharedFile = writeAssetFile(SHARED, OLD_MTIME)
    const orphanOldFile = writeAssetFile(ORPHAN_OLD, OLD_MTIME)

    const result = await runAssetGc(dataDir, { db, graceMs: GRACE_MS, now: () => NOW })

    expect(result.deletedAssetIds).toEqual([ORPHAN_OLD])
    expect(result.skippedByGrace).toBe(0)
    expect(existsSync(orphanOldFile)).toBe(false)

    expect(existsSync(refFile)).toBe(true)
    expect(existsSync(sharedFile)).toBe(true)

    expect(
      getAllAssetMetadata(db)
        .map((a) => a.id)
        .sort(),
    ).toEqual([REFERENCED, SHARED].sort())
  })

  it('defers old orphan reclamation while uploads are active and converges after quiescence', async () => {
    seedDatabase({ characters: [{ chaId: 'char-a', image: REFERENCED }] }, [asset(REFERENCED), asset(ORPHAN_OLD)])
    const recentReferencedFile = writeAssetFile(REFERENCED, FRESH_MTIME)
    const oldStagedFile = writeAssetFile(ORPHAN_OLD, OLD_MTIME)

    const active = await runAssetGc(dataDir, { db, graceMs: GRACE_MS, now: () => NOW })

    expect(active.deletedAssetIds).toEqual([])
    expect(active.skippedByGrace).toBe(1)
    expect(existsSync(oldStagedFile)).toBe(true)

    const idle = await runAssetGc(dataDir, {
      db,
      graceMs: GRACE_MS,
      now: () => NOW + GRACE_MS + 60_000,
    })
    expect(idle.deletedAssetIds).toEqual([ORPHAN_OLD])
    expect(existsSync(oldStagedFile)).toBe(false)
    expect(existsSync(recentReferencedFile)).toBe(true)
  })

  it('never deletes a just-uploaded (within-grace) asset even if not yet referenced', async () => {
    seedDatabase({ characters: [] }, [asset(ORPHAN_FRESH)])
    const freshFile = writeAssetFile(ORPHAN_FRESH, FRESH_MTIME)

    const result = await runAssetGc(dataDir, { db, graceMs: GRACE_MS, now: () => NOW })

    expect(result.deletedAssetIds).toEqual([])
    expect(result.skippedByGrace).toBe(1)
    expect(existsSync(freshFile)).toBe(true)
    expect(getAllAssetMetadata(db).map((a) => a.id)).toEqual([ORPHAN_FRESH])
  })

  it('keeps cataloged inlay bytes until catalog deletion makes them collectible', async () => {
    insertAssetMetadataBatch(db, [asset(ORPHAN_OLD)])
    const file = writeAssetFile(ORPHAN_OLD, OLD_MTIME)
    upsertInlayCatalogEntry(db, {
      assetId: ORPHAN_OLD,
      aliases: ['friendly-inlay'],
      name: 'cataloged.png',
      width: 1,
      height: 1,
    })

    expect((await runAssetGc(dataDir, { db, graceMs: GRACE_MS, now: () => NOW })).deletedAssetIds).toEqual([])
    expect(existsSync(file)).toBe(true)

    expect(deleteInlayCatalogEntry(db, ORPHAN_OLD)).toBe(true)
    expect((await runAssetGc(dataDir, { db, graceMs: GRACE_MS, now: () => NOW })).deletedAssetIds).toEqual([ORPHAN_OLD])
    expect(existsSync(file)).toBe(false)
  })

  it('drops a metadata entry whose backing file is already gone', async () => {
    seedDatabase({ characters: [] }, [asset(ORPHAN_OLD)])

    const result = await runAssetGc(dataDir, { db, graceMs: GRACE_MS, now: () => NOW })

    expect(result.deletedAssetIds).toEqual([ORPHAN_OLD])
    expect(getAllAssetMetadata(db)).toEqual([])
  })

  it('sweeps stray, unreferenced, grace-aged files with no metadata entry', async () => {
    seedDatabase({ characters: [] }, [])
    const strayOld = writeAssetFile(STRAY_OLD, OLD_MTIME)

    const result = await runAssetGc(dataDir, { db, graceMs: GRACE_MS, now: () => NOW })

    expect(result.deletedStrayFiles).toEqual([`${STRAY_OLD}.png`])
    expect(existsSync(strayOld)).toBe(false)
  })

  it('is a no-op when nothing is reclaimed', async () => {
    const database = { characters: [{ chaId: 'char-a', image: REFERENCED }] }
    seedDatabase(database, [asset(REFERENCED)])
    writeAssetFile(REFERENCED, OLD_MTIME)

    const result = await runAssetGc(dataDir, { db, graceMs: GRACE_MS, now: () => NOW })

    expect(result.deletedAssetIds).toEqual([])
    expect(result.deletedStrayFiles).toEqual([])
    expect(getAllAssetMetadata(db)).toEqual([asset(REFERENCED)])
  })

  it('never hydrates the message corpus during a sweep', async () => {
    const database = {
      characters: [{ chaId: 'char-a', image: REFERENCED, chats: [{ id: 'chat-a' }] }],
    }
    seedDatabase(database, [asset(REFERENCED), asset(ORPHAN_OLD)])
    writeAssetFile(REFERENCED, OLD_MTIME)
    writeAssetFile(ORPHAN_OLD, OLD_MTIME)
    replaceAllChatMessages(db, [
      {
        chatId: 'chat-a',
        messages: [{ chatId: 'message-a', role: 'user', data: `{{inlay::${SHARED}}}` }],
      },
    ])

    // The sweep may keep its message-free broad walk (that is its union source),
    // but the message/hypa corpus must never hydrate — the inlay references come
    // from the column-only `messages.data` scan.
    const allowEverythingButMessages = Object.keys(CORPUS_TABLES).filter(
      (table) => table !== 'messages' && table !== 'chat_hypa_v3',
    )
    const result = await assertScopedLoadOnHotPath(
      () => runAssetGc(dataDir, { db, graceMs: GRACE_MS, now: () => NOW }),
      { allowTables: allowEverythingButMessages },
    )
    expect(result.deletedAssetIds).toEqual([ORPHAN_OLD])
  })

  it('reports identical referenced/missing/orphaned sets to the hydrated walker', async () => {
    const MISSING = '9'.repeat(64)
    const database = {
      userIcon: REFERENCED,
      characters: [
        {
          chaId: 'char-a',
          image: SHARED,
          chats: [{ id: 'chat-a' }, { id: 'chat-b', message: [{ chatId: 'embedded-1', role: 'user', data: 'plain' }] }],
        },
        { chaId: 'char-b', chats: [{ id: 'chat-c' }] },
      ],
    }
    seedDatabase(database, [asset(REFERENCED), asset(SHARED), asset(ORPHAN_OLD)])
    replaceAllChatMessages(db, [
      {
        chatId: 'chat-a',
        messages: [
          { chatId: 'message-a', role: 'user', data: `one {{inlay::${SHARED}}}` },
          { chatId: 'message-b', role: 'char', data: `two {{inlayed::${MISSING}}}` },
        ],
      },
      {
        chatId: 'chat-c',
        messages: [{ chatId: 'message-c', role: 'user', data: `{{inlayeddata::${REFERENCED}}}` }],
      },
    ])

    const scoped = buildRepositoryRisuSaveAssetReport(dataDir, db)
    const hydrated = buildRisuSaveAssetReport(loadPersistedWithMessages(db, dataDir).database, getAllAssetMetadata(db))
    // Byte-identical report: same ids, same path labels, same counts.
    expect(scoped).toEqual(hydrated)
    expect(scoped.referenced.map((reference) => reference.id)).toContain(SHARED)
    expect(scoped.missing.map((reference) => reference.id)).toEqual([MISSING])
    expect(scoped.orphaned.map((entry) => entry.id)).toEqual([ORPHAN_OLD])
  })

  it('preserves references from settings, collection rows, character rows, chat rows, and messages', async () => {
    const database = {
      userIcon: SETTINGS_REF,
      customBackground: `assets/${SETTINGS_REF}.png`,
      modules: [{ assets: [['module-ref', COLLECTION_REF]] }],
      personas: [{ icon: COLLECTION_REF }],
      botPresets: [{ image: `assets/${COLLECTION_REF}.png` }],
      characters: [
        {
          chaId: 'char-a',
          image: CHARACTER_REF,
          notificationImage: NOTIFICATION_IMAGE_REF,
          emotionImages: [['happy', `assets/${CHARACTER_REF}.png`]],
          additionalAssets: [['sheet', CHARACTER_REF]],
          ccAssets: [{ uri: CHARACTER_REF }],
          vits: { files: { voice: CHARACTER_REF } },
          prebuiltAssetExclude: [CHARACTER_REF],
          gptSoVitsConfig: { ref_audio_data: { assetId: CHARACTER_REF } },
          chats: [
            {
              id: 'chat-a',
              message: [
                {
                  chatId: 'message-a',
                  role: 'user',
                  data: `message table {{inlayeddata::${MESSAGE_REF}}}`,
                },
              ],
            },
          ],
        },
      ],
    }
    seedDatabase(database, [
      asset(SETTINGS_REF),
      asset(COLLECTION_REF),
      asset(CHARACTER_REF),
      asset(NOTIFICATION_IMAGE_REF),
      asset(CHAT_ROW_REF),
      asset(MESSAGE_REF),
      asset(ORPHAN_OLD),
    ])
    embedChatRowMessage('chat-a', `embedded chat row {{inlay::${CHAT_ROW_REF}}}`)
    const referencedFiles = [
      writeAssetFile(SETTINGS_REF, OLD_MTIME),
      writeAssetFile(COLLECTION_REF, OLD_MTIME),
      writeAssetFile(CHARACTER_REF, OLD_MTIME),
      writeAssetFile(NOTIFICATION_IMAGE_REF, OLD_MTIME),
      writeAssetFile(CHAT_ROW_REF, OLD_MTIME),
      writeAssetFile(MESSAGE_REF, OLD_MTIME),
    ]
    const orphanFile = writeAssetFile(ORPHAN_OLD, OLD_MTIME)

    const broad = buildRepositoryRisuSaveAssetReport(dataDir, db)
    const scoped = buildAssetGcRisuSaveAssetReport(db, getAllAssetMetadata(db))

    expect(scoped).toEqual(broad)
    expect(scoped.referenced.map((reference) => reference.id).sort()).toEqual(
      [SETTINGS_REF, COLLECTION_REF, CHARACTER_REF, CHAT_ROW_REF, MESSAGE_REF, NOTIFICATION_IMAGE_REF].sort(),
    )

    const result = await runAssetGc(dataDir, { db, graceMs: GRACE_MS, now: () => NOW })

    expect(result.deletedAssetIds).toEqual([ORPHAN_OLD])
    expect(result.scannedOrphans).toBe(1)
    for (const file of referencedFiles) expect(existsSync(file)).toBe(true)
    expect(existsSync(orphanFile)).toBe(false)
  })

  it('keeps assets referenced only by SQLite chat-message inlay tokens', async () => {
    const database = { characters: [{ chaId: 'char-a', chats: [{ id: 'chat-a' }] }] }
    seedDatabase(database, [asset(REFERENCED), asset(ORPHAN_OLD)])
    const referencedFile = writeAssetFile(REFERENCED, OLD_MTIME)
    const orphanFile = writeAssetFile(ORPHAN_OLD, OLD_MTIME)
    replaceAllChatMessages(db, [
      {
        chatId: 'chat-a',
        messages: [
          {
            chatId: 'message-a',
            role: 'user',
            data: `look {{inlayeddata::${REFERENCED}}}`,
          },
        ],
      },
    ])

    const result = await runAssetGc(dataDir, { db, graceMs: GRACE_MS, now: () => NOW })

    expect(result.deletedAssetIds).toEqual([ORPHAN_OLD])
    expect(existsSync(referencedFile)).toBe(true)
    expect(existsSync(orphanFile)).toBe(false)
  })

  it('keeps inlays referenced only by pending generation-finalization payloads', async () => {
    seedDatabase({ characters: [] }, [asset(PENDING_MESSAGE_REF), asset(PENDING_ALTERNATE_REF), asset(ORPHAN_OLD)])
    enqueueGenerationFinalizationRetry(db, {
      generationId: 'generation-a',
      chatId: 'chat-a',
      mode: 'send',
      message: {
        chatId: 'pending-message',
        role: 'char',
        data: `pending {{inlay::${PENDING_MESSAGE_REF}}}`,
      } as never,
      alternateMessages: [
        {
          chatId: 'pending-alternate',
          role: 'char',
          data: `pending alternate {{inlayeddata::${PENDING_ALTERNATE_REF}}}`,
        } as never,
      ],
      chatVarMutations: [],
    })
    enqueueGenerationFinalizationRetry(db, {
      generationId: 'generation-terminal',
      chatId: 'chat-a',
      mode: 'send',
      message: {
        chatId: 'terminal-message',
        role: 'char',
        data: `terminal {{inlay::${ORPHAN_OLD}}}`,
      } as never,
      chatVarMutations: [],
    })
    markGenerationFinalizationRetryFailure(db, 'generation-terminal', 'terminal fixture', true)

    await runGcAndExpectReferencesSurvive([PENDING_MESSAGE_REF, PENDING_ALTERNATE_REF])
  })
})
