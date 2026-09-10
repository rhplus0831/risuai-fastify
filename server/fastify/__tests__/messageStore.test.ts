import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../src/db.js'
import {
  addAlternateMessage,
  activeMessageIdExistsInChat,
  appendActiveChatMessageTail,
  applyChatMessageDiff,
  clearAlternateMessages,
  countAlternateMessages,
  countChatMessages,
  deleteChatHypaV3,
  deleteChatMessages,
  getAllChatHypaV3Grouped,
  getAllChatIdsWithHypaV3,
  getAllChatIdsWithMessages,
  getAlternateMessages,
  getChatHypaV3,
  getChatMessages,
  getChatMessagesRange,
  getChatMessageDiffInstrumentation,
  resolveActiveMessageLocationById,
  replaceChatMessages,
  resetChatMessageDiffInstrumentation,
  setChatHypaV3,
  updateActiveMessageById,
  deleteActiveMessageById,
} from '../src/messageStore.js'
import {
  ensureDbJsonImported,
  loadPersisted,
  loadPersistedWithMessages,
  writePersistedWithMessages,
  type Persisted,
} from '../src/repository.js'

const dataDirs: string[] = []
const dbs: DatabaseSync[] = []

function makeDataDir(): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-msgstore-'))
  dataDirs.push(dataDir)
  return dataDir
}

function makeDb(dataDir: string): DatabaseSync {
  const db = openDatabase(dataDir)
  dbs.push(db)
  return db
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const dataDir of dataDirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

function msg(uid: string, role: 'user' | 'char', data: string, extra: Record<string, unknown> = {}) {
  return { chatId: uid, role, data, ...extra }
}

describe('messageStore CRUD', () => {
  it('round-trips messages in seq order via the json column', () => {
    const db = makeDb(makeDataDir())
    const messages = [
      msg('m1', 'user', 'hello', { time: 1, name: 'A' }),
      msg('m2', 'char', 'hi there', { generationInfo: { model: 'x' } }),
      msg('m3', 'user', 'bye', { disabled: 'allBefore' }),
    ]
    replaceChatMessages(db, 'chat-1', messages)

    expect(getChatMessages(db, 'chat-1')).toEqual(messages)
    expect(getChatMessagesRange(db, 'chat-1', 1, 1)).toEqual([messages[1]])
    expect(getChatMessagesRange(db, 'chat-1', 1, 10)).toEqual([messages[1], messages[2]])
    expect(countChatMessages(db, 'chat-1')).toBe(3)
    expect(getAllChatIdsWithMessages(db)).toEqual(['chat-1'])
    expect(activeMessageIdExistsInChat(db, 'm2', 'chat-1')).toBe(true)
    expect(activeMessageIdExistsInChat(db, 'm2', 'chat-other')).toBe(false)
  })

  it('keeps a source-valid Draft-hook translation and clears it after the sent text changes', () => {
    const db = makeDb(makeDataDir())
    const data = 'Draft hook output{{inlayed::asset-a}}'
    const translation = {
      text: 'Original composer text',
      source: 'raw',
      sourceHash: createHash('sha256').update(data).digest('hex'),
      targetLanguage: 'original',
      inputLanguage: 'auto',
      translatorType: 'llm',
      settingsHash: 'a'.repeat(64),
      updatedAt: 123,
    }
    replaceChatMessages(db, 'chat-1', [msg('m1', 'user', data, { translation })])

    expect(getChatMessages(db, 'chat-1')).toEqual([msg('m1', 'user', data, { translation })])

    expect(updateActiveMessageById(db, 'm1', { data: 'Edited Draft output' })).toMatchObject({ ok: true })
    expect(getChatMessages(db, 'chat-1')).toEqual([msg('m1', 'user', 'Edited Draft output', { translation: null })])
  })

  it('reads ranges by logical row offset even when stored seq values are sparse', () => {
    const db = makeDb(makeDataDir())
    const messages = [msg('m10', 'user', 'logical 0'), msg('m20', 'char', 'logical 1'), msg('m30', 'user', 'logical 2')]
    replaceChatMessages(db, 'chat-1', messages)
    db.prepare('UPDATE messages SET seq = seq + 10 WHERE chat_id = ? AND alternate = 0').run('chat-1')

    expect(getChatMessages(db, 'chat-1')).toEqual(messages)
    expect(countChatMessages(db, 'chat-1')).toBe(3)
    expect(getChatMessagesRange(db, 'chat-1', 1, 2)).toEqual([messages[1], messages[2]])
  })

  it('replaceChatMessages overwrites only the target chat', () => {
    const db = makeDb(makeDataDir())
    replaceChatMessages(db, 'chat-a', [msg('a1', 'user', 'a')])
    replaceChatMessages(db, 'chat-b', [msg('b1', 'user', 'b'), msg('b2', 'char', 'b2')])

    replaceChatMessages(db, 'chat-a', [msg('a1', 'user', 'a-edited')])

    expect(getChatMessages(db, 'chat-a')).toEqual([msg('a1', 'user', 'a-edited')])
    expect(getChatMessages(db, 'chat-b')).toEqual([msg('b1', 'user', 'b'), msg('b2', 'char', 'b2')])
    expect(getAllChatIdsWithMessages(db).sort()).toEqual(['chat-a', 'chat-b'])
  })

  it('deleteChatMessages clears one chat only', () => {
    const db = makeDb(makeDataDir())
    replaceChatMessages(db, 'chat-a', [msg('a1', 'user', 'a')])
    replaceChatMessages(db, 'chat-b', [msg('b1', 'user', 'b')])

    deleteChatMessages(db, 'chat-a')

    expect(getChatMessages(db, 'chat-a')).toEqual([])
    expect(countChatMessages(db, 'chat-a')).toBe(0)
    expect(getAllChatIdsWithMessages(db)).toEqual(['chat-b'])
  })

  it('replaceChatMessages with an empty array removes all active rows', () => {
    const db = makeDb(makeDataDir())
    replaceChatMessages(db, 'chat-a', [msg('a1', 'user', 'a')])
    replaceChatMessages(db, 'chat-a', [])
    expect(getChatMessages(db, 'chat-a')).toEqual([])
    expect(getAllChatIdsWithMessages(db)).toEqual([])
  })

  it('treats duplicate active message ids as ambiguous instead of mutating an arbitrary row', () => {
    const db = makeDb(makeDataDir())
    replaceChatMessages(db, 'chat-a', [msg('dup', 'user', 'from a')])
    replaceChatMessages(db, 'chat-b', [msg('dup', 'char', 'from b')])

    expect(resolveActiveMessageLocationById(db, 'dup')).toEqual({ ok: false, reason: 'ambiguous' })
    expect(updateActiveMessageById(db, 'dup', { data: 'edited' })).toEqual({ ok: false, reason: 'ambiguous' })
    expect(deleteActiveMessageById(db, 'dup')).toEqual({ ok: false, reason: 'ambiguous' })
    expect(getChatMessages(db, 'chat-a')).toEqual([msg('dup', 'user', 'from a')])
    expect(getChatMessages(db, 'chat-b')).toEqual([msg('dup', 'char', 'from b')])
  })
})

// Reroll buffer candidates never appear in active transcript queries.
describe('reroll-alternate rows', () => {
  it('keeps alternates out of every active query', () => {
    const db = makeDb(makeDataDir())
    replaceChatMessages(db, 'chat-1', [msg('m1', 'user', 'hi'), msg('m2', 'char', 'active')])
    addAlternateMessage(db, 'chat-1', msg('alt1', 'char', 'old candidate'))

    // The active transcript is unchanged by the alternate.
    expect(getChatMessages(db, 'chat-1')).toEqual([msg('m1', 'user', 'hi'), msg('m2', 'char', 'active')])
    expect(countChatMessages(db, 'chat-1')).toBe(2)
    expect(getAllChatIdsWithMessages(db)).toEqual(['chat-1'])
    // The alternate is retrievable via the dedicated buffer queries.
    expect(getAlternateMessages(db, 'chat-1')).toEqual([msg('alt1', 'char', 'old candidate')])
    expect(countAlternateMessages(db, 'chat-1')).toBe(1)
  })

  it('accumulates alternates with unique negative seqs (most-recent first)', () => {
    const db = makeDb(makeDataDir())
    addAlternateMessage(db, 'chat-1', msg('a', 'char', 'first'))
    addAlternateMessage(db, 'chat-1', msg('b', 'char', 'second'))
    addAlternateMessage(db, 'chat-1', msg('c', 'char', 'third'))

    expect(countAlternateMessages(db, 'chat-1')).toBe(3)
    expect(getAlternateMessages(db, 'chat-1').map((m) => m.data)).toEqual(['third', 'second', 'first'])
    const seqs = (
      db.prepare('SELECT seq FROM messages WHERE chat_id = ? AND alternate = 1').all('chat-1') as {
        seq: number
      }[]
    ).map((r) => r.seq)
    expect(seqs.sort((x, y) => x - y)).toEqual([-3, -2, -1])
  })

  it('clears a chat reroll buffer without touching the active transcript', () => {
    const db = makeDb(makeDataDir())
    replaceChatMessages(db, 'chat-1', [msg('m1', 'char', 'active')])
    addAlternateMessage(db, 'chat-1', msg('alt', 'char', 'candidate'))

    clearAlternateMessages(db, 'chat-1')

    expect(getAlternateMessages(db, 'chat-1')).toEqual([])
    expect(countAlternateMessages(db, 'chat-1')).toBe(0)
    expect(getChatMessages(db, 'chat-1')).toEqual([msg('m1', 'char', 'active')])
  })

  it('does not disturb alternates when the active transcript is appended/diffed', () => {
    const db = makeDb(makeDataDir())
    const base = [msg('m1', 'user', 'a')]
    replaceChatMessages(db, 'chat-1', base)
    addAlternateMessage(db, 'chat-1', msg('alt', 'char', 'candidate'))

    // Surgical active append must leave the alternate intact.
    applyChatMessageDiff(db, 'chat-1', base, [...base, msg('m2', 'char', 'b')])

    expect(getChatMessages(db, 'chat-1')).toEqual([msg('m1', 'user', 'a'), msg('m2', 'char', 'b')])
    expect(getAlternateMessages(db, 'chat-1')).toEqual([msg('alt', 'char', 'candidate')])
  })

  it('deleteChatMessages drops the reroll buffer too (chat lifecycle)', () => {
    const db = makeDb(makeDataDir())
    replaceChatMessages(db, 'chat-1', [msg('m1', 'char', 'active')])
    addAlternateMessage(db, 'chat-1', msg('alt', 'char', 'candidate'))

    deleteChatMessages(db, 'chat-1')

    expect(getChatMessages(db, 'chat-1')).toEqual([])
    expect(getAlternateMessages(db, 'chat-1')).toEqual([])
  })

  it('scopes the buffer per chat', () => {
    const db = makeDb(makeDataDir())
    addAlternateMessage(db, 'chat-a', msg('a', 'char', 'A'))
    addAlternateMessage(db, 'chat-b', msg('b', 'char', 'B'))

    clearAlternateMessages(db, 'chat-a')

    expect(getAlternateMessages(db, 'chat-a')).toEqual([])
    expect(getAlternateMessages(db, 'chat-b')).toEqual([msg('b', 'char', 'B')])
  })
})

describe('applyChatMessageDiff surgical writes', () => {
  function rowids(db: DatabaseSync, chatId: string): { seq: number; rowid: number }[] {
    return db.prepare('SELECT rowid, seq FROM messages WHERE chat_id = ? ORDER BY seq').all(chatId) as {
      seq: number
      rowid: number
    }[]
  }

  function persistedActiveRows(db: DatabaseSync, chatId: string) {
    return db
      .prepare(
        'SELECT seq, uid, role, data, disabled, json, alternate FROM messages WHERE chat_id = ? AND alternate = 0 ORDER BY seq',
      )
      .all(chatId)
  }

  it('appends exactly one row and leaves prior rows physically untouched', () => {
    const db = makeDb(makeDataDir())
    const base = [msg('m1', 'user', 'a'), msg('m2', 'char', 'b')]
    replaceChatMessages(db, 'chat-1', base)
    const before = rowids(db, 'chat-1')

    applyChatMessageDiff(db, 'chat-1', base, [...base, msg('m3', 'user', 'c')])

    const after = rowids(db, 'chat-1')
    // The two prefix rows keep their rowid (not deleted+reinserted); one new row.
    expect(after.slice(0, 2)).toEqual(before)
    expect(after).toHaveLength(3)
    expect(getChatMessages(db, 'chat-1')).toEqual([...base, msg('m3', 'user', 'c')])
  })

  it('writes nothing when the array is unchanged', () => {
    const db = makeDb(makeDataDir())
    const base = [msg('m1', 'user', 'a'), msg('m2', 'char', 'b')]
    replaceChatMessages(db, 'chat-1', base)
    const before = rowids(db, 'chat-1')

    applyChatMessageDiff(db, 'chat-1', base, structuredClone(base))

    expect(rowids(db, 'chat-1')).toEqual(before)
  })

  it('deletes from the divergence point and reseqs the tail', () => {
    const db = makeDb(makeDataDir())
    const base = [msg('m1', 'user', 'a'), msg('m2', 'char', 'b'), msg('m3', 'user', 'c')]
    replaceChatMessages(db, 'chat-1', base)
    const before = rowids(db, 'chat-1')

    // Delete the middle message → tail reseqs.
    applyChatMessageDiff(db, 'chat-1', base, [base[0], base[2]])

    expect(getChatMessages(db, 'chat-1')).toEqual([msg('m1', 'user', 'a'), msg('m3', 'user', 'c')])
    // The untouched prefix (m1 at seq 0) keeps its rowid.
    expect(rowids(db, 'chat-1')[0]).toEqual(before[0])
  })

  it('truncates by dropping trailing rows only', () => {
    const db = makeDb(makeDataDir())
    const base = [msg('m1', 'user', 'a'), msg('m2', 'char', 'b'), msg('m3', 'user', 'c')]
    replaceChatMessages(db, 'chat-1', base)
    const before = rowids(db, 'chat-1')

    applyChatMessageDiff(db, 'chat-1', base, base.slice(0, 1))

    expect(getChatMessages(db, 'chat-1')).toEqual([msg('m1', 'user', 'a')])
    expect(rowids(db, 'chat-1')).toEqual([before[0]])
  })

  it('append-only tail persistence writes byte-identical rows without generic diff work', () => {
    const expectedDb = makeDb(makeDataDir())
    const db = makeDb(makeDataDir())
    const base = Array.from({ length: 64 }, (_, index) =>
      msg(`m${index}`, index % 2 === 0 ? 'user' : 'char', `row ${index}`, {
        time: index,
      }),
    )
    const tail = msg('m64', 'char', 'tail', {
      disabled: true,
      generationInfo: { model: 'test-model' },
    })
    const next = [...base, tail]

    replaceChatMessages(expectedDb, 'chat-1', next)
    replaceChatMessages(db, 'chat-1', base)
    addAlternateMessage(db, 'chat-1', msg('alt', 'char', 'candidate'))
    const prefixRowids = rowids(db, 'chat-1').filter(({ seq }) => seq >= 0)

    resetChatMessageDiffInstrumentation()
    const appended = appendActiveChatMessageTail(db, 'chat-1', next, base)

    expect(appended).toBe(true)
    expect(getChatMessageDiffInstrumentation()).toMatchObject({
      genericDiffRuns: 0,
      stableEqualCalls: 0,
      stableEqualStringifies: 0,
      appendFastPathRows: 1,
    })
    expect(persistedActiveRows(db, 'chat-1')).toEqual(persistedActiveRows(expectedDb, 'chat-1'))
    expect(
      rowids(db, 'chat-1')
        .filter(({ seq }) => seq >= 0)
        .slice(0, base.length),
    ).toEqual(prefixRowids)
    expect(getAlternateMessages(db, 'chat-1')).toEqual([msg('alt', 'char', 'candidate')])
  })

  it('rejects an append-only tail derived from a stale same-length prefix', () => {
    const db = makeDb(makeDataDir())
    const initial = [msg('m1', 'user', 'question'), msg('m2', 'char', 'original answer')]
    const concurrentlyEdited = [initial[0], msg('m2', 'char', 'concurrent answer')]
    const desired = [...initial, msg('m3', 'user', 'stale follow-up')]
    replaceChatMessages(db, 'chat-1', concurrentlyEdited)
    const beforeRows = persistedActiveRows(db, 'chat-1')
    const beforeRowids = rowids(db, 'chat-1')

    resetChatMessageDiffInstrumentation()
    const appended = appendActiveChatMessageTail(db, 'chat-1', desired, initial)

    expect(appended).toBe(false)
    expect(getChatMessages(db, 'chat-1')).toEqual(concurrentlyEdited)
    expect(persistedActiveRows(db, 'chat-1')).toEqual(beforeRows)
    expect(rowids(db, 'chat-1')).toEqual(beforeRowids)
    expect(getChatMessageDiffInstrumentation()).toMatchObject({
      genericDiffRuns: 0,
      stableEqualCalls: 0,
      stableEqualStringifies: 0,
      appendFastPathRows: 0,
    })
  })
})

describe('chat hypaV3Data store', () => {
  it('upserts, reads, groups and deletes a chat blob', () => {
    const db = makeDb(makeDataDir())
    setChatHypaV3(db, 'chat-1', { mainChunks: [{ text: 'a' }], lastImportantSummary: 2 })
    setChatHypaV3(db, 'chat-2', { mainChunks: [] })

    expect(getChatHypaV3(db, 'chat-1')).toEqual({
      mainChunks: [{ text: 'a' }],
      lastImportantSummary: 2,
    })
    expect(getAllChatIdsWithHypaV3(db).sort()).toEqual(['chat-1', 'chat-2'])

    // Upsert overwrites.
    setChatHypaV3(db, 'chat-1', { mainChunks: [{ text: 'b' }] })
    expect(getChatHypaV3(db, 'chat-1')).toEqual({ mainChunks: [{ text: 'b' }] })

    // setChatHypaV3(null/undefined) deletes.
    setChatHypaV3(db, 'chat-1', undefined)
    expect(getChatHypaV3(db, 'chat-1')).toBeUndefined()
    deleteChatHypaV3(db, 'chat-2')
    expect(getAllChatHypaV3Grouped(db).size).toBe(0)
  })
})

describe('repository message-aware load/write', () => {
  function seedHydrated(database: unknown): Persisted {
    return { _version: 1, database, assets: [] }
  }

  it('splits embedded messages into SQLite, plain load omits them', () => {
    const dataDir = makeDataDir()
    const db = makeDb(dataDir)
    const database = {
      characters: [
        {
          chaId: 'char-a',
          chats: [
            { id: 'chat-1', message: [msg('m1', 'user', 'hi'), msg('m2', 'char', 'yo')] },
            { id: 'chat-2', message: [msg('m3', 'user', 'second chat')] },
          ],
        },
      ],
    }

    const clone = structuredClone(database)
    writePersistedWithMessages(db, dataDir, seedHydrated(clone))

    // Plain load (from SQLite) sees characters but no messages...
    const plain = loadPersisted(db, dataDir).database as typeof database
    expect(plain.characters[0].chats[0].message).toBeUndefined()
    // ...while the hydrated load reconstructs them byte-for-byte.
    const hydrated = loadPersistedWithMessages(db, dataDir).database as typeof database
    expect(hydrated.characters[0].chats[0].message).toEqual(database.characters[0].chats[0].message)
    expect(hydrated.characters[0].chats[1].message).toEqual(database.characters[0].chats[1].message)
  })

  it('splits + rejoins per-chat hypaV3Data via SQLite', () => {
    const dataDir = makeDataDir()
    const db = makeDb(dataDir)
    const database = {
      characters: [
        {
          chaId: 'c',
          chats: [
            {
              id: 'chat-1',
              message: [msg('m1', 'user', 'hi')],
              hypaV3Data: { mainChunks: [{ t: 1 }] },
            },
            { id: 'chat-2', message: [], hypaV3Data: undefined },
          ],
        },
      ],
    }

    const clone = structuredClone(database)
    writePersistedWithMessages(db, dataDir, seedHydrated(clone))

    // The hydrated load rejoins hypaV3Data (only where present).
    const hydrated = loadPersistedWithMessages(db, dataDir).database as typeof database
    expect(hydrated.characters[0].chats[0].hypaV3Data).toEqual({ mainChunks: [{ t: 1 }] })
    expect(hydrated.characters[0].chats[1].hypaV3Data).toBeUndefined()
  })

  it('round-trips load->write->load preserving messages', () => {
    const dataDir = makeDataDir()
    const db = makeDb(dataDir)
    const database = {
      characters: [
        {
          chaId: 'c',
          chats: [{ id: 'chat-1', message: [msg('m1', 'user', 'a'), msg('m2', 'char', 'b')] }],
        },
      ],
    }
    writePersistedWithMessages(db, dataDir, seedHydrated(structuredClone(database)))

    const first = loadPersistedWithMessages(db, dataDir)
    writePersistedWithMessages(db, dataDir, structuredClone(first))
    const second = loadPersistedWithMessages(db, dataDir)

    expect(second.database).toEqual(first.database)
    expect((second.database as typeof database).characters[0].chats[0].message).toEqual(
      database.characters[0].chats[0].message,
    )
  })

  it('returns empty messages when characters are in SQLite but no message rows exist yet', () => {
    // Characters live in SQLite; when no message rows exist, the hydrated
    // load sees an empty transcript.
    const dataDir = makeDataDir()
    const db = makeDb(dataDir)
    // Seed characters into SQLite without messages by writing chats with empty message arrays.
    const databaseNoMessages = {
      characters: [{ chaId: 'c', chats: [{ id: 'chat-1' }] }],
    }
    writePersistedWithMessages(db, dataDir, seedHydrated(structuredClone(databaseNoMessages)))

    const hydrated = loadPersistedWithMessages(db, dataDir).database as {
      characters: Array<{ chats: Array<{ id: string; message: unknown[] }> }>
    }
    // No message rows in SQLite so the chat has an empty transcript.
    expect(hydrated.characters[0].chats[0].message).toEqual([])
    // After a message-aware write with messages provided, they land in SQLite.
    const withMessages = structuredClone(hydrated)
    withMessages.characters[0].chats[0].message = [msg('m1', 'user', 'embedded')]
    writePersistedWithMessages(db, dataDir, { _version: 1, database: withMessages, assets: [] })
    expect(getChatMessages(db, 'chat-1')).toEqual([msg('m1', 'user', 'embedded')])
  })

  it('ensureDbJsonImported is a no-op when no db.json exists', () => {
    // When data is already in SQLite and no legacy db.json is present,
    // ensureDbJsonImported does nothing.
    const dataDir = makeDataDir()
    const db = makeDb(dataDir)
    const database = {
      characters: [
        {
          chaId: 'c',
          chats: [
            {
              id: 'chat-1',
              name: 'Already migrated',
              message: [msg('m1', 'user', 'already in sqlite')],
            },
          ],
        },
      ],
    }
    writePersistedWithMessages(db, dataDir, seedHydrated(structuredClone(database)))

    ensureDbJsonImported(db, dataDir)

    // Characters remain in SQLite, messages untouched.
    const hydrated = loadPersistedWithMessages(db, dataDir).database as {
      characters: Array<{ chats: Array<{ id: string; message: unknown[] }> }>
    }
    expect(hydrated.characters[0].chats[0].id).toBe('chat-1')
    expect(hydrated.characters[0].chats[0].message).toEqual([msg('m1', 'user', 'already in sqlite')])
  })

  it('ensureDbJsonImported imports a legacy db.json into SQLite', () => {
    // A legacy db.json with characters and messages is imported into SQLite
    // and the file is renamed to db.json.migrated.
    const dataDir = makeDataDir()
    const db = makeDb(dataDir)
    const legacyAsset = {
      id: 'a'.repeat(64),
      ext: 'png',
      size: 123,
      contentType: 'image/png',
    }
    const database = {
      loreBook: [
        {
          name: 'Legacy lorebook',
          data: [{ key: 'legacy', comment: 'Legacy entry', content: '' }],
        },
      ],
      characters: [
        {
          chaId: 'c',
          chats: [{ id: 'chat-1', name: 'Legacy chat', message: [msg('m1', 'user', 'hi')] }],
        },
      ],
    }
    writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ _version: 1, database, assets: [legacyAsset] }))

    ensureDbJsonImported(db, dataDir)

    // Characters and messages are now in SQLite.
    const hydrated = loadPersistedWithMessages(db, dataDir).database as {
      characters: Array<{ chats: Array<{ id: string; message: unknown[] }> }>
    }
    expect(hydrated.characters[0].chats[0].id).toBe('chat-1')
    expect(hydrated.characters[0].chats[0].message).toEqual([msg('m1', 'user', 'hi')])
    const migratedLorebook = (
      loadPersisted(db, dataDir).database as { loreBook: Array<{ id?: unknown; data: Array<{ id?: unknown }> }> }
    ).loreBook[0]
    expect(migratedLorebook.id).toEqual(expect.any(String))
    expect(migratedLorebook.data[0].id).toEqual(expect.any(String))
    expect(loadPersisted(db, dataDir).assets).toEqual([legacyAsset])
  })

  it('reclaims rows for chats removed from the database', () => {
    const dataDir = makeDataDir()
    const db = makeDb(dataDir)
    const withTwo = {
      characters: [
        {
          chaId: 'c',
          chats: [
            { id: 'chat-1', message: [msg('m1', 'user', 'a')] },
            { id: 'chat-2', message: [msg('m2', 'user', 'b')] },
          ],
        },
      ],
    }
    writePersistedWithMessages(db, dataDir, seedHydrated(structuredClone(withTwo)))
    expect(getAllChatIdsWithMessages(db).sort()).toEqual(['chat-1', 'chat-2'])

    const withOne = {
      characters: [{ chaId: 'c', chats: [{ id: 'chat-1', message: [msg('m1', 'user', 'a')] }] }],
    }
    writePersistedWithMessages(db, dataDir, seedHydrated(structuredClone(withOne)))
    expect(getAllChatIdsWithMessages(db)).toEqual(['chat-1'])
  })
})
