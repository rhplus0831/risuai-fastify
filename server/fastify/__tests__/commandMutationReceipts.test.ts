/** @module-tag core */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createCommandEventSink, type CommandEventSink } from '../src/commands/events.js'
import { getSchemaState } from '../src/db.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import { insertAssetMetadataBatch } from '../src/repository.js'
import { setupAuthedClient } from './helpers/auth.js'

interface Harness {
  app: FastifyInstance
  dataDir: string
  commandEvents: CommandEventSink
}

let harness: Harness
let assertion: string
let revision: number
let databaseLineage: string

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-command-receipts-'))
  const commandEvents = createCommandEventSink()
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
    commandEvents,
    assetGc: false,
    memoryWorker: false,
  })
  return { app, dataDir, commandEvents }
}

async function importDatabase(database: Record<string, unknown>): Promise<number> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion },
    payload: { database },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().revision as number
}

function openRawDatabase(): DatabaseSync {
  return new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
}

function readSettings(): Record<string, unknown> {
  const db = openRawDatabase()
  try {
    const row = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
    return JSON.parse(row.data_json) as Record<string, unknown>
  } finally {
    db.close()
  }
}

async function readChatMessages(chatId: string): Promise<Array<Record<string, unknown>>> {
  const response = await harness.app.inject({
    method: 'GET',
    url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    headers: { 'risu-auth': assertion },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().message as Array<Record<string, unknown>>
}

function receiptCount(): number {
  const db = openRawDatabase()
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM command_mutation_receipts').get() as { count: number }
    return row.count
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  harness = await startHarness()
  assertion = (await setupAuthedClient(harness.app)).assertion
  revision = await importDatabase({
    theme: 'dark',
    characters: [],
    modelProfiles: [],
    agentPresets: [],
  })
  const db = openRawDatabase()
  try {
    databaseLineage = getDatabaseLineage(db)
  } finally {
    db.close()
  }
  harness.commandEvents.clear()
})

afterEach(async () => {
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
})

describe('transactional command mutation receipts', () => {
  it('replays the original result before the revision check without writing or emitting twice', async () => {
    const first = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'autosave-1',
        'risu-database-lineage': databaseLineage,
      },
      payload: { baseRevision: revision, patch: { theme: 'light' } },
    })
    expect(first.statusCode, first.body).toBe(200)
    const firstBody = first.json() as Record<string, unknown>
    const acceptedRevision = firstBody.revision as number
    expect(acceptedRevision).toBe(revision + 1)
    expect(readSettings().theme).toBe('light')
    expect(harness.commandEvents.list()).toHaveLength(1)
    expect(receiptCount()).toBe(1)

    const replay = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'autosave-1',
        'risu-database-lineage': databaseLineage,
      },
      // Durable replays rebuild the transport cursor. The receipt lookup must
      // still win even when that cursor is now stale or otherwise different.
      payload: { baseRevision: acceptedRevision + 100, patch: { theme: 'light' } },
    })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(firstBody)
    expect(readSettings().theme).toBe('light')
    expect(harness.commandEvents.list()).toHaveLength(1)
    expect(receiptCount()).toBe(1)

    const db = openRawDatabase()
    try {
      expect(getSchemaState(db).revision).toBe(acceptedRevision)
      expect(db.prepare('SELECT COUNT(*) AS count FROM command_events').get()).toMatchObject({ count: 2 })
    } finally {
      db.close()
    }
  })

  it('replays in preHandler before route validation can reject a formerly valid request', async () => {
    const assetId = 'a'.repeat(64)
    const seed = openRawDatabase()
    try {
      insertAssetMetadataBatch(seed, [{ id: assetId, ext: 'png', size: 1, contentType: 'image/png' }])
    } finally {
      seed.close()
    }

    const first = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'asset-validation-replay',
        'risu-database-lineage': databaseLineage,
      },
      payload: { baseRevision: revision, patch: { customBackground: assetId } },
    })
    expect(first.statusCode, first.body).toBe(200)
    const firstBody = first.json() as Record<string, unknown>

    const removeAsset = openRawDatabase()
    try {
      removeAsset.prepare('DELETE FROM assets WHERE id = ?').run(assetId)
    } finally {
      removeAsset.close()
    }

    const replay = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'asset-validation-replay',
        'risu-database-lineage': databaseLineage,
      },
      payload: {
        baseRevision: (firstBody.revision as number) + 100,
        patch: { customBackground: assetId },
      },
    })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(firstBody)
    expect(harness.commandEvents.list()).toHaveLength(1)

    const newIntent = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'asset-validation-new-intent',
        'risu-database-lineage': databaseLineage,
      },
      payload: { baseRevision: firstBody.revision, patch: { customBackground: assetId } },
    })
    expect(newIntent.statusCode, newIntent.body).toBe(400)
    expect(newIntent.json()).toMatchObject({ error: expect.stringContaining('customBackground') })
    expect(harness.commandEvents.list()).toHaveLength(1)
  })

  it('replays chat create, fork, and append receipts before duplicate-id validation', async () => {
    revision = await importDatabase({
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'Character A',
          chatPage: 0,
          chats: [{ id: 'chat-source', name: 'Source', note: '', localLore: [], message: [] }],
          chatFolders: [],
        },
      ],
      characterOrder: ['char-a'],
    })
    const lineageDb = openRawDatabase()
    try {
      databaseLineage = getDatabaseLineage(lineageDb)
    } finally {
      lineageDb.close()
    }
    harness.commandEvents.clear()

    const durableHeaders = (mutationId: string) => ({
      'risu-auth': assertion,
      'risu-writer-session': 'writer-chat-lifecycle',
      'risu-mutation-id': mutationId,
      'risu-database-lineage': databaseLineage,
    })
    const createdChat = {
      id: 'chat-created',
      name: 'Durable created chat',
      note: '',
      localLore: [],
      message: [],
    }
    const create = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: durableHeaders('chat-create-receipt'),
      payload: { baseRevision: revision, chat: createdChat, select: true },
    })
    expect(create.statusCode, create.body).toBe(200)
    const createBody = create.json() as Record<string, unknown>
    const createReplay = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: durableHeaders('chat-create-receipt'),
      payload: { baseRevision: (createBody.revision as number) + 100, chat: createdChat, select: true },
    })
    expect(createReplay.statusCode, createReplay.body).toBe(200)
    expect(createReplay.json()).toEqual(createBody)

    const forkedChat = {
      id: 'chat-forked',
      name: 'Durable fork',
      note: '',
      localLore: [],
      message: [{ role: 'char', data: 'fork seed', chatId: 'message-fork-seed' }],
    }
    const fork = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-source/fork',
      headers: durableHeaders('chat-fork-receipt'),
      payload: { baseRevision: createBody.revision, chat: forkedChat, select: false },
    })
    expect(fork.statusCode, fork.body).toBe(200)
    const forkBody = fork.json() as Record<string, unknown>
    const forkReplay = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-source/fork',
      headers: durableHeaders('chat-fork-receipt'),
      payload: { baseRevision: (forkBody.revision as number) + 100, chat: forkedChat, select: false },
    })
    expect(forkReplay.statusCode, forkReplay.body).toBe(200)
    expect(forkReplay.json()).toEqual(forkBody)

    const appendedMessage = {
      role: 'user',
      data: 'durable append',
      chatId: 'message-created-append',
      time: 123,
    }
    const append = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-created/messages',
      headers: durableHeaders('chat-append-receipt'),
      payload: { baseRevision: forkBody.revision, message: appendedMessage },
    })
    expect(append.statusCode, append.body).toBe(200)
    const appendBody = append.json() as Record<string, unknown>
    const appendReplay = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-created/messages',
      headers: durableHeaders('chat-append-receipt'),
      payload: { baseRevision: (appendBody.revision as number) + 100, message: appendedMessage },
    })
    expect(appendReplay.statusCode, appendReplay.body).toBe(200)
    expect(appendReplay.json()).toEqual(appendBody)

    const characterResponse = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-a',
      headers: { 'risu-auth': assertion },
    })
    expect(characterResponse.statusCode, characterResponse.body).toBe(200)
    const character = characterResponse.json().character as {
      chats: Array<{ id: string }>
    }
    expect(character.chats.filter((chat) => chat.id === 'chat-created')).toHaveLength(1)
    expect(character.chats.filter((chat) => chat.id === 'chat-forked')).toHaveLength(1)
    await expect(readChatMessages('chat-created')).resolves.toEqual([appendedMessage])
    await expect(readChatMessages('chat-forked')).resolves.toEqual(forkedChat.message)
    expect(harness.commandEvents.list()).toHaveLength(3)
    expect(receiptCount()).toBe(3)
  })

  it('replays chat and folder edits and reorders without applying structure twice', async () => {
    revision = await importDatabase({
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'Character A',
          chatPage: 0,
          chats: [
            {
              id: 'chat-a',
              name: 'Chat A',
              note: '',
              localLore: [],
              message: [],
              folderId: 'folder-a',
            },
            {
              id: 'chat-b',
              name: 'Chat B',
              note: '',
              localLore: [],
              message: [],
              folderId: null,
            },
          ],
          chatFolders: [
            { id: 'folder-a', name: 'Folder A', folded: false },
            { id: 'folder-b', name: 'Folder B', folded: false },
          ],
        },
      ],
      characterOrder: ['char-a'],
    })
    const lineageDb = openRawDatabase()
    try {
      databaseLineage = getDatabaseLineage(lineageDb)
    } finally {
      lineageDb.close()
    }
    harness.commandEvents.clear()

    const durableHeaders = (mutationId: string) => ({
      'risu-auth': assertion,
      'risu-writer-session': 'writer-chat-structure',
      'risu-mutation-id': mutationId,
      'risu-database-lineage': databaseLineage,
    })
    const executeAndReplay = async (
      mutationId: string,
      method: 'PATCH' | 'POST',
      url: string,
      payload: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const first = await harness.app.inject({
        method,
        url,
        headers: durableHeaders(mutationId),
        payload,
      })
      expect(first.statusCode, first.body).toBe(200)
      const firstBody = first.json() as Record<string, unknown>
      const replay = await harness.app.inject({
        method,
        url,
        headers: durableHeaders(mutationId),
        payload: { ...payload, baseRevision: (firstBody.revision as number) + 100 },
      })
      expect(replay.statusCode, replay.body).toBe(200)
      expect(replay.json()).toEqual(firstBody)
      return firstBody
    }

    const chatUpdated = await executeAndReplay('chat-update-receipt', 'PATCH', '/api/v1/commands/chats/chat-b', {
      baseRevision: revision,
      patch: { name: 'Chat B renamed' },
      select: true,
    })
    const folderUpdated = await executeAndReplay(
      'folder-update-receipt',
      'PATCH',
      '/api/v1/commands/chat-folders/folder-b',
      {
        baseRevision: chatUpdated.revision,
        patch: { name: 'Folder B renamed', folded: true },
      },
    )
    const foldersReordered = await executeAndReplay(
      'folder-reorder-receipt',
      'POST',
      '/api/v1/commands/characters/char-a/chat-folders/reorder',
      {
        baseRevision: folderUpdated.revision,
        folderIds: ['folder-b', 'folder-a'],
        selectedChatId: 'chat-b',
      },
    )
    const chatsReordered = await executeAndReplay(
      'chat-reorder-receipt',
      'POST',
      '/api/v1/commands/characters/char-a/chats/reorder',
      {
        baseRevision: foldersReordered.revision,
        chatIds: ['chat-b', 'chat-a'],
        folderByChatId: { 'chat-b': 'folder-b', 'chat-a': null },
        selectedChatId: 'chat-b',
      },
    )

    const characterResponse = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/characters/char-a',
      headers: { 'risu-auth': assertion },
    })
    expect(characterResponse.statusCode, characterResponse.body).toBe(200)
    const character = characterResponse.json().character as {
      chatPage: number
      chats: Array<{ id: string; name: string; folderId?: string | null }>
      chatFolders: Array<{ id: string; name: string; folded: boolean }>
    }
    expect(character.chatPage).toBe(0)
    expect(character.chats.map(({ id, name, folderId }) => ({ id, name, folderId: folderId ?? null }))).toEqual([
      { id: 'chat-b', name: 'Chat B renamed', folderId: 'folder-b' },
      { id: 'chat-a', name: 'Chat A', folderId: null },
    ])
    expect(character.chatFolders).toEqual([
      { id: 'folder-b', name: 'Folder B renamed', folded: true },
      { id: 'folder-a', name: 'Folder A', folded: false },
    ])
    expect(chatsReordered.revision).toBe(revision + 4)
    expect(harness.commandEvents.list()).toHaveLength(4)
    expect(receiptCount()).toBe(4)
  })

  it('replays across writer handoffs and rejects semantic mutation-id collisions globally', async () => {
    const first = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'shared-id',
        'risu-database-lineage': databaseLineage,
      },
      payload: { baseRevision: revision, patch: { theme: 'light' } },
    })
    expect(first.statusCode, first.body).toBe(200)
    const firstRevision = first.json().revision as number

    const writerHandoff = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-b',
      },
    })
    expect(writerHandoff.statusCode, writerHandoff.body).toBe(200)

    const replay = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-b',
        'risu-mutation-id': 'shared-id',
        'risu-database-lineage': databaseLineage,
      },
      payload: { baseRevision: firstRevision + 100, patch: { theme: 'light' } },
    })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(first.json())
    expect(readSettings().theme).toBe('light')
    expect(harness.commandEvents.list()).toHaveLength(1)
    expect(receiptCount()).toBe(1)

    const collision = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-b',
        'risu-mutation-id': 'shared-id',
        'risu-database-lineage': databaseLineage,
      },
      payload: { baseRevision: firstRevision, patch: { theme: 'dark' } },
    })
    expect(collision.statusCode, collision.body).toBe(409)
    expect(collision.json()).toEqual({ error: 'mutation_id_conflict' })
    expect(readSettings().theme).toBe('light')
  })

  it('requires a valid writer session whenever a mutation id is present', async () => {
    const missingWriter = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-mutation-id': 'autosave-without-writer',
        'risu-database-lineage': databaseLineage,
      },
      payload: { baseRevision: revision, patch: { theme: 'light' } },
    })
    expect(missingWriter.statusCode, missingWriter.body).toBe(400)
    expect(missingWriter.json()).toEqual({
      error: 'risu-mutation-id requires a valid risu-writer-session header',
    })
    expect(readSettings().theme).toBe('dark')
    expect(harness.commandEvents.list()).toHaveLength(0)
    expect(receiptCount()).toBe(0)
  })

  it('requires the current database lineage for durable mutations', async () => {
    const missingLineage = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'autosave-without-lineage',
      },
      payload: { baseRevision: revision, patch: { theme: 'light' } },
    })
    expect(missingLineage.statusCode, missingLineage.body).toBe(400)
    expect(missingLineage.json()).toEqual({
      error: 'risu-database-lineage must be a valid database lineage UUID',
    })
    expect(readSettings().theme).toBe('dark')
    expect(receiptCount()).toBe(0)
  })

  it('retains unacknowledged receipts instead of expiring them during later writes', async () => {
    const first = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'unacknowledged-old',
        'risu-database-lineage': databaseLineage,
      },
      payload: { baseRevision: revision, patch: { theme: 'light' } },
    })
    expect(first.statusCode, first.body).toBe(200)

    const db = openRawDatabase()
    try {
      db.prepare("UPDATE command_mutation_receipts SET created_at = '2000-01-01T00:00:00.000Z'").run()
    } finally {
      db.close()
    }

    const second = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'unacknowledged-new',
        'risu-database-lineage': databaseLineage,
      },
      payload: { baseRevision: first.json().revision as number, patch: { zoomsize: 91 } },
    })
    expect(second.statusCode, second.body).toBe(200)
    expect(receiptCount()).toBe(2)
  })

  it('lets the current writer acknowledge a completed multi-request intent from an earlier session', async () => {
    let currentRevision = revision
    const originalResponses: Array<Record<string, unknown>> = []
    for (const [index, mutationId] of ['intent-a', 'intent-a.1', 'intent-a.2'].entries()) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/settings/display',
        headers: {
          'risu-auth': assertion,
          'risu-writer-session': 'writer-a',
          'risu-mutation-id': mutationId,
          'risu-database-lineage': databaseLineage,
        },
        payload: { baseRevision: currentRevision, patch: { zoomsize: 80 + index } },
      })
      expect(response.statusCode, response.body).toBe(200)
      const responseBody = response.json() as Record<string, unknown>
      originalResponses.push(responseBody)
      currentRevision = responseBody.revision as number
    }

    const writerHandoff = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-b',
      },
    })
    expect(writerHandoff.statusCode, writerHandoff.body).toBe(200)
    expect(receiptCount()).toBe(3)

    const acknowledged = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/mutation-receipts/ack',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-b',
      },
      payload: { mutationId: 'intent-a', requestCount: 3, databaseLineage },
    })
    expect(acknowledged.statusCode, acknowledged.body).toBe(200)
    expect(acknowledged.json()).toEqual({ acknowledged: 3, requested: 3 })
    expect(receiptCount()).toBe(3)

    const delayedDuplicate = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-b',
        'risu-mutation-id': 'intent-a',
        'risu-database-lineage': databaseLineage,
      },
      payload: { baseRevision: currentRevision + 100, patch: { zoomsize: 80 } },
    })
    expect(delayedDuplicate.statusCode, delayedDuplicate.body).toBe(200)
    expect(delayedDuplicate.json()).toEqual(originalResponses[0])
    expect(harness.commandEvents.list()).toHaveLength(3)

    const repeated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/mutation-receipts/ack',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-b',
      },
      payload: { mutationId: 'intent-a', requestCount: 3, databaseLineage },
    })
    expect(repeated.statusCode, repeated.body).toBe(200)
    expect(repeated.json()).toEqual({ acknowledged: 0, requested: 3 })

    const db = openRawDatabase()
    try {
      expect(getSchemaState(db).revision).toBe(currentRevision)
      expect(
        db
          .prepare(
            `
              SELECT mutation_id AS mutationId,
                     acknowledged_at IS NOT NULL AS acknowledged,
                     delete_after IS NOT NULL AS expires
              FROM command_mutation_receipts
              ORDER BY mutation_id
            `,
          )
          .all(),
      ).toEqual([
        { mutationId: 'intent-a', acknowledged: 1, expires: 1 },
        { mutationId: 'intent-a.1', acknowledged: 1, expires: 1 },
        { mutationId: 'intent-a.2', acknowledged: 1, expires: 1 },
      ])
    } finally {
      db.close()
    }
  })

  it('rotates lineage on restore and accepts the next autosave with the returned scope', async () => {
    const writerBootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
      },
    })
    expect(writerBootstrap.statusCode, writerBootstrap.body).toBe(200)
    expect(writerBootstrap.json()).toMatchObject({ databaseLineage, writerEpoch: 1 })

    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
      },
      payload: { label: 'before durable restore' },
    })
    expect(backup.statusCode, backup.body).toBe(201)

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${encodeURIComponent(backup.json().id as string)}/restore`,
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
      },
    })
    expect(restored.statusCode, restored.body).toBe(200)
    const restoredBody = restored.json() as {
      revision: number
      databaseLineage: string
      writerEpoch: number
    }
    expect(restoredBody.databaseLineage).not.toBe(databaseLineage)
    expect(restoredBody.writerEpoch).toBe(1)

    const staleLineage = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'after-restore-stale-lineage',
        'risu-database-lineage': databaseLineage,
      },
      payload: { baseRevision: restoredBody.revision, patch: { theme: 'light' } },
    })
    expect(staleLineage.statusCode, staleLineage.body).toBe(409)
    expect(staleLineage.json()).toEqual({
      error: 'database_lineage_conflict',
      databaseLineage: restoredBody.databaseLineage,
    })

    const nextAutosave = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'after-restore-live-lineage',
        'risu-database-lineage': restoredBody.databaseLineage,
      },
      payload: { baseRevision: restoredBody.revision, patch: { theme: 'light' } },
    })
    expect(nextAutosave.statusCode, nextAutosave.body).toBe(200)
    expect(nextAutosave.json().revision).toBe(restoredBody.revision + 1)
  })

  it('rolls back the domain write, revision, and event when receipt persistence fails', async () => {
    const db = openRawDatabase()
    try {
      db.exec(`
        CREATE TRIGGER fail_command_mutation_receipt_insert
        BEFORE INSERT ON command_mutation_receipts
        BEGIN
          SELECT RAISE(FAIL, 'injected receipt persistence failure');
        END;
      `)
    } finally {
      db.close()
    }

    const failed = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'atomic-write',
        'risu-database-lineage': databaseLineage,
      },
      payload: { baseRevision: revision, patch: { theme: 'light' } },
    })
    expect(failed.statusCode).toBe(500)
    expect(readSettings().theme).toBe('dark')
    expect(harness.commandEvents.list()).toHaveLength(0)
    expect(receiptCount()).toBe(0)

    const after = openRawDatabase()
    try {
      expect(getSchemaState(after).revision).toBe(revision)
      expect(after.prepare('SELECT COUNT(*) AS count FROM command_events').get()).toMatchObject({ count: 1 })
    } finally {
      after.close()
    }
  })

  it('threads receipts through model-profile and Agent Preset command wrappers', async () => {
    const profile = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'profile-create',
        'risu-database-lineage': databaseLineage,
      },
      payload: {
        baseRevision: revision,
        profile: { name: 'Durable profile', providerId: 'openai', modelId: 'gpt-5' },
      },
    })
    expect(profile.statusCode, profile.body).toBe(200)
    const profileBody = profile.json() as Record<string, unknown>
    const profileRevision = profileBody.revision as number

    const profileReplay = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/model-profiles',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'profile-create',
        'risu-database-lineage': databaseLineage,
      },
      payload: {
        baseRevision: profileRevision,
        profile: { name: 'Durable profile', providerId: 'openai', modelId: 'gpt-5' },
      },
    })
    expect(profileReplay.statusCode, profileReplay.body).toBe(200)
    expect(profileReplay.json()).toEqual(profileBody)

    const preset = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'agent-preset-create',
        'risu-database-lineage': databaseLineage,
      },
      payload: {
        baseRevision: profileRevision,
        preset: { name: 'Durable agent preset' },
      },
    })
    expect(preset.statusCode, preset.body).toBe(200)
    const presetBody = preset.json() as Record<string, unknown>

    const presetReplay = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'writer-a',
        'risu-mutation-id': 'agent-preset-create',
        'risu-database-lineage': databaseLineage,
      },
      payload: {
        baseRevision: presetBody.revision as number,
        preset: { name: 'Durable agent preset' },
      },
    })
    expect(presetReplay.statusCode, presetReplay.body).toBe(200)
    expect(presetReplay.json()).toEqual(presetBody)

    const settings = readSettings()
    expect(settings.modelProfiles).toHaveLength(1)
    expect(settings.agentPresets).toHaveLength(1)
    expect(receiptCount()).toBe(2)
  })
})
