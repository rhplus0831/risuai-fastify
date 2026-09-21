import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { compressSync } from 'fflate'
import type { FastifyInstance } from 'fastify'
import { getSchemaState, openDatabase } from '../src/db.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  startHarness,
  stopHarness,
  importDatabase,
  readJsonRow,
  persistedChatMessages,
} from './helpers/commandHarness.js'

const LEGACY_COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01'

function coldStorageSidecarPath(dataDir: string, key: string): string {
  const saveDir = path.join(dataDir, 'save')
  mkdirSync(saveDir, { recursive: true })
  const storageKey = `coldstorage/${key}`
  return path.join(saveDir, Buffer.from(storageKey, 'utf8').toString('hex'))
}

function writeColdStorageSidecar(dataDir: string, key: string, value: unknown): string {
  const sidecarPath = coldStorageSidecarPath(dataDir, key)
  writeFileSync(sidecarPath, Buffer.from(compressSync(new TextEncoder().encode(JSON.stringify(value)))))
  return sidecarPath
}

async function persistedChatHypaV3(app: FastifyInstance, assertion: string, chatId: string): Promise<unknown> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    headers: { 'risu-auth': assertion },
  })
  expect(res.statusCode).toBe(200)
  return res.json().hypaV3Data
}

let harness: Harness

describe('legacy cold-storage recovery commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('recovers an archived character and all of its chats in one revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-cold',
          name: 'Archived shell',
          coldstorage: 'character-archive',
          coldStoragedChats: ['chat-archive'],
          chats: [
            {
              id: 'shell-chat',
              name: 'Shell',
              note: '',
              localLore: [],
              message: [{ role: 'char', data: '', chatId: 'shell-message' }],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-cold'],
    })
    const sidecarPath = writeColdStorageSidecar(harness.dataDir, 'character-archive', {
      character: {
        chaId: 'char-cold',
        name: 'Recovered character',
        chats: [
          {
            id: 'recovered-chat',
            name: 'Recovered chat',
            note: 'legacy note',
            localLore: [{ key: 'legacy lore' }],
            scriptstate: { score: 7 },
            hypaV3Data: { summaries: [{ text: 'memory' }] },
            message: [
              { role: 'user', data: 'Are you still there?', chatId: 'recovered-message-a' },
              { role: 'char', data: 'Always.', chatId: 'recovered-message-b' },
            ],
          },
        ],
        chatFolders: [],
        chatPage: 0,
      },
    })

    const recovered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'character-archive' },
    })

    expect(recovered.statusCode).toBe(200)
    expect(recovered.json()).toMatchObject({
      revision: revision + 1,
      event: {
        type: 'coldStorage.characterRecovered',
        resource: 'characterRow',
        id: 'char-cold',
      },
      characterId: 'char-cold',
      character: {
        chaId: 'char-cold',
        name: 'Recovered character',
        chats: [{ id: 'recovered-chat' }],
      },
    })
    expect(readJsonRow(harness.dataDir, 'characters', 'char-cold')).toMatchObject({
      chaId: 'char-cold',
      name: 'Recovered character',
    })
    expect(readJsonRow(harness.dataDir, 'characters', 'char-cold').coldstorage).toBeUndefined()
    expect(readJsonRow(harness.dataDir, 'chats', 'recovered-chat')).toMatchObject({
      id: 'recovered-chat',
      scriptstate: { score: 7 },
      localLore: [{ key: 'legacy lore' }],
    })
    expect(await persistedChatMessages(harness.app, assertion, 'recovered-chat')).toEqual([
      expect.objectContaining({ data: 'Are you still there?', chatId: 'recovered-message-a' }),
      expect.objectContaining({ data: 'Always.', chatId: 'recovered-message-b' }),
    ])
    expect(existsSync(sidecarPath)).toBe(true)
    expect(() => readJsonRow(harness.dataDir, 'chats', 'shell-chat')).toThrow()
  })

  it('rejects character archives with missing chat arrays before changing live rows', { tags: 'core' }, async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-cold',
          name: 'Live character',
          coldstorage: 'malformed-character-archive',
          chats: [
            {
              id: 'live-chat',
              name: 'Live chat',
              note: 'must survive',
              localLore: [],
              hypaV3Data: { summaries: [{ text: 'live memory' }] },
              message: [{ role: 'char', data: 'live transcript', chatId: 'live-message' }],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-cold'],
    })

    writeColdStorageSidecar(harness.dataDir, 'malformed-character-archive', {
      character: { chaId: 'char-cold', name: 'Missing chats' },
    })
    const missingChats = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'malformed-character-archive' },
    })
    expect(missingChats.statusCode).toBe(400)
    expect(missingChats.json().error).toBe('archive.character.chats must be an array')

    writeColdStorageSidecar(harness.dataDir, 'malformed-character-archive', {
      character: {
        chaId: 'char-cold',
        name: 'Missing messages',
        chats: [{ id: 'recovered-chat', name: 'Recovered chat', note: '', localLore: [] }],
      },
    })
    const missingMessages = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'malformed-character-archive' },
    })
    expect(missingMessages.statusCode).toBe(400)
    expect(missingMessages.json().error).toBe('archive.character.chats[0].message must be an array')

    expect(readJsonRow(harness.dataDir, 'characters', 'char-cold')).toMatchObject({
      name: 'Live character',
      coldstorage: 'malformed-character-archive',
    })
    expect(readJsonRow(harness.dataDir, 'chats', 'live-chat')).toMatchObject({
      name: 'Live chat',
      note: 'must survive',
    })
    expect(await persistedChatMessages(harness.app, assertion, 'live-chat')).toEqual([
      { role: 'char', data: 'live transcript', chatId: 'live-message' },
    ])
    expect(await persistedChatHypaV3(harness.app, assertion, 'live-chat')).toEqual({
      summaries: [{ text: 'live memory' }],
    })
    const db = openDatabase(harness.dataDir)
    try {
      expect(getSchemaState(db).revision).toBe(revision)
    } finally {
      db.close()
    }
  })

  it('preserves live Hypa V3 data when a character archive omits it', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-cold',
          name: 'Archived shell',
          coldstorage: 'character-without-hypa',
          chats: [
            {
              id: 'shared-chat',
              name: 'Shell chat',
              note: '',
              localLore: [],
              hypaV3Data: { summaries: [{ text: 'live character memory' }] },
              message: [{ role: 'char', data: 'shell', chatId: 'shell-message' }],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-cold'],
    })
    writeColdStorageSidecar(harness.dataDir, 'character-without-hypa', {
      character: {
        chaId: 'char-cold',
        name: 'Recovered character',
        chats: [
          {
            id: 'shared-chat',
            name: 'Recovered chat',
            note: '',
            localLore: [],
            message: [{ role: 'char', data: 'recovered', chatId: 'recovered-message' }],
          },
        ],
        chatFolders: [],
        chatPage: 0,
      },
    })

    const recovered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'character-without-hypa' },
    })

    expect(recovered.statusCode).toBe(200)
    expect(await persistedChatHypaV3(harness.app, assertion, 'shared-chat')).toEqual({
      summaries: [{ text: 'live character memory' }],
    })
  })

  it('recovers an archived chat transcript and metadata without deleting its sidecar', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-cold',
              name: 'Archived chat',
              note: '',
              localLore: [],
              message: [
                {
                  role: 'char',
                  data: `${LEGACY_COLD_STORAGE_HEADER}chat-archive`,
                  chatId: 'pointer-message',
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
    const sidecarPath = writeColdStorageSidecar(harness.dataDir, 'chat-archive', {
      message: [
        { role: 'user', data: 'Recovered question', chatId: 'message-a' },
        { role: 'char', data: 'Recovered answer', chatId: 'message-b' },
      ],
      hypaV2Data: { legacy: true },
      hypaV3Data: { summaries: [{ text: 'remember this' }] },
      scriptstate: { route: 'recovered' },
      localLore: [{ key: 'archive lore' }],
    })

    const recovered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'chat-archive' },
    })

    expect(recovered.statusCode).toBe(200)
    expect(recovered.json()).toMatchObject({
      revision: revision + 1,
      event: {
        type: 'coldStorage.chatRecovered',
        resource: 'chatTranscript',
        id: 'chat-cold',
        parentId: 'char-a',
      },
      chat: {
        id: 'chat-cold',
        scriptstate: { route: 'recovered' },
        localLore: [{ key: 'archive lore' }],
      },
    })
    expect(await persistedChatMessages(harness.app, assertion, 'chat-cold')).toEqual([
      expect.objectContaining({ data: 'Recovered question', chatId: 'message-a' }),
      expect.objectContaining({ data: 'Recovered answer', chatId: 'message-b' }),
    ])
    expect(readJsonRow(harness.dataDir, 'chats', 'chat-cold')).toMatchObject({
      hypaV2Data: { legacy: true },
      scriptstate: { route: 'recovered' },
      localLore: [{ key: 'archive lore' }],
    })
    expect(existsSync(sidecarPath)).toBe(true)
  })

  it('preserves live Hypa V3 data when a legacy chat archive omits it', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-cold',
              name: 'Archived chat',
              note: '',
              localLore: [],
              hypaV3Data: { summaries: [{ text: 'live chat memory' }] },
              message: [
                {
                  role: 'char',
                  data: `${LEGACY_COLD_STORAGE_HEADER}legacy-array-archive`,
                  chatId: 'pointer-message',
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
    writeColdStorageSidecar(harness.dataDir, 'legacy-array-archive', [
      { role: 'user', data: 'Recovered question', chatId: 'message-a' },
      { role: 'char', data: 'Recovered answer', chatId: 'message-b' },
    ])

    const recovered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'legacy-array-archive' },
    })

    expect(recovered.statusCode).toBe(200)
    expect(await persistedChatHypaV3(harness.app, assertion, 'chat-cold')).toEqual({
      summaries: [{ text: 'live chat memory' }],
    })
  })

  it('keeps an authoritative chat pointer when its archive is missing or corrupt', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const pointer = `${LEGACY_COLD_STORAGE_HEADER}missing-archive`
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-cold',
              name: 'Archived chat',
              note: '',
              localLore: [],
              message: [{ role: 'char', data: pointer, chatId: 'pointer-message' }],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const missing = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'missing-archive' },
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toContain('missing-archive')
    expect((await persistedChatMessages(harness.app, assertion, 'chat-cold'))[0].data).toBe(pointer)

    writeFileSync(coldStorageSidecarPath(harness.dataDir, 'missing-archive'), Buffer.from('not compressed json'))
    const corrupt = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/chats/chat-cold/recover-cold-storage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, key: 'missing-archive' },
    })
    expect(corrupt.statusCode).toBe(400)
    expect(corrupt.json().error).toContain('corrupt')
    expect((await persistedChatMessages(harness.app, assertion, 'chat-cold'))[0].data).toBe(pointer)
    const db = openDatabase(harness.dataDir)
    try {
      expect(getSchemaState(db).revision).toBe(revision)
    } finally {
      db.close()
    }
  })
})
