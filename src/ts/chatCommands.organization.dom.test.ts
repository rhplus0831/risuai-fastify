import {
  setupChatCommandTests,
  type CapturedFetch,
  jsonResponse,
  createDeferred,
  stubCommandFetch,
  stubFailingCommandFetch,
  waitForCallCount,
  jsonClone,
  prepareDurableOutbox,
  clearDurableOutbox,
} from './chatCommands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { setCachedServerCommandRevision, type ChatFolderSnapshot, type ChatSnapshot } from './server/commands'
import { selectedCharID } from './stores.svelte'
import { applyCharacterResource, replaceResourceDatabase as setDatabaseLite } from './server/resourceState.svelte'
// Import the heavy database module AFTER stores.svelte: importing it first
// triggers a circular-import TDZ when the reactive moduleUpdate $effect runs
// mid-init.
import { type Chat, type ChatFolder, type Message } from './storage/database.svelte'
import { get } from 'svelte/store'
import {
  applyOptimisticCreatedChat,
  applyOptimisticCreatedChatFolder,
  applyOptimisticDeletedChat,
  applyOptimisticResetChats,
  applyChatNoteValueLocally,
  captureChatCreateSnapshot,
  captureChatFolderCreateSnapshot,
  captureChatDeleteSnapshot,
  captureChatFolderDeleteSnapshot,
  captureChatOrderSnapshot,
  captureChatForkSnapshot,
  captureChatResetSnapshot,
  dispatchReorderChatsByIdsWithOutcome,
  currentChatSelectionSnapshot,
  currentChatStateSnapshot,
  dispatchAppendMessage,
  dispatchCreateChat,
  dispatchCreateChatWithOutcome,
  dispatchCreateChatFolder,
  dispatchDeleteChat,
  dispatchDeleteChatWithOutcome,
  dispatchDeleteChatFolder,
  dispatchForkChat,
  dispatchReorderChatFoldersAndChatsByIds,
  dispatchReorderChatFoldersAndChatsByIdsWithOutcome,
  dispatchReorderChatFoldersByIds,
  dispatchReorderChatsByIds,
  dispatchResetChatsWithOutcome,
  dispatchSelectChat,
  dispatchUpdateChat,
  dispatchUpdateChatFolder,
  dispatchUpdateChatFolderWithOutcome,
  restoreChatState,
  restoreChatSelection,
} from './chatCommands'
import {
  assertRollbackRestoresOnly,
  assertSnapshotIsScalar,
  seedCloneCostDb,
  withCloneInstrumentation,
} from './__tests__/cloneCostHarness'
import {
  clearPendingMutationOutbox,
  listPendingMutations,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
} from './server/pendingMutationOutbox'
import { replayPendingMutations } from './server/pendingMutationReplay'
import { getResourceDatabase as getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

setupChatCommandTests()

function stubCombinedReorderCommandFetch(input: {
  fail: 'folders' | 'chats'
  onFolderCommand?: (url: string, init: RequestInit) => void
  onChatCommand?: (url: string, init: RequestInit) => void
}): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      const url = String(requestInput)
      calls.push({
        url,
        method: init.method ?? 'GET',
        authHeader: headers?.['risu-auth'] ?? null,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      })

      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
      if (url === '/api/v1/commands/characters/char-a/chat-folders/reorder' && init.method === 'POST') {
        input.onFolderCommand?.(url, init)
        if (input.fail === 'folders') return jsonResponse({ error: 'folder reorder failed' }, 500)
        return jsonResponse({
          revision: 11,
          event: { type: 'chatFolder.reordered', revision: 11, resource: 'chatFolder' },
          selectedChatId: 'chat-a',
        })
      }
      if (url === '/api/v1/commands/characters/char-a/chats/reorder' && init.method === 'POST') {
        input.onChatCommand?.(url, init)
        if (input.fail === 'chats') return jsonResponse({ error: 'chat reorder failed' }, 500)
        return jsonResponse({
          revision: 12,
          event: { type: 'chat.reordered', revision: 12, resource: 'chat' },
          selectedChatId: 'chat-a',
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

describe('chat command projection helpers', () => {
  it('optimistically inserts and selects a command-created chat through its owner', () => {
    const previous = currentChatStateSnapshot()
    const chat = {
      id: 'chat-c',
      name: 'Chat C',
      note: '',
      message: [],
      localLore: [],
      fmIndex: -1,
    } as Chat

    expect(applyOptimisticCreatedChat('char-a', chat, previous)).toBe(true)

    expect(getDatabase().characters[0].chats.map((candidate) => candidate.id)).toEqual(['chat-c', 'chat-a', 'chat-b'])
    expect(getDatabase().characters[0].chatPage).toBe(0)

    restoreChatState(previous)
    expect(getDatabase().characters[0].chats.map((candidate) => candidate.id)).toEqual(['chat-a', 'chat-b'])
  })

  it('optimistically replaces every chat with one empty Chat 1 through its owner', () => {
    const previous = currentChatStateSnapshot()
    const chat = {
      id: 'chat-new',
      name: 'Chat 1',
      note: '',
      message: [],
      localLore: [],
      fmIndex: -1,
    } as Chat

    expect(applyOptimisticResetChats('char-a', chat, previous)).toBe(true)
    expect(getDatabase().characters[0].chats).toEqual([chat])
    expect(getDatabase().characters[0].chatPage).toBe(0)

    restoreChatState(previous)
    expect(getDatabase().characters[0].chats.map((candidate) => candidate.id)).toEqual(['chat-a', 'chat-b'])
  })

  it('optimistically inserts a command-created chat folder through its owner', () => {
    const previous = currentChatStateSnapshot()
    const folder = {
      id: 'folder-b',
      name: 'Folder B',
      folded: false,
    }

    expect(applyOptimisticCreatedChatFolder('char-a', folder, previous)).toBe(true)

    expect(getDatabase().characters[0].chatFolders.map((candidate) => candidate.id)).toEqual(['folder-b', 'folder-a'])

    restoreChatState(previous)
    expect(getDatabase().characters[0].chatFolders.map((candidate) => candidate.id)).toEqual(['folder-a'])
  })

  it('optimistically removes a command-deleted chat through its owner', () => {
    const previous = currentChatStateSnapshot()

    expect(applyOptimisticDeletedChat('char-a', 'chat-a', previous)).toEqual({
      applied: true,
      selectedChatId: 'chat-b',
    })

    expect(getDatabase().characters[0].chats.map((candidate) => candidate.id)).toEqual(['chat-b'])
    expect(getDatabase().characters[0].chatPage).toBe(0)

    restoreChatState(previous)
    expect(getDatabase().characters[0].chats.map((candidate) => candidate.id)).toEqual(['chat-a', 'chat-b'])
  })

  it('keeps the active chat selected when an earlier inactive chat is deleted', () => {
    getDatabase().characters[0].chats.push({ id: 'chat-c', name: 'Chat C', message: [] } as Chat)
    getDatabase().characters[0].chatPage = 1
    const previous = currentChatStateSnapshot()
    expect(applyOptimisticDeletedChat('char-a', 'chat-a', previous)).toEqual({
      applied: true,
      selectedChatId: 'chat-b',
    })

    expect(getDatabase().characters[0].chats.map((candidate) => candidate.id)).toEqual(['chat-b', 'chat-c'])
    expect(getDatabase().characters[0].chatPage).toBe(0)
  })

  it('routes SideChatList chat and folder flows through owner commands', async () => {
    const calls = stubCommandFetch()
    const createChat: ChatSnapshot = {
      id: 'chat-c',
      name: 'Chat C',
      note: '',
      message: [],
      localLore: [],
      fmIndex: -1,
    }
    const createFolder: ChatFolderSnapshot = {
      id: 'folder-b',
      name: 'Folder B',
      folded: false,
    }
    const previous = currentChatStateSnapshot()

    dispatchCreateChat('char-a', createChat as any, previous)
    await waitForCallCount(calls, 2)
    dispatchCreateChatFolder('char-a', createFolder as any, previous)
    await waitForCallCount(calls, 3)
    dispatchUpdateChat('chat-a', {}, previous, true)
    await waitForCallCount(calls, 4)
    dispatchReorderChatsByIds(
      'char-a',
      ['chat-b', 'chat-a'],
      { 'chat-a': null, 'chat-b': 'folder-a' },
      previous,
      'chat-a',
    )
    await waitForCallCount(calls, 5)
    dispatchReorderChatFoldersByIds('char-a', ['folder-a'], previous, 'chat-a')

    await waitForCallCount(calls, 6)
    dispatchDeleteChat('chat-a', previous)

    await waitForCallCount(calls, 7)
    expect(calls).toEqual([
      {
        url: '/api/v1/bootstrap',
        method: 'GET',
        authHeader: 'chat-command-token',
        body: null,
      },
      {
        url: '/api/v1/commands/characters/char-a/chats',
        method: 'POST',
        authHeader: 'chat-command-token',
        body: {
          baseRevision: 10,
          chat: createChat,
          select: true,
        },
      },
      {
        url: '/api/v1/commands/characters/char-a/chat-folders',
        method: 'POST',
        authHeader: 'chat-command-token',
        body: {
          baseRevision: expect.any(Number),
          folder: createFolder,
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a',
        method: 'PATCH',
        authHeader: 'chat-command-token',
        body: {
          baseRevision: expect.any(Number),
          patch: {},
          select: true,
        },
      },
      {
        url: '/api/v1/commands/characters/char-a/chats/reorder',
        method: 'POST',
        authHeader: 'chat-command-token',
        body: {
          baseRevision: expect.any(Number),
          chatIds: ['chat-b', 'chat-a'],
          selectedChatId: 'chat-a',
        },
      },
      {
        url: '/api/v1/commands/characters/char-a/chat-folders/reorder',
        method: 'POST',
        authHeader: 'chat-command-token',
        body: {
          baseRevision: expect.any(Number),
          folderIds: ['folder-a'],
          selectedChatId: 'chat-a',
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a',
        method: 'DELETE',
        authHeader: 'chat-command-token',
        body: {
          baseRevision: expect.any(Number),
        },
      },
    ])
  })

  it('serializes the attempted create-folder snapshot even if the caller mutates the live folder', async () => {
    const calls = stubCommandFetch()
    const previous = currentChatStateSnapshot()
    const createFolder: ChatFolder = {
      id: 'folder-b',
      name: 'Folder B',
      color: 'blue',
      folded: false,
    }

    dispatchCreateChatFolder('char-a', createFolder, previous)
    createFolder.name = 'Mutated Folder'
    createFolder.color = 'red'
    createFolder.folded = true

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/characters/char-a/chat-folders',
      method: 'POST',
      body: {
        baseRevision: expect.any(Number),
        folder: {
          id: 'folder-b',
          name: 'Folder B',
          color: 'blue',
          folded: false,
        },
      },
    })
  })

  it('preserves newer same-folder edits when a chat folder update rollback fails', async () => {
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chat-folders/folder-a' && init.method === 'PATCH',
      onCommand: () => {
        withTestDatabaseWrite(() => {
          const folder = getDatabase().characters[0].chatFolders[0]
          folder.name = 'Newer folder name'
        })
      },
    })
    const previous = currentChatStateSnapshot()
    withTestDatabaseWrite(() => {
      const folder = getDatabase().characters[0].chatFolders[0]
      folder.name = 'Attempted folder name'
      folder.folded = true
    })

    dispatchUpdateChatFolder('folder-a', { name: 'Attempted folder name', folded: true }, previous)

    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chatFolders[0]).toMatchObject({
        id: 'folder-a',
        name: 'Newer folder name',
        folded: false,
      })
    })
  })

  it.each(['legacy', 'scoped'] as const)(
    'removes only an unchanged attempted folder after a failed create and keeps newer siblings (%s snapshot)',
    async (snapshotMode) => {
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/characters/char-a/chat-folders' && init.method === 'POST',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            getDatabase().characters[0].chatFolders.push({
              id: 'folder-c',
              name: 'Newer sibling folder',
              folded: false,
            })
          })
        },
      })
      const attemptedFolder = {
        id: 'folder-b',
        name: 'Attempted Folder',
        folded: false,
      }

      const previous =
        snapshotMode === 'scoped'
          ? captureChatFolderCreateSnapshot('char-a', attemptedFolder)!
          : currentChatStateSnapshot()
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chatFolders.unshift(attemptedFolder)
      })

      dispatchCreateChatFolder('char-a', attemptedFolder, previous)

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chatFolders.map((folder) => folder.id)).toEqual(['folder-a', 'folder-c'])
      })
      expect(getDatabase().characters[0].chatFolders[1]).toMatchObject({
        id: 'folder-c',
        name: 'Newer sibling folder',
      })
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'keeps a failed attempted folder when newer chats were moved into it (%s snapshot)',
    async (snapshotMode) => {
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/characters/char-a/chat-folders' && init.method === 'POST',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            getDatabase().characters[0].chats[0].folderId = 'folder-b'
          })
        },
      })
      const attemptedFolder = {
        id: 'folder-b',
        name: 'Attempted Folder',
        folded: false,
      }

      const previous =
        snapshotMode === 'scoped'
          ? captureChatFolderCreateSnapshot('char-a', attemptedFolder)!
          : currentChatStateSnapshot()
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chatFolders.unshift(attemptedFolder)
      })

      dispatchCreateChatFolder('char-a', attemptedFolder, previous)

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chatFolders.map((folder) => folder.id)).toEqual(['folder-b', 'folder-a'])
        expect(getDatabase().characters[0].chats[0].folderId).toBe('folder-b')
      })
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'rolls back an optimistic folder delete while preserving newer chat changes (%s snapshot)',
    async (snapshotMode) => {
      getDatabase().characters[0].chatFolders = [
        { id: 'folder-a', name: 'Latest optimistic folder child edit', folded: false },
        { id: 'folder-b', name: 'Folder B', folded: false },
      ]
      getDatabase().characters[0].chats = [
        { id: 'chat-a', name: 'Chat A', folderId: null, message: [] },
        { id: 'chat-b', name: 'Chat B', folderId: 'folder-a', message: [] },
        { id: 'chat-c', name: 'Chat C', folderId: 'folder-a', message: [] },
      ] as any
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/chat-folders/folder-a' && init.method === 'DELETE',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            getDatabase().characters[0].chats[0].name = 'Newer unrelated chat name'
            getDatabase().characters[0].chats[1].name = 'Newer affected chat name'
            getDatabase().characters[0].chats[2].name = 'Moved affected chat'
            getDatabase().characters[0].chats[2].folderId = 'folder-b'
          })
        },
      })
      const previous =
        snapshotMode === 'scoped' ? captureChatFolderDeleteSnapshot('folder-a', 'char-a')! : currentChatStateSnapshot()
      dispatchDeleteChatFolder('folder-a', previous)

      expect(getDatabase().characters[0].chatFolders.map((folder) => folder.id)).toEqual(['folder-b'])
      expect(getDatabase().characters[0].chats.map((chat) => chat.folderId)).toEqual([null, null, null])

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chatFolders.map((folder) => folder.id)).toEqual(['folder-a', 'folder-b'])
        expect(getDatabase().characters[0].chats[1].folderId).toBe('folder-a')
      })
      expect(getDatabase().characters[0].chats[0].name).toBe('Newer unrelated chat name')
      expect(getDatabase().characters[0].chats[1]).toMatchObject({
        name: 'Newer affected chat name',
        folderId: 'folder-a',
      })
      expect(getDatabase().characters[0].chatFolders[0].name).toBe('Latest optimistic folder child edit')
      expect(getDatabase().characters[0].chats[2]).toMatchObject({
        name: 'Moved affected chat',
        folderId: 'folder-b',
      })
    },
  )

  it('does not corrupt chat or folder rows for duplicate reorder ids', async () => {
    getDatabase().characters[0].chatFolders = [
      { id: 'folder-a', name: 'Folder A', folded: false },
      { id: 'folder-b', name: 'Folder B', folded: false },
    ]
    const calls = stubFailingCommandFetch({
      matches: (url, init) =>
        (url === '/api/v1/commands/characters/char-a/chats/reorder' ||
          url === '/api/v1/commands/characters/char-a/chat-folders/reorder') &&
        init.method === 'POST',
    })
    const previous = currentChatStateSnapshot()
    dispatchReorderChatsByIds('char-a', ['chat-a', 'chat-a'], {}, previous)
    await waitForCallCount(calls, 2)

    expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b'])

    dispatchReorderChatFoldersByIds('char-a', ['folder-a', 'folder-a'], previous)
    await waitForCallCount(calls, 3)

    expect(getDatabase().characters[0].chatFolders.map((folder) => folder.id)).toEqual(['folder-a', 'folder-b'])
  })

  it('keeps an unchanged omitted folder assignment omitted during optimistic reorder', async () => {
    withTestDatabaseWrite(() => {
      const omittedFolderChat = { ...getDatabase().characters[0].chats[0] }
      delete omittedFolderChat.folderId
      getDatabase().characters[0].chats[0] = omittedFolderChat
    })
    expect(Object.prototype.hasOwnProperty.call(getDatabase().characters[0].chats[0], 'folderId')).toBe(false)
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/characters/char-a/chats/reorder' && init.method === 'POST',
    })
    const previous = currentChatStateSnapshot()
    dispatchReorderChatsByIds(
      'char-a',
      ['chat-b', 'chat-a'],
      { 'chat-a': null, 'chat-b': 'folder-a' },
      previous,
      'chat-a',
    )

    const attemptedChat = getDatabase().characters[0].chats.find((chat) => chat.id === 'chat-a')
    expect(Object.prototype.hasOwnProperty.call(attemptedChat, 'folderId')).toBe(false)

    await waitForCallCount(calls, 2)
    const restoredChat = getDatabase().characters[0].chats.find((chat) => chat.id === 'chat-a')
    expect(Object.prototype.hasOwnProperty.call(restoredChat, 'folderId')).toBe(false)
  })

  it.each(['legacy', 'scoped'] as const)(
    'restores a failed chat folder reorder only when live order still equals the attempted order (%s snapshot)',
    async (snapshotMode) => {
      getDatabase().characters[0].chatFolders = [
        { id: 'folder-a', name: 'Folder A', folded: false },
        { id: 'folder-b', name: 'Folder B', folded: false },
        { id: 'folder-c', name: 'Folder C', folded: false },
      ]
      const calls = stubFailingCommandFetch({
        matches: (url, init) =>
          url === '/api/v1/commands/characters/char-a/chat-folders/reorder' && init.method === 'POST',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            const folder = getDatabase().characters[0].chatFolders.find((candidate) => candidate.id === 'folder-c')
            if (folder) folder.name = 'Newer Folder C'
          })
        },
      })
      const previous = snapshotMode === 'scoped' ? captureChatOrderSnapshot('char-a')! : currentChatStateSnapshot()
      const attemptedIds = ['folder-c', 'folder-a', 'folder-b']
      withTestDatabaseWrite(() => {
        const foldersById = new Map(getDatabase().characters[0].chatFolders.map((folder) => [folder.id, folder]))
        getDatabase().characters[0].chatFolders = attemptedIds.map((id) => foldersById.get(id)!)
      })

      dispatchReorderChatFoldersByIds('char-a', attemptedIds, previous)

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chatFolders.map((folder) => folder.id)).toEqual([
          'folder-a',
          'folder-b',
          'folder-c',
        ])
      })
      expect(getDatabase().characters[0].chatFolders[2].name).toBe('Newer Folder C')
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'skips failed chat folder reorder rollback after a newer reorder (%s snapshot)',
    async (snapshotMode) => {
      getDatabase().characters[0].chatFolders = [
        { id: 'folder-a', name: 'Folder A', folded: false },
        { id: 'folder-b', name: 'Folder B', folded: false },
        { id: 'folder-c', name: 'Folder C', folded: false },
      ]
      const newerIds = ['folder-b', 'folder-c', 'folder-a']
      const calls = stubFailingCommandFetch({
        matches: (url, init) =>
          url === '/api/v1/commands/characters/char-a/chat-folders/reorder' && init.method === 'POST',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            const foldersById = new Map(getDatabase().characters[0].chatFolders.map((folder) => [folder.id, folder]))
            getDatabase().characters[0].chatFolders = newerIds.map((id) => foldersById.get(id)!)
          })
        },
      })
      const previous = snapshotMode === 'scoped' ? captureChatOrderSnapshot('char-a')! : currentChatStateSnapshot()
      const attemptedIds = ['folder-c', 'folder-a', 'folder-b']
      withTestDatabaseWrite(() => {
        const foldersById = new Map(getDatabase().characters[0].chatFolders.map((folder) => [folder.id, folder]))
        getDatabase().characters[0].chatFolders = attemptedIds.map((id) => foldersById.get(id)!)
      })

      dispatchReorderChatFoldersByIds('char-a', attemptedIds, previous)

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chatFolders.map((folder) => folder.id)).toEqual(newerIds)
      })
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'keeps an accepted folder reorder when the combined chat reorder fails (%s snapshot)',
    async (snapshotMode) => {
      getDatabase().characters[0].chatFolders = [
        { id: 'folder-a', name: 'Folder A', folded: false },
        { id: 'folder-b', name: 'Folder B', folded: false },
        { id: 'folder-c', name: 'Folder C', folded: false },
      ]
      getDatabase().characters[0].chats = [
        { id: 'chat-a', name: 'Chat A', folderId: null, message: [] },
        { id: 'chat-b', name: 'Chat B', folderId: 'folder-a', message: [] },
        { id: 'chat-c', name: 'Chat C', folderId: 'folder-b', message: [] },
      ] as any
      const calls = stubCombinedReorderCommandFetch({
        fail: 'chats',
        onChatCommand: () => {
          withTestDatabaseWrite(() => {
            const folder = getDatabase().characters[0].chatFolders.find((candidate) => candidate.id === 'folder-c')
            const chat = getDatabase().characters[0].chats.find((candidate) => candidate.id === 'chat-c')
            if (folder) folder.name = 'Newer Folder C'
            if (chat) chat.name = 'Newer Chat C'
          })
        },
      })
      const previous = snapshotMode === 'scoped' ? captureChatOrderSnapshot('char-a')! : currentChatStateSnapshot()
      const attemptedFolderIds = ['folder-c', 'folder-a', 'folder-b']
      const attemptedChatIds = ['chat-c', 'chat-a', 'chat-b']
      const attemptedFolderByChatId = {
        'chat-a': 'folder-c',
        'chat-b': null,
        'chat-c': 'folder-a',
      }
      withTestDatabaseWrite(() => {
        const foldersById = new Map(getDatabase().characters[0].chatFolders.map((folder) => [folder.id, folder]))
        const chatsById = new Map(getDatabase().characters[0].chats.map((chat) => [chat.id, chat]))
        getDatabase().characters[0].chatFolders = attemptedFolderIds.map((id) => foldersById.get(id)!)
        getDatabase().characters[0].chats = attemptedChatIds.map((id) => chatsById.get(id)!)
        for (const chat of getDatabase().characters[0].chats) {
          chat.folderId = attemptedFolderByChatId[chat.id]
        }
        getDatabase().characters[0].chatPage = 1
      })

      dispatchReorderChatFoldersAndChatsByIds(
        'char-a',
        attemptedFolderIds,
        attemptedChatIds,
        attemptedFolderByChatId,
        previous,
        'chat-a',
      )

      await waitForCallCount(calls, 3)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chatFolders.map((folder) => folder.id)).toEqual(attemptedFolderIds)
        expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b', 'chat-c'])
      })
      expect(getDatabase().characters[0].chatFolders[0]).toMatchObject({
        id: 'folder-c',
        name: 'Newer Folder C',
      })
      expect(getDatabase().characters[0].chats.map((chat) => chat.folderId)).toEqual([null, 'folder-a', 'folder-b'])
      expect(getDatabase().characters[0].chats[2].name).toBe('Newer Chat C')
      expect(getDatabase().characters[0].chats[getDatabase().characters[0].chatPage].id).toBe('chat-a')
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'sends only changed folder assignments in a combined folder and chat reorder (%s snapshot)',
    async (snapshotMode) => {
      const calls = stubCombinedReorderCommandFetch({ fail: 'chats' })
      const previous = snapshotMode === 'scoped' ? captureChatOrderSnapshot('char-a')! : currentChatStateSnapshot()

      dispatchReorderChatFoldersAndChatsByIds(
        'char-a',
        ['folder-a'],
        ['chat-b', 'chat-a'],
        {
          'chat-a': 'folder-a',
          'chat-b': 'folder-a',
        },
        previous,
        'chat-a',
      )

      await waitForCallCount(calls, 3)
      expect(calls[2]).toMatchObject({
        url: '/api/v1/commands/characters/char-a/chats/reorder',
        method: 'POST',
        body: {
          baseRevision: 11,
          chatIds: ['chat-b', 'chat-a'],
          folderByChatId: { 'chat-a': 'folder-a' },
          selectedChatId: 'chat-a',
        },
      })
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'rolls back both attempted orders narrowly when the combined folder reorder fails first (%s snapshot)',
    async (snapshotMode) => {
      getDatabase().characters[0].chatFolders = [
        { id: 'folder-a', name: 'Folder A', folded: false },
        { id: 'folder-b', name: 'Folder B', folded: false },
        { id: 'folder-c', name: 'Folder C', folded: false },
      ]
      getDatabase().characters[0].chats = [
        { id: 'chat-a', name: 'Chat A', folderId: null, message: [] },
        { id: 'chat-b', name: 'Chat B', folderId: 'folder-a', message: [] },
        { id: 'chat-c', name: 'Chat C', folderId: 'folder-b', message: [] },
      ] as any
      const calls = stubCombinedReorderCommandFetch({
        fail: 'folders',
        onFolderCommand: () => {
          withTestDatabaseWrite(() => {
            const folder = getDatabase().characters[0].chatFolders.find((candidate) => candidate.id === 'folder-c')
            const chat = getDatabase().characters[0].chats.find((candidate) => candidate.id === 'chat-c')
            if (folder) folder.name = 'Newer Folder C'
            if (chat) chat.name = 'Newer Chat C'
          })
        },
      })
      const previous = snapshotMode === 'scoped' ? captureChatOrderSnapshot('char-a')! : currentChatStateSnapshot()
      const attemptedFolderIds = ['folder-c', 'folder-a', 'folder-b']
      const attemptedChatIds = ['chat-c', 'chat-a', 'chat-b']
      const attemptedFolderByChatId = {
        'chat-a': 'folder-c',
        'chat-b': null,
        'chat-c': 'folder-a',
      }
      withTestDatabaseWrite(() => {
        const foldersById = new Map(getDatabase().characters[0].chatFolders.map((folder) => [folder.id, folder]))
        const chatsById = new Map(getDatabase().characters[0].chats.map((chat) => [chat.id, chat]))
        getDatabase().characters[0].chatFolders = attemptedFolderIds.map((id) => foldersById.get(id)!)
        getDatabase().characters[0].chats = attemptedChatIds.map((id) => chatsById.get(id)!)
        for (const chat of getDatabase().characters[0].chats) {
          chat.folderId = attemptedFolderByChatId[chat.id]
        }
        getDatabase().characters[0].chatPage = 1
      })

      dispatchReorderChatFoldersAndChatsByIds(
        'char-a',
        attemptedFolderIds,
        attemptedChatIds,
        attemptedFolderByChatId,
        previous,
        'chat-a',
      )

      await waitForCallCount(calls, 2)
      expect(calls.map((call) => call.url)).toEqual([
        '/api/v1/bootstrap',
        '/api/v1/commands/characters/char-a/chat-folders/reorder',
      ])
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chatFolders.map((folder) => folder.id)).toEqual([
          'folder-a',
          'folder-b',
          'folder-c',
        ])
        expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b', 'chat-c'])
      })
      expect(getDatabase().characters[0].chatFolders[2]).toMatchObject({
        id: 'folder-c',
        name: 'Newer Folder C',
      })
      expect(getDatabase().characters[0].chats.map((chat) => chat.folderId)).toEqual([null, 'folder-a', 'folder-b'])
      expect(getDatabase().characters[0].chats[2].name).toBe('Newer Chat C')
      expect(getDatabase().characters[0].chats[getDatabase().characters[0].chatPage].id).toBe('chat-a')
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'keeps a pre-existing same-id chat after a failed create rollback (%s snapshot)',
    async (snapshotMode) => {
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/characters/char-a/chats' && init.method === 'POST',
      })
      const attemptedChat = jsonClone(getDatabase().characters[0].chats[1])

      const previous =
        snapshotMode === 'scoped' ? captureChatCreateSnapshot('char-a', attemptedChat)! : currentChatStateSnapshot()

      expect(applyOptimisticCreatedChat('char-a', attemptedChat, previous)).toBe(true)
      expect(getDatabase().characters[0].chatPage).toBe(1)

      dispatchCreateChat('char-a', attemptedChat, previous)

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b'])
      })
      expect(getDatabase().characters[0].chats[1]).toMatchObject({
        id: 'chat-b',
        name: 'Chat B',
      })
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'restores every previous chat when an optimistic reset fails (%s snapshot)',
    async (snapshotMode) => {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/characters/char-a/chats' && init.method === 'PUT',
      })
      const previous = snapshotMode === 'scoped' ? captureChatResetSnapshot('char-a')! : currentChatStateSnapshot()
      const attemptedChat = {
        id: 'chat-new',
        name: 'Chat 1',
        note: '',
        message: [],
        localLore: [],
        fmIndex: -1,
      } as Chat

      expect(applyOptimisticResetChats('char-a', attemptedChat, previous)).toBe(true)
      await expect(dispatchResetChatsWithOutcome('char-a', attemptedChat, previous)).resolves.toMatchObject({
        status: 'failed',
      })

      expect(calls.at(-1)).toMatchObject({
        url: '/api/v1/commands/characters/char-a/chats',
        method: 'PUT',
        body: {
          baseRevision: 10,
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
      expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b'])
      expect(getDatabase().characters[0].chatPage).toBe(0)
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'removes only an unchanged attempted chat after a failed create and keeps newer siblings (%s snapshot)',
    async (snapshotMode) => {
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/characters/char-a/chats' && init.method === 'POST',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            getDatabase().characters[0].chats[2].name = 'Newer sibling name'
            getDatabase().characters[0].chats.push({
              id: 'chat-d',
              name: 'Newer appended chat',
              folderId: null,
              message: [],
              note: '',
              localLore: [],
            })
          })
        },
      })
      const attemptedChat = {
        id: 'chat-c',
        name: 'Attempted Chat',
        note: '',
        folderId: null,
        message: [],
        localLore: [],
        fmIndex: -1,
      } as Chat

      const previous =
        snapshotMode === 'scoped' ? captureChatCreateSnapshot('char-a', attemptedChat)! : currentChatStateSnapshot()
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chats.unshift(attemptedChat)
        getDatabase().characters[0].chatPage = 0
      })

      dispatchCreateChat('char-a', attemptedChat, previous)

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b', 'chat-d'])
      })
      expect(getDatabase().characters[0].chats[1].name).toBe('Newer sibling name')
      expect(getDatabase().characters[0].chats[2].name).toBe('Newer appended chat')
      expect(getDatabase().characters[0].chatPage).toBe(0)
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'removes a failed created-chat ghost even after a dependent row edit (%s snapshot)',
    async (snapshotMode) => {
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/characters/char-a/chats' && init.method === 'POST',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            getDatabase().characters[0].chats[0].name = 'Newer attempted chat name'
            getDatabase().characters[0].chats[2].name = 'Newer sibling name'
          })
        },
      })
      const attemptedChat = {
        id: 'chat-c',
        name: 'Attempted Chat',
        note: '',
        folderId: null,
        message: [],
        localLore: [],
        fmIndex: -1,
      } as Chat

      const previous =
        snapshotMode === 'scoped' ? captureChatCreateSnapshot('char-a', attemptedChat)! : currentChatStateSnapshot()
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chats.unshift(attemptedChat)
        getDatabase().characters[0].chatPage = 0
      })

      dispatchCreateChat('char-a', attemptedChat, previous)

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b'])
      })
      expect(getDatabase().characters[0].chats[1].name).toBe('Newer sibling name')
      expect(getDatabase().characters[0].chatPage).toBe(0)
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'keeps an authoritative targeted row when a create response fails after the row arrives (%s snapshot)',
    async (snapshotMode) => {
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/characters/char-a/chats' && init.method === 'POST',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            const authoritativeCharacter = jsonClone(getDatabase().characters[0])
            const createdChat = authoritativeCharacter.chats.find((chat) => chat.id === 'chat-c')
            if (createdChat) createdChat.name = 'Canonical created chat'
            applyCharacterResource({ revision: 11, character: authoritativeCharacter })
          })
        },
      })
      const attemptedChat = {
        id: 'chat-c',
        name: 'Attempted Chat',
        note: '',
        folderId: null,
        message: [],
        localLore: [],
        fmIndex: -1,
      } as Chat

      const previous =
        snapshotMode === 'scoped' ? captureChatCreateSnapshot('char-a', attemptedChat)! : currentChatStateSnapshot()
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chats.unshift(attemptedChat)
        getDatabase().characters[0].chatPage = 0
      })

      dispatchCreateChat('char-a', attemptedChat, previous)

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-c', 'chat-a', 'chat-b'])
      })
      expect(getDatabase().characters[0].chats[0].name).toBe('Canonical created chat')
      expect(getDatabase().characters[0].chatPage).toBe(0)
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'rolls back an optimistic fork while preserving a newer sibling chat edit (%s snapshot)',
    async (snapshotMode) => {
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/chats/chat-a/fork' && init.method === 'POST',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            const attemptedFork = getDatabase().characters[0].chats.find((chat) => chat.id === 'chat-c')
            const sibling = getDatabase().characters[0].chats.find((chat) => chat.id === 'chat-b')
            if (attemptedFork) attemptedFork.name = 'Newer dependent fork edit'
            if (sibling) sibling.name = 'Newer sibling name'
          })
        },
      })
      const forkedChat = {
        id: 'chat-c',
        name: 'Chat A Copy',
        folderId: null,
        message: [],
      } as Chat

      const previous =
        snapshotMode === 'scoped'
          ? captureChatForkSnapshot('chat-a', { chat: forkedChat })!
          : currentChatStateSnapshot()

      dispatchForkChat('chat-a', previous, { chat: forkedChat })

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b'])
      })
      expect(getDatabase().characters[0].chats[1]).toMatchObject({
        id: 'chat-b',
        name: 'Newer sibling name',
      })
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'failed branch fork removes unchanged forked chat, restores source folder, and removes created folder (%s snapshot)',
    async (snapshotMode) => {
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/chats/chat-a/fork' && init.method === 'POST',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            getDatabase().characters[0].chats[2].name = 'Newer sibling name'
            getDatabase().characters[0].chatFolders[1].name = 'Newer folder name'
          })
        },
      })
      const branchFolder = {
        id: 'folder-branch',
        name: 'Branches of Chat A',
        folded: false,
      }
      const forkedChat = {
        id: 'chat-branch',
        name: 'Chat A Branch',
        folderId: branchFolder.id,
        message: [],
      } as Chat

      const previous =
        snapshotMode === 'scoped'
          ? captureChatForkSnapshot('chat-a', {
              chat: forkedChat,
              sourcePatch: { folderId: branchFolder.id },
              folder: branchFolder,
            })!
          : currentChatStateSnapshot()
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chatFolders.unshift(branchFolder)
        getDatabase().characters[0].chats[0].folderId = branchFolder.id
        getDatabase().characters[0].chats.unshift(forkedChat)
        getDatabase().characters[0].chatPage = 0
      })

      dispatchForkChat('chat-a', previous, {
        chat: forkedChat,
        sourcePatch: { folderId: branchFolder.id },
        folder: branchFolder,
      })

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b'])
        expect(getDatabase().characters[0].chatFolders.map((folder) => folder.id)).toEqual(['folder-a'])
      })
      expect(getDatabase().characters[0].chats[0]).toMatchObject({
        id: 'chat-a',
        folderId: null,
      })
      expect(getDatabase().characters[0].chats[1]).toMatchObject({
        id: 'chat-b',
        name: 'Newer sibling name',
      })
      expect(getDatabase().characters[0].chatFolders[0]).toMatchObject({
        id: 'folder-a',
        name: 'Newer folder name',
      })
      expect(getDatabase().characters[0].chats[getDatabase().characters[0].chatPage].id).toBe('chat-a')
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'removes a failed fork ghost even after a dependent row edit (%s snapshot)',
    async (snapshotMode) => {
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/chats/chat-a/fork' && init.method === 'POST',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            getDatabase().characters[0].chats[0].name = 'Newer forked chat name'
          })
        },
      })
      const forkedChat = {
        id: 'chat-branch',
        name: 'Chat A Branch',
        folderId: null,
        message: [],
      } as Chat

      const previous =
        snapshotMode === 'scoped'
          ? captureChatForkSnapshot('chat-a', { chat: forkedChat })!
          : currentChatStateSnapshot()
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chats.unshift(forkedChat)
        getDatabase().characters[0].chatPage = 0
      })

      dispatchForkChat('chat-a', previous, { chat: forkedChat })

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b'])
      })
      expect(getDatabase().characters[0].chats[getDatabase().characters[0].chatPage].id).toBe('chat-a')
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'reinserts only a still-missing deleted chat after a failed delete and preserves sibling edits (%s snapshot)',
    async (snapshotMode) => {
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/chats/chat-a' && init.method === 'DELETE',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            getDatabase().characters[0].chats[0].name = 'Newer sibling name'
            getDatabase().characters[0].chats.push({
              id: 'chat-c',
              name: 'Newer appended chat',
              folderId: null,
              message: [],
              note: '',
              localLore: [],
            })
          })
        },
      })
      expect(applyChatNoteValueLocally('chat-a', 'latest optimistic note')).toMatchObject({ note: '' })
      const previous =
        snapshotMode === 'scoped' ? captureChatDeleteSnapshot('chat-a', 'char-a')! : currentChatStateSnapshot()
      expect(applyOptimisticDeletedChat('char-a', 'chat-a', previous)).toEqual({
        applied: true,
        selectedChatId: 'chat-b',
      })

      dispatchDeleteChat('chat-a', previous)

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b', 'chat-c'])
      })
      expect(getDatabase().characters[0].chats[0].note).toBe('latest optimistic note')
      expect(getDatabase().characters[0].chats[1].name).toBe('Newer sibling name')
      expect(getDatabase().characters[0].chats[2].name).toBe('Newer appended chat')
      expect(getDatabase().characters[0].chatPage).toBe(0)
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'preserves newer user selection instead of restoring old selection after a failed delete (%s snapshot)',
    async (snapshotMode) => {
      getDatabase().characters[0].chats.push({
        id: 'chat-c',
        name: 'Chat C',
        folderId: null,
        message: [],
      } as Chat)
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/chats/chat-a' && init.method === 'DELETE',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            getDatabase().characters[0].chatPage = 1
          })
        },
      })
      const previous =
        snapshotMode === 'scoped' ? captureChatDeleteSnapshot('chat-a', 'char-a')! : currentChatStateSnapshot()
      expect(applyOptimisticDeletedChat('char-a', 'chat-a', previous)).toEqual({
        applied: true,
        selectedChatId: 'chat-b',
      })

      dispatchDeleteChat('chat-a', previous)

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b', 'chat-c'])
      })
      expect(getDatabase().characters[0].chats[getDatabase().characters[0].chatPage].id).toBe('chat-c')
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'restores failed chat reorder order and folder assignments only when live state still equals the attempt (%s snapshot)',
    async (snapshotMode) => {
      getDatabase().characters[0].chatFolders = [
        { id: 'folder-a', name: 'Folder A', folded: false },
        { id: 'folder-b', name: 'Folder B', folded: false },
      ]
      getDatabase().characters[0].chats = [
        { id: 'chat-a', name: 'Chat A', folderId: null, message: [] },
        { id: 'chat-b', name: 'Chat B', folderId: 'folder-a', message: [] },
        { id: 'chat-c', name: 'Chat C', folderId: 'folder-b', message: [] },
      ] as any
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/characters/char-a/chats/reorder' && init.method === 'POST',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            const chat = getDatabase().characters[0].chats.find((candidate) => candidate.id === 'chat-c')
            if (chat) chat.name = 'Newer Chat C'
          })
        },
      })
      const previous = snapshotMode === 'scoped' ? captureChatOrderSnapshot('char-a')! : currentChatStateSnapshot()
      const attemptedIds = ['chat-c', 'chat-a', 'chat-b']
      const attemptedFolderByChatId = {
        'chat-a': null,
        'chat-b': null,
        'chat-c': 'folder-a',
      }
      withTestDatabaseWrite(() => {
        const chatsById = new Map(getDatabase().characters[0].chats.map((chat) => [chat.id, chat]))
        getDatabase().characters[0].chats = attemptedIds.map((id) => chatsById.get(id)!)
        for (const chat of getDatabase().characters[0].chats) {
          chat.folderId = attemptedFolderByChatId[chat.id]
        }
        getDatabase().characters[0].chatPage = 1
      })

      dispatchReorderChatsByIds('char-a', attemptedIds, attemptedFolderByChatId, previous, 'chat-a')

      await waitForCallCount(calls, 2)
      expect(calls[1]).toMatchObject({
        url: '/api/v1/commands/characters/char-a/chats/reorder',
        method: 'POST',
        body: {
          chatIds: attemptedIds,
          folderByChatId: {
            'chat-b': null,
            'chat-c': 'folder-a',
          },
          selectedChatId: 'chat-a',
        },
      })
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b', 'chat-c'])
      })
      expect(getDatabase().characters[0].chats.map((chat) => chat.folderId)).toEqual([null, 'folder-a', 'folder-b'])
      expect(getDatabase().characters[0].chats[2].name).toBe('Newer Chat C')
      expect(getDatabase().characters[0].chats[getDatabase().characters[0].chatPage].id).toBe('chat-a')
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'skips failed chat reorder rollback after a newer reorder (%s snapshot)',
    async (snapshotMode) => {
      getDatabase().characters[0].chats.push({
        id: 'chat-c',
        name: 'Chat C',
        folderId: null,
        message: [],
      } as Chat)
      const newerIds = ['chat-b', 'chat-c', 'chat-a']
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/characters/char-a/chats/reorder' && init.method === 'POST',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            const chatsById = new Map(getDatabase().characters[0].chats.map((chat) => [chat.id, chat]))
            getDatabase().characters[0].chats = newerIds.map((id) => chatsById.get(id)!)
          })
        },
      })
      const previous = snapshotMode === 'scoped' ? captureChatOrderSnapshot('char-a')! : currentChatStateSnapshot()
      const attemptedIds = ['chat-c', 'chat-a', 'chat-b']
      const attemptedFolderByChatId = {
        'chat-a': null,
        'chat-b': 'folder-a',
        'chat-c': null,
      }
      withTestDatabaseWrite(() => {
        const chatsById = new Map(getDatabase().characters[0].chats.map((chat) => [chat.id, chat]))
        getDatabase().characters[0].chats = attemptedIds.map((id) => chatsById.get(id)!)
      })

      dispatchReorderChatsByIds('char-a', attemptedIds, attemptedFolderByChatId, previous, 'chat-a')

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(newerIds)
      })
    },
  )

  it.each(['legacy', 'scoped'] as const)(
    'skips failed chat reorder rollback after a newer folder move (%s snapshot)',
    async (snapshotMode) => {
      getDatabase().characters[0].chatFolders = [
        { id: 'folder-a', name: 'Folder A', folded: false },
        { id: 'folder-b', name: 'Folder B', folded: false },
      ]
      getDatabase().characters[0].chats.push({
        id: 'chat-c',
        name: 'Chat C',
        folderId: null,
        message: [],
      } as Chat)
      const calls = stubFailingCommandFetch({
        matches: (url, init) => url === '/api/v1/commands/characters/char-a/chats/reorder' && init.method === 'POST',
        onCommand: () => {
          withTestDatabaseWrite(() => {
            const chat = getDatabase().characters[0].chats.find((candidate) => candidate.id === 'chat-c')
            if (chat) chat.folderId = 'folder-b'
          })
        },
      })
      const previous = snapshotMode === 'scoped' ? captureChatOrderSnapshot('char-a')! : currentChatStateSnapshot()
      const attemptedIds = ['chat-c', 'chat-a', 'chat-b']
      const attemptedFolderByChatId = {
        'chat-a': null,
        'chat-b': 'folder-a',
        'chat-c': null,
      }
      withTestDatabaseWrite(() => {
        const chatsById = new Map(getDatabase().characters[0].chats.map((chat) => [chat.id, chat]))
        getDatabase().characters[0].chats = attemptedIds.map((id) => chatsById.get(id)!)
      })

      dispatchReorderChatsByIds('char-a', attemptedIds, attemptedFolderByChatId, previous, 'chat-a')

      await waitForCallCount(calls, 2)
      await vi.waitFor(() => {
        expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(attemptedIds)
      })
      expect(getDatabase().characters[0].chats[0]).toMatchObject({
        id: 'chat-c',
        folderId: 'folder-b',
      })
    },
  )

  it('replays a retained chat create before a later append on the same explicit character owner', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-chat-create-append',
      writerEpoch: 33,
      databaseLineage: 'lineage-chat-create-append',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    const previous = currentChatStateSnapshot()
    const createdChat = {
      id: 'chat-created-queued',
      name: 'Queued chat',
      note: '',
      localLore: [],
      message: [],
    } as Chat
    expect(applyOptimisticCreatedChat('char-a', createdChat, previous)).toBe(true)

    let recover = false
    let nextRevision = 10
    const commandCalls: Array<{
      method: string
      path: string
      body: Record<string, unknown>
      mutationId: string | null
    }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        const path = url.replace('/api/v1/commands', '')
        if (path === '/characters/char-a/chats' || path === '/chats/chat-created-queued/messages') {
          const headers = init.headers as Record<string, string> | undefined
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
          commandCalls.push({
            method: init.method ?? 'GET',
            path,
            body,
            mutationId: headers?.['risu-mutation-id'] ?? null,
          })
          if (!recover) return jsonResponse({ error: 'temporarily unavailable' }, 503)
          nextRevision += 1
          if (path === '/characters/char-a/chats') {
            return jsonResponse({
              revision: nextRevision,
              event: {
                type: 'chat.created',
                revision: nextRevision,
                resource: 'chatTranscript',
                id: 'chat-created-queued',
                parentId: 'char-a',
              },
              chatId: 'chat-created-queued',
              selectedChatId: 'chat-created-queued',
              generationSettings: null,
            })
          }
          return jsonResponse({
            revision: nextRevision,
            event: {
              type: 'message.created',
              revision: nextRevision,
              resource: 'message',
              id: 'message-after-create',
              parentId: 'chat-created-queued',
            },
            chatId: 'chat-created-queued',
            messageId: 'message-after-create',
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      dispatchCreateChat('char-a', createdChat, previous)
      await vi.waitFor(() => expect(commandCalls).toHaveLength(1))

      const appendPrevious = currentChatStateSnapshot()
      const message = {
        role: 'user',
        data: 'after retained create',
        chatId: 'message-after-create',
        time: 555,
      } as Message
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chats[0].message.push(message)
      })
      dispatchAppendMessage('chat-created-queued', message, appendPrevious)

      await vi.waitFor(() => expect(commandCalls).toHaveLength(2))
      expect(commandCalls.map((call) => call.path)).toEqual(['/characters/char-a/chats', '/characters/char-a/chats'])
      expect(commandCalls[1].mutationId).toBe(commandCalls[0].mutationId)

      const pending = await listPendingMutations()
      expect(pending.map((entry) => entry.handle.key)).toEqual(['character-owner:char-a', 'character-owner:char-a'])
      expect(pending.map((entry) => entry.intent.requests[0])).toEqual([
        {
          method: 'POST',
          path: '/characters/char-a/chats',
          body: { chat: createdChat, select: true },
        },
        {
          method: 'POST',
          path: '/chats/chat-created-queued/messages',
          body: { message },
        },
      ])

      recover = true
      const replayStart = commandCalls.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 2, retained: 0 })
      expect(commandCalls.slice(replayStart).map((call) => call.path)).toEqual([
        '/characters/char-a/chats',
        '/chats/chat-created-queued/messages',
      ])
      expect(await listPendingMutations()).toEqual([])
      expect(getDatabase().characters[0].chats[0].message).toEqual([message])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })
})

describe('chat-selection snapshot', () => {
  it('captures only selection scalars and performs zero clone work', () => {
    setDatabaseLite(seedCloneCostDb() as any)
    selectedCharID.set(0)

    const instrumented = withCloneInstrumentation(() => currentChatSelectionSnapshot())
    const snapshot = instrumented.result
    expect(snapshot).toEqual({ characterId: 'char-0', selectedCharID: 0, chatPage: 0 })
    assertSnapshotIsScalar(snapshot)
    // Purely scalar reads: not a single clone primitive call. The old path
    // JSON-cloned the whole characters array (hydrated transcripts included).
    expect(instrumented.totalCloneCount).toBe(0)
  })

  it('restores only the owning character chatPage, never the selection or sibling edits', () => {
    setDatabaseLite(seedCloneCostDb() as any)
    selectedCharID.set(0)

    assertRollbackRestoresOnly({
      capture: () => currentChatSelectionSnapshot(),
      mutate: () => {
        // the optimistic select write
        getDatabase().characters[0].chatPage = 1
        // concurrent, unrelated edits a whole-array restore would wipe
        getDatabase().characters[0].chats[0].message.push({
          role: 'char',
          data: 'concurrent',
          chatId: 'msg-concurrent',
        })
        getDatabase().characters[1].chats[0].note = 'sibling concurrent note'
        // a concurrent character switch the rollback must not undo
        selectedCharID.set(1)
      },
      expectMutated: () => {
        expect(getDatabase().characters[0].chatPage).toBe(1)
      },
      restore: (snapshot) => restoreChatSelection(snapshot),
      expectRestored: () => {
        expect(getDatabase().characters[0].chatPage).toBe(0)
      },
      expectUntouched: () => {
        expect(getDatabase().characters[0].chats[0].message).toHaveLength(41)
        expect(getDatabase().characters[1].chats[0].note).toBe('sibling concurrent note')
        // chat select never mutates the character selection; restore must not
        // re-write it either (it only locates the row by it)
        expect(get(selectedCharID)).toBe(1)
      },
    })
  })

  it('restores chatPage by stable chaId even when the character index shifted', () => {
    setDatabaseLite(seedCloneCostDb() as any)
    selectedCharID.set(0)
    const snapshot = currentChatSelectionSnapshot()

    getDatabase().characters[0].chatPage = 1
    getDatabase().characters.unshift({
      chaId: 'char-new',
      name: 'Inserted',
      chatPage: 9,
      chats: [],
    } as any)

    restoreChatSelection(snapshot)

    expect(getDatabase().characters.find((c: any) => c.chaId === 'char-0').chatPage).toBe(0)
    // the character now sitting at the stale index is untouched
    expect(getDatabase().characters[0].chatPage).toBe(9)
  })

  it('dispatchSelectChat sends the empty-patch select command', async () => {
    const calls = stubCommandFetch()
    dispatchSelectChat('chat-a', currentChatSelectionSnapshot())
    await waitForCallCount(calls, 2)

    expect(calls[1]).toEqual({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      authHeader: 'chat-command-token',
      body: {
        baseRevision: 10,
        patch: {},
        select: true,
      },
    })
  })

  it('dispatchSelectChat optimistically updates chatPage before the PATCH resolves', async () => {
    const calls = stubCommandFetch()
    dispatchSelectChat('chat-b', currentChatSelectionSnapshot())

    expect(getDatabase().characters[0].chatPage).toBe(1)
    await waitForCallCount(calls, 2)
    expect(calls[1]).toEqual({
      url: '/api/v1/commands/chats/chat-b',
      method: 'PATCH',
      authHeader: 'chat-command-token',
      body: {
        baseRevision: 10,
        patch: {},
        select: true,
      },
    })
  })

  it('dispatchSelectChat rolls back the optimistic chatPage on command failure', async () => {
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string> | undefined
        const url = String(input)
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: headers?.['risu-auth'] ?? null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })

        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/chats/chat-b') return jsonResponse({ error: 'nope' }, 500)
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    dispatchSelectChat('chat-b', currentChatSelectionSnapshot())

    expect(getDatabase().characters[0].chatPage).toBe(1)
    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chatPage).toBe(0)
    })
  })

  it('dispatchSelectChat does not roll a newer chat selection back to an older page', async () => {
    getDatabase().characters[0].chats.push({ id: 'chat-c', name: 'Chat C', message: [] } as any)
    const calls = stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/chats/chat-b' && init.method === 'PATCH',
      onCommand: () => {
        withTestDatabaseWrite(() => {
          getDatabase().characters[0].chatPage = 2
        })
      },
    })
    dispatchSelectChat('chat-b', currentChatSelectionSnapshot())

    expect(getDatabase().characters[0].chatPage).toBe(1)
    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].chatPage).toBe(2)
    })
  })
})

describe('scoped chat organization ownership', () => {
  it.each(['delete', 'reset'] as const)(
    'restores newer edits on a detached removed row when scoped %s fails',
    async (operation) => {
      const response = createDeferred<Response>()
      const sent = createDeferred<void>()
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          if (String(input) === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
          sent.resolve()
          return response.promise
        }),
      )
      const owner = getDatabase().characters[0]
      const removedChat = owner.chats[0]
      removedChat.message.push({ role: 'char', data: 'started before removal', chatId: 'removed-message' })
      const removedMessage = removedChat.message[0]
      let mutation: ReturnType<typeof dispatchDeleteChatWithOutcome>
      if (operation === 'delete') {
        const previous = captureChatDeleteSnapshot('chat-a', 'char-a')!
        expect(applyOptimisticDeletedChat('char-a', 'chat-a', previous).applied).toBe(true)
        mutation = dispatchDeleteChatWithOutcome('chat-a', previous)
      } else {
        const previous = captureChatResetSnapshot('char-a')!
        const chat = { id: 'chat-reset', name: 'Chat 1', note: '', message: [], localLore: [], fmIndex: -1 } as Chat
        expect(applyOptimisticResetChats('char-a', chat, previous)).toBe(true)
        mutation = dispatchResetChatsWithOutcome('char-a', chat, previous)
      }
      try {
        await sent.promise
        expect(owner.chats.some((chat) => chat.id === 'chat-a')).toBe(false)
        removedMessage.data = 'finished while removal was pending'
        removedChat.note = 'newer detached draft'
        response.resolve(jsonResponse({ error: 'removal rejected' }, 500))
        await expect(mutation).resolves.toMatchObject({ status: 'failed' })
        const restored = owner.chats.find((chat) => chat.id === 'chat-a')!
        expect(restored.message[0].data).toBe('finished while removal was pending')
        expect(restored.note).toBe('newer detached draft')
      } finally {
        response.resolve(jsonResponse({ error: 'cleanup' }, 500))
        await mutation
      }
    },
  )

  it.each(['accepted', 'failed'] as const)(
    'keeps resident message identities through a held reorder that is %s',
    async (status) => {
      const response = createDeferred<Response>()
      const sent = createDeferred<void>()
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          if (String(input) === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
          sent.resolve()
          return response.promise
        }),
      )
      const owner = getDatabase().characters[0]
      const first = owner.chats[0]
      const second = owner.chats[1]
      second.message.push({ role: 'char', data: 'pending generation', chatId: 'background' })
      const messages = second.message
      const message = messages[0]
      const previous = captureChatOrderSnapshot('char-a')!
      const mutation = dispatchReorderChatsByIdsWithOutcome(
        'char-a',
        ['chat-b', 'chat-a'],
        { 'chat-a': null, 'chat-b': 'folder-a' },
        previous,
        'chat-a',
      )
      try {
        expect(owner.chats).toEqual([second, first])
        expect(owner.chats[0]).toBe(second)
        expect(second.message).toBe(messages)
        expect(messages[0]).toBe(message)
        await sent.promise
        message.data = 'background generation completed'
        response.resolve(
          status === 'accepted'
            ? jsonResponse({
                revision: 11,
                event: { type: 'chat.reordered', revision: 11, resource: 'chat' },
                selectedChatId: 'chat-a',
              })
            : jsonResponse({ error: 'reorder rejected' }, 500),
        )
        await expect(mutation).resolves.toMatchObject({ status })
        expect(owner.chats.map((chat) => chat.id)).toEqual(
          status === 'accepted' ? ['chat-b', 'chat-a'] : ['chat-a', 'chat-b'],
        )
        expect(owner.chats.find((chat) => chat.id === 'chat-b')).toBe(second)
        expect(second.message).toBe(messages)
        expect(messages[0]).toBe(message)
        expect(message.data).toBe('background generation completed')
      } finally {
        response.resolve(jsonResponse({ error: 'cleanup' }, 500))
        await mutation
      }
    },
  )

  it('does not resurrect reset chats after an authoritative replacement arrives while the command is held', async () => {
    const response = createDeferred<Response>()
    const sent = createDeferred<void>()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        sent.resolve()
        return response.promise
      }),
    )
    const previous = captureChatResetSnapshot('char-a')!
    const chat = { id: 'chat-new', name: 'Chat 1', note: '', message: [], localLore: [], fmIndex: -1 } as Chat
    expect(applyOptimisticResetChats('char-a', chat, previous)).toBe(true)
    const mutation = dispatchResetChatsWithOutcome('char-a', chat, previous)
    try {
      await sent.promise
      const authoritative = jsonClone(getDatabase().characters[0])
      expect(applyCharacterResource({ revision: 11, character: authoritative })).toBe(true)
      response.resolve(jsonResponse({ error: 'old reset failed' }, 500))
      await expect(mutation).resolves.toMatchObject({ status: 'failed' })
      expect(getDatabase().characters[0].chats.map((candidate) => candidate.id)).toEqual(['chat-new'])
    } finally {
      response.resolve(jsonResponse({ error: 'cleanup' }, 500))
      await mutation
    }
  })
})

describe('durable chat and folder structure dispatch', () => {
  it('classifies a terminal structural create as failed after narrow rollback', async () => {
    resetPendingMutationOutboxForTests()
    stubFailingCommandFetch({
      matches: (url, init) => url === '/api/v1/commands/characters/char-a/chats' && init.method === 'POST',
    })
    const previous = currentChatStateSnapshot()
    const attemptedChat = {
      id: 'chat-created',
      name: 'Attempted Chat',
      note: '',
      folderId: null,
      message: [],
      localLore: [],
      fmIndex: -1,
    } as Chat
    expect(applyOptimisticCreatedChat('char-a', attemptedChat, previous)).toBe(true)

    await expect(dispatchCreateChatWithOutcome('char-a', attemptedChat, previous)).resolves.toMatchObject({
      status: 'failed',
    })
    expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b'])
  })

  it('settles a retained structural create after its exact replay is accepted', async () => {
    await prepareDurableOutbox('create-outcome')
    let recover = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url === '/api/v1/commands/characters/char-a/chats' && init.method === 'POST') {
          if (!recover) return jsonResponse({ error: 'temporarily unavailable' }, 503)
          return jsonResponse({
            revision: 11,
            event: { type: 'chat.created', revision: 11, resource: 'chatTranscript', parentId: 'char-a' },
            chatId: 'chat-created',
            selectedChatId: 'chat-created',
            generationSettings: null,
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const previous = currentChatStateSnapshot()
      const attemptedChat = {
        id: 'chat-created',
        name: 'Queued Chat',
        note: '',
        folderId: null,
        message: [],
        localLore: [],
        fmIndex: -1,
      } as Chat
      expect(applyOptimisticCreatedChat('char-a', attemptedChat, previous)).toBe(true)

      const mutation = await dispatchCreateChatWithOutcome('char-a', attemptedChat, previous)
      expect(mutation).toMatchObject({ status: 'queued', mutationIds: [expect.any(String)] })
      expect(getDatabase().characters[0].chats[0].id).toBe('chat-created')
      expect(await listPendingMutations()).toHaveLength(1)

      recover = true
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 1, retained: 0 })
      if (mutation.status !== 'queued') throw new Error('Expected a queued create')
      await expect(mutation.settlement).resolves.toEqual({ status: 'accepted' })
    } finally {
      await clearDurableOutbox()
    }
  })

  it('reports a terminal final replay and rolls the retained structural create back', async () => {
    await prepareDurableOutbox('create-final-failure')
    let rejectReplay = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/characters/char-a/chats' && init.method === 'POST') {
          return rejectReplay
            ? jsonResponse({ error: 'invalid queued chat' }, 400)
            : jsonResponse({ error: 'temporarily unavailable' }, 503)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const previous = currentChatStateSnapshot()
      const attemptedChat = {
        id: 'chat-rejected-finally',
        name: 'Rejected Queued Chat',
        note: '',
        folderId: null,
        message: [],
        localLore: [],
        fmIndex: -1,
      } as Chat
      expect(applyOptimisticCreatedChat('char-a', attemptedChat, previous)).toBe(true)
      const mutation = await dispatchCreateChatWithOutcome('char-a', attemptedChat, previous)
      if (mutation.status !== 'queued') throw new Error('Expected a queued create')

      rejectReplay = true
      await expect(replayPendingMutations()).resolves.toMatchObject({ discarded: 1, retained: 0 })
      await expect(mutation.settlement).resolves.toMatchObject({
        status: 'failed',
        result: { status: 'error', error: 'invalid queued chat' },
      })
      expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b'])
    } finally {
      await clearDurableOutbox()
    }
  })

  it('retains optimistic chat selection and folder metadata edits on retryable failures', async () => {
    await prepareDurableOutbox('selection')
    let liveBody: Record<string, unknown> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/chats/chat-b' && init.method === 'PATCH') {
          liveBody = typeof init.body === 'string' ? JSON.parse(init.body) : {}
          return jsonResponse({ error: 'temporarily unavailable' }, 503)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      dispatchSelectChat('chat-b', currentChatSelectionSnapshot())
      await vi.waitFor(() => expect(liveBody).toBeDefined())

      expect(getDatabase().characters[0].chatPage).toBe(1)
      const pending = await listPendingMutations()
      expect(pending).toMatchObject([
        {
          handle: { key: 'character-owner:char-a' },
          intent: {
            requests: [
              {
                method: 'PATCH',
                path: '/chats/chat-b',
                body: { patch: {}, select: true },
              },
            ],
          },
        },
      ])
      const { baseRevision: _baseRevision, ...sentBody } = liveBody ?? {}
      expect(sentBody).toEqual(pending[0].intent.requests[0].body)
    } finally {
      await clearDurableOutbox()
    }

    await prepareDurableOutbox('folder-patch')
    liveBody = undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/chat-folders/folder-a' && init.method === 'PATCH') {
          liveBody = typeof init.body === 'string' ? JSON.parse(init.body) : {}
          return jsonResponse({ error: 'temporarily unavailable' }, 503)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const previous = currentChatStateSnapshot()
      withTestDatabaseWrite(() => {
        getDatabase().characters[0].chatFolders[0].name = 'Durable folder rename'
      })
      const mutation = dispatchUpdateChatFolderWithOutcome('folder-a', { name: 'Durable folder rename' }, previous)
      await vi.waitFor(() => expect(liveBody).toBeDefined())
      await expect(mutation).resolves.toMatchObject({ status: 'queued' })

      expect(getDatabase().characters[0].chatFolders[0].name).toBe('Durable folder rename')
      const pending = await listPendingMutations()
      expect(pending).toMatchObject([
        {
          handle: { key: 'character-owner:char-a' },
          intent: {
            requests: [
              {
                method: 'PATCH',
                path: '/chat-folders/folder-a',
                body: { patch: { name: 'Durable folder rename' } },
              },
            ],
          },
        },
      ])
      const { baseRevision: _baseRevision, ...sentBody } = liveBody ?? {}
      expect(sentBody).toEqual(pending[0].intent.requests[0].body)
    } finally {
      await clearDurableOutbox()
    }
  })

  it('pre-stages combined folder and chat reorders and replays them in owner order', async () => {
    await prepareDurableOutbox('combined-reorder')
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chatFolders.push({ id: 'folder-b', name: 'Folder B', folded: false })
    })
    const previous = currentChatStateSnapshot()
    let recover = false
    let revision = 10
    const commandPaths: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        const path = url.replace('/api/v1/commands', '')
        if (path === '/characters/char-a/chat-folders/reorder' || path === '/characters/char-a/chats/reorder') {
          commandPaths.push(path)
          if (!recover) return jsonResponse({ error: 'temporarily unavailable' }, 503)
          revision += 1
          return jsonResponse({
            revision,
            event: {
              type: path.includes('/chat-folders/') ? 'chatFolder.reordered' : 'chat.reordered',
              revision,
              resource: 'characterRow',
              parentId: 'char-a',
            },
            selectedChatId: 'chat-b',
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const mutation = dispatchReorderChatFoldersAndChatsByIdsWithOutcome(
        'char-a',
        ['folder-b', 'folder-a'],
        ['chat-b', 'chat-a'],
        { 'chat-b': 'folder-b', 'chat-a': null },
        previous,
        'chat-b',
      )
      await vi.waitFor(() => expect(commandPaths).toEqual(['/characters/char-a/chat-folders/reorder']))
      const queuedOutcome = await mutation
      expect(queuedOutcome).toMatchObject({
        status: 'queued',
        mutationIds: [expect.any(String), expect.any(String)],
      })

      expect(getDatabase().characters[0].chatFolders.map((folder) => folder.id)).toEqual(['folder-b', 'folder-a'])
      expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-b', 'chat-a'])
      const pending = await listPendingMutations()
      expect(pending.map((entry) => entry.handle.key)).toEqual(['character-owner:char-a', 'character-owner:char-a'])
      expect(pending.map((entry) => entry.intent.requests[0])).toEqual([
        {
          method: 'POST',
          path: '/characters/char-a/chat-folders/reorder',
          body: { folderIds: ['folder-b', 'folder-a'], selectedChatId: 'chat-b' },
        },
        {
          method: 'POST',
          path: '/characters/char-a/chats/reorder',
          body: {
            chatIds: ['chat-b', 'chat-a'],
            folderByChatId: { 'chat-b': 'folder-b' },
            selectedChatId: 'chat-b',
          },
        },
      ])

      recover = true
      const replayStart = commandPaths.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 2, retained: 0 })
      expect(commandPaths.slice(replayStart)).toEqual([
        '/characters/char-a/chat-folders/reorder',
        '/characters/char-a/chats/reorder',
      ])
      if (queuedOutcome.status !== 'queued') throw new Error('Expected a queued reorder batch')
      await expect(queuedOutcome.settlement).resolves.toEqual({ status: 'accepted' })
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearDurableOutbox()
    }
  })

  it('keeps an accepted folder reorder when the later chat reorder is terminally rejected', async () => {
    await prepareDurableOutbox('combined-terminal')
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].chatFolders.push({ id: 'folder-b', name: 'Folder B', folded: false })
    })
    const previous = currentChatStateSnapshot()
    const commandPaths: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        const path = url.replace('/api/v1/commands', '')
        if (path === '/characters/char-a/chat-folders/reorder') {
          commandPaths.push(path)
          return jsonResponse({
            revision: 11,
            event: {
              type: 'chatFolder.reordered',
              revision: 11,
              resource: 'characterRow',
              parentId: 'char-a',
            },
            selectedChatId: 'chat-b',
          })
        }
        if (path === '/characters/char-a/chats/reorder') {
          commandPaths.push(path)
          return jsonResponse({ error: 'invalid chat reorder' }, 400)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const mutation = dispatchReorderChatFoldersAndChatsByIdsWithOutcome(
        'char-a',
        ['folder-b', 'folder-a'],
        ['chat-b', 'chat-a'],
        { 'chat-b': 'folder-b', 'chat-a': null },
        previous,
        'chat-b',
      )
      await vi.waitFor(() => {
        expect(commandPaths).toEqual(['/characters/char-a/chat-folders/reorder', '/characters/char-a/chats/reorder'])
      })
      await expect(mutation).resolves.toMatchObject({ status: 'failed' })
      await vi.waitFor(async () => expect(await listPendingMutations()).toEqual([]))

      expect(getDatabase().characters[0].chatFolders.map((folder) => folder.id)).toEqual(['folder-b', 'folder-a'])
      expect(getDatabase().characters[0].chats.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b'])
      expect(getDatabase().characters[0].chats.map((chat) => chat.folderId ?? null)).toEqual([null, 'folder-a'])
    } finally {
      await clearDurableOutbox()
    }
  })
})
