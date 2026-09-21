import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { openDatabase } from '../src/db.js'
import { addAlternateMessage } from '../src/messageStore.js'
import {
  createMemoryChunk,
  createMemoryJob,
  createMemorySummary,
  listMemoryChunks,
  listMemoryJobs,
} from '../src/memoryRepository.js'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  readAllDatabaseRows,
  startHarness,
  stopHarness,
  importDatabase,
  readJsonRow,
  persistedChatMessages,
  projectedCharacterRow,
} from './helpers/commandHarness.js'

async function persistedChatAlternates(
  app: FastifyInstance,
  assertion: string,
  chatId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    headers: { 'risu-auth': assertion },
  })
  expect(res.statusCode).toBe(200)
  return res.json().alternates as Array<Record<string, unknown>>
}

let harness: Harness

describe('surgical message writes', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  function messageRowids(dataDir: string, chatId: string): { seq: number; rowid: number }[] {
    const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
    try {
      return db.prepare('SELECT rowid, seq FROM messages WHERE chat_id = ? ORDER BY seq').all(chatId) as {
        seq: number
        rowid: number
      }[]
    } finally {
      db.close()
    }
  }

  async function seedTwoChats(assertion: string): Promise<number> {
    return importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A',
              note: '',
              localLore: [],
              message: [{ role: 'user', data: 'a1', chatId: 'a1' }],
            },
            {
              id: 'chat-b',
              name: 'B',
              note: '',
              localLore: [],
              message: [{ role: 'user', data: 'b1', chatId: 'b1' }],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
  }

  it('appends one row to the target chat without rewriting an unrelated chat', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await seedTwoChats(assertion)
    const chatBBefore = messageRowids(harness.dataDir, 'chat-b')
    const chatABefore = messageRowids(harness.dataDir, 'chat-a')

    const appended = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, message: { role: 'char', data: 'a2', chatId: 'a2' } },
    })
    expect(appended.statusCode).toBe(200)

    // chat-b is physically untouched (same rowids); chat-a kept its existing
    // row and gained exactly one (no whole-chat rewrite).
    expect(messageRowids(harness.dataDir, 'chat-b')).toEqual(chatBBefore)
    const chatAAfter = messageRowids(harness.dataDir, 'chat-a')
    expect(chatAAfter.slice(0, chatABefore.length)).toEqual(chatABefore)
    expect(chatAAfter).toHaveLength(chatABefore.length + 1)
  })

  async function seedGeneratedMessage(assertion: string): Promise<number> {
    return importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A',
              note: '',
              localLore: [],
              message: [
                {
                  role: 'char',
                  data: '<ImgGen="cat">',
                  chatId: 'message-a',
                  generationInfo: { generationId: 'generation-a' },
                },
              ],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
  }

  it.each([
    ['text', { expectedData: 'different source' }],
    ['chat', { expectedChatId: 'other-chat' }],
    ['generation', { expectedGenerationId: 'other-generation' }],
  ] as const)(
    'rejects a mismatched finalization %s without changing messages, revision, or events',
    async (_name, mismatch) => {
      const { assertion } = await setupAuthedClient(harness.app)
      const revision = await seedGeneratedMessage(assertion)
      harness.commandEvents.clear()
      const before = readAllDatabaseRows(harness.dataDir)

      const rejected = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/messages/message-a',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          patch: { data: '{{inlay::asset-stale}}' },
          expectedData: '<ImgGen="cat">',
          expectedChatId: 'chat-a',
          expectedGenerationId: 'generation-a',
          ...mismatch,
        },
      })

      expect(rejected.statusCode).toBe(400)
      expect(readAllDatabaseRows(harness.dataDir)).toEqual(before)
      expect(harness.commandEvents.list()).toEqual([])
    },
  )

  it('conditionally finalizes a generated message only while its owner, generation, and text still match', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await seedGeneratedMessage(assertion)

    const finalized = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/message-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { data: '{{inlay::asset-a}}' },
        expectedData: '<ImgGen="cat">',
        expectedChatId: 'chat-a',
        expectedGenerationId: 'generation-a',
      },
    })
    expect(finalized.statusCode).toBe(200)
    expect(finalized.json().revision).toBe(revision + 1)
    const beforeStaleFinalization = readAllDatabaseRows(harness.dataDir)
    harness.commandEvents.clear()

    const staleFinalization = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/message-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: finalized.json().revision,
        patch: { data: '{{inlay::asset-stale}}' },
        expectedData: '<ImgGen="cat">',
        expectedChatId: 'chat-a',
        expectedGenerationId: 'generation-a',
      },
    })
    expect(staleFinalization.statusCode).toBe(400)
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(beforeStaleFinalization)
    expect(harness.commandEvents.list()).toEqual([])
    expect((await persistedChatMessages(harness.app, assertion, 'chat-a'))[0].data).toBe('{{inlay::asset-a}}')
  })

  it(
    'updates, deletes, truncates, and replaces target chat rows without touching unrelated chats',
    { tags: 'core' },
    async () => {
      const { assertion } = await setupAuthedClient(harness.app)
      let revision = await importDatabase(harness.app, assertion, {
        characters: [
          {
            chaId: 'char-a',
            name: 'A',
            chats: [
              {
                id: 'chat-a',
                name: 'A',
                note: '',
                localLore: [],
                bookmarks: ['msg-a1', 'msg-a2', 'msg-a3'],
                bookmarkNames: { 'msg-a1': 'One', 'msg-a2': 'Two', 'msg-a3': 'Three' },
                message: [
                  { role: 'user', data: 'a1', chatId: 'msg-a1' },
                  { role: 'char', data: 'a2', chatId: 'msg-a2' },
                  { role: 'user', data: 'a3', chatId: 'msg-a3' },
                ],
              },
              {
                id: 'chat-b',
                name: 'B',
                note: '',
                localLore: [],
                message: [
                  { role: 'user', data: 'b1', chatId: 'msg-b1' },
                  { role: 'char', data: 'b2', chatId: 'msg-b2' },
                ],
              },
            ],
            chatFolders: [],
            chatPage: 0,
          },
        ],
        characterOrder: ['char-a'],
      })
      const chatBBefore = messageRowids(harness.dataDir, 'chat-b')
      const chatABefore = messageRowids(harness.dataDir, 'chat-a')

      const updated = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/messages/msg-a2',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, patch: { data: 'a2 updated', disabled: true } },
      })
      expect(updated.statusCode).toBe(200)
      revision = updated.json().revision
      expect(messageRowids(harness.dataDir, 'chat-b')).toEqual(chatBBefore)
      expect(messageRowids(harness.dataDir, 'chat-a')).toEqual(chatABefore)

      const deleted = await harness.app.inject({
        method: 'DELETE',
        url: '/api/v1/commands/messages/msg-a2',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision },
      })
      expect(deleted.statusCode).toBe(200)
      revision = deleted.json().revision
      expect(messageRowids(harness.dataDir, 'chat-b')).toEqual(chatBBefore)
      const afterDelete = messageRowids(harness.dataDir, 'chat-a')
      expect(afterDelete).toHaveLength(2)
      expect(afterDelete[0]).toEqual(chatABefore[0])
      expect(afterDelete.map((row) => row.seq)).toEqual([0, 1])
      expect((await persistedChatMessages(harness.app, assertion, 'chat-a')).map((m) => m.chatId)).toEqual([
        'msg-a1',
        'msg-a3',
      ])
      expect(readJsonRow(harness.dataDir, 'chats', 'chat-a')).toMatchObject({
        bookmarks: ['msg-a1', 'msg-a3'],
        bookmarkNames: { 'msg-a1': 'One', 'msg-a3': 'Three' },
      })

      const appended = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/commands/chats/chat-a/messages',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          message: { role: 'char', data: 'a4', chatId: 'msg-a4' },
        },
      })
      expect(appended.statusCode).toBe(200)
      revision = appended.json().revision

      const beforeTruncate = messageRowids(harness.dataDir, 'chat-a')
      const truncated = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/commands/chats/chat-a/messages/truncate',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, afterMessageId: 'msg-a1' },
      })
      expect(truncated.statusCode).toBe(200)
      revision = truncated.json().revision
      expect(messageRowids(harness.dataDir, 'chat-b')).toEqual(chatBBefore)
      const afterTruncate = messageRowids(harness.dataDir, 'chat-a')
      expect(afterTruncate).toEqual([beforeTruncate[0]])
      expect(readJsonRow(harness.dataDir, 'chats', 'chat-a')).toMatchObject({
        bookmarks: ['msg-a1'],
        bookmarkNames: { 'msg-a1': 'One' },
      })

      const replaced = await harness.app.inject({
        method: 'PUT',
        url: '/api/v1/commands/chats/chat-a/messages',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          messages: [
            { role: 'user', data: 'a1', chatId: 'msg-a1' },
            { role: 'char', data: 'a5', chatId: 'msg-a5' },
            { role: 'user', data: 'a6', chatId: 'msg-a6' },
          ],
        },
      })
      expect(replaced.statusCode).toBe(200)
      expect(messageRowids(harness.dataDir, 'chat-b')).toEqual(chatBBefore)
      const afterReplace = messageRowids(harness.dataDir, 'chat-a')
      expect(afterReplace).toHaveLength(3)
      expect(afterReplace[0]).toEqual(afterTruncate[0])
      expect(afterReplace.map((row) => row.seq)).toEqual([0, 1, 2])
      expect((await persistedChatMessages(harness.app, assertion, 'chat-a')).map((m) => m.chatId)).toEqual([
        'msg-a1',
        'msg-a5',
        'msg-a6',
      ])
      expect(readJsonRow(harness.dataDir, 'chats', 'chat-a')).toMatchObject({
        bookmarks: ['msg-a1'],
        bookmarkNames: { 'msg-a1': 'One' },
      })
    },
  )

  it('a non-message command writes nothing to the messages table', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await seedTwoChats(assertion)
    const before = readAllDatabaseRows(harness.dataDir).messages
    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      // Persistent triggers observe the app's separate SQLite connection and
      // catch even UPDATEs that leave both content and rowids unchanged.
      db.exec('CREATE TABLE message_write_audit (operation TEXT NOT NULL)')
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        db.exec(`
          CREATE TRIGGER audit_message_${operation.toLowerCase()} AFTER ${operation} ON messages
          BEGIN
            INSERT INTO message_write_audit (operation) VALUES ('${operation}');
          END;
        `)
      }
    } finally {
      db.close()
    }

    const persona = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/personas',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        persona: { id: 'persona-p', name: 'P', personaPrompt: 'hi', note: '' },
      },
    })
    expect(persona.statusCode).toBe(200)

    const after = readAllDatabaseRows(harness.dataDir)
    expect(after.messages).toEqual(before)
    expect(after.message_write_audit).toEqual([])
  })

  it('deleting a chat drops its message rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await seedTwoChats(assertion)
    expect(messageRowids(harness.dataDir, 'chat-b')).toHaveLength(1)

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/chats/chat-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    expect(deleted.statusCode).toBe(200)
    expect(messageRowids(harness.dataDir, 'chat-b')).toEqual([])
    expect(messageRowids(harness.dataDir, 'chat-a')).toHaveLength(1)
  })
})

describe('message history commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('appends, updates, deletes, truncates, and replaces messages by id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'hello', chatId: 'msg-a' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const appended = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        message: { role: 'char', data: 'hi', chatId: 'msg-b' },
      },
    })
    expect(appended.statusCode).toBe(200)
    expect(appended.json()).toEqual({
      revision: 2,
      event: {
        type: 'message.appended',
        revision: 2,
        resource: 'message',
        id: 'msg-b',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      messageId: 'msg-b',
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: appended.json().revision,
        patch: {
          data: 'hi there',
          disabled: true,
          name: 'Assistant',
          promptInfo: { promptName: 'Preset' },
        },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      revision: 3,
      event: {
        type: 'message.updated',
        resource: 'message',
        id: 'msg-b',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      messageId: 'msg-b',
    })

    const replaced = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        messages: [
          { role: 'user', data: 'one', chatId: 'msg-1' },
          { role: 'char', data: 'two', chatId: 'msg-2', generationInfo: { model: 'm' } },
          { role: 'user', data: 'three', chatId: 'msg-3' },
        ],
      },
    })
    expect(replaced.statusCode).toBe(200)
    expect(replaced.json()).toMatchObject({
      revision: 4,
      event: {
        type: 'messages.replaced',
        resource: 'message',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
    })

    const truncated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/truncate',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: replaced.json().revision,
        afterMessageId: 'msg-1',
      },
    })
    expect(truncated.statusCode).toBe(200)
    expect(truncated.json()).toMatchObject({
      revision: 5,
      event: {
        type: 'message.truncated',
        resource: 'message',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      afterMessageId: 'msg-1',
      removedCount: 2,
    })

    const appendedAgain = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: truncated.json().revision,
        message: { role: 'char', data: 'tail', chatId: 'msg-tail' },
      },
    })
    expect(appendedAgain.statusCode).toBe(200)

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/messages/msg-tail',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: appendedAgain.json().revision },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: 7,
      event: {
        type: 'message.deleted',
        resource: 'message',
        id: 'msg-tail',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      messageId: 'msg-tail',
    })

    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      { role: 'user', data: 'one', chatId: 'msg-1' },
    ])
  })

  it('invalidates unsummarized chunks and their jobs when persisted message content changes', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'stale source', chatId: 'msg-a' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const db = openDatabase(harness.dataDir)
    try {
      createMemoryChunk(db, {
        id: 'chunk-stale',
        chatId: 'chat-a',
        messageId: 'msg-a',
        rangeStartSeq: 0,
        rangeEndSeq: 0,
        text: 'user: stale source',
      })
      createMemoryJob(db, {
        id: 'job-stale',
        chatId: 'chat-a',
        kind: 'summarize',
        status: 'failed',
        payload: { chunkId: 'chunk-stale', model: 'memory' },
      })
      createMemoryChunk(db, {
        id: 'chunk-summarized',
        chatId: 'chat-a',
        messageId: 'msg-a',
        rangeStartSeq: 0,
        rangeEndSeq: 0,
        text: 'user: summarized source',
        status: 'summarized',
      })
      createMemorySummary(db, {
        id: 'summary-keep',
        chatId: 'chat-a',
        chunkId: 'chunk-summarized',
        model: 'memory',
        text: 'retained summary',
        tokens: 2,
      })
      createMemoryJob(db, {
        id: 'job-summarized',
        chatId: 'chat-a',
        kind: 'summarize',
        status: 'completed',
        payload: { chunkId: 'chunk-summarized', model: 'memory' },
      })
      createMemoryChunk(db, {
        id: 'chunk-other-chat',
        chatId: 'chat-other',
        messageId: 'msg-other',
        rangeStartSeq: 0,
        rangeEndSeq: 0,
        text: 'user: other chat',
      })
      createMemoryJob(db, {
        id: 'job-other-chat',
        chatId: 'chat-other',
        kind: 'summarize',
        status: 'failed',
        payload: { chunkId: 'chunk-other-chat', model: 'memory' },
      })
    } finally {
      db.close()
    }

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { data: 'fresh source' } },
    })
    expect(updated.statusCode).toBe(200)

    const updatedDb = openDatabase(harness.dataDir)
    try {
      expect(listMemoryChunks(updatedDb, { chatId: 'chat-a' }).map((chunk) => chunk.id)).toEqual(['chunk-summarized'])
      expect(listMemoryJobs(updatedDb, { chatId: 'chat-a' }).map((job) => job.id)).toEqual(['job-summarized'])
      expect(listMemoryChunks(updatedDb, { chatId: 'chat-other' }).map((chunk) => chunk.id)).toEqual([
        'chunk-other-chat',
      ])
      expect(listMemoryJobs(updatedDb, { chatId: 'chat-other' }).map((job) => job.id)).toEqual(['job-other-chat'])
    } finally {
      updatedDb.close()
    }
  })

  it('requires truncate and tail anchors to be present while accepting explicit null', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'one', chatId: 'msg-1' },
                { role: 'char', data: 'two', chatId: 'msg-2' },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const omittedTruncate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/truncate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    expect(omittedTruncate.statusCode).toBe(400)
    expect(omittedTruncate.json().error).toBe('afterMessageId is required')

    const omittedTail = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/tail',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, messages: [] },
    })
    expect(omittedTail.statusCode).toBe(400)
    expect(omittedTail.json().error).toBe('afterMessageId is required')
    expect((await persistedChatMessages(harness.app, assertion, 'chat-a')).map((message) => message.chatId)).toEqual([
      'msg-1',
      'msg-2',
    ])

    const explicitNull = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/truncate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, afterMessageId: null },
    })
    expect(explicitNull.statusCode).toBe(200)
    expect(explicitNull.json()).toMatchObject({
      afterMessageId: null,
      removedCount: 2,
    })
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([])
  })

  it('rejects ambiguous duplicate UIDs for truncate, tail replacement, and generation results', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'first', chatId: 'duplicate-id' },
                { role: 'char', data: 'second', chatId: 'original-second-id' },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const db = openDatabase(harness.dataDir)
    try {
      const row = db.prepare("SELECT json FROM messages WHERE chat_id = 'chat-a' AND seq = 1").get() as {
        json: string
      }
      const message = JSON.parse(row.json) as Record<string, unknown>
      message.chatId = 'duplicate-id'
      db.prepare("UPDATE messages SET uid = 'duplicate-id', json = ? WHERE chat_id = 'chat-a' AND seq = 1").run(
        JSON.stringify(message),
      )
    } finally {
      db.close()
    }

    const truncate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/truncate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, afterMessageId: 'duplicate-id' },
    })
    expect(truncate.statusCode).toBe(400)
    expect(truncate.json().error).toBe('Ambiguous message id: duplicate-id')

    const tail = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/tail',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, afterMessageId: 'duplicate-id', messages: [] },
    })
    expect(tail.statusCode).toBe(400)
    expect(tail.json().error).toBe('Ambiguous message id: duplicate-id')

    const generation = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          message: {
            role: 'char',
            data: 'collision',
            chatId: 'duplicate-id',
            promptInfo: {},
            generationInfo: { generationId: 'duplicate-id' },
          },
        },
      },
    })
    expect(generation.statusCode).toBe(400)
    expect(generation.json().error).toBe('Ambiguous message id: duplicate-id')
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      { role: 'user', data: 'first', chatId: 'duplicate-id' },
      { role: 'char', data: 'second', chatId: 'duplicate-id' },
    ])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
  })

  it('rejects retired reroll-preserving truncates and leaves ordinary truncation destructive', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'one', chatId: 'msg-1' },
                { role: 'char', data: 'two', chatId: 'msg-2', generationInfo: { model: 'm' } },
                { role: 'user', data: 'three', chatId: 'msg-3' },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const retired = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/truncate',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        afterMessageId: 'msg-1',
        preserveRemovedAsAlternates: true,
      },
    })
    expect(retired.statusCode).toBe(400)
    expect(retired.json().error).toBe('preserveRemovedAsAlternates is no longer supported')
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toHaveLength(3)

    const truncated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/truncate',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        afterMessageId: 'msg-1',
      },
    })

    expect(truncated.statusCode).toBe(200)
    expect(truncated.json()).toMatchObject({
      revision: 2,
      chatId: 'chat-a',
      afterMessageId: 'msg-1',
      removedCount: 2,
    })
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      { role: 'user', data: 'one', chatId: 'msg-1' },
    ])
    expect(await persistedChatAlternates(harness.app, assertion, 'chat-a')).toEqual([])
  })

  it('replaces only the requested message tail', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'one', chatId: 'msg-1' },
                { role: 'char', data: 'two', chatId: 'msg-2' },
                { role: 'user', data: 'three', chatId: 'msg-3' },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const tailReplaced = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages/tail',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        afterMessageId: 'msg-1',
        messages: [
          { role: 'char', data: 'two alt', chatId: 'msg-2b', generationInfo: { model: 'm' } },
          { role: 'user', data: 'three alt', chatId: 'msg-3b' },
        ],
      },
    })

    expect(tailReplaced.statusCode).toBe(200)
    expect(tailReplaced.json()).toMatchObject({
      revision: 2,
      event: {
        type: 'messages.replaced',
        resource: 'message',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      afterMessageId: 'msg-1',
      replacedCount: 2,
    })
    expect(tailReplaced.json()).not.toHaveProperty('messageIds')
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      { role: 'user', data: 'one', chatId: 'msg-1' },
      { role: 'char', data: 'two alt', chatId: 'msg-2b', generationInfo: { model: 'm' } },
      { role: 'user', data: 'three alt', chatId: 'msg-3b' },
    ])
  })

  it('normalizes missing message ids and rejects malformed message commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'missing id' },
                { role: 'char', data: 'duplicate a', chatId: 'dup' },
                { role: 'user', data: 'duplicate b', chatId: 'dup' },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const duplicateReplacement = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        messages: [
          { role: 'user', data: 'a', chatId: 'same' },
          { role: 'char', data: 'b', chatId: 'same' },
        ],
      },
    })
    expect(duplicateReplacement.statusCode).toBe(400)
    expect(duplicateReplacement.json().error).toBe('Duplicate message id: same')

    const missingAppendId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        message: { role: 'user', data: 'missing id' },
      },
    })
    expect(missingAppendId.statusCode).toBe(400)
    expect(missingAppendId.json().error).toBe('message.chatId must be a non-empty string')

    const missingReplacementId = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        messages: [{ role: 'user', data: 'missing id' }],
      },
    })
    expect(missingReplacementId.statusCode).toBe(400)
    expect(missingReplacementId.json().error).toBe('messages[0].chatId must be a non-empty string')

    const badPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/dup',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { generationInfo: { model: 'later-slice' } },
      },
    })
    expect(badPatch.statusCode).toBe(400)
    expect(badPatch.json().error).toBe('patch.generationInfo is not supported for message commands')

    const badTranslationPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/dup',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { translation: { text: 1 } },
      },
    })
    expect(badTranslationPatch.statusCode).toBe(400)
    expect(badTranslationPatch.json().error).toBe('patch.translation.text must be a string')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    const messages = await persistedChatMessages(harness.app, assertion, 'chat-a')
    expect(messages.map((message) => (message as any).data)).toEqual(['missing id', 'duplicate a', 'duplicate b'])
    expect(messages.map((message) => (message as any).chatId)).toHaveLength(3)
    expect(new Set(messages.map((message) => (message as any).chatId)).size).toBe(3)
  })

  it('repairs imported duplicate message ids across chats and updates local references', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'a', chatId: 'msg-shared' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [
            {
              id: 'chat-b',
              name: 'B chat',
              note: '',
              message: [{ role: 'char', data: 'b', chatId: 'msg-shared' }],
              bookmarks: ['msg-shared'],
              bookmarkNames: { 'msg-shared': 'Pinned' },
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    const charB = (await projectedCharacterRow(harness.app, assertion, 'char-b')) as {
      chats: Array<{ bookmarks?: unknown; bookmarkNames?: unknown }>
    }
    const chatAMessages = await persistedChatMessages(harness.app, assertion, 'chat-a')
    const chatBMessages = await persistedChatMessages(harness.app, assertion, 'chat-b')
    const renamedMessageId = chatBMessages[0].chatId as string
    expect(chatAMessages[0].chatId).toBe('msg-shared')
    expect(renamedMessageId).not.toBe('msg-shared')
    expect(typeof renamedMessageId).toBe('string')
    // The import's cross-chat uid repair also rewrote chat-b's bookmarks
    // (metadata) to the renamed id — verified against the hydrated character
    // row because bootstrap now shells inactive characters.
    expect(charB.chats[0].bookmarks).toEqual([renamedMessageId])
    expect(charB.chats[0].bookmarkNames).toEqual({ [renamedMessageId]: 'Pinned' })
  })

  it('rejects message ids already used by another chat without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'hello', chatId: 'msg-a' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [
            {
              id: 'chat-b',
              name: 'B chat',
              note: '',
              message: [{ role: 'user', data: 'hi', chatId: 'msg-b' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })

    const duplicateAppend = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-b/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        message: { role: 'char', data: 'duplicate append', chatId: 'msg-a' },
      },
    })
    expect(duplicateAppend.statusCode).toBe(400)
    expect(duplicateAppend.json().error).toBe('Duplicate message id: msg-a')

    const duplicateReplace = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-b/messages',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        messages: [{ role: 'char', data: 'duplicate replace', chatId: 'msg-a' }],
      },
    })
    expect(duplicateReplace.statusCode).toBe(400)
    expect(duplicateReplace.json().error).toBe('Duplicate message id: msg-a')

    const duplicateGeneration = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-b/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          targetMessageId: 'msg-b',
          message: {
            role: 'char',
            data: 'duplicate generation',
            chatId: 'msg-a',
            generationInfo: { generationId: 'gen-a' },
            promptInfo: { promptName: 'Preset' },
          },
        },
      },
    })
    expect(duplicateGeneration.statusCode).toBe(400)
    expect(duplicateGeneration.json().error).toBe('Duplicate message id: msg-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    const chatAMessages = await persistedChatMessages(harness.app, assertion, 'chat-a')
    const chatBMessages = await persistedChatMessages(harness.app, assertion, 'chat-b')
    expect([...chatAMessages, ...chatBMessages].map((message) => message.chatId)).toEqual(['msg-a', 'msg-b'])
  })

  it('returns 404 and 409 for missing messages and stale message revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'hello', chatId: 'msg-a' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/missing',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { data: 'Nope' },
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Message not found: missing')

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/messages/msg-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
        patch: { data: 'Stale' },
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('generation persistence command', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('persists generated assistant rows by appending or replacing the target message', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'hello', chatId: 'msg-a' },
                { role: 'char', data: 'old tail', chatId: 'msg-old' },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const appended = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          message: {
            role: 'char',
            data: 'fresh answer',
            chatId: 'gen-1',
            promptInfo: { promptName: 'Preset' },
            generationInfo: { generationId: 'gen-1', model: 'echo_model' },
          },
        },
      },
    })
    expect(appended.statusCode).toBe(200)
    expect(appended.json()).toEqual({
      revision: 2,
      event: {
        type: 'generation.persisted',
        revision: 2,
        resource: 'generation',
        id: 'gen-1',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      messageId: 'gen-1',
    })

    const repeated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: appended.json().revision,
        generationResult: {
          message: {
            role: 'char',
            data: 'fresh answer replay',
            chatId: 'gen-1',
            promptInfo: { promptName: 'Preset' },
            generationInfo: { generationId: 'gen-1', model: 'echo_model' },
          },
        },
      },
    })
    expect(repeated.statusCode).toBe(200)
    expect((await persistedChatMessages(harness.app, assertion, 'chat-a')).map((m) => m.chatId)).toEqual([
      'msg-a',
      'msg-old',
      'gen-1',
    ])

    const replaced = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: repeated.json().revision,
        generationResult: {
          targetMessageId: 'msg-old',
          message: {
            role: 'char',
            data: 'continued answer',
            chatId: 'gen-2',
            promptInfo: { promptName: 'Preset' },
            generationInfo: {
              generationId: 'gen-2',
              model: 'echo_model',
              stageTiming: { stage4: 3 },
            },
          },
        },
      },
    })
    expect(replaced.statusCode).toBe(200)
    expect(replaced.json()).toMatchObject({
      revision: 4,
      event: {
        type: 'generation.persisted',
        resource: 'generation',
        id: 'gen-2',
        parentId: 'chat-a',
      },
      chatId: 'chat-a',
      messageId: 'gen-2',
    })

    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([
      { role: 'user', data: 'hello', chatId: 'msg-a' },
      {
        role: 'char',
        data: 'continued answer',
        chatId: 'gen-2',
        promptInfo: { promptName: 'Preset' },
        generationInfo: {
          generationId: 'gen-2',
          model: 'echo_model',
          stageTiming: { stage4: 3 },
        },
      },
      {
        role: 'char',
        data: 'fresh answer replay',
        chatId: 'gen-1',
        promptInfo: { promptName: 'Preset' },
        generationInfo: { generationId: 'gen-1', model: 'echo_model' },
      },
    ])
    expect(harness.commandEvents.list().at(-1)).toMatchObject({
      type: 'generation.persisted',
      revision: 4,
      resource: 'generation',
      id: 'gen-2',
      parentId: 'chat-a',
    })
  })

  it('preserves a targetless same-UID displaced row and the existing alternate buffer', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [
                { role: 'user', data: 'hello', chatId: 'msg-a' },
                {
                  role: 'char',
                  data: 'displaced answer',
                  chatId: 'generation-id',
                  promptInfo: { promptName: 'Old preset' },
                  generationInfo: { generationId: 'generation-id', model: 'old-model' },
                },
              ],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const db = openDatabase(harness.dataDir)
    try {
      addAlternateMessage(db, 'chat-a', {
        role: 'char',
        data: 'pre-existing alternate',
        chatId: 'pre-existing-alternate',
      })
    } finally {
      db.close()
    }

    const result = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          message: {
            role: 'char',
            data: 'replacement answer',
            chatId: 'generation-id',
            promptInfo: { promptName: 'New preset' },
            generationInfo: { generationId: 'generation-id', model: 'new-model' },
          },
        },
      },
    })

    expect(result.statusCode).toBe(200)
    expect((await persistedChatMessages(harness.app, assertion, 'chat-a')).at(-1)).toEqual({
      role: 'char',
      data: 'replacement answer',
      chatId: 'generation-id',
      promptInfo: { promptName: 'New preset' },
      generationInfo: { generationId: 'generation-id', model: 'new-model' },
    })
    expect(await persistedChatAlternates(harness.app, assertion, 'chat-a')).toEqual(
      expect.arrayContaining([
        {
          role: 'char',
          data: 'displaced answer',
          chatId: 'generation-id',
          promptInfo: { promptName: 'Old preset' },
          generationInfo: { generationId: 'generation-id', model: 'old-model' },
        },
        {
          role: 'char',
          data: 'pre-existing alternate',
          chatId: 'pre-existing-alternate',
        },
      ]),
    )
  })

  it('rejects malformed generation results without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const badRole = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          message: {
            role: 'user',
            data: 'not an assistant',
            chatId: 'gen-1',
            generationInfo: { generationId: 'gen-1' },
          },
        },
      },
    })
    expect(badRole.statusCode).toBe(400)
    expect(badRole.json().error).toBe('generationResult.message.role must be char')

    const missingInfo = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          message: { role: 'char', data: 'missing metadata', chatId: 'gen-1' },
        },
      },
    })
    expect(missingInfo.statusCode).toBe(400)
    expect(missingInfo.json().error).toBe('generationResult.message.generationInfo is required')

    const missingMessageId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          message: {
            role: 'char',
            data: 'missing id',
            generationInfo: { generationId: 'gen-1' },
          },
        },
      },
    })
    expect(missingMessageId.statusCode).toBe(400)
    expect(missingMessageId.json().error).toBe('generationResult.message.chatId must be a non-empty string')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(await persistedChatMessages(harness.app, assertion, 'chat-a')).toEqual([])
  })

  it('returns 404 and 409 for missing generation targets and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'hello', chatId: 'msg-a' }],
              localLore: [],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const missingChat = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/missing/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          message: {
            role: 'char',
            data: 'answer',
            chatId: 'gen-1',
            generationInfo: { generationId: 'gen-1' },
          },
        },
      },
    })
    expect(missingChat.statusCode).toBe(404)
    expect(missingChat.json().error).toBe('Chat not found: missing')

    const missingMessage = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        generationResult: {
          targetMessageId: 'missing-message',
          message: {
            role: 'char',
            data: 'answer',
            chatId: 'gen-1',
            generationInfo: { generationId: 'gen-1' },
          },
        },
      },
    })
    expect(missingMessage.statusCode).toBe(404)
    expect(missingMessage.json().error).toBe('Message not found for chat chat-a: missing-message')

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/generation-result',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
        generationResult: {
          message: {
            role: 'char',
            data: 'answer',
            chatId: 'gen-1',
            generationInfo: { generationId: 'gen-1' },
          },
        },
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})
