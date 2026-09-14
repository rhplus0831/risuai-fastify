import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setupAuthedClient } from './helpers/auth.js'
import { compressSync } from 'fflate'

interface Harness {
  app: FastifyInstance
  assertion: string
  dataDir: string
  databaseLineage: string
  revision: number
}

let harness: Harness

beforeEach(async () => {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-chat-occupancy-enforcement-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    chatOccupancy: { enabled: true },
    memoryWorker: false,
    bardWikiWorker: false,
    assetGc: false,
    generationChat: { finalizationRetry: false },
  })
  const { assertion } = await setupAuthedClient(app)
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion },
    payload: {
      database: {
        characters: [
          {
            chaId: 'character-a',
            name: 'Ada',
            chats: [
              {
                id: 'chat-a',
                name: 'A',
                fmIndex: 0,
                folderId: 'folder-a',
                modules: ['module-a'],
                message: [{ role: 'user', data: 'a', chatId: 'message-a' }],
              },
              {
                id: 'chat-b',
                name: 'B',
                fmIndex: 1,
                message: [{ role: 'user', data: 'b', chatId: 'message-b' }],
              },
              { id: 'chat-c', name: 'C', message: [] },
            ],
            alternateGreetings: ['zero', 'one'],
            chatFolders: [{ id: 'folder-a', name: 'Folder A', folded: false }],
            chatPage: 0,
          },
        ],
        characterOrder: ['character-a'],
        modules: [{ id: 'module-a', name: 'Module A', description: '' }],
      },
    },
  })
  expect(imported.statusCode).toBe(200)
  const bootstrap = await app.inject({
    method: 'GET',
    url: '/api/v1/bootstrap',
    headers: { 'risu-auth': assertion, 'risu-writer-session': 'owner-a' },
  })
  expect(bootstrap.statusCode).toBe(200)
  harness = {
    app,
    assertion,
    dataDir,
    databaseLineage: bootstrap.json().databaseLineage as string,
    revision: bootstrap.json().revision as number,
  }
})

afterEach(async () => {
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
})

function ownerHeaders() {
  return { 'risu-auth': harness.assertion, 'risu-writer-session': 'owner-a' }
}

async function claim(chatId: string, sessionId: string, claimClass: 'owner' | 'chat_only' = 'chat_only') {
  const response = await harness.app.inject({
    method: 'POST',
    url: `/api/v1/chat-occupancies/${chatId}/claim`,
    headers: {
      'risu-auth': harness.assertion,
      'risu-writer-session': sessionId,
      'risu-database-lineage': harness.databaseLineage,
      'risu-chat-occupancy-epoch': '0',
    },
    payload: { version: 1, claimClass },
  })
  expect(response.statusCode).toBe(200)
  return response.json()
}

function readRows(sql: string, ...params: Array<string | number | null>): unknown[] {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

describe('chat occupancy command enforcement', () => {
  it('blocks a compatibility owner mutation without a session header when the chat is occupied', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-chat-occupancy-compatibility-'))
    const { app } = await buildApp({
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir,
        bodyLimit: 1024 * 1024,
        importMaxBytes: Infinity,
        trustProxy: false,
        hubUrl: 'https://sv.risuai.xyz',
      },
      chatOccupancy: { enabled: true },
      memoryWorker: false,
      bardWikiWorker: false,
      assetGc: false,
      generationChat: { finalizationRetry: false },
    })
    try {
      const { assertion } = await setupAuthedClient(app)
      const imported = await app.inject({
        method: 'POST',
        url: '/api/v1/import/risusave',
        headers: { 'risu-auth': assertion },
        payload: {
          database: {
            characters: [
              {
                chaId: 'compat-character',
                name: 'Compatibility',
                chats: [
                  {
                    id: 'compat-chat',
                    name: 'Compatibility chat',
                    message: [{ role: 'user', data: 'before', chatId: 'compat-message' }],
                  },
                ],
                chatFolders: [],
                chatPage: 0,
              },
            ],
            characterOrder: ['compat-character'],
          },
        },
      })
      expect(imported.statusCode).toBe(200)
      const claimResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/chat-occupancies/compat-chat/claim',
        headers: {
          'risu-auth': assertion,
          'risu-writer-session': 'compat-reader',
          'risu-database-lineage': imported.json().databaseLineage,
          'risu-chat-occupancy-epoch': '0',
        },
        payload: { version: 1, claimClass: 'chat_only' },
      })
      expect(claimResponse.statusCode).toBe(200)

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/messages/compat-message',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: imported.json().revision, patch: { disabled: true } },
      })

      expect(response.statusCode).toBe(423)
      expect(response.json()).toMatchObject({ error: 'chat_occupied', conflictingChatIds: ['compat-chat'] })
      const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
      try {
        expect(db.prepare('SELECT disabled FROM messages WHERE uid = ?').get('compat-message')).toEqual({
          disabled: null,
        })
      } finally {
        db.close()
      }
    } finally {
      await app.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('resolves a message target from SQLite and blocks a foreign owner edit despite a forged expected chat', async () => {
    await claim('chat-a', 'reader-a')
    const before = readRows('SELECT * FROM messages WHERE uid = ?', 'message-a')

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/message-a',
      headers: ownerHeaders(),
      payload: {
        baseRevision: harness.revision,
        patch: { disabled: true },
        expectedChatId: 'chat-b',
      },
    })

    expect(response.statusCode).toBe(423)
    expect(response.json()).toMatchObject({
      error: 'chat_occupied',
      chatId: 'chat-a',
      conflictingChatIds: ['chat-a'],
      safeRelease: expect.any(String),
    })
    expect(readRows('SELECT * FROM messages WHERE uid = ?', 'message-a')).toEqual(before)
    expect(readRows('SELECT revision FROM schema_version WHERE id = 1')).toEqual([{ revision: harness.revision }])
  })

  it('allows the actor to mutate its own occupied chat and preserves unrelated owner writes', async () => {
    await claim('chat-a', 'reader-a')
    await claim('chat-b', 'owner-a', 'owner')

    const ownEdit = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/message-b',
      headers: ownerHeaders(),
      payload: { baseRevision: harness.revision, patch: { disabled: true } },
    })
    expect(ownEdit.statusCode).toBe(200)

    const characterEdit = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/character-a',
      headers: ownerHeaders(),
      payload: { baseRevision: ownEdit.json().revision, patch: { name: 'Ada Updated' } },
    })
    expect(characterEdit.statusCode).toBe(200)
    expect(
      readRows('SELECT json_extract(data_json, ?) AS name FROM characters WHERE id = ?', '$.name', 'character-a'),
    ).toEqual([{ name: 'Ada Updated' }])
  })

  it('creates, read-only forks, and deletes another chat without rewriting an occupied sibling row', async () => {
    await claim('chat-a', 'reader-a')
    const occupiedRow = readRows('SELECT * FROM chats WHERE id = ?', 'chat-a')

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/character-a/chats',
      headers: ownerHeaders(),
      payload: {
        baseRevision: harness.revision,
        chat: { id: 'chat-new', name: 'New', note: '', message: [], localLore: [] },
      },
    })
    expect(created.statusCode).toBe(200)

    const forked = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: ownerHeaders(),
      payload: {
        baseRevision: created.json().revision,
        chat: { id: 'chat-fork', name: 'Fork', note: '', message: [], localLore: [] },
      },
    })
    expect(forked.statusCode).toBe(200)

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/chats/chat-c',
      headers: ownerHeaders(),
      payload: { baseRevision: forked.json().revision },
    })
    expect(deleted.statusCode).toBe(200)
    expect(readRows('SELECT * FROM chats WHERE id = ?', 'chat-a')).toEqual(occupiedRow)
    expect(
      readRows('SELECT id, position FROM chats WHERE id IN (?, ?) ORDER BY position', 'chat-new', 'chat-fork'),
    ).toEqual([
      { id: 'chat-fork', position: -2 },
      { id: 'chat-new', position: -1 },
    ])

    const patchedFork = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: ownerHeaders(),
      payload: {
        baseRevision: deleted.json().revision,
        sourcePatch: { name: 'Must not change' },
        chat: { id: 'chat-blocked-fork', name: 'Blocked', note: '', message: [], localLore: [] },
      },
    })
    expect(patchedFork.statusCode).toBe(423)
    expect(readRows('SELECT * FROM chats WHERE id = ?', 'chat-a')).toEqual(occupiedRow)
    expect(readRows('SELECT id FROM chats WHERE id = ?', 'chat-blocked-fork')).toEqual([])
  })

  it('rejects a whole character deletion with every occupied chat and no partial changes', async () => {
    await claim('chat-a', 'reader-a')
    await claim('chat-b', 'reader-b')
    const beforeChats = readRows('SELECT * FROM chats ORDER BY id')
    const beforeMessages = readRows('SELECT * FROM messages ORDER BY chat_id, seq')

    const response = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/characters/character-a',
      headers: ownerHeaders(),
      payload: { baseRevision: harness.revision },
    })

    expect(response.statusCode).toBe(423)
    expect(response.json()).toMatchObject({
      error: 'chat_occupied',
      conflictingChatIds: ['chat-a', 'chat-b'],
      safeRelease: expect.any(String),
    })
    expect(readRows('SELECT * FROM chats ORDER BY id')).toEqual(beforeChats)
    expect(readRows('SELECT * FROM messages ORDER BY chat_id, seq')).toEqual(beforeMessages)
    expect(readRows('SELECT id FROM characters')).toEqual([{ id: 'character-a' }])
  })

  const destructiveCases = [
    {
      name: 'chat delete',
      method: 'DELETE' as const,
      url: '/api/v1/commands/chats/chat-a',
      payload: (revision: number) => ({ baseRevision: revision }),
    },
    {
      name: 'all-chat reset',
      method: 'PUT' as const,
      url: '/api/v1/commands/characters/character-a/chats',
      payload: (revision: number) => ({
        baseRevision: revision,
        chat: { id: 'replacement-chat', name: 'Replacement', message: [], localLore: [] },
      }),
    },
    {
      name: 'chat reorder',
      method: 'POST' as const,
      url: '/api/v1/commands/characters/character-a/chats/reorder',
      payload: (revision: number) => ({
        baseRevision: revision,
        chatIds: ['chat-b', 'chat-a', 'chat-c'],
        folderByChatId: { 'chat-a': 'folder-a', 'chat-b': null, 'chat-c': null },
      }),
    },
    {
      name: 'folder delete',
      method: 'DELETE' as const,
      url: '/api/v1/commands/chat-folders/folder-a',
      payload: (revision: number) => ({ baseRevision: revision }),
    },
    {
      name: 'alternate greeting remap',
      method: 'PATCH' as const,
      url: '/api/v1/commands/characters/character-a/alternate-greetings',
      payload: (revision: number) => ({
        baseRevision: revision,
        alternateGreetings: ['one'],
        operation: { type: 'delete', index: 0 },
      }),
    },
    {
      name: 'chat cold-storage recovery',
      method: 'POST' as const,
      url: '/api/v1/commands/chats/chat-a/recover-cold-storage',
      setup() {
        const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
        try {
          db.prepare('UPDATE messages SET data = ? WHERE uid = ?').run(
            '\uEF01COLDSTORAGE\uEF01occupied-archive',
            'message-a',
          )
        } finally {
          db.close()
        }
        const saveDir = path.join(harness.dataDir, 'save')
        mkdirSync(saveDir, { recursive: true })
        writeFileSync(
          path.join(saveDir, Buffer.from('coldstorage/occupied-archive', 'utf8').toString('hex')),
          Buffer.from(
            compressSync(
              new TextEncoder().encode(
                JSON.stringify({ message: [{ role: 'user', data: 'replacement', chatId: 'replacement-message' }] }),
              ),
            ),
          ),
        )
      },
      payload: (revision: number) => ({ baseRevision: revision, key: 'occupied-archive' }),
    },
    {
      name: 'module reference cleanup',
      method: 'DELETE' as const,
      url: '/api/v1/commands/modules/module-a',
      payload: (revision: number) => ({ baseRevision: revision }),
    },
  ]

  it.each(destructiveCases)('rejects $name atomically when its affected chat is foreign-occupied', async (testCase) => {
    testCase.setup?.()
    const before = {
      characters: readRows('SELECT * FROM characters ORDER BY id'),
      chats: readRows('SELECT * FROM chats ORDER BY id'),
      messages: readRows('SELECT * FROM messages ORDER BY chat_id, seq'),
      modules: readRows('SELECT * FROM modules ORDER BY position'),
      revision: readRows('SELECT revision FROM schema_version WHERE id = 1'),
    }
    await claim('chat-a', 'reader-a')

    const response = await harness.app.inject({
      method: testCase.method,
      url: testCase.url,
      headers: ownerHeaders(),
      payload: testCase.payload(harness.revision),
    })

    expect(response.statusCode).toBe(423)
    expect(response.json()).toMatchObject({
      error: 'chat_occupied',
      conflictingChatIds: ['chat-a'],
      safeRelease: expect.any(String),
    })
    expect({
      characters: readRows('SELECT * FROM characters ORDER BY id'),
      chats: readRows('SELECT * FROM chats ORDER BY id'),
      messages: readRows('SELECT * FROM messages ORDER BY chat_id, seq'),
      modules: readRows('SELECT * FROM modules ORDER BY position'),
      revision: readRows('SELECT revision FROM schema_version WHERE id = 1'),
    }).toEqual(before)
  })

  it('preserves a negative-position occupied sibling during an unrelated alternate-greeting remap', async () => {
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      db.prepare("UPDATE chats SET position = -5, data_json = json_set(data_json, '$.fmIndex', -1) WHERE id = ?").run(
        'chat-a',
      )
    } finally {
      db.close()
    }
    await claim('chat-a', 'reader-a')
    const beforeOccupied = readRows('SELECT * FROM chats WHERE id = ?', 'chat-a')

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/character-a/alternate-greetings',
      headers: ownerHeaders(),
      payload: {
        baseRevision: harness.revision,
        alternateGreetings: ['one'],
        operation: { type: 'delete', index: 0 },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(readRows('SELECT * FROM chats WHERE id = ?', 'chat-a')).toEqual(beforeOccupied)
  })

  it('rejects database replacement before publication and retains lineage and rows', async () => {
    await claim('chat-a', 'reader-a')
    const beforeChats = readRows('SELECT * FROM chats ORDER BY id')

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: ownerHeaders(),
      payload: {
        database: {
          characters: [{ chaId: 'replacement', name: 'Replacement', chats: [], chatFolders: [], chatPage: -1 }],
          characterOrder: ['replacement'],
        },
      },
    })

    expect(response.statusCode).toBe(423)
    expect(response.json()).toMatchObject({
      error: 'chat_occupied',
      conflictingChatIds: ['chat-a'],
      safeRelease: expect.any(String),
    })
    expect(readRows('SELECT * FROM chats ORDER BY id')).toEqual(beforeChats)
    expect(readRows('SELECT lineage FROM database_metadata WHERE id = 1')).toEqual([
      { lineage: harness.databaseLineage },
    ])
  })

  it('rejects backup restore inside its publication transaction while a chat is occupied', async () => {
    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: ownerHeaders(),
      payload: { label: 'before occupancy' },
    })
    expect(backup.statusCode).toBe(201)
    await claim('chat-a', 'reader-a')
    const beforeChats = readRows('SELECT * FROM chats ORDER BY id')

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${backup.json().id}/restore`,
      headers: ownerHeaders(),
    })

    expect(restored.statusCode).toBe(423)
    expect(restored.json()).toMatchObject({
      error: 'chat_occupied',
      conflictingChatIds: ['chat-a'],
      safeRelease: expect.any(String),
    })
    expect(readRows('SELECT * FROM chats ORDER BY id')).toEqual(beforeChats)
    expect(readRows('SELECT lineage FROM database_metadata WHERE id = 1')).toEqual([
      { lineage: harness.databaseLineage },
    ])
  })
})
