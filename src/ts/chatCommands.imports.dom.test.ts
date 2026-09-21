import { setupChatCommandTests, jsonResponse, createDeferred } from './chatCommands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { setCachedServerCommandRevision } from './server/commands'
// Import the heavy database module AFTER stores.svelte: importing it first
// triggers a circular-import TDZ when the reactive moduleUpdate $effect runs
// mid-init.
import { type Chat, type ChatFolder } from './storage/database.svelte'
import {
  applyOptimisticCreatedChat,
  currentChatStateSnapshot,
  dispatchCreateChat,
  dispatchCreateChatForImport,
  dispatchCreateImportedChats,
} from './chatCommands'
import {
  clearPendingMutationOutbox,
  listPendingMutations,
  MAX_DURABLE_MUTATION_PAYLOAD_BYTES,
  pendingMutationIntentPayloadByteLength,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
} from './server/pendingMutationOutbox'
import { getResourceDatabase as getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

setupChatCommandTests()

describe('chat command projection helpers', () => {
  it('accepts a retained single-chat import without rolling back or inviting a duplicate retry', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-import',
      writerEpoch: 32,
      databaseLineage: 'lineage-chat-import',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    const previous = currentChatStateSnapshot()
    const importedChat = {
      id: 'chat-imported',
      name: 'Imported chat',
      note: '',
      localLore: [],
      message: [{ role: 'user', data: 'imported row', chatId: 'message-imported' }],
    } as Chat
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats.unshift(importedChat)
      getDatabase().characters[0].chatPage = 0
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/v1/commands/characters/char-a/chats') {
          return jsonResponse({ error: 'temporarily unavailable' }, 503)
        }
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      await expect(dispatchCreateChatForImport('char-a', importedChat, previous)).resolves.toEqual({ status: 'ok' })
      expect(getDatabase().characters[0].chats[0]).toEqual(importedChat)
      expect(await listPendingMutations()).toMatchObject([
        {
          handle: { key: 'character-owner:char-a' },
          intent: {
            version: 1,
            requests: [
              {
                method: 'POST',
                path: '/characters/char-a/chats',
                body: { chat: importedChat, select: true },
              },
            ],
          },
        },
      ])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('pre-stages every multi-chat import item and retains later rows without sending after a retryable failure', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-batch-import',
      writerEpoch: 34,
      databaseLineage: 'lineage-chat-batch-import',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    const previous = currentChatStateSnapshot()
    const folder = { id: 'folder-imported', name: 'Imported folder', folded: false } as ChatFolder
    const chats = [
      {
        id: 'chat-imported-a',
        name: 'Imported A',
        note: '',
        localLore: [],
        folderId: 'folder-imported',
        message: [],
      },
      {
        id: 'chat-imported-b',
        name: 'Imported B',
        note: '',
        localLore: [],
        message: [{ role: 'user', data: 'batch row', chatId: 'message-batch' }],
      },
    ] as Chat[]
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chatFolders.push(folder)
      getDatabase().characters[0].chats.unshift(...chats)
    })

    const commandUrls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/v1/commands/characters/char-a/chat-folders') {
          commandUrls.push(url)
          return jsonResponse({ error: 'temporarily unavailable' }, 503)
        }
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      await expect(dispatchCreateImportedChats('char-a', [folder], chats, previous)).resolves.toEqual({
        status: 'ok',
      })
      expect(getDatabase().characters[0].chatFolders.at(-1)).toEqual(folder)
      expect(getDatabase().characters[0].chats.slice(0, 2)).toEqual(chats)
      expect(commandUrls).toEqual(['/api/v1/commands/characters/char-a/chat-folders'])
      const pending = await listPendingMutations()
      expect(pending).toHaveLength(3)
      expect(pending.map((entry) => entry.handle.key)).toEqual([
        'character-owner:char-a',
        'character-owner:char-a',
        'character-owner:char-a',
      ])
      expect(pending.map((entry) => entry.intent)).toEqual([
        {
          version: 1,
          requests: [
            {
              method: 'POST',
              path: '/characters/char-a/chat-folders',
              body: { folder },
            },
          ],
        },
        {
          version: 1,
          requests: [
            {
              method: 'POST',
              path: '/characters/char-a/chats',
              body: { chat: chats[0], select: false },
            },
          ],
        },
        {
          version: 1,
          requests: [
            {
              method: 'POST',
              path: '/characters/char-a/chats',
              body: { chat: chats[1], select: false },
            },
          ],
        },
      ])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('reserves every import queue slot before durable readiness so a later create cannot overtake', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-batch-order',
      writerEpoch: 37,
      databaseLineage: 'lineage-chat-batch-order',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    const encryptionGate = createDeferred<void>()
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
    const encryptSpy = vi
      .spyOn(globalThis.crypto.subtle, 'encrypt')
      .mockImplementation(async (algorithm, key, data) => {
        await encryptionGate.promise
        return originalEncrypt(algorithm, key, data)
      })
    const previous = currentChatStateSnapshot()
    const folder = { id: 'folder-batch-order', name: 'Batch folder', folded: false } as ChatFolder
    const importedChat = {
      id: 'chat-batch-order',
      name: 'Batch chat',
      note: '',
      localLore: [],
      folderId: folder.id,
      message: [],
    } as Chat
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chatFolders.push(folder)
      getDatabase().characters[0].chats.unshift(importedChat)
    })

    let revision = 10
    const commandUrls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url === '/api/v1/commands/characters/char-a/chat-folders') {
          commandUrls.push(url)
          revision += 1
          return jsonResponse({
            revision,
            event: {
              type: 'chatFolder.created',
              revision,
              resource: 'chatFolder',
              id: folder.id,
              parentId: 'char-a',
            },
            folderId: folder.id,
          })
        }
        if (url === '/api/v1/commands/characters/char-a/chats') {
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
          const chatId = body.chat?.id as string
          commandUrls.push(`${url}:${chatId}`)
          revision += 1
          return jsonResponse({
            revision,
            event: {
              type: 'chat.created',
              revision,
              resource: 'chatTranscript',
              id: chatId,
              parentId: 'char-a',
            },
            chatId,
            selectedChatId: body.select === false ? 'chat-a' : chatId,
            generationSettings: null,
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const importPromise = dispatchCreateImportedChats('char-a', [folder], [importedChat], previous)
      const laterPrevious = currentChatStateSnapshot()
      const laterChat = {
        id: 'chat-created-after-batch',
        name: 'Later chat',
        note: '',
        localLore: [],
        message: [],
      } as Chat
      expect(applyOptimisticCreatedChat('char-a', laterChat, laterPrevious)).toBe(true)
      dispatchCreateChat('char-a', laterChat, laterPrevious)

      await Promise.resolve()
      expect(commandUrls).toEqual([])
      encryptionGate.resolve()

      await expect(importPromise).resolves.toEqual({ status: 'ok' })
      await vi.waitFor(() => expect(commandUrls).toHaveLength(3))
      expect(commandUrls).toEqual([
        '/api/v1/commands/characters/char-a/chat-folders',
        '/api/v1/commands/characters/char-a/chats:chat-batch-order',
        '/api/v1/commands/characters/char-a/chats:chat-created-after-batch',
      ])
      await vi.waitFor(async () => expect(await listPendingMutations()).toEqual([]))
    } finally {
      encryptionGate.resolve()
      encryptSpy.mockRestore()
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('durably pre-stages imports containing more than one hundred chats', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-large-batch-import',
      writerEpoch: 35,
      databaseLineage: 'lineage-chat-large-batch-import',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    const previous = currentChatStateSnapshot()
    const chats = Array.from({ length: 101 }, (_, index) => ({
      id: `chat-large-import-${index}`,
      name: `Imported ${index}`,
      note: '',
      localLore: [],
      message: [],
    })) as Chat[]
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats.unshift(...chats)
    })
    let createCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/v1/commands/characters/char-a/chats') {
          createCalls += 1
          return jsonResponse({ error: 'temporarily unavailable' }, 503)
        }
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      await expect(dispatchCreateImportedChats('char-a', [], chats, previous)).resolves.toEqual({ status: 'ok' })
      expect(createCalls).toBe(1)
      expect(getDatabase().characters[0].chats.slice(0, chats.length)).toEqual(chats)
      const pending = await listPendingMutations()
      expect(pending).toHaveLength(101)
      expect(pending.every((entry) => entry.handle.key === 'character-owner:char-a')).toBe(true)
      expect(pending.every((entry) => entry.intent.requests.length === 1)).toBe(true)
      expect(pending.at(-1)?.intent.requests[0]).toEqual({
        method: 'POST',
        path: '/characters/char-a/chats',
        body: { chat: chats.at(-1), select: false },
      })
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  }, 15_000)

  it('keeps an accepted chunked-import prefix when a later tail is terminally rejected', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-chunked-terminal',
      writerEpoch: 39,
      databaseLineage: 'lineage-chat-chunked-terminal',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    const previous = currentChatStateSnapshot()
    const messageSize = Math.ceil(MAX_DURABLE_MUTATION_PAYLOAD_BYTES / 2)
    const chunkedChat = {
      id: 'chat-chunked-terminal',
      name: 'Chunked terminal import',
      note: '',
      localLore: [],
      message: [
        { role: 'user', data: 'a'.repeat(messageSize), chatId: 'message-terminal-a' },
        { role: 'char', data: 'b'.repeat(messageSize), chatId: 'message-terminal-b' },
      ],
    } as Chat
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats.unshift(chunkedChat)
    })

    let revision = 10
    let tailCalls = 0
    const commandPaths: string[] = []
    const commandRequests: Array<{
      method: 'POST'
      path: string
      body: Record<string, unknown>
    }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url === '/api/v1/commands/characters/char-a/chats') {
          commandPaths.push('/characters/char-a/chats')
          commandRequests.push({
            method: 'POST',
            path: '/characters/char-a/chats',
            body: typeof init.body === 'string' ? JSON.parse(init.body) : {},
          })
          revision += 1
          return jsonResponse({
            revision,
            event: {
              type: 'chat.created',
              revision,
              resource: 'chatTranscript',
              id: chunkedChat.id,
              parentId: 'char-a',
            },
            chatId: chunkedChat.id,
            selectedChatId: 'chat-a',
            generationSettings: null,
          })
        }
        if (url === '/api/v1/commands/chats/chat-chunked-terminal/messages/tail') {
          commandPaths.push('/chats/chat-chunked-terminal/messages/tail')
          tailCalls += 1
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
          commandRequests.push({
            method: 'POST',
            path: '/chats/chat-chunked-terminal/messages/tail',
            body,
          })
          if (tailCalls === 2) return jsonResponse({ error: 'invalid second tail' }, 400)
          revision += 1
          return jsonResponse({
            revision,
            event: {
              type: 'messages.replaced',
              revision,
              resource: 'message',
              parentId: chunkedChat.id,
            },
            chatId: chunkedChat.id,
            afterMessageId: body.afterMessageId ?? null,
            replacedCount: body.messages?.length ?? 0,
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      await expect(dispatchCreateImportedChats('char-a', [], [chunkedChat], previous)).resolves.toEqual({
        status: 'error',
        error: 'invalid second tail',
        reason: 'invalid-request',
      })
      expect(commandPaths).toEqual([
        '/characters/char-a/chats',
        '/chats/chat-chunked-terminal/messages/tail',
        '/chats/chat-chunked-terminal/messages/tail',
      ])
      expect(commandRequests[0]).toMatchObject({
        body: { chat: { id: chunkedChat.id, message: [] }, select: false },
      })
      expect(commandRequests[1]).toMatchObject({
        body: { afterMessageId: null, messages: [{ chatId: 'message-terminal-a' }] },
      })
      expect(commandRequests[2]).toMatchObject({
        body: { afterMessageId: 'message-terminal-a', messages: [{ chatId: 'message-terminal-b' }] },
      })
      expect(MAX_DURABLE_MUTATION_PAYLOAD_BYTES).toBe(16 * 1024 * 1024)
      expect(
        commandRequests.every((request) => {
          const { baseRevision: _baseRevision, ...body } = request.body
          return (
            pendingMutationIntentPayloadByteLength({
              version: 1,
              requests: [{ ...request, body }],
            }) <= MAX_DURABLE_MUTATION_PAYLOAD_BYTES
          )
        }),
      ).toBe(true)
      const imported = getDatabase().characters[0].chats.find((chat) => chat.id === chunkedChat.id)
      expect(imported?.message).toHaveLength(1)
      expect(imported?.message[0].chatId).toBe('message-terminal-a')
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('rejects an unchunkable oversized message before sending and rolls back the projection', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-oversized-import',
      writerEpoch: 36,
      databaseLineage: 'lineage-chat-oversized-import',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    const previous = currentChatStateSnapshot()
    const oversizedChat = {
      id: 'chat-oversized-import',
      name: 'Oversized import',
      note: '',
      localLore: [],
      message: [
        {
          role: 'user',
          data: 'x'.repeat(MAX_DURABLE_MUTATION_PAYLOAD_BYTES + 1_024),
          chatId: 'message-oversized-import',
        },
      ],
    } as Chat
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chats.unshift(oversizedChat)
    })
    let mutationIdHeader: string | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/characters/char-a/chats') {
          mutationIdHeader = (init.headers as Record<string, string> | undefined)?.['risu-mutation-id']
          return jsonResponse({ error: 'oversized import failed' }, 503)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      await expect(dispatchCreateImportedChats('char-a', [], [oversizedChat], previous)).resolves.toEqual({
        status: 'error',
        error: 'chat_import_too_large',
      })
      expect(mutationIdHeader).toBeUndefined()
      expect(getDatabase().characters[0].chats.some((chat) => chat.id === oversizedChat.id)).toBe(false)
      expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b'])
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })
})
