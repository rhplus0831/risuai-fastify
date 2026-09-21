import { jsonResponse, makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  createChatCommand,
  createChatFolderCommand,
  deleteChatCommand,
  deleteChatFolderCommand,
  forkChatCommand,
  patchChatScriptstateCommand,
  reorderChatFoldersCommand,
  reorderChatsCommand,
  resetChatsCommand,
  updateChatCommand,
  updateChatFolderCommand,
  setServerCommandSuccessReconciler,
} from './commands'
import { captureDestructiveRefreshEpoch, createDestructiveRefreshToken } from './staleStateGuards'

describe('chat and folder command adapters', () => {
  it('dispatches chat and chat-folder commands through typed helpers', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/chat-folders/reorder')) {
        return {
          revision: 9,
          event: { type: 'chatFolder.reordered', revision: 9, resource: 'chatFolder' },
          selectedChatId: 'chat-a',
        }
      }
      if (url.endsWith('/chat-folders/folder-a')) {
        const method = commandFetch.calls.at(-1)?.method
        return method === 'DELETE'
          ? {
              revision: 8,
              event: {
                type: 'chatFolder.deleted',
                revision: 8,
                resource: 'chatFolder',
                id: 'folder-a',
              },
              folderId: 'folder-a',
            }
          : {
              revision: 7,
              event: {
                type: 'chatFolder.updated',
                revision: 7,
                resource: 'characterRow',
                id: 'folder-a',
                parentId: 'char-a',
              },
              folderId: 'folder-a',
            }
      }
      if (url.endsWith('/chat-folders')) {
        return {
          revision: 6,
          event: {
            type: 'chatFolder.created',
            revision: 6,
            resource: 'chatFolder',
            id: 'folder-a',
          },
          folderId: 'folder-a',
        }
      }
      if (url.endsWith('/chats/reorder')) {
        return {
          revision: 5,
          event: { type: 'chat.reordered', revision: 5, resource: 'chat' },
          selectedChatId: 'chat-a',
        }
      }
      if (url.endsWith('/chats/chat-a/fork')) {
        return {
          revision: 4,
          event: { type: 'chat.forked', revision: 4, resource: 'chat', id: 'chat-b' },
          chatId: 'chat-b',
          sourceChatId: 'chat-a',
          selectedChatId: 'chat-b',
        }
      }
      if (url.endsWith('/chats/chat-a')) {
        const method = commandFetch.calls.at(-1)?.method
        return method === 'DELETE'
          ? {
              revision: 3,
              event: { type: 'chat.deleted', revision: 3, resource: 'chat', id: 'chat-a' },
              chatId: 'chat-a',
              selectedChatId: 'chat-b',
            }
          : {
              revision: 2,
              event: { type: 'chat.updated', revision: 2, resource: 'chat', id: 'chat-a' },
              chatId: 'chat-a',
              selectedChatId: 'chat-a',
            }
      }
      return {
        revision: 1,
        event: { type: 'chat.created', revision: 1, resource: 'chat', id: 'chat-a' },
        chatId: 'chat-a',
        selectedChatId: 'chat-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      createChatCommand({
        baseRevision: 0,
        characterId: 'char-a',
        chat: { id: 'chat-a', name: 'A', note: '', message: [], localLore: [] },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 1, chatId: 'chat-a' })

    await expect(
      updateChatCommand({
        baseRevision: 1,
        chatId: 'chat-a',
        patch: { name: 'A renamed' },
        select: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, selectedChatId: 'chat-a' })

    await expect(
      deleteChatCommand({
        baseRevision: 2,
        chatId: 'chat-a',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, selectedChatId: 'chat-b' })

    await expect(
      forkChatCommand({
        baseRevision: 3,
        chatId: 'chat-a',
        chat: { id: 'chat-b', name: 'B', note: '', message: [], localLore: [] },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 4, chatId: 'chat-b' })

    await expect(
      reorderChatsCommand({
        baseRevision: 4,
        characterId: 'char-a',
        chatIds: ['chat-a', 'chat-b'],
        folderByChatId: { 'chat-a': null, 'chat-b': 'folder-a' },
        selectedChatId: 'chat-a',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, selectedChatId: 'chat-a' })

    await expect(
      createChatFolderCommand({
        baseRevision: 5,
        characterId: 'char-a',
        folder: { id: 'folder-a', name: 'Folder', folded: false },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 6, folderId: 'folder-a' })

    await expect(
      updateChatFolderCommand({
        baseRevision: 6,
        folderId: 'folder-a',
        patch: { folded: true },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 7, folderId: 'folder-a' })

    await expect(
      deleteChatFolderCommand({
        baseRevision: 7,
        folderId: 'folder-a',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 8, folderId: 'folder-a' })

    await expect(
      reorderChatFoldersCommand({
        baseRevision: 8,
        characterId: 'char-a',
        folderIds: ['folder-a'],
        selectedChatId: 'chat-a',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 9, selectedChatId: 'chat-a' })

    expect(observedEffects).toContainEqual({
      kind: 'characterRowMutation',
      operation: 'chatFolderUpdate',
      characterId: 'char-a',
      targetId: 'folder-a',
    })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/characters/char-a/chats',
        method: 'POST',
        body: {
          baseRevision: 0,
          chat: { id: 'chat-a', name: 'A', note: '', message: [], localLore: [] },
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a',
        method: 'PATCH',
        body: {
          baseRevision: 1,
          patch: { name: 'A renamed' },
          select: true,
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a',
        method: 'DELETE',
        body: {
          baseRevision: 2,
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a/fork',
        method: 'POST',
        body: {
          baseRevision: 3,
          chat: { id: 'chat-b', name: 'B', note: '', message: [], localLore: [] },
        },
      },
      {
        url: '/api/v1/commands/characters/char-a/chats/reorder',
        method: 'POST',
        body: {
          baseRevision: 4,
          chatIds: ['chat-a', 'chat-b'],
          folderByChatId: { 'chat-a': null, 'chat-b': 'folder-a' },
          selectedChatId: 'chat-a',
        },
      },
      {
        url: '/api/v1/commands/characters/char-a/chat-folders',
        method: 'POST',
        body: {
          baseRevision: 5,
          folder: { id: 'folder-a', name: 'Folder', folded: false },
        },
      },
      {
        url: '/api/v1/commands/chat-folders/folder-a',
        method: 'PATCH',
        body: {
          baseRevision: 6,
          patch: { folded: true },
        },
      },
      {
        url: '/api/v1/commands/chat-folders/folder-a',
        method: 'DELETE',
        body: {
          baseRevision: 7,
        },
      },
      {
        url: '/api/v1/commands/characters/char-a/chat-folders/reorder',
        method: 'POST',
        body: {
          baseRevision: 8,
          folderIds: ['folder-a'],
          selectedChatId: 'chat-a',
        },
      },
    ])
  })

  it('dispatches an atomic all-chat reset through the typed helper', async () => {
    const commandFetch = makeCommandFetch(() => ({
      revision: 12,
      event: {
        type: 'chats.reset',
        revision: 12,
        resource: 'characterRow',
        id: 'chat-new',
        parentId: 'char-a',
      },
      chatId: 'chat-new',
      selectedChatId: 'chat-new',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      resetChatsCommand({
        baseRevision: 11,
        characterId: 'char-a',
        chat: { id: 'chat-new', name: 'Chat 1', note: '', message: [], localLore: [], fmIndex: -1 },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 12, chatId: 'chat-new' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/characters/char-a/chats',
        method: 'PUT',
        body: {
          baseRevision: 11,
          chat: { id: 'chat-new', name: 'Chat 1', note: '', message: [], localLore: [], fmIndex: -1 },
        },
      },
    ])
  })

  it('emits strict opt-in local effects for optimistic chat structure mutations', async () => {
    const optimisticEpoch = captureDestructiveRefreshEpoch()
    const optimisticRowEpoch = 0
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const responses = [
      {
        revision: 1,
        event: {
          type: 'chat.created',
          revision: 1,
          resource: 'chatTranscript',
          id: 'chat-created',
          parentId: 'char-a',
        },
        chatId: 'chat-created',
        selectedChatId: 'chat-created',
        generationSettings: null,
      },
      {
        revision: 2,
        event: {
          type: 'chat.deleted',
          revision: 2,
          resource: 'characterRow',
          id: 'chat-deleted',
          parentId: 'char-a',
        },
        chatId: 'chat-deleted',
        selectedChatId: 'chat-created',
      },
      {
        revision: 3,
        event: {
          type: 'chat.forked',
          revision: 3,
          resource: 'chatTranscript',
          id: 'chat-forked',
          parentId: 'char-a',
        },
        chatId: 'chat-forked',
        sourceChatId: 'chat-created',
        selectedChatId: 'chat-forked',
        generationSettings: null,
      },
      {
        revision: 4,
        event: { type: 'chat.reordered', revision: 4, resource: 'characterRow', parentId: 'char-a' },
        selectedChatId: 'chat-created',
      },
      {
        revision: 5,
        event: {
          type: 'chatFolder.created',
          revision: 5,
          resource: 'characterRow',
          id: 'folder-a',
          parentId: 'char-a',
        },
        folderId: 'folder-a',
      },
      {
        revision: 6,
        event: {
          type: 'chatFolder.deleted',
          revision: 6,
          resource: 'characterRow',
          id: 'folder-a',
          parentId: 'char-a',
        },
        folderId: 'folder-a',
      },
      {
        revision: 7,
        event: { type: 'chatFolder.reordered', revision: 7, resource: 'characterRow', parentId: 'char-a' },
        selectedChatId: 'chat-created',
      },
    ]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => responses[responseIndex++])
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createChatCommand({
      baseRevision: 0,
      characterId: 'char-a',
      chat: {
        id: 'chat-created',
        name: 'Created',
        note: '',
        localLore: [],
        message: [{ role: 'user', data: 'Created', chatId: 'message-a' }],
      },
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch,
    })
    await deleteChatCommand({
      baseRevision: 1,
      chatId: 'chat-deleted',
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch,
    })
    await forkChatCommand({
      baseRevision: 2,
      chatId: 'chat-created',
      chat: {
        id: 'chat-forked',
        name: 'Forked',
        note: '',
        localLore: [],
        message: [{ role: 'user', data: 'Forked', chatId: 'message-b' }],
      },
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch,
    })
    await reorderChatsCommand({
      baseRevision: 3,
      characterId: 'char-a',
      chatIds: ['chat-forked', 'chat-created'],
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch,
    })
    await createChatFolderCommand({
      baseRevision: 4,
      characterId: 'char-a',
      folder: { id: 'folder-a', folded: false },
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch,
    })
    await deleteChatFolderCommand({
      baseRevision: 5,
      folderId: 'folder-a',
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch,
    })
    await reorderChatFoldersCommand({
      baseRevision: 6,
      characterId: 'char-a',
      folderIds: ['folder-b', 'folder-a'],
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch,
    })

    expect(observedEffects).toEqual([
      {
        kind: 'chatStructureMutation',
        operation: 'create',
        characterId: 'char-a',
        targetId: 'chat-created',
        attemptedGenerationSettings: null,
        generationSettings: null,
        optimisticEpoch,
        optimisticRowEpoch,
      },
      {
        kind: 'chatStructureMutation',
        operation: 'delete',
        characterId: 'char-a',
        targetId: 'chat-deleted',
        optimisticEpoch,
        optimisticRowEpoch,
      },
      {
        kind: 'chatStructureMutation',
        operation: 'fork',
        characterId: 'char-a',
        targetId: 'chat-forked',
        attemptedGenerationSettings: null,
        generationSettings: null,
        optimisticEpoch,
        optimisticRowEpoch,
      },
      {
        kind: 'chatStructureMutation',
        operation: 'reorder',
        characterId: 'char-a',
        attemptedIds: ['chat-forked', 'chat-created'],
        optimisticEpoch,
        optimisticRowEpoch,
      },
      {
        kind: 'chatStructureMutation',
        operation: 'folderCreate',
        characterId: 'char-a',
        targetId: 'folder-a',
        optimisticEpoch,
        optimisticRowEpoch,
      },
      {
        kind: 'chatStructureMutation',
        operation: 'folderDelete',
        characterId: 'char-a',
        targetId: 'folder-a',
        optimisticEpoch,
        optimisticRowEpoch,
      },
      {
        kind: 'chatStructureMutation',
        operation: 'folderReorder',
        characterId: 'char-a',
        attemptedIds: ['folder-b', 'folder-a'],
        optimisticEpoch,
        optimisticRowEpoch,
      },
    ])
  })

  it('does not emit a structural local effect after a destructive refresh', async () => {
    const optimisticEpoch = captureDestructiveRefreshEpoch()
    createDestructiveRefreshToken('chat-structure-test-refresh')
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 1,
      event: {
        type: 'chat.created',
        revision: 1,
        resource: 'characterRow',
        id: 'chat-created',
        parentId: 'char-a',
      },
      chatId: 'chat-created',
      selectedChatId: 'chat-created',
      generationSettings: null,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createChatCommand({
      baseRevision: 0,
      characterId: 'char-a',
      chat: { id: 'chat-created', name: 'Created', note: '', localLore: [], message: [] },
      acknowledgeOptimistic: true,
      optimisticEpoch,
      optimisticRowEpoch: 0,
    })

    expect(observedEffects).toEqual([])
  })

  it('dispatches chat scriptstate commands through typed helpers', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/chats/chat-a/scriptstate')) {
        return {
          revision: 7,
          event: {
            type: 'chat.scriptstate.updated',
            revision: 7,
            resource: 'characterRow',
            id: 'chat-a',
            parentId: 'char-a',
          },
          chatId: 'chat-a',
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      patchChatScriptstateCommand({
        baseRevision: 6,
        chatId: 'chat-a',
        patch: { $score: '9', $count: 2 },
        deleteKeys: ['$old'],
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 7, chatId: 'chat-a' })

    expect(observedEffects).toEqual([
      {
        kind: 'characterRowMutation',
        operation: 'chatScriptstate',
        characterId: 'char-a',
        targetId: 'chat-a',
      },
    ])

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/chats/chat-a/scriptstate',
        method: 'PATCH',
        body: {
          baseRevision: 6,
          patch: { $score: '9', $count: 2 },
          deleteKeys: ['$old'],
        },
      },
    ])
  })

  it('reports an accepted chat update as a local command effect', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 5,
      event: {
        type: 'chat.updated',
        revision: 5,
        resource: 'characterRow',
        id: 'chat-a',
        parentId: 'char-a',
      },
      chatId: 'chat-a',
      selectedChatId: 'chat-a',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      updateChatCommand({
        baseRevision: 4,
        chatId: 'chat-a',
        patch: {},
        select: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, selectedChatId: 'chat-a' })

    expect(observedEffects).toEqual([
      {
        kind: 'chatPatch',
        characterId: 'char-a',
        chatId: 'chat-a',
        patch: {},
        select: true,
      },
    ])
  })
})
