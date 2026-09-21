import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { activeMessageRowids } from './helpers/rowStability.js'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  startHarness,
  stopHarness,
  loadPersistedFromDir,
  importDatabase,
  persistedChatMessages,
} from './helpers/commandHarness.js'

let harness: Harness

describe('chat record and folder commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('creates, updates, forks, reorders, and deletes chats and chat folders by id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            { id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] },
            {
              id: 'chat-b',
              name: 'B chat',
              note: '',
              message: [],
              localLore: [],
              folderId: 'folder-a',
            },
          ],
          chatFolders: [{ id: 'folder-a', name: 'Folder A', folded: false }],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-c',
          name: 'C chat',
          note: '',
          message: [{ role: 'user', data: 'created hello', chatId: 'msg-created' }],
          localLore: [],
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      revision: 2,
      event: {
        type: 'chat.created',
        revision: 2,
        resource: 'chatTranscript',
        id: 'chat-c',
        parentId: 'char-a',
      },
      chatId: 'chat-c',
      selectedChatId: 'chat-c',
      generationSettings: null,
    })
    await expect(persistedChatMessages(harness.app, assertion, 'chat-c')).resolves.toEqual([
      { role: 'user', data: 'created hello', chatId: 'msg-created' },
    ])
    const createdBootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const createdCharacter = createdBootstrap.resourceDatabase.characters[0]
    expect(createdCharacter.chatPage).toBe(0)
    expect(createdCharacter.chats.map((chat: { id: string }) => chat.id)).toEqual(['chat-c', 'chat-a', 'chat-b'])

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-c',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: {
          name: 'C renamed',
          note: 'Author note',
          bookmarks: ['msg-a'],
          bookmarkNames: { 'msg-a': 'Pinned' },
          pinned: true,
        },
        select: true,
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      revision: 3,
      event: {
        type: 'chat.updated',
        // Chat metadata lives in one character row, so a foreign refresh ships
        // just the containing character (per-character `characterRow` branch).
        resource: 'characterRow',
        id: 'chat-c',
        parentId: 'char-a',
      },
      chatId: 'chat-c',
      selectedChatId: 'chat-c',
    })

    const forked = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        sourcePatch: { folderId: 'folder-a' },
        chat: {
          id: 'chat-fork',
          name: 'A branch',
          note: '',
          message: [{ role: 'char', data: 'branch marker', chatId: 'msg-branch' }],
          localLore: [],
          folderId: 'folder-a',
        },
      },
    })
    expect(forked.statusCode).toBe(200)
    expect(forked.json()).toMatchObject({
      revision: 4,
      event: {
        type: 'chat.forked',
        resource: 'chatTranscript',
        id: 'chat-fork',
        parentId: 'char-a',
      },
      chatId: 'chat-fork',
      sourceChatId: 'chat-a',
      selectedChatId: 'chat-fork',
    })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: forked.json().revision,
        chatIds: ['chat-a', 'chat-fork', 'chat-c', 'chat-b'],
        folderByChatId: {
          'chat-a': 'folder-a',
          'chat-fork': 'folder-a',
          'chat-c': null,
          'chat-b': 'folder-a',
        },
        selectedChatId: 'chat-c',
      },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json()).toMatchObject({
      revision: 5,
      event: {
        type: 'chat.reordered',
        resource: 'characterRow',
        parentId: 'char-a',
      },
      selectedChatId: 'chat-c',
    })

    const folderCreated = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chat-folders',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: reordered.json().revision,
        folder: { id: 'folder-b', name: 'Folder B', color: 'blue', folded: false },
      },
    })
    expect(folderCreated.statusCode).toBe(200)
    expect(folderCreated.json().event).toMatchObject({
      type: 'chatFolder.created',
      resource: 'characterRow',
      id: 'folder-b',
      parentId: 'char-a',
    })
    const folderUpdated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chat-folders/folder-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: folderCreated.json().revision,
        patch: { name: 'Folder B renamed', folded: true },
      },
    })
    expect(folderUpdated.statusCode).toBe(200)
    expect(folderUpdated.json().event).toMatchObject({
      type: 'chatFolder.updated',
      resource: 'characterRow',
      id: 'folder-b',
      parentId: 'char-a',
    })

    const foldersReordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chat-folders/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: folderUpdated.json().revision,
        folderIds: ['folder-a', 'folder-b'],
        selectedChatId: 'chat-c',
      },
    })
    expect(foldersReordered.statusCode).toBe(200)
    expect(foldersReordered.json().event).toMatchObject({
      type: 'chatFolder.reordered',
      resource: 'characterRow',
      parentId: 'char-a',
    })

    const folderDeleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/chat-folders/folder-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: foldersReordered.json().revision },
    })
    expect(folderDeleted.statusCode).toBe(200)
    expect(folderDeleted.json().event).toMatchObject({
      type: 'chatFolder.deleted',
      resource: 'characterRow',
      id: 'folder-a',
      parentId: 'char-a',
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/chats/chat-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: folderDeleted.json().revision },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: 10,
      event: {
        type: 'chat.deleted',
        resource: 'characterRow',
        id: 'chat-b',
        parentId: 'char-a',
      },
      chatId: 'chat-b',
      selectedChatId: 'chat-c',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const character = bootstrap.resourceDatabase.characters[0]
    expect(character.chatPage).toBe(2)
    expect(character.chats.map((chat: { id: string }) => chat.id)).toEqual(['chat-a', 'chat-fork', 'chat-c'])
    expect(character.chats.map((chat: { folderId?: string | null }) => chat.folderId ?? null)).toEqual([
      null,
      null,
      null,
    ])
    expect(character.chatFolders).toEqual([{ id: 'folder-b', name: 'Folder B renamed', color: 'blue', folded: true }])
    expect(character.chats[2]).toMatchObject({
      id: 'chat-c',
      name: 'C renamed',
      note: 'Author note',
      bookmarks: ['msg-a'],
      bookmarkNames: { 'msg-a': 'Pinned' },
      pinned: true,
    })
  })

  it('atomically replaces every character chat with one empty Chat 1', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [{ role: 'user', data: 'old a', chatId: 'message-a' }],
              localLore: [],
              hypaV3Data: { version: 3, summaries: [{ text: 'old memory', start: 0, end: 1 }] },
            },
            {
              id: 'chat-b',
              name: 'B chat',
              note: '',
              message: [{ role: 'char', data: 'old b', chatId: 'message-b' }],
              localLore: [],
              folderId: 'folder-a',
            },
          ],
          chatFolders: [{ id: 'folder-a', name: 'Folder A', folded: false }],
          chatPage: 1,
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [{ id: 'chat-other', name: 'Other', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })

    const reset = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-new',
          name: 'Chat 1',
          note: '',
          message: [],
          localLore: [],
          fmIndex: -1,
        },
      },
    })

    expect(reset.statusCode).toBe(200)
    expect(reset.json()).toMatchObject({
      revision: revision + 1,
      event: {
        type: 'chats.reset',
        resource: 'characterRow',
        id: 'chat-new',
        parentId: 'char-a',
      },
      chatId: 'chat-new',
      selectedChatId: 'chat-new',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const [characterA, characterB] = bootstrap.resourceDatabase.characters
    expect(characterA).toMatchObject({
      chaId: 'char-a',
      chatPage: 0,
      chats: [{ id: 'chat-new', name: 'Chat 1', note: '', localLore: [], fmIndex: -1 }],
      chatFolders: [{ id: 'folder-a', name: 'Folder A', folded: false }],
    })
    expect(characterA.chats[0].message).toEqual([])
    expect(characterB.chats.map((chat: { id: string }) => chat.id)).toEqual(['chat-other'])

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      expect(db.prepare("SELECT id FROM chats WHERE character_id = 'char-a' ORDER BY position").all()).toEqual([
        { id: 'chat-new' },
      ])
      expect(db.prepare("SELECT uid FROM messages WHERE chat_id IN ('chat-a', 'chat-b') ORDER BY uid").all()).toEqual(
        [],
      )
      expect(
        db.prepare("SELECT chat_id FROM chat_hypa_v3 WHERE chat_id IN ('chat-a', 'chat-b') ORDER BY chat_id").all(),
      ).toEqual([])
    } finally {
      db.close()
    }
  })

  it('preserves omitted folder assignments in sparse chat reorder patches', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              folderId: 'folder-a',
            },
            {
              id: 'chat-b',
              name: 'B chat',
              note: '',
              message: [],
              localLore: [],
              folderId: 'folder-b',
            },
            { id: 'chat-c', name: 'C chat', note: '', message: [], localLore: [] },
          ],
          chatFolders: [
            { id: 'folder-a', name: 'Folder A', folded: false },
            { id: 'folder-b', name: 'Folder B', folded: false },
          ],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const pureReorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chatIds: ['chat-c', 'chat-b', 'chat-a'],
        selectedChatId: 'chat-a',
      },
    })
    expect(pureReorder.statusCode).toBe(200)

    const afterPureReorder = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(
      afterPureReorder.resourceDatabase.characters[0].chats.map((chat: { id: string; folderId?: string | null }) => [
        chat.id,
        chat.folderId ?? null,
      ]),
    ).toEqual([
      ['chat-c', null],
      ['chat-b', 'folder-b'],
      ['chat-a', 'folder-a'],
    ])

    const sparseReorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: pureReorder.json().revision,
        chatIds: ['chat-a', 'chat-c', 'chat-b'],
        folderByChatId: { 'chat-b': null },
        selectedChatId: 'chat-a',
      },
    })
    expect(sparseReorder.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(
      bootstrap.resourceDatabase.characters[0].chats.map((chat: { id: string; folderId?: string | null }) => [
        chat.id,
        chat.folderId ?? null,
      ]),
    ).toEqual([
      ['chat-a', 'folder-a'],
      ['chat-c', null],
      ['chat-b', null],
    ])
  })

  it('creates a chat at the head while select:false preserves the selected chat', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            { id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] },
            { id: 'chat-b', name: 'B chat', note: '', message: [], localLore: [] },
          ],
          chatFolders: [],
          chatPage: 1,
        },
      ],
      characterOrder: ['char-a'],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        select: false,
        chat: {
          id: 'chat-c',
          name: 'C chat',
          note: '',
          message: [
            { role: 'user', data: 'first', chatId: 'msg-c-1' },
            { role: 'char', data: 'second', chatId: 'msg-c-2' },
          ],
          localLore: [],
        },
      },
    })

    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({
      revision: 2,
      chatId: 'chat-c',
      selectedChatId: 'chat-b',
      event: {
        type: 'chat.created',
        resource: 'chatTranscript',
        id: 'chat-c',
        parentId: 'char-a',
      },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const character = bootstrap.resourceDatabase.characters[0]
    expect(character.chatPage).toBe(2)
    expect(character.chats.map((chat: { id: string }) => chat.id)).toEqual(['chat-c', 'chat-a', 'chat-b'])
    await expect(persistedChatMessages(harness.app, assertion, 'chat-c')).resolves.toEqual([
      { role: 'user', data: 'first', chatId: 'msg-c-1' },
      { role: 'char', data: 'second', chatId: 'msg-c-2' },
    ])
    await expect(persistedChatMessages(harness.app, assertion, 'chat-a')).resolves.toEqual([])
    await expect(persistedChatMessages(harness.app, assertion, 'chat-b')).resolves.toEqual([])
  })

  it('serves created and forked long transcripts from the chat message endpoint', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-a', name: 'Source', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const createdMessages = Array.from({ length: 13 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'char',
      data: `created ${index}`,
      chatId: `created-${index}`,
    }))
    const createdHypaV3Data = {
      version: 3,
      summaries: [{ text: 'created memory', start: 0, end: 4 }],
    }

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-created',
          name: 'Created',
          note: '',
          message: createdMessages,
          localLore: [],
          hypaV3Data: createdHypaV3Data,
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json().event).toMatchObject({
      type: 'chat.created',
      resource: 'chatTranscript',
      id: 'chat-created',
      parentId: 'char-a',
    })
    const createdMessagesRead = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/chats/chat-created/messages',
      headers: { 'risu-auth': assertion },
    })
    expect(createdMessagesRead.statusCode).toBe(200)
    expect(createdMessagesRead.json()).toMatchObject({
      revision: 2,
      chatId: 'chat-created',
      message: createdMessages,
      hypaV3Data: createdHypaV3Data,
    })

    const forkedMessages = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'char',
      data: `forked ${index}`,
      chatId: `forked-${index}`,
    }))
    const forkedHypaV3Data = {
      version: 3,
      summaries: [{ text: 'forked memory', start: 2, end: 8 }],
    }
    const forked = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        chat: {
          id: 'chat-forked',
          name: 'Forked',
          note: '',
          message: forkedMessages,
          localLore: [],
          hypaV3Data: forkedHypaV3Data,
        },
      },
    })
    expect(forked.statusCode).toBe(200)
    expect(forked.json().event).toMatchObject({
      type: 'chat.forked',
      resource: 'chatTranscript',
      id: 'chat-forked',
      parentId: 'char-a',
    })
    const forkedMessagesRead = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/chats/chat-forked/messages',
      headers: { 'risu-auth': assertion },
    })
    expect(forkedMessagesRead.statusCode).toBe(200)
    expect(forkedMessagesRead.json()).toMatchObject({
      revision: 3,
      chatId: 'chat-forked',
      message: forkedMessages,
      hypaV3Data: forkedHypaV3Data,
    })
  })

  it('updates chat metadata without rewriting message rows', async () => {
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
                { role: 'char', data: 'hi', chatId: 'msg-b' },
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

    const beforeRows = activeMessageRowids(harness.dataDir, 'chat-a')
    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          name: 'A renamed',
          note: 'metadata only',
          autoTranslate: true,
          autoTranslateBotOnly: true,
          translatorPresetId: 'translator-preset-a',
          bilingualDisplay: true,
          bilingualEmphasis: 'translation',
          bookmarks: ['msg-a'],
          bookmarkNames: { 'msg-a': 'Pinned' },
        },
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      revision: 2,
      event: {
        type: 'chat.updated',
        resource: 'characterRow',
        id: 'chat-a',
        parentId: 'char-a',
      },
      chatId: 'chat-a',
      selectedChatId: 'chat-a',
    })
    expect(activeMessageRowids(harness.dataDir, 'chat-a')).toEqual(beforeRows)
    await expect(persistedChatMessages(harness.app, assertion, 'chat-a')).resolves.toEqual([
      { role: 'user', data: 'hello', chatId: 'msg-a' },
      { role: 'char', data: 'hi', chatId: 'msg-b' },
    ])

    const persisted = loadPersistedFromDir(harness.dataDir) as {
      database: { characters: Array<{ chats: Array<Record<string, unknown>> }> }
    }
    expect(persisted.database.characters[0].chats[0]).toMatchObject({
      id: 'chat-a',
      name: 'A renamed',
      note: 'metadata only',
      autoTranslate: true,
      autoTranslateBotOnly: true,
      translatorPresetId: 'translator-preset-a',
      bilingualDisplay: true,
      bilingualEmphasis: 'translation',
      bookmarks: ['msg-a'],
      bookmarkNames: { 'msg-a': 'Pinned' },
    })
  })

  it('validates and persists sparse bilingual emphasis chat patches', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    let revision = await importDatabase(harness.app, assertion, {
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

    for (const value of ['original', 'translation', null] as const) {
      const updated = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/chats/chat-a',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          patch: { bilingualEmphasis: value },
        },
      })
      expect(updated.statusCode).toBe(200)
      revision = updated.json().revision

      const persisted = loadPersistedFromDir(harness.dataDir) as {
        database: { characters: Array<{ chats: Array<Record<string, unknown>> }> }
      }
      expect(persisted.database.characters[0].chats[0]).toHaveProperty('bilingualEmphasis', value)
    }

    for (const value of ['translated', 1]) {
      const rejected = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/chats/chat-a',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          patch: { bilingualEmphasis: value },
        },
      })
      expect(rejected.statusCode).toBe(400)
      expect(rejected.json().error).toBe(
        "patch.bilingualEmphasis must be 'original', 'translation', null, or undefined",
      )
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
  })

  it('validates, persists, and clears stable translator preset chat bindings', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    let revision = await importDatabase(harness.app, assertion, {
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

    const selected = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { translatorPresetId: 'translator-preset-a' } },
    })
    expect(selected.statusCode).toBe(200)
    revision = selected.json().revision
    expect((loadPersistedFromDir(harness.dataDir) as any).database.characters[0].chats[0].translatorPresetId).toBe(
      'translator-preset-a',
    )

    const cleared = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { translatorPresetId: null } },
    })
    expect(cleared.statusCode).toBe(200)
    revision = cleared.json().revision
    expect((loadPersistedFromDir(harness.dataDir) as any).database.characters[0].chats[0]).not.toHaveProperty(
      'translatorPresetId',
    )

    for (const value of ['', 1, false]) {
      const rejected = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/chats/chat-a',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, patch: { translatorPresetId: value } },
      })
      expect(rejected.statusCode).toBe(400)
      expect(rejected.json().error).toBe('patch.translatorPresetId must be a non-empty string, null, or undefined')
    }
  })

  it('rejects chat fork commands without client-supplied fork ids without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            { id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] },
            { id: 'chat-b', name: 'B chat', note: '', message: [], localLore: [] },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const omittedChat = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
      },
    })
    expect(omittedChat.statusCode).toBe(400)
    expect(omittedChat.json().error).toBe('chat must be an object')

    const missingChatId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          name: 'Fork without id',
          note: '',
          message: [],
          localLore: [],
        },
      },
    })
    expect(missingChatId.statusCode).toBe(400)
    expect(missingChatId.json().error).toBe('chat.id must be a non-empty string')

    const duplicateChatId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-b',
          name: 'Duplicate fork',
          note: '',
          message: [],
          localLore: [],
        },
      },
    })
    expect(duplicateChatId.statusCode).toBe(400)
    expect(duplicateChatId.json().error).toBe('Duplicate chat id: chat-b')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.characters[0].chats.map((chat: { id: string }) => chat.id)).toEqual([
      'chat-a',
      'chat-b',
    ])
  })

  it('repairs imported duplicate chat ids across characters', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [{ id: 'chat-shared', name: 'A chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [{ id: 'chat-shared', name: 'B chat', note: '', message: [], localLore: [] }],
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
    const [charA, charB] = bootstrap.resourceDatabase.characters
    expect(charA.chats[0].id).toBe('chat-shared')
    expect(charB.chats[0].id).not.toBe('chat-shared')
    expect(typeof charB.chats[0].id).toBe('string')
  })

  it('rejects command-created chat ids and message ids already used by another character', async () => {
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
          chats: [{ id: 'chat-b', name: 'B chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })

    const duplicateCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-b/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: { id: 'chat-a', name: 'Duplicate', note: '', message: [], localLore: [] },
      },
    })
    expect(duplicateCreate.statusCode).toBe(400)
    expect(duplicateCreate.json().error).toBe('Duplicate chat id: chat-a')

    const duplicateFork = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-b/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: { id: 'chat-a', name: 'Duplicate fork', note: '', message: [], localLore: [] },
      },
    })
    expect(duplicateFork.statusCode).toBe(400)
    expect(duplicateFork.json().error).toBe('Duplicate chat id: chat-a')

    const duplicateCreateMessage = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-b/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-c',
          name: 'Message duplicate',
          note: '',
          message: [{ role: 'char', data: 'duplicate', chatId: 'msg-a' }],
          localLore: [],
        },
      },
    })
    expect(duplicateCreateMessage.statusCode).toBe(400)
    expect(duplicateCreateMessage.json().error).toBe('Duplicate message id: msg-a')

    const duplicateForkMessage = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-b/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-fork',
          name: 'Message duplicate fork',
          note: '',
          message: [{ role: 'char', data: 'duplicate', chatId: 'msg-a' }],
          localLore: [],
        },
      },
    })
    expect(duplicateForkMessage.statusCode).toBe(400)
    expect(duplicateForkMessage.json().error).toBe('Duplicate message id: msg-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(
      bootstrap.resourceDatabase.characters.map((character: { chats: { id: string }[] }) =>
        character.chats.map((chat) => chat.id),
      ),
    ).toEqual([['chat-a'], ['chat-b']])
  })

  it('rejects command-created chat folder ids that already exist on another character', async () => {
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
              message: [],
              localLore: [],
              folderId: 'folder-a',
            },
          ],
          chatFolders: [{ id: 'folder-a', name: 'Folder A', folded: false }],
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
              message: [],
              localLore: [],
              folderId: 'folder-b',
            },
          ],
          chatFolders: [{ id: 'folder-b', name: 'Folder B', folded: false }],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })

    const duplicateFolderCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-b/chat-folders',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        folder: { id: 'folder-a', name: 'Duplicate Folder A', folded: false },
      },
    })
    expect(duplicateFolderCreate.statusCode).toBe(400)
    expect(duplicateFolderCreate.json().error).toBe('Duplicate chat folder id: folder-a')

    const duplicateForkFolder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-b/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-fork',
          name: 'Fork',
          note: '',
          message: [],
          localLore: [],
        },
        folder: { id: 'folder-a', name: 'Duplicate Fork Folder', folded: false },
      },
    })
    expect(duplicateForkFolder.statusCode).toBe(400)
    expect(duplicateForkFolder.json().error).toBe('Duplicate chat folder id: folder-a')

    const folderUpdated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chat-folders/folder-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { name: 'Folder B renamed' },
      },
    })
    expect(folderUpdated.statusCode).toBe(200)

    const folderDeleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/chat-folders/folder-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: folderUpdated.json().revision },
    })
    expect(folderDeleted.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const characters = bootstrap.resourceDatabase.characters
    expect(characters[0].chatFolders).toEqual([])
    expect(characters[0].chats[0].folderId).toBeNull()
    expect(characters[1].chatFolders).toEqual([{ id: 'folder-b', name: 'Folder B renamed', folded: false }])
    expect(characters[1].chats[0].folderId).toBe('folder-b')
  })

  it('repairs imported duplicate chat folder ids across characters', async () => {
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
              message: [],
              localLore: [],
              folderId: 'folder-a',
            },
          ],
          chatFolders: [{ id: 'folder-a', name: 'Folder A', folded: false }],
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
              message: [],
              localLore: [],
              folderId: 'folder-a',
            },
          ],
          chatFolders: [{ id: 'folder-a', name: 'Folder B', folded: false }],
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
    const [charA, charB] = bootstrap.resourceDatabase.characters
    expect(charA.chatFolders[0].id).toBe('folder-a')
    expect(charA.chats[0].folderId).toBe('folder-a')
    expect(charB.chatFolders[0].id).not.toBe('folder-a')
    expect(typeof charB.chatFolders[0].id).toBe('string')
    expect(charB.chats[0].folderId).toBe(charB.chatFolders[0].id)
  })

  it('rejects chat module links to missing and MCP modules without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modules: [
        { id: 'mod-a', name: 'A', description: '' },
        { id: 'mcp-a', name: 'MCP', description: '', mcp: { url: 'internal:risuai' } },
      ],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-a',
              name: 'A chat',
              note: '',
              message: [],
              localLore: [],
              modules: ['mod-a'],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const missingCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-missing',
          name: 'Missing module chat',
          note: '',
          message: [],
          localLore: [],
          modules: ['missing-module'],
        },
      },
    })
    expect(missingCreate.statusCode).toBe(400)
    expect(missingCreate.json().error).toBe('Unknown module id in chat.modules: missing-module')

    const mcpPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { modules: ['mcp-a'] },
      },
    })
    expect(mcpPatch.statusCode).toBe(400)
    expect(mcpPatch.json().error).toBe('Unknown module id in patch.modules: mcp-a')

    const mcpForkSource = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        sourcePatch: { modules: ['mcp-a'] },
        chat: {
          id: 'chat-fork',
          name: 'Fork',
          note: '',
          message: [],
          localLore: [],
          modules: ['mod-a'],
        },
      },
    })
    expect(mcpForkSource.statusCode).toBe(400)
    expect(mcpForkSource.json().error).toBe('Unknown module id in sourcePatch.modules: mcp-a')

    const missingForkChat = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-a/fork',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chat: {
          id: 'chat-fork',
          name: 'Fork',
          note: '',
          message: [],
          localLore: [],
          modules: ['missing-module'],
        },
      },
    })
    expect(missingForkChat.statusCode).toBe(400)
    expect(missingForkChat.json().error).toBe('Unknown module id in chat.modules: missing-module')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.characters[0].chats).toMatchObject([
      {
        id: 'chat-a',
        name: 'A chat',
        note: '',
        message: [],
        localLore: [],
        modules: ['mod-a'],
      },
    ])
  })

  it('rejects malformed chat commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            { id: 'chat-a', name: 'A chat', note: '', message: [], localLore: [] },
            { id: 'chat-b', name: 'B chat', note: '', message: [], localLore: [] },
          ],
          chatFolders: [{ id: 'folder-a', name: 'Folder A', folded: false }],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const patch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { message: [] },
      },
    })
    expect(patch.statusCode).toBe(400)
    expect(patch.json().error).toBe('patch.message is owned by a later command slice')

    const reorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chatIds: ['chat-a', 'chat-a'],
      },
    })
    expect(reorder.statusCode).toBe(400)
    expect(reorder.json().error).toBe('Duplicate chat id in chatIds: chat-a')

    const folder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/chats/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        chatIds: ['chat-a', 'chat-b'],
        folderByChatId: { 'chat-a': 'missing-folder' },
      },
    })
    expect(folder.statusCode).toBe(400)
    expect(folder.json().error).toBe('Unknown chat folder id in folderByChatId: missing-folder')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.characters[0].chats.map((chat: { id: string }) => chat.id)).toEqual([
      'chat-a',
      'chat-b',
    ])
  })

  it('returns 404 and 409 for missing chats and stale chat revisions', async () => {
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

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/missing',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { name: 'Nope' },
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Chat not found: missing')

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
        patch: { name: 'Stale' },
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('chat scriptstate command', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('applies partial scriptstate patches and delete keys with a command event', async () => {
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
              message: [],
              localLore: [],
              scriptstate: { $old: '1', $keep: true },
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a/scriptstate',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { $score: '9', $count: 2 },
        deleteKeys: ['$old'],
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      revision: 2,
      event: {
        type: 'chat.scriptstate.updated',
        revision: 2,
        resource: 'characterRow',
        id: 'chat-a',
        parentId: 'char-a',
      },
      chatId: 'chat-a',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toEqual({
      $keep: true,
      $score: '9',
      $count: 2,
    })
    expect(harness.commandEvents.list().at(-1)).toEqual(res.json().event)
  })

  it('removes empty scriptstate after deleting the last key', async () => {
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
              message: [],
              localLore: [],
              scriptstate: { $old: '1' },
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a/scriptstate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: {}, deleteKeys: ['$old'] },
    })

    expect(res.statusCode).toBe(200)
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toBeUndefined()
  })

  it('rejects malformed scriptstate payloads without bumping revision', async () => {
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

    const unsupportedValue = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a/scriptstate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { $bad: { nested: true } } },
    })
    expect(unsupportedValue.statusCode).toBe(400)
    expect(unsupportedValue.json().error).toBe('patch.$bad must be a string, number, or boolean')

    const empty = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a/scriptstate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: {}, deleteKeys: [] },
    })
    expect(empty.statusCode).toBe(400)
    expect(empty.json().error).toBe('scriptstate command must include patch fields or deleteKeys')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.characters[0].chats[0].scriptstate).toBeUndefined()
  })

  it('returns 404 and 409 for missing chats and stale scriptstate revisions', async () => {
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

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/missing/scriptstate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { $x: '1' } },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Chat not found: missing')

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/chats/chat-a/scriptstate',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { $x: '1' } },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})
